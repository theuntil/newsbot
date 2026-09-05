import { createHash } from "node:crypto";
import type { BodyBlock } from "../parser/types.js";

/** Kalan HTML etiketlerini temizle (feed bazen <p>, <b> gönderiyor) */
export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

/** Parser'dan kaçan entity'ler için ikinci güvenlik ağı */
const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&apos;": "'", "&nbsp;": " ", "&#39;": "'", "&#34;": '"',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#34);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\u00a0/g, " ")     // non-breaking space
    .replace(/[\t\r]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function cleanText(s: unknown): string {
  if (s == null) return "";
  return normalizeWhitespace(decodeEntities(stripTags(String(s))));
}

/**
 * IHA description yapısı:
 *   - <br/> ile ayrılmış satırlar
 *   - İLK satır = spot (summary)
 *   - Tırnak içindeki kısa satırlar = alt başlık → heading bloğu
 *
 * Örnek: `"Onlar Allah'ın dilsiz emanetleri"` → heading
 */
const QUOTE_CHARS = ['"', "\u201c", "\u201d", "\u00ab", "\u00bb"];

function isHeading(line: string): boolean {
  if (line.length > 120) return false;              // uzunsa paragraftır
  const first = line[0];
  const last = line[line.length - 1];
  if (!first || !last) return false;
  const opens = QUOTE_CHARS.includes(first);
  const closes = QUOTE_CHARS.includes(last);
  if (!(opens && closes)) return false;
  // Cümle sonu noktalaması varsa alıntıdır, başlık değil
  return !/[.!?]$/.test(line.slice(1, -1).trim());
}

function stripQuotes(line: string): string {
  return line.replace(/^["\u201c\u201d\u00ab\u00bb]+|["\u201c\u201d\u00ab\u00bb]+$/g, "").trim();
}

export interface SplitBody {
  summary: string | null;
  blocks: BodyBlock[];
  bodyText: string;
}

export function splitDescription(description: unknown): SplitBody {
  const raw = description == null ? "" : String(description);

  const lines = raw
    .split(/<br\s*\/?>|\r?\n/i)
    .map((l) => cleanText(l))
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { summary: null, blocks: [], bodyText: "" };
  }

  const summary = lines[0];
  const blocks: BodyBlock[] = [];

  for (const line of lines.slice(1)) {
    blocks.push(
      isHeading(line)
        ? { type: "heading", text: stripQuotes(line) }
        : { type: "paragraph", text: line },
    );
  }

  const bodyText = lines.join("\n");
  return { summary, blocks, bodyText };
}

/**
 * İçerik parmak izi.
 *
 * ÖNEMLİ: Medya BİLEREK dahil değil. Medya ayrı yaşam döngüsünde
 * (fotoğraf haberden dakikalar sonra ekleniyor). Medya hash'e girseydi
 * her foto eklenişinde metin UPDATE'i tetiklenir, gereksiz ISR
 * revalidate maliyeti çıkardı.
 */
export function contentHash(parts: {
  title: string;
  summary: string | null;
  bodyText: string;
  kategori: string | null;
  sehir: string | null;
  sonDakika: boolean;
}): string {
  const payload = [
    parts.title,
    parts.summary ?? "",
    parts.bodyText,
    parts.kategori ?? "",
    parts.sehir ?? "",
    parts.sonDakika ? "1" : "0",
  ].join("\u0000");

  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}

/** Dead-letter dedup anahtarı */
export function fingerprint(...parts: (string | null | undefined)[]): string {
  return createHash("sha1")
    .update(parts.filter(Boolean).join("|"), "utf8")
    .digest("hex")
    .slice(0, 24);
}
