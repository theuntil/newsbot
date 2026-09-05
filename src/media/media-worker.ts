import { rm } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env, redactUrl } from "../config/env.js";
import { log } from "../lib/logger.js";
import { fingerprint } from "../lib/text.js";
import { BotError, isRetryable, errorCode } from "../lib/errors.js";
import { mapLimit, Semaphore } from "../lib/rate-limit.js";
import type { Db, BotSettings } from "../db/client.js";
import { MediaDownloader } from "./downloader.js";
import { ImageProcessor } from "./image-processor.js";
import { VideoProcessor, checkFfmpeg, isEnvironmentError } from "./video-processor.js";
import { buildStorageKey, putBuffer, putFileStream } from "./storage.js";

export interface MediaJob {
  mediaId: string;
  articleId: string;
  haberKodu: string;
  externalKey: string;
  type: "image" | "video";
  sourceUrl: string;
  sourceBytes: number;
  publishedAt: Date | null;
  attempts: number;
  /** IHA'nın verdiği poster URL'i (varsa ffmpeg yerine bu kullanılır) */
  posterSourceUrl: string | null;
}

export interface MediaWorkerStats {
  processed: number;
  ready: number;
  skipped: number;   // filesize=0, henüz yüklenmemiş
  failed: number;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
}

/**
 * Medya worker'ı.
 *
 * TASARIM KARARLARI:
 *
 * 1. filesize=0 → İNDİRME DENEME. Feed fotoğrafı henüz yüklememiş.
 *    Boşuna istek atmak rate limit israfı; retry zamanlanır.
 *
 * 2. Video AYRI semafor. Tek 14 dakikalık transcode CPU'yu doldurur;
 *    aynı havuzda olsaydı 200 haberin fotoğrafı kuyrukta beklerdi.
 *
 * 3. Geçici dosyalar finally'de HER DURUMDA silinir. Paylaşımlı
 *    sunucuda /tmp dolarsa Supabase de yazamaz hale gelir.
 */
export class MediaWorker {
  private imageProc = new ImageProcessor();
  private videoProc = new VideoProcessor();
  private videoSem: Semaphore;
  private ffmpegWarned = false;

  constructor(
    private db: Db,
    private sb: SupabaseClient,
    private downloader: MediaDownloader,
    videoConcurrency = 1,
  ) {
    this.videoSem = new Semaphore(videoConcurrency);
  }

  /**
   * İşlenmeyi bekleyen medyayı ATOMİK olarak sahiplen.
   *
   * `claim_media_jobs` tek SQL ifadesinde SELECT + UPDATE yapar ve
   * `FOR UPDATE SKIP LOCKED` kullanır. İki worker aynı satırı
   * alamaz. Önceki sürüm önce SELECT edip sonra güncelliyordu;
   * arada başka bir container aynı videoyu kapabilirdi.
   */
  async claimJobs(limit: number, includeVideo = true): Promise<MediaJob[]> {
    const { data, error } = await this.sb.rpc("claim_media_jobs", {
      p_limit: limit,
      p_include_video: includeVideo,
    });

    if (error) { log.error("Medya işi alınamadı", { error }); return []; }

    return (data ?? []).map((r: any) => ({
      mediaId: r.id,
      articleId: r.article_id,
      haberKodu: r.haber_kodu ?? "unknown",
      externalKey: r.external_key ?? r.id,
      type: r.type,
      sourceUrl: r.source_url,
      sourceBytes: r.source_bytes ?? 0,
      publishedAt: r.published_at ? new Date(r.published_at) : null,
      attempts: r.attempts ?? 0,
      posterSourceUrl: r.poster_source_url ?? null,
    }));
  }


  /**
   * Çökme sonrası takılı kalmış kayıtları kurtar.
   *
   * Container 'downloading'/'processing' aşamasındayken ölürse
   * o satırlar sonsuza kadar o durumda kalır ve BİR DAHA
   * İŞLENMEZ. Bu, sessiz medya kaybının klasik sebebidir.
   */
  async recoverStuck(minutes = 30): Promise<number> {
    const { data, error } = await this.sb.rpc("bot_recover_stuck_media", {
      p_minutes: minutes,
    });
    if (error) { log.warn("Takılı medya kurtarma başarısız", { error }); return 0; }
    const n = Number(data ?? 0);
    if (n > 0) log.warn("Takılı medya kurtarıldı", { adet: n });
    return n;
  }

