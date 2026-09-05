import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import { log } from "../lib/logger.js";
import { BotError } from "../lib/errors.js";

/**
 * service_role istemcisi — RLS'i BYPASS eder.
 * Bu istemci asla tarayıcıya gitmez, sadece bot container'ında yaşar.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(env.supabase.url, env.supabase.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-bot-instance": env.instanceId } },
    db: { schema: "public" },
  });
}

// ---- DB tipleri (SQL şemasıyla birebir) ----------------------

export type MediaState =
  | "pending" | "retrying" | "partial" | "complete" | "no_media" | "failed";

export type MediaStatus =
  | "pending" | "downloading" | "processing" | "ready" | "failed" | "skipped";

export type RunStatus = "running" | "success" | "partial" | "failed" | "skipped";

export type FailureKindDb =
  | "feed_fetch" | "feed_parse" | "item_parse" | "item_ingest"
  | "media_fetch" | "media_process" | "media_upload" | "unknown";

export type AlertSeverity = "info" | "warning" | "critical";

/** bot_settings — panelden yönetilen çalışma zamanı ayarları */
export interface BotSettings {
  is_enabled: boolean;
  paused_until: string | null;
  pause_reason: string | null;

  poll_interval_sec: number;
  request_timeout_sec: number;
  feed_max_retries: number;
  feed_retry_backoff_ms: number;
  feed_user_agent: string;

  ingest_enabled: boolean;
  max_items_per_run: number;
  backfill_lookback_min: number;

  media_enabled: boolean;
  media_concurrency: number;
  media_max_attempts: number;
  media_rate_per_sec: number;
  media_download_timeout_sec: number;

  image_enabled: boolean;
  image_format: string;
  image_quality: number;
  image_fallback_webp: boolean;
  image_variants: Array<{ name: string; w: number }>;
  image_max_bytes: number;
  image_blurhash: boolean;

  video_enabled: boolean;
  video_concurrency: number;
  video_max_height: number;
  video_crf_short: number;
  video_crf_long: number;
  video_preset: string;
  video_audio_kbps: number;
  video_threads: number;
  video_short_max_sec: number;
  video_skip_over_sec: number;
  video_max_bytes: number;

  alerts_enabled: boolean;
  alert_email: string | null;
  alert_min_consecutive: number;
  alert_cooldown_min: number;
  alert_on_recovery: boolean;
  alert_critical_bypass: boolean;
  alert_daily_cap: number;

  watchdog_enabled: boolean;
  watchdog_stale_min: number;

  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_errors: number;
  total_runs: number;
  total_articles: number;
}

export interface BeginRunResult {
  run_id: number | null;
  allowed: boolean;
  reason: string | null;
  settings: BotSettings;
}

export interface IngestResult {
  article_id: string;
  was_created: boolean;
  was_updated: boolean;
}

export interface ArticleRow {
  id: string;
  haber_kodu: string | null;
  slug: string;
  title: string;
  media_state: MediaState;
  media_attempts: number;
  media_next_try: string | null;
  is_manually_edited: boolean;
  content_hash: string | null;
  published_at: string | null;
}

/** RPC hatasını anlamlı BotError'a çevirir */
function rpcError(fn: string, error: unknown): BotError {
  const e = error as { message?: string; code?: string; details?: string; hint?: string };
  const msg = e?.message ?? String(error);

  // Postgres bağlantı/kaynak hataları geçici; kısıt ihlalleri kalıcı
  const transient = /timeout|connection|ECONN|fetch failed|503|502|too many/i.test(msg);
  const constraint = e?.code?.startsWith("23") ?? false;

  return new BotError(`RPC ${fn}: ${msg}`, {
    kind: "item_ingest",
    retryable: transient && !constraint,
    code: e?.code ?? null,
    cause: error,
    context: { fn, details: e?.details, hint: e?.hint },
  });
}

/**
 * Bot ↔ Supabase arasındaki TEK arayüz.
 * Ham tablo yazımı yok — her şey RPC üzerinden, çünkü iş kuralları
 * (is_manually_edited koruması, content_hash atlama, backoff)
 * DB tarafında yaşıyor ve bot onları atlayamamalı.
 */
