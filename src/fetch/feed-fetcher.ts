import { env, buildFeedUrl, redactUrl } from "../config/env.js";
import { log } from "../lib/logger.js";
import { classifyHttp, classifyNetwork, BotError } from "../lib/errors.js";
import { RateLimiter, withRetry } from "../lib/rate-limit.js";

export interface FetchFeedResult {
  xml: string;
  bytes: number;
  httpStatus: number;
  durationMs: number;
  waitedMs: number;
  attempts: number;
}

/** Beklenen üst sınır — bunun üstü ya saldırı ya arıza */
const MAX_FEED_BYTES = 32 * 1024 * 1024;

/** IHA feed HTML döndürüyorsa (hata sayfası) XML sanıp parse etme */
/**
 * Yanıt gövdesindeki sırları temizle.
 *
 * KRİTİK: IHA hız sınırı mesajında kimlik bilgilerini GERİ GÖNDERİYOR:
 *   "[ UserCode=7350 , UserName=kuzey , UserPassword=iharss3 ]"
 * Bu metni ham loglarsak şifre Dokploy log ekranında kalıcı olur.
 * URL maskelemesi yeterli değil — gövde de temizlenmeli.
 */
function redactBody(text: string): string {
  return text
    .replace(/(User(?:Password|Code|Name)\s*=\s*)[^\s,\]&]+/gi, "$1***")
    .replace(/(password|sifre|şifre|token|key)\s*[:=]\s*[^\s,\]&]+/gi, "$1=***");
}

/** IHA hız sınırı mesajı — düz metin döner, XML değil */
const RATE_LIMIT_RE = /iki rss iste[gğ]i aras[ıi]ndaki s[uü]re|en az 30 saniye|rate limit|too many request/i;

function assertLooksLikeXml(text: string, url: string): void {
  const clean = text.replace(/^\uFEFF/, "").trimStart();
  const head = clean.slice(0, 500).toLowerCase();

  // Hız sınırı: TUR İÇİNDE TEKRAR DENEME.
  //
  // Canlıda tespit edildi: her turda 2 istek gidiyordu — biri
  // sınıra takılıyor, retry 30 sn dolmadan tekrar gidiyor,
  // o da takılıyordu. Tekrar denemenin kendisi sorunun kaynağıydı.
  //
  // Çözüm: bu turda pes et, bir sonraki tur normal aralıkla dener.
  // Böylece tur başına TAM 1 istek gider.
  if (RATE_LIMIT_RE.test(clean.slice(0, 400))) {
    throw new BotError("Sağlayıcı hız sınırı — bu tur atlandı, sonraki turda denenecek", {
      kind: "feed_fetch", retryable: false, code: "PROVIDER_RATE_LIMIT",
      context: { url: redactUrl(url), preview: redactBody(clean.slice(0, 200)) },
    });
  }

  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    throw new BotError("Feed yerine HTML döndü (muhtemelen hata/giriş sayfası)", {
      kind: "feed_fetch", retryable: true, code: "HTML_RESPONSE",
      context: { url: redactUrl(url), preview: redactBody(clean.slice(0, 300)) },
    });
  }

  const looksXml =
    head.includes("<?xml") ||
    head.includes("<rss") ||
    head.includes("<channel") ||
    head.includes("<feed") ||
    /^<[a-z_][\w:.-]*[\s>]/.test(head);

  if (!looksXml) {
    throw new BotError("Yanıt XML'e benzemiyor", {
      kind: "feed_fetch", retryable: true, code: "NOT_XML",
      context: {
        url: redactUrl(url),
        bytes: Buffer.byteLength(text),
        preview: redactBody(clean.slice(0, 300)),
      },
    });
  }
}

/**
 * Yanıtı akış halinde oku ve boyut sınırını AŞARSA kes.
 *
 * Neden: res.text() önce her şeyi belleğe alır. Sunucu bozulup
 * 2 GB gönderirse container OOM ile ölür. Akışta sayarak keseriz.
 */
