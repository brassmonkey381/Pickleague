-- ============================================================
-- Presence Phase 1, file 2 of 5: location-confirmed check-ins, sessions that
-- check you in, sport-aware court lookup. Apply order: see
-- migration_presence_p1_schema.sql (needs file 1 first).
--
-- No manual check-ins (decision 6). A check-in needs a GPS fix the server
-- verifies: at most 2 minutes old (and not more than 1 minute in the future),
-- inside the court's boundary or within
--   coalesce(geofence_radius_m, 100) + least(coalesce(p_accuracy_m, 75), 75)
-- metres of one of the facility's rows (its canonical row and duplicates).
--   * no fix (an un-updated 1.0.4 app): a PRIVATE row, location_confirmed =
--     false. Shown to nobody but its owner, counted nowhere, earns nothing.
--   * a fix that doesn't confirm: an error the app shows as it is.
--
-- Signatures change in this one transaction: the old checkin_venue,
-- checkout_venue and start_play_session are dropped and recreated with
-- trailing defaulted parameters, so 1.0.4's named-argument calls resolve to
-- the new versions. Every write takes pg_advisory_xact_lock('checkin:' || uid),
-- so a check-in, a session start and a check-out from two devices never race.
--
-- Also:
--   * a second check-in at the court you are already at is quiet: the open row
--     comes back with a later expiry (no close-and-reopen, no new push later)
--   * checkout_venue takes the time you really left (p_at), so a queued
--     check-out no longer stretches a visit to its expiry
--   * starting a play session at a court checks you in there (source
--     'session', same id as the session) or adopts the check-in you have;
--     ending or replacing the session closes only the check-in it opened
--   * a check-in id the server never stored (1.0.4 keeps its own id when the
--     server hands back the row it already had) falls back to your open row
--     in checkout_venue and extend_checkin
--   * resolve_court: the court at a point, pickleball by default
--
-- The pickleague-expire-venue-checkins (*/10) and
-- pickleague-expire-play-sessions ('25 * * * *') cron jobs keep calling the
-- same function names; expire_play_sessions now also closes the expired
-- session's check-in.
-- ============================================================


-- ── 1. The fix check ───────────────────────────────────────────────────────
-- p_venue is canonical. distance_m is to the nearest of the facility's rows
-- (0 inside a boundary); fresh is the 2-minute rule.
create or replace function public._pl_check_fix(
  p_venue      text,
  p_lat        double precision,
  p_lng        double precision,
  p_accuracy_m double precision,
  p_fix_at     timestamptz,
  out fresh      boolean,
  out confirmed  boolean,
  out distance_m double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_slack double precision := least(greatest(coalesce(p_accuracy_m, 75), 0), 75);
begin
  fresh := p_fix_at is not null
       and p_fix_at >= now() - interval '2 minutes'
       and p_fix_at <= now() + interval '1 minute';

  select min(case
               when v.boundary_geom is not null
                and extensions.st_contains(v.boundary_geom,
                      extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)) then 0
               else public.haversine_meters(p_lat, p_lng, v.lat, v.lng)
             end),
         bool_or(
               (v.boundary_geom is not null
                and extensions.st_contains(v.boundary_geom,
                      extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)))
            or public.haversine_meters(p_lat, p_lng, v.lat, v.lng)
                 <= coalesce(v.geofence_radius_m, 100) + v_slack)
    into distance_m, confirmed
    from public.venues v
   where v.id = p_venue or v.canonical_id = p_venue;

  confirmed := coalesce(confirmed, false) and fresh;
end $$;
revoke all on function public._pl_check_fix(text, double precision, double precision, double precision, timestamptz)
  from public, anon, authenticated;

-- Shared input check for a device fix. Both null = no fix (1.0.4).
create or replace function public._pl_require_fix_shape(p_lat double precision, p_lng double precision)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_lat is null and p_lng is null then return false; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'Your location didn''t come through. Try again.';
  end if;
  return true;
end $$;
revoke all on function public._pl_require_fix_shape(double precision, double precision) from public, anon, authenticated;


-- ── 2. checkin_venue ───────────────────────────────────────────────────────
drop function if exists public.checkin_venue(uuid, text, int, text, timestamptz);

