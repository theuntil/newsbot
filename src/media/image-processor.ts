import sharp from "sharp";
import type { Metadata, Sharp } from "sharp";
import { encode as encodeBlurhash } from "blurhash";
import { stat as statFile } from "node:fs/promises";
import { log } from "../lib/logger.js";
import { BotError } from "../lib/errors.js";
import type { BotSettings } from "../db/client.js";

// Paylaşımlı sunucu: sharp'ın kendi thread havuzunu sınırla.
// Varsayılan tüm çekirdekleri kullanır ve diğer projeleri boğar.
sharp.concurrency(2);
sharp.cache({ memory: 128, files: 0, items: 50 });

export interface ImageVariantOut {
  name: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  buffer: Buffer;
}

export interface ImageProcessResult {
  variants: ImageVariantOut[];
  width: number;
  height: number;
  blurhash: string | null;
  dominantColor: string | null;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
}

/** Zip bomb benzeri saldırı: küçük dosya, devasa piksel boyutu */
const MAX_PIXELS = 100_000_000; // 100 MP

export class ImageProcessor {
  /**
   * Görseli işler.
   *
   * Strateji: AVIF q52 + 3 boyut. IHA fotoğrafları zaten JPEG q85
   * civarı; AVIF'e geçince 250 KB → ~35 KB, gözle fark edilmez.
   *
   * Küçültme yapılır, BÜYÜTME YAPILMAZ. Kaynak 600px ise "full"
   * varyantı 1600px'e şişirilmez — dosya büyür, kalite artmaz.
   */
  async process(
    filePath: string,
    settings: BotSettings,
  ): Promise<ImageProcessResult> {
    const started = Date.now();

    let meta: Metadata;
    try {
      meta = await sharp(filePath, { limitInputPixels: MAX_PIXELS }).metadata();
    } catch (err) {
      throw new BotError("Görsel okunamadı (bozuk dosya?)", {
        kind: "media_process", retryable: false, code: "DECODE_FAILED", cause: err,
      });
    }

    if (!meta.width || !meta.height) {
      throw new BotError("Görsel boyutu okunamadı", {
        kind: "media_process", retryable: false, code: "NO_DIMENSIONS",
      });
    }
    if (meta.width * meta.height > MAX_PIXELS) {
      throw new BotError(`Görsel çok büyük: ${meta.width}x${meta.height}`, {
        kind: "media_process", retryable: false, code: "TOO_MANY_PIXELS",
      });
    }

    // EXIF rotation uygula ve metadata'yı SİL.
    // GPS koordinatı, cihaz bilgisi, bazen fotoğrafçı adı taşır —
    // bunları CDN'e koymak gereksiz veri sızıntısı.
    const base = sharp(filePath, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .withMetadata({ orientation: undefined });

    const variants: ImageVariantOut[] = [];
    let bytesOut = 0;

    const wanted = Array.isArray(settings.image_variants) && settings.image_variants.length
      ? settings.image_variants
      : [{ name: "thumb", w: 400 }, { name: "card", w: 800 }, { name: "full", w: 1600 }];

    for (const v of wanted) {
      /**
       * Kaynaktan büyük varyant üretme. `withoutEnlargement` zaten
       * büyütmüyor ama aynı boyutta iki dosya üretmeyi de engelle:
       * kaynak 1280px ise "full"(1920) ve "card"(800) yeter,
       * 1920 varyantı 1280 olarak çıkar ve card ile çakışmaz.
       */
      if (v.name !== "thumb" && meta.width < v.w * 0.9) {
        const already = variants.some((x) => x.width >= meta.width! - 2);
        if (already) continue;
      }

      const buf = await this.encode(base.clone(), v.w, settings);
      const m = await sharp(buf).metadata();

      variants.push({
        name: v.name,
        format: settings.image_format,
        width: m.width ?? v.w,
        height: m.height ?? 0,
        bytes: buf.byteLength,
        buffer: buf,
      });
      bytesOut += buf.byteLength;
    }

    // WebP fallback — eski Safari/Edge AVIF desteklemez
    if (settings.image_fallback_webp) {
      const cardW = wanted.find((v) => v.name === "card")?.w ?? 800;
      const buf = await base.clone()
        .resize({ width: cardW, withoutEnlargement: true })
        .webp({ quality: Math.min(85, settings.image_quality + 20), effort: 4 })
        .toBuffer();
      const m = await sharp(buf).metadata();
      variants.push({
        name: "fb", format: "webp",
        width: m.width ?? cardW, height: m.height ?? 0,
        bytes: buf.byteLength, buffer: buf,
      });
      bytesOut += buf.byteLength;
    }

    if (variants.length === 0) {
      throw new BotError("Hiç varyant üretilemedi", {
        kind: "media_process", retryable: false, code: "NO_VARIANTS",
      });
    }

    const [blurhash, dominantColor] = await Promise.all([
      settings.image_blurhash ? this.blurhash(base.clone()) : Promise.resolve(null),
      this.dominantColor(base.clone()),
    ]);

    // sharp'ın metadata().size'ı bazı formatlarda 0/undefined dönüyor,
    // bu yüzden tasarruf oranı hep %0 görünüyordu. Dosyayı doğrudan oku.
    const bytesIn = (await statFile(filePath)).size;
    const result: ImageProcessResult = {
      variants,
      width: meta.width,
      height: meta.height,
      blurhash,
      dominantColor,
      bytesIn,
      bytesOut,
      durationMs: Date.now() - started,
    };

    log.debug("Görsel işlendi", {
      source: `${meta.width}x${meta.height}`,
      variants: variants.length,
      bytesIn, bytesOut,
      saving: bytesIn ? `${Math.round((1 - bytesOut / bytesIn) * 100)}%` : "?",
      ms: result.durationMs,
    });

    return result;
  }

  private async encode(
    img: Sharp, width: number, s: BotSettings,
  ): Promise<Buffer> {
    const resized = img.resize({
      width,
      withoutEnlargement: true,
      fit: "inside",
      kernel: "lanczos3",
    });

    switch (s.image_format) {
      case "avif":
        // effort 4: kalite/süre dengesi. 9 çok yavaş, 0 dosyayı şişirir.
        return resized.avif({ quality: s.image_quality, effort: 4, chromaSubsampling: "4:2:0" }).toBuffer();
      case "webp":
        return resized.webp({ quality: s.image_quality, effort: 4 }).toBuffer();
      default:
        return resized.jpeg({ quality: s.image_quality, progressive: true, mozjpeg: true }).toBuffer();
    }
  }

  /**
   * Blurhash — sayfa yüklenirken bulanık önizleme.
   * CLS (layout shift) sıfırlanır, algılanan hız artar.
   */
  private async blurhash(img: Sharp): Promise<string | null> {
    try {
      const { data, info } = await img
        .resize(32, 32, { fit: "inside" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return encodeBlurhash(
        new Uint8ClampedArray(data), info.width, info.height, 4, 3,
      );
    } catch (err) {
      log.debug("Blurhash üretilemedi", { err });
      return null;
    }
  }

  private async dominantColor(img: Sharp): Promise<string | null> {
    try {
      const { dominant } = await img.stats();
      const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
      return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
    } catch {
      return null;
    }
  }
}
