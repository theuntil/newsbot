import { spawn } from "node:child_process";
import { rm, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { log } from "../lib/logger.js";
import { BotError } from "../lib/errors.js";
import type { BotSettings } from "../db/client.js";

export interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  bitrate: number;
  codec: string;
}

export interface VideoResult {
  path: string;
  posterPath: string | null;
  durationSec: number;
  width: number;
  height: number;
  bytesIn: number;
  bytesOut: number;
  processingMs: number;
  skipped: boolean;
  skipReason: string | null;
  cleanup: () => Promise<void>;
}

/**
 * ffmpeg/ffprobe kurulu mu?
 *
 * NEDEN ÖNEMLİ: Kurulu değilse her video "spawn ENOENT" alır.
 * Bunu kalıcı hata sayarsak videolar ölür ve ffmpeg sonradan
 * kurulsa bile geri gelmez. Bu yüzden ORTAM hatası olarak
 * ayırıyoruz: video işleme askıya alınır, kayıtlar bekler.
 */
let ffmpegAvailable: boolean | null = null;

export async function checkFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  const probe = (cmd: string) => new Promise<boolean>((res) => {
    const p = spawn(cmd, ["-version"], { stdio: "ignore" });
    p.on("close", (c) => res(c === 0));
    p.on("error", () => res(false));
  });
  ffmpegAvailable = (await probe("ffmpeg")) && (await probe("ffprobe"));
  return ffmpegAvailable;
}

export function isFfmpegKnownMissing(): boolean {
  return ffmpegAvailable === false;
}

/** Ortam hatası mı? (program yok, izin yok) — kalıcı sayılmaz */
export function isEnvironmentError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "SPAWN_FAILED" || code === "FFMPEG_MISSING";
}

/**
 * Alt süreç çalıştırıcı — SERT zaman aşımı ile.
 *
 * ffmpeg bozuk dosyada sonsuza kadar takılabilir. Timeout olmazsa
 * bir video tüm video kuyruğunu kalıcı kilitler. SIGKILL şart:
 * ffmpeg SIGTERM'i bazen yok sayar.
 */
function run(
  cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let done = false;

    const kill = (reason: string) => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new BotError(`${cmd} ${reason}`, {
        kind: "media_process", retryable: reason === "zaman aşımı", code: "FFMPEG_KILLED",
      }));
    };

    const timer = setTimeout(() => kill("zaman aşımı"), timeoutMs);
    const onAbort = () => kill("iptal edildi");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d) => { stdout += d; if (stdout.length > 1e6) stdout = stdout.slice(-1e6); });
    child.stderr?.on("data", (d) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-1e6); });

    child.on("error", (err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      reject(new BotError(
        missing
          ? `${cmd} kurulu değil (spawn ENOENT) — video işleme askıda`
          : `${cmd} başlatılamadı: ${err.message}`,
        {
          kind: "media_process",
          // ORTAM hatası: kalıcı DEĞİL. ffmpeg sonradan kurulunca
          // videolar işlensin diye kayıtlar öldürülmemeli.
          retryable: true,
          code: missing ? "FFMPEG_MISSING" : "SPAWN_FAILED",
          cause: err,
        },
      ));
    });

    child.on("close", (code) => {
      if (done) return; done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(new BotError(`${cmd} çıkış kodu ${code}: ${stderr.slice(-600)}`, {
          kind: "media_process", retryable: false, code: `EXIT_${code}`,
        }));
      }
    });
  });
}

