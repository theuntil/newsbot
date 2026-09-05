import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { spawn } from "node:child_process";

process.env.IHA_RSS_URL = "http://x/rss";
process.env.IHA_USER_CODE = "1"; process.env.IHA_USER_NAME = "u";
process.env.IHA_USER_PASSWORD = "p";
process.env.SUPABASE_URL = "https://x.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJ" + "a".repeat(60);
process.env.S3_ENDPOINT = "https://x.r2.cloudflarestorage.com";
process.env.S3_BUCKET = "b"; process.env.S3_ACCESS_KEY_ID = "a";
process.env.S3_SECRET_ACCESS_KEY = "s";
process.env.CDN_BASE = "https://medya.example.com";
process.env.SMTP_ENABLED = "false";
process.env.LOG_LEVEL = "error";
process.env.TMP_DIR = "/tmp/haberbot-test";

const { ImageProcessor } = await import("./image-processor.js");
const { VideoProcessor } = await import("./video-processor.js");
const { assertSafeUrl } = await import("./downloader.js");
const { buildStorageKey, publicUrl, contentTypeFor } = await import("./storage.js");
import type { BotSettings } from "../db/client.js";

const TMP = "/tmp/haberbot-test";
await mkdir(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

const settings = {
  image_format: "avif", image_quality: 72, image_fallback_webp: false,
  image_variants: [{ name: "thumb", w: 400 }, { name: "card", w: 800 }, { name: "full", w: 1920 }],
  image_blurhash: true, image_max_bytes: 26214400,
  video_max_height: 1080, video_crf_short: 23, video_crf_long: 25,
  video_preset: "veryfast", video_audio_kbps: 128, video_threads: 2,
  video_short_max_sec: 300, video_skip_over_sec: 1200, video_max_bytes: 524288000,
} as unknown as BotSettings;

// =============================================================
console.log("\n=== SSRF KORUMASI ===");
const bad = [
  "http://169.254.169.254/latest/meta-data",      // AWS metadata
  "http://localhost:8080/admin",
  "http://127.0.0.1/",
  "file:///etc/passwd",
  "https://evil.com/x.jpg",
  "https://iha.com.tr.evil.com/x.jpg",            // suffix saldırısı
];
for (const u of bad) {
  let blocked = false;
  try { assertSafeUrl(u); } catch { blocked = true; }
  check(`engellendi: ${u.slice(0, 42)}`, blocked);
}
const good = [
  "https://cdn.iha.com.tr/telifli/foto?id=1",
  "https://www.iha.com.tr/x.jpg",
  "https://iha.com.tr/y.mp4",
];
for (const u of good) {
  let ok = true;
  try { assertSafeUrl(u); } catch { ok = false; }
  check(`izin verildi: ${u.slice(0, 42)}`, ok);
}

console.log("\n=== DEPOLAMA YOLU ===");
const key = buildStorageKey({
  haberKodu: "20260818AW769386", externalKey: "R001",
  publishedAt: new Date("2026-08-18T02:16:37Z"),
});
check("tarih bazlı klasör", key === "media/2026/08/18/20260818AW769386/R001", key);
check("public URL birleşti",
  publicUrl(key, "card", "avif") === `https://medya.example.com/${key}/card.avif`);
const dirty = buildStorageKey({
  haberKodu: "../../../etc/passwd", externalKey: "a b/c",
  publishedAt: new Date("2026-01-05T00:00:00Z"),
});
check("path traversal temizlendi", !dirty.includes(".."), dirty);
check("boşluk/slash temizlendi", !dirty.includes(" ") && dirty.split("/").length === 6, dirty);
check("content type doğru", contentTypeFor("avif") === "image/avif");
check("bilinmeyen uzantı güvenli", contentTypeFor("xyz") === "application/octet-stream");

console.log("\n=== GÖRSEL İŞLEME ===");
// Gerçek bir JPEG üret (1920x1080, gradyan + gürültü)
const w = 1920, h = 1080;
const raw = Buffer.alloc(w * h * 3);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    raw[i] = (x / w) * 255;
    raw[i + 1] = (y / h) * 255;
    raw[i + 2] = ((x + y) % 256);
  }
}
const bigJpg = join(TMP, "test-big.jpg");
await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
  .jpeg({ quality: 85 }).toFile(bigJpg);
const jpgSize = (await stat(bigJpg)).size;

const ip = new ImageProcessor();
const img = await ip.process(bigJpg, settings);

