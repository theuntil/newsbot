import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "./config/env.js";
import { log } from "./lib/logger.js";
import { sleep } from "./lib/rate-limit.js";
import { fingerprint } from "./lib/text.js";
import { isCritical, errorCode, BotError } from "./lib/errors.js";
import type { Db, BotSettings, RunStatus } from "./db/client.js";
import type { FeedFetcher } from "./fetch/feed-fetcher.js";
import { parseIhaFeed } from "./parser/iha-parser.js";
import type { IngestPipeline } from "./ingest/pipeline.js";
import type { MediaWorker } from "./media/media-worker.js";
import { StorageCleaner } from "./media/storage-cleaner.js";
import type { Alerter } from "./alerts/alerter.js";

/**
 * Kiralama süresi (saniye).
 *
 * Bu süre boyunca kiralama bu instance'ındır; her turda yenilenir.
 * Instance çökerse süre dolar ve başka bir instance devralır.
 * Poll aralığının en az 2 katı olmalı.
 */
const LEASE_TTL_SEC = 900;

export interface OrchestratorDeps {
  db: Db;
  sb: SupabaseClient;
  fetcher: FeedFetcher;
  ingest: IngestPipeline;
  media: MediaWorker;
  alerter: Alerter;
}

export class Orchestrator {
  private stopping = false;
  private currentRun: number | null = null;
  private lockHeld = false;
  private consecutiveFailures = 0;
  private lastSuccessAt: number | null = null;
  private tickCount = 0;

  /** Medya döngüsü feed turundan bağımsız; durumu burada tutulur */
  private settings: BotSettings | null = null;
  private mediaActive = false;
  private mediaDoneTotal = 0;
  private mediaFailedTotal = 0;
  /** Hata sonrası yavaşlama çarpanı. Bot ASLA durmaz, sadece yavaşlar. */
  private slowdownFactor = 1;
  /** "Başka bot çalışıyor" uyarısı bir kez verilsin */
  private leaseWarned = false;

  private readonly cleaner: StorageCleaner;

  constructor(private deps: OrchestratorDeps) {
    this.cleaner = new StorageCleaner(deps.sb);
  }

  // ---- Sağlık durumu (healthcheck endpoint'i okur) -----------
  get health() {
    const staleMs = this.lastSuccessAt ? Date.now() - this.lastSuccessAt : null;
    return {
      ok: !this.stopping && (staleMs === null || staleMs < 15 * 60_000),
      stopping: this.stopping,
      lockHeld: this.lockHeld,
      ticks: this.tickCount,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      minutesSinceSuccess: staleMs ? Math.round(staleMs / 60_000) : null,
    };
  }

  /**
   * Kiralamayı al veya yenile.
   *
   * ÖNCEKİ SÜRÜM pg_try_advisory_lock kullanıyordu ve ÇALIŞMIYORDU:
   * advisory lock OTURUM bazlıdır, Supabase'in PostgREST katmanı
   * ise bağlantı havuzu kullanır. Kilit havuzdaki rastgele bir
   * bağlantıda kalıyor, ikinci instance'ı engelleyemiyordu.
   *
   * Canlıda sonucu şuydu: iki bot aynı IHA hesabıyla istek attı,
   * sağlayıcı "iki istek arası en az 30 saniye" hatası verdi.
   *
   * Tablo tabanlı kiralama bu sorunu çözer: kiralama satırda
   * durur, bağlantıdan bağımsızdır.
   */
  private async acquireLease(): Promise<boolean> {
    const { data, error } = await this.deps.sb.rpc("bot_acquire_lease", {
      p_instance: env.instanceId,
      p_ttl_sec: LEASE_TTL_SEC,
    });

    if (error) {
      // Fonksiyon yoksa (yama uygulanmamış) kilitsiz devam et
      log.debug("Kiralama alınamadı, kilitsiz devam", { error: error.message });
      return true;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row?.sahip === true) return true;

    if (!this.leaseWarned) {
      this.leaseWarned = true;
      log.warn("═══ BAŞKA BİR BOT ÇALIŞIYOR ═══", {
        tutan: row?.tutan,
        kalanSn: row?.kalan_sn,
        bu: env.instanceId,
      });
      log.warn("Bu instance BEKLEMEDE. Aynı IHA hesabıyla iki bot");
      log.warn("çalışırsa sağlayıcı hız sınırı hatası verir.");
    }
    return false;
  }

