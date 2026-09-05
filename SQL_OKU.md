# SQL Kurulumu

## Tek dosya (önerilen)

**`TAM_KURULUM.sql`** — hepsi tek dosyada, doğru sırayla.

Supabase → SQL Editor → tamamını yapıştır → RUN.

Temiz bir PostgreSQL üzerinde **üç kez üst üste** çalıştırılarak test
edildi, hatasız. Tekrar çalıştırmak güvenli (idempotent).

Kurulumdan sonra:

```sql
update public.bot_settings set
  is_enabled  = true,
  alert_email = 'gercek@adresin.com'
where id;

update public.profiles set role='admin'
 where id = (select id from auth.users where email='senin@mail.com');
```

## Parça parça

Zaten bir kısmını çalıştırdıysan `KURULUM_SIRASI.md`'deki 14 dosyayı
sırayla uygula. İkisi aynı sonucu verir.

## Doğrulama

```sql
-- 14 tabloda da RLS açık olmalı
select count(*) filter (where relrowsecurity) as rls_acik, count(*) as toplam
  from pg_class where relnamespace='public'::regnamespace and relkind='r';

-- Kategori ve şehir envanteri
select (select count(*) from categories where kind='topic')  as konu,
       (select count(*) from categories where kind='scope')  as kapsam,
       (select count(*) from cities where is_domestic)       as il,
       (select count(*) from cities where not is_domestic)   as yurt_disi;

-- Bir haberin üç boyutu
select a.title,
       (select c.name from categories c where c.id=a.category_id) as birincil_konu,
       (select string_agg(c2.name||' ('||c2.kind||')', ' + ')
          from article_categories ac join categories c2 on c2.id=ac.category_id
         where ac.article_id=a.id) as tum_kategoriler,
       (select ci.name from cities ci where ci.id=a.city_id) as sehir
  from articles a where a.deleted_at is null
 order by a.published_at desc limit 5;

-- Eşleştirme bekleyenler (panelde gösterilecek)
select * from pending_category_mappings;
select * from pending_city_mappings;

-- Depolama temizliği
select * from storage_cleanup_status;
```

## Beklenen değerler

| | |
|---|---|
| RLS açık tablo | 14 / 14 |
| Konu kategorisi | 13 |
| Kapsam kategorisi | 4 |
| İl | 81 |
| Yurt dışı | 13 |
| `SECURITY DEFINER` + `search_path` | 51 / 51 |
