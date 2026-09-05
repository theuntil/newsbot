/**
 * Ortam değişkenleri — açılışta doğrulanır.
 *
 * TASARIM: Eksik/bozuk env varsa bot BAŞLAMAZ (fail-fast).
 * Yarı çalışan bot, hiç çalışmayan bottan tehlikelidir:
 * haberleri alır ama medyayı kaydedemez, sen de fark etmezsin.
 *
 * Çalışma zamanı ayarları (aralık, kalite, video eşikleri) burada DEĞİL —
 * onlar bot_settings tablosunda, panelden değiştirilebilir.
 * Burada sadece sırlar ve altyapı adresleri var.
 */

function required(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) {
    throw new Error(
      `Eksik ortam değişkeni: ${key}\n\n` +
      `  .env dosyası var mı ve bu değişken dolu mu kontrol et.\n` +
      `  Yerelde çalıştırırken:  npm start   (otomatik .env okur)\n` +
      `  veya:                   node --env-file=.env dist/index.js\n` +
      `  Docker'da .env otomatik yüklenir (env_file).\n`,
    );
  }
  return v;
}

function optional(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} sayı olmalı, gelen: ${raw}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "evet"].includes(raw);
}

function assertUrl(key: string, value: string): string {
  try { new URL(value); } catch { throw new Error(`${key} geçerli URL değil: ${value}`); }
  return value.replace(/\/+$/, "");
}

export const env = {
  nodeEnv: optional("NODE_ENV", "production"),
  isDev: optional("NODE_ENV") === "development",
  logLevel: optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
  /** "pretty" = okunabilir (varsayılan), "json" = log toplayıcı için */
  logFormat: (optional("LOG_FORMAT", "pretty") === "json" ? "json" : "pretty") as "pretty" | "json",
  /** Aynı DB'ye bakan birden fazla instance'ı ayırt etmek için */
  instanceId: optional("INSTANCE_ID", `bot-${process.pid}`),

  // ---- IHA ------------------------------------------------
  iha: {
    baseUrl: assertUrl("IHA_RSS_URL", required("IHA_RSS_URL")),
    userCode: required("IHA_USER_CODE"),
    userName: required("IHA_USER_NAME"),
    userPassword: required("IHA_USER_PASSWORD"),
    /**
     * Sağlayıcı kuralı: istekler arası minimum 30 saniye.
     *
     * 33 sn kullanıyoruz — 3 sn güvenlik payı. Canlıda tam 30 sn'de
     * bile "en az 30 saniye olmalıdır" hatası alındı; IHA süreyi
     * kendi tarafında ölçüyor ve ağ gecikmesi/saat kayması sınırı
     * delebiliyor. Bu değer 30000'in ALTINA indirilemez.
     */
    minIntervalMs: Math.max(30_000, num("IHA_MIN_INTERVAL_MS", 33_000)),
    /** Medya sunucusu hotlink koruması yapıyor olabilir */
    referer: optional("IHA_REFERER", "https://www.iha.com.tr/"),
  },

  // ---- Supabase -------------------------------------------
  supabase: {
    url: assertUrl("SUPABASE_URL", required("SUPABASE_URL")),
    /** service_role: RLS'i bypass eder. ASLA istemciye gitmez. */
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  },

  // ---- R2 (S3 uyumlu) -------------------------------------
  s3: {
    endpoint: assertUrl("S3_ENDPOINT", required("S3_ENDPOINT")),
    region: optional("S3_REGION", "auto"),
    bucket: required("S3_BUCKET"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    /** Public CDN kökü — DB'de tam URL saklanmaz, burada birleşir */
    cdnBase: assertUrl("CDN_BASE", required("CDN_BASE")),
  },

  // ---- Redis ----------------------------------------------
  redis: {
    url: optional("REDIS_URL", "redis://127.0.0.1:6379"),
    prefix: optional("REDIS_PREFIX", "haberbot"),
  },

  // ---- SMTP (Hostinger) -----------------------------------
  smtp: {
    enabled: bool("SMTP_ENABLED", true),
    host: optional("SMTP_HOST", "smtp.hostinger.com"),
    port: num("SMTP_PORT", 465),
    secure: bool("SMTP_SECURE", true),
    user: optional("SMTP_USER"),
    pass: optional("SMTP_PASS"),
    from: optional("SMTP_FROM", "Haber Bot <bot@localhost>"),
  },

  // ---- Geçici dosyalar ------------------------------------
  tmpDir: optional("TMP_DIR", "/tmp/haberbot"),
  /** Disk koruması: paylaşımlı sunucuda /tmp dolarsa Supabase de yazamaz */
  tmpMaxBytes: num("TMP_MAX_BYTES", 10 * 1024 ** 3),

  // ---- Sağlık ---------------------------------------------
  healthPort: num("HEALTH_PORT", 8080),
} as const;

/** Kimlik bilgileri query string'de — bu URL asla loglanmaz */
export function buildFeedUrl(): string {
  const u = new URL(env.iha.baseUrl);
  u.searchParams.set("UserCode", env.iha.userCode);
  u.searchParams.set("UserName", env.iha.userName);
  u.searchParams.set("UserPassword", env.iha.userPassword);
  return u.toString();
}

/** Log ve hata mesajlarında kullanılacak güvenli sürüm */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ["UserPassword", "UserCode", "UserName", "param1", "token", "sig"]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, "***");
    }
    return u.toString();
  } catch {
    return "***";
  }
}

/** Açılışta çağrılır; env bozuksa burada patlar */
export function validateEnv(): void {
  if (env.iha.minIntervalMs < 30_000) {
    throw new Error("IHA_MIN_INTERVAL_MS 30000'in altına indirilemez (sağlayıcı limiti)");
  }
  if (env.smtp.enabled && (!env.smtp.user || !env.smtp.pass)) {
    throw new Error("SMTP_ENABLED=true ama SMTP_USER/SMTP_PASS eksik");
  }
  if (!env.supabase.serviceKey.startsWith("eyJ") && env.supabase.serviceKey.length < 40) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY geçersiz görünüyor");
  }
}
