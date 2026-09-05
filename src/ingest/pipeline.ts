import type { Db, BotSettings } from "../db/client.js";
import type { ParsedItem, ParseResult } from "../parser/types.js";
import { toIso } from "../lib/dates.js";
import { fingerprint } from "../lib/text.js";
import { log } from "../lib/logger.js";
import { mapLimit } from "../lib/rate-limit.js";
import { redactUrl } from "../config/env.js";

export interface IngestStats {
  seen: number;
  created: number;
  updated: number;
  skipped: number;      // içerik değişmemiş — DB'ye dokunulmadı
  failed: number;
  mediaQueued: number;
  parseErrors: number;
  /** Medyası eksik olup retry bekleyenler */
  mediaPending: number;
  durationMs: number;
}

/**
 * HABER ATLAMAMA GARANTİSİ — üç katman
 *
 *  1. Parser izolasyonu  → bozuk item turu çökertmez (parser'da)
 *  2. Tam tarama         → feed'deki TÜM kodlar DB ile karşılaştırılır.
 *                          Watermark mantığına güvenmiyoruz; IHA geriye
 *                          dönük haber ekleyebiliyor. 50 kayıtlık IN
 *                          sorgusu maliyetsiz, kesin sonuç veriyor.
 *  3. Dead letter        → insert patlarsa ham item saklanır, tekrar
 *                          denenir, tükenirse panelde kırmızı görünür.
 *
 * Ayrıca: içerik hash'i değişmemişse DB'ye HİÇ dokunulmaz.
 * Bu, gereksiz UPDATE ve ISR revalidate maliyetini sıfırlar.
 */
export class IngestPipeline {
  constructor(private db: Db) {}

