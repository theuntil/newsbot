import { isRetryable } from "./errors.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Dağıtık hız sınırlayıcı.
 *
 * IHA kuralı: istekler arası minimum 30 saniye. Bu limit HESAP
 * BAZINDA — kaç container çalıştırdığın önemli değil. Bu yüzden
 * sayaç Redis'te tutulur, process belleğinde değil.
 *
 * Redis yoksa bellek moduna düşer (tek instance geliştirme için).
 */
export interface RateLimiterStore {
  /** Atomik: son çağrı zamanını oku, uygunsa güncelle. Dönen: beklenecek ms */
  reserve(key: string, minIntervalMs: number): Promise<number>;
}

/** Tek process — geliştirme */
export class MemoryStore implements RateLimiterStore {
  private last = new Map<string, number>();

  async reserve(key: string, minIntervalMs: number): Promise<number> {
    const now = Date.now();
    const prev = this.last.get(key) ?? 0;
    const earliest = prev + minIntervalMs;
    if (now >= earliest) {
      this.last.set(key, now);
      return 0;
    }
    // Slotu şimdiden rezerve et — eşzamanlı çağrılar sıraya girer
    this.last.set(key, earliest);
    return earliest - now;
  }
}

/**
 * Redis — üretim. Lua script'i ile atomik.
 * Yarış koşulu olamaz: iki container aynı anda çağırsa bile
 * ikincisi farklı bir slot alır.
 *
 * KRİTİK (canlıda tespit edildi):
 * Lua 5.1'de tüm sayılar double'dır. Redis 7.4+ `redis.call`'a
 * float geçilmesini REDDEDER:
 *   "ERR Lua redis lib command arguments must be strings or integers"
 * Bu hata hem feed çekmeyi hem medyayı kırdı. Bu yüzden tüm
 * argümanlar string.format('%d', ...) ile AÇIKÇA tam sayı
 * string'ine çevriliyor.
 */
export class RedisStore implements RateLimiterStore {
  private static readonly LUA = `
    local key = KEYS[1]
    local interval = tonumber(ARGV[1])
    local now = tonumber(ARGV[2])
    local prev = tonumber(redis.call('GET', key) or '0')
    local earliest = prev + interval
    local slot = now
    if now < earliest then slot = earliest end
    local ttl = interval * 4
    if ttl < 1000 then ttl = 1000 end
    redis.call('SET', key, string.format('%d', slot), 'PX', string.format('%d', ttl))
    return math.floor(slot - now)
  `;

  /** Lua bozulursa botu durdurmamak için yedek moda geçilir */
  private luaBroken = false;
  /** ioredis pozisyonel, node-redis obje formu kullanır */
  private positional = false;

  constructor(private redis: {
    eval: (...a: any[]) => Promise<any>;
    get?: (k: string) => Promise<string | null>;
    set?: (k: string, v: string, o?: any) => Promise<any>;
  }) {}