create or replace function public.checkin_venue(
  p_id         uuid,
  p_venue      text,
  p_minutes    int default 120,
  p_source     text default 'manual',
  p_at         timestamptz default null,
  p_lat        double precision default null,
  p_lng        double precision default null,
  p_accuracy_m double precision default null,
  p_fix_at     timestamptz default null
) returns public.venue_checkins
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_source  text := coalesce(p_source, 'manual');
  v_venue   text;
  v_at      timestamptz;
  v_until   timestamptz;
  v_has_fix boolean;
  v_fix     record;
  v_dist    double precision;
  v_row     public.venue_checkins;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_id is null then raise exception 'Missing check-in id'; end if;
  if v_source not in ('manual', 'geofence', 'session') then raise exception 'Bad source'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  -- Replay of a check-in that already landed.
  select * into v_row from public.venue_checkins where id = p_id;
  if v_row.id is not null then
    if v_row.user_id <> v_uid then raise exception 'Not your check-in'; end if;
    return v_row;
  end if;

  v_venue := public._pl_canonical_venue(p_venue);
  if v_venue is null then raise exception 'Court not found'; end if;

  -- Honest time for a queued (offline) check-in, never in the future and
  -- never more than 6 hours back.
  v_at := greatest(least(coalesce(p_at, now()), now()), now() - interval '6 hours');
  v_until := v_at + make_interval(mins => greatest(15, least(coalesce(p_minutes, 120), 240)));

  v_has_fix := public._pl_require_fix_shape(p_lat, p_lng);
  if v_has_fix then
    select * into v_fix from public._pl_check_fix(v_venue, p_lat, p_lng, p_accuracy_m, p_fix_at);
    if not v_fix.fresh then
      raise exception 'Your location is out of date. Try again at the court.';
    end if;
    if not v_fix.confirmed then
      raise exception 'You need to be at the court to check in (about % m away).',
        coalesce(round(v_fix.distance_m)::int, 0);
    end if;
    v_dist := v_fix.distance_m;
  end if;

  -- Already here (same facility, still open): quiet. A confirmed row is
  -- extended by a confirmed call and returned as is to a call without a fix;
  -- a private row is extended by another call without a fix, and replaced
  -- below by a confirmed one.
  select * into v_row
    from public.venue_checkins c
   where c.user_id = v_uid and c.checked_out_at is null and c.expires_at > now()
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
   order by c.location_confirmed desc, c.checked_in_at desc
   limit 1;
  if v_row.id is not null and (v_row.location_confirmed or not v_has_fix) then
    if v_row.location_confirmed = v_has_fix then
      update public.venue_checkins set expires_at = greatest(expires_at, v_until)
       where id = v_row.id
      returning * into v_row;
    end if;
    return v_row;
  end if;

  -- One open check-in per player.
  update public.venue_checkins
     set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_at, expires_at))
   where user_id = v_uid and checked_out_at is null;

  insert into public.venue_checkins
    (id, user_id, venue_id, checked_in_at, expires_at, source,
     location_confirmed, fix_lat, fix_lng, fix_accuracy_m, fix_at, fix_distance_m)
  values
    (p_id, v_uid, v_venue, v_at, v_until, v_source,
     v_has_fix,
     case when v_has_fix then p_lat end,
     case when v_has_fix then p_lng end,
     case when v_has_fix then p_accuracy_m end,
     case when v_has_fix then p_fix_at end,
     v_dist)
  returning * into v_row;
  return v_row;
end $$;
revoke execute on function public.checkin_venue(uuid, text, int, text, timestamptz, double precision, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.checkin_venue(uuid, text, int, text, timestamptz, double precision, double precision, double precision, timestamptz) to authenticated;


-- ── 3. extend_checkin ──────────────────────────────────────────────────────
-- Absolute end time: a replay cannot extend twice. Capped 4 hours from now.
-- An id the server never stored falls back to my open check-in; a closed one
-- is still an error.
create or replace function public.extend_checkin(p_id uuid, p_until timestamptz)
returns public.venue_checkins
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.venue_checkins;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  update public.venue_checkins
     set expires_at = greatest(expires_at, least(p_until, now() + interval '4 hours'))
   where id = p_id and user_id = v_uid and checked_out_at is null
  returning * into v_row;

  if v_row.id is null and not exists (select 1 from public.venue_checkins where id = p_id and user_id = v_uid) then
    update public.venue_checkins
       set expires_at = greatest(expires_at, least(p_until, now() + interval '4 hours'))
     where id = (select c.id from public.venue_checkins c
                  where c.user_id = v_uid and c.checked_out_at is null and c.expires_at > now()
                  order by c.checked_in_at desc limit 1)
    returning * into v_row;
  end if;

  if v_row.id is null then raise exception 'Check-in is no longer open'; end if;
  return v_row;
end $$;
revoke execute on function public.extend_checkin(uuid, timestamptz) from public, anon;
grant execute on function public.extend_checkin(uuid, timestamptz) to authenticated;


-- ── 4. checkout_venue ──────────────────────────────────────────────────────
-- Close one check-in (p_id) or, with null, every open one of mine, at the time
-- I left: greatest(checked_in_at + 1 s, least(coalesce(p_at, now()), now(),
-- expires_at)). p_source keeps its 1.0.4 meaning, a FILTER: 'manual',
-- 'geofence' or 'session' close only check-ins that source opened (a
-- geofence exit must not close a manual check-in); null or any other value
-- (e.g. 'signout') closes regardless. Returns how many closed; 0 on a replay.
drop function if exists public.checkout_venue(uuid, text);

create or replace function public.checkout_venue(
  p_id     uuid default null,
  p_source text default null,
  p_at     timestamptz default null
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_filter text := case when p_source in ('manual', 'geofence', 'session') then p_source end;
  v_at     timestamptz := least(coalesce(p_at, now()), now());
  v_n      int := 0;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  if p_id is not null then
    update public.venue_checkins
       set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_at, expires_at))
     where id = p_id and user_id = v_uid and checked_out_at is null
       and (v_filter is null or source = v_filter);
    get diagnostics v_n = row_count;
    -- A check-in of mine that is already closed (or another source's): a
    -- replay, nothing to do. An id never stored: close my open row instead.
    if v_n > 0 or exists (select 1 from public.venue_checkins where id = p_id and user_id = v_uid) then
      return v_n;
    end if;
  end if;

  update public.venue_checkins
     set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_at, expires_at))
   where user_id = v_uid and checked_out_at is null
     and (v_filter is null or source = v_filter);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.checkout_venue(uuid, text, timestamptz) from public, anon;
