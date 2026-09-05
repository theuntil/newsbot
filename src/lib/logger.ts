/**
 * Yapılandırılmış logger.
 *
 * KRİTİK: Sırlar loglanmaz. IHA feed URL'i şifreyi query string'de
 * taşıyor; bir hata mesajında düz loglanırsa şifre Dokploy log
 * ekranında ve varsa log toplayıcıda kalıcı olur.
 * Bu yüzden tüm çıktı redaction filtresinden geçer.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let minLevel: Level = "info";
let instanceId = "bot";
/** "pretty" = insan okuyabilir, "json" = makine/log toplayıcı */
let format: "pretty" | "json" = "pretty";

export function configureLogger(
  level: Level, instance: string, fmt: "pretty" | "json" = "pretty",
): void {
  minLevel = level;
  instanceId = instance;
  format = fmt;
}

/** Bayt → okunabilir */
function human(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** Süre → okunabilir */
function dur(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}dk ${Math.round((ms % 60_000) / 1000)}sn`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}sn`;
  return `${ms}ms`;
}

const ICONS: Record<Level, string> = {
  debug: "·", info: "•", warn: "!", error: "✗",
};

/**
 * Bilinen olayları tek satırlık, anlaşılır özete çevirir.
 * Bilinmeyenler için genel biçim kullanılır.
 */
