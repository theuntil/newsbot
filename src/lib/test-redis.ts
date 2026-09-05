/**
 * GERÇEK REDIS testi — hız sınırlayıcı.
 *
 * Redis yoksa test ATLANIR (CI/yerel ortam için).
 * Çalıştırmak için:  docker run -d -p 6399:6379 redis:7-alpine
 *
 * Bu test, canlıda botu kıran hatayı yakalar:
 * node-redis v4 pozisyonel eval formunu desteklemez, KEYS/ARGV
 * boş gelir ve "arguments must be strings or integers" patlar.
 */
import { createClient } from "redis";
import { RedisStore, RateLimiter } from "./rate-limit.js";

const URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6399";

const c = createClient({
  url: URL,
  socket: { connectTimeout: 1500, reconnectStrategy: () => false },
});
c.on("error", () => {});

try {
  await c.connect();
  await c.ping();
} catch {
  console.log("\n  --   Redis bulunamadı, hız sınırlayıcı testi ATLANDI");
  console.log(`       (${URL})`);
  console.log("       Çalıştırmak için: docker run -d -p 6399:6379 redis:7-alpine\n");
  console.log("GEÇTİ: 0   KALDI: 0\n");
  process.exit(0);
}

for (const k of ["rlx:t1","rlx:m1","rlx:c1","rlx:fb"]) await c.del(k).catch(()=>{});

const store = new RedisStore(c as never);
const rl = new RateLimiter(store, "rlx");

let pass=0, fail=0;
const ck=(n:string,c2:boolean,e?:unknown)=>{c2?(pass++,console.log("  ok   "+n)):(fail++,console.log("  FAIL "+n,e??""))};

console.log("\n=== GERÇEK REDIS İLE HIZ SINIRI ===");
const t0=Date.now();
const w1 = await store.reserve("rlx:t1", 33000);
ck("ilk çağrı beklemesiz", w1 === 0, w1);

const w2 = await store.reserve("rlx:t1", 33000);
ck("ikinci çağrı ~33 sn bekletiyor", w2 > 32000 && w2 <= 33000, w2);

const w3 = await store.reserve("rlx:t1", 33000);
ck("üçüncü çağrı ~66 sn", w3 > 65000 && w3 <= 66000, w3);

// Saklanan değer tam sayı mı?
const stored = await c.get("rlx:t1");
ck("saklanan değer tam sayı (float değil)", /^\d+$/.test(stored ?? ""), stored);

// TTL doğru mu?
const ttl = await c.pTTL("rlx:t1");
ck("TTL ayarlandı", ttl > 0, ttl);

console.log("\n=== KÜÇÜK ARALIK (medya: 125ms) ===");
await c.del("rlx:m1");
const m1 = await store.reserve("rlx:m1", 125);
const m2 = await store.reserve("rlx:m1", 125);
ck("küçük aralık çalışıyor", m1 === 0 && m2 > 120 && m2 <= 125, {m1,m2});
const mstored = await c.get("rlx:m1");
ck("küçük aralıkta da tam sayı", /^\d+$/.test(mstored ?? ""), mstored);

console.log("\n=== EŞZAMANLI (yarış koşulu) ===");
await c.del("rlx:c1");
const rs = await Promise.all([
  store.reserve("rlx:c1", 1000),
  store.reserve("rlx:c1", 1000),
  store.reserve("rlx:c1", 1000),
]);
const sorted=[...rs].sort((a,b)=>a-b);
ck("üç çağrı farklı slot aldı", new Set(rs).size === 3, rs);
ck("slotlar 0/1000/2000 civarı",
  sorted[0]===0 && sorted[1]>990 && sorted[2]>1990, sorted);

console.log("\n=== YEDEK MOD (Lua bozuksa) ===");
const badStore = new RedisStore({
  eval: async () => { throw new Error("ERR Lua redis lib command arguments must be strings or integers"); },
  get: (k:string)=>c.get(k) as any,
  set: (k:string,v:string,o:any)=>c.set(k,v,o) as any,
} as never);
await c.del("rlx:fb");
const f1 = await badStore.reserve("rlx:fb", 500);
const f2 = await badStore.reserve("rlx:fb", 500);
ck("Lua patlasa bile çalışıyor", f1 === 0 && f2 > 490, {f1,f2});

await c.quit();
console.log(`\nGEÇTİ: ${pass}  KALDI: ${fail}\n`);
process.exit(fail===0?0:1);
