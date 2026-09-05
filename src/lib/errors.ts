
export type FailureKind =
  | "feed_fetch" | "feed_parse" | "item_parse" | "item_ingest"
  | "media_fetch" | "media_process" | "media_upload" | "unknown";

/**
 * Hata sınıflandırması.
 *
 * Neden önemli: "tekrar denenebilir" ile "kalıcı" hatayı ayırmazsan
 * 404 alan bir görseli 7 kez daha denersin — hem boşuna kaynak,
 * hem rate limit israfı. Tersine, geçici 503'te pes edersen
 * haber kalıcı olarak medyasız kalır.
 */
export class BotError extends Error {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  readonly critical: boolean;
  readonly code: string | null;
  readonly context: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      kind: FailureKind;
      retryable?: boolean;
      critical?: boolean;
      code?: string | null;
      cause?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = "BotError";
    this.kind = opts.kind;
    this.retryable = opts.retryable ?? true;
    this.critical = opts.critical ?? false;
    this.code = opts.code ?? null;
    this.context = opts.context ?? {};
  }
}

/** Kimlik doğrulama hatası — retry anlamsız, ANINDA mail gerekir */
export function authError(message: string, code?: string): BotError {
  return new BotError(message, {
    kind: "feed_fetch", retryable: false, critical: true, code: code ?? "AUTH",
  });
}

/** HTTP durum kodundan sınıflandırma */
export function classifyHttp(status: number, kind: FailureKind, url?: string): BotError {
  // 401/403: şifre değişmiş veya abonelik bitmiş → insan müdahalesi şart
  if (status === 401 || status === 403) {
    return new BotError(`Yetkilendirme reddedildi (${status})`, {
      kind, retryable: false, critical: true, code: `HTTP_${status}`, context: { url },
    });
  }
  // 404/410: kaynak yok, tekrar denemek anlamsız
  if (status === 404 || status === 410) {
    return new BotError(`Kaynak bulunamadı (${status})`, {
      kind, retryable: false, code: `HTTP_${status}`, context: { url },
    });
  }
  // 429: rate limit — geri çekil ama pes etme
  if (status === 429) {
    return new BotError("Hız sınırı aşıldı (429)", {
      kind, retryable: true, code: "HTTP_429", context: { url },
    });
  }
  // 5xx: sunucu sorunu, geçici kabul et
  if (status >= 500) {
    return new BotError(`Sunucu hatası (${status})`, {
      kind, retryable: true, code: `HTTP_${status}`, context: { url },
    });
  }
  return new BotError(`Beklenmeyen HTTP ${status}`, {
    kind, retryable: status >= 500, code: `HTTP_${status}`, context: { url },
  });
}

/** Ağ seviyesi hataları — neredeyse hepsi geçici */
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH",
  "ENETUNREACH", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

export function classifyNetwork(err: unknown, kind: FailureKind): BotError {
  if (err instanceof BotError) return err;

  const e = err as { name?: string; code?: string; message?: string; cause?: any };
  const code = e?.code ?? e?.cause?.code ?? null;

  if (e?.name === "AbortError" || e?.name === "TimeoutError") {
    return new BotError("İstek zaman aşımına uğradı", {
      kind, retryable: true, code: "TIMEOUT", cause: err,
    });
  }
  if (code && TRANSIENT_CODES.has(code)) {
    return new BotError(`Ağ hatası: ${code}`, { kind, retryable: true, code, cause: err });
  }

  return new BotError(e?.message || "Bilinmeyen hata", {
    kind, retryable: true, code, cause: err,
  });
}

export function isRetryable(err: unknown): boolean {
  return err instanceof BotError ? err.retryable : true;
}

export function isCritical(err: unknown): boolean {
  return err instanceof BotError ? err.critical : false;
}

export function errorKind(err: unknown): FailureKind {
  return err instanceof BotError ? err.kind : "unknown";
}

export function errorCode(err: unknown): string | null {
  if (err instanceof BotError) return err.code;
  const c = (err as any)?.code;
  return typeof c === "string" ? c : null;
}
