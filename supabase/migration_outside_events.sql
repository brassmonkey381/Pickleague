-- ============================================================
-- Outside events (2026-11-06): Doggle's outside events
-- (doggle/db/migrations/0505, 0506, 0507, 0518; DOG-021) ported to
-- Pickleague. Real pickleball events other people organize (rec-center open
-- play, club socials, clinics, round robins, ladders, tournaments), listed
-- "via <source>" with a "View original event" link, so Pickleague players
-- find each other there.
--
-- Pickleague has no public meetups to fold them into (league_events belong to
-- a league, drill_sessions to two players), so they get their own table,
-- pinned to a Pickleague court when one is within 150 m.
--
-- Brian's decisions (2026-11-06):
--   * Shown within 40 km of the player's home court (profiles.home_court_lat
--     / home_court_lng). No home court, or an event with no point: shown.
--   * Each event has 1 or 2 kinds (open_play, round_robin, clinic, ladder,
--     tournament, social), filtered with a chip on the Events screen.
--   * Same rules as Doggle:
--       - Never Pickleague's: no Pickleague host; always source_name +
--         source_url, shown "via <source>" with "View original event".
--       - Facts only: title, times, place, organizer, source, kinds, plus our
--         OWN one-line summary (max 160 characters). No copied descriptions,
--         no photos. No scraping: rows come from the admin form or the seed
--         importer (scripts/import-outside-events.mjs).
--       - Report a problem (cancelled / wrong time / wrong place): one report
--         per person; 2 people since the last admin review hide it with the
--         most-reported reason; every report pushes the admins.
--       - A takedown ("organizer asked") hides every date from that page and
--         blocks re-adding it.
--       - Past events drop out: ends_at passed, or (no end) the start passed
--         an hour ago.
--       - Interested = an RSVP "maybe". An outside event reaches the Home
--         feed only after Interested or Going (list_outside_events p_mine).
--       - No pickles and no pickleballs for an RSVP (nothing here touches
--         pickle_ledger or _pl_track_add_xp).
--       - Launch switch app_settings.outside_events_live, default false:
--         until it is true, only godmode users see outside events.
--
-- ── Tables (RLS on, no policies: RPCs only) ────────────────────────────────
--   outside_events (id, title, starts_at, ends_at, kinds text[1..2], summary,
--     organizer_name, source_name, source_url, place_name, place_address,
--     venue_id -> venues, lat, lng, last_verified_at, hidden_reason,
--     hidden_at, reports_cleared_at, created_by, created_at, updated_at).
--     One row per (source page, start time); a recurring event's dates are
--     separate rows.
--   outside_event_rsvps (event_id, profile_id, status going | maybe).
--   outside_event_reports (event_id, profile_id, reason).
--   outside_event_seen (profile_id, event_id, seen_at): the NEW count.
--
-- ── Client RPCs (authenticated, in the hardening allowlist) ────────────────
--   list_outside_events(p_kinds text[] default null, p_mine boolean default false)
--     -> jsonb [row]: listed events near me, soonest first (at most 200).
--     p_kinds: only events with any of these kinds. p_mine: only the ones I
--     marked Interested or Going (the Home feed's source).
--   get_outside_event(p_id uuid) -> jsonb row or null. Also answers a hidden
--     or past event I RSVP'd to (with hidden_reason / past), so its screen
--     can say why it's gone.
--   set_outside_event_rsvp(p_id uuid, p_status text) -> jsonb
--     {my_status, going_count, interested_count}. p_status going | maybe |
--     null (clear). Clearing always works; setting needs a listed event.
--   report_outside_event(p_id uuid, p_reason text) -> jsonb
--     {status reported | updated | hidden, reports, hidden, hidden_reason}
--   mark_outside_events_seen(p_ids uuid[]) -> integer (newly seen)
--   count_new_outside_events() -> integer (listed for me, not seen)
--   row: {id, title, starts_at, ends_at, kinds, summary, organizer_name,
--     source_name, source_url, place_name, place_address, venue_id,
--     venue_name, lat, lng, last_verified_at, going_count, interested_count,
--     my_status, my_report, seen, hidden_reason, past}
--
-- ── Admin RPCs (godmode only) ──────────────────────────────────────────────
--   admin_save_outside_event(p_id, p_title, p_starts_at, p_ends_at, p_kinds,
--     p_summary, p_organizer_name, p_source_name, p_source_url, p_place_name,
--     p_place_address, p_lat, p_lng, p_venue_id) -> uuid
--   admin_mark_outside_event_checked(p_id) -> timestamptz
--   admin_set_outside_event_hidden(p_id, p_reason) -> integer (rows)
--     'organizer asked' | 'removed by Pickleague' | null (show again, clears
--     the reports so far)
--   admin_list_outside_events() -> jsonb (upcoming, hidden ones too)
--
-- ── Marketing ──────────────────────────────────────────────────────────────
--   view public.upcoming_outside_events: the next 7 days, listed only.
--   Service role only.
--
-- Errors carry a pl:events.* hint for the app's refusal copy.
-- Safe to re-run.
-- Run: supabase db query --linked -f supabase/migration_outside_events.sql
-- ============================================================

-- ════ 1. Tables ══════════════════════════════════════════════════════════
create table if not exists public.outside_events (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  starts_at          timestamptz not null,
  ends_at            timestamptz,
  kinds              text[] not null,
  summary            text,
  organizer_name     text,
  source_name        text not null,
  source_url         text not null,
  place_name         text,
  place_address      text,
  venue_id           text references public.venues (id) on delete set null,
  lat                double precision,
  lng                double precision,
  last_verified_at   timestamptz not null default now(),
  hidden_reason      text,
  hidden_at          timestamptz,
  reports_cleared_at timestamptz,
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.outside_events drop constraint if exists outside_events_shape;
alter table public.outside_events add constraint outside_events_shape check (
  nullif(btrim(title), '') is not null and char_length(title) <= 120
  and nullif(btrim(source_name), '') is not null
  and source_url ~* '^https?://[^ ]+$'
  and (summary is null or char_length(summary) <= 160)
  and (ends_at is null or ends_at > starts_at)
  and cardinality(kinds) between 1 and 2
  and kinds <@ array['open_play', 'round_robin', 'clinic', 'ladder', 'tournament', 'social']::text[]
  and (lat is null) = (lng is null)
  and (hidden_reason is null) = (hidden_at is null)
  and (hidden_reason is null or hidden_reason in (
    'organizer asked', 'reported: cancelled', 'reported: wrong time', 'reported: wrong place', 'removed by Pickleague'))
);

comment on table public.outside_events is
  'Outside events (migration_outside_events.sql): pickleball events other people organize, shown "via <source_name>". RLS on, no policy: RPCs only.';

-- The dedupe key: one URL, written a little differently, is still one page.
create or replace function public._pl_outside_url_key(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(btrim(coalesce(p_url, '')), '/+$', ''))
$$;
revoke all on function public._pl_outside_url_key(text) from public, anon, authenticated;

create unique index if not exists outside_events_url_start
  on public.outside_events (public._pl_outside_url_key(source_url), starts_at);
create index if not exists outside_events_upcoming
  on public.outside_events (starts_at) where hidden_at is null;

create table if not exists public.outside_event_rsvps (
  event_id   uuid not null references public.outside_events (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  status     text not null check (status in ('going', 'maybe')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, profile_id)
);
create index if not exists outside_event_rsvps_profile on public.outside_event_rsvps (profile_id);

create table if not exists public.outside_event_reports (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.outside_events (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  reason     text not null check (reason in ('cancelled', 'wrong_time', 'wrong_place')),
  created_at timestamptz not null default now(),
  unique (event_id, profile_id)
);

create table if not exists public.outside_event_seen (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  event_id   uuid not null references public.outside_events (id) on delete cascade,
  seen_at    timestamptz not null default now(),
  primary key (profile_id, event_id)
);

alter table public.outside_events        enable row level security;
alter table public.outside_event_rsvps   enable row level security;
alter table public.outside_event_reports enable row level security;
alter table public.outside_event_seen    enable row level security;
revoke all on table public.outside_events, public.outside_event_rsvps,
                    public.outside_event_reports, public.outside_event_seen
  from public, anon, authenticated;

-- The launch switch (a re-run keeps whatever was set). To launch:
--   update public.app_settings set value = 'true'::jsonb, updated_at = now()
--    where key = 'outside_events_live';
insert into public.app_settings (key, value) values ('outside_events_live', 'false'::jsonb)
on conflict (key) do nothing;


-- ════ 2. Helpers ═════════════════════════════════════════════════════════
create or replace function public._pl_outside_events_live()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.value = 'true'::jsonb from public.app_settings s where s.key = 'outside_events_live'), false)
$$;
revoke all on function public._pl_outside_events_live() from public, anon, authenticated;

-- Over: ends_at passed, or (no end) the start passed an hour ago.
create or replace function public._pl_outside_event_past(p_starts timestamptz, p_ends timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case when p_ends is not null then p_ends <= now() else p_starts <= now() - interval '1 hour' end
$$;
revoke all on function public._pl_outside_event_past(timestamptz, timestamptz) from public, anon, authenticated;

-- Listed for this viewer: not hidden, not over, the switch on (godmode
-- always), and within 40 km of their home court (unknown on either side:
-- shown).
create or replace function public._pl_outside_event_listed(p_event uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.outside_events e
     where e.id = p_event
       and e.hidden_at is null
       and not public._pl_outside_event_past(e.starts_at, e.ends_at)
       and (public._pl_outside_events_live() or public.is_godmode_user(p_viewer))
       and (e.lat is null or coalesce((
             select public.haversine_meters(pr.home_court_lat, pr.home_court_lng, e.lat, e.lng) <= 40000
               from public.profiles pr
              where pr.id = p_viewer and pr.home_court_lat is not null and pr.home_court_lng is not null
           ), true))
  )
$$;
revoke all on function public._pl_outside_event_listed(uuid, uuid) from public, anon, authenticated;

-- The nearest pickleball court within 150 m of a point, or null.
create or replace function public._pl_outside_event_venue(p_lat double precision, p_lng double precision)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select v.id from public.venues v
   where p_lat is not null and p_lng is not null
     and v.sport @> array['pickleball']
     and v.lat between p_lat - 0.002 and p_lat + 0.002
     and v.lng between p_lng - 0.003 and p_lng + 0.003
     and public.haversine_meters(v.lat, v.lng, p_lat, p_lng) <= 150
   order by public.haversine_meters(v.lat, v.lng, p_lat, p_lng)
   limit 1
$$;
revoke all on function public._pl_outside_event_venue(double precision, double precision) from public, anon, authenticated;

-- One event as the app reads it.
create or replace function public._pl_outside_event_json(p_event uuid, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', e.id, 'title', e.title, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
           'kinds', to_jsonb(e.kinds), 'summary', e.summary, 'organizer_name', e.organizer_name,
           'source_name', e.source_name, 'source_url', e.source_url,
           'place_name', coalesce(nullif(btrim(e.place_name), ''), v.name),
           'place_address', e.place_address,
           'venue_id', e.venue_id, 'venue_name', v.name, 'lat', e.lat, 'lng', e.lng,
           'last_verified_at', e.last_verified_at,
           'going_count', (select count(*)::int from public.outside_event_rsvps r where r.event_id = e.id and r.status = 'going'),
           'interested_count', (select count(*)::int from public.outside_event_rsvps r where r.event_id = e.id and r.status = 'maybe'),
           'my_status', (select r.status from public.outside_event_rsvps r where r.event_id = e.id and r.profile_id = p_viewer),
           'my_report', (select r.reason from public.outside_event_reports r where r.event_id = e.id and r.profile_id = p_viewer),
           'seen', exists (select 1 from public.outside_event_seen s where s.event_id = e.id and s.profile_id = p_viewer),
           'hidden_reason', e.hidden_reason,
           'past', public._pl_outside_event_past(e.starts_at, e.ends_at))
    from public.outside_events e
    left join public.venues v on v.id = e.venue_id
   where e.id = p_event
$$;
revoke all on function public._pl_outside_event_json(uuid, uuid) from public, anon, authenticated;

create or replace function public._pl_require_godmode()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_godmode_user(v_uid) then
    raise exception using message = 'Only the Pickleague team adds and edits outside events.', hint = 'pl:events.admin_only';
  end if;
  return v_uid;
end $$;
revoke all on function public._pl_require_godmode() from public, anon, authenticated;

-- The one place an outside event is written (admin form, seed importer).
-- p_if_new: the importer's mode; a duplicate returns null instead of refusing.
-- p_venue_id null: the nearest court within 150 m, if any.
create or replace function public._pl_save_outside_event(
  p_id            uuid,
  p_title         text,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_kinds         text[],
  p_summary       text,
  p_organizer     text,
  p_source_name   text,
  p_source_url    text,
  p_place_name    text,
  p_place_address text,
  p_lat           double precision,
  p_lng           double precision,
  p_venue_id      text,
  p_actor         uuid,
  p_if_new        boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_kinds   constant text[] := array['open_play', 'round_robin', 'clinic', 'ladder', 'tournament', 'social'];
  v_title   text := nullif(btrim(p_title), '');
  v_url     text := nullif(btrim(p_source_url), '');
  v_source  text := nullif(btrim(p_source_name), '');
  v_summary text := nullif(btrim(p_summary), '');
  v_kinds   text[];
  v_venue   text := nullif(btrim(p_venue_id), '');
  v_id      uuid;
begin
  -- Kinds: trimmed, lower case, duplicates dropped, first-given order kept.
  select coalesce(array_agg(k order by first_at), '{}') into v_kinds
    from (select lower(btrim(k)) as k, min(o) as first_at
            from unnest(coalesce(p_kinds, '{}'::text[])) with ordinality u(k, o)
           where nullif(btrim(k), '') is not null
           group by lower(btrim(k))) x;

  if v_title is null or char_length(v_title) > 120 then
    raise exception using message = 'The event needs a title (up to 120 characters).', hint = 'pl:events.title';
  end if;
  if v_url is null or v_url !~* '^https?://[^ ]+$' then
    raise exception using message = 'The event needs a link to the original page, starting with https://', hint = 'pl:events.link';
  end if;
  if v_source is null then
    raise exception using message = 'The event needs a source name, like the club or the site it''s listed on.', hint = 'pl:events.source';
  end if;
  if p_starts_at is null then
    raise exception using message = 'The event needs a start time. Use the time on the original event.', hint = 'pl:events.start';
  end if;
  if p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception using message = 'The end time is before the start. Leave the end empty if the original doesn''t say.', hint = 'pl:events.end';
  end if;
  if v_summary is not null and char_length(v_summary) > 160 then
    raise exception using message = 'The summary is too long. Write one line of your own, up to 160 characters. Never copy the original description.', hint = 'pl:events.summary';
  end if;
  if cardinality(v_kinds) not between 1 and 2 or not v_kinds <@ c_kinds then
    raise exception using message = 'Pick 1 or 2 kinds: open play, round robin, clinic, ladder, tournament or social.', hint = 'pl:events.kinds';
  end if;
  if (p_lat is null) <> (p_lng is null) then
    raise exception using message = 'The event''s point needs both a latitude and a longitude.', hint = 'pl:events.point';
  end if;
  if v_venue is not null and not exists (select 1 from public.venues v where v.id = v_venue) then
    raise exception using message = 'That court isn''t in Pickleague.', hint = 'pl:events.venue';
  end if;

  -- A takedown blocks every date from that page.
  if exists (
    select 1 from public.outside_events e
     where public._pl_outside_url_key(e.source_url) = public._pl_outside_url_key(v_url)
       and e.hidden_reason = 'organizer asked'
       and e.id is distinct from p_id
  ) then
    raise exception using message = 'The organizer asked us to take events from this page down. Don''t add it again unless they ask to be listed.',
                          hint = 'pl:events.taken_down';
  end if;

  select e.id into v_id
    from public.outside_events e
   where public._pl_outside_url_key(e.source_url) = public._pl_outside_url_key(v_url)
     and e.starts_at = p_starts_at
     and e.id is distinct from p_id;
  if v_id is not null then
    if p_if_new then return null; end if;
    raise exception using message = 'That event is already listed at this start time. Open it from Outside events to edit it.',
                          hint = 'pl:events.duplicate';
  end if;

  v_venue := coalesce(v_venue, public._pl_outside_event_venue(p_lat, p_lng));

  if p_id is null then
    insert into public.outside_events (
      title, starts_at, ends_at, kinds, summary, organizer_name, source_name, source_url,
      place_name, place_address, venue_id, lat, lng, last_verified_at, created_by
    ) values (
      v_title, p_starts_at, p_ends_at, v_kinds, v_summary, nullif(btrim(p_organizer), ''), v_source, v_url,
      nullif(btrim(p_place_name), ''), nullif(btrim(p_place_address), ''), v_venue, p_lat, p_lng, now(), p_actor
    )
    returning id into v_id;
  else
    update public.outside_events e
       set title = v_title, starts_at = p_starts_at, ends_at = p_ends_at, kinds = v_kinds, summary = v_summary,
           organizer_name = nullif(btrim(p_organizer), ''), source_name = v_source, source_url = v_url,
           place_name = nullif(btrim(p_place_name), ''), place_address = nullif(btrim(p_place_address), ''),
           venue_id = v_venue, lat = p_lat, lng = p_lng, last_verified_at = now(), updated_at = now()
     where e.id = p_id
    returning e.id into v_id;
    if v_id is null then
      raise exception using message = 'That outside event no longer exists. Go back to Outside events and refresh.', hint = 'pl:events.gone';
    end if;
  end if;
  return v_id;
end $$;
revoke all on function public._pl_save_outside_event(uuid, text, timestamptz, timestamptz, text[], text, text, text, text, text, text, double precision, double precision, text, uuid, boolean) from public, anon, authenticated;


-- ════ 3. Client RPCs ═════════════════════════════════════════════════════
create or replace function public.list_outside_events(p_kinds text[] default null, p_mine boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  return coalesce((
    select jsonb_agg(public._pl_outside_event_json(x.id, v_uid) order by x.starts_at, x.id)
      from (
        select e.id, e.starts_at
          from public.outside_events e
         where e.hidden_at is null
           and not public._pl_outside_event_past(e.starts_at, e.ends_at)
           and (cardinality(coalesce(p_kinds, '{}'::text[])) = 0 or e.kinds && p_kinds)
           and (not coalesce(p_mine, false)
                or exists (select 1 from public.outside_event_rsvps r where r.event_id = e.id and r.profile_id = v_uid))
           and public._pl_outside_event_listed(e.id, v_uid)
         order by e.starts_at, e.id
         limit 200
      ) x
  ), '[]'::jsonb);
end $$;
revoke all on function public.list_outside_events(text[], boolean) from public, anon;
grant execute on function public.list_outside_events(text[], boolean) to authenticated;

create or replace function public.get_outside_event(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if public._pl_outside_event_listed(p_id, v_uid)
     or exists (select 1 from public.outside_event_rsvps r where r.event_id = p_id and r.profile_id = v_uid) then
    return public._pl_outside_event_json(p_id, v_uid);
  end if;
  return null;
end $$;
revoke all on function public.get_outside_event(uuid) from public, anon;
grant execute on function public.get_outside_event(uuid) to authenticated;

-- Going / Interested (maybe) / clear. Pays nothing and pushes nobody.
create or replace function public.set_outside_event_rsvp(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_status is null then
    delete from public.outside_event_rsvps where event_id = p_id and profile_id = v_uid;
  else
    if p_status not in ('going', 'maybe') then
      raise exception using message = 'Pick Going or Interested.', hint = 'pl:events.rsvp';
    end if;
    if not public._pl_outside_event_listed(p_id, v_uid) then
      raise exception using message = 'This event isn''t listed anymore. It may be over, or it was taken down.', hint = 'pl:events.gone';
    end if;
    insert into public.outside_event_rsvps (event_id, profile_id, status)
    values (p_id, v_uid, p_status)
    on conflict (event_id, profile_id) do update set status = excluded.status, updated_at = now();
  end if;
  return jsonb_build_object(
    'my_status', (select r.status from public.outside_event_rsvps r where r.event_id = p_id and r.profile_id = v_uid),
    'going_count', (select count(*)::int from public.outside_event_rsvps r where r.event_id = p_id and r.status = 'going'),
    'interested_count', (select count(*)::int from public.outside_event_rsvps r where r.event_id = p_id and r.status = 'maybe'));
end $$;
revoke all on function public.set_outside_event_rsvp(uuid, text) from public, anon;
grant execute on function public.set_outside_event_rsvp(uuid, text) to authenticated;

-- One report per person (a second one changes the reason). Two people since
-- the last admin review hide it with the most-reported reason. Every report
-- pushes the godmode users.
create or replace function public.report_outside_event(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_e      public.outside_events%rowtype;
  v_new    boolean;
  v_n      int;
  v_top    text;
  v_hidden boolean := false;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_reason is null or p_reason not in ('cancelled', 'wrong_time', 'wrong_place') then
    raise exception using message = 'Pick what''s wrong: cancelled, wrong time or wrong place.', hint = 'pl:events.reason';
  end if;
  select * into v_e from public.outside_events e where e.id = p_id;
  if not found then
    raise exception using message = 'This event isn''t listed anymore. It may be over, or it was taken down.', hint = 'pl:events.gone';
  end if;
  if v_e.hidden_at is not null then
    return jsonb_build_object('status', 'hidden', 'reports', 0, 'hidden', true, 'hidden_reason', v_e.hidden_reason);
  end if;
  if not public._pl_outside_event_listed(p_id, v_uid)
     and not exists (select 1 from public.outside_event_rsvps r where r.event_id = p_id and r.profile_id = v_uid) then
    raise exception using message = 'This event isn''t listed anymore. It may be over, or it was taken down.', hint = 'pl:events.gone';
  end if;

  -- clock_timestamp, not now(): compared with reports_cleared_at, which an
  -- admin may set earlier in the same transaction.
  insert into public.outside_event_reports (event_id, profile_id, reason, created_at)
  values (p_id, v_uid, p_reason, clock_timestamp())
  on conflict (event_id, profile_id) do update set reason = excluded.reason, created_at = excluded.created_at
  returning (xmax = 0) into v_new;

  select count(*)::int into v_n
    from public.outside_event_reports r
   where r.event_id = p_id and r.created_at > coalesce(v_e.reports_cleared_at, '-infinity'::timestamptz);

  if v_n >= 2 then
    select r.reason into v_top
      from public.outside_event_reports r
     where r.event_id = p_id and r.created_at > coalesce(v_e.reports_cleared_at, '-infinity'::timestamptz)
     group by r.reason
     order by count(*) desc, max(r.created_at) desc
     limit 1;
    update public.outside_events
       set hidden_reason = 'reported: ' || replace(v_top, '_', ' '), hidden_at = now(), updated_at = now()
     where id = p_id;
    v_hidden := true;
  end if;

  begin
    insert into public.push_outbox (recipient_id, kind, title, body, deep_link, expires_at, push_data)
    select p.id, 'info', '🚩 Outside event reported',
           format('"%s": %s. %s %s so far.%s', v_e.title, replace(p_reason, '_', ' '), v_n,
                  case when v_n = 1 then 'report' else 'reports' end,
                  case when v_hidden then ' It''s hidden now.' else '' end),
           'outside_event/' || p_id::text, now() + interval '7 days',
           jsonb_build_object('kind', 'outside_event_report', 'event_id', p_id)
      from public.profiles p
     where public.is_godmode_user(p.id) and p.id <> v_uid;
  exception when others then
    raise warning 'outside event report push for % not queued: %', p_id, sqlerrm;
  end;

  return jsonb_build_object('status', case when v_new then 'reported' else 'updated' end,
                            'reports', v_n, 'hidden', v_hidden,
                            'hidden_reason', case when v_hidden then 'reported: ' || replace(v_top, '_', ' ') end);
end $$;
revoke all on function public.report_outside_event(uuid, text) from public, anon;
grant execute on function public.report_outside_event(uuid, text) to authenticated;

-- Mark these events seen by me (on screen in the Home card or the Events
-- screen). Unknown ids are ignored. Returns how many were new.
create or replace function public.mark_outside_events_seen(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n   int;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  insert into public.outside_event_seen (profile_id, event_id)
  select v_uid, e.id from public.outside_events e where e.id = any (coalesce(p_ids, '{}'::uuid[]))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.mark_outside_events_seen(uuid[]) from public, anon;
grant execute on function public.mark_outside_events_seen(uuid[]) to authenticated;

-- The red count on Home: listed for me and not seen yet.
create or replace function public.count_new_outside_events()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return 0; end if;
  return (
    select count(*)::int from public.outside_events e
     where e.hidden_at is null
       and not public._pl_outside_event_past(e.starts_at, e.ends_at)
       and not exists (select 1 from public.outside_event_seen s where s.event_id = e.id and s.profile_id = v_uid)
       and public._pl_outside_event_listed(e.id, v_uid));
end $$;
revoke all on function public.count_new_outside_events() from public, anon;
grant execute on function public.count_new_outside_events() to authenticated;


-- ════ 4. Admin RPCs (godmode) ════════════════════════════════════════════
create or replace function public.admin_save_outside_event(
  p_id            uuid,
  p_title         text,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_kinds         text[],
  p_summary       text,
  p_organizer     text,
  p_source_name   text,
  p_source_url    text,
  p_place_name    text,
  p_place_address text,
  p_lat           double precision,
  p_lng           double precision,
  p_venue_id      text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := public._pl_require_godmode();
begin
  return public._pl_save_outside_event(
    p_id, p_title, p_starts_at, p_ends_at, p_kinds, p_summary, p_organizer, p_source_name, p_source_url,
    p_place_name, p_place_address, p_lat, p_lng, p_venue_id, v_uid, false);
end $$;
revoke all on function public.admin_save_outside_event(uuid, text, timestamptz, timestamptz, text[], text, text, text, text, text, text, double precision, double precision, text) from public, anon;
grant execute on function public.admin_save_outside_event(uuid, text, timestamptz, timestamptz, text[], text, text, text, text, text, text, double precision, double precision, text) to authenticated;

-- "Still on": the admin looked at the original again.
create or replace function public.admin_mark_outside_event_checked(p_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare v_at timestamptz;
begin
  perform public._pl_require_godmode();
  update public.outside_events set last_verified_at = now(), updated_at = now()
   where id = p_id
  returning last_verified_at into v_at;
  if v_at is null then
    raise exception using message = 'That outside event no longer exists. Go back to Outside events and refresh.', hint = 'pl:events.gone';
  end if;
  return v_at;
end $$;
revoke all on function public.admin_mark_outside_event_checked(uuid) from public, anon;
grant execute on function public.admin_mark_outside_event_checked(uuid) to authenticated;

-- Hide (with a reason) or show again (p_reason null). 'organizer asked' hides
-- every date from that page; showing again clears the reports so far.
create or replace function public.admin_set_outside_event_hidden(p_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_n   int;
begin
  perform public._pl_require_godmode();
  select e.source_url into v_url from public.outside_events e where e.id = p_id;
  if v_url is null then
    raise exception using message = 'That outside event no longer exists. Go back to Outside events and refresh.', hint = 'pl:events.gone';
  end if;
  if p_reason is null then
    update public.outside_events
       set hidden_reason = null, hidden_at = null, reports_cleared_at = clock_timestamp(),
           last_verified_at = now(), updated_at = now()
     where id = p_id;
    return 1;
  end if;
  if p_reason not in ('organizer asked', 'removed by Pickleague') then
    raise exception using message = 'Use "organizer asked" or "removed by Pickleague".', hint = 'pl:events.reason';
  end if;
  update public.outside_events e set hidden_reason = p_reason, hidden_at = now(), updated_at = now()
   where e.id = p_id
      or (p_reason = 'organizer asked' and public._pl_outside_url_key(e.source_url) = public._pl_outside_url_key(v_url));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.admin_set_outside_event_hidden(uuid, text) from public, anon;
grant execute on function public.admin_set_outside_event_hidden(uuid, text) to authenticated;

-- The admin list: upcoming outside events (hidden ones too) with their reports.
create or replace function public.admin_list_outside_events()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public._pl_require_godmode();
  return coalesce((
    select jsonb_agg(public._pl_outside_event_json(e.id, auth.uid())
                     || jsonb_build_object(
                          'report_count', (select count(*)::int from public.outside_event_reports r
                                            where r.event_id = e.id
                                              and r.created_at > coalesce(e.reports_cleared_at, '-infinity'::timestamptz)),
                          'hidden_at', e.hidden_at)
                     order by e.starts_at, e.id)
      from public.outside_events e
     where e.starts_at >= now() - interval '1 day' or e.ends_at > now()
  ), '[]'::jsonb);
end $$;
revoke all on function public.admin_list_outside_events() from public, anon;
grant execute on function public.admin_list_outside_events() to authenticated;


-- ════ 5. The weekly post's view (marketing studio) ═══════════════════════
-- The next 7 days of listed outside events. Service role only.
create or replace view public.upcoming_outside_events as
  select e.id,
         e.title,
         e.starts_at,
         e.ends_at,
         e.kinds,
         coalesce(nullif(btrim(e.place_name), ''), v.name) as place_name,
         v.name as court_name,
         btrim((regexp_match(e.place_address, '([^,]+),\s*[A-Z]{2}(\s+\d{5})?\s*(,\s*USA)?\s*$'))[1]) as city,
         e.organizer_name as organizer,
         e.source_name,
         e.source_url,
         (select count(*)::int from public.outside_event_rsvps r where r.event_id = e.id and r.status = 'going') as going_count,
         (select count(*)::int from public.outside_event_rsvps r where r.event_id = e.id and r.status = 'maybe') as interested_count
    from public.outside_events e
    left join public.venues v on v.id = e.venue_id
   where e.hidden_at is null
     and e.starts_at >= now()
     and e.starts_at < now() + interval '7 days'
   order by e.starts_at;
revoke all on table public.upcoming_outside_events from public, anon, authenticated;
grant select on table public.upcoming_outside_events to service_role;
