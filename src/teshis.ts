/**
 * TEŞHİS ARACI — gerçek feed'in yapısını raporlar.
 *
 * Kullanım:  npm run teshis
 *
 * Feed'i BİR KEZ çeker (hız sınırına uyar), tüm node isimlerini,
 * medya bloklarını ve örnek bir item'ı gösterir. Böylece parser'ın
 * neyi kaçırdığını tahmin etmek yerine GÖREBİLİRİZ.
 *
 * Çıktıda sır yoktur; ham XML de istenirse dosyaya yazılır.
 */
import { writeFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { env, buildFeedUrl, validateEnv } from "./config/env.js";
import { configureLogger, log } from "./lib/logger.js";
import { parseIhaFeed } from "./parser/iha-parser.js";

const HR = "═".repeat(60);

function keysOf(obj: unknown, prefix = "", out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 4 || obj == null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    if (obj[0]) keysOf(obj[0], prefix, out, depth);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    if (v && typeof v === "object") keysOf(v, path, out, depth + 1);
  }
  return out;
}

async function main() {
  configureLogger("info", "teshis");
  validateEnv();

  console.log(`\n${HR}\n  FEED TEŞHİS\n${HR}\n`);

  console.log("Feed çekiliyor (tek istek)...");
  const res = await fetch(buildFeedUrl(), {
    headers: { "User-Agent": "KuzeybatiHaberBot/1.0-teshis" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status} — feed alınamadı`);
    process.exit(1);
  }

  const xml = await res.text();
  console.log(`Alındı: ${(xml.length / 1024).toFixed(0)} KB\n`);

  if (!xml.includes("<rss") && !xml.includes("<?xml")) {
    console.error("XML gelmedi. Yanıt:");
    console.error(xml.slice(0, 300).replace(/(User\w+\s*=\s*)[^\s,\]]+/gi, "$1***"));
    process.exit(1);
  }

  await writeFile("feed-ornek.xml", xml, "utf8");
  console.log("Ham XML kaydedildi: feed-ornek.xml\n");

  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: "@_",
    parseAttributeValue: false, parseTagValue: false,
    processEntities: true, cdataPropName: "__cdata",
    isArray: (n) => ["item"].includes(n),
  });
  const doc = parser.parse(xml) as any;
  const channel = doc?.rss?.channel ?? doc?.channel;
  const items: any[] = Array.isArray(channel?.item) ? channel.item : [];

  console.log(`${HR}\n  1. GENEL\n${HR}`);
  console.log(`  Item sayısı: ${items.length}`);
  console.log(`  Channel alanları: ${Object.keys(channel ?? {}).filter(k => k !== "item").join(", ")}`);

  // --- Tüm alan adları -------------------------------------
  const allKeys = new Set<string>();
  for (const it of items) keysOf(it, "", allKeys);

  console.log(`\n${HR}\n  2. TÜM ALAN ADLARI (item içinde)\n${HR}`);
  [...allKeys].sort().forEach((k) => console.log(`  ${k}`));

  // --- Medya ile ilgili alanlar ----------------------------
  const mediaKeys = [...allKeys].filter((k) =>
    /video|resim|image|foto|photo|media|enclosure|mp4|dosya|file/i.test(k));

  console.log(`\n${HR}\n  3. MEDYA İLE İLGİLİ ALANLAR\n${HR}`);
  if (mediaKeys.length === 0) {
    console.log("  ⚠️  Hiç medya alanı bulunamadı!");
  } else {
    mediaKeys.forEach((k) => console.log(`  ${k}`));
  }

  // --- Video araması ---------------------------------------
  console.log(`\n${HR}\n  4. VİDEO ARAMASI\n${HR}`);
  const videoItems = items.filter((it) => {
    const s = JSON.stringify(it).toLowerCase();
    return s.includes("video") || s.includes(".mp4") || s.includes("videokodu");
  });
  console.log(`  Video içeren item: ${videoItems.length} / ${items.length}`);

  if (videoItems.length > 0) {
    console.log("\n  --- İLK VİDEOLU ITEM (ham yapı) ---");
    const v = videoItems[0];
    const videoFields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (/video|media|enclosure|mp4/i.test(k) || /video|\.mp4/i.test(JSON.stringify(val))) {
        videoFields[k] = val;
      }
    }
    console.log(JSON.stringify(videoFields, null, 2).slice(0, 2500));
  } else {
    console.log("  ⚠️  Bu feed'de HİÇ VİDEO YOK.");
    console.log("     Muhtemelen 'standartrss' sadece fotoğraf içeriyor.");
    console.log("     IHA'nın ayrı bir video feed'i olabilir — abonelik");
    console.log("     panelinden veya destekten sorman gerekir.");
  }

  // --- Fotoğraf yapısı -------------------------------------
  console.log(`\n${HR}\n  5. FOTOĞRAF YAPISI (örnek)\n${HR}`);
  const withImg = items.find((it) => {
    const s = JSON.stringify(it).toLowerCase();
    return s.includes("resim") || s.includes("image");
  });
  if (withImg) {
    const imgFields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(withImg)) {
      if (/resim|image|foto|photo/i.test(k)) imgFields[k] = val;
    }
    console.log(JSON.stringify(imgFields, null, 2).slice(0, 1500));
  }

  // --- Parser sonucu ---------------------------------------
  console.log(`\n${HR}\n  6. PARSER SONUCU\n${HR}`);
  const parsed = parseIhaFeed(xml);
  const imgCount = parsed.items.reduce((s, i) => s + i.media.filter(m => m.type === "image").length, 0);
  const vidCount = parsed.items.reduce((s, i) => s + i.media.filter(m => m.type === "video").length, 0);
  const zeroByte = parsed.items.reduce((s, i) => s + i.media.filter(m => m.sourceBytes === 0).length, 0);

  console.log(`  Ayrıştırılan haber : ${parsed.items.length}`);
  console.log(`  Parse hatası       : ${parsed.errors.length}`);
  console.log(`  Bulunan fotoğraf   : ${imgCount}`);
  console.log(`  Bulunan video      : ${vidCount}`);
  console.log(`  filesize=0 (bekleyen): ${zeroByte}`);

  if (vidCount === 0 && videoItems.length > 0) {
    console.log("\n  ⚠️  Feed'de video VAR ama parser bulamıyor!");
    console.log("     Yukarıdaki bölüm 4'teki yapıyı paylaş, parser'ı düzeltelim.");
  }

  console.log(`\n${HR}`);
  console.log("  Bölüm 2, 3 ve 4'ün çıktısını paylaşırsan gerekli");
  console.log("  düzeltmeyi yapabilirim.");
  console.log(`${HR}\n`);
}

main().catch((err) => {
  log.error("Teşhis başarısız", { err });
  process.exit(1);
});
