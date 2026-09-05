-- ############################################################
--  FAZ 2A — BOT KONTROL KATMANI
--  Supabase → SQL Editor → yapıştır → RUN
--  Tekrar çalıştırılabilir (idempotent).
--
--  Bu dosya botun BEYNİ: ayarlar, tur kayıtları, hata kuyruğu,
--  mail bildirim mantığı ve watchdog.
-- ############################################################

set statement_timeout = '120s';

-- ============================================================
-- 1. ENUM'LAR
-- ============================================================
do $$ begin
  create type public.bot_run_status as enum
    ('running','success','partial','failed','skipped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bot_failure_kind as enum
    ('feed_fetch','feed_parse','item_parse','item_ingest',
     'media_fetch','media_process','media_upload','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bot_failure_status as enum
    ('open','retrying','resolved','abandoned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.alert_severity as enum ('info','warning','critical');
exception when duplicate_object then null; end $$;

-- ============================================================
-- 2. BOT_SETTINGS  — tek satır, panelden yönetilir
--
--  TASARIM: JSONB değil ayrı kolonlar. Tip güvenliği +
--  CHECK constraint'leri ile panelden saçma değer girilemez.
--  Bot bu satırı HER TURDA okur → restart gerekmez.
-- ============================================================
create table if not exists public.bot_settings (
  id boolean primary key default true,
  constraint bot_settings_singleton check (id),   -- tek satır garantisi

  -- ---- Ana kontrol ----------------------------------------
  is_enabled            boolean not null default false,  -- ilk kurulumda KAPALI
  paused_until          timestamptz,                     -- circuit breaker
  pause_reason          text,

  -- ---- Feed çekme -----------------------------------------
  -- IHA limiti: istekler arası min 30 sn. 60 sn güvenli marj.
  poll_interval_sec     int  not null default 60,
  request_timeout_sec   int  not null default 25,
  feed_max_retries      int  not null default 3,
  feed_retry_backoff_ms int  not null default 2000,
  feed_user_agent       text not null default 'KuzeybatiHaberBot/1.0',

  -- ---- Haber işleme ---------------------------------------
  ingest_enabled        boolean not null default true,
  max_items_per_run     int  not null default 200,
  -- feed'de geriye dönük tarama penceresi (haber atlamama garantisi)
  backfill_lookback_min int  not null default 180,

  -- ---- Medya genel ----------------------------------------
  media_enabled         boolean not null default true,
  media_concurrency     int  not null default 4,
  media_max_attempts    int  not null default 7,
  -- medya sunucusuna saniyede kaç istek (feed limitinden ayrı)
  media_rate_per_sec    numeric(4,2) not null default 2.0,
  media_download_timeout_sec int not null default 60,

  -- ---- Görsel ---------------------------------------------
  image_enabled         boolean not null default true,
  image_format          text not null default 'avif',
  image_quality         int  not null default 52,
  image_fallback_webp   boolean not null default true,
  image_variants        jsonb not null default
    '[{"name":"thumb","w":400},{"name":"card","w":800},{"name":"full","w":1600}]'::jsonb,
  image_max_bytes       bigint not null default 26214400,   -- 25 MB
  image_blurhash        boolean not null default true,

  -- ---- Video ----------------------------------------------
  video_enabled         boolean not null default true,
  video_concurrency     int  not null default 1,
  video_max_height      int  not null default 720,
  video_crf_short       int  not null default 26,   -- <= 5 dk
  video_crf_long        int  not null default 28,   -- 5-20 dk
  video_preset          text not null default 'veryfast',
  video_audio_kbps      int  not null default 96,
  video_threads         int  not null default 4,
  video_short_max_sec   int  not null default 300,
  -- bundan uzun video TRANSCODE EDİLMEZ, sadece poster saklanır
  video_skip_over_sec   int  not null default 1200,
  video_max_bytes       bigint not null default 524288000,  -- 500 MB

  -- ---- Bildirim (panelden aç/kapa) ------------------------
  alerts_enabled        boolean not null default true,
  alert_email           text,
  alert_min_consecutive int  not null default 3,   -- kaç ardışık hatadan sonra
  alert_cooldown_min    int  not null default 30,  -- aynı hata için bekleme
  alert_on_recovery     boolean not null default true,
  alert_critical_bypass boolean not null default true,
  alert_daily_cap       int  not null default 50,  -- SMTP limitini koru

  -- ---- Watchdog -------------------------------------------
  watchdog_enabled      boolean not null default true,
  watchdog_stale_min    int  not null default 10,  -- bu süre tur yoksa alarm

  -- ---- Canlı durum (bot yazar, panel okur) ----------------
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  consecutive_errors    int not null default 0,
  total_runs            bigint not null default 0,
  total_articles        bigint not null default 0,

  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.profiles(id) on delete set null,

  -- ---- Güvenlik sınırları ---------------------------------
  -- Panelden saçma değer girilip IHA'nın limitinin delinmesini engeller
  constraint chk_poll     check (poll_interval_sec between 30 and 3600),
  constraint chk_timeout  check (request_timeout_sec between 5 and 120),
  constraint chk_retries  check (feed_max_retries between 0 and 10),
  constraint chk_items    check (max_items_per_run between 1 and 1000),
  constraint chk_mconc    check (media_concurrency between 1 and 16),
  constraint chk_mrate    check (media_rate_per_sec between 0.1 and 20),
  constraint chk_mattempt check (media_max_attempts between 1 and 20),
  constraint chk_iq       check (image_quality between 20 and 95),
  constraint chk_ifmt     check (image_format in ('avif','webp','jpeg')),
  constraint chk_vconc    check (video_concurrency between 1 and 4),
  constraint chk_vh       check (video_max_height in (360,480,720,1080)),
  constraint chk_vcrf1    check (video_crf_short between 18 and 35),
  constraint chk_vcrf2    check (video_crf_long  between 18 and 35),
  constraint chk_vpreset  check (video_preset in
    ('ultrafast','superfast','veryfast','faster','fast','medium','slow')),
  constraint chk_vthreads check (video_threads between 1 and 8),
  constraint chk_vskip    check (video_skip_over_sec between 60 and 14400),
  constraint chk_acool    check (alert_cooldown_min between 1 and 1440),
  constraint chk_amin     check (alert_min_consecutive between 1 and 20),
  constraint chk_acap     check (alert_daily_cap between 1 and 500),
  constraint chk_wstale   check (watchdog_stale_min between 2 and 180),
  constraint chk_email    check (alert_email is null or alert_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

insert into public.bot_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists bot_settings_touch on public.bot_settings;
create trigger bot_settings_touch before update on public.bot_settings
  for each row execute function public.tg_set_updated_at();

-- ============================================================
-- 3. BOT_RUNS — her turun kaydı (panel grafiği + watchdog)
-- ============================================================
create table if not exists public.bot_runs (
  id              bigserial primary key,
  status          public.bot_run_status not null default 'running',
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  duration_ms     int,

  items_seen      int not null default 0,
  items_created   int not null default 0,
  items_updated   int not null default 0,
  items_skipped   int not null default 0,
  items_failed    int not null default 0,

  media_queued    int not null default 0,
  media_done      int not null default 0,
  media_failed    int not null default 0,

  feed_bytes      int,
  feed_http_status int,
  error_message   text,
  meta            jsonb not null default '{}'::jsonb
);

create index if not exists bot_runs_recent_idx on public.bot_runs (started_at desc);
create index if not exists bot_runs_status_idx on public.bot_runs (status, started_at desc)
  where status in ('failed','partial');

-- ============================================================
-- 4. BOT_FAILURES — dead letter kuyruğu
--
--  SONSUZ RETRY YOK. max_attempts dolunca 'abandoned' olur,
--  panelde kırmızı görünür, insan bakar.
--  raw_payload ham veriyi tutar → elle kurtarma mümkün.
-- ============================================================
create table if not exists public.bot_failures (
  id           bigserial primary key,
  run_id       bigint references public.bot_runs(id) on delete set null,
  kind         public.bot_failure_kind not null,
  status       public.bot_failure_status not null default 'open',

  haber_kodu   text,
  article_id   uuid references public.articles(id) on delete cascade,
  media_id     uuid references public.media(id) on delete cascade,
  target_url   text,

  error_code   text,
  error_message text not null,
  stack        text,
  raw_payload  jsonb,          -- kurtarma için ham item

  attempts     int not null default 1,
  max_attempts int not null default 5,
  next_try_at  timestamptz,

  -- aynı hatayı gruplamak için parmak izi (dedup + alert)
  fingerprint  text not null,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references public.profiles(id) on delete set null,
  note          text
);

-- Açık hatalar parmak izine göre TEK satır → tablo şişmez
create unique index if not exists bot_failures_fp_open_idx
  on public.bot_failures (fingerprint) where status in ('open','retrying');

create index if not exists bot_failures_queue_idx
  on public.bot_failures (next_try_at) where status in ('open','retrying');
create index if not exists bot_failures_panel_idx
  on public.bot_failures (status, last_seen_at desc);
create index if not exists bot_failures_kod_idx
  on public.bot_failures (haber_kodu) where haber_kodu is not null;

-- ============================================================
-- 5. ALERT_LOG — mail bombardımanını önleyen katman
-- ============================================================
create table if not exists public.alert_log (
  id           bigserial primary key,
  severity     public.alert_severity not null default 'warning',
  fingerprint  text not null,
  subject      text not null,
  body         text,
  sent_at      timestamptz not null default now(),
  sent_to      text,
  delivered    boolean not null default false,
  smtp_error   text,
  occurrences  int not null default 1,   -- cooldown içinde kaç kez tekrarlandı
  meta         jsonb not null default '{}'::jsonb
);

create index if not exists alert_log_fp_idx on public.alert_log (fingerprint, sent_at desc);
create index if not exists alert_log_recent_idx on public.alert_log (sent_at desc);

-- ============================================================
-- 6. RLS
-- ============================================================
alter table public.bot_settings force row level security;
alter table public.bot_runs     force row level security;
alter table public.bot_failures force row level security;
alter table public.alert_log    force row level security;

-- Bot ayarları/logları SADECE staff görür. anon asla.
do $$
declare t text;
begin
  foreach t in array array['bot_settings','bot_runs','bot_failures','alert_log'] loop
    execute format('drop policy if exists %I_sel_staff on public.%I', t, t);
    execute format(
      'create policy %I_sel_staff on public.%I for select to authenticated using (public.is_staff())',
      t, t);
  end loop;
end $$;

-- Ayar DEĞİŞTİRME sadece admin
drop policy if exists bot_settings_upd_admin on public.bot_settings;
create policy bot_settings_upd_admin on public.bot_settings
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Hata çözümleme (resolve/abandon) sadece admin
drop policy if exists bot_failures_upd_admin on public.bot_failures;
create policy bot_failures_upd_admin on public.bot_failures
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 7. BOT RPC'LERİ  (service_role)
-- ============================================================

-- ---- 7.1 Tur başlat -----------------------------------------
-- Bot çalışmalı mı? Ayarları + izni tek çağrıda döner.
create or replace function public.bot_begin_run()
returns table (run_id bigint, allowed boolean, reason text, settings jsonb)
language plpgsql security definer set search_path = ''
as $$
declare s public.bot_settings; rid bigint;
begin
  select * into s from public.bot_settings where id;

  if not s.is_enabled then
    return query select null::bigint, false, 'bot_disabled', to_jsonb(s); return;
  end if;

  if s.paused_until is not null and s.paused_until > now() then
    return query select null::bigint, false,
      'paused_until:' || s.paused_until::text, to_jsonb(s); return;
  end if;

  -- Aralık dolmadıysa çalıştırma (çift tetiklenmeye karşı)
  if s.last_run_at is not null
     and s.last_run_at > now() - make_interval(secs => s.poll_interval_sec * 0.9) then
    return query select null::bigint, false, 'too_soon', to_jsonb(s); return;
  end if;

  insert into public.bot_runs (status) values ('running') returning id into rid;

  update public.bot_settings
     set last_run_at = now(), total_runs = total_runs + 1
   where id;

  return query select rid, true, null::text, to_jsonb(s);
end; $$;

-- ---- 7.2 Tur bitir ------------------------------------------
create or replace function public.bot_finish_run(
  p_run_id bigint,
  p_status public.bot_run_status,
  p_seen int default 0, p_created int default 0, p_updated int default 0,
  p_skipped int default 0, p_failed int default 0,
  p_media_queued int default 0, p_media_done int default 0, p_media_failed int default 0,
  p_error text default null, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
declare st timestamptz;
begin
  select started_at into st from public.bot_runs where id = p_run_id;

  update public.bot_runs set
    status = p_status, finished_at = now(),
    duration_ms = (extract(epoch from (now() - st)) * 1000)::int,
    items_seen = p_seen, items_created = p_created, items_updated = p_updated,
    items_skipped = p_skipped, items_failed = p_failed,
    media_queued = p_media_queued, media_done = p_media_done, media_failed = p_media_failed,
    error_message = p_error, meta = p_meta
  where id = p_run_id;

  if p_status in ('success','partial') then
    update public.bot_settings set
      last_success_at = now(),
      consecutive_errors = 0,
      total_articles = total_articles + p_created
    where id;
  else
    update public.bot_settings set
      consecutive_errors = consecutive_errors + 1
    where id;
  end if;
end; $$;

-- ---- 7.3 Circuit breaker ------------------------------------
-- Ardışık hata eşiği aşılınca bot kendini durdurur.
create or replace function public.bot_trip_breaker(
  p_minutes int default 5, p_reason text default 'consecutive_errors')
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare until_ts timestamptz := now() + make_interval(mins => greatest(p_minutes,1));
begin
  update public.bot_settings
     set paused_until = until_ts, pause_reason = left(p_reason, 500)
   where id;
  return until_ts;
end; $$;

-- ---- 7.4 Hata kaydet (upsert, dedup'lu) ---------------------
create or replace function public.bot_log_failure(
  p_kind public.bot_failure_kind,
  p_fingerprint text,
  p_error text,
  p_run_id bigint default null,
  p_haber_kodu text default null,
  p_article_id uuid default null,
  p_media_id uuid default null,
  p_target_url text default null,
  p_error_code text default null,
  p_stack text default null,
  p_raw jsonb default null,
  p_max_attempts int default 5,
  p_backoff_sec int default 300)
returns table (failure_id bigint, attempts int, exhausted boolean)
language plpgsql security definer set search_path = ''
as $$
declare f public.bot_failures;
begin
  insert into public.bot_failures (
    run_id, kind, fingerprint, error_message, haber_kodu, article_id, media_id,
    target_url, error_code, stack, raw_payload, max_attempts,
    next_try_at, status)
  values (
    p_run_id, p_kind, p_fingerprint, left(p_error, 4000), p_haber_kodu,
    p_article_id, p_media_id, p_target_url, p_error_code, left(p_stack, 8000),
    p_raw, p_max_attempts,
    now() + make_interval(secs => p_backoff_sec), 'open')
  on conflict (fingerprint) where status in ('open','retrying')
  do update set
    attempts      = public.bot_failures.attempts + 1,
    last_seen_at  = now(),
    error_message = left(p_error, 4000),
    run_id        = coalesce(p_run_id, public.bot_failures.run_id),
    -- üstel backoff, tavan 1 saat
    next_try_at   = now() + make_interval(
                      secs => least(p_backoff_sec * power(2, public.bot_failures.attempts)::int, 3600)),
    status        = case
                      when public.bot_failures.attempts + 1 >= public.bot_failures.max_attempts
                      then 'abandoned'::public.bot_failure_status
                      else 'retrying'::public.bot_failure_status end
  returning * into f;

  return query select f.id, f.attempts, (f.status = 'abandoned');
end; $$;

-- ---- 7.5 Hata çözüldü ---------------------------------------
create or replace function public.bot_resolve_failure(p_fingerprint text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  update public.bot_failures
     set status = 'resolved', resolved_at = now(), next_try_at = null
   where fingerprint = p_fingerprint and status in ('open','retrying');
end; $$;

-- ---- 7.6 Mail gönderilmeli mi? ------------------------------
--  Tüm bildirim mantığı TEK yerde. Bot sadece "gönderelim mi?"
--  diye sorar, cevap true ise SMTP'ye gider.
--  Koruma katmanları: enabled → eşik → günlük tavan → cooldown
create or replace function public.bot_should_alert(
  p_fingerprint text,
  p_severity public.alert_severity default 'warning')
returns table (should_send boolean, reason text, to_email text, suppressed int)
language plpgsql security definer set search_path = ''
as $$
declare
  s public.bot_settings;
  last_sent timestamptz;
  sent_today int;
  sup int := 0;
begin
  select * into s from public.bot_settings where id;

  if not s.alerts_enabled then
    return query select false, 'alerts_disabled', null::text, 0; return;
  end if;

  if coalesce(s.alert_email,'') = '' then
    return query select false, 'no_recipient', null::text, 0; return;
  end if;

  -- Günlük tavan: SMTP hesabının bloklanmasını önler
  select count(*) into sent_today from public.alert_log
   where sent_at > now() - interval '24 hours' and delivered;
  if sent_today >= s.alert_daily_cap then
    return query select false, 'daily_cap_reached', s.alert_email, 0; return;
  end if;

  -- Kritik hatalar cooldown'ı atlayabilir
  if p_severity = 'critical' and s.alert_critical_bypass then
    return query select true, 'critical_bypass', s.alert_email, 0; return;
  end if;

  -- Ardışık hata eşiği (uyarı seviyesi için)
  if p_severity = 'warning' and s.consecutive_errors < s.alert_min_consecutive then
    return query select false, 'below_threshold', s.alert_email, 0; return;
  end if;

  -- Cooldown: aynı parmak izi için sessizlik penceresi
  select max(sent_at) into last_sent from public.alert_log
   where fingerprint = p_fingerprint and delivered;

  if last_sent is not null
     and last_sent > now() - make_interval(mins => s.alert_cooldown_min) then
    -- bastırılan tekrarları say, mail gidince gövdeye yazılır
    update public.alert_log set occurrences = occurrences + 1
     where id = (select id from public.alert_log
                  where fingerprint = p_fingerprint and delivered
                  order by sent_at desc limit 1)
    returning occurrences into sup;
    return query select false, 'cooldown', s.alert_email, coalesce(sup,0); return;
  end if;

  return query select true, 'ok', s.alert_email, 0;
end; $$;

-- ---- 7.7 Gönderilen maili kaydet ----------------------------
create or replace function public.bot_record_alert(
  p_fingerprint text, p_subject text, p_body text,
  p_severity public.alert_severity default 'warning',
  p_to text default null, p_delivered boolean default true,
  p_smtp_error text default null, p_meta jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = ''
as $$
declare v_id bigint;
begin
  insert into public.alert_log (severity, fingerprint, subject, body, sent_to,
                                delivered, smtp_error, meta)
  values (p_severity, p_fingerprint, left(p_subject,300), left(p_body,20000),
          p_to, p_delivered, p_smtp_error, p_meta)
  returning id into v_id;
  return v_id;
end; $$;

-- ---- 7.8 Medyası bekleyen haberler --------------------------
create or replace function public.bot_pending_media(p_limit int default 50)
returns setof public.articles
language sql stable security definer set search_path = ''
as $$
  select * from public.articles
   where media_state in ('pending','retrying','partial')
     and deleted_at is null
     and (media_next_try is null or media_next_try <= now())
   order by media_next_try nulls first, published_at desc
   limit greatest(1, least(p_limit, 500));
$$;

-- ============================================================
-- 8. WATCHDOG
--
--  KRİTİK: Bot ölürse kendi ölümünü bildiremez. Bu fonksiyon
--  Supabase içinde (pg_cron) çalışır, bottan BAĞIMSIZDIR.
--  Panelden veya cron'dan çağrılır; alarm gerekiyorsa true döner.
-- ============================================================
create or replace function public.bot_watchdog_check()
returns table (is_stale boolean, minutes_since numeric, message text)
language plpgsql stable security definer set search_path = ''
as $$
declare s public.bot_settings; mins numeric;
begin
  select * into s from public.bot_settings where id;

  if not s.is_enabled or not s.watchdog_enabled then
    return query select false, 0::numeric, 'watchdog_off'; return;
  end if;
  if s.paused_until is not null and s.paused_until > now() then
    return query select false, 0::numeric, 'paused'; return;
  end if;

  mins := extract(epoch from (now() - coalesce(s.last_success_at, s.updated_at))) / 60;

  if mins > s.watchdog_stale_min then
    return query select true, mins,
      format('Bot %s dakikadır başarılı tur atmadı.', round(mins)); return;
  end if;

  return query select false, mins, 'ok';
end; $$;

-- ============================================================
-- 9. PANEL GÖRÜNÜMÜ — tek sorguda sağlık özeti
-- ============================================================
drop view if exists public.bot_health;
create view public.bot_health as
select
  s.is_enabled,
  s.paused_until,
  s.pause_reason,
  s.last_run_at,
  s.last_success_at,
  s.consecutive_errors,
  s.total_runs,
  s.total_articles,
  round(extract(epoch from (now() - s.last_success_at)) / 60) as minutes_since_success,
  (select count(*) from public.bot_failures where status in ('open','retrying')) as open_failures,
  (select count(*) from public.bot_failures where status = 'abandoned') as abandoned_failures,
  (select count(*) from public.articles
    where media_state in ('pending','retrying') and deleted_at is null) as media_pending,
  (select count(*) from public.articles
    where media_state = 'no_media' and deleted_at is null) as media_missing,
  (select count(*) from public.articles
    where created_at > now() - interval '24 hours' and deleted_at is null) as articles_24h,
  (select count(*) from public.bot_runs
    where started_at > now() - interval '24 hours' and status = 'failed') as failed_runs_24h,
  (select count(*) from public.alert_log
    where sent_at > now() - interval '24 hours' and delivered) as alerts_24h
from public.bot_settings s where s.id;

-- ============================================================
-- 10. TEMİZLİK — log tabloları sonsuza kadar büyümesin
-- ============================================================
-- Dönüş tipi ileride genişleyebilir (yama 10, +deletions_deleted).
-- CREATE OR REPLACE tip değişimine izin vermez → önce düşür.
drop function if exists public.bot_cleanup(int);

create or replace function public.bot_cleanup(p_keep_days int default 30)
returns table (runs_deleted int, failures_deleted int, alerts_deleted int)
language plpgsql security definer set search_path = ''
as $$
declare r int; f int; a int;
begin
  delete from public.bot_runs
   where started_at < now() - make_interval(days => p_keep_days)
     and status in ('success','skipped');
  get diagnostics r = row_count;

  delete from public.bot_failures
   where status = 'resolved' and resolved_at < now() - make_interval(days => p_keep_days);
  get diagnostics f = row_count;

  delete from public.alert_log
   where sent_at < now() - make_interval(days => p_keep_days * 3);
  get diagnostics a = row_count;

  return query select r, f, a;
end; $$;

-- ============================================================
-- 11. YETKİLER
-- ============================================================
revoke all on public.bot_settings, public.bot_runs,
               public.bot_failures, public.alert_log
  from public, anon, authenticated;

grant select on public.bot_settings, public.bot_runs,
                public.bot_failures, public.alert_log, public.bot_health
  to authenticated;
grant update on public.bot_settings, public.bot_failures to authenticated;

-- Bot fonksiyonları: SADECE service_role
revoke all on function
  public.bot_begin_run(),
  public.bot_finish_run(bigint, public.bot_run_status, int,int,int,int,int,int,int,int,text,jsonb),
  public.bot_trip_breaker(int,text),
  public.bot_log_failure(public.bot_failure_kind,text,text,bigint,text,uuid,uuid,text,text,text,jsonb,int,int),
  public.bot_resolve_failure(text),
  public.bot_should_alert(text, public.alert_severity),
  public.bot_record_alert(text,text,text,public.alert_severity,text,boolean,text,jsonb),
  public.bot_pending_media(int),
  public.bot_cleanup(int)
  from public, anon, authenticated;

grant execute on function
  public.bot_begin_run(),
  public.bot_finish_run(bigint, public.bot_run_status, int,int,int,int,int,int,int,int,text,jsonb),
  public.bot_trip_breaker(int,text),
  public.bot_log_failure(public.bot_failure_kind,text,text,bigint,text,uuid,uuid,text,text,text,jsonb,int,int),
  public.bot_resolve_failure(text),
  public.bot_should_alert(text, public.alert_severity),
  public.bot_record_alert(text,text,text,public.alert_severity,text,boolean,text,jsonb),
  public.bot_pending_media(int),
  public.bot_cleanup(int)
  to service_role;

-- Watchdog'u panel de çağırabilsin
grant execute on function public.bot_watchdog_check() to authenticated, service_role;

-- ============================================================
-- 12. KURULUM SONRASI
--
--  Bot varsayılan olarak KAPALI geldi. Kod hazır olunca aç:
--
--    update public.bot_settings set
--      is_enabled  = true,
--      alert_email = 'senin@mail.com'
--    where id;
--
--  Sağlık kontrolü:
--    select * from public.bot_health;
-- ============================================================

select 'Bot kontrol katmanı hazır. Bot KAPALI durumda (bölüm 12).' as durum;


-- ============================================================
--  POSTGREST ŞEMA ÖNBELLEĞİNİ YENİLE
--
--  Supabase'de yeni RPC fonksiyonları anında görünmez; PostgREST
--  şemayı önbellekte tutar. Bu olmadan bot şu hatayı alır:
--    PGRST202: Could not find the function ... in the schema cache
-- ============================================================
notify pgrst, 'reload schema';
