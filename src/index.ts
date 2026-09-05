import { createServer } from "node:http";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { env, validateEnv } from "./config/env.js";
import { configureLogger, log } from "./lib/logger.js";
import { Db, createServiceClient } from "./db/client.js";
import { RateLimiter, MemoryStore, RedisStore, type RateLimiterStore } from "./lib/rate-limit.js";
import { FeedFetcher } from "./fetch/feed-fetcher.js";
import { IngestPipeline } from "./ingest/pipeline.js";
import { MediaDownloader } from "./media/downloader.js";
import { MediaWorker } from "./media/media-worker.js";
import { Alerter } from "./alerts/alerter.js";
import { verifyStorage } from "./media/storage.js";
import { checkFfmpeg } from "./media/video-processor.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * Redis'e bağlan. Başarısız olursa bellek moduna düşer.
 *
 * NOT: Bellek modunda hız sınırı SADECE bu process için geçerli.
 * Birden fazla container çalıştıracaksan Redis ŞART, yoksa
 * 30 saniye kuralı container sayısı kadar delinir.
 */
async function createStore(): Promise<{ store: RateLimiterStore; close: () => Promise<void> }> {
  try {
    const { createClient } = await import("redis");
    const client = createClient({
      url: env.redis.url,
      socket: {
        connectTimeout: 5000,
        // Sonsuz yeniden bağlanma YOK. Redis yoksa 3 denemede pes et
        // ve bellek moduna düş; açılış tıkanmasın.
        reconnectStrategy: (retries) => (retries > 3 ? false : Math.min(retries * 300, 1000)),
      },
    });

    // İlk bağlantı hatalarını sessizce yut; başarısızsa zaten catch'e düşecek
    let connected = false;
    client.on("error", (e: Error) => {
      if (connected) log.warn("Redis hatası", { err: e.message });
    });

    await client.connect();
    await client.ping();
    connected = true;

    log.info("Redis bağlandı", { url: env.redis.url.replace(/:[^:@]*@/, ":***@") });
    return {
      store: new RedisStore(client as never),
      close: async () => { await client.quit().catch(() => {}); },
    };
  } catch (err) {
    log.warn("Redis yok — bellek modu (tek instance varsayımı)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { store: new MemoryStore(), close: async () => {} };
  }
}

/**
 * Yetim geçici dosyaları temizle.
 *
 * Container çökerse /tmp'de yarım indirilmiş videolar kalır.
 * Paylaşımlı sunucuda disk dolarsa Supabase de yazamaz hale gelir,
 * bu yüzden açılışta ve saatte bir süpürüyoruz.
 */
async function sweepTmp(maxAgeMs = 2 * 60 * 60 * 1000): Promise<void> {
  try {
    await mkdir(env.tmpDir, { recursive: true });
    const files = await readdir(env.tmpDir);
    const now = Date.now();
    let removed = 0, bytes = 0;

    for (const f of files) {
      const p = join(env.tmpDir, f);
      try {
        const st = await stat(p);
        if (now - st.mtimeMs > maxAgeMs) {
          bytes += st.size;
          await rm(p, { force: true, recursive: true });
          removed++;
        }
      } catch {}
    }
    if (removed > 0) {
      log.info("Yetim geçici dosyalar silindi", { removed, mb: Math.round(bytes / 1e6) });
    }
  } catch (err) {
    log.warn("Geçici dizin temizliği başarısız", { err });
  }
}

async function main(): Promise<void> {
  configureLogger(env.logLevel, env.instanceId, env.logFormat);

  // --- 1) Env doğrulaması — bozuksa BAŞLAMA ------------------
  try {
    validateEnv();
  } catch (err) {
    log.error("Ortam değişkenleri geçersiz", { err });
    process.exit(1);
  }

  log.info("Haber botu başlıyor", {
    instance: env.instanceId, nodeEnv: env.nodeEnv, tmpDir: env.tmpDir,
  });

  await sweepTmp(0); // açılışta hepsini temizle

  // --- 2) Bağımlılıklar --------------------------------------
  const sb = createServiceClient();
  const db = new Db(sb);
  const { store, close: closeStore } = await createStore();
  const limiter = new RateLimiter(store, env.redis.prefix);

  const alerter = new Alerter(db);
  const fetcher = new FeedFetcher(limiter);
  const ingest = new IngestPipeline(db);
  const downloader = new MediaDownloader(limiter);

  // --- 3) Açılış kontrolleri ---------------------------------
  // Yanlış anahtarı ilk haberde değil, ŞİMDİ öğren.
  const [dbOk, r2Ok] = await Promise.all([db.ping(), verifyStorage()]);
  if (!dbOk) { log.error("Supabase erişilemiyor — çıkılıyor"); process.exit(1); }
  if (!r2Ok) log.warn("R2 doğrulanamadı — medya yüklemeleri başarısız olabilir");
  await alerter.verify();

  // ffmpeg: video işleme için şart. Yoksa videolar bekler, ölmez.
  if (await checkFfmpeg()) {
    log.info("ffmpeg hazır — video işleme aktif");
  } else {
    log.warn("═══ ffmpeg YOK — VİDEO İŞLEME ASKIDA ═══");
    log.warn("Videolar 'pending' kalır, kaybolmaz. Fotoğraflar normal işlenir.");
    log.warn("macOS: brew install ffmpeg  |  Ubuntu: sudo apt install ffmpeg");
    log.warn("Docker imajında ffmpeg zaten kurulu — üretimde bu uyarı çıkmaz.");
  }

  // Bot açık mı? Kullanıcı bunu HEMEN görsün, 60 sn beklemesin.
  try {
    const begin = await db.beginRun().catch(() => null);
    const s = begin?.settings;

    if (s && !s.is_enabled) {
      log.warn("═══ BOT KAPALI ═══");
      log.warn("Açmak için Supabase SQL Editor'de:");
      log.warn("  update public.bot_settings set is_enabled = true where id;");
    } else if (s) {
      log.info("Bot AÇIK", {
        aralikSn: s.poll_interval_sec,
        maxHaber: s.max_items_per_run,
        medya: s.media_enabled,
        video: s.video_enabled,
        bildirim: s.alerts_enabled,
        toplamHaber: s.total_articles,
      });
    }

    // Örnek/placeholder adres kontrolü. Bildirimler "gönderildi"
    // görünür ama kimseye ulaşmaz — sessiz başarısızlık.
    const mail = s?.alert_email ?? "";
    const PLACEHOLDER = /^(senin@mail\.com|ornek@|example@|test@|your@|email@example)/i;
    if (s?.alerts_enabled && PLACEHOLDER.test(mail)) {
      log.warn("═══ UYARI: alert_email ÖRNEK ADRES ═══", { mevcut: mail });
      log.warn("Bildirimler size ULAŞMAYACAK. Supabase'de düzelt:");
      log.warn("  update public.bot_settings set alert_email = 'gercek@adresin.com' where id;");
    } else if (s?.alerts_enabled && !mail) {
      log.warn("alert_email boş — bildirimler gönderilmeyecek");
    }
  } catch { /* ana döngü zaten tekrar deneyecek */ }

  const media = new MediaWorker(db, sb, downloader, 1);
  const orchestrator = new Orchestrator({ db, sb, fetcher, ingest, media, alerter });

  // --- 4) Sağlık sunucusu (Docker healthcheck okur) ----------
  const health = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const h = orchestrator.health;
      res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(h));
    } else {
      res.writeHead(404); res.end();
    }
  });
  health.listen(env.healthPort, () => {
    log.info("Sağlık sunucusu dinliyor", { port: env.healthPort });
  });

  // --- 5) Periyodik temizlik ---------------------------------
  const sweeper = setInterval(() => void sweepTmp(), 60 * 60 * 1000);
  sweeper.unref();

  // --- 6) Graceful shutdown ----------------------------------
  // Dokploy deploy'da SIGTERM gönderir. Yarım kalan transcode veya
  // yarım yüklenmiş R2 dosyası bırakmamak için mevcut turu bitiriyoruz.
  const ctrl = new AbortController();
  let shuttingDown = false;
  let firstSignalAt = 0;

  const shutdown = async (sig: string) => {
    if (shuttingDown) {
      // npm start ile çalışırken Ctrl+C hem npm'e hem node'a gider;
      // aynı anda gelen kopyaları yok say. Kullanıcı gerçekten ikinci
      // kez bastıysa (2 sn sonra) zorla çık.
      if (Date.now() - firstSignalAt < 2000) return;
      log.warn("İkinci sinyal — zorla çıkılıyor");
      process.exit(1);
    }
    shuttingDown = true;
    firstSignalAt = Date.now();
    log.info("Kapanma sinyali alındı", { signal: sig });

    ctrl.abort();
    clearInterval(sweeper);

    const timeout = setTimeout(() => {
      log.error("Kapanma zaman aşımı — zorla çıkılıyor");
      process.exit(1);
    }, 45_000);

    try {
      await orchestrator.shutdown(30_000);
      await new Promise<void>((r) => health.close(() => r()));
      await alerter.close();
      await closeStore();
      await sweepTmp(0);
    } catch (err) {
      log.error("Kapanma sırasında hata", { err });
    }

    clearTimeout(timeout);
    log.info("Temiz kapanış");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    // Loglayıp DEVAM ET. Bir promise hatası botu öldürmemeli.
    log.error("Yakalanmamış promise reddi (bot çalışmaya devam ediyor)", { reason });
  });

  process.on("uncaughtException", (err) => {
    /**
     * BOT ASLA KENDİ KENDİNE ÖLMEZ.
     *
     * Önceden burada shutdown çağrılıyordu; tek bir beklenmedik
     * hata tüm botu kapatıyordu. Artık sadece logluyoruz ve
     * çalışmaya devam ediyoruz.
     *
     * İstisna: bellek tükenmesi gibi süreç gerçekten kurtarılamaz
     * durumdaysa çıkılır — Docker `restart: unless-stopped` ile
     * saniyeler içinde geri getirir.
     */
    const msg = err?.message ?? String(err);
    const fatal =
      /heap out of memory|ERR_WORKER_OUT_OF_MEMORY|Cannot allocate memory|EMFILE/i.test(msg);

    if (fatal) {
      log.error("Kurtarılamaz hata — süreç yeniden başlatılacak", { err });
      process.exit(1);   // Docker restart eder
    }

    log.error("Yakalanmamış istisna (bot çalışmaya devam ediyor)", { err });
  });

  // --- 7) Çalış ----------------------------------------------
  await orchestrator.start(ctrl.signal);
  await shutdown("loop-ended");
}

main().catch((err) => {
  log.error("Başlatma başarısız", { err });
  process.exit(1);
});
