import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../lib/logger.js";
import { deleteByPrefix, listKeys } from "./storage.js";
import { mapLimit } from "../lib/rate-limit.js";

export interface CleanupStats {
  claimed: number;
  deleted: number;
  files: number;
  failed: number;
}

/**
 * Depolama temizleyici.
 *
 * Haber silindiğinde R2'deki dosyalar da gitmeli — yoksa yıllar
 * içinde ölü dosya birikir ve depolama faturası sessizce şişer.
 *
 * GECİKMELİ SİLME: kayıtlar `delete_after` süresi dolana kadar
 * beklerler (varsayılan 7 gün). Bu sürede haber geri alınırsa
 * silme iptal edilir. Anında silseydik geri dönüş imkânsız olurdu.
 *
 * Önek altındaki dosyalar LİSTELENEREK silinir, tahmin edilmez:
 * kalite ayarı değişip varyant isimleri farklılaştıysa eski
 * dosyalar da yakalanır.
 */
export class StorageCleaner {
  constructor(private sb: SupabaseClient) {}

  async run(limit = 50, signal?: AbortSignal): Promise<CleanupStats> {
    const stats: CleanupStats = { claimed: 0, deleted: 0, files: 0, failed: 0 };

    const { data, error } = await this.sb.rpc("claim_storage_deletions", {
      p_limit: limit,
    });

    if (error) {
      log.warn("Silme kuyruğu okunamadı", { error });
      return stats;
    }

    const jobs = (data ?? []) as Array<{
      d_id: number; d_storage_key: string;
      d_article_id: string | null; d_reason: string; d_attempts: number;
    }>;

    if (jobs.length === 0) return stats;
    stats.claimed = jobs.length;

    // R2 istekleri hafif; 4 paralel yeterli
    const results = await mapLimit(jobs, 4, async (job) => {
      if (signal?.aborted) throw new Error("İptal edildi");

      try {
        const files = await deleteByPrefix(job.d_storage_key);
        await this.finish(job.d_id, true, files);
        return files;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.finish(job.d_id, false, 0, msg);
        log.warn("Depolama silme başarısız", {
          key: job.d_storage_key, deneme: job.d_attempts, err,
        });
        throw err;
      }
    });

    for (const r of results) {
      if (r.ok) { stats.deleted++; stats.files += r.value; }
      else stats.failed++;
    }

    if (stats.deleted > 0 || stats.failed > 0) {
      log.info("Depolama temizliği", {
        silinen: stats.deleted, dosya: stats.files, hata: stats.failed,
      });
    }
    return stats;
  }

  /**
   * YETİM DOSYA MUTABAKATI (reconciliation).
   *
   * Outbox güvenilirdir ama mutlak değildir: elle DB düzenlemesi,
   * eski bir bug ya da 5 denemeyi tüketmiş bir silme yetim dosya
   * bırakabilir. Bu tarama bucket'ı DB ile karşılaştırır.
   *
   * Günde bir kez çalışır (bot_settings.orphan_sweep_interval_hours).
   * Listeleme R2'de ucuz bir işlemdir (Class B).
   */
  async sweepOrphans(signal?: AbortSignal): Promise<{ scanned: number; orphans: number }> {
    const { data: should } = await this.sb.rpc("should_run_orphan_sweep");
    if (should !== true) return { scanned: 0, orphans: 0 };

    log.info("Yetim dosya taraması başlıyor");
    const started = Date.now();

    // Tüm nesneleri listele, önek düzeyine indir
    // media/YYYY/MM/DD/HABERKODU/MEDYAKODU/dosya.avif → ilk 6 segment
    const all = await listKeys("media/", 50_000);
    const prefixes = new Set<string>();
    for (const k of all) {
      const parts = k.split("/");
      if (parts.length >= 7) prefixes.add(parts.slice(0, 6).join("/"));
    }

    const list = [...prefixes];
    let orphans = 0;

    // DB'ye parçalar halinde sor
    for (let i = 0; i < list.length; i += 200) {
      if (signal?.aborted) break;
      const chunk = list.slice(i, i + 200);

      const { data, error } = await this.sb.rpc("storage_keys_exist", { p_keys: chunk });
      if (error) { log.warn("Yetim sorgusu başarısız", { error }); break; }

      const missing = (data ?? [])
        .filter((r: { exists_in_db: boolean }) => !r.exists_in_db)
        .map((r: { storage_key: string }) => r.storage_key);

      if (missing.length > 0) {
        await this.sb.rpc("enqueue_orphans", { p_keys: missing });
        orphans += missing.length;
      }
    }

    await this.sb.rpc("mark_orphan_sweep_done");

    log.info("Yetim taraması bitti", {
      taranan: list.length, yetim: orphans, ms: Date.now() - started,
    });
    return { scanned: list.length, orphans };
  }

  /** Kalıcı olarak silinemeyenler var mı? */
  async failedCount(): Promise<number> {
    const { data } = await this.sb.rpc("storage_deletion_alarm");
    const row = Array.isArray(data) ? data[0] : data;
    return Number(row?.failed_count ?? 0);
  }

  private async finish(
    id: number, ok: boolean, files: number, error?: string,
  ): Promise<void> {
    const { error: e } = await this.sb.rpc("finish_storage_deletion", {
      p_id: id, p_ok: ok, p_files: files, p_error: error ?? null,
    });
    if (e) log.warn("Silme durumu güncellenemedi", { id, error: e });
  }
}