  async runBatch(
    jobs: MediaJob[],
    settings: BotSettings,
    runId: number | null,
    signal?: AbortSignal,
  ): Promise<MediaWorkerStats> {
    const started = Date.now();
    const stats: MediaWorkerStats = {
      processed: 0, ready: 0, skipped: 0, failed: 0,
      bytesIn: 0, bytesOut: 0, durationMs: 0,
    };

    if (!settings.media_enabled || jobs.length === 0) {
      stats.durationMs = Date.now() - started;
      return stats;
    }

    const images = jobs.filter((j) => j.type === "image");
    let videos = jobs.filter((j) => j.type === "video");

    /**
     * ffmpeg yoksa videoyu HİÇ DENEME.
     *
     * Denersek her biri hata alır, 178 kayıt boşuna işlenir ve
     * loglar dolar. Kayıtlar 'pending' kalır; ffmpeg kurulunca
     * (veya Docker'da çalışınca) kendiliğinden işlenirler.
     */
    if (videos.length > 0 && !(await checkFfmpeg())) {
      if (!this.ffmpegWarned) {
        this.ffmpegWarned = true;
        log.warn("═══ ffmpeg KURULU DEĞİL — VİDEO İŞLEME ASKIDA ═══");
        log.warn("Videolar 'pending' olarak bekliyor, kaybolmuyor.");
        log.warn("macOS: brew install ffmpeg   |   Docker imajında zaten var");
      }
      // Uzun bir bekleme koy — sürekli sorgulanmasınlar
      await this.deferVideos(videos);
      videos = [];
    }

    // Görseller: paralel. Videolar: ayrı semafor, CPU'yu tekelleştirmesin.
    const [imgResults, vidResults] = await Promise.all([
      settings.image_enabled
        ? mapLimit(images, settings.media_concurrency, (j) =>
            this.processOne(j, settings, runId, signal))
        : Promise.resolve([]),
      settings.video_enabled
        ? Promise.all(videos.map((j) =>
            this.videoSem.run(() => this.processOne(j, settings, runId, signal)
              .then((v) => ({ ok: true as const, value: v }))
              .catch((error) => ({ ok: false as const, error })))))
        : Promise.resolve([]),
    ]);

    for (const r of [...imgResults, ...vidResults]) {
      stats.processed++;
      if (r.ok) {
        if (r.value.ready) stats.ready++; else stats.skipped++;
        stats.bytesIn += r.value.bytesIn;
        stats.bytesOut += r.value.bytesOut;
      } else {
        stats.failed++;
      }
    }

    stats.durationMs = Date.now() - started;
    if (stats.processed > 0) {
      log.info("Medya partisi tamamlandı", {
        ...stats,
        saving: stats.bytesIn
          ? `${Math.round((1 - stats.bytesOut / stats.bytesIn) * 100)}%` : "0%",
      });
    }
    return stats;
  }

  private async processOne(
    job: MediaJob,
    settings: BotSettings,
    runId: number | null,
    signal?: AbortSignal,
  ): Promise<{ ready: boolean; bytesIn: number; bytesOut: number }> {
    const fp = fingerprint("media", job.mediaId);
    const tempPaths: string[] = [];

    try {
      await this.setStatus(job.mediaId, "downloading");

      const maxBytes = job.type === "image"
        ? settings.image_max_bytes : settings.video_max_bytes;

      const dl = await this.downloader.download({
        url: job.sourceUrl,
        kind: job.type,
        maxBytes,
        timeoutSec: settings.media_download_timeout_sec,
        ratePerSec: settings.media_rate_per_sec,
        signal,
      });
      tempPaths.push(dl.path);

      await this.setStatus(job.mediaId, "processing");

      const storageKey = buildStorageKey({
        haberKodu: job.haberKodu,
        externalKey: job.externalKey,
        publishedAt: job.publishedAt,
      });

      const out = job.type === "image"
        ? await this.handleImage(job, dl.path, storageKey, settings)
        : await this.handleVideo(job, dl.path, storageKey, settings, tempPaths, signal);

      await this.db.resolveFailure(fp).catch(() => {});
      return out;
    } catch (err) {
      await this.handleFailure(job, err, settings, runId, fp);
      throw err;
    } finally {
      // Disk koruması: her koşulda temizle
      await Promise.all(tempPaths.map((p) => rm(p, { force: true }).catch(() => {})));
    }
  }

