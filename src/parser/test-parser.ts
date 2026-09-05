import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseIhaFeed } from "./iha-parser.js";
import { parseIhaDate } from "../lib/dates.js";

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, "../fixtures/sample-feed.xml"), "utf8");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

console.log("\n=== TARİH ===");
const d = parseIhaDate("18.08.2026 02:16:37");
check("dd.MM.yyyy HH:mm:ss parse edildi", d !== null);
check("UTC+3 -> UTC dönüşümü", d?.toISOString() === "2026-08-17T23:16:37.000Z", d?.toISOString());
check("saniyesiz format", parseIhaDate("18.08.2026 02:31") !== null);
check('"-" null döner', parseIhaDate("-") === null);
check("boş null döner", parseIhaDate("") === null);
check("geçersiz gün reddedildi", parseIhaDate("32.08.2026 10:00") === null);
check("31 Şubat reddedildi", parseIhaDate("31.02.2026 10:00") === null);
check("RFC822 reddedildi", parseIhaDate("Mon, 18 Aug 2026 02:16:37 GMT") === null);

console.log("\n=== FEED ===");
const r = parseIhaFeed(xml);
check("4 item görüldü", r.totalSeen === 4, r.totalSeen);
check("4 item parse edildi", r.items.length === 4, r.items.length);
check("hata yok", r.errors.length === 0, r.errors);

console.log("\n=== ITEM 1 (spor, 2 foto, biri filesize=0) ===");
const a = r.items[0];
check("haberKodu", a.haberKodu === "20260818AW769386", a.haberKodu);
check("başlık Türkçe karakter", a.title.includes("Fenerbahçe"), a.title);
check("summary ilk satır", a.summary?.startsWith("Fenerbahçe, İspanyol") === true, a.summary);
check("sonDakika Evet -> true", a.sonDakika === true);
check("kategori", a.kategori === "FUTBOL", a.kategori);
check("body 4 blok", a.body.length === 4, a.body.length);
check("tırnaklı satır heading oldu",
  a.body.some((b) => b.type === "heading" && b.text === "Yeni bir sayfa açıyoruz"),
  a.body);
check("heading tırnaksız", !a.body.some((b) => "text" in b && b.text.includes('"')));
check("2 medya", a.media.length === 2, a.media.length);
check("URL entity çözüldü (&param1=)",
  a.media[0].url.includes("&param1=") && !a.media[0].url.includes("&amp;"),
  a.media[0].url);
check("filesize 184320", a.media[0].sourceBytes === 184320, a.media[0].sourceBytes);
check("filesize 0 korundu (retry sinyali)", a.media[1].sourceBytes === 0);
check("caption eşleşti", a.media[0].caption?.includes("OLGUN YILDIZ") === true, a.media[0].caption);
check("ResimKodu", a.media[0].externalKey === "R001", a.media[0].externalKey);
check("contentHash üretildi", /^[a-f0-9]{32}$/.test(a.contentHash), a.contentHash);

console.log("\n=== ITEM 2 (tek foto — isArray testi) ===");
const b = r.items[1];
check("tek image dizi olarak geldi", Array.isArray(b.media) && b.media.length === 1, b.media.length);
check("SonHaberGuncellenmeTarihi '-' -> null", b.updatedAt === null);
check("photoAddedAt parse edildi", b.photoAddedAt !== null);
check("heading yakalandı",
  b.body.some((x) => x.type === "heading" && x.text.includes("dilsiz emanetleri")), b.body);

console.log("\n=== ITEM 3 (video) ===");
const c = r.items[2];
check("1 video", c.media.length === 1 && c.media[0].type === "video");
check("süre 855 sn", c.media[0].durationSec === 855, c.media[0].durationSec);
check("82 MB filesize", c.media[0].sourceBytes === 86011904);
check("poster URL var", c.media[0].posterUrl !== null, c.media[0].posterUrl);
check("VideoKodu", c.media[0].externalKey === "V001");

console.log("\n=== ITEM 4 (medyasız) ===");
const e = r.items[3];
check("medya yok", e.media.length === 0);
check("body boş, summary dolu", e.body.length === 0 && e.summary !== null);
check("KVKK: plaka ham veride duruyor", e.summary!.includes("16 CCL 150"));


console.log("\n=== GERÇEK IHA YAPISI (canlı feed'den) ===");
const realXml = readFileSync(join(here, "../fixtures/real-structure.xml"), "utf8");
const rr = parseIhaFeed(realXml);
const ri = rr.items[0];
check("gerçek yapı hatasız ayrıştı", rr.errors.length === 0, rr.errors);
check("2 medya (1 foto + 1 video)", ri.media.length === 2, ri.media.length);

const rImg = ri.media.find((m) => m.type === "image")!;
const rVid = ri.media.find((m) => m.type === "video")!;

check("VİDEO BULUNDU (path_video alt düğümü)", rVid !== undefined);
check("video URL path_video'dan alındı",
  rVid?.url.includes("type=video") === true, rVid?.url);
check("video entity çözüldü (&param1)",
  rVid?.url.includes("&param1=") === true && !rVid.url.includes("&amp;"), rVid?.url);
check("VideoKodu okundu", rVid?.externalKey === "1926967", rVid?.externalKey);
check("filesize okundu", rVid?.sourceBytes === 4565773, rVid?.sourceBytes);
check("duration okundu", rVid?.durationSec === 47, rVid?.durationSec);
check("poster URL alındı", rVid?.posterUrl?.includes("download.ashx") === true, rVid?.posterUrl);
check("video açıklaması alındı",
  rVid?.caption?.includes("kuyumcu") === true, rVid?.caption);

check("foto ResimKodu okundu",
  rImg?.externalKey === "20260822AW772685_01", rImg?.externalKey);
check("foto filesize okundu", rImg?.sourceBytes === 126063);
check("künye ResimKodu ile eşleşti",
  rImg?.caption?.includes("KÜÇÜKÇEKMECE") === true, rImg?.caption);
check("abonerss host'u kabul edildi",
  rImg?.url.startsWith("https://abonerss.iha.com.tr/") === true, rImg?.url);

console.log("\n=== HASH KARARLILIĞI ===");
const r2 = parseIhaFeed(xml);
check("aynı girdi aynı hash", r2.items[0].contentHash === a.contentHash);
check("farklı item farklı hash", r2.items[1].contentHash !== a.contentHash);

console.log("\n=== BOZUK GİRDİ ===");
try { parseIhaFeed(""); check("boş feed hata verdi", false); }
catch { check("boş feed hata verdi", true); }
try { parseIhaFeed("<rss><channel>"); check("bozuk XML hata verdi", false); }
catch { check("bozuk XML hata verdi", true); }

const partial = xml.replace("<HaberKodu>20260817AW769301</HaberKodu>", "<HaberKodu></HaberKodu>");
const rp = parseIhaFeed(partial);
check("bozuk item izole edildi", rp.items.length === 3 && rp.errors.length === 1,
  { items: rp.items.length, errors: rp.errors.length });

console.log(`\n${"=".repeat(40)}\nGEÇTİ: ${pass}   KALDI: ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
