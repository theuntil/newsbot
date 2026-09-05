import { log, configureLogger } from "./logger.js";
import { BotError } from "./errors.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

// stdout'u yakala
const lines: string[] = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
function capture() {
  (process.stdout as any).write = (c: any) => { lines.push(String(c)); return true; };
  (process.stderr as any).write = (c: any) => { lines.push(String(c)); return true; };
}
function release() {
  (process.stdout as any).write = origOut;
  (process.stderr as any).write = origErr;
}

configureLogger("debug", "test", "json");  // maskeleme testi JSON üzerinden

console.log("\n=== SIR MASKELEME ===");
lines.length = 0; capture();
log.info("m", {
  password: "S1", SMTP_PASS: "S2", apiKey: "S3", secretAccessKey: "S4",
  authorization: "Bearer S5", token: "S6",
  url: "https://x/rss?UserPassword=S7&UserCode=S8",
  nested: { service_role_key: "S9" },
  S3_SECRET_ACCESS_KEY: "S10", IHA_USER_PASSWORD: "S11", accessToken: "S12",
  key: "alert-recovery", bucket: "haber-medya",
  haberKodu: "20260822AW772681", storageKey: "media/2026/08/x", monkey: "ok",
});
release();
const out = lines.join("");

for (let i = 1; i <= 12; i++) {
  check(`sır S${i} sızmadı`, !out.includes(`"S${i}"`) && !out.includes(`=S${i}`), out.slice(0, 200));
}

const parsed = JSON.parse(out.trim());
check("key teşhis için görünür", parsed.key === "alert-recovery", parsed.key);
check("bucket görünür", parsed.bucket === "haber-medya");
check("haberKodu görünür", parsed.haberKodu === "20260822AW772681");
check("storageKey görünür", parsed.storageKey === "media/2026/08/x");
check("monkey yanlışlıkla maskelenmedi", parsed.monkey === "ok", parsed.monkey);
check("URL parametreleri maskelendi", parsed.url.includes("UserPassword=***"));

console.log("\n=== HATA BAĞLAMI GÖRÜNÜR ===");
lines.length = 0; capture();
log.error("hata", {
  err: new BotError("Yanıt XML'e benzemiyor", {
    kind: "feed_fetch", code: "NOT_XML",
    context: { preview: "Lutfen 30 saniye bekleyiniz", bytes: 42 },
  }),
});
release();
const errOut = JSON.parse(lines.join("").trim());
check("hata kodu görünür", errOut.err.code === "NOT_XML", errOut.err.code);
check("context görünür (teşhis şart)", errOut.err.context !== undefined, errOut.err);
check("preview okunabiliyor",
  errOut.err.context?.preview?.includes("30 saniye"), errOut.err.context);

console.log(`\n${"=".repeat(40)}\nGEÇTİ: ${pass}   KALDI: ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