  private async handleImage(
    job: MediaJob, path: string, storageKey: string, settings: BotSettings,
  ): Promise<{ ready: boolean; bytesIn: number; bytesOut: number }> {
    const result = await this.imageProc.process(path, settings);

    // Varyantları yükle
    const variants: Record<string, { w: number; h: number; b: number; f: string }> = {};
    for (const v of result.variants) {
      await putBuffer(
        `${storageKey}/${v.name}.${v.format}`,
        v.buffer,
        v.format,
        { haberkodu: job.haberKodu },
      );
      variants[v.name] = { w: v.width, h: v.height, b: v.bytes, f: v.format };
    }

    await this.sb.from("media").update({
      status: "ready",
      storage_key: storageKey,
      variants,
      width: result.width,
      height: result.height,
      blurhash: result.blurhash,
      dominant_color: result.dominantColor,
      bytes_in: result.bytesIn,
      bytes_out: result.bytesOut,
      processed_at: new Date().toISOString(),
      last_error: null,
      next_try_at: null,
    }).eq("id", job.mediaId);

    return { ready: true, bytesIn: result.bytesIn, bytesOut: result.bytesOut };
  }

  private async handleVideo(
    job: MediaJob, path: string, storageKey: string,
    settings: BotSettings, tempPaths: string[], signal?: AbortSignal,
  ): Promise<{ ready: boolean; bytesIn: number; bytesOut: number }> {
    const v = await this.videoProc.process(path, settings, signal);
    if (v.path) tempPaths.push(v.path);
    if (v.posterPath) tempPaths.push(v.posterPath);

    const variants: Record<string, unknown> = {};
    let posterKey: string | null = null;
    let posterFrom: "feed" | "ffmpeg" | null = null;

    /**
     * POSTER STRATEJİSİ — iki kademeli:
     *
     * 1. IHA'nın verdiği poster (path_source_url). Haber editörünün
     *    seçtiği kare olduğu için içerik olarak daha isabetli.
     * 2. Bulunamazsa/indirilemezse ffmpeg ile videonun %10'undan
     *    kendi üretiriz (ilk kare genelde siyah olur).
     *
     * Böylece poster ASLA eksik kalmaz.
     */
    let posterSource: string | null = null;

    if (job.posterSourceUrl) {
      try {
        const dl = await this.downloader.download({
          url: job.posterSourceUrl,
          kind: "image",
          maxBytes: settings.image_max_bytes,
          timeoutSec: Math.min(30, settings.media_download_timeout_sec),
          ratePerSec: settings.media_rate_per_sec,
          signal,
        });
        tempPaths.push(dl.path);
        posterSource = dl.path;
        posterFrom = "feed";
      } catch (err) {
        log.debug("Feed posteri indirilemedi, videodan üretilecek", {
          mediaId: job.mediaId, err,
        });
      }
    }

    // Yedek: ffmpeg'in videodan çıkardığı kare
    if (!posterSource && v.posterPath) {
      posterSource = v.posterPath;
      posterFrom = "ffmpeg";
    }

    if (posterSource) {
      try {
        const p = await this.imageProc.process(posterSource, settings);
        for (const pv of p.variants) {
          await putBuffer(`${storageKey}/poster-${pv.name}.${pv.format}`, pv.buffer, pv.format);
        }
        posterKey = `${storageKey}/poster`;
        variants.poster = {
          f: settings.image_format,
          w: p.width, h: p.height,
          blurhash: p.blurhash,
          src: posterFrom,           // feed mi ffmpeg mi — teşhis için
        };
      } catch (err) {
        log.warn("Poster işlenemedi", { mediaId: job.mediaId, err });
      }
    }

    if (v.skipped) {
      // Transcode edilmedi: poster var, video yok. Kalıcı durum.
      await this.sb.from("media").update({
        status: "skipped",
        storage_key: storageKey,
        poster_key: posterKey,
        variants,
        duration_sec: v.durationSec,
        width: v.width, height: v.height,
        bytes_in: v.bytesIn, bytes_out: 0,
        processed_at: new Date().toISOString(),
        last_error: `Transcode atlandı: ${v.skipReason}`,
        next_try_at: null,
      }).eq("id", job.mediaId);

      return { ready: false, bytesIn: v.bytesIn, bytesOut: 0 };
    }

    // Video AKIŞLA yüklenir — belleğe alınmaz
    await putFileStream(`${storageKey}/video.mp4`, v.path, "mp4", {
      haberkodu: job.haberKodu,
    });
    variants.video = { f: "mp4", b: v.bytesOut, w: v.width, h: v.height, d: v.durationSec };

    await this.sb.from("media").update({
      status: "ready",
      storage_key: storageKey,
      poster_key: posterKey,
      variants,
      duration_sec: v.durationSec,
      width: v.width, height: v.height,
      bytes_in: v.bytesIn, bytes_out: v.bytesOut,
      processed_at: new Date().toISOString(),
      last_error: null, next_try_at: null,
    }).eq("id", job.mediaId);

    log.debug("Video kaydedildi", {
      mediaId: job.mediaId, poster: posterFrom ?? "yok",
      durationSec: v.durationSec,
    });

    return { ready: true, bytesIn: v.bytesIn, bytesOut: v.bytesOut };
  }

