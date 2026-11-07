-- ============================================================
-- Court schedules: weekly sessions attached to a court, and the review list
-- that keeps them right.
--
-- Brian's decisions (2026-11-06):
--   * Repeating sessions (Bushrod Park's open play nights) belong to the court,
--     as a weekly calendar. The events feed keeps hosted one-offs.
--   * Schedules don't count toward NEW and never push players on their own.
--   * A weekly check of an approved page list; nothing publishes itself.
--     Agreed with Expo-Foundations (2026-11-07): the check stores a hash and
--     the check time, never page text; robots.txt is honored; no Facebook, no
--     Meetup, nothing behind a login. A changed page goes on the review list
--     for a person to open.
--   * Facts only, always with a source. No copied descriptions.
--
-- ── Tables (RLS on, no policies: RPCs only) ────────────────────────────────
--   court_schedule_sources (id, name, url, url_key, method fetch | manual,
--     terms_checked_at, notes, active, content_hash, last_checked_at,
--     last_changed_at, last_status). The check reads a page only when method
--     is fetch, it's active and terms_checked_at is set.
--   court_sessions (id, venue_id, title, days, start_time, end_time, tz, level,
--     cost, note, organizer_name, source_name, source_url, source_id,
--     valid_from, valid_to, skip_dates, last_verified_at, hidden_at, ...).
--     days: the weekday mask, Mon = 1 ... Sun = 64 (kit /scheduling/weekdayMask).
--     valid_from, valid_to (inclusive), skip_dates: dates at the court.
--   court_schedule_proposals (id, kind page_changed | suggestion, source_id,
--     venue_id, proposed_by, note, status pending | applied | dismissed, ...).
--
-- ── Client RPCs (authenticated, in the hardening allowlist) ────────────────
--   list_court_sessions(p_venue_id text) -> jsonb [row]
--   nearby_court_schedules() -> jsonb {court_count, session_count,
--     courts: [{venue_id, name, city, session_count}]}: within 40 km of my home
--     location, nearest first; no home location: every court, by name.
--   suggest_court_schedule(p_venue_id text, p_note text) -> uuid
--   row: PlaceSession in the kit's /placeSchedule: {id, place_id, title, days,
--     start_time, end_time, tz, level, cost, note, organizer_name, source_name,
--     source_url, valid_from, valid_to, skip_dates, last_verified_at}
--
-- ── Admin RPCs (godmode only) ──────────────────────────────────────────────
--   admin_schedule_review() -> jsonb {proposals: [...], sources: [...]}
--   admin_resolve_schedule_proposal(p_id, p_status) -> void
--     applied: the page was read and the sessions are right, so its sessions
--     count as confirmed today.
--   admin_save_court_session(...) -> uuid
--   admin_set_court_session_hidden(p_id, p_hidden) -> void
--
-- ── Service role only (supabase/functions/check-schedule-sources) ──────────
--   schedule_source_checked(p_id, p_status, p_hash) -> text same | changed |
--     first | skipped
--   schedule_check_notify(p_changed int) -> void: one push to the admins.
--
-- Listed = not hidden, valid_to not past at the court, and confirmed in the
-- last 180 days (the kit's SCHEDULE_HIDE_DAYS).
--
-- Errors carry a pl:schedules.* hint for the app's refusal copy.
-- Safe to re-run.
-- Run: supabase db query --linked -f supabase/migration_court_schedules.sql
-- ============================================================

-- ════ 1. Tables ══════════════════════════════════════════════════════════
create table if not exists public.court_schedule_sources (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  url              text not null,
  url_key          text not null unique,
  method           text not null default 'manual',
  terms_checked_at timestamptz,
  notes            text,
  active           boolean not null default true,
  content_hash     text,
  last_checked_at  timestamptz,
  last_changed_at  timestamptz,
  last_status      text,
  created_at       timestamptz not null default now(),
  constraint court_schedule_sources_method_chk check (method in ('fetch', 'manual'))
);
comment on table public.court_schedule_sources is
  'Pages the weekly schedule check may read (migration_court_schedules.sql). A hash and the check time only, never page text. RLS on, no policy: RPCs only.';

create table if not exists public.court_sessions (
  id               uuid primary key default gen_random_uuid(),
  venue_id         text not null references public.venues (id) on delete cascade,
  title            text not null,
  days             smallint not null,
  start_time       time not null,
  end_time         time,
  tz               text not null default 'America/Los_Angeles',
  level            text,
  cost             text,
  note             text,
  organizer_name   text,
  source_name      text,
  source_url       text,
  source_id        uuid references public.court_schedule_sources (id) on delete set null,
  valid_from       date,
  valid_to         date,
  skip_dates       date[] not null default '{}',
  last_verified_at timestamptz not null default now(),
  hidden_at        timestamptz,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint court_sessions_shape check (
    nullif(btrim(title), '') is not null and char_length(title) <= 120
    and days between 1 and 127
    and (end_time is null or end_time > start_time)
    and (valid_from is null or valid_to is null or valid_to >= valid_from)
    and (level is null or char_length(level) <= 60)
    and (cost is null or char_length(cost) <= 80)
    and (note is null or char_length(note) <= 160)
    and (source_url is null or source_url ~* '^https?://[^ ]+$')
  )
);
create index if not exists court_sessions_venue_idx on public.court_sessions (venue_id) where hidden_at is null;
create index if not exists court_sessions_source_idx on public.court_sessions (source_id);
comment on table public.court_sessions is
  'Weekly sessions at a court (migration_court_schedules.sql). Not events: they never reach the events feed, NEW counts or pushes. RLS on, no policy: RPCs only.';

create table if not exists public.court_schedule_proposals (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  source_id   uuid references public.court_schedule_sources (id) on delete cascade,
  venue_id    text references public.venues (id) on delete cascade,
  proposed_by uuid references public.profiles (id) on delete set null,
  note        text,
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  constraint court_schedule_proposals_kind_chk check (kind in ('page_changed', 'suggestion')),
  constraint court_schedule_proposals_status_chk check (status in ('pending', 'applied', 'dismissed')),
  constraint court_schedule_proposals_note_chk check (note is null or char_length(note) <= 500)
);
create unique index if not exists court_schedule_proposals_one_pending_page
  on public.court_schedule_proposals (source_id) where status = 'pending' and kind = 'page_changed';
create index if not exists court_schedule_proposals_pending_idx
  on public.court_schedule_proposals (created_at) where status = 'pending';
create index if not exists court_schedule_proposals_by_idx on public.court_schedule_proposals (proposed_by, created_at);
comment on table public.court_schedule_proposals is
  'The schedule review list (migration_court_schedules.sql): a changed page or a player suggestion, read by a person. RLS on, no policy: RPCs only.';

alter table public.court_schedule_sources enable row level security;
alter table public.court_sessions enable row level security;
alter table public.court_schedule_proposals enable row level security;

revoke all on table public.court_schedule_sources from public, anon, authenticated;
revoke all on table public.court_sessions from public, anon, authenticated;
revoke all on table public.court_schedule_proposals from public, anon, authenticated;


-- ════ 2. Helpers ═════════════════════════════════════════════════════════
create or replace function public._pl_court_session_listed(s public.court_sessions)
returns boolean
language sql
stable
set search_path = ''
as $$
  select s.hidden_at is null
     and (s.valid_to is null or s.valid_to >= (now() at time zone s.tz)::date)
     and s.last_verified_at > now() - interval '180 days'
$$;
revoke all on function public._pl_court_session_listed(public.court_sessions) from public, anon, authenticated;

create or replace function public._pl_court_session_json(s public.court_sessions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'place_id', s.venue_id, 'title', s.title, 'days', s.days,
    'start_time', to_char(s.start_time, 'HH24:MI'), 'end_time', to_char(s.end_time, 'HH24:MI'),
    'tz', s.tz, 'level', s.level, 'cost', s.cost, 'note', s.note,
    'organizer_name', s.organizer_name, 'source_name', s.source_name, 'source_url', s.source_url,
    'valid_from', s.valid_from, 'valid_to', s.valid_to, 'skip_dates', to_jsonb(s.skip_dates),
    'last_verified_at', s.last_verified_at)
$$;
revoke all on function public._pl_court_session_json(public.court_sessions) from public, anon, authenticated;

create or replace function public._pl_schedule_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_godmode_user(v_uid) then
    raise exception using message = 'Only the Pickleague team edits court schedules.', hint = 'pl:schedules.admin_only';
  end if;
  return v_uid;
end $$;
revoke all on function public._pl_schedule_admin() from public, anon, authenticated;


-- ════ 3. Client RPCs ═════════════════════════════════════════════════════
create or replace function public.list_court_sessions(p_venue_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public._pl_court_session_json(s) order by s.start_time, s.title), '[]'::jsonb)
    from public.court_sessions s
   where auth.uid() is not null
     and s.venue_id = p_venue_id
     and public._pl_court_session_listed(s)
