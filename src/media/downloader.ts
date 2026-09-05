import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { env, redactUrl } from "../config/env.js";
import { log } from "../lib/logger.js";
import { BotError, classifyHttp, classifyNetwork } from "../lib/errors.js";
import { RateLimiter } from "../lib/rate-limit.js";

/**
 * SSRF koruması.
 *
 * source_url DB'den geliyor ve DB'ye feed'den giriyor. Feed ele
 * geçirilse veya birisi media tablosuna satır ekleyebilse,
 * worker'a "http://169.254.169.254/latest/meta-data" gibi bir adres
 * verip iç ağ taraması yaptırabilirdi. Bu yüzden host beyaz listesi.
 * (DB tarafında da CHECK constraint var — iki katman.)
 */
const ALLOWED_HOST_RE = /(^|\.)iha\.com\.tr$/i;

export function assertSafeUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch {
    throw new BotError("Geçersiz medya URL'i", {
      kind: "media_fetch", retryable: false, code: "BAD_URL",
    });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new BotError(`İzin verilmeyen protokol: ${u.protocol}`, {
      kind: "media_fetch", retryable: false, code: "BAD_PROTOCOL",
    });
  }
  if (!ALLOWED_HOST_RE.test(u.hostname)) {
    throw new BotError(`İzin verilmeyen host: ${u.hostname}`, {
      kind: "media_fetch", retryable: false, code: "HOST_NOT_ALLOWED",
    });
  }
  return u;
}

const IMAGE_TYPES = /^image\/(jpeg|jpg|png|webp|avif|gif|tiff|bmp)/i;
const VIDEO_TYPES = /^(video\/|application\/octet-stream)/i;

export interface DownloadResult {
  path: string;
  bytes: number;
  contentType: string;
  durationMs: number;
  cleanup: () => Promise<void>;
}

export class MediaDownloader {
  constructor(private limiter: RateLimiter) {}

  /**
   * Medyayı DİSKE indirir, belleğe değil.
   *
   * Neden: 82 MB video × 3 paralel = 250 MB bellek, artı ffmpeg'in
   * kendi kullanımı. Container limiti aşılır, OOM-kill gelir.
   * Diske yazıp ffmpeg'e dosya yolu vermek hem güvenli hem hızlı.
   */
  async download(opts: {
    url: string;
    kind: "image" | "video";
    maxBytes: number;
    timeoutSec: number;
    ratePerSec: number;
    signal?: AbortSignal;
  }): Promise<DownloadResult> {
    const u = assertSafeUrl(opts.url);
    const safe = redactUrl(opts.url);
    const started = Date.now();

    // Medya sunucusu için ayrı hız sınırı (feed limitinden bağımsız)
    const minInterval = Math.max(1, Math.round(1000 / Math.max(0.1, opts.ratePerSec)));
    await this.limiter.acquire("iha:media", minInterval, opts.signal);

    await mkdir(env.tmpDir, { recursive: true });
    const tmpPath = join(env.tmpDir, `dl-${randomUUID()}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutSec * 1000);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = async () => { await rm(tmpPath, { force: true }).catch(() => {}); };

    try {
      const res = await globalThis.fetch(u.toString(), {
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          // Hotlink koruması olabilir — Referer olmadan 403 döner
          "Referer": env.iha.referer,
          "User-Agent": "Mozilla/5.0 (compatible; KuzeybatiHaberBot/1.0)",
          "Accept": opts.kind === "image"
            ? "image/avif,image/webp,image/jpeg,image/*;q=0.8,*/*;q=0.5"
            : "video/mp4,video/*;q=0.9,*/*;q=0.5",
        },
      });

      if (!res.ok) throw classifyHttp(res.status, "media_fetch", safe);

      const ct = (res.headers.get("content-type") ?? "").toLowerCase();

      /**
       * İçerik tipi doğrulaması.
       * IHA hata durumunda HTML döndürüyor. Bunu .jpg diye kaydedersen
       * sharp patlar veya daha kötüsü bozuk dosya CDN'e gider.
       */
      if (ct.includes("text/html")) {
        throw new BotError("Medya yerine HTML döndü (muhtemelen hata sayfası)", {
          kind: "media_fetch", retryable: true, code: "HTML_RESPONSE",
          context: { url: safe, contentType: ct },
        });
      }
      const expected = opts.kind === "image" ? IMAGE_TYPES : VIDEO_TYPES;
      if (ct && !expected.test(ct)) {
        throw new BotError(`Beklenmeyen içerik tipi: ${ct}`, {
          kind: "media_fetch", retryable: false, code: "BAD_CONTENT_TYPE",
          context: { url: safe },
        });
      }

      // İndirmeden önce boyut kontrolü — 500 MB'lik dosyayı hiç başlatma
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > opts.maxBytes) {
        throw new BotError(`Dosya çok büyük: ${declared} bayt`, {
          kind: "media_fetch", retryable: false, code: "TOO_LARGE",
          context: { url: safe, declared, max: opts.maxBytes },
        });
      }
      if (!res.body) {
        throw new BotError("Yanıt gövdesi boş", {
          kind: "media_fetch", retryable: true, code: "NO_BODY",
        });
      }

      // Akış halinde diske yaz, sayarak sınırı uygula
      let written = 0;
      const limiter = new TransformSizeGuard(opts.maxBytes, () => { written = limiter.total; });

      await pipeline(
        Readable.fromWeb(res.body as any),
        limiter.stream,
        createWriteStream(tmpPath),
      );
      written = limiter.total;

      if (written === 0) {
        throw new BotError("İndirilen dosya boş (0 bayt)", {
          kind: "media_fetch", retryable: true, code: "EMPTY_FILE",
        });
      }

      const st = await stat(tmpPath);
      log.debug("Medya indirildi", {
        url: safe, bytes: st.size, contentType: ct, ms: Date.now() - started,
      });

      return {
        path: tmpPath,
        bytes: st.size,
        contentType: ct,
        durationMs: Date.now() - started,
        cleanup,
      };
    } catch (err) {
      await cleanup();
      if (err instanceof BotError) throw err;
      throw classifyNetwork(err, "media_fetch");
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Akışta bayt sayan ve sınırı aşınca kesen geçiş katmanı */
class TransformSizeGuard {
  total = 0;
  stream: Transform;

  constructor(maxBytes: number, onEnd?: () => void) {
    const self = this;
    this.stream = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        self.total += chunk.length;
        if (self.total > maxBytes) {
          cb(new BotError(`İndirme boyut sınırını aştı (>${maxBytes})`, {
            kind: "media_fetch", retryable: false, code: "TOO_LARGE",
          }));
          return;
        }
        cb(null, chunk);
      },
      flush(cb) { onEnd?.(); cb(); },
    });
  }
}
