# Güvenlik Denetimi

Gerçek PostgreSQL ve Redis üzerinde çalıştırılan denetim sonuçları.

## Bulunan ve düzeltilen kritik açık

**RLS aslında kapalıydı.** Kurulum SQL'inde `FORCE ROW LEVEL SECURITY`
kullanılmıştı; `FORCE` tek başına RLS'i **açmaz**, sadece tablo sahibine
de uygulanmasını sağlar. Önce `ENABLE` gerekir.

Sonuç: politikalar yazılmıştı ama hiç uygulanmıyordu. `anon` anahtarıyla
taslak ve reddedilmiş haberler okunabiliyordu.

`yama-05-final.sql` bunu düzeltir. Uyguladıktan sonra doğrula:

```sql
select relname, relrowsecurity as acik, relforcerowsecurity as zorunlu
  from pg_class
 where relnamespace='public'::regnamespace and relkind='r';
```

Sekiz tablonun tamamında `acik = t` olmalı.

## İkinci sızma testi (rol bazlı)

Temiz bir veritabanında dört rolle 23 senaryo denendi, hepsi doğru:

| Rol | Denenen | Sonuç |
|---|---|---|
| anon | 15 saldırı vektörü | hepsi engellendi |
| reader | haber yazma, başkasının yazısını değiştirme, kategori oluşturma, bot ayarı, rol yükseltme | hepsi engellendi |
| author | kendini yayınlama, başkasının yazısı, onaylama, silme, hard delete, rol yükseltme | hepsi engellendi |
| editor | onaylama, silme, bot ayarı, kategori oluşturma | hepsi engellendi (admin işi) |
| admin | onaylama, kategori, bot ayarı, silme | hepsi çalışıyor |

Gelişmiş denemeler de engellendi: yazarın doğrudan `published` insert
etmesi, sahte IHA kaynağı uydurması, başkası adına yazı açması,
`evil.com` medya URL'i eklemesi (SSRF).

## Bulunan ve düzeltilen ikinci açık

**`anon` rolü `articles.raw_payload` sütununu okuyabiliyordu.** Bu sütun
IHA'dan gelen ham XML'i tutar; içinde token'lı medya URL'leri ve
sağlayıcıya ait iç veriler var.

`yama-12-guvenlik.sql` bunu kapatır. Gizlenen sütunlar:

| Tablo | Gizlenen |
|---|---|
| articles | `raw_payload`, `content_hash` |
| media | `source_url`, `poster_source_url`, `last_error`, `attempts`, `next_try_at` |
| profiles | `push_tokens` |

**Not:** Sütun bazlı `REVOKE` tek başına yetmez — Postgres'te tablo
düzeyi `SELECT` tüm sütunları kapsar. Doğru yöntem tablo yetkisini
kaldırıp güvenli sütunları tek tek vermektir. Yama bunu döngüyle
yapar; ileride eklenen normal sütunlar otomatik açılır, hassas
olanı kara listeye eklemek yeterlidir.

Ayrıca iki güvenli görünüm eklendi: `public_articles` ve
`public_media`. Frontend bunları kullanırsa kategori/şehir/kaynak
birleştirilmiş halde gelir ve hassas sütun riski hiç doğmaz.

## Doğrulanan korumalar

| Test | Sonuç |
|---|---|
| anon taslak haber okuyabiliyor mu | Hayır (8 haberden 6 yayındakini görüyor) |
| anon bot ayarlarını okuyabiliyor mu | Hayır |
| anon INSERT / UPDATE / DELETE | Üçü de engellendi |
| anon bot RPC'lerini çağırabiliyor mu | Hayır |
| anon haber onaylayabiliyor mu | Hayır |
| yazar kendi yazısını yayınlayabiliyor mu | Hayır (sadece RPC ile, o da admin) |
| yazar başkasının yazısını onaylayabiliyor mu | Hayır |
| yazar kendini admin yapabiliyor mu | Hayır (trigger engelliyor) |
| 29 SECURITY DEFINER fonksiyonunda search_path | 29/29 sabitlenmiş |

## Katmanlı savunma

**Yetki (GRANT):** `anon` hiçbir tabloya yazamaz. `DELETE` hiç kimsede yok.
Bot fonksiyonları sadece `service_role`'da.

**RLS:** Yetki katmanını geçse bile satır bazında filtrelenir.

**Trigger:** Politika delinse bile `tg_guard_role_change` rol yükseltmeyi
DB seviyesinde engeller.

**RPC:** `status` kolonuna kimse doğrudan yazamaz; tüm geçişler yetki
kontrolü yapan fonksiyonlardan geçer.

## Uygulama katmanı

**Sır sızıntısı:** IHA hız sınırı yanıtında kimlik bilgilerini geri
gönderiyor. Hem URL hem yanıt gövdesi maskeleniyor. 12 farklı sır
formatı test ediliyor (`npm run test:logger`).

**SSRF:** Medya indirme sadece `*.iha.com.tr` host'larına izin verir.
Bulut metadata adresleri, localhost, `file://` ve suffix saldırıları
(`iha.com.tr.evil.com`) test edilerek engellendi. DB'de ayrıca CHECK
constraint var — iki bağımsız katman.

**Path traversal:** Depolama anahtarları sanitize edilir.

**Kaynak tüketimi:** İndirme boyut sınırı akışta uygulanır (OOM koruması),
ffmpeg'de sert timeout + SIGKILL, sharp thread havuzu sınırlı, geçici
dosyalar `finally` bloğunda her koşulda silinir.

**EXIF:** Görsellerden metadata silinir (GPS koordinatı, cihaz bilgisi).

## Bilinen sınırlar

Container `service_role` anahtarını taşır ve RLS'i bypass eder. Bu
tasarım gereğidir; anahtarın sunucuda kalması şarttır. Asla
`NEXT_PUBLIC_` ile başlayan bir değişkene konmamalıdır.

Yorum ve beğeni sistemi henüz yok (Faz 3). Kullanıcı üretimi içerik
eklendiğinde moderasyon ve oran sınırlama gerekecek.
