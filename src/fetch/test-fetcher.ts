import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Test env'i — import'lardan ÖNCE ayarlanmalı
process.env.IHA_RSS_URL = "http://127.0.0.1:9911/rss";
process.env.IHA_USER_CODE = "7350";
process.env.IHA_USER_NAME = "kuzey";
process.env.IHA_USER_PASSWORD = "gizli-sifre-123";
process.env.IHA_MIN_INTERVAL_MS = "30000"; // env taban; testler kendi limiterını kullanır
process.env.SUPABASE_URL = "https://x.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJ" + "a".repeat(60);
process.env.S3_ENDPOINT = "https://x.r2.cloudflarestorage.com";
process.env.S3_BUCKET = "haber-medya";
process.env.S3_ACCESS_KEY_ID = "ak";
process.env.S3_SECRET_ACCESS_KEY = "sk";
process.env.CDN_BASE = "https://medya.example.com";
process.env.SMTP_ENABLED = "false";
process.env.LOG_LEVEL = "error";

const { FeedFetcher } = await import("./feed-fetcher.js");
const { RateLimiter, MemoryStore, backoffMs, Semaphore, mapLimit, withRetry } =
  await import("../lib/rate-limit.js");
const { redactUrl, buildFeedUrl } = await import("../config/env.js");
const { BotError, classifyHttp, isRetryable, isCritical } = await import("../lib/errors.js");
const { parseIhaFeed } = await import("../parser/iha-parser.js");

const here = dirname(fileURLToPath(import.meta.url));
const sampleXml = readFileSync(join(here, "../fixtures/sample-feed.xml"), "utf8");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

// ---- Sahte IHA sunucusu -------------------------------------
let mode = "ok";
let hitCount = 0;
let lastUA = "";

const server: Server = createServer((req, res) => {
  hitCount++;
  lastUA = String(req.headers["user-agent"] ?? "");

  if (mode === "ok") {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(sampleXml);
  } else if (mode === "500-then-ok") {
    if (hitCount < 3) { res.writeHead(503); res.end("gecici"); }
    else { res.writeHead(200, { "content-type": "application/xml" }); res.end(sampleXml); }
  } else if (mode === "403") {
    res.writeHead(403); res.end("yasak");
  } else if (mode === "404") {
    res.writeHead(404); res.end("yok");
  } else if (mode === "html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!DOCTYPE html><html><body>Giris yapin</body></html>");
  } else if (mode === "ratelimit") {
    // IHA'nın gerçek yanıtı — düz metin, ŞİFREYİ GERİ GÖNDERİYOR
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("İki rss isteği arasındaki süre en az 30 saniye olmalıdır. " +
            "[ İstek Yapan IP = 1.2.3.4 ] " +
            "[ UserCode=7350 , UserName=kuzey , UserPassword=gizli-sifre-123 ]");
  } else if (mode === "empty") {
    res.writeHead(200, { "content-type": "application/xml" }); res.end("");
  } else if (mode === "slow") {
    setTimeout(() => { res.writeHead(200); res.end(sampleXml); }, 5000);
  } else {
    res.writeHead(500); res.end();
  }
});

await new Promise<void>((r) => server.listen(9911, "127.0.0.1", r));

// Test için hız sınırını düşür (gerçekte 30 sn)
const limiter = new RateLimiter(new MemoryStore(), "test");
const fetcher = new FeedFetcher(limiter);
const base = { timeoutSec: 3, maxRetries: 2, userAgent: "TestBot/1.0" };

// Her testte farklı key kullanmak için limiter'ı sarmalayan yardımcı
function freshFetcher() {
  return new FeedFetcher(new RateLimiter(new MemoryStore(), `t${Math.random()}`));
}

console.log("\n=== SIR MASKELEME ===");
const feedUrl = buildFeedUrl();
check("URL şifreyi içeriyor (ham)", feedUrl.includes("gizli-sifre-123"));
const safe = redactUrl(feedUrl);
check("redactUrl şifreyi gizledi", !safe.includes("gizli-sifre-123"), safe);
check("redactUrl kullanıcı kodunu gizledi", !safe.includes("7350"), safe);
check("redactUrl yapıyı korudu", safe.includes("UserPassword=***"), safe);