async function readTextLimited(res: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new BotError(`Feed çok büyük: ${declared} bayt`, {
      kind: "feed_fetch", retryable: false, code: "TOO_LARGE",
    });
  }

  if (!res.body) {
    const text = await res.text();
    return { text, bytes: Buffer.byteLength(text) };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BotError(`Feed boyut sınırını aştı (>${maxBytes} bayt)`, {
          kind: "feed_fetch", retryable: false, code: "TOO_LARGE",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}

export class FeedFetcher {
  /**
   * Son GERÇEK istek zamanı.
   *
   * Slot hesabından bağımsız ikinci güvenlik kilidi. Slot mantığı
   * (kuyruk kayması, saat sapması, event loop gecikmesi) yanılsa
   * bile bu kontrol 30 sn kuralının altına inilmesini engeller.
   */
  private lastRequestAt = 0;

  constructor(private limiter: RateLimiter) {}

  /** Gerekirse gerçek zamana göre ek bekleme yap */
  private async enforceMinGap(signal?: AbortSignal): Promise<number> {
    if (this.lastRequestAt === 0) return 0;
    const elapsed = Date.now() - this.lastRequestAt;
    const need = env.iha.minIntervalMs - elapsed;
    if (need <= 0) return 0;

    log.debug("Mutlak aralık kilidi devrede", { bekleme: need });
    const step = 250;
    let waited = 0;
    while (waited < need) {
      if (signal?.aborted) throw new Error("İptal edildi");
      await new Promise((r) => setTimeout(r, Math.min(step, need - waited)));
      waited += step;
    }
    return need;
  }

  /**
   * Feed'i çeker.
   *
   * Katmanlar:
   *  1. Rate limit  — 30 sn kuralı, Redis'te global
   *  2. Timeout     — takılı kalan istek turu kilitlemesin
   *  3. Retry       — sadece geçici hatalarda, jitter'lı backoff
   *  4. Boyut sınırı— akışta kesilir, OOM olmaz
   *  5. İçerik kontrolü — HTML hata sayfasını XML sanmaz
   */
  async fetch(opts: {
    timeoutSec: number;
    maxRetries: number;
    userAgent: string;
    signal?: AbortSignal;
  }): Promise<FetchFeedResult> {
    const url = buildFeedUrl();
    const safeUrl = redactUrl(url);
    const started = Date.now();
    let attempts = 0;
    let waitedMs = 0;

    const result = await withRetry(
      async (attempt) => {
        attempts = attempt + 1;

        /**
         * HIZ SINIRI HER DENEMEDE UYGULANIR.
         *
         * Önceden sadece ilk istekte alınıyordu; tekrar denemeler
         * 1.4 sn sonra gidip 30 sn kuralını deliyordu. IHA düz metin
         * "en az 30 saniye olmalıdır" dönüyor, bu da NOT_XML olarak
         * patlıyor ve tüm tur çöküyordu. Canlıda tespit edildi.
         */
        waitedMs += await this.limiter.acquire(
          "iha:feed", env.iha.minIntervalMs, opts.signal,
        );
        // İkinci kilit: gerçek saate göre de aralık dolmuş olmalı
        waitedMs += await this.enforceMinGap(opts.signal);
        this.lastRequestAt = Date.now();

        const timer = new AbortController();
        const to = setTimeout(() => timer.abort(), opts.timeoutSec * 1000);
        const onAbort = () => timer.abort();
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        try {
          const res = await globalThis.fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: timer.signal,
            headers: {
              "User-Agent": opts.userAgent,
              "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
              "Accept-Encoding": "gzip, deflate",
              "Cache-Control": "no-cache",
            },
          });

          if (!res.ok) throw classifyHttp(res.status, "feed_fetch", safeUrl);

          const { text, bytes } = await readTextLimited(res, MAX_FEED_BYTES);

          if (bytes === 0) {
            throw new BotError("Feed boş döndü (0 bayt)", {
              kind: "feed_fetch", retryable: true, code: "EMPTY",
            });
          }

          assertLooksLikeXml(text, url);

          return { xml: text, bytes, httpStatus: res.status };
        } catch (err) {
          throw classifyNetwork(err, "feed_fetch");
        } finally {
          clearTimeout(to);
          opts.signal?.removeEventListener("abort", onAbort);
        }
      },
      {
        attempts: Math.max(1, opts.maxRetries + 1),
        // Hız sınırına takıldıysak backoff'un kendisi de uzun olmalı;
        // limiter zaten bekletiyor ama üstüne pay bırakıyoruz.
        baseMs: 3000,
        capMs: 45_000,
        signal: opts.signal,
        onRetry: (n, delay, err) => {
          log.warn("Feed çekme başarısız, tekrar denenecek", {
            attempt: n, delayMs: delay, err,
          });
        },
      },
    );

    const durationMs = Date.now() - started;
    log.info("Feed alındı", {
      bytes: result.bytes, httpStatus: result.httpStatus, durationMs, attempts, waitedMs,
    });

    return { ...result, durationMs, waitedMs, attempts };
  }
}
