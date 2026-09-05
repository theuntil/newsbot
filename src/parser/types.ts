/**
 * IHA feed — normalize edilmiş tipler.
 *
 * Ham XML asla dışarı sızmaz; parser sadece bu tipleri üretir.
 */

/** articles.body içine yazılan blok. Mobil native render eder. */
export type BodyBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "media"; mediaKey: string };

export interface ParsedMedia {
  /** IHA ResimKodu / VideoKodu — media.external_key */
  externalKey: string;
  type: "image" | "video";
  url: string;
  /**
   * Feed'deki filesize.
   * 0 => DOSYA HENÜZ YÜKLENMEMİŞ. İndirme denemesi yapılmaz, retry planlanır.
   */
  sourceBytes: number;
  caption: string | null;
  order: number;
  /** video */
  durationSec: number | null;
  posterUrl: string | null;
}

export interface ParsedItem {
  haberKodu: string;
  title: string;
  summary: string | null;
  body: BodyBlock[];
  bodyText: string;

  kategori: string | null;
  ustKategori: string | null;
  sehir: string | null;
  sonDakika: boolean;

  /** UTC'ye çevrilmiş (feed Europe/Istanbul yerel saat verir) */
  publishedAt: Date | null;
  updatedAt: Date | null;
  photoAddedAt: Date | null;

  media: ParsedMedia[];

  /** Metin değişti mi kontrolü — medya bu hash'e DAHİL DEĞİL */
  contentHash: string;

  /** Kurtarma için ham item */
  raw: unknown;
}

export interface ParseResult {
  items: ParsedItem[];
  /** Parse edilemeyen item'lar — dead letter kuyruğuna gider */
  errors: Array<{ index: number; haberKodu: string | null; message: string; raw: unknown }>;
  channelTitle: string | null;
  totalSeen: number;
}
