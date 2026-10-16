-- ============================================================
-- Presence Phase 1, file 1 of 5: schema, duplicate courts, privacy helpers
-- (docs/play-sessions-presence.md, contract: docs/play-sessions-presence-api.md).
--
-- APPLY ORDER (one transaction, in this order; none of them has begin/commit):
--   1. migration_presence_p1_schema.sql    columns, tables, RLS lockdown, venue
--                                          dedupe, league/court backfill, helpers
--   2. migration_presence_p1_checkins.sql  location-confirmed check-ins, sessions,
--                                          resolve_court
--   3. migration_presence_p1_reads.sql     venue_players_here (definer), court_presence,
--                                          venue_crowd, friends_at_courts, settings,
--                                          court favorites
--   4. migration_presence_p1_friends.sql   friend RPCs, notices, block teardown,
--                                          suggest_friends
--   5. migration_presence_p1_hygiene.sql   account deletion + 180-day retention cron
-- The allowlist in migration_rls_hardening_2026q3.sql already names every RPC
-- these files grant, so re-running it afterwards takes nothing offline.
-- Persona tests: node supabase/tests/build-presence-test.mjs (applies all five
-- plus the hardening file in a rolled-back transaction).
--
-- Needs migration_venue_checkins.sql, migration_play_sessions.sql,
-- migration_venue_geofence_radius_100.sql, migration_moderation_report_block.sql
-- (user_blocks, blocked_between) and pg_trgm. Idempotent: add column if not
-- exists, create table if not exists, create or replace, drop policy if exists.
--
-- What changes for players:
--   * Nobody can read anyone else's check-ins or play sessions any more. Until
--     now any signed-in account, guests included, could read every row. Others
--     see presence only through the SECURITY DEFINER reads in file 3, which
--     apply _pl_can_see_presence (friends, closed leagues, blocks, pause,
--     hide-from).
--   * Duplicate court rows (Google + OSM copies, OSM per-court rows) get a
--     venues.canonical_id, so two friends on adjacent pitches land on one court.
--     No venue is deleted or edited beyond that column.
--   * Leagues and drill court locations remember their court
--     (home_venue_id / venue_id), kept in step when a 1.0.4 app edits the
--     home court by its name and coordinates only.
-- ============================================================


-- ── 1. Columns ─────────────────────────────────────────────────────────────
-- A check-in is location-confirmed when the server verified a fresh GPS fix
-- inside the court's fence (file 2). Unconfirmed rows come only from 1.0.4
-- apps that send no fix: shown to nobody, counted nowhere, earn nothing.
alter table public.venue_checkins add column if not exists location_confirmed boolean not null default false;
alter table public.venue_checkins add column if not exists fix_lat        double precision;
alter table public.venue_checkins add column if not exists fix_lng        double precision;
alter table public.venue_checkins add column if not exists fix_accuracy_m real;
alter table public.venue_checkins add column if not exists fix_at         timestamptz;
alter table public.venue_checkins add column if not exists fix_distance_m real;
comment on column public.venue_checkins.venue_id is
  'The CANONICAL venue (venues.canonical_id resolved), so a facility''s duplicate rows share one id.';
create index if not exists venue_checkins_user_time_idx on public.venue_checkins (user_id, checked_in_at desc);

-- null = this row is canonical. Set only by _pl_dedupe_venues() below.
alter table public.venues add column if not exists canonical_id text references public.venues (id) on delete set null;
create index if not exists venues_canonical_id_idx on public.venues (canonical_id) where canonical_id is not null;

alter table public.leagues add column if not exists home_venue_id text references public.venues (id) on delete set null;
alter table public.court_locations add column if not exists venue_id text references public.venues (id) on delete set null;


-- ── 2. Tables ──────────────────────────────────────────────────────────────
-- Every one is owner-only (or the two parties, for friendships) with no write
-- policies: writes go through the RPCs in files 2-4. On account deletion the
-- profile survives as a tombstone, so FK cascades never fire; file 5 deletes
-- these rows explicitly.

