# Kurulum Sırası

SQL dosyaları **bu sırayla** çalıştırılmalı. Sıfırdan temiz bir
PostgreSQL üzerinde baştan sona test edildi, 14/14 hatasız. 13 tabloda da RLS aktif.

| # | Dosya | İçerik |
|---|---|---|
| 1 | `supabase_kurulum.sql` | Tablolar, RLS, iş akışı RPC'leri |
| 2 | `bot_kontrol.sql` | Bot ayarları, tur kayıtları, hata kuyruğu, bildirim |
| 3 | `yama-01-slug.sql` | Slug kesme hatası |
| 4 | `yama-02-video-kurtarma.sql` | ffmpeg yüzünden ölen medyayı kurtarır |
| 5 | `yama-03-poster.sql` | Video poster kaynağı |
| 6 | `yama-04-ayarlar.sql` | 5 dakikalık aralık |
| 7 | `yama-05-final.sql` | **RLS açığı**, atomik claim, sources, byline |
| 8 | `yama-06-kalite.sql` | Görüntü kalitesi (SSIM ölçümlü) |
| 9 | `yama-07-kategori.sql` | Kategori sistemi |
| 10 | `yama-08-sehir.sql` | Şehir sistemi (81 il + yurt dışı) |
| 11 | `yama-09-depolama-temizlik.sql` | Silinen haberin R2 dosyalarını temizler |
| 12 | `yama-10-temizlik-tamamlama.sql` | Yetim tarama, kuyruk temizliği, uyarı |
| 13 | `yama-11-cok-kategori.sql` | Çok kategorili yapı (konu + kapsam + yer) |
| 14 | `watchdog.sql` | pg_cron ile bot ölüm kontrolü |

Zaten 1–2'yi çalıştırdıysan 3'ten devam et. Hepsi tekrar
çalıştırılabilir (idempotent).

## Sonrasında

```sql
update public.bot_settings set
  is_enabled  = true,
  alert_email = 'gercek@adresin.com'
where id;

-- Kendini admin yap
update public.profiles set role='admin'
 where id = (select id from auth.users where email='senin@mail.com');
```

## Doğrulama

```sql
-- 10 tabloda da RLS açık olmalı
select count(*) filter (where relrowsecurity) as rls_acik, count(*) as toplam
  from pg_class where relnamespace='public'::regnamespace and relkind='r';

-- Kategoriler
select slug, name, color, icon from categories order by sort_order;

-- Eşleştirilmeyi bekleyen kategoriler (panelde gösterilecek)
select * from pending_category_mappings;

-- Kategori dağılımı
select * from category_stats where yayinda > 0;
```

## Kategori sistemi nasıl çalışıyor

IHA'nın ham kategorisi (`UstKategori` + `Kategori`) `category_mappings`
tablosundan bizim kategorimize çevrilir.

Bilinmeyen bir kombinasyon gelirse: haber `Genel` kategorisine düşer
**ve** eşleştirme kuyruğuna kaydedilir. Panelde `pending_category_mappings`
görünümünden görürsün, kaç haber geldiğiyle birlikte.

Eşleştirdiğinde geçmiş haberler de otomatik düzelir:

```sql
select map_category(
  '<mapping_id>',
  (select id from categories where slug='teknoloji'),
  true   -- geçmişe dönük uygula
);
```

Kategori ekleme/düzenleme (renk, ikon, sıra, menüde görünsün mü) doğrudan
`categories` tablosundan yapılır — admin paneli bu tabloyu yönetecek.


## Şehir sistemi

Kategoriyle aynı desende ama **ayrı boyut** — bir haber hem `Spor`
hem `Ankara` olabilir. Aynı tabloda olsalardı "Ankara'daki spor
haberleri" sorgusu yapılamazdı.

**81 il hazır geliyor:** plaka kodu, coğrafi bölge, slug.
Yurt dışı için 13 hazır kayıt (KKTC, Almanya, Filistin, Rusya...).
`is_domestic` alanı ikisini ayırır.

