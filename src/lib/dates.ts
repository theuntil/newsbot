/**
 * IHA tarih formatı: "18.08.2026 02:16:37" veya "18.08.2026 02:31"
 *
 * Bu format RFC822 DEĞİL — new Date() ile parse edilemez, Invalid Date verir.
 * Ayrıca timezone bilgisi YOK; değerler Europe/Istanbul yerel saatidir.
 *
 * Bağımlılık kullanmıyoruz: Türkiye 2016'dan beri kalıcı UTC+3,
 * yaz saati uygulaması yok. Sabit ofset güvenli ve date-fns-tz'den hızlı.
 */

const TR_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, sabit

const RE = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Feed'de veri yokluğunu ifade eden değerler */
const EMPTY = new Set(["", "-", "--", "null", "NULL", "0"]);

export function parseIhaDate(input: unknown): Date | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (EMPTY.has(s)) return null;

  const m = RE.exec(s);
  if (!m) return null;

  const [, dd, MM, yyyy, HH, mm, ss] = m;

  const day = +dd, month = +MM, year = +yyyy;
  const hour = +HH, min = +mm, sec = ss ? +ss : 0;

  // Aralık kontrolü — Date.UTC taşmayı sessizce kabul eder (32 Ocak → 1 Şubat)
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;
  if (year < 2000 || year > 2100) return null;

  const utcMs = Date.UTC(year, month - 1, day, hour, min, sec) - TR_OFFSET_MS;
  const d = new Date(utcMs);

  // Gerçek takvim doğrulaması (31 Şubat gibi değerleri ele)
  const back = new Date(d.getTime() + TR_OFFSET_MS);
  if (back.getUTCDate() !== day || back.getUTCMonth() !== month - 1) return null;

  return d;
}

/** Postgres timestamptz için ISO string, null-güvenli */
export function toIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Gelecek tarihli haberleri makul sınıra çeker.
 * Feed'de bozuk tarih gelirse haber listenin başına çakılıp kalmasın.
 */
export function clampFuture(d: Date | null, maxAheadMin = 30): Date | null {
  if (!d) return null;
  const limit = Date.now() + maxAheadMin * 60_000;
  return d.getTime() > limit ? new Date() : d;
}