  private async releaseLease(): Promise<void> {
    if (!this.lockHeld) return;
    try {
      await this.deps.sb.rpc("bot_release_lease", { p_instance: env.instanceId });
    } catch { /* kiralama zaten süre dolunca serbest kalır */ }
    this.lockHeld = false;
  }

  /** Ana döngü — feed ve medya PARALEL çalışır */
  async start(signal: AbortSignal): Promise<void> {
    log.info("Bot başlatılıyor", { instance: env.instanceId });

    // Feed ve medya ayrı döngülerde.
    //
    // NEDEN: Aynı turda yapılırsa medya, feed'in hızına mahkûm olur.
    // Canlıda görüldü: 1426 medya kuyrukta, turda 12 işleniyor,
    // 60 sn aralıkla ~2 saat sürer. Medya kendi hızında akmalı.
    await Promise.all([
      this.feedLoop(signal),
      this.mediaLoop(signal),
    ]);

    await this.releaseLease();
    log.info("Ana döngü sonlandı", { ticks: this.tickCount });
  }

  /** Feed döngüsü — haberleri çeker ve yazar. ASLA kırılmaz. */
  private async feedLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopping) {
      const tickStart = Date.now();
      let intervalSec = 60;

      try {
        intervalSec = await this.tick(signal);
      } catch (err) {
        log.error("Tur beklenmeyen hata ile bitti (döngü devam ediyor)", { err });
        this.consecutiveFailures++;
        // Bildirim/yavaşlama da patlarsa döngü yine durmasın
        try { await this.onFailure(err); } catch (e2) {
          log.error("Hata işleyicisi de patladı", { err: e2 });
        }
      }

      if (signal.aborted || this.stopping) break;

      const elapsed = Date.now() - tickStart;
      // Yavaşlama çarpanı: hata varsa aralık açılır ama bot DURMAZ
      const target = intervalSec * 1000 * this.slowdownFactor;
      const wait = Math.max(1000, target - elapsed);
      await this.interruptibleSleep(wait, signal);
    }
  }

  /**
   * Medya döngüsü — biriken medyayı sürekli işler.
   *
   * Kuyruk doluyken kısa aralıkla, boşken uzun aralıkla döner.
   * Böylece 1400 medyalık ilk yükleme saatlerce beklemez ama
   * boştayken de sunucuyu meşgul etmez.
   */
  private async mediaLoop(signal: AbortSignal): Promise<void> {
    // Feed'in ilk turu haberleri yazsın diye biraz bekle
    await this.interruptibleSleep(5000, signal);

    while (!signal.aborted && !this.stopping) {
      let idle = true;

      try {
        const s = this.settings;

        if (s?.is_enabled && s.media_enabled && !this.isPaused(s)) {
          // Parti boyutu eşzamanlılığın 8 katı — worker'lar aç kalmasın
          const batch = Math.min(120, Math.max(12, s.media_concurrency * 8));
          const jobs = await this.deps.media.claimJobs(batch);

          if (jobs.length > 0) {
            idle = false;
            this.mediaActive = true;
            const m = await this.deps.media.runBatch(jobs, s, this.currentRun, signal);
            this.mediaActive = false;

            this.mediaDoneTotal += m.ready;
            this.mediaFailedTotal += m.failed;
          }

          /**
           * Silinen haberlerin R2 dosyalarını temizle.
           *
           * Feed turunda değil BURADA: feed 5 dakikada bir çalışır,
           * bu döngü 2-20 saniyede bir. Silme neredeyse anlık olur.
           */
          const c = await this.cleaner.run(50, signal);
          if (c.claimed > 0) idle = false;
        }
      } catch (err) {
        this.mediaActive = false;
        log.error("Medya döngüsü hatası", { err });
        idle = true;
      }

      if (signal.aborted || this.stopping) break;
      // Doluyken 2 sn, boşken 20 sn
      await this.interruptibleSleep(idle ? 20_000 : 2000, signal);
    }
  }

  private isPaused(s: BotSettings): boolean {
    return !!s.paused_until && new Date(s.paused_until).getTime() > Date.now();
  }

  /** Kapanma sinyalinde uykuyu anında böl — deploy 60 sn beklemesin */
  private async interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
    const step = 500;
    let waited = 0;
    while (waited < ms && !signal.aborted && !this.stopping) {
      await sleep(Math.min(step, ms - waited));
      waited += step;
    }
  }

  /**
   * Tek tur.
   *
   * Sıra önemli: önce feed (yeni haberler), sonra medya (birikenler).
   * Medya işi uzun sürerse bir sonraki feed turu gecikir ama haber
   * kaybı olmaz — feed 50 haberi hâlâ içerir.
   */
  private async tick(signal: AbortSignal): Promise<number> {
    this.tickCount++;

    // --- 1) Tek instance garantisi ---------------------------
    // HER TURDA yenilenir: bu instance çökerse kiralama süresi
    // dolar ve yedek instance devralabilir.
    this.lockHeld = await this.acquireLease();
    if (!this.lockHeld) return 60;
    this.leaseWarned = false;

    // --- 2) Çalışma izni + güncel ayarlar --------------------
    const begin = await this.deps.db.beginRun();
    const settings = begin.settings;
    const interval = settings?.poll_interval_sec ?? 60;

    // Medya döngüsü güncel ayarları buradan okur (panelden değişiklik
    // anında yansısın; ayrıca bot kapatılırsa medya da dursun)
    if (settings) this.settings = settings;

    if (!begin.allowed || begin.run_id === null) {
      // Bot kapalı/duraklatılmış durumu GÖRÜNÜR olmalı. Debug'da
      // saklarsak kullanıcı "bot dondu mu?" diye düşünür.
      const reason = begin.reason ?? "bilinmiyor";

      if (reason === "bot_disabled") {
        // İlk turda ve her 10 turda bir hatırlat
        if (this.tickCount === 1 || this.tickCount % 10 === 0) {
          log.info("Bot KAPALI — açmak için Supabase'de çalıştır: " +
            "update public.bot_settings set is_enabled = true where id;");
        }
      } else if (reason.startsWith("paused_until:")) {
        if (this.tickCount % 5 === 0 || this.tickCount === 1) {
          log.warn("Bot duraklatıldı (devre kesici)", {
            until: reason.slice("paused_until:".length),
            pauseReason: settings?.pause_reason ?? null,
          });
        }
      } else if (reason === "too_soon") {
        log.debug("Aralık dolmadı, bekleniyor");
      } else {
        log.info("Tur çalıştırılmadı", { reason });
      }

      return reason === "bot_disabled" ? 60 : Math.max(15, interval);
    }

    const runId = begin.run_id;
    this.currentRun = runId;

    // Watchdog'un kuyruğa attığı uyarıları gönder (SMTP'ye erişimi yok)
    void this.deps.alerter.flushPending();

    let status: RunStatus = "success";
    let errorMsg: string | null = null;
    const stats = {
      seen: 0, created: 0, updated: 0, skipped: 0, failed: 0,
      mediaQueued: 0, mediaDone: 0, mediaFailed: 0,
    };

    try {
      // --- 3) Feed çek ---------------------------------------
      const feed = await this.deps.fetcher.fetch({
        timeoutSec: settings.request_timeout_sec,
        maxRetries: settings.feed_max_retries,
        userAgent: settings.feed_user_agent,
        signal,
      });

      // --- 4) Ayrıştır ---------------------------------------
      const parsed = parseIhaFeed(feed.xml);

      // Feed boş dönerse bu bir ARIZA sinyalidir — normalde
      // her zaman ~50 haber olur. Sessizce geçme.
      if (parsed.items.length === 0 && parsed.errors.length === 0) {
        throw new BotError("Feed hiç haber içermiyor", {
          kind: "feed_parse", retryable: true, code: "NO_ITEMS",
        });
      }

      // --- 5) Haberleri yaz ----------------------------------
      const ing = await this.deps.ingest.run(parsed, settings, runId, signal);
      Object.assign(stats, {
        seen: ing.seen, created: ing.created, updated: ing.updated,
        skipped: ing.skipped, failed: ing.failed, mediaQueued: ing.mediaQueued,
      });

      if (ing.failed > 0 || ing.parseErrors > 0) status = "partial";

      // Medya artık mediaLoop'ta işleniyor (paralel).
      // Turda ne kadar ilerlediğini rapora yaz.
      stats.mediaDone = this.mediaDoneTotal;
      stats.mediaFailed = this.mediaFailedTotal;
      this.mediaDoneTotal = 0;
      this.mediaFailedTotal = 0;

      // --- 7) Medyası eksik haberleri yeniden planla ---------
      await this.rescheduleStaleMedia(settings);

      // --- 8a) Yetim dosya taraması (günde bir) --------------
      this.cleaner.sweepOrphans(signal).catch((err) =>
        log.warn("Yetim taraması atlandı", { err }));

      // --- 8b) Kalıcı silme hatası varsa haber ver ----------
      const failedDel = await this.cleaner.failedCount().catch(() => 0);
      if (failedDel > 0) {
        await this.deps.alerter.warning(
          "storage-deletion-failed",
          `${failedDel} dosya silinemedi`,
          {
            "Başarısız": failedDel,
            "Ne yapmalı": "Panelden retry_failed_deletions() çalıştırın",
          },
        );
      }

      // --- 8) Çökme sonrası takılı kalmış medyayı kurtar -----
      // Container çökerse satırlar 'downloading' durumunda kalır
      // ve bir daha işlenmezdi. Bu onları kuyruğa geri alır.
      await this.deps.media.recoverStuck(30).catch(() => {});


      // --- Başarı ---------------------------------------------
      const wasFailing = this.consecutiveFailures > 0;
      this.consecutiveFailures = 0;
      this.slowdownFactor = 1;      // toparlandı, normal hıza dön
      this.lastSuccessAt = Date.now();

      if (wasFailing && settings.alert_on_recovery) {
        await this.deps.alerter.info("bot-recovered", "Bot normale döndü", {
          "Tur": runId, "Yeni haber": stats.created, "Güncellenen": stats.updated,
        });
      }
    } catch (err) {
      status = "failed";
      errorMsg = err instanceof Error ? err.message : String(err);
      this.consecutiveFailures++;
      log.error("Tur başarısız", { runId, err });
      await this.onFailure(err, settings);
    } finally {
      await this.deps.db.finishRun(runId, status, { ...stats, error: errorMsg });
      this.currentRun = null;
    }

    return interval;
  }

  /**
   * Medyası hâlâ gelmemiş haberleri kontrol et.
   *
   * NUMARA: Feed zaten tüm haberleri her turda içeriyor, yani
   * "fotoğraf yüklendi mi" sorusunu ayrı istek atmadan öğreniyoruz.
   * Bu, retry maliyetini sıfıra indiriyor — 30 sn limitini yemiyor.
   */
  /**
   * Medyası hâlâ gelmemiş haberleri kontrol et.
   *
   * KRİTİK DÜZELTME: Önceden her turda `scheduleMediaRetry` çağrılıyor
   * ve `attempts` artıyordu — medya worker'ı kuyruğu işlerken bile.
   * 7 tur sonra haber "medyasız" damgası yiyordu, oysa medyası
   * sadece sırada bekliyordu. İlk kurulumda 1400 medya kuyruktayken
   * tam olarak bu oluyordu.
   *
   * Artık sayaç SADECE gerçekten indirilebilir medya yoksa artar.
   * Kuyrukta bekleyen (pending/downloading/processing) satır varsa
   * haber "bekliyor" sayılır, sayaç ilerlemez.
   */
  private async rescheduleStaleMedia(settings: BotSettings): Promise<void> {
    try {
      const pending = await this.deps.db.pendingMedia(100);
      if (pending.length === 0) return;

      const ids = pending.map((a) => a.id);
      // Bu haberlerin medya satırları hangi durumda?
      const busy = await this.deps.db.articlesWithBusyMedia(ids);

      let advanced = 0, waiting = 0;
      for (const a of pending) {
        if (busy.has(a.id)) {
          // Medyası kuyrukta/işlemde → sayacı ARTIRMA, sadece
          // bir sonraki kontrolü ötele.
          await this.deps.db.touchMediaCheck(a.id, 5);
          waiting++;
          continue;
        }
        // Gerçekten indirilebilir medya yok → backoff ilerlet
        await this.deps.db.scheduleMediaRetry(a.id);
        advanced++;
      }

      if (advanced || waiting) {
        log.debug("Medya kontrolü", { backoffIlerledi: advanced, kuyruktaBekliyor: waiting });
      }
    } catch (err) {
      log.warn("Medya yeniden planlama başarısız", { err });
    }
  }

  /**
   * Hata sonrası: YAVAŞLA, ASLA DURMA.
   *
   * TASARIM DEĞİŞİKLİĞİ: Önceden devre kesici botu `paused_until`
   * ile durduruyordu. Artık durdurmuyor — sadece tur aralığını
   * geçici olarak açıyor. Bot sonsuza kadar denemeye devam eder.
   *
   * Gerekçe: haber botu sürekli çalışmalı. Kritik hatada bile
   * (şifre değişti, abonelik bitti) durursak, sorun düzeldiğinde
   * kimse elle başlatmazsa saatlerce haber kaçar. Bunun yerine
   * yavaşlayıp mail atıyoruz; sorun düzelince kendi kendine toparlar.
   */
  private async onFailure(err: unknown, settings?: BotSettings): Promise<void> {
    const critical = isCritical(err);
    const message = err instanceof Error ? err.message : String(err);
    const threshold = settings?.alert_min_consecutive ?? 3;

    // Ardışık hataya göre yavaşlama: 1x, 2x, 4x... tavan 10x
    this.slowdownFactor = Math.min(10, 2 ** Math.max(0, this.consecutiveFailures - 2));

    if (critical) {
      await this.deps.alerter.critical(
        `critical-${errorCode(err) ?? "unknown"}`,
        "Bot kritik hata alıyor — müdahale gerekli (bot çalışmaya devam ediyor)",
        {
          "Hata kodu": errorCode(err) ?? "-",
          "Ardışık hata": this.consecutiveFailures,
          "Yavaşlama": `${this.slowdownFactor}x`,
          "Instance": env.instanceId,
        },
        err,
      );
      // Kimlik hatasında sunucuyu yormamak için en yavaş moda geç,
      // ama DURMA — şifre düzelince kendiliğinden toparlasın.
      this.slowdownFactor = 10;
      return;
    }

    if (this.consecutiveFailures >= threshold) {
      await this.deps.alerter.warning(
        fingerprint("run-failure", errorCode(err) ?? message.slice(0, 80)),
        `Bot ${this.consecutiveFailures} turdur başarısız (çalışmaya devam ediyor)`,
        {
          "Ardışık hata": this.consecutiveFailures,
          "Son hata": message.slice(0, 200),
          "Yavaşlama": `${this.slowdownFactor}x`,
          "Instance": env.instanceId,
        },
        err,
      );
    }

    if (this.slowdownFactor > 1) {
      log.warn("Hata sonrası yavaşlama", {
        ardisikHata: this.consecutiveFailures,
        carpan: this.slowdownFactor,
      });
    }
  }

  /** Kapanma: mevcut turun ve medya işinin bitmesini bekle */
  async shutdown(graceMs = 30_000): Promise<void> {
    log.info("Kapanma başladı", {
      currentRun: this.currentRun, mediaActive: this.mediaActive,
    });
    this.stopping = true;

    const deadline = Date.now() + graceMs;
    // Yarım kalan transcode veya yarım yüklenmiş R2 dosyası bırakma
    while ((this.currentRun !== null || this.mediaActive) && Date.now() < deadline) {
      await sleep(250);
    }

    if (this.currentRun !== null) {
      log.warn("Tur zamanında bitmedi, zorla kapanıyor", { runId: this.currentRun });
      await this.deps.db.finishRun(this.currentRun, "failed", {
        error: "Kapanma sırasında yarıda kesildi",
      }).catch(() => {});
    }

    await this.releaseLease();
    log.info("Kapanma tamamlandı");
  }
}