**Türkçe eşleştirme çözüldü.** `İSTANBUL`, `istanbul`, `İstanbul`,
` İSTANBUL ` — hepsi `slugify()` ile aynı anahtara iner. Türkçe'nin
meşhur İ/I sorunu bu şekilde aşılır. Eski adlar da eşleşir:
`İÇEL`→Mersin, `AFYON`→Afyonkarahisar, `MARAŞ`→Kahramanmaraş,
`URFA`→Şanlıurfa, `GAZZE`→Filistin, `BAKÜ`→Azerbaycan.

**Bilinmeyen şehir** gelirse haber şehirsiz kalır ve kuyruğa düşer:

```sql
select * from pending_city_mappings;
```

Mevcut bir şehre eşle:
```sql
select map_city('<mapping_id>', (select id from cities where slug='istanbul'), true);
```

Ya da yeni şehir oluştur (yurt dışı vb.) — tek adımda eşler ve
geçmiş haberleri de bağlar:
```sql
select create_city_from_mapping('<mapping_id>', 'Timbuktu', false, 'ML');
```

**Panel görünümleri:** `city_stats` (şehir başına haber sayısı),
`pending_city_mappings` (eşleştirme bekleyenler).

**Veri bütünlüğü:** Yurt dışı kaydına plaka verilemez, il kaydında
plaka zorunlu, plaka 1–81 aralığında, renk hex formatında. Dördü de
DB kısıtı olarak zorlanır.


## Depolama temizliği

Haber silindiğinde R2'deki dosyalar **anında** silinir (birkaç saniye).

**Neden bir tablo var:** PostgreSQL R2'ye HTTP isteği atamaz. Silmeyi
bot yapar; DB'nin bota "şunları sil" demesinin tek yolu bir tablodur.
Bu bir tasarım tercihi değil, zorunluluk. Bot bu tabloya 2-20 saniyede
bir bakar, o yüzden pratikte anlık çalışır.

İstersen gecikme koyabilirsin (yanlışlıkla silineni geri almak için):
`update bot_settings set storage_grace_days = 7 where id;`

```sql
-- Durum
select * from storage_cleanup_status;

-- Bekleme süresini değiştir
update bot_settings set storage_grace_days = 14 where id;

-- Tamamen kapat
update bot_settings set storage_cleanup_enabled = false where id;

-- Haberi geri al (bekleyen silme iptal olur)
select restore_article('<article_id>');
```

Silme sırasında önek altındaki dosyalar **listelenerek** silinir,
tahmin edilmez. Kalite ayarı değişip varyant isimleri farklılaştıysa
eski dosyalar da yakalanır.

**Güvenlik:** Önek en az 3 seviye derinlikte ve `media/` altında
olmalı. `media/`, `media/2026`, `/`, `*` gibi tehlikeli önekler
reddedilir — bir hata tüm bucket'ı silemez. Dokuz senaryo test edildi.

### Silme hangi yollardan tetikleniyor

Test edilmiş dört senaryo:

| Yol | Tetikleyici |
|---|---|
| `soft_delete_article()` RPC | `articles UPDATE OF deleted_at` |
| Panelden doğrudan `update articles set deleted_at` | aynı trigger |
| Haber hard delete | FK cascade → `media AFTER DELETE` |
| Medya yeniden işlenip yolu değişti | `media UPDATE OF storage_key` |

Yani silme nereden gelirse gelsin dosyalar temizlenir.

### Yetim dosya taraması

Outbox güvenilirdir ama mutlak değildir: elle DB düzenlemesi, eski
bir bug veya 5 denemeyi tüketmiş bir silme yetim dosya bırakabilir.
Bot günde bir kez bucket'ı listeleyip DB ile karşılaştırır; karşılığı
olmayan dosyaları silme kuyruğuna alır.