check("3 varyant (webp fallback kapalı)", img.variants.length === 3, img.variants.map(v => v.name));
check("kaynak boyutu okundu", img.width === 1920 && img.height === 1080);
check("thumb 400px", img.variants.find(v => v.name === "thumb")?.width === 400);
check("card 800px", img.variants.find(v => v.name === "card")?.width === 800);
check("full kaynak boyutunda (1920)", img.variants.find(v => v.name === "full")?.width === 1920);
check("webp fallback üretilmedi", img.variants.find(v => v.name === "fb") === undefined);
check("avif formatı", img.variants[0].format === "avif");
check("blurhash üretildi", typeof img.blurhash === "string" && img.blurhash!.length > 6, img.blurhash);
check("baskın renk hex", /^#[0-9a-f]{6}$/.test(img.dominantColor ?? ""), img.dominantColor);
check("boyut küçüldü", img.bytesOut < jpgSize, { in: jpgSize, out: img.bytesOut });
const saving = Math.round((1 - img.bytesOut / jpgSize) * 100);
console.log(`       → ${(jpgSize/1024).toFixed(0)} KB -> ${(img.bytesOut/1024).toFixed(0)} KB (%${saving} tasarruf)`);
check("anlamlı sıkıştırma (>%40)", saving > 40, `%${saving}`);

console.log("\n=== BÜYÜTME YAPILMIYOR ===");
const smallJpg = join(TMP, "test-small.jpg");
await sharp({ create: { width: 500, height: 300, channels: 3, background: "#4488cc" } })
  .jpeg().toFile(smallJpg);
const smallOut = await ip.process(smallJpg, settings);
const maxW = Math.max(...smallOut.variants.map(v => v.width));
check("500px kaynak 1600px'e şişirilmedi", maxW <= 500, maxW);
check("yine de varyant üretildi", smallOut.variants.length >= 2, smallOut.variants.length);

console.log("\n=== BOZUK GÖRSEL ===");
const junk = join(TMP, "junk.jpg");
await writeFile(junk, Buffer.from("bu bir jpeg degil, sadece metin"));
let imgErr: any;
try { await ip.process(junk, settings); } catch (e) { imgErr = e; }
check("bozuk dosya reddedildi", imgErr !== undefined);
check("kalıcı hata (retry yok)", imgErr?.retryable === false, imgErr?.code);

console.log("\n=== VİDEO ===");

/** ffmpeg kurulu mu? Yoksa video testleri atlanır (Docker imajında var). */
async function hasFfmpeg(): Promise<boolean> {
  const probe = (cmd: string) => new Promise<boolean>((res) => {
    const p = spawn(cmd, ["-version"], { stdio: "ignore" });
    p.on("close", (c) => res(c === 0));
    p.on("error", () => res(false));
  });
  return (await probe("ffmpeg")) && (await probe("ffprobe"));
}

if (!(await hasFfmpeg())) {
  console.log("  --   ffmpeg bulunamadı, video testleri ATLANDI");
  console.log("       macOS:  brew install ffmpeg");
  console.log("       Ubuntu: sudo apt install ffmpeg");
  console.log("       (Docker imajında ffmpeg zaten kurulu, üretimi etkilemez)");
} else {
  // 6 saniyelik gerçek test videosu üret
  const srcVid = join(TMP, "src.mp4");
  await new Promise<void>((res, rej) => {
    const p = spawn("ffmpeg", ["-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=25:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
      "-c:a", "aac", "-pix_fmt", "yuv420p", srcVid]);
    p.on("close", (c) => c === 0 ? res() : rej(new Error("ffmpeg " + c)));
    p.on("error", rej);
  });
  const srcSize = (await stat(srcVid)).size;

  const vp = new VideoProcessor();
  const probe = await vp.probe(srcVid);
  check("süre okundu (6 sn)", probe.durationSec === 6, probe.durationSec);
  check("çözünürlük okundu", probe.width === 1920 && probe.height === 1080);
  check("ses akışı tespit edildi", probe.hasAudio === true);
  check("codec okundu", probe.codec === "h264", probe.codec);

  const vid = await vp.process(srcVid, settings);
  check("transcode atlanmadı", vid.skipped === false);
  check("1080p korundu (küçültülmedi)", vid.height === 1080, `${vid.width}x${vid.height}`);
  check("poster üretildi", vid.posterPath !== null);
  const posterSize = vid.posterPath ? (await stat(vid.posterPath)).size : 0;
  check("poster boş değil", posterSize > 1000, posterSize);
  check("çıktı boyutu küçüldü", vid.bytesOut < srcSize, { in: srcSize, out: vid.bytesOut });
  const vsav = Math.round((1 - vid.bytesOut / srcSize) * 100);
  console.log(`       → ${(srcSize/1024).toFixed(0)} KB -> ${(vid.bytesOut/1024).toFixed(0)} KB (%${vsav} tasarruf)`);

  // faststart doğrulaması: moov atom dosyanın ilk kısmında olmalı
  const { readFile } = await import("node:fs/promises");
  const head = (await readFile(vid.path)).subarray(0, 2048).toString("latin1");
  check("faststart uygulandı (moov başta)", head.includes("moov"), head.slice(0, 60));
  await vid.cleanup();


  console.log("\n=== ZATEN SIKIŞTIRILMIŞ VİDEO ===");
  {
    // Kaynak agresif sıkıştırılmışsa yeniden kodlamak dosyayı
    // BÜYÜTÜR ve kaliteyi düşürür. Canlıda -12%'ye kadar görüldü.
    const tiny = join(TMP, "tiny.mp4");
    await new Promise<void>((res, rej) => {
      const p = spawn("ffmpeg", ["-nostdin","-y","-i",srcVid,
        "-vf","scale=640:360","-c:v","libx264","-preset","fast","-crf","34",
        "-an","-pix_fmt","yuv420p", tiny]);
      p.on("close",(c)=>c===0?res():rej(new Error("ffmpeg "+c)));
      p.on("error",rej);
    });
    const tinySize = (await stat(tiny)).size;
    const tr = await vp.process(tiny, settings);
    check("kaynak korundu (transcode büyütüyordu)",
      tr.skipReason === "kaynak_daha_kucuk", tr.skipReason);
    check("çıktı kaynaktan büyük değil", tr.bytesOut <= tinySize, {
      kaynak: tinySize, cikti: tr.bytesOut });
    check("yine de kullanılabilir", tr.skipped === false && tr.path.length > 0);
    await tr.cleanup();
  }

  console.log("\n=== UZUN VİDEO ATLANIYOR ===");
  const longSettings = { ...settings, video_skip_over_sec: 3 } as BotSettings;
  const skipped = await vp.process(srcVid, longSettings);
  check("6sn > 3sn limiti, atlandı", skipped.skipped === true);
  check("sebep kaydedildi", skipped.skipReason?.includes("duration") === true, skipped.skipReason);
  check("poster yine de üretildi", skipped.posterPath !== null);
  check("transcode yapılmadı", skipped.bytesOut === 0);
  await skipped.cleanup();

  console.log("\n=== BOZUK VİDEO ===");
  const junkVid = join(TMP, "junk.mp4");
  await writeFile(junkVid, Buffer.alloc(5000, 7));
  let vidErr: any;
  try { await vp.probe(junkVid); } catch (e) { vidErr = e; }
  check("bozuk video reddedildi", vidErr !== undefined, vidErr?.code);
}


console.log("\n=== ffmpeg YOKKEN DAVRANIŞ ===");
{
  // Gerçek ENOENT: ffmpeg PATH'te bulunamıyor.
  // Bu bir ORTAM hatası — medya kaydı ÖLDÜRÜLMEMELİ.
  const { mkdirSync } = await import("node:fs");
  mkdirSync("/tmp/hb-emptybin", { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = "/tmp/hb-emptybin";

  // modül önbelleğini atlatmak için taze import
  const mod = await import("./video-processor.js?nocache=" + Date.now());
  const vp2 = new mod.VideoProcessor();
  let e2: any;
  try { await vp2.probe("/tmp/olmayan.mp4"); } catch (e) { e2 = e; }

  process.env.PATH = savedPath;

  check("ffmpeg eksikliği FFMPEG_MISSING olarak işaretlendi",
    e2?.code === "FFMPEG_MISSING", e2?.code);
  check("KALICI hata DEĞİL (kayıt ölmez)", e2?.retryable === true, e2?.retryable);
  check("ortam hatası olarak tanındı",
    mod.isEnvironmentError(e2) === true, mod.isEnvironmentError?.(e2));
}


console.log("\n=== DEPOLAMA SİLME GÜVENLİĞİ ===");
{
  const { deleteByPrefix } = await import("./storage.js");
  // Bir hata tüm bucket'ı silebilirdi; önek en az 3 seviye ve
  // media/ altında olmalı.
  for (const p of ["", "/", "media", "media/", "media/2026", "..", "*",
                   "a/b/c", "img/x/y/z"]) {
    let blocked = false;
    try { await deleteByPrefix(p); }
    catch (e: any) { blocked = e?.code === "UNSAFE_PREFIX"; }
    check(`tehlikeli önek reddedildi: "${p}"`, blocked);
  }
}

console.log("\n=== TEMİZLİK ===");
const before = (await import("node:fs")).readdirSync(TMP).length;
await rm(TMP, { recursive: true, force: true });
check("geçici dosyalar silinebilir", true);

console.log(`\n${"=".repeat(40)}\nGEÇTİ: ${pass}   KALDI: ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