export class VideoProcessor {
  async probe(filePath: string, signal?: AbortSignal): Promise<VideoProbe> {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-print_format", "json",
      "-show_format", "-show_streams", filePath,
    ], 30_000, signal);

    let data: any;
    try { data = JSON.parse(stdout); } catch {
      throw new BotError("ffprobe çıktısı okunamadı", {
        kind: "media_process", retryable: false, code: "PROBE_PARSE",
      });
    }

    const v = (data.streams ?? []).find((s: any) => s.codec_type === "video");
    if (!v) {
      throw new BotError("Dosyada video akışı yok", {
        kind: "media_process", retryable: false, code: "NO_VIDEO_STREAM",
      });
    }

    return {
      durationSec: Math.round(Number(data.format?.duration ?? v.duration ?? 0)),
      width: Number(v.width ?? 0),
      height: Number(v.height ?? 0),
      hasAudio: (data.streams ?? []).some((s: any) => s.codec_type === "audio"),
      bitrate: Number(data.format?.bit_rate ?? 0),
      codec: String(v.codec_name ?? "unknown"),
    };
  }

  /**
   * Videoyu sıkıştırır.
   *
   * KADEMELİ STRATEJİ (feed'de 3 MB'den 82 MB'ye her şey var):
   *   ≤ 5 dk   → CRF 26, iyi kalite
   *   5–20 dk  → CRF 28, daha agresif
   *   > 20 dk  → TRANSCODE YOK, sadece poster
   *
   * Uzun videoyu 720p'ye indirmek 10+ dakika CPU yer ve haber
   * sitesinde 14 dakikalık videoyu neredeyse kimse izlemiyor.
   * Eşikler bot_settings'te, panelden değiştirilebilir.
   */
  async process(
    inputPath: string,
    settings: BotSettings,
    signal?: AbortSignal,
  ): Promise<VideoResult> {
    const started = Date.now();
    await mkdir(env.tmpDir, { recursive: true });

    const id = randomUUID();
    const outPath = join(env.tmpDir, `vid-${id}.mp4`);
    const posterPath = join(env.tmpDir, `poster-${id}.jpg`);

    const cleanup = async () => {
      await Promise.all([
        rm(outPath, { force: true }).catch(() => {}),
        rm(posterPath, { force: true }).catch(() => {}),
      ]);
    };

    try {
      const info = await this.probe(inputPath, signal);
      const bytesIn = (await stat(inputPath)).size;

      // Poster her durumda üretilir — uzun videoda bile kapak lazım
      const poster = await this.extractPoster(inputPath, posterPath, info, signal)
        .then(() => posterPath)
        .catch((err) => { log.warn("Poster üretilemedi", { err }); return null; });

      // --- Çok uzun video: transcode etme ---------------------
      if (info.durationSec > settings.video_skip_over_sec) {
        log.info("Video çok uzun, transcode atlandı", {
          durationSec: info.durationSec, limit: settings.video_skip_over_sec,
        });
        return {
          path: "", posterPath: poster,
          durationSec: info.durationSec, width: info.width, height: info.height,
          bytesIn, bytesOut: 0, processingMs: Date.now() - started,
          skipped: true, skipReason: `duration>${settings.video_skip_over_sec}s`,
          cleanup,
        };
      }

      const isShort = info.durationSec <= settings.video_short_max_sec;
      const crf = isShort ? settings.video_crf_short : settings.video_crf_long;
      /**
       * Hedef yükseklik: ayardan ve KAYNAKTAN küçük olanı.
       * 720p bir videoyu 1080'e şişirmek dosyayı büyütür,
       * kaliteyi artırmaz.
       */
      const targetH = Math.min(
        settings.video_max_height,
        info.height || settings.video_max_height,
      );

      // Süre bazlı timeout: gerçek zamanın 4 katı + 2 dk pay
      const timeoutMs = Math.min(
        (info.durationSec * 4 + 120) * 1000,
        45 * 60 * 1000,
      );

      const args = [
        "-nostdin", "-y",
        "-threads", String(settings.video_threads),
        "-i", inputPath,
        // -2: genişliği çift sayıya yuvarla (h264 zorunluluğu)
        // Yüksekliği hedefe indir, en-boy oranını koru, çift sayıya yuvarla
        // (h264 tek sayı boyut kabul etmez). Kaynaktan BÜYÜTME yok.
        "-vf", `scale=-2:'min(${targetH},ih)':flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        "-c:v", "libx264",
        "-preset", settings.video_preset,
        "-crf", String(crf),
        "-profile:v", "high", "-level", "4.0",
        "-pix_fmt", "yuv420p",           // eski cihaz uyumluluğu
        "-max_muxing_queue_size", "1024",
      ];

      if (info.hasAudio) {
        args.push("-c:a", "aac", "-b:a", `${settings.video_audio_kbps}k`, "-ac", "2");
      } else {
        args.push("-an");
      }

      // +faststart: index'i dosya başına taşır → tarayıcı hemen oynatır.
      // Bu olmadan kullanıcı tüm dosya inene kadar bekler.
      args.push("-movflags", "+faststart", outPath);

      log.debug("Video transcode başlıyor", {
        durationSec: info.durationSec, crf, targetH,
        preset: settings.video_preset, timeoutMs,
      });

      await run("ffmpeg", args, timeoutMs, signal);

      const outStat = await stat(outPath);
      if (outStat.size === 0) {
        throw new BotError("Transcode çıktısı boş", {
          kind: "media_process", retryable: false, code: "EMPTY_OUTPUT",
        });
      }

      /**
       * ÇIKTI KAYNAKTAN BÜYÜKSE KAYNAĞI KULLAN.
       *
       * Canlıda görüldü: bazı IHA videoları zaten agresif
       * sıkıştırılmış geliyor. Bunları CRF 26'da yeniden
       * kodlayınca dosya BÜYÜYOR (-12%, -10%) ve üstelik
       * yeniden kodlama kayıplı olduğu için kalite de düşüyor.
       *
       * %5'ten fazla kazanç yoksa orijinali kullanmak her
       * açıdan daha iyi: daha küçük dosya, daha iyi kalite,
       * boşa giden CPU yok.
       */
      if (outStat.size > bytesIn * 0.95) {
        log.info("Transcode kazanç sağlamadı, kaynak kullanılıyor", {
          durationSec: info.durationSec,
          bytesIn, transcoded: outStat.size,
        });
        await rm(outPath, { force: true }).catch(() => {});

        return {
          path: inputPath,          // orijinal dosya yüklenecek
          posterPath: poster,
          durationSec: info.durationSec,
          width: info.width, height: info.height,
          bytesIn, bytesOut: bytesIn,
          processingMs: Date.now() - started,
          skipped: false,
          skipReason: "kaynak_daha_kucuk",
          cleanup,
        };
      }

      const outInfo = await this.probe(outPath, signal).catch(() => null);

      const result: VideoResult = {
        path: outPath,
        posterPath: poster,
        durationSec: info.durationSec,
        width: outInfo?.width ?? info.width,
        height: outInfo?.height ?? targetH,
        bytesIn,
        bytesOut: outStat.size,
        processingMs: Date.now() - started,
        skipped: false,
        skipReason: null,
        cleanup,
      };

      log.info("Video işlendi", {
        durationSec: info.durationSec,
        bytesIn, bytesOut: outStat.size,
        saving: `${Math.round((1 - outStat.size / bytesIn) * 100)}%`,
        ms: result.processingMs,
      });

      return result;
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  /** Kapak karesi — %10'undan al, ilk kare genelde siyah olur */
  private async extractPoster(
    input: string, out: string, info: VideoProbe, signal?: AbortSignal,
  ): Promise<void> {
    const seek = Math.min(Math.max(1, Math.floor(info.durationSec * 0.1)), 30);
    await run("ffmpeg", [
      "-nostdin", "-y",
      "-ss", String(seek),
      "-i", input,
      "-frames:v", "1",
      "-vf", "scale='min(1280,iw)':-2",
      "-q:v", "3",
      out,
    ], 60_000, signal);
  }
}