```sql
-- Aralığı değiştir
update bot_settings set orphan_sweep_interval_hours = 12 where id;
-- Kapat
update bot_settings set orphan_sweep_enabled = false where id;
```

### Silinemeyen dosyalar

5 denemede silinemeyen kayıt `failed` olur, silinmez (insan
incelesin diye). Bot bunu görünce mail atar. Panelden tekrar dene:

```sql
select retry_failed_deletions();
```


## Üç boyutlu sınıflandırma

IHA bir haberi şöyle gönderiyor:

```xml
<UstKategori>ULUSAL HABER</UstKategori>
<Kategori>SPOR</Kategori>
<Sehir>MANİSA</Sehir>
```

Bu üç ayrı boyuttur ve haber **üçüne birden** bağlanır:

| Boyut | Değer | Nerede |
|---|---|---|
| Konu | Spor | `article_categories` (birincil) |
| Kapsam | Ulusal Haber | `article_categories` |
| Yer | Manisa | `articles.city_id` |

`articles.category_id` birincil konuyu tutar — rozet, URL ve menü
için hızlı erişim. Tam liste `article_categories` tablosunda.

**Neden böyle:** IHA'nın `UstKategori` alanı tutarsız. Bazen konu
gönderiyor (`SPOR`), bazen kapsam (`ULUSAL HABER`). Tek bir alana
sıkıştırmak bilgiyi kaybettiriyordu. Artık her ham değer bağımsız
eşleşiyor, ikisi de korunuyor.

### Sorgular

```sql
-- Spor haberleri
select a.* from articles a
  join article_categories ac on ac.article_id = a.id
  join categories c on c.id = ac.category_id
 where c.slug = 'spor' and a.status='published' and a.deleted_at is null;

-- Ulusal haberler
... where c.slug = 'ulusal'

-- Manisa haberleri
select a.* from articles a join cities ci on ci.id = a.city_id
 where ci.slug = 'manisa';

-- Manisa'daki spor haberleri
select a.* from articles a
  join cities ci on ci.id = a.city_id
  join article_categories ac on ac.article_id = a.id
  join categories c on c.id = ac.category_id
 where ci.slug='manisa' and c.slug='spor';
```

Kategori türleri: `kind='topic'` (13 konu), `kind='scope'` (4 kapsam:
Ulusal, Yerel, Bölgesel, Uluslararası). Menüde ikisini ayrı
gösterebilirsin.


## Ek yamalar

`yama-12-guvenlik.sql` — sütun bazlı yetki (raw_payload gizleme)
`yama-13-tekillestirme.sql` — aynı videoyu iki kez işlememe + encoder hızlandırma


## Medya tekilleştirme

IHA aynı videoyu birden fazla habere bağlıyor (maç özeti hem "1-0"
hem "4-0" haberinde). Ölçüm: 72 video işleminin sadece 54'ü
benzersizdi — **%25 israf**.

Artık aynı `external_key` daha önce işlendiyse dosya paylaşılıyor;
indirme ve transcode hiç yapılmıyor.

**Referans sayımı:** Paylaşılan dosya, onu kullanan son haber de
silinene kadar R2'den silinmiyor. Test edildi: iki haber aynı videoyu
paylaşırken birini silmek dosyayı silmiyor, ikincisi de silinince
dosya gidiyor.

## Encoder hızlandırma

SSIM ölçümü (1080p, gerçek video):

| Ayar | Boyut | Süre | SSIM |
|---|---|---|---|
| fast crf26 (eski) | 3700 KB | 12.4 sn | 0.9921 |
| **veryfast crf25** | 3771 KB | **6.1 sn** | **0.9924** |
| veryfast crf26 | 3314 KB | 5.8 sn | 0.9909 |

`veryfast`, `fast`'ten **2 kat hızlı**; crf25'te kalite bir tık daha
iyi ve dosya boyutu aynı. Net kazanç, ödün yok.
