import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.IHA_RSS_URL = "http://x/rss";
process.env.IHA_USER_CODE = "1"; process.env.IHA_USER_NAME = "u";
process.env.IHA_USER_PASSWORD = "p";
process.env.SUPABASE_URL = "https://x.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJ" + "a".repeat(60);
process.env.S3_ENDPOINT = "https://x.r2.cloudflarestorage.com";
process.env.S3_BUCKET = "b"; process.env.S3_ACCESS_KEY_ID = "a";
process.env.S3_SECRET_ACCESS_KEY = "s";
process.env.CDN_BASE = "https://cdn.example.com";
process.env.SMTP_ENABLED = "false";
process.env.LOG_LEVEL = "error";

const { IngestPipeline } = await import("./pipeline.js");
const { parseIhaFeed } = await import("../parser/iha-parser.js");
import type { Db, BotSettings, IngestResult, ArticleRow } from "../db/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, "../fixtures/sample-feed.xml"), "utf8");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

// ---- Sahte DB ------------------------------------------------
interface Call { fn: string; args: any }

class FakeDb {
  calls: Call[] = [];
  store = new Map<string, { id: string; hash: string | null; manuallyEdited: boolean }>();
  mediaRows: any[] = [];
  failures: any[] = [];
  retries: string[] = [];
  failIngestFor = new Set<string>();
  private seq = 0;

  private rec(fn: string, args: any) { this.calls.push({ fn, args }); }

  async getExistingHashes(codes: string[]) {
    this.rec("getExistingHashes", codes);
    const m = new Map<string, { hash: string | null; manuallyEdited: boolean; id: string }>();
    for (const c of codes) { const v = this.store.get(c); if (v) m.set(c, v); }
    return m;
  }

  async ingestArticle(a: any): Promise<IngestResult> {
    this.rec("ingestArticle", a);
    if (this.failIngestFor.has(a.haberKodu)) {
      const e: any = new Error("DB yazma hatası"); e.code = "XX000"; throw e;
    }
    const prev = this.store.get(a.haberKodu);
    const id = prev?.id ?? `art-${++this.seq}`;
    const created = !prev;
    const updated = !!prev && prev.hash !== a.contentHash;
    this.store.set(a.haberKodu, { id, hash: a.contentHash, manuallyEdited: prev?.manuallyEdited ?? false });
    return { article_id: id, was_created: created, was_updated: updated };
  }

  async upsertMedia(rows: any[]) {
    this.rec("upsertMedia", rows);
    let n = 0;
    for (const r of rows) {
      const key = `${r.article_id}:${r.external_key}`;
      if (!this.mediaRows.find((m) => `${m.article_id}:${m.external_key}` === key)) {
        this.mediaRows.push(r); n++;
      }
    }
    return n;
  }

  async scheduleMediaRetry(id: string) { this.rec("scheduleMediaRetry", id); this.retries.push(id); return new Date().toISOString(); }
  async logFailure(f: any) { this.rec("logFailure", f); this.failures.push(f); return { failure_id: this.failures.length, attempts: 1, exhausted: false }; }
  async resolveFailure(fp: string) { this.rec("resolveFailure", fp); }
  async findMissingCodes(codes: string[]) { return new Set(codes.filter((c) => !this.store.has(c))); }
  async pendingMedia(): Promise<ArticleRow[]> { return []; }
  async beginRun(): Promise<any> { return {}; }
  async finishRun() {}
  async tripBreaker() { return null; }
  async shouldAlert() { return { should_send: false, reason: "x", to_email: null, suppressed: 0 }; }
  async recordAlert() {}
  async ping() { return true; }

  countCalls(fn: string) { return this.calls.filter((c) => c.fn === fn).length; }
  reset() { this.calls = []; }
}

const settings = {
  ingest_enabled: true, max_items_per_run: 200,
} as unknown as BotSettings;

const parsed = parseIhaFeed(xml);

// =============================================================
console.log("\n=== İLK TUR (hepsi yeni) ===");
const db = new FakeDb();
const pipe = new IngestPipeline(db as unknown as Db);
const s1 = await pipe.run(parsed, settings, 1);