grant execute on function public.checkout_venue(uuid, text, timestamptz) to authenticated;


-- ── 5. Play sessions ───────────────────────────────────────────────────────
drop function if exists public.start_play_session(uuid, text, uuid, text, timestamptz);

-- Unchanged, plus: a session at a court checks you in there. With an open
-- confirmed check-in at that court, it is adopted (kept, extended to cover
-- 180 minutes; ending the session leaves it open). Otherwise, when the fix
-- confirms the court, a source 'session' check-in with the session's id opens
-- for 180 minutes and closes with the session. Without a confirming fix the
-- session runs untracked: no error, no check-in.
create or replace function public.start_play_session(
  p_id         uuid,
  p_kind       text,
  p_source     uuid default null,
  p_venue      text default null,
  p_at         timestamptz default null,
  p_lat        double precision default null,
  p_lng        double precision default null,
  p_accuracy_m double precision default null,
  p_fix_at     timestamptz default null
) returns public.play_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_at    timestamptz := greatest(least(coalesce(p_at, now()), now()), now() - interval '12 hours');
  v_venue text := public._pl_canonical_venue(p_venue);
  v_until timestamptz := greatest(v_at, now()) + interval '180 minutes';
  v_fix   record;
  v_ci    uuid;
  v_row   public.play_sessions;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_id is null then raise exception 'Missing session id'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  select * into v_row from public.play_sessions where id = p_id;
  if v_row.id is not null then
    if v_row.user_id <> v_uid then raise exception 'Not your session'; end if;
    return v_row;  -- replay
  end if;

  -- One open session per player; the check-in a session opened ends with it.
  update public.venue_checkins c
     set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_at, c.expires_at))
   where c.user_id = v_uid and c.checked_out_at is null and c.source = 'session'
     and c.id in (select s.id from public.play_sessions s where s.user_id = v_uid and s.ended_at is null);
  update public.play_sessions set ended_at = greatest(v_at, started_at)
   where user_id = v_uid and ended_at is null;

  insert into public.play_sessions (id, user_id, kind, source_id, venue_id, started_at)
  values (p_id, v_uid, p_kind, p_source, v_venue, v_at)
  returning * into v_row;

  if v_venue is null then return v_row; end if;

  select c.id into v_ci
    from public.venue_checkins c
   where c.user_id = v_uid and c.checked_out_at is null and c.expires_at > now() and c.location_confirmed
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
   order by c.checked_in_at desc
   limit 1;
  if v_ci is not null then
    update public.venue_checkins set expires_at = greatest(expires_at, v_until) where id = v_ci;
    return v_row;
  end if;

  if not public._pl_require_fix_shape(p_lat, p_lng) then return v_row; end if;
  select * into v_fix from public._pl_check_fix(v_venue, p_lat, p_lng, p_accuracy_m, p_fix_at);
  if not v_fix.confirmed then return v_row; end if;

  update public.venue_checkins
     set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_at, expires_at))
   where user_id = v_uid and checked_out_at is null;
  insert into public.venue_checkins
    (id, user_id, venue_id, checked_in_at, expires_at, source,
     location_confirmed, fix_lat, fix_lng, fix_accuracy_m, fix_at, fix_distance_m)
  values
    (p_id, v_uid, v_venue, v_at, v_until, 'session',
     true, p_lat, p_lng, p_accuracy_m, p_fix_at, v_fix.distance_m)
  on conflict (id) do nothing;
  return v_row;