-- Who sees me at the courts. A missing row means the defaults, resolved in SQL.
create table if not exists public.presence_settings (
  user_id         uuid primary key references public.profiles (id) on delete cascade,
  checkins_level  text not null default 'leaguemates'
                  check (checkins_level in ('everyone', 'leaguemates', 'friends', 'hidden')),
  plans_level     text not null default 'friends'
                  check (plans_level in ('leaguemates', 'friends', 'hidden')),
  paused_until    timestamptz,
  consent_seen_at timestamptz,
  auto_checkin    boolean not null default false,   -- read in Phase 2
  updated_at      timestamptz not null default now()
);

-- "Hide my presence from <person>": they see an anonymous Player instead.
create table if not exists public.presence_hidden_from (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  hidden_user_id uuid not null references public.profiles (id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, hidden_user_id),
  check (user_id <> hidden_user_id)
);
create index if not exists presence_hidden_from_hidden_idx on public.presence_hidden_from (hidden_user_id);

-- Mutual friendships. One row per pair (either direction); a re-request
-- reuses it, so a decline is remembered for the 30-day quiet window.
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
create unique index if not exists friendships_pair_key
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);

-- The close-friend star (Phase 2 pushes go to close friends only).
create table if not exists public.close_friends (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  friend_id  uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create index if not exists close_friends_friend_idx on public.close_friends (friend_id);

-- My courts (max 5, enforced by set_court_favorite). venue_id is canonical.
create table if not exists public.court_favorites (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  venue_id   text not null references public.venues (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, venue_id)
);
create index if not exists court_favorites_venue_idx on public.court_favorites (venue_id);

-- Every friend request sent (internal, no client access). cancel_friend_request
-- deletes the request row, so the 20-a-day cap and the "no second push within
-- 24 h" rule need a memory that survives it. Pruned after 30 days (file 5).
create table if not exists public.friend_request_log (
  sender_id    uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  sent_at      timestamptz not null default now(),
  notified     boolean not null default false
);
create index if not exists friend_request_log_sender_idx on public.friend_request_log (sender_id, sent_at desc);
create index if not exists friend_request_log_addressee_idx on public.friend_request_log (addressee_id);

alter table public.presence_settings    enable row level security;
alter table public.presence_hidden_from enable row level security;
alter table public.friendships          enable row level security;
alter table public.close_friends        enable row level security;
alter table public.court_favorites      enable row level security;
alter table public.friend_request_log   enable row level security;   -- no policies: RPCs only
revoke all on public.friend_request_log from anon, authenticated;

drop policy if exists presence_settings_own on public.presence_settings;
create policy presence_settings_own on public.presence_settings
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists presence_hidden_from_own on public.presence_hidden_from;
create policy presence_hidden_from_own on public.presence_hidden_from
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists friendships_parties on public.friendships;
create policy friendships_parties on public.friendships
  for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

drop policy if exists close_friends_own on public.close_friends;
create policy close_friends_own on public.close_friends
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists court_favorites_own on public.court_favorites;
create policy court_favorites_own on public.court_favorites
  for select to authenticated using (user_id = (select auth.uid()));


-- ── 3. Presence lockdown: raw rows are owner-only ──────────────────────────
-- Every 1.0.4 direct read is already own-row (data/venueCheckins.ts,
-- data/playSessions.ts, courtGeofence.ts), so nothing shipped breaks.
drop policy if exists venue_checkins_read on public.venue_checkins;
create policy venue_checkins_read on public.venue_checkins
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists play_sessions_read on public.play_sessions;
create policy play_sessions_read on public.play_sessions
  for select to authenticated using (user_id = (select auth.uid()));


-- ── 4. Duplicate courts: venues.canonical_id ───────────────────────────────
-- Two court names "match" when they are the same once punctuation and case go,
-- close by trigram similarity ('Pickleball Courts | Montclair Park' vs
-- 'Montclair Pickleball Courts' = 0.88), or either is a bare court label ('1',
-- 'Court 3'), as OSM tags each pitch of one facility.
create or replace function public._pl_similar_court_names(a text, b text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
       regexp_replace(lower(a), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(b), '[^a-z0-9]+', '', 'g')
    or public.similarity(lower(a), lower(b)) >= 0.5
    or a ~* '^\s*(court\s*)?#?\d+[a-z]?\s*$'
    or b ~* '^\s*(court\s*)?#?\d+[a-z]?\s*$',
    false);
$$;
revoke all on function public._pl_similar_court_names(text, text) from public, anon, authenticated;

-- The canonical id of a venue (itself when canonical), or null when unknown.
create or replace function public._pl_canonical_venue(p_venue text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(v.canonical_id, v.id) from public.venues v where v.id = p_venue;
$$;
revoke all on function public._pl_canonical_venue(text) from public, anon, authenticated;

-- Deterministic, non-destructive dedupe of one sport's venues. Two venues are
-- the same facility when they are within 50 m with matching names, or when an
-- OSM point lies inside another venue's boundary. Facilities are the connected
-- groups of those pairs; each group's canonical row is the one with a
-- boundary, then a Google row, then the lowest id. Re-running recomputes
-- canonical_id for that sport's venues (it owns the column) and repoints the
-- rows that store canonical ids. Nothing is ever deleted. Returns how many
-- venues changed. Re-run after a venue ingest:  select public._pl_dedupe_venues();
create or replace function public._pl_dedupe_venues(p_sport text default 'pickleball')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  with recursive p as (
    select v.id, v.name, v.lat, v.lng, v.source, v.boundary_geom
      from public.venues v
     where v.sport @> array[p_sport] and v.confirmation_status <> 'rejected'
  ),
  pairs as (
    select a.id as a, b.id as b
      from p a
      join p b on b.id <> a.id
              and abs(a.lat - b.lat) < 0.001 and abs(a.lng - b.lng) < 0.0015
     where public.haversine_meters(a.lat, a.lng, b.lat, b.lng) <= 50
       and public._pl_similar_court_names(a.name, b.name)
    union
    select a.id, b.id
      from p a
      join p b on b.id <> a.id and b.source = 'osm' and b.boundary_geom is null
     where a.boundary_geom is not null
       and extensions.st_contains(a.boundary_geom, extensions.st_setsrid(extensions.st_makepoint(b.lng, b.lat), 4326))
  ),
  edges as (
    select a, b from pairs union select b, a from pairs
  ),
  reach (node, other) as (
    select id, id from p
    union
    select r.node, e.b from reach r join edges e on e.a = r.other
  ),
  canon as (
    select r.node,
           (array_agg(p.id order by (p.boundary_geom is not null) desc, (p.source = 'google') desc, p.id))[1] as rep
      from reach r join p on p.id = r.other
     group by r.node
  )
  update public.venues v
     set canonical_id = nullif(c.rep, v.id)
    from canon c
   where v.id = c.node
     and v.canonical_id is distinct from nullif(c.rep, v.id);
  get diagnostics v_n = row_count;

  -- Rows that promise a canonical id.
  update public.venue_checkins c set venue_id = v.canonical_id
    from public.venues v where v.id = c.venue_id and v.canonical_id is not null;
  update public.play_sessions s set venue_id = v.canonical_id
    from public.venues v where v.id = s.venue_id and v.canonical_id is not null;
  update public.leagues l set home_venue_id = v.canonical_id
    from public.venues v where v.id = l.home_venue_id and v.canonical_id is not null;
  update public.court_locations cl set venue_id = v.canonical_id
    from public.venues v where v.id = cl.venue_id and v.canonical_id is not null;
  insert into public.court_favorites (user_id, venue_id, created_at)
  select f.user_id, v.canonical_id, f.created_at
    from public.court_favorites f join public.venues v on v.id = f.venue_id
   where v.canonical_id is not null
  on conflict do nothing;
  delete from public.court_favorites f
   using public.venues v
   where v.id = f.venue_id and v.canonical_id is not null;
  return v_n;
end $$;
revoke all on function public._pl_dedupe_venues(text) from public, anon, authenticated;

select public._pl_dedupe_venues('pickleball');


-- ── 5. League home courts and drill court locations ────────────────────────
-- The court a stored place means: the nearest canonical venue of the sport
-- within p_radius_m, unless a second one is within 25 m of that distance
-- (ambiguous: null, the organizer picks). With nothing in range, a venue
-- within 1 km whose name contains the place's words ('Crocker-Amazon' ->
-- 'Crocker Amazon Pickleball Courts', 752 m), when exactly one does.
-- 'Bladium Sports & Fitness Club' resolves to 'The Hub Sports Club - Alameda'
-- (117 m): the same facility (migration_court_nickname.sql).
create or replace function public._pl_match_court(
  p_lat      double precision,
  p_lng      double precision,
  p_name     text default null,
  p_sport    text default 'pickleball',
  p_radius_m double precision default 200
) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dlat double precision;
  v_dlng double precision;
  v_ids  text[];
  v_d    double precision[];
begin
  if p_lat is null or p_lng is null then return null; end if;
  v_dlat := 1000 / 111000.0;
  v_dlng := v_dlat / greatest(cos(radians(p_lat)), 0.01);

  select array_agg(x.canon order by x.d), array_agg(x.d order by x.d)
    into v_ids, v_d
    from (
      select coalesce(v.canonical_id, v.id) as canon,
             min(public.haversine_meters(p_lat, p_lng, v.lat, v.lng)) as d
        from public.venues v
       where (p_sport is null or v.sport @> array[p_sport])
         and v.confirmation_status <> 'rejected'
         and abs(v.lat - p_lat) < v_dlat and abs(v.lng - p_lng) < v_dlng
       group by 1
    ) x
   where x.d <= p_radius_m;

  if coalesce(cardinality(v_ids), 0) = 1 then return v_ids[1]; end if;
  if coalesce(cardinality(v_ids), 0) > 1 then
    return case when v_d[2] - v_d[1] >= 25 then v_ids[1] end;
  end if;

  if coalesce(trim(p_name), '') = '' then return null; end if;
  select array_agg(distinct coalesce(v.canonical_id, v.id))
    into v_ids
    from public.venues v
   where (p_sport is null or v.sport @> array[p_sport])
     and v.confirmation_status <> 'rejected'
     and abs(v.lat - p_lat) < v_dlat and abs(v.lng - p_lng) < v_dlng
     and public.haversine_meters(p_lat, p_lng, v.lat, v.lng) <= 1000
     and public.word_similarity(lower(p_name), lower(v.name)) >= 0.8;
  return case when cardinality(v_ids) = 1 then v_ids[1] end;
end $$;
revoke all on function public._pl_match_court(double precision, double precision, text, text, double precision) from public, anon, authenticated;

-- Keep leagues.home_venue_id in step. The app's home-court pickers write it
-- (stored canonical); a 1.0.4 app changes only home_court / lat / lng, so a
-- changed place without a new venue id is re-resolved. The sport is the
-- league's own once leagues.sport exists (multi-sport), pickleball until then.
-- A resolution problem never blocks saving the league.
create or replace function public._leagues_sync_home_venue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if new.home_venue_id is not null
       and (tg_op = 'INSERT' or new.home_venue_id is distinct from old.home_venue_id) then
      new.home_venue_id := public._pl_canonical_venue(new.home_venue_id);
    elsif tg_op = 'INSERT'
       or new.home_court is distinct from old.home_court
       or new.home_court_lat is distinct from old.home_court_lat
       or new.home_court_lng is distinct from old.home_court_lng then
      new.home_venue_id := public._pl_match_court(
        new.home_court_lat, new.home_court_lng, new.home_court,
        coalesce(to_jsonb(new) ->> 'sport', 'pickleball'));
    end if;
  exception when others then
    raise warning '_leagues_sync_home_venue failed for league %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._leagues_sync_home_venue() from public, anon, authenticated;

drop trigger if exists trg_leagues_sync_home_venue on public.leagues;
create trigger trg_leagues_sync_home_venue
  before insert or update of home_court, home_court_lat, home_court_lng, home_venue_id on public.leagues
  for each row execute function public._leagues_sync_home_venue();

-- Same for court_locations (learn_court_from_match inserts these inside every
-- match insert, so this must never raise).
create or replace function public._court_locations_sync_venue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if new.venue_id is not null
       and (tg_op = 'INSERT' or new.venue_id is distinct from old.venue_id) then
      new.venue_id := public._pl_canonical_venue(new.venue_id);
    elsif tg_op = 'INSERT'
       or new.lat is distinct from old.lat
       or new.lng is distinct from old.lng then
      new.venue_id := public._pl_match_court(new.lat, new.lng, coalesce(new.nickname, new.name),
                                              coalesce(to_jsonb(new) ->> 'sport', 'pickleball'));
    end if;
  exception when others then
    raise warning '_court_locations_sync_venue failed for %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._court_locations_sync_venue() from public, anon, authenticated;

drop trigger if exists trg_court_locations_sync_venue on public.court_locations;
create trigger trg_court_locations_sync_venue
  before insert or update of lat, lng, venue_id on public.court_locations
  for each row execute function public._court_locations_sync_venue();

-- One-off backfill (only rows not set yet, so a re-run never overrides a court
-- an organizer picked). Live 2026-10-15: both Bladium leagues and Hub 4.5+ ->
-- The Hub Sports Club - Alameda; dinks (Crocker-Amazon) -> Crocker Amazon
-- Pickleball Courts; Guest League has no court.
update public.leagues l
   set home_venue_id = public._pl_match_court(l.home_court_lat, l.home_court_lng, l.home_court,
                                              coalesce(to_jsonb(l) ->> 'sport', 'pickleball'))
 where l.home_venue_id is null and l.home_court_lat is not null and l.home_court_lng is not null;

update public.court_locations cl
   set venue_id = public._pl_match_court(cl.lat, cl.lng, coalesce(cl.nickname, cl.name), 'pickleball')
 where cl.venue_id is null and cl.lat is not null and cl.lng is not null;


-- ── 6. Privacy helpers (internal: EXECUTE revoked from clients) ────────────
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships f
     where least(f.requester_id, f.addressee_id) = least(a, b)
       and greatest(f.requester_id, f.addressee_id) = greatest(a, b)
       and f.status = 'accepted'
  );