check("4 haber görüldü", s1.seen === 4, s1.seen);
check("4 haber oluşturuldu", s1.created === 4, s1.created);
check("güncelleme yok", s1.updated === 0);
check("hata yok", s1.failed === 0, s1.failed);
check("parse hatası yok", s1.parseErrors === 0);
check("tek toplu hash sorgusu", db.countCalls("getExistingHashes") === 1, db.countCalls("getExistingHashes"));


console.log("\n=== ÜST KATEGORİ İLETİLİYOR ===");
{
  const dbU = new FakeDb();
  const pipeU = new IngestPipeline(dbU as unknown as Db);
  await pipeU.run(parsed, settings, 30);
  const calls = dbU.calls.filter((c) => c.fn === "ingestArticle");
  check("ingestArticle çağrıldı", calls.length > 0);
  const spor = calls.find((c: any) => c.args.haberKodu === "20260818AW769386");
  check("UstKategori DB'ye gönderildi (önceden kayboluyordu)",
    spor?.args.ustKategori === "SPOR", spor?.args.ustKategori);
  check("Kategori de gönderildi", spor?.args.kategori === "FUTBOL", spor?.args.kategori);
  const ardahan = calls.find((c: any) => c.args.haberKodu === "20260817AW769368");
  check("ikinci haberin üst kategorisi", ardahan?.args.ustKategori === "GÜNCEL",
    ardahan?.args.ustKategori);
}

console.log("\n=== MEDYA KAYDI (filesize=0 dahil) ===");
check("4 medya satırı yazıldı", db.mediaRows.length === 4, db.mediaRows.length);
const zeroByte = db.mediaRows.filter((m) => m.source_bytes === 0);
check("filesize=0 olanlar KAYDEDİLDİ", zeroByte.length === 2, zeroByte.length);
check("caption korundu",
  db.mediaRows.some((m) => m.caption?.includes("OLGUN YILDIZ")));
check("video süresi kaydedildi",
  db.mediaRows.some((m) => m.type === "video" && m.duration_sec === 855));
check("sıra korundu", db.mediaRows.filter((m) => m.sort_order === 1).length >= 2);


console.log("\n=== VİDEO POSTER KAYNAĞI ===");
{
  const dbP = new FakeDb();
  const pipeP = new IngestPipeline(dbP as unknown as Db);
  await pipeP.run(parsed, settings, 20);
  const vidRow = dbP.mediaRows.find((m: any) => m.type === "video");
  check("video satırı yazıldı", vidRow !== undefined);
  check("IHA poster URL'i KAYDEDİLDİ (ffmpeg'e mahkûm değil)",
    typeof vidRow?.poster_source_url === "string" &&
    vidRow.poster_source_url.includes("poster"), vidRow?.poster_source_url);
  check("video süresi kaydedildi", vidRow?.duration_sec === 855, vidRow?.duration_sec);

  const imgRow = dbP.mediaRows.find((m: any) => m.type === "image");
  check("fotoğrafta poster alanı boş", imgRow?.poster_source_url === null,
    imgRow?.poster_source_url);
}

console.log("\n=== RETRY PLANLAMA ===");
// item2: tek foto, filesize=0 → tamamen medyasız → retry planlanmalı
check("medyasız haber için retry planlandı", db.retries.length === 1, db.retries.length);
check("mediaPending sayıldı", s1.mediaPending === 1, s1.mediaPending);

console.log("\n=== İKİNCİ TUR (değişiklik yok) ===");
db.reset();
const s2 = await pipe.run(parsed, settings, 2);
check("hiç oluşturulmadı", s2.created === 0, s2.created);
check("hiç güncellenmedi", s2.updated === 0, s2.updated);
check("4'ü de atlandı", s2.skipped === 4, s2.skipped);
check("ingestArticle HİÇ çağrılmadı (hash aynı)",
  db.countCalls("ingestArticle") === 0, db.countCalls("ingestArticle"));
check("medya yine kontrol edildi", db.countCalls("upsertMedia") > 0);
check("mükerrer medya eklenmedi", db.mediaRows.length === 4, db.mediaRows.length);