console.log("\n=== BAŞARILI ÇEKİM ===");
mode = "ok"; hitCount = 0;
const r1 = await freshFetcher().fetch(base);
check("XML alındı", r1.xml.includes("<rss"), r1.bytes);
check("HTTP 200", r1.httpStatus === 200);
check("bayt sayısı doğru", r1.bytes === Buffer.byteLength(sampleXml), r1.bytes);
check("tek denemede geçti", r1.attempts === 1);
check("User-Agent gönderildi", lastUA === "TestBot/1.0", lastUA);
check("parse edilebiliyor", parseIhaFeed(r1.xml).items.length === 4);

console.log("\n=== GEÇİCİ HATA -> RETRY ===");
mode = "500-then-ok"; hitCount = 0;
const r2 = await freshFetcher().fetch(base);
check("503 sonrası başarılı", r2.httpStatus === 200);
check("3 istek yapıldı", hitCount === 3, hitCount);
check("attempts=3 raporlandı", r2.attempts === 3, r2.attempts);

console.log("\n=== KALICI HATA -> RETRY YOK ===");
mode = "403"; hitCount = 0;
let err403: any;
try { await freshFetcher().fetch(base); } catch (e) { err403 = e; }
check("403 hata fırlattı", err403 instanceof BotError);
check("403 retryable DEĞİL", err403?.retryable === false);
check("403 critical (mail gitmeli)", err403?.critical === true);
check("403 tek denemede bıraktı", hitCount === 1, hitCount);

mode = "404"; hitCount = 0;
let err404: any;
try { await freshFetcher().fetch(base); } catch (e) { err404 = e; }
check("404 retryable değil", err404?.retryable === false);
check("404 tek istek", hitCount === 1, hitCount);

console.log("\n=== HTML HATA SAYFASI ===");
mode = "html"; hitCount = 0;
let errHtml: any;
try { await freshFetcher().fetch({ ...base, maxRetries: 0 }); } catch (e) { errHtml = e; }
check("HTML yanıt reddedildi", errHtml?.code === "HTML_RESPONSE", errHtml?.code);
check("HTML parse edilmeye çalışılmadı", errHtml instanceof BotError);

console.log("\n=== SAĞLAYICI HIZ SINIRI ===");
mode = "ratelimit"; hitCount = 0;
let errRl: any;
try { await freshFetcher().fetch({ ...base, maxRetries: 0 }); } catch (e) { errRl = e; }
check("hız sınırı ayrı sınıflandırıldı",
  errRl?.code === "PROVIDER_RATE_LIMIT", errRl?.code);
// Hız sınırında TUR İÇİNDE tekrar denenmez — tekrar deneme
// sorunun kaynağıydı (her turda 2 istek gidiyordu).
check("tur içinde tekrar DENENMEZ", errRl?.retryable === false, errRl?.retryable);
check("tek istek yapıldı", hitCount === 1, hitCount);

const rlDump = JSON.stringify(errRl?.context ?? {});
check("ŞİFRE loglara sızmadı", !rlDump.includes("gizli-sifre-123"), rlDump);
check("UserCode maskelendi", !rlDump.includes("7350"), rlDump);
check("mesaj yine de okunabilir", rlDump.includes("30 saniye"), rlDump);

console.log("\n=== RETRY DE HIZ SINIRINA UYUYOR ===");
// Kritik: önceden sadece ilk istek limitliydi, retry'lar 1.4 sn'de
// gidip 30 sn kuralını deliyordu. Artık HER deneme limiter'dan geçiyor.
// (Gerçek 30 sn beklememek için limiter'ı sayaçla sarmalıyoruz.)
let acquireCount = 0;
class CountingStore extends MemoryStore {
  async reserve(key: string, ms: number) { acquireCount++; return super.reserve(key, 50); }
}
mode = "500-then-ok"; hitCount = 0;
const rlFetcher = new FeedFetcher(new RateLimiter(new CountingStore(), "cnt"));
const rlRes = await rlFetcher.fetch({ ...base, maxRetries: 2 });
check("retry'lar sonrası başarılı", rlRes.httpStatus === 200);
check("3 deneme yapıldı", rlRes.attempts === 3, rlRes.attempts);
check("limiter HER denemede çağrıldı", acquireCount === 3, acquireCount);