function prettify(msg: string, c: Record<string, unknown>): string {
  const n = (k: string) => Number(c[k] ?? 0);

  switch (msg) {
    case "Feed alındı":
      return `Feed alındı — ${human(n("bytes"))}, ${dur(n("durationMs"))}` +
        (n("waitedMs") > 0 ? `, ${dur(n("waitedMs"))} beklendi` : "");

    case "Ingest planı":
      return `Haberler: ${c.total} geldi → ${c.willProcess} işlenecek, ` +
        `${c.unchanged} değişmemiş, ${c.newCodes} yeni`;

    case "Ingest tamamlandı": {
      const parts = [`${c.created} yeni`];
      if (n("updated")) parts.push(`${c.updated} güncel`);
      if (n("failed")) parts.push(`${c.failed} HATA`);
      if (n("mediaQueued")) parts.push(`${c.mediaQueued} medya kuyruğa`);
      return `Haber işlendi: ${parts.join(", ")} (${dur(n("durationMs"))})`;
    }

    case "Medya partisi tamamlandı": {
      const p = [`${c.ready} tamam`];
      if (n("failed")) p.push(`${c.failed} HATA`);
      if (n("skipped")) p.push(`${c.skipped} atlandı`);
      const save = n("bytesIn") ? ` · ${human(n("bytesIn"))} → ${human(n("bytesOut"))} (${c.saving})` : "";
      return `Medya: ${p.join(", ")}${save}`;
    }

    case "Video işlendi":
      return `Video: ${Math.floor(n("durationSec") / 60)}:${String(n("durationSec") % 60).padStart(2, "0")} · ` +
        `${human(n("bytesIn"))} → ${human(n("bytesOut"))} (${c.saving} küçüldü) · ${dur(n("ms"))}`;

    case "Görsel işlendi":
      return `Görsel: ${c.source} · ${c.variants} boyut · ${c.saving} küçüldü`;

    case "Bot AÇIK":
      return `Bot AÇIK — her ${c.aralikSn} sn, medya:${c.medya ? "✓" : "✗"} ` +
        `video:${c.video ? "✓" : "✗"} mail:${c.bildirim ? "✓" : "✗"} · toplam ${c.toplamHaber} haber`;

    default:
      return msg;
  }
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;

  const clean = ctx ? (redact(ctx) as Record<string, unknown>) : {};

  if (format === "json") {
    const line = {
      t: new Date().toISOString(), lvl: level, inst: instanceId,
      msg: redactString(msg), ...clean,
    };
    const out = JSON.stringify(line);
    if (level === "error" || level === "warn") process.stderr.write(out + "\n");
    else process.stdout.write(out + "\n");
    return;
  }

  // --- pretty ---
  const time = new Date().toLocaleTimeString("tr-TR", {
    hour12: false, timeZone: "Europe/Istanbul",
  });

  let text = prettify(redactString(msg), clean);

  // Özetlenmemiş alanlar varsa kısaca ekle
  if (text === redactString(msg)) {
    const extra = Object.entries(clean)
      .filter(([k]) => k !== "err" && k !== "error" && k !== "stack")
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 60) : v}`)
      .slice(0, 5)
      .join(" ");
    if (extra) text += `  ${extra}`;
  }

  // Hata varsa sebebi tek satırda göster
  const e = (clean.err ?? clean.error) as Record<string, unknown> | undefined;
  if (e && typeof e === "object") {
    const em = e.message ?? e.msg ?? "";
    const ec = e.code ? ` [${e.code}]` : "";
    if (em) text += `\n    ↳${ec} ${String(em).slice(0, 200)}`;
    const cx = e.context as Record<string, unknown> | undefined;
    if (cx?.preview) text += `\n    ↳ yanıt: ${String(cx.preview).slice(0, 160)}`;
  }

  const out = `${time} ${ICONS[level]} ${text}\n`;
  if (level === "error" || level === "warn") process.stderr.write(out);
  else process.stdout.write(out);
}

/**
 * Maskelenecek alan adları.
 *
 * DENGE: Çok geniş olursa teşhis bilgisini de gizler (önceden /key/
 * vardı, "key":"alert-recovery" bile maskeleniyordu). Çok dar olursa
 * sır sızar. Bu yüzden: sır SÖZCÜĞÜ alan adının herhangi bir yerinde
 * geçebilir, ama "key" tek başına yeterli değil — nitelenmiş olmalı
 * (apiKey, accessKey, secretKey, service_role_key...).
 */
const SECRET_KEYS = new RegExp(
  [
    "pass(word|wd)?",                         // password, pass, SMTP_PASS
    "secret",                                 // secret, secretAccessKey
    // "token" tek başına DEĞİL: tokenIn/tokenOut gibi sayaç
    // alanlarını maskeliyordu ve teşhis imkânsızlaşıyordu.
    "(access|refresh|id|bearer|auth|api|secret|session)[_-]?token",
    "token[_-]?(secret|value|string)",
    "^tokens?$",
    "credential",
    "authorization",
    "cookie",
    "(api|access|secret|private|public|role|encryption|signing)[_-]?key",
    "service[_-]?role",
    "\\bauth\\b",
    "bearer",
    "session[_-]?id",
  ].join("|"),
  "i",
);

/** Metin içinde geçen hassas query parametreleri */
const SECRET_PARAMS = /([?&](?:UserPassword|UserCode|UserName|param1|token|sig|X-Amz-Signature)=)[^&\s"']+/gi;

function redactString(s: string): string {
  return s.replace(SECRET_PARAMS, "$1***");
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[derin]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;

  if (value instanceof Error) {
    const e = value as Error & { code?: unknown; context?: unknown };
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack).split("\n").slice(0, 6).join("\n") : undefined,
      ...(e.code !== undefined ? { code: e.code } : {}),
      // BotError.context teşhis için kritik (örn. NOT_XML'de yanıt önizlemesi).
      // Bunu atlarsak hatanın SEBEBİNİ göremeyiz.
      ...(e.context !== undefined ? { context: redact(e.context, depth + 1) } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redact(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "***" : redact(v, depth + 1);
  }
  return out;
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),

  /** Alt bileşenler için sabit bağlamlı logger */
  child(base: Record<string, unknown>) {
    return {
      debug: (m: string, c?: Record<string, unknown>) => emit("debug", m, { ...base, ...c }),
      info:  (m: string, c?: Record<string, unknown>) => emit("info", m, { ...base, ...c }),
      warn:  (m: string, c?: Record<string, unknown>) => emit("warn", m, { ...base, ...c }),
      error: (m: string, c?: Record<string, unknown>) => emit("error", m, { ...base, ...c }),
    };
  },
};

export type Logger = typeof log;