  async run(
    parsed: ParseResult,
    settings: BotSettings,
    runId: number | null,
    signal?: AbortSignal,
  ): Promise<IngestStats> {
    const started = Date.now();
    const stats: IngestStats = {
      seen: parsed.totalSeen, created: 0, updated: 0, skipped: 0, failed: 0,
      mediaQueued: 0, parseErrors: parsed.errors.length, mediaPending: 0, durationMs: 0,
    };

    // --- Parse hatalarını dead letter'a yaz -------------------
    for (const e of parsed.errors) {
      await this.db.logFailure({
        kind: "item_parse",
        fingerprint: fingerprint("item_parse", e.haberKodu ?? `idx-${e.index}`, e.message),
        error: e.message,
        runId,
        haberKodu: e.haberKodu,
        raw: e.raw,
        maxAttempts: 3,
      });
    }

    if (!settings.ingest_enabled) {
      log.info("Ingest kapalı, haber işlenmedi");
      stats.durationMs = Date.now() - started;
      return stats;
    }

    // Feed sıralaması garanti değil — en yenisi önce işlensin
    const items = [...parsed.items]
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
      .slice(0, settings.max_items_per_run);

    if (items.length === 0) {
      stats.durationMs = Date.now() - started;
      return stats;
    }

    // --- KATMAN 2: mevcut durumu tek sorguda öğren -----------
    const codes = items.map((i) => i.haberKodu);
    const existing = await this.db.getExistingHashes(codes);

    const toProcess: ParsedItem[] = [];
    for (const item of items) {
      const prev = existing.get(item.haberKodu);

      // Editör dokunmuş → metne karışma, ama medya kontrolü sürsün
      if (prev?.manuallyEdited) {
        stats.skipped++;
        if (item.media.length > 0) {
          stats.mediaQueued += await this.syncMedia(prev.id, item, runId);
        }
        continue;
      }

      // İçerik değişmemiş → DB'ye hiç dokunma
      if (prev && prev.hash === item.contentHash) {
        stats.skipped++;
        // ama medyası eksikse yeni foto gelmiş olabilir
        if (item.media.length > 0) {
          stats.mediaQueued += await this.syncMedia(prev.id, item, runId);
        }
        continue;
      }

      toProcess.push(item);
    }

    log.info("Ingest planı", {
      total: items.length,
      willProcess: toProcess.length,
      unchanged: stats.skipped,
      newCodes: items.filter((i) => !existing.has(i.haberKodu)).length,
    });

    // --- Haberleri işle (sınırlı eşzamanlılık) ---------------
    // Canlıda 405 haber 38 sn sürdü (concurrency 4). Bu, 60 sn'lik
    // turun yarısından fazlası. 8'e çıkarmak süreyi yarıya indiriyor;
    // daha yükseği Supabase bağlantı havuzunu zorlar.
    const results = await mapLimit(toProcess, 8, async (item) => {
      if (signal?.aborted) throw new Error("İptal edildi");
      return this.ingestOne(item, runId);
    });

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.ok) {
        if (r.value.created) stats.created++;
        else if (r.value.updated) stats.updated++;
        else stats.skipped++;
        stats.mediaQueued += r.value.mediaQueued;
        if (r.value.mediaPending) stats.mediaPending++;
      } else {
        stats.failed++;
        // Hata zaten ingestOne içinde dead letter'a yazıldı
      }
    }

    stats.durationMs = Date.now() - started;
    log.info("Ingest tamamlandı", stats as unknown as Record<string, unknown>);
    return stats;
  }

  private async ingestOne(item: ParsedItem, runId: number | null): Promise<{
    created: boolean; updated: boolean; mediaQueued: number; mediaPending: boolean;
  }> {
    const fp = fingerprint("item_ingest", item.haberKodu);

    try {
      const res = await this.db.ingestArticle({
        haberKodu: item.haberKodu,
        title: item.title,
        summary: item.summary,
        body: item.body,
        bodyText: item.bodyText,
        kategori: item.kategori,
        // UstKategori önceden DB'ye HİÇ gitmiyordu; kategori
        // eşleştirmesi bunun üzerinden yapılıyor.
        ustKategori: item.ustKategori,
        sehir: item.sehir,
        sonDakika: item.sonDakika,
        publishedAt: toIso(item.publishedAt),
        updatedAt: toIso(item.updatedAt),
        contentHash: item.contentHash,
        raw: item.raw,
      });

      const mediaQueued = await this.syncMedia(res.article_id, item, runId);

      // Feed medya listesi veriyor ama hiçbiri indirilebilir değilse
      // (hepsi filesize=0) → retry planla
      const hasUsable = item.media.some((m) => m.sourceBytes > 0);
      const mediaPending = item.media.length > 0 && !hasUsable;

      if (mediaPending) {
        await this.db.scheduleMediaRetry(res.article_id);
      }

      // Önceki hata varsa kapat
      if (res.was_created || res.was_updated) {
        await this.db.resolveFailure(fp).catch(() => {});
      }

      log.debug("Haber işlendi", {
        haberKodu: item.haberKodu,
        created: res.was_created,
        updated: res.was_updated,
        media: item.media.length,
        mediaUsable: item.media.filter((m) => m.sourceBytes > 0).length,
      });

      return {
        created: res.was_created,
        updated: res.was_updated,
        mediaQueued,
        mediaPending,
      };
    } catch (err) {
      const e = err as Error & { code?: string };
      log.error("Haber işlenemedi", { haberKodu: item.haberKodu, err });

      // KATMAN 3: ham item saklanır → elle kurtarma mümkün
      await this.db.logFailure({
        kind: "item_ingest",
        fingerprint: fp,
        error: e.message,
        runId,
        haberKodu: item.haberKodu,
        errorCode: e.code ?? null,
        stack: e.stack ?? null,
        raw: item.raw,
        maxAttempts: 5,
        backoffSec: 120,
      });

      throw err;
    }
  }

  /**
   * Medya kayıtlarını DB'ye yaz.
   *
   * KRİTİK: filesize=0 olanlar da KAYDEDİLİR ama status='pending' kalır.
   * Kaydetmezsek, fotoğraf 10 dakika sonra yüklendiğinde onu
   * bekleyen bir kayıt olmaz ve haber kalıcı olarak medyasız kalır.
   * Eski botun %70 medyasız kalmasının sebebi tam olarak buydu.
   */
  private async syncMedia(
    articleId: string,
    item: ParsedItem,
    runId: number | null,
  ): Promise<number> {
    if (item.media.length === 0) return 0;

    try {
      const rows = item.media.map((m) => ({
        article_id: articleId,
        external_key: m.externalKey,
        type: m.type,
        source_url: m.url,
        source_bytes: m.sourceBytes,
        caption: m.caption,
        sort_order: m.order,
        duration_sec: m.durationSec,
        // IHA'nın verdiği poster URL'i SAKLANIR. Worker önce bunu
        // indirir; başarısız olursa videodan kendi üretir.
        poster_source_url: m.posterUrl,
      }));

      return await this.db.upsertMedia(rows);
    } catch (err) {
      const e = err as Error;
      log.warn("Medya kaydı başarısız", { haberKodu: item.haberKodu, err });

      await this.db.logFailure({
        kind: "media_fetch",
        fingerprint: fingerprint("media_upsert", item.haberKodu),
        error: e.message,
        runId,
        haberKodu: item.haberKodu,
        articleId,
        targetUrl: item.media[0] ? redactUrl(item.media[0].url) : null,
        maxAttempts: 3,
      });
      return 0;
    }
  }
}