export class Db {
  constructor(private sb: SupabaseClient = createServiceClient()) {}

  /** Tur başlat. allowed=false ise bot çalışmamalı. */
  async beginRun(): Promise<BeginRunResult> {
    const { data, error } = await this.sb.rpc("bot_begin_run");
    if (error) throw rpcError("bot_begin_run", error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new BotError("bot_begin_run boş döndü", { kind: "unknown", retryable: true });
    return row as BeginRunResult;
  }

  async finishRun(runId: number, status: RunStatus, stats: {
    seen?: number; created?: number; updated?: number; skipped?: number; failed?: number;
    mediaQueued?: number; mediaDone?: number; mediaFailed?: number;
    error?: string | null; meta?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.sb.rpc("bot_finish_run", {
      p_run_id: runId,
      p_status: status,
      p_seen: stats.seen ?? 0,
      p_created: stats.created ?? 0,
      p_updated: stats.updated ?? 0,
      p_skipped: stats.skipped ?? 0,
      p_failed: stats.failed ?? 0,
      p_media_queued: stats.mediaQueued ?? 0,
      p_media_done: stats.mediaDone ?? 0,
      p_media_failed: stats.mediaFailed ?? 0,
      p_error: stats.error ?? null,
      p_meta: stats.meta ?? {},
    });
    // Tur kapanışı başarısız olsa bile botu çökertme — sadece logla,
    // watchdog zaten "başarılı tur yok" diye alarm verecek
    if (error) log.error("bot_finish_run başarısız", { runId, error });
  }

  async tripBreaker(minutes: number, reason: string): Promise<string | null> {
    const { data, error } = await this.sb.rpc("bot_trip_breaker", {
      p_minutes: minutes, p_reason: reason,
    });
    if (error) { log.error("bot_trip_breaker başarısız", { error }); return null; }
    return data as string | null;
  }

  /** Haber ekle/güncelle. is_manually_edited ve content_hash mantığı DB'de. */
  async ingestArticle(a: {
    haberKodu: string;
    title: string;
    summary: string | null;
    body: unknown;
    bodyText: string;
    kategori: string | null;
    ustKategori: string | null;
    sehir: string | null;
    sonDakika: boolean;
    publishedAt: string | null;
    updatedAt: string | null;
    contentHash: string;
    raw: unknown;
  }): Promise<IngestResult> {
    const { data, error } = await this.sb.rpc("ingest_iha_article", {
      p_haber_kodu: a.haberKodu,
      p_title: a.title,
      p_summary: a.summary,
      p_body: a.body,
      p_body_text: a.bodyText,
      p_kategori: a.kategori,
      p_ust_kategori: a.ustKategori,
      p_sehir: a.sehir,
      p_son_dakika: a.sonDakika,
      p_source_pub: a.publishedAt,
      p_source_upd: a.updatedAt,
      p_content_hash: a.contentHash,
      p_raw: a.raw,
    });
    if (error) throw rpcError("ingest_iha_article", error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new BotError("ingest boş döndü", { kind: "item_ingest", retryable: true });
    return row as IngestResult;
  }

  /**
   * Feed'deki hangi haber kodları DB'de YOK?
   * "Haber atlamama" garantisinin 2. katmanı: watermark kaçırsa
   * bile bu sorgu eksiği yakalar. 50 kayıtlık IN sorgusu, maliyetsiz.
   */
  async findMissingCodes(codes: string[]): Promise<Set<string>> {
    if (codes.length === 0) return new Set();

    const found = new Set<string>();
    // Postgrest URL uzunluk sınırı — parçalara böl
    const CHUNK = 100;
    for (let i = 0; i < codes.length; i += CHUNK) {
      const slice = codes.slice(i, i + CHUNK);
      const { data, error } = await this.sb
        .from("articles").select("haber_kodu").in("haber_kodu", slice);
      if (error) throw rpcError("findMissingCodes", error);
      for (const r of data ?? []) if (r.haber_kodu) found.add(r.haber_kodu);
    }
    return new Set(codes.filter((c) => !found.has(c)));
  }

  /** Var olan haberlerin content_hash'i — gereksiz RPC çağrısını önler */
  async getExistingHashes(codes: string[]): Promise<Map<string, {
    hash: string | null; manuallyEdited: boolean; id: string;
  }>> {
    const out = new Map<string, { hash: string | null; manuallyEdited: boolean; id: string }>();
    if (codes.length === 0) return out;

    const CHUNK = 100;
    for (let i = 0; i < codes.length; i += CHUNK) {
      const slice = codes.slice(i, i + CHUNK);
      const { data, error } = await this.sb
        .from("articles")
        .select("id, haber_kodu, content_hash, is_manually_edited")
        .in("haber_kodu", slice);
      if (error) throw rpcError("getExistingHashes", error);
      for (const r of data ?? []) {
        if (r.haber_kodu) {
          out.set(r.haber_kodu, {
            hash: r.content_hash, manuallyEdited: r.is_manually_edited, id: r.id,
          });
        }
      }
    }
    return out;
  }

  /** Medya kayıtlarını ekle (varsa dokunma) */
  async upsertMedia(rows: Array<{
    article_id: string;
    external_key: string;
    type: "image" | "video";
    source_url: string;
    source_bytes: number;
    caption: string | null;
    sort_order: number;
    duration_sec: number | null;
    poster_source_url: string | null;
  }>): Promise<number> {
    if (rows.length === 0) return 0;
    const { data, error } = await this.sb
      .from("media")
      .upsert(rows, { onConflict: "article_id,external_key", ignoreDuplicates: true })
      .select("id");
    if (error) throw rpcError("upsertMedia", error);
    return data?.length ?? 0;
  }

  /** Medyası eksik haberler — retry worker bunu tarar */
  async pendingMedia(limit: number): Promise<ArticleRow[]> {
    const { data, error } = await this.sb.rpc("bot_pending_media", { p_limit: limit });
    if (error) throw rpcError("bot_pending_media", error);
    return (data ?? []) as ArticleRow[];
  }

  async scheduleMediaRetry(articleId: string): Promise<string | null> {
    const { data, error } = await this.sb.rpc("schedule_media_retry", {
      p_article_id: articleId,
    });
    if (error) throw rpcError("schedule_media_retry", error);
    return data as string | null;
  }

  /** Dead letter — dedup'lu, sonsuz retry yok */
  async logFailure(f: {
    kind: FailureKindDb;
    fingerprint: string;
    error: string;
    runId?: number | null;
    haberKodu?: string | null;
    articleId?: string | null;
    mediaId?: string | null;
    targetUrl?: string | null;
    errorCode?: string | null;
    stack?: string | null;
    raw?: unknown;
    maxAttempts?: number;
    backoffSec?: number;
  }): Promise<{ failure_id: number; attempts: number; exhausted: boolean } | null> {
    const { data, error } = await this.sb.rpc("bot_log_failure", {
      p_kind: f.kind,
      p_fingerprint: f.fingerprint,
      p_error: f.error,
      p_run_id: f.runId ?? null,
      p_haber_kodu: f.haberKodu ?? null,
      p_article_id: f.articleId ?? null,
      p_media_id: f.mediaId ?? null,
      p_target_url: f.targetUrl ?? null,
      p_error_code: f.errorCode ?? null,
      p_stack: f.stack ?? null,
      p_raw: f.raw ?? null,
      p_max_attempts: f.maxAttempts ?? 5,
      p_backoff_sec: f.backoffSec ?? 300,
    });
    if (error) { log.error("bot_log_failure başarısız", { error }); return null; }
    const row = Array.isArray(data) ? data[0] : data;
    return row ?? null;
  }

  async resolveFailure(fingerprint: string): Promise<void> {
    const { error } = await this.sb.rpc("bot_resolve_failure", { p_fingerprint: fingerprint });
    if (error) log.warn("bot_resolve_failure başarısız", { error });
  }

  /** Mail gönderilmeli mi? Tüm bastırma mantığı DB'de. */
  async shouldAlert(fingerprint: string, severity: AlertSeverity): Promise<{
    should_send: boolean; reason: string; to_email: string | null; suppressed: number;
  }> {
    const { data, error } = await this.sb.rpc("bot_should_alert", {
      p_fingerprint: fingerprint, p_severity: severity,
    });
    if (error) {
      log.error("bot_should_alert başarısız", { error });
      return { should_send: false, reason: "rpc_error", to_email: null, suppressed: 0 };
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row ?? { should_send: false, reason: "empty", to_email: null, suppressed: 0 };
  }

  async recordAlert(a: {
    fingerprint: string; subject: string; body: string;
    severity: AlertSeverity; to: string | null;
    delivered: boolean; smtpError?: string | null;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.sb.rpc("bot_record_alert", {
      p_fingerprint: a.fingerprint,
      p_subject: a.subject,
      p_body: a.body,
      p_severity: a.severity,
      p_to: a.to,
      p_delivered: a.delivered,
      p_smtp_error: a.smtpError ?? null,
      p_meta: a.meta ?? {},
    });
    if (error) log.error("bot_record_alert başarısız", { error });
  }

  /**
   * Bu haberlerden hangilerinin medyası HÂLÂ İŞLENİYOR?
   * (kuyrukta bekleyen veya indirilmekte olan satırı olanlar)
   *
   * Bu ayrım olmadan, kuyruk yoğun olduğu için bekleyen haberler
   * yanlışlıkla "medyasız" işaretleniyordu.
   */
  async articlesWithBusyMedia(articleIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (articleIds.length === 0) return out;

    const CHUNK = 100;
    for (let i = 0; i < articleIds.length; i += CHUNK) {
      const slice = articleIds.slice(i, i + CHUNK);
      const { data, error } = await this.sb
        .from("media")
        .select("article_id")
        .in("article_id", slice)
        .in("status", ["pending", "downloading", "processing"]);
      if (error) { log.warn("Meşgul medya sorgusu başarısız", { error }); continue; }
      for (const r of data ?? []) if (r.article_id) out.add(r.article_id);
    }
    return out;
  }

  /** Sayacı ARTIRMADAN bir sonraki kontrolü ötele */
  async touchMediaCheck(articleId: string, minutes: number): Promise<void> {
    const { error } = await this.sb
      .from("articles")
      .update({ media_next_try: new Date(Date.now() + minutes * 60_000).toISOString() })
      .eq("id", articleId);
    if (error) log.warn("Medya kontrolü ötelenemedi", { articleId, error });
  }

  /** Bağlantı testi — açılışta çağrılır */
  async ping(): Promise<boolean> {
    const { error } = await this.sb.from("bot_settings").select("is_enabled").limit(1);
    if (error) { log.error("Supabase ping başarısız", { error }); return false; }
    return true;
  }

  /**
   * Watchdog'un yazdığı ama gönderilememiş uyarılar.
   *
   * Watchdog Supabase içinde çalışıyor ve SMTP'ye erişemiyor;
   * sadece alert_log'a delivered=false satır yazıyor. Bot ayağa
   * kalkınca bunları görüp gerçekten mail atıyor.
   */
  async undeliveredAlerts(limit = 10): Promise<Array<{
    id: number; severity: AlertSeverity; fingerprint: string;
    subject: string; body: string | null; sent_to: string | null;
  }>> {
    const { data, error } = await this.sb.rpc("bot_undelivered_alerts", { p_limit: limit });
    if (error) { log.warn("Bekleyen uyarılar okunamadı", { error }); return []; }
    return (data ?? []) as never;
  }

  async markAlertDelivered(id: number, delivered: boolean, smtpError?: string): Promise<void> {
    const { error } = await this.sb.from("alert_log")
      .update({ delivered, smtp_error: smtpError ?? null })
      .eq("id", id);
    if (error) log.warn("Uyarı durumu güncellenemedi", { id, error });
  }
}