$$;
revoke all on function public.list_court_sessions(text) from public, anon;
grant execute on function public.list_court_sessions(text) to authenticated;

create or replace function public.nearby_court_schedules()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select h.lat, h.lng from public.profile_home_locations h where h.profile_id = auth.uid()
  ), courts as (
    select v.id, v.name, v.city, count(*)::int as n,
           (select public.haversine_meters(m.lat, m.lng, v.lat, v.lng) from me m) as meters
      from public.court_sessions s
      join public.venues v on v.id = s.venue_id
     where auth.uid() is not null
       and public._pl_court_session_listed(s)
     group by v.id, v.name, v.city, v.lat, v.lng
  ), near as (
    select * from courts where meters is null or meters <= 40000
  )
  select jsonb_build_object(
    'court_count', (select count(*) from near),
    'session_count', (select coalesce(sum(n), 0) from near),
    'courts', coalesce((
      select jsonb_agg(jsonb_build_object('venue_id', c.id, 'name', c.name, 'city', c.city, 'session_count', c.n)
                       order by c.meters nulls last, c.name)
        from near c), '[]'::jsonb))
$$;
revoke all on function public.nearby_court_schedules() from public, anon;
grant execute on function public.nearby_court_schedules() to authenticated;

-- A player suggests or corrects a court's schedule. It only reaches the review
-- list, and the review list only reaches a person.
create or replace function public.suggest_court_schedule(p_venue_id text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id   uuid;
begin
  if v_uid is null then
    raise exception using message = 'Sign in to suggest a schedule.', hint = 'pl:schedules.sign_in';
  end if;
  if v_note is null or char_length(v_note) < 5 or char_length(v_note) > 500 then
    raise exception using message = 'Tell us the days and times, in up to 500 characters.', hint = 'pl:schedules.note';
  end if;
  if not exists (select 1 from public.venues v where v.id = p_venue_id) then
    raise exception using message = 'That court isn''t listed any more. Go back and pick another.', hint = 'pl:schedules.gone';
  end if;
  if (select count(*) from public.court_schedule_proposals p
       where p.proposed_by = v_uid and p.created_at > now() - interval '1 day') >= 3 then
    raise exception using message = 'That''s 3 suggestions today. Thanks! Try again tomorrow.', hint = 'pl:schedules.limit';
  end if;

  insert into public.court_schedule_proposals (kind, venue_id, proposed_by, note)
  values ('suggestion', p_venue_id, v_uid, v_note)
  returning id into v_id;

  begin
    insert into public.push_outbox (recipient_id, kind, title, body, deep_link, expires_at, push_data)
    select p.id, 'info', '📅 Schedule suggestion',
           'A player suggested a court schedule. Open the schedule review.',
           'admin/schedules', now() + interval '7 days',
           jsonb_build_object('kind', 'court_schedule_suggestion')
      from public.profiles p
     where public.is_godmode_user(p.id) and p.id <> v_uid;
  exception when others then
    raise warning 'schedule suggestion push not queued: %', sqlerrm;
  end;
  return v_id;
end $$;
revoke all on function public.suggest_court_schedule(text, text) from public, anon;
grant execute on function public.suggest_court_schedule(text, text) to authenticated;


-- ════ 4. Admin RPCs ══════════════════════════════════════════════════════
create or replace function public.admin_schedule_review()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public._pl_schedule_admin();
  return jsonb_build_object(
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'kind', p.kind, 'note', p.note, 'created_at', p.created_at,
               'venue_id', p.venue_id, 'venue_name', v.name,
               'source_id', p.source_id, 'source_name', s.name, 'source_url', s.url)
             order by p.created_at)
        from public.court_schedule_proposals p
        left join public.venues v on v.id = p.venue_id
        left join public.court_schedule_sources s on s.id = p.source_id
       where p.status = 'pending'), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'url', s.url, 'method', s.method, 'active', s.active,
               'terms_checked', s.terms_checked_at is not null, 'notes', s.notes,
               'last_checked_at', s.last_checked_at, 'last_changed_at', s.last_changed_at,
               'last_status', s.last_status)
             order by s.name)
        from public.court_schedule_sources s), '[]'::jsonb));