console.log("\n=== İÇERİK DEĞİŞTİ ===");
db.reset();
const changed = parseIhaFeed(xml.replace(
  "Marco Asensio Fenerbahçe'ye imza attı",
  "Marco Asensio resmen Fenerbahçe'de"));
const s3 = await pipe.run(changed, settings, 3);
check("1 haber güncellendi", s3.updated === 1, s3.updated);
check("3'ü atlandı", s3.skipped === 3, s3.skipped);
check("sadece 1 ingest çağrısı", db.countCalls("ingestArticle") === 1, db.countCalls("ingestArticle"));

console.log("\n=== EDİTÖR KORUMASI ===");
db.reset();
const kod = "20260818AW769386";
const rec = db.store.get(kod)!;
db.store.set(kod, { ...rec, manuallyEdited: true });
const changed2 = parseIhaFeed(xml.replace(
  "Marco Asensio Fenerbahçe'ye imza attı", "BOT BUNU EZMEMELİ"));
const s4 = await pipe.run(changed2, settings, 4);
check("editör düzenlemesi korundu (ingest yok)",
  !db.calls.some((c) => c.fn === "ingestArticle" && c.args.haberKodu === kod));
check("skipped sayıldı", s4.skipped >= 1, s4.skipped);
check("medya senkronu yine çalıştı", db.countCalls("upsertMedia") > 0);

console.log("\n=== YENİ FOTOĞRAF GELDİ ===");
db.reset();
const withPhoto = parseIhaFeed(xml.replace(
  'ResimKodu="R010" filesize="0"', 'ResimKodu="R010" filesize="204800"'));
await pipe.run(withPhoto, settings, 5);
const r010 = db.mediaRows.find((m) => m.external_key === "R010");
check("mevcut medya kaydı korundu (upsert ignoreDuplicates)", r010 !== undefined);
check("yeni medya satırı eklenmedi (aynı key)", db.mediaRows.length === 4, db.mediaRows.length);

console.log("\n=== HATA İZOLASYONU ===");
const db2 = new FakeDb();
const pipe2 = new IngestPipeline(db2 as unknown as Db);
db2.failIngestFor.add("20260817AW769368");
const s5 = await pipe2.run(parsed, settings, 6);
check("1 haber patladı", s5.failed === 1, s5.failed);
check("diğer 3 haber işlendi", s5.created === 3, s5.created);
check("dead letter'a yazıldı", db2.failures.length === 1, db2.failures.length);
check("ham veri saklandı", db2.failures[0].raw !== undefined);
check("haberKodu kaydedildi", db2.failures[0].haberKodu === "20260817AW769368");
check("fingerprint üretildi", typeof db2.failures[0].fingerprint === "string");
check("maxAttempts sınırlı (sonsuz retry yok)", db2.failures[0].maxAttempts === 5);

console.log("\n=== PARSE HATASI -> DEAD LETTER ===");
const db3 = new FakeDb();
const pipe3 = new IngestPipeline(db3 as unknown as Db);
const broken = parseIhaFeed(xml.replace(
  "<HaberKodu>20260817AW769301</HaberKodu>", "<HaberKodu></HaberKodu>"));
const s6 = await pipe3.run(broken, settings, 7);
check("parse hatası sayıldı", s6.parseErrors === 1, s6.parseErrors);
check("parse hatası dead letter'da",
  db3.failures.some((f) => f.kind === "item_parse"));
check("kalan 3 haber işlendi", s6.created === 3, s6.created);

console.log("\n=== INGEST KAPALI ===");
const db4 = new FakeDb();
const pipe4 = new IngestPipeline(db4 as unknown as Db);
const s7 = await pipe4.run(parsed, { ...settings, ingest_enabled: false } as BotSettings, 8);
check("hiçbir şey yazılmadı", s7.created === 0 && db4.countCalls("ingestArticle") === 0);

console.log("\n=== LİMİT ===");
const db5 = new FakeDb();
const pipe5 = new IngestPipeline(db5 as unknown as Db);
const s8 = await pipe5.run(parsed, { ...settings, max_items_per_run: 2 } as BotSettings, 9);
check("limit uygulandı", s8.created === 2, s8.created);

console.log(`\n${"=".repeat(40)}\nGEÇTİ: ${pass}   KALDI: ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
