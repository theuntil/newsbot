# Dokploy'a Kurulum

Sıfırdan üretime alma adımları. Sırayla takip et.

---

## 1. Supabase hazırlığı

SQL Editor'de **sırayla** çalıştır:

| Dosya | Ne yapar |
|---|---|
| `supabase_kurulum.sql` | Tablolar, RLS, RPC'ler (daha önce çalıştırdıysan atla) |
| `bot_kontrol.sql` | Bot ayarları, tur kayıtları, hata kuyruğu (atla) |
| `yama-01-slug.sql` | Slug kesme hatası düzeltmesi |
| `yama-02-video-kurtarma.sql` | ffmpeg yüzünden ölen videoları geri getirir |
| `watchdog.sql` | pg_cron ile bot ölüm kontrolü |

Sonra ayarları düzelt:

```sql
update public.bot_settings set
  is_enabled          = true,
  alert_email         = 'gercek@adresin.com',   -- ÖNEMLİ
  max_items_per_run   = 500,
  media_concurrency   = 8,
  image_fallback_webp = false                   -- ~%30 depolama tasarrufu
where id;
```

---

## 2. Repo'yu hazırla

```bash
git init
git add .
git commit -m "haber bot"
git remote add origin <repo-url>
git push -u origin main
```

⚠️ `.env` **commit edilmez** — `.gitignore`'da. Değişkenleri Dokploy
arayüzünden gireceksin.

---

## 3. Dokploy'da servis oluştur

**Projects → Create Project → Create Service → Compose**

- **Source:** Git → repo URL'in, branch `main`
- **Compose Path:** `docker-compose.yml`
- **Build Path:** `/` (kök)

---

## 4. Ortam değişkenleri

Dokploy → servisin → **Environment** sekmesi. Aşağıdakileri gir:

```env
IHA_RSS_URL=https://abonerss.iha.com.tr/xml/standartrss
IHA_USER_CODE=
IHA_USER_NAME=
IHA_USER_PASSWORD=
IHA_MIN_INTERVAL_MS=33000
IHA_REFERER=https://www.iha.com.tr/

SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=

S3_ENDPOINT=https://59af34f812e988f0cfe7aa4805316551.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=haber-medya
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
CDN_BASE=https://medya.kuzeybatihaber.com.tr

SMTP_ENABLED=true
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=bot@kuzeybatihaber.com.tr
SMTP_PASS=
SMTP_FROM=Haber Bot <bot@kuzeybatihaber.com.tr>

LOG_LEVEL=info
INSTANCE_ID=dokploy-bot-1
```

`REDIS_URL` girme — compose zaten `redis://redis:6379` veriyor.

Alıcı mail adresi burada **değil**, `bot_settings.alert_email`'de
(panelden değiştirilebilsin diye).

---

## 5. Deploy

**Deploy** butonuna bas. İlk derleme 3–6 dakika sürer (ffmpeg
kurulumu + sharp ikili dosyaları).

Derleme sırasında şunları görmelisin — çıkmıyorsa imaj bozuk:

```
ffmpeg + ffprobe OK
sharp OK vips 8.x.x
```

---

## 6. Doğrulama

**Logs** sekmesinde beklenen açılış:

```
Haber botu başlıyor
Redis bağlandı                    ← Dokploy'da Redis VAR, bu satır çıkmalı
R2 bağlantısı doğrulandı
SMTP bağlantısı doğrulandı
ffmpeg hazır — video işleme aktif  ← ÖNEMLİ
Bot AÇIK
Sağlık sunucusu dinliyor
Feed alındı
Ingest planı
Medya partisi tamamlandı
```

"Redis yok" veya "ffmpeg YOK" görüyorsan compose düzgün ayağa
kalkmamıştır.

Supabase'den kontrol:

```sql
select * from public.bot_health;
select type, status, count(*) from media group by type, status;
```

`type='video'` satırlarında `ready` görmelisin.

---

## 7. İzleme

```sql
-- Son turlar
select id, status, items_created, media_done, duration_ms, error_message
  from bot_runs order by started_at desc limit 20;

-- Açık hatalar
select kind, left(error_message,80), attempts, last_seen_at
  from bot_failures where status in ('open','retrying')
 order by last_seen_at desc;

-- Sıkıştırma verimi
select type, count(*),
       pg_size_pretty(sum(bytes_in))  as ham,
       pg_size_pretty(sum(bytes_out)) as sikistirilmis,
       round(100 - sum(bytes_out)::numeric / nullif(sum(bytes_in),0) * 100) as tasarruf
  from media where status = 'ready' group by type;
```

---

## Sorun giderme

**Derleme "sharp" hatası veriyor**
Dokploy sunucusunda ağ kısıtı olabilir; sharp ikili dosya indiriyor.
`docker system prune -af` ile önbelleği temizleyip tekrar dene.

**"ffmpeg YOK" uyarısı**
İmaj eski. Dokploy → Redeploy, "Force rebuild" işaretli olsun.

**Videolar pending'de takılı**
`select last_error from media where type='video' and status='pending' limit 5;`
`ffmpeg yok — bekliyor` yazıyorsa imaj sorunu; başka bir hata varsa
onu paylaş.

**Bot iki kez çalışıyor gibi**
Advisory lock devrede, ikinci instance tur atlar. Loglarda
"Başka instance çalışıyor" görürsün — normaldir.

**Disk doluyor**
`docker exec <container> du -sh /tmp/haberbot` — normalde birkaç MB.
Büyükse bir transcode takılmış; container'ı yeniden başlat.

**Mail gelmiyor**
`select * from alert_log order by sent_at desc limit 10;`
`delivered=false` ise `smtp_error` sütununa bak.

---

## Güncelleme

```bash
git add . && git commit -m "guncelleme" && git push
```

Dokploy → **Redeploy**. Graceful shutdown sayesinde mevcut tur
tamamlanır, yarım medya kalmaz.
