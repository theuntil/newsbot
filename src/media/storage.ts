import { createReadStream, statSync } from "node:fs";
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectsCommand,
         ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { env } from "../config/env.js";
import { log } from "../lib/logger.js";
import { BotError } from "../lib/errors.js";

/**
 * Cloudflare R2 — S3 uyumlu.
 *
 * R2 NOTLARI:
 *  - region "auto" olmalı; "eeur" yazarsan SDK imza hatası verir
 *  - ContentType AÇIKÇA verilmeli; R2 tahmin etmez, boş bırakılırsa
 *    tarayıcı görseli indirmeye çalışır
 *  - checksum davranışı S3'ten biraz farklı → SDK v3.700+ gerekli
 */
let client: S3Client | null = null;

export function s3(): S3Client {
  if (client) return client;
  client = new S3Client({
    region: env.s3.region,
    endpoint: env.s3.endpoint,
    credentials: {
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
    },
    maxAttempts: 3,
    requestHandler: { requestTimeout: 120_000 },
  });
  return client;
}

const CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg", jpg: "image/jpeg",
  png: "image/png", mp4: "video/mp4", m4a: "audio/mp4", json: "application/json",
};

export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.replace(/^\./, "").toLowerCase()] ?? "application/octet-stream";
}

/**
 * Depolama yolu şeması:
 *   media/{yyyy}/{mm}/{dd}/{haberKodu}/{externalKey}/{variant}.{ext}
 *
 * Tarih bazlı klasörleme: ileride "2025'i sil" gibi toplu işlem kolay olsun.
 * İçerik asla değişmediği için CDN'de 1 yıl cache güvenli.
 */
export function buildStorageKey(opts: {
  haberKodu: string;
  externalKey: string;
  publishedAt: Date | null;
}): string {
  const d = opts.publishedAt ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return `media/${yyyy}/${mm}/${dd}/${safe(opts.haberKodu)}/${safe(opts.externalKey)}`;
}

/** DB'de tam URL saklanmaz; okuma anında burada birleşir */
export function publicUrl(storageKey: string, variant: string, ext: string): string {
  return `${env.s3.cdnBase}/${storageKey}/${variant}.${ext}`;
}

export interface UploadResult { key: string; bytes: number; etag: string | null }

/** Küçük dosyalar (görsel varyantları) — bellekten tek atışta */
export async function putBuffer(
  key: string, body: Buffer, ext: string,
  meta?: Record<string, string>,
): Promise<UploadResult> {
  try {
    const res = await s3().send(new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentTypeFor(ext),
      // Path'te içerik hiç değişmiyor → uzun cache güvenli
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: meta,
    }));
    return { key, bytes: body.byteLength, etag: res.ETag ?? null };
  } catch (err) {
    throw new BotError(`R2 yükleme hatası: ${key}`, {
      kind: "media_upload", retryable: true, cause: err, context: { key },
    });
  }
}

/**
 * Büyük dosyalar (video) — DİSKTEN AKIŞ.
 *
 * KRİTİK: 82 MB'lik videoyu readFileSync ile belleğe alma. Üç video
 * paralel gelirse container OOM-kill olur. Bu botların en sık
 * öldüğü yer. Upload sınıfı 8 MB'lik parçalar halinde gönderir.
 */
export async function putFileStream(
  key: string, filePath: string, ext: string,
  meta?: Record<string, string>,
): Promise<UploadResult> {
  const size = statSync(filePath).size;
  try {
    const upload = new Upload({
      client: s3(),
      params: {
        Bucket: env.s3.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentType: contentTypeFor(ext),
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: meta,
      },
      partSize: 8 * 1024 * 1024,
      queueSize: 2,       // paylaşımlı sunucu: bant genişliğini tekelleştirme
      leavePartsOnError: false,
    });

    upload.on("httpUploadProgress", (p) => {
      if (p.loaded && size > 20_000_000) {
        log.debug("Yükleme ilerleme", {
          key, percent: Math.round((p.loaded / size) * 100),
        });
      }
    });

    const res = await upload.done();
    return { key, bytes: size, etag: (res as { ETag?: string }).ETag ?? null };
  } catch (err) {
    throw new BotError(`R2 akış yükleme hatası: ${key}`, {
      kind: "media_upload", retryable: true, cause: err, context: { key, size },
    });
  }
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Yeniden işleme öncesi eski varyantları temizle */
export async function deletePrefix(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  try {
    const res = await s3().send(new DeleteObjectsCommand({
      Bucket: env.s3.bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }));
    return keys.length - (res.Errors?.length ?? 0);
  } catch (err) {
    log.warn("R2 silme başarısız", { err, count: keys.length });
    return 0;
  }
}

/** Açılış kontrolü — yanlış anahtarı ilk medyada değil şimdi öğren */
export async function verifyStorage(): Promise<boolean> {
  const probe = `_health/${Date.now()}.json`;
  try {
    await putBuffer(probe, Buffer.from(JSON.stringify({ ok: true })), "json");
    await deletePrefix([probe]);
    log.info("R2 bağlantısı doğrulandı", { bucket: env.s3.bucket });
    return true;
  } catch (err) {
    log.error("R2 doğrulaması başarısız", { err, bucket: env.s3.bucket });
    return false;
  }
}


/**
 * Bir önek altındaki TÜM nesneleri listele.
 *
 * Varyant isimlerini tahmin etmek yerine gerçekten listeliyoruz:
 * ayarlar değiştiyse eski varyantlar da (örn. 1600px "full" veya
 * kapatılmış webp fallback) yakalanır. Tahmin etseydik yetim
 * dosya kalırdı.
 */
export async function listKeys(prefix: string, max = 1000): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;

  do {
    const res = await s3().send(new ListObjectsV2Command({
      Bucket: env.s3.bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: Math.min(1000, max - keys.length),
    }));
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && keys.length < max);

  return keys;
}