  /** ffmpeg yokken videoları ileri tarihe ötele — asla 'failed' yapma */
  private async deferVideos(jobs: MediaJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const next = new Date(Date.now() + 30 * 60_000).toISOString();
    await this.sb.from("media")
      .update({ status: "pending", next_try_at: next, last_error: "ffmpeg yok — bekliyor" })
      .in("id", jobs.map((j) => j.mediaId));
    log.info("Videolar ertelendi (ffmpeg yok)", { count: jobs.length, nextTry: next });
  }

  /**
   * Hata yönetimi.
   * Kalıcı hata (404, bozuk dosya) → hemen 'failed', retry yok.
   * ORTAM hatası (ffmpeg yok) → asla 'failed' yapma, ötele.
   * Geçici hata → backoff ile tekrar, deneme hakkı dolunca 'failed'.
   */
  private async handleFailure(
    job: MediaJob, err: unknown, settings: BotSettings,
    runId: number | null, fp: string,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;

    // ORTAM hatası: araç eksik. Kaydı öldürme, deneme sayacını da artırma.
    if (isEnvironmentError(err)) {
      await this.sb.from("media").update({
        status: "pending",
        last_error: message.slice(0, 500),
        next_try_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }).eq("id", job.mediaId);
      return;
    }

    const permanent = !isRetryable(err);
    const exhausted = attempts >= settings.media_max_attempts;

    if (permanent || exhausted) {
      await this.sb.from("media").update({
        status: "failed",
        attempts,
        last_error: message.slice(0, 1000),
        next_try_at: null,
      }).eq("id", job.mediaId);

      log.warn("Medya kalıcı olarak başarısız", {
        mediaId: job.mediaId, haberKodu: job.haberKodu,
        attempts, permanent, err,
      });
    } else {
      // Üstel backoff: 1, 2, 4, 8... dakika, tavan 30 dk
      const delayMin = Math.min(2 ** (attempts - 1), 30);
      await this.sb.from("media").update({
        status: "pending",
        attempts,
        last_error: message.slice(0, 1000),
        next_try_at: new Date(Date.now() + delayMin * 60_000).toISOString(),
      }).eq("id", job.mediaId);
    }

    await this.db.logFailure({
      kind: job.type === "video" ? "media_process" : "media_fetch",
      fingerprint: fp,
      error: message,
      runId,
      haberKodu: job.haberKodu,
      articleId: job.articleId,
      mediaId: job.mediaId,
      targetUrl: redactUrl(job.sourceUrl),
      errorCode: errorCode(err),
      stack: err instanceof Error ? err.stack ?? null : null,
      maxAttempts: settings.media_max_attempts,
      backoffSec: 120,
    });
  }

  private async setStatus(mediaId: string, status: string): Promise<void> {
    await this.sb.from("media").update({ status }).eq("id", mediaId);
  }
}