console.log("\n=== BOŞ YANIT ===");
mode = "empty";
let errEmpty: any;
try { await freshFetcher().fetch({ ...base, maxRetries: 0 }); } catch (e) { errEmpty = e; }
check("boş yanıt reddedildi", errEmpty?.code === "EMPTY", errEmpty?.code);

console.log("\n=== TIMEOUT ===");
mode = "slow"; hitCount = 0;
const t0 = Date.now();
let errTo: any;
try { await freshFetcher().fetch({ ...base, timeoutSec: 1, maxRetries: 0 }); }
catch (e) { errTo = e; }
const elapsed = Date.now() - t0;
check("timeout hatası", errTo?.code === "TIMEOUT", errTo?.code);
check("1 sn civarında kesildi", elapsed < 2500, elapsed);

console.log("\n=== HIZ SINIRI ===");
const rl = new RateLimiter(new MemoryStore(), "rltest");
const s0 = Date.now();
await rl.acquire("k", 300);
const w1 = Date.now() - s0;
await rl.acquire("k", 300);
const w2 = Date.now() - s0;
check("ilk çağrı beklemedi", w1 < 100, w1);
check("ikinci çağrı bekledi", w2 >= 290, w2);

const rl2 = new RateLimiter(new MemoryStore(), "rl2");
const st = Date.now();
await Promise.all([rl2.acquire("x", 200), rl2.acquire("x", 200), rl2.acquire("x", 200)]);
const par = Date.now() - st;
check("eşzamanlı çağrılar sıraya girdi", par >= 380, par);

console.log("\n=== BACKOFF + JITTER ===");
const b = Array.from({ length: 40 }, (_, i) => backoffMs(i % 4, 1000, 30000));
check("backoff artıyor", backoffMs(0,1000,30000) < backoffMs(3,1000,30000) * 2);
check("jitter var (değerler farklı)", new Set(b.slice(0, 10)).size > 1);
check("tavan aşılmıyor", Math.max(...b.map((x) => x)) <= 30000);
check("negatif yok", Math.min(...b) > 0);

console.log("\n=== EŞZAMANLILIK ===");
let peak = 0, active = 0;
const sem = new Semaphore(3);
await Promise.all(Array.from({ length: 12 }, () =>
  sem.run(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  })));
check("eşzamanlılık 3'ü aşmadı", peak === 3, peak);

const results = await mapLimit([1, 2, 3, 4], 2, async (n) => {
  if (n === 2) throw new Error("patladi");
  return n * 10;
});
check("mapLimit hataları izole etti", results.filter((r) => r.ok).length === 3);
check("mapLimit hatayı yakaladı", results.filter((r) => !r.ok).length === 1);
check("mapLimit değerleri doğru",
  results[0].ok && results[0].value === 10 && results[3].ok && results[3].value === 40);

console.log("\n=== HATA SINIFLANDIRMA ===");
check("401 critical", isCritical(classifyHttp(401, "feed_fetch")));
check("429 retryable", isRetryable(classifyHttp(429, "media_fetch")));
check("503 retryable", isRetryable(classifyHttp(503, "media_fetch")));
check("404 retryable değil", !isRetryable(classifyHttp(404, "media_fetch")));
check("400 retryable değil", !isRetryable(classifyHttp(400, "media_fetch")));

let tries = 0;
try {
  await withRetry(async () => { tries++; throw classifyHttp(404, "media_fetch"); },
    { attempts: 5, baseMs: 10 });
} catch {}
check("withRetry kalıcı hatada durdu", tries === 1, tries);

tries = 0;
try {
  await withRetry(async () => { tries++; throw classifyHttp(503, "media_fetch"); },
    { attempts: 3, baseMs: 10 });
} catch {}
check("withRetry geçici hatada 3 denedi", tries === 3, tries);

server.close();
console.log(`\n${"=".repeat(40)}\nGEÇTİ: ${pass}   KALDI: ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
