# Haber Bot — IHA RSS → Supabase + Cloudflare R2

Haberleri IHA feed'inden çeker, medyayı sıkıştırıp R2'ye yükler,
hata olursa mail atar. Tüm ayarlar panelden değiştirilebilir.

**170 test** · `npm test`

---

## Kurulum

### 1. Bağımlılıklar

```bash
npm install
npm test          # 170 test geçmeli
npm run build
```

### 2. Ortam değişkenleri

```bash
cp .env.example .env
```

Doldurulacaklar: IHA kimlik bilgileri, `SUPABASE_SERVICE_ROLE_KEY`,
R2 anahtarları, SMTP şifresi.

⚠️ `.env` git'e **commit edilmez**. `service_role` anahtarı asla
`NEXT_PUBLIC_` ile başlayan bir değişkene konmaz — RLS'i bypass eder.

### 3. Watchdog

`watchdog.sql` dosyasını Supabase SQL Editor'de çalıştır.
Bot ölürse kendi ölümünü bildiremez; bu görev Supabase içinde,
bottan bağımsız çalışır.

### 4. Dokploy

- Yeni **Compose** servisi → repo'yu bağla
- Environment → `.env` içeriğini yapıştır
- Deploy

### 5. Botu aç

```sql
update public.bot_settings set
  is_enabled  = true,
  alert_email = 'senin@mail.com'
where id;
```

---

## İzleme

```sql
-- Genel sağlık
select * from public.bot_health;

-- Son turlar
select id, status, items_created, items_updated, media_done,
       duration_ms, error_message
  from public.bot_runs order by started_at desc limit 20;

-- Açık hatalar
select kind, error_message, attempts, haber_kodu, last_seen_at
  from public.bot_failures
 where status in ('open','retrying') order by last_seen_at desc;

-- Medyası eksik haberler
select haber_kodu, title, media_state, media_attempts
  from public.articles
 where media_state in ('pending','retrying','no_media')
   and deleted_at is null
 order by published_at desc;

-- Sıkıştırma verimi
select count(*),
       pg_size_pretty(sum(bytes_in))  as ham,
       pg_size_pretty(sum(bytes_out)) as sikistirilmis,
       round(100 - avg(bytes_out::numeric / nullif(bytes_in,0)) * 100) as tasarruf_yuzde
  from public.media where status = 'ready';
```

Container sağlığı: `curl http://localhost:8080/health`

---

## Panelden yönetilen ayarlar

Hepsi `bot_settings` tablosunda, **restart gerektirmez** — bot her
turda okur.

| Alan | Ne yapar |
|---|---|
| `is_enabled` | Ana açma/kapama |
| `poll_interval_sec` | Feed aralığı (min 30, DB zorlar) |
| `media_enabled` / `image_enabled` / `video_enabled` | Katman bazlı kapatma |
| `image_quality` | AVIF kalitesi (20–95, varsayılan 52) |
| `image_variants` | Üretilecek boyutlar |
| `video_crf_short` / `video_crf_long` | Video kalitesi |
| `video_skip_over_sec` | Bu süreden uzun video transcode edilmez |
| `alerts_enabled` | Mail bildirimi aç/kapa |
| `alert_cooldown_min` | Aynı hata için sessizlik penceresi |
| `alert_daily_cap` | Günlük mail tavanı (SMTP limitini korur) |

---

## Tasarım kararları

**Haber atlamama — üç katman.** Bozuk item turu çökertmez (parser
izolasyonu); feed'deki tüm kodlar her turda DB ile karşılaştırılır
(watermark'a güvenilmez, IHA geriye dönük haber ekleyebiliyor);
yazma patlarsa ham veri dead letter'da saklanır.

**`filesize=0` kaydedilir, atlanmaz.** IHA fotoğrafı haberden
dakikalar sonra yüklüyor. Kayıt açılmazsa fotoğraf geldiğinde onu
bekleyen bir satır olmaz ve haber kalıcı medyasız kalır.

**İçerik hash'i değişmediyse DB'ye dokunulmaz.** 60 saniyede bir
çalışan bir botta bu, günde ~1.400 gereksiz yazma ve aynı sayıda
ISR revalidate'i önler.

**`is_manually_edited`.** Editör bir IHA haberini düzenlediğinde bot
metni bir daha ezmez, sadece medyayı senkronlar. Bu bayrak olmasa
KVKK için silinen plaka 60 saniye sonra geri gelirdi.

**Medya URL'i saklanmaz, sadece `storage_key`.** CDN domain'i veya
bucket değişirse tek env değişkeni güncellenir.

**Video kademeli.** ≤5 dk CRF 26, 5–20 dk CRF 28, >20 dk transcode
yok (sadece poster). Uzun videoyu 720p'ye indirmek 10+ dk CPU yer.

**Advisory lock.** Deploy sırasında eski/yeni container üst üste
binerse iki poller aynı anda feed çekip 30 sn limitini delerdi.

**Mail bastırma DB'de, bellekte değil.** İki container çalışırsa
bellekteki cooldown her birinde ayrı olur ve çift mail gider.

---

## Sorun giderme

**Bot çalışmıyor** → `select is_enabled, paused_until, pause_reason
from bot_settings;`

**Medya gelmiyor** → `select status, count(*), last_error from media
group by status, last_error;`
`HTML_RESPONSE` görüyorsan `IHA_REFERER` yanlış olabilir.

**Mail gelmiyor** → `select * from alert_log order by sent_at desc
limit 10;` · `delivered=false` ise `smtp_error` sütununa bak.

**Disk doluyor** → `docker exec <container> du -sh /tmp/haberbot`
Normalde birkaç MB olmalı; büyükse bir transcode takılmış demektir.

**Şifre değişti** → Bot 401/403'te `critical` mail atar ve 15 dakika
kendini durdurur. `.env`'i güncelleyip yeniden deploy et.