end $$;
revoke all on function public.admin_schedule_review() from public, anon;
grant execute on function public.admin_schedule_review() to authenticated;

create or replace function public.admin_resolve_schedule_proposal(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._pl_schedule_admin();
  v_src uuid;
begin
  if p_status not in ('applied', 'dismissed') then
    raise exception using message = 'Pick Done or Dismiss.', hint = 'pl:schedules.status';
  end if;
  update public.court_schedule_proposals
     set status = p_status, reviewed_at = now(), reviewed_by = v_uid
   where id = p_id and status = 'pending'
   returning source_id into v_src;
  if not found then
    raise exception using message = 'That one was already reviewed. Pull to refresh.', hint = 'pl:schedules.gone';
  end if;
  if p_status = 'applied' and v_src is not null then
    update public.court_sessions set last_verified_at = now(), updated_at = now() where source_id = v_src;
  end if;
end $$;
revoke all on function public.admin_resolve_schedule_proposal(uuid, text) from public, anon;
grant execute on function public.admin_resolve_schedule_proposal(uuid, text) to authenticated;

create or replace function public.admin_save_court_session(
  p_id             uuid,
  p_venue_id       text,
  p_title          text,
  p_days           integer,
  p_start_time     time,
  p_end_time       time default null,
  p_level          text default null,
  p_cost           text default null,
  p_note           text default null,
  p_organizer_name text default null,
  p_source_name    text default null,
  p_source_url     text default null,
  p_valid_from     date default null,
  p_valid_to       date default null,
  p_skip_dates     date[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := public._pl_schedule_admin();
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_url   text := nullif(btrim(coalesce(p_source_url, '')), '');
  v_id    uuid := p_id;
begin
  if v_title is null or char_length(v_title) > 120 then
    raise exception using message = 'The session needs a title (up to 120 characters).', hint = 'pl:schedules.title';
  end if;
  if p_days is null or p_days not between 1 and 127 then
    raise exception using message = 'Pick at least one day.', hint = 'pl:schedules.days';
  end if;
  if p_start_time is null or (p_end_time is not null and p_end_time <= p_start_time) then
    raise exception using message = 'Check the times: the end has to be after the start.', hint = 'pl:schedules.time';
  end if;
  if v_url is not null and v_url !~* '^https?://[^ ]+$' then
    raise exception using message = 'The source link has to start with https://', hint = 'pl:schedules.link';
  end if;
  if not exists (select 1 from public.venues v where v.id = p_venue_id) then
    raise exception using message = 'That court isn''t listed any more. Go back and pick another.', hint = 'pl:schedules.gone';
  end if;

  if v_id is null then
    insert into public.court_sessions (
      venue_id, title, days, start_time, end_time, level, cost, note, organizer_name,
      source_name, source_url, source_id, valid_from, valid_to, skip_dates, created_by)
    values (
      p_venue_id, v_title, p_days, p_start_time, p_end_time, nullif(btrim(p_level), ''), nullif(btrim(p_cost), ''),
      nullif(btrim(p_note), ''), nullif(btrim(p_organizer_name), ''), nullif(btrim(p_source_name), ''), v_url,
      (select s.id from public.court_schedule_sources s where s.url_key = public._pl_outside_url_key(v_url)),
      p_valid_from, p_valid_to, coalesce(p_skip_dates, '{}'), v_uid)
    returning id into v_id;
  else
    update public.court_sessions
       set venue_id = p_venue_id, title = v_title, days = p_days, start_time = p_start_time, end_time = p_end_time,
           level = nullif(btrim(p_level), ''), cost = nullif(btrim(p_cost), ''), note = nullif(btrim(p_note), ''),
           organizer_name = nullif(btrim(p_organizer_name), ''), source_name = nullif(btrim(p_source_name), ''),
           source_url = v_url,
           source_id = (select s.id from public.court_schedule_sources s where s.url_key = public._pl_outside_url_key(v_url)),
           valid_from = p_valid_from, valid_to = p_valid_to, skip_dates = coalesce(p_skip_dates, '{}'),
           last_verified_at = now(), updated_at = now()
     where id = v_id;
    if not found then
      raise exception using message = 'That session is gone. Pull to refresh.', hint = 'pl:schedules.gone';
    end if;
  end if;
  return v_id;
end $$;
revoke all on function public.admin_save_court_session(uuid, text, text, integer, time, time, text, text, text, text, text, text, date, date, date[]) from public, anon;
grant execute on function public.admin_save_court_session(uuid, text, text, integer, time, time, text, text, text, text, text, text, date, date, date[]) to authenticated;

create or replace function public.admin_set_court_session_hidden(p_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._pl_schedule_admin();
  update public.court_sessions
     set hidden_at = case when p_hidden then now() end, updated_at = now()
   where id = p_id;
  if not found then
    raise exception using message = 'That session is gone. Pull to refresh.', hint = 'pl:schedules.gone';
  end if;
end $$;
revoke all on function public.admin_set_court_session_hidden(uuid, boolean) from public, anon;
grant execute on function public.admin_set_court_session_hidden(uuid, boolean) to authenticated;


-- ════ 5. The weekly check (service role only) ════════════════════════════
-- Records one page's check. The same hash keeps that page's sessions
-- confirmed. A new hash puts the page on the review list once. A page that
-- can't be read changes nothing but last_status, so its sessions age out.
create or replace function public.schedule_source_checked(p_id uuid, p_status text, p_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  select s.content_hash into v_old from public.court_schedule_sources s where s.id = p_id for update;
  if not found then
    return 'skipped';
  end if;
  update public.court_schedule_sources
     set last_checked_at = now(), last_status = left(p_status, 80)
   where id = p_id;
  if p_hash is null then
    return 'skipped';
  end if;
  if v_old is null then
    update public.court_schedule_sources set content_hash = p_hash where id = p_id;
    return 'first';
  end if;
  if v_old = p_hash then
    update public.court_sessions set last_verified_at = now() where source_id = p_id;
    return 'same';
  end if;
  update public.court_schedule_sources
     set content_hash = p_hash, last_changed_at = now()
   where id = p_id;
  insert into public.court_schedule_proposals (kind, source_id)
  values ('page_changed', p_id)
  on conflict (source_id) where status = 'pending' and kind = 'page_changed' do nothing;
  return 'changed';
end $$;
revoke all on function public.schedule_source_checked(uuid, text, text) from public, anon, authenticated;
grant execute on function public.schedule_source_checked(uuid, text, text) to service_role;

-- At most one push a week, to the admins only.
create or replace function public.schedule_check_notify(p_changed integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(p_changed, 0) <= 0 then
    return;
  end if;
  insert into public.push_outbox (recipient_id, kind, title, body, deep_link, expires_at, push_data)
  select p.id, 'info', '📅 Court schedules to review',
         format('%s %s changed this week. Open the schedule review.', p_changed,
                case when p_changed = 1 then 'page' else 'pages' end),
         'admin/schedules', now() + interval '7 days',
         jsonb_build_object('kind', 'court_schedule_review')
    from public.profiles p
   where public.is_godmode_user(p.id);
end $$;
revoke all on function public.schedule_check_notify(integer) from public, anon, authenticated;
grant execute on function public.schedule_check_notify(integer) to service_role;

-- The cron job's call. Until private.app_config has schedule_check_url the job
-- does nothing: setting that key is what turns the check on.
create or replace function public._pl_schedule_check_post()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from private.app_config where key = 'schedule_check_url';
  select value into v_secret from private.app_config where key = 'send_push_secret';
  if v_url is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', coalesce(v_secret, '')),
    timeout_milliseconds := 60000
  );
end $$;
revoke all on function public._pl_schedule_check_post() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pickleague-schedule-check') then
    perform cron.unschedule('pickleague-schedule-check');
  end if;
  -- Mondays, 16:00 UTC.
  perform cron.schedule('pickleague-schedule-check', '0 16 * * 1', $c$ select public._pl_schedule_check_post(); $c$);
end $$;


-- ════ 6. The first courts, sources and sessions ══════════════════════════
-- Ocean View Park was pinned to a lessons business and Iron Horse Gym had no
-- court. Addresses and points: OpenStreetMap Nominatim, 2026-11-07.
insert into public.venues (id, sport, name, kind, lat, lng, address, city, source, indoor)
values
  ('curated:ocean-view-park-albany', array['pickleball'], 'Ocean View Park', 'court',
   37.8866297, -122.3031591, '900 Buchanan St, Albany, CA 94706', 'Albany', 'curated', false),
  ('curated:iron-horse-gym-san-ramon', array['pickleball'], 'Iron Horse Gym', 'court',
   37.7704670, -121.9566290, '12601 Alcosta Blvd, San Ramon, CA 94583', 'San Ramon', 'curated', true)
on conflict (id) do nothing;

-- Pages that return 403 to a plain request stay manual: a person checks them.
insert into public.court_schedule_sources (name, url, url_key, method, terms_checked_at, notes)
select v.name, v.url, public._pl_outside_url_key(v.url), v.method, v.terms::timestamptz, v.notes
  from (values
    ('City of Albany', 'https://www.albanyca.gov/News-Articles/2026/Announcements/Outdoor-Pickleball-Open-Play-Coming-to-Ocean-View-Park', 'fetch', '2026-11-07', 'robots.txt allows this path; the home page links no site terms (2026-11-07).'),
    ('BORP', 'https://www.borp.org/pickleball-for-all/', 'fetch', '2026-11-07', 'robots.txt allows this path; the home page links no site terms (2026-11-07).'),
    ('City of San Ramon', 'https://www.sanramon.ca.gov/our_city/departments_and_divisions/parks_community_services/sports_fitness/pickleball', 'fetch', '2026-11-07', 'robots.txt allows this path; the home page links no site terms (2026-11-07).'),
    ('LARPD', 'https://www.larpd.org/adult-pickleball-fall-2026', 'fetch', '2026-11-07', 'robots.txt allows this path; its terms of use ban harvesting personal data, not reading a public page (2026-11-07). Seasonal page: a new season has a new link.'),
    ('City of Walnut Creek', 'https://www.walnutcreekartsrec.org/programs-activities/sports/drop-in-sports', 'manual', null, 'Answered 403 on 2026-11-06.'),
    ('City of Fremont', 'https://fremont.gov/government/departments/parks-recreation/camps-classes/sports', 'manual', null, 'Answered 403 on 2026-11-06.'),
    ('City of Lafayette', 'https://www.lovelafayette.org/city-hall/city-departments/parks-trails-recreation/lafayette-rink', 'manual', null, 'Answered 403 on 2026-11-06.')
  ) as v(name, url, method, terms, notes)
on conflict (url_key) do nothing;

insert into public.court_sessions (
  venue_id, title, days, start_time, end_time, level, cost, note, organizer_name,
  source_name, source_url, source_id, valid_from, valid_to, skip_dates, last_verified_at)
select v.venue_id, v.title, v.days, v.start_time::time, v.end_time::time, v.level, v.cost, v.note, v.organizer,
       v.source_name, v.source_url, s.id, v.valid_from::date, v.valid_to::date, v.skip_dates::date[], '2026-11-06'::timestamptz
  from (values
    ('curated:ocean-view-park-albany', 'Outdoor open play', 2, '16:00', '18:00', 'All levels', null,
     'Self-directed. Bring paddles and balls.', 'City of Albany', 'City of Albany',
     'https://www.albanyca.gov/News-Articles/2026/Announcements/Outdoor-Pickleball-Open-Play-Coming-to-Ocean-View-Park',
     null, null, '{}'),
    ('curated:ocean-view-park-albany', 'Adaptive and inclusive pickleball', 8, '17:00', '18:30', 'Any age and level', null,
     'First visit needs a BORP membership and sign-up form.', 'BORP', 'BORP',
     'https://www.borp.org/pickleball-for-all/', null, null, '{2026-11-26}'),
    ('curated:ocean-view-park-albany', 'Adaptive and inclusive pickleball', 32, '13:00', '16:00', 'Any age and level', null,
     'First visit needs a BORP membership and sign-up form.', 'BORP', 'BORP',
     'https://www.borp.org/pickleball-for-all/', null, null, '{}'),
    ('curated:iron-horse-gym-san-ramon', 'Open gym', 64, '18:00', '21:00', 'All levels', '$7 daily entry or passes',
     'Six courts. Under-18s need an adult.', 'City of San Ramon', 'City of San Ramon',
     'https://www.sanramon.ca.gov/our_city/departments_and_divisions/parks_community_services/sports_fitness/pickleball',
     '2026-11-15', null, '{}'),
    ('g:ChIJ9Z96VQDnj4ARm1XtJ4sTMvs', 'Daytime drop-in', 10, '11:30', '14:30', 'Adults 18+', '$7 adults, $6 seniors 55+',
     'In the community center gym.', 'LARPD', 'LARPD',
     'https://www.larpd.org/adult-pickleball-fall-2026', null, '2026-12-17', '{2026-11-24,2026-11-26}'),
    ('g:ChIJ9Z96VQDnj4ARm1XtJ4sTMvs', 'Evening drop-in', 4, '18:00', '21:00', 'Adults 18+', '$7 adults, $6 seniors 55+',
     'In the community center gym.', 'LARPD', 'LARPD',
     'https://www.larpd.org/adult-pickleball-fall-2026', null, '2026-12-16', '{2026-11-11,2026-11-25}')
  ) as v(venue_id, title, days, start_time, end_time, level, cost, note, organizer, source_name, source_url, valid_from, valid_to, skip_dates)
  join public.court_schedule_sources s on s.url_key = public._pl_outside_url_key(v.source_url)
 where exists (select 1 from public.venues c where c.id = v.venue_id)
   and not exists (
     select 1 from public.court_sessions x
      where x.venue_id = v.venue_id and x.title = v.title and x.days = v.days);

-- These five series were imported as 16 event rows. They're court sessions
-- now, so the feed is left for hosted one-offs. admin_set_outside_event_hidden
-- with null brings a row back.
update public.outside_events e
   set hidden_reason = 'removed by Pickleague', hidden_at = now()
 where e.hidden_at is null
   and e.created_at < '2026-11-08'
   and public._pl_outside_url_key(e.source_url) in (
     select s.url_key from public.court_schedule_sources s where s.method = 'fetch')
   and not exists (select 1 from public.outside_event_rsvps r where r.event_id = e.id);

notify pgrst, 'reload schema';