$$;
revoke all on function public.are_friends(uuid, uuid) from public, anon, authenticated;

-- Members of one CLOSED league (open leagues never count: anyone can join one
-- instantly), both memberships live.
create or replace function public.share_closed_league(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.league_members ma
      join public.league_members mb on mb.league_id = ma.league_id
      join public.leagues l on l.id = ma.league_id
     where ma.user_id = a and mb.user_id = b
       and not l.is_open
       and (ma.expires_at is null or ma.expires_at > now())
       and (mb.expires_at is null or mb.expires_at > now())
  );
$$;
revoke all on function public.share_closed_league(uuid, uuid) from public, anon, authenticated;

-- A viewer who only ever gets counts: a guest pass (profiles.is_guest, or an
-- anonymous sign-in), a deleted account, or no profile at all.
create or replace function public._pl_presence_viewer_is_guest(p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is null
      or not exists (
           select 1 from public.profiles p
            where p.id = p_viewer and not p.is_guest and p.deleted_at is null)
      or (p_viewer = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false));
$$;
revoke all on function public._pl_presence_viewer_is_guest(uuid) from public, anon, authenticated;

-- What a viewer may know about an owner's presence:
--   'named'      full row (name, avatar, rating)
--   'anonymous'  an anonymous "Player": counted, never identified
--   'none'       not shown, not counted (blocked either way, deleted owner)
-- p_kind 'checkins' reads checkins_level, 'plans' reads plans_level. Callers
-- also show only location_confirmed rows to anyone but the owner.
create or replace function public._pl_can_see_presence(viewer uuid, owner uuid, p_kind text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_level  text;
  v_paused timestamptz;
begin
  if owner is null then return 'none'; end if;
  if viewer is not null and viewer = owner then return 'named'; end if;
  if viewer is not null and public.blocked_between(viewer, owner) then return 'none'; end if;
  if not exists (select 1 from public.profiles p where p.id = owner and p.deleted_at is null) then
    return 'none';
  end if;
  if public._pl_presence_viewer_is_guest(viewer) then return 'anonymous'; end if;

  select case when p_kind = 'plans' then s.plans_level else s.checkins_level end, s.paused_until
    into v_level, v_paused
    from public.presence_settings s
   where s.user_id = owner;
  v_level := coalesce(v_level, case when p_kind = 'plans' then 'friends' else 'leaguemates' end);

  if v_paused is not null and v_paused > now() then return 'anonymous'; end if;
  if exists (select 1 from public.presence_hidden_from h
              where h.user_id = owner and h.hidden_user_id = viewer) then
    return 'anonymous';
  end if;
  if v_level = 'hidden' then return 'anonymous'; end if;
  if v_level = 'everyone' then return 'named'; end if;
  if public.are_friends(viewer, owner) then return 'named'; end if;
  if v_level = 'leaguemates' and public.share_closed_league(viewer, owner) then return 'named'; end if;
  return 'anonymous';
end $$;
revoke all on function public._pl_can_see_presence(uuid, uuid, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