/**
 * Bir anahtarı ya da önek altındaki her şeyi sil.
 *
 * ┌─ AVATAR VE EDİTÖR DOSYALARI HİÇ SİLİNMİYORDU ⚠️ ──────────┐
 * │ Bu fonksiyon yalnızca `media/` altını kabul ediyordu; her │
 * │ şeyi bir KLASÖR sayıp altını listeliyordu.                 │
 * │                                                              │
 * │ Ama iki farklı düzen var:                                   │
 * │   media/…/KOD/ANAHTAR/  → klasör (bot çıktısı, varyantlar) │
 * │   avatar/uid/a.jpg      → TEK DOSYA                        │
 * │   editor/uid/k.jpg      → TEK DOSYA                        │
 * │                                                              │
 * │ Silme kuyruğuna giren avatar ve editör anahtarları         │
 * │ "Sadece media/ altı silinebilir" hatasıyla reddediliyor,   │
 * │ dosyalar R2'de sonsuza kadar kalıyordu.                     │
 * │                                                              │
 * │ ⚠ GÜVENLİK KORUNUYOR. Yalnızca bilinen dört önek kabul     │
 * │ ediliyor ve en az üç seviye derinlik şartı duruyor —       │
 * │ hatalı bir çağrı bucket'ın tamamını silemez.                │
 * └──────────────────────────────────────────────────────────────┘
 */
const SILINEBILIR_ONEK = ["media/", "avatar/", "editor/", "library/"];

/** Klasör düzeni yalnızca bot çıktısında var */
const KLASOR_ONEK = "media/";

export async function deleteByPrefix(prefix: string): Promise<number> {
  const clean = prefix.replace(/^\/+|\/+$/g, "");

  if (clean.length < 8 || clean.split("/").length < 3) {
    throw new BotError(`Tehlikeli silme öneki reddedildi: "${prefix}"`, {
      kind: "media_upload", retryable: false, code: "UNSAFE_PREFIX",
    });
  }
  if (!SILINEBILIR_ONEK.some((o) => clean.startsWith(o))) {
    throw new BotError(
      `Bu önek silinemez: "${prefix}" (izinli: ${SILINEBILIR_ONEK.join(", ")})`,
      { kind: "media_upload", retryable: false, code: "UNSAFE_PREFIX" },
    );
  }

  /*
   * ⚠ TEK DOSYA MI, KLASÖR MÜ?
   *
   * `media/` altı klasör: bir haberin thumb/card/full varyantları
   * aynı klasörde. `avatar/`, `editor/` ve `library/` ise tek
   * dosya; altını listelemek boş dönerdi ve dosya hiç silinmezdi.
   */
  if (!clean.startsWith(KLASOR_ONEK)) {
    await s3().send(new DeleteObjectsCommand({
      Bucket: env.s3.bucket,
      Delete: { Objects: [{ Key: clean }], Quiet: true },
    }));
    return 1;
  }

  const keys = await listKeys(`${clean}/`);
  if (keys.length === 0) return 0;

  let deleted = 0;
  // DeleteObjects tek seferde en fazla 1000 anahtar alır
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const res = await s3().send(new DeleteObjectsCommand({
      Bucket: env.s3.bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }));
    deleted += batch.length - (res.Errors?.length ?? 0);
    if (res.Errors?.length) {
      log.warn("Bazı nesneler silinemedi", {
        prefix: clean, hata: res.Errors.length,
        ornek: res.Errors[0]?.Message,
      });
    }
  }

  log.debug("Depolama öneki silindi", { prefix: clean, dosya: deleted });
  return deleted;
}
