import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseIhaDate, clampFuture } from "../lib/dates.js";
import { cleanText, splitDescription, contentHash } from "../lib/text.js";
import type { ParsedItem, ParsedMedia, ParseResult } from "./types.js";

/**
 * rss-parser KULLANILMAZ.
 * Bu feed standart RSS değil: HaberKodu, images/image, videos/video,
 * Aciklamalar/Aciklama gibi custom node'lar var. rss-parser bunları düşürür.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false, // "007" gibi kodları sayıya çevirmesin
  parseTagValue: false,       // HaberKodu'nu string tut
  trimValues: true,
  processEntities: true,      // &amp;param1= → &param1=  (ZORUNLU)
  htmlEntities: true,
  cdataPropName: "__cdata",
  textNodeName: "#text",
  // Tek elemanlıyken de dizi olsun — aksi halde 1 fotoğraflı haberde
  // images.image bir obje döner ve .map() patlar
  isArray: (name) =>
    ["item", "image", "video", "Aciklama"].includes(name),
});

/** CDATA / text / düz string — hepsinden metni çıkar */
function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.__cdata != null) return String(o.__cdata);
    if (o["#text"] != null) return String(o["#text"]);
  }
  return "";
}

function attrNum(node: unknown, key: string): number | null {
  if (node == null || typeof node !== "object") return null;
  const v = (node as Record<string, unknown>)[`@_${key}`];
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function attrStr(node: unknown, key: string): string | null {
  if (node == null || typeof node !== "object") return null;
  const v = (node as Record<string, unknown>)[`@_${key}`];
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function firstField(item: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (item[n] != null) return item[n];
  return null;
}

/** "Evet"/"Hayır"/"1"/"true" → boolean */
function parseBool(v: unknown): boolean {
  const s = cleanText(v).toLowerCase();
  return ["evet", "true", "1", "yes", "e"].includes(s);
}

/**
 * Açıklamalar. Gerçek yapıda her Aciklama'nın ResimKodu attribute'u var:
 *   <Aciklama HaberKodu="..." ResimKodu="20260822AW772685_01">metin</Aciklama>
 *
 * Sıraya güvenmek yerine ResimKodu ile eşleştiriyoruz — bir fotoğraf
 * eksikse veya sıra kayarsa yanlış künye atanmasın (foto muhabiri
 * adı yanlış fotoğrafa gitmesin).
 */
function readCaptions(item: Record<string, unknown>): {
  byKey: Map<string, string>; ordered: string[];
} {
  const byKey = new Map<string, string>();
  const ordered: string[] = [];

  const holder = firstField(item, ["Aciklamalar", "aciklamalar"]);
  if (!holder || typeof holder !== "object") return { byKey, ordered };

  const raw = (holder as Record<string, unknown>).Aciklama
    ?? (holder as Record<string, unknown>).aciklama;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  for (const a of list) {
    const text = cleanText(textOf(a));
    if (!text) continue;
    ordered.push(text);
    const key = attrStr(a, "ResimKodu") ?? attrStr(a, "resimkodu");
    if (key) byKey.set(key, text);
  }
  return { byKey, ordered };
}

function readImages(
  item: Record<string, unknown>,
  captions: { byKey: Map<string, string>; ordered: string[] },
): ParsedMedia[] {
  const holder = firstField(item, ["images", "Images", "Resimler"]);
  if (!holder || typeof holder !== "object") return [];
  const raw = (holder as Record<string, unknown>).image
    ?? (holder as Record<string, unknown>).Resim;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const out: ParsedMedia[] = [];
  list.forEach((node, i) => {
    const url = cleanText(textOf(node));
    if (!url || !/^https?:\/\//i.test(url)) return;

    const key = attrStr(node, "ResimKodu") ?? attrStr(node, "resimkodu") ?? `img-${i + 1}`;

    out.push({
      externalKey: key,
      type: "image",
      url,
      // filesize yoksa 0 kabul et → indirme denenmez, retry planlanır
      sourceBytes: attrNum(node, "filesize") ?? 0,
      // Önce ResimKodu eşleşmesi, olmazsa sıraya düş
      caption: captions.byKey.get(key) ?? captions.ordered[i] ?? null,
      order: attrNum(node, "sira") ?? i + 1,
      durationSec: null,
      posterUrl: null,
    });
  });
  return out;
}

/**
 * Video düğümlerini bul.
 *
 * IHA'NIN GERÇEK YAPISI (canlı feed'den doğrulandı):
 *   <videos>
 *     <video>
 *       <Aciklama VideoKodu="1926967">...</Aciklama>
 *       <path_video  duration="47" filesize="4565773" VideoKodu="1926967">URL</path_video>
 *       <path_poster VideoKodu="1926967">URL</path_poster>
 *     </video>
 *   </videos>
 *
 * KRİTİK: URL <video> düğümünün metni DEĞİL, alt düğüm
 * <path_video> içinde. Attribute'lar da orada. Önceki sürüm
 * <video>'nun kendi metnini okuyordu ve boş dönüyordu —
 * bu yüzden hiç video kaydı oluşmuyordu.
 *
 * Ek olarak eski/alternatif yapılar da destekleniyor.
 */
function readVideos(item: Record<string, unknown>, offset: number): ParsedMedia[] {
  const out: ParsedMedia[] = [];
  const seen = new Set<string>();
  let seq = 0;

  const add = (m: Omit<ParsedMedia, "order">) => {
    if (!m.url || !/^https?:\/\//i.test(m.url)) return;
    if (seen.has(m.url)) return;
    seen.add(m.url);
    out.push({ ...m, order: offset + ++seq });
  };

  /** <video> düğümünü çöz — asıl yapı */
  const parseVideoNode = (node: unknown, idx: number) => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;

    // 1) Asıl yol: alt düğüm path_video
    const pv = o.path_video ?? o.PathVideo ?? o.path ?? o.url;
    const pp = o.path_poster ?? o.PathPoster ?? o.poster;

    let url = cleanText(textOf(pv));
    let source: unknown = pv;

    // 2) Yedek: URL doğrudan <video> metninde
    if (!url) {
      url = cleanText(textOf(node));
      source = node;
    }
    if (!url) return;

    // Açıklama alt düğümde olabilir
    let caption: string | null = null;
    const ac = o.Aciklama ?? o.aciklama;
    if (ac != null) {
      const arr = Array.isArray(ac) ? ac : [ac];
      caption = cleanText(textOf(arr[0])) || null;
    }

    // Poster: alt düğüm (gerçek yapı) VEYA attribute (eski varyant)
    const posterUrl =
      cleanText(textOf(pp)) ||
      attrStr(node, "path_poster") ||
      attrStr(node, "poster") ||
      attrStr(source, "path_poster") ||
      "";

    add({
      externalKey:
        attrStr(source, "VideoKodu") ?? attrStr(node, "VideoKodu") ??
        attrStr(source, "videokodu") ?? attrStr(node, "kod") ?? `vid-${idx + 1}`,
      type: "video",
      url,
      // filesize=0 ise video henüz hazır değil → retry planlanır
      sourceBytes: attrNum(source, "filesize") ?? attrNum(node, "filesize")
        ?? attrNum(source, "length") ?? 0,
      caption,
      durationSec: attrNum(source, "duration") ?? attrNum(node, "duration")
        ?? attrNum(source, "sure") ?? attrNum(node, "sure") ?? null,
      posterUrl: posterUrl && /^https?:\/\//i.test(posterUrl) ? posterUrl : null,
    });
  };

  // --- Sarmalayıcı içinde -----------------------------------
  for (const w of ["videos", "Videos", "Videolar", "VIDEOS"]) {
    const holder = item[w];
    if (!holder || typeof holder !== "object") continue;
    for (const i of ["video", "Video", "VIDEO"]) {
      const list = (holder as Record<string, unknown>)[i];
      const arr = Array.isArray(list) ? list : list ? [list] : [];
      arr.forEach(parseVideoNode);
    }
  }

  // --- Doğrudan item altında --------------------------------
  for (const i of ["video", "Video"]) {
    const direct = item[i];
    if (direct == null) continue;
    const arr = Array.isArray(direct) ? direct : [direct];
    arr.forEach(parseVideoNode);
  }

  // --- RSS standardı <enclosure> ----------------------------
  const enc = item.enclosure ?? item.Enclosure;
  const encArr = Array.isArray(enc) ? enc : enc ? [enc] : [];
  encArr.forEach((node, i) => {
    const type = attrStr(node, "type") ?? "";
    const url = attrStr(node, "url") ?? cleanText(textOf(node));
    if (/^video\//i.test(type) || /\.(mp4|m4v|mov|webm)(\?|$)/i.test(url)) {
      add({
        externalKey: attrStr(node, "VideoKodu") ?? `enc-${i + 1}`,
        type: "video", url,
        sourceBytes: attrNum(node, "length") ?? attrNum(node, "filesize") ?? 0,
        caption: null, durationSec: null, posterUrl: null,
      });
    }
  });

  return out;
}

function parseItem(item: Record<string, unknown>): ParsedItem {
  const haberKodu = cleanText(
    textOf(firstField(item, ["HaberKodu", "haberkodu", "guid"])),
  );
  if (!haberKodu) throw new Error("HaberKodu boş");

  const title = cleanText(textOf(firstField(item, ["title", "Baslik"])));
  if (!title) throw new Error("Başlık boş");

  const { summary, blocks, bodyText } = splitDescription(
    textOf(firstField(item, ["description", "Aciklama", "Metin"])),
  );

  const kategori = cleanText(textOf(firstField(item, ["Kategori", "kategori"]))) || null;

  const captions = readCaptions(item);
  const images = readImages(item, captions);
  const videos = readVideos(item, images.length);

  const ustKategori = cleanText(textOf(firstField(item, ["UstKategori", "ustkategori"]))) || null;
  const sehir = cleanText(textOf(firstField(item, ["Sehir", "sehir", "Il"]))) || null;
  const sonDakika = parseBool(firstField(item, ["SonDakika", "sondakika"]));

  const publishedAt = clampFuture(
    parseIhaDate(textOf(firstField(item, ["pubDate", "PubDate", "Tarih"]))),
  );
  const updatedAt = parseIhaDate(
    textOf(firstField(item, ["SonHaberGuncellenmeTarihi", "GuncellenmeTarihi"])),
  );
  const photoAddedAt = parseIhaDate(
    textOf(firstField(item, ["SonFotografEklenmeTarihi"])),
  );

  return {
    haberKodu,
    title,
    summary,
    body: blocks,
    bodyText,
    kategori,
    ustKategori,
    sehir,
    sonDakika,
    publishedAt,
    updatedAt,
    photoAddedAt,
    media: [...images, ...videos],
    contentHash: contentHash({ title, summary, bodyText, kategori, sehir, sonDakika }),
    raw: item,
  };
}

/**
 * Feed'i ayrıştır.
 *
 * TASARIM: Tek item patlarsa TÜM tur çökmez. Hatalı item errors[]
 * dizisine düşer, dead-letter kuyruğuna gider, diğerleri işlenir.
 * "Haber atlamama" garantisinin ilk katmanı budur.
 */
export function parseIhaFeed(xml: string): ParseResult {
  if (!xml || xml.trim().length === 0) {
    throw new Error("Feed boş geldi");
  }

  const valid = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (valid !== true) {
    throw new Error(`Geçersiz XML: ${valid.err.msg} (satır ${valid.err.line})`);
  }

  const doc = parser.parse(xml) as Record<string, any>;
  const channel = doc?.rss?.channel ?? doc?.channel;
  if (!channel) throw new Error("channel bulunamadı — beklenmeyen feed yapısı");

  const rawItems: unknown[] = Array.isArray(channel.item) ? channel.item : [];

  const items: ParsedItem[] = [];
  const errors: ParseResult["errors"] = [];
  const seen = new Set<string>();

  rawItems.forEach((raw, index) => {
    try {
      const parsed = parseItem(raw as Record<string, unknown>);

      // Aynı feed içinde tekrar eden haber kodu → ilkini al
      if (seen.has(parsed.haberKodu)) return;
      seen.add(parsed.haberKodu);

      items.push(parsed);
    } catch (err) {
      const o = raw as Record<string, unknown>;
      errors.push({
        index,
        haberKodu: cleanText(textOf(o?.HaberKodu)) || null,
        message: err instanceof Error ? err.message : String(err),
        raw,
      });
    }
  });

  return {
    items,
    errors,
    channelTitle: cleanText(textOf(channel.title)) || null,
    totalSeen: rawItems.length,
  };
}