end $$;
revoke execute on function public.start_play_session(uuid, text, uuid, text, timestamptz, double precision, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.start_play_session(uuid, text, uuid, text, timestamptz, double precision, double precision, double precision, timestamptz) to authenticated;

-- Also closes the check-in this session opened (an adopted one stays open),
-- even when the session itself was already closed.
create or replace function public.end_play_session(p_id uuid, p_at timestamptz default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_at  timestamptz := least(coalesce(p_at, now()), now());
  v_n   int;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));
  update public.play_sessions
     set ended_at = greatest(v_at, started_at)
   where id = p_id and user_id = v_uid and ended_at is null;
  get diagnostics v_n = row_count;

  update public.venue_checkins
     set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_at, expires_at))
   where id = p_id and user_id = v_uid and source = 'session' and checked_out_at is null;
  return v_n;  -- 0 on a replay
end $$;
revoke execute on function public.end_play_session(uuid, timestamptz) from public, anon;
grant execute on function public.end_play_session(uuid, timestamptz) to authenticated;

-- Close sessions nobody ended (phone died, app deleted) after 6 hours, and any
-- session check-in still open after its session ended.
create or replace function public.expire_play_sessions() returns void
language sql security definer set search_path = '' as $$
  update public.play_sessions set ended_at = started_at + interval '6 hours'
   where ended_at is null and started_at < now() - interval '6 hours';
  update public.venue_checkins c
     set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(c.expires_at, s.ended_at))
    from public.play_sessions s
   where s.id = c.id and s.user_id = c.user_id and s.ended_at is not null
     and c.source = 'session' and c.checked_out_at is null;
$$;
revoke execute on function public.expire_play_sessions() from public, anon, authenticated;


-- ── 6. resolve_court ───────────────────────────────────────────────────────
-- The court at a point: the smallest boundary of the sport containing it,
-- else the nearest venue of the sport within p_radius_m (10 m to 2 km).
-- Returns the CANONICAL venue {id, name, lat, lng, distance_m, inside}:
-- distance_m to the nearest of the facility's rows (0 inside a boundary),
-- inside = within a boundary or a row's geofence radius. null when nothing is
-- close. p_sport null = any sport. resolve_venue is left as it is (1.0.4).
create or replace function public.resolve_court(
  p_lat      double precision,
  p_lng      double precision,
  p_radius_m double precision default 150,
  p_sport    text default 'pickleball'
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_radius double precision := greatest(10, least(coalesce(p_radius_m, 150), 2000));
  v_dlat   double precision;
  v_dlng   double precision;
  v_hit    text;
  v_canon  public.venues;
  v_d      double precision;
  v_inside boolean;
  v_pt     extensions.geometry;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return null; end if;
  v_pt := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326);
  v_dlat := v_radius / 111000.0;
  v_dlng := v_dlat / greatest(cos(radians(p_lat)), 0.01);

  select coalesce(v.canonical_id, v.id) into v_hit
    from public.venues v
   where v.boundary_geom is not null
     and (p_sport is null or v.sport @> array[p_sport])
     and v.confirmation_status <> 'rejected'
     and extensions.st_contains(v.boundary_geom, v_pt)
   order by v.area_sqm asc nulls last, v.id
   limit 1;

  if v_hit is null then
    select coalesce(v.canonical_id, v.id) into v_hit
      from public.venues v
     where (p_sport is null or v.sport @> array[p_sport])
       and v.confirmation_status <> 'rejected'
       and abs(v.lat - p_lat) < v_dlat and abs(v.lng - p_lng) < v_dlng
       and public.haversine_meters(p_lat, p_lng, v.lat, v.lng) <= v_radius
     order by public.haversine_meters(p_lat, p_lng, v.lat, v.lng), v.id
     limit 1;
  end if;
  if v_hit is null then return null; end if;

  select * into v_canon from public.venues where id = v_hit;
  select min(case when v.boundary_geom is not null and extensions.st_contains(v.boundary_geom, v_pt) then 0
                  else public.haversine_meters(p_lat, p_lng, v.lat, v.lng) end),
         bool_or((v.boundary_geom is not null and extensions.st_contains(v.boundary_geom, v_pt))
                 or public.haversine_meters(p_lat, p_lng, v.lat, v.lng) <= coalesce(v.geofence_radius_m, 100))
    into v_d, v_inside
    from public.venues v
   where v.id = v_hit or v.canonical_id = v_hit;

  return jsonb_build_object(
    'id', v_canon.id, 'name', v_canon.name, 'lat', v_canon.lat, 'lng', v_canon.lng,
    'distance_m', round(v_d::numeric, 1), 'inside', coalesce(v_inside, false));
end $$;
revoke all on function public.resolve_court(double precision, double precision, double precision, text) from public, anon;
grant execute on function public.resolve_court(double precision, double precision, double precision, text) to authenticated;

notify pgrst, 'reload schema';