  async reserve(key: string, minIntervalMs: number): Promise<number> {
    const interval = Math.max(1, Math.floor(minIntervalMs));
    const now = Date.now();

    if (!this.luaBroken) {
      try {
        /**
         * node-redis v4 SADECE obje formunu destekler:
         *   eval(script, { keys: [...], arguments: [...] })
         *
         * Pozisyonel form (script, numkeys, key, ...) sessizce
         * KEYS/ARGV'yi BOŞ bırakır → redis.call('GET', nil) →
         * "arguments must be strings or integers". Canlıda tam
         * olarak bu oldu; hem feed hem medya kırıldı.
         *
         * ioredis pozisyonel kullanır, o yüzden ikisini de deniyoruz.
         */
        const wait = this.positional
          ? await this.redis.eval(RedisStore.LUA, 1, key, String(interval), String(now))
          : await this.redis.eval(RedisStore.LUA, {
              keys: [key],
              arguments: [String(interval), String(now)],
            });

        const n = Number(wait);
        if (!Number.isFinite(n)) throw new Error(`Beklenmeyen eval sonucu: ${wait}`);
        return n > 0 ? n : 0;
      } catch (err) {
        // Obje formu tutmadıysa bir kez pozisyonel formu dene (ioredis)
        if (!this.positional) {
          this.positional = true;
          try {
            const wait = await this.redis.eval(
              RedisStore.LUA, 1, key, String(interval), String(now),
            );
            const n = Number(wait);
            if (Number.isFinite(n)) return n > 0 ? n : 0;
          } catch { /* ikisi de olmadı → yedeğe düş */ }
        }

        // Hız sınırlayıcı hatası TÜM botu durdurmamalı.
        this.luaBroken = true;
        console.error(JSON.stringify({
          lvl: "warn",
          msg: "Redis Lua script çalışmadı, GET/SET yedeğine geçiliyor",
          err: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    return this.fallbackReserve(key, interval, now);
  }

  /**
   * Yedek: GET + SET. Tam atomik değil ama tek instance'ta
   * pratikte yeterli; hız sınırının hiç çalışmamasından iyidir.
   */
  private async fallbackReserve(key: string, interval: number, now: number): Promise<number> {
    if (!this.redis.get || !this.redis.set) return 0;
    const raw = await this.redis.get(key).catch(() => null);
    const prev = Number(raw ?? 0) || 0;
    const earliest = prev + interval;
    const slot = now < earliest ? earliest : now;
    await this.redis
      .set(key, String(Math.floor(slot)), { PX: Math.max(1000, interval * 4) })
      .catch(() => {});
    return Math.max(0, Math.floor(slot - now));
  }
}

export class RateLimiter {
  constructor(
    private store: RateLimiterStore,
    private prefix = "rl",
  ) {}

  /** Slot açılana kadar bekler. Uzun beklemede iptal edilebilir. */
  async acquire(key: string, minIntervalMs: number, signal?: AbortSignal): Promise<number> {
    const waited = await this.store.reserve(`${this.prefix}:${key}`, minIntervalMs);
    if (waited > 0) {
      if (signal?.aborted) throw new Error("İptal edildi");
      await sleep(waited);
      if (signal?.aborted) throw new Error("İptal edildi");
    }
    return waited;
  }
}

/**
 * Üstel backoff + jitter.
 *
 * Jitter neden şart: birden fazla worker aynı anda 503 alırsa,
 * sabit backoff'ta hepsi aynı anda tekrar dener ve sunucuyu
 * yeniden düşürür (thundering herd). Rastgelelik bunu dağıtır.
 */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exp = Math.min(baseMs * 2 ** attempt, capMs);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export interface RetryOptions {
  attempts: number;
  baseMs?: number;
  capMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Kalıcı hatalarda ANINDA vazgeçer (404, 401 için 7 kez denemek israf).
 * Sadece retryable hatalarda tekrarlar.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { attempts, baseMs = 1000, capMs = 60_000, signal, onRetry } = opts;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new Error("İptal edildi");
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;      // kalıcı hata → hemen bırak
      if (i === attempts - 1) break;         // son deneme

      const delay = backoffMs(i, baseMs, capMs);
      onRetry?.(i + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Eşzamanlılık sınırlayıcı.
 * 200 görseli aynı anda indirmeye kalkarsan hem RAM patlar
 * hem karşı sunucu seni engeller.
 */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  get inFlight(): number { return this.active; }
  get pending(): number { return this.queue.length; }
}

/** Sınırlı eşzamanlılıkla toplu işlem; tek hata diğerlerini çökertmez */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const sem = new Semaphore(limit);
  return Promise.all(
    items.map((item, i) =>
      sem.run(async () => {
        try { return { ok: true as const, value: await fn(item, i) }; }
        catch (error) { return { ok: false as const, error }; }
      }),
    ),
  );
}
