-- ============================================================
-- Refusal messages: every refusal says why, and what to do
-- (docs/play-sessions-presence.md, rule 11; the user's standing rule of
-- 2026-10-16: "always give a clear message when something is refused as to why").
--
-- Scope: check-ins, court presence, play sessions, session validity, friends,
-- match recording (confirm, the pending-match notices, the 1-hour expiry) and
-- drill reviews. Messages, codes and returned reasons only:
--   - every function keeps its live identity signature
--     (pg_get_function_identity_arguments, checked 2026-10-16) and its
--     attributes (definer, search_path, volatility);
--   - every replaced function starts from its LIVE definition
--     (pg_get_functiondef, 2026-10-16), not from an older file;
--   - nothing that was allowed is refused, nothing refused is allowed.
-- Two new internal helpers (_pl_session_explain, _pl_notify_match_expired)
-- are revoked from clients; no new client RPC.
--
-- Codes. Each refusal keeps SQLSTATE P0001 and a complete, readable message
-- (1.0.4 and older bundles show the message as is), and carries a stable code
-- in HINT as 'pl:<code>' that the app maps to its own copy (mobile/src/lib/
-- refusals.ts). DETAIL, where set, is a small JSON object with the numbers the
-- app words (distance_m, ended_at, last_fix_at, deadline).
--   auth.signed_out           no user in the request
--   request.bad               the app sent an incomplete request (a bug)
--   court.gone                that court isn't in Pickleague any more
--   court.favorites_full      6th starred court
--   fix.stale / fix.stale_clock / fix.imprecise / fix.not_at_court / fix.malformed
--   checkin.none              extend with nothing open
--   checkin.closed            extend a check-in that already ended
--   checkin.needs_fix         extend past 4 h after the last confirming fix
--   session.not_yours         a Start id that is another account's session
--   match.removed / match.already_confirmed / match.scheduled /
--   match.confirm_expired / match.not_player
--   player.gone / presence.pick_someone
--   friend.self / friend.guest_caller / friend.unclaimed / friend.guest /
--   friend.unavailable / friend.daily_cap / friend.not_friends
-- New returned reasons: confirm_match 'already_your_team' (my team had
-- confirmed already; still waiting on the other team), send_friend_request
-- 'already_friends', respond_friend_request 'already_declined' (Accept on a
-- request I declined). 1.0.4 reads unknown answers as before ('already',
-- 'gone', a confirm).
--
-- 1.0.4 compatibility (how the shipped app turns server errors into copy:
-- friendlySbMessage shows a P0001 message raw; 42501 -> "You don't have access
-- to that."; the lock screen's mapError reads /no longer pending|expired|not
-- found|Invite already/ as "Nothing to answer"; lib/courtCheckinRules reads
-- "need to be at the court", "precise enough", "location is out of date" and
-- "open Pickleague at the court"): every text below keeps the words those
-- regexes need, never adds "expired" / "not found" where they didn't apply,
-- never uses a network word ("timed out", "load failed", "failed to fetch",
-- "network": 1.0.4 would queue the refused write and replay it), and never
-- uses errcode 42501.
--
-- Also: my_session_validity adds keys for the app to word outcomes with
-- (_pl_session_explain: who still has to confirm, whether a drill counts,
-- why something recorded doesn't); the pending-match notice names who really
-- recorded it and gives the deadline in the recipient's zone;
-- expire_pending_matches tells the players why their match is gone and which
-- session stopped counting (an ended one, or one still running).
--
-- Apply AFTER migration_validity_rules.sql (and after any re-run of the
-- presence_p1_* files or that file, which define these functions with the
-- old texts). Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_refusal_messages.sql
-- Tested by supabase/tests/refusal_personas.sql (build-presence-test.mjs).
-- ============================================================

-- ════ Helpers ════════════════════════════════════════════════════════════

-- _pl_raise_unconfirmed_fix: from the live definition (pg_get_functiondef, 2026-10-16).
-- checkin_venue ('check in') and extend_checkin ('stay checked in'). Each text
-- keeps the words the shipped app matches (lib/courtCheckinRules: "need to be
-- at the court", "precise enough", "location is out of date"), which drive the
-- "Start without a court" offer and the lock-screen notice.
create or replace function public._pl_raise_unconfirmed_fix(p_fresh boolean, p_precise boolean, p_confirmed boolean, p_distance_m double precision, p_had_age boolean, p_what text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_d int := coalesce(round(p_distance_m)::int, 0);
begin
  if not coalesce(p_fresh, false) then
    if p_had_age then
      raise exception using
        message = 'Your location is out of date: it''s more than 2 minutes old. Try again at the court.',
        hint = 'pl:fix.stale';
    end if;
    raise exception using
      message = 'Your location is out of date. Check that your phone''s date and time are set automatically, then try again at the court.',
      hint = 'pl:fix.stale_clock';
  end if;
  if not coalesce(p_precise, false) then
    raise exception using
      message = 'Your location isn''t precise enough to confirm you''re at the court. Make sure Precise Location is on for Pickleague, then try again.',
      hint = 'pl:fix.imprecise';
  end if;
  if not coalesce(p_confirmed, false) then
    raise exception using
      message = format('You need to be at the court to %s. You''re about %s m away, so try again when you''re there.',
                       p_what, v_d),
      hint = 'pl:fix.not_at_court',
      detail = format('{"distance_m": %s}', v_d);
  end if;
end $function$;

-- _pl_require_fix_shape: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public._pl_require_fix_shape(p_lat double precision, p_lng double precision)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
begin
  if p_lat is null and p_lng is null then return false; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception using
      message = 'Your location didn''t come through, so Pickleague couldn''t confirm you''re at the court. Try again.',
      hint = 'pl:fix.malformed';
  end if;
  return true;
end $function$;

-- _pl_session_explain (new, internal): the keys my_session_validity adds so
-- the app can say WHY a session counts or doesn't (lib/sessionValidity). Read
-- only, never stored; the owner check is my_session_validity's. Uses the same
-- rules as _pl_session_validity (which keeps its OUT list: its identity
-- signature must not change).
--   started_at, ended_at   the stored times (a Start the no-overlap rule moved
--                          shows here: the app compares them with its own)
--   match_pending          it counts only through a match still waiting for
--                          the other team (open sessions too)
--   confirm_by             the earliest deadline among those matches
--   confirm_needed         who still has to confirm that match (the one with
--                          the earliest deadline): 'theirs' (the other team),
--                          'mine' (an opponent recorded it: the player's own
--                          team), 'both' (a league member who didn't play
--                          recorded it). Only while match_pending.
--   drill_counted          a drill counts for it (so the app never credits a
--                          drill for a session a match made count)
--   why                    something the player recorded doesn't count for it:
--     'match_counted_elsewhere'  (only when nothing counts) a match the player
--                                recorded in its window counts for another of
--                                their sessions (match_at, counted_for_started_at)
--     'drill_not_during_session' a drill reviewed in its window wasn't held
--                                during it (drill_starts_at); also when a
--                                match counts for it
create or replace function public._pl_session_explain(p_session uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s            public.play_sessions;
  v_until      timestamptz;
  v_counted    boolean := false;
  v_done       boolean := false;
  v_confirm_by timestamptz;
  v_drill      boolean := false;
  v_pending    boolean;
  v_why        text;
  v_match_at   timestamptz;
  v_other      uuid;
  v_other_at   timestamptz;
  v_reviewed   boolean := false;
  v_drill_at   timestamptz;
  v_confirmer  text;
begin
  select * into s from public.play_sessions ps where ps.id = p_session;
  if s.id is null then return '{}'::jsonb; end if;
  v_until := coalesce(s.ended_at, now()) + interval '2 hours';

  -- The matches that count for this session (as _pl_session_validity counts them).
  select count(*) > 0,
         coalesce(bool_or(m.status = 'completed'), false),
         min(m.confirm_deadline) filter (where m.status = 'pending')
    into v_counted, v_done, v_confirm_by
    from public.matches m
   where m.status in ('pending', 'completed')
     and (m.player1_id = s.user_id or m.player2_id = s.user_id
          or m.partner1_id = s.user_id or m.partner2_id = s.user_id)
     and (m.play_session_id = s.id or m.created_at between s.started_at and v_until)
     and public._pl_match_session(s.user_id, m.play_session_id, m.created_at) = s.id;

  select exists (
    select 1
      from public.drill_session_reviews r
      join public.drill_sessions d on d.id = r.session_id
     where r.user_id = s.user_id
       and (d.player1_id = s.user_id or d.player2_id = s.user_id)
       and r.created_at between s.started_at and v_until
       and d.starts_at is not null
       and public._pl_drill_session(s.user_id, d.id, r.created_at, d.starts_at, d.length_minutes) = s.id)
    into v_drill;

  v_pending := v_counted and not v_done and not v_drill;

  -- Who still has to confirm the pending match it counts through (the one
  -- with the earliest deadline, as confirm_by): the other team, the player's
  -- own team (an opponent recorded it), or both (a non-player recorded it).
  if v_pending then
    select case
             when (s.user_id in (m.player1_id, m.partner1_id) and m.team1_confirmed_by is not null)
               or (s.user_id in (m.player2_id, m.partner2_id) and m.team2_confirmed_by is not null) then 'theirs'
             when m.team1_confirmed_by is null and m.team2_confirmed_by is null then 'both'
             else 'mine'
           end
      into v_confirmer
      from public.matches m
     where m.status = 'pending'
       and (m.player1_id = s.user_id or m.player2_id = s.user_id
            or m.partner1_id = s.user_id or m.partner2_id = s.user_id)
       and (m.play_session_id = s.id or m.created_at between s.started_at and v_until)
       and public._pl_match_session(s.user_id, m.play_session_id, m.created_at) = s.id
     order by m.confirm_deadline nulls last, m.created_at, m.id
     limit 1;
  end if;

  -- Nothing counts here yet, on a session long enough to take something:
  -- did something the player recorded go elsewhere?
  if not v_counted and not v_drill
     and (s.ended_at is null or s.ended_at - s.started_at >= interval '5 minutes') then
    select m.created_at, public._pl_match_session(s.user_id, m.play_session_id, m.created_at)
      into v_match_at, v_other
      from public.matches m
     where m.status in ('pending', 'completed')
       and (m.player1_id = s.user_id or m.player2_id = s.user_id
            or m.partner1_id = s.user_id or m.partner2_id = s.user_id)
       and (m.play_session_id = s.id or m.created_at between s.started_at and v_until)
     order by m.created_at desc
     limit 1;
    if v_match_at is not null then
      v_why := 'match_counted_elsewhere';
      select ps.started_at into v_other_at from public.play_sessions ps where ps.id = v_other;
    else
      select true, d.starts_at into v_reviewed, v_drill_at
        from public.drill_session_reviews r
        join public.drill_sessions d on d.id = r.session_id
       where r.user_id = s.user_id
         and (d.player1_id = s.user_id or d.player2_id = s.user_id)
         and r.created_at between s.started_at and v_until
       order by r.created_at desc
       limit 1;
      if coalesce(v_reviewed, false) then v_why := 'drill_not_during_session'; end if;
    end if;
  elsif v_counted and not v_drill then
    -- A match counts for it: did the player also review a drill in its
    -- window that doesn't (so the app can say why, never credit the drill)?
    select true, d.starts_at into v_reviewed, v_drill_at
      from public.drill_session_reviews r
      join public.drill_sessions d on d.id = r.session_id
     where r.user_id = s.user_id
       and (d.player1_id = s.user_id or d.player2_id = s.user_id)
       and r.created_at between s.started_at and v_until
     order by r.created_at desc
     limit 1;
    if coalesce(v_reviewed, false) then v_why := 'drill_not_during_session'; end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'started_at', s.started_at,
    'ended_at', s.ended_at,
    'match_pending', v_pending,
    'confirm_by', case when v_pending then v_confirm_by end,
    'confirm_needed', case when v_pending then v_confirmer end,
    'drill_counted', v_drill,
    'why', v_why,
    'match_at', v_match_at,
    'counted_for_started_at', v_other_at,
    'drill_starts_at', v_drill_at));
end $$;
revoke all on function public._pl_session_explain(uuid) from public, anon, authenticated;

-- ════ Check-ins and play sessions ════════════════════════════════════════════════════════════

-- checkin_venue: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.checkin_venue(p_id uuid, p_venue text, p_minutes integer DEFAULT 120, p_source text DEFAULT 'manual'::text, p_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_fix_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_fix_age_ms double precision DEFAULT NULL::double precision)
 RETURNS public.venue_checkins
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_source  text := coalesce(p_source, 'manual');
  v_venue   text;
  v_at      timestamptz;
  v_until   timestamptz;
  v_has_fix boolean;
  v_fix     record;
  v_dist    double precision;
  v_fix_at  timestamptz;
  v_closed  timestamptz;
  v_row     public.venue_checkins;
begin
  if v_uid is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_id is null then raise exception using message = 'Couldn''t check you in because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad'; end if;
  if v_source not in ('manual', 'geofence', 'session') then raise exception using message = 'Couldn''t check you in because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  -- Replay of a check-in that already landed.
  select * into v_row from public.venue_checkins where id = p_id;
  if v_row.id is not null then
    if v_row.user_id <> v_uid then raise exception using message = 'Couldn''t check you in because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad'; end if;
    return v_row;
  end if;

  -- Checked out before it got here: it lands closed. Nothing is stored and no
  -- other check-in is touched (one made since stays open). Not an error, so
  -- a queued replay is not reported as refused.
  select e.closed_at into v_closed
    from public.presence_closed_ids e where e.user_id = v_uid and e.id = p_id;
  if v_closed is not null then
    v_row.id := p_id;
    v_row.user_id := v_uid;
    v_row.venue_id := coalesce(public._pl_canonical_venue(p_venue), p_venue);
    v_row.source := v_source;
    v_row.checked_in_at := least(coalesce(p_at, v_closed), v_closed);
    v_row.expires_at := greatest(v_closed, v_row.checked_in_at + interval '1 second');
    v_row.checked_out_at := v_closed;
    v_row.location_confirmed := false;
    v_row.created_at := now();
    return v_row;
  end if;

  v_venue := public._pl_canonical_venue(p_venue);
  if v_venue is null then
    raise exception using message = 'That court isn''t in Pickleague any more, so you can''t check in there. Find your court again.', hint = 'pl:court.gone';
  end if;

  -- Honest time for a queued (offline) check-in, never in the future and
  -- never more than 6 hours back.
  v_at := greatest(least(coalesce(p_at, now()), now()), now() - interval '6 hours');
  v_until := v_at + make_interval(mins => greatest(15, least(coalesce(p_minutes, 120), 240)));

  v_has_fix := public._pl_require_fix_shape(p_lat, p_lng);
  if v_has_fix then
    select * into v_fix from public._pl_check_fix(v_venue, p_lat, p_lng, p_accuracy_m, p_fix_at, p_fix_age_ms);
    perform public._pl_raise_unconfirmed_fix(v_fix.fresh, v_fix.precise, v_fix.confirmed, v_fix.distance_m,
                                             p_fix_age_ms is not null, 'check in');
    v_dist := v_fix.distance_m;
    v_fix_at := v_fix.fix_at;
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
    if v_row.location_confirmed and v_has_fix then
      -- The new fix confirms I am still here.
      update public.venue_checkins
         set expires_at = greatest(expires_at, v_until),
             fix_lat = p_lat, fix_lng = p_lng, fix_accuracy_m = p_accuracy_m,
             fix_at = v_fix_at, fix_distance_m = v_dist
       where id = v_row.id
      returning * into v_row;
    elsif not v_row.location_confirmed and not v_has_fix then
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
     v_fix_at,
     v_dist)
  returning * into v_row;
  return v_row;
end $function$;

-- extend_checkin: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.extend_checkin(p_id uuid, p_until timestamp with time zone, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_fix_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_fix_age_ms double precision DEFAULT NULL::double precision)
 RETURNS public.venue_checkins
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid  uuid := auth.uid();
  v_row  public.venue_checkins;
  v_fix  record;
  v_want timestamptz;
  v_cap  timestamptz;
begin
  if v_uid is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  select * into v_row from public.venue_checkins where id = p_id and user_id = v_uid;
  if v_row.id is null then
    select * into v_row
      from public.venue_checkins c
     where c.user_id = v_uid and c.checked_out_at is null and c.expires_at > now()
     order by c.checked_in_at desc
     limit 1;
  end if;
  -- Nothing to extend: say which (never the word "expired": 1.0.4's lock
  -- screen would read it as "Nothing to answer").
  if v_row.id is null then
    raise exception using
      message = 'You''re not checked in anywhere, so there''s nothing to extend. Check in when you''re at a court.',
      hint = 'pl:checkin.none';
  end if;
  if v_row.checked_out_at is not null then
    raise exception using
      message = format('Your check-in at %s already ended (%s). Check in again when you''re at the court.',
                       coalesce((select v.name from public.venues v where v.id = v_row.venue_id), 'the court'),
                       public._pickleague_local_label(v_row.checked_out_at, public._pickleague_tz_for(v_uid))),
      hint = 'pl:checkin.closed',
      detail = jsonb_build_object('ended_at', v_row.checked_out_at)::text;
  end if;

  v_want := least(p_until, now() + interval '4 hours');

  if v_row.location_confirmed and public._pl_require_fix_shape(p_lat, p_lng) then
    select * into v_fix
      from public._pl_check_fix(v_row.venue_id, p_lat, p_lng, p_accuracy_m, p_fix_at, p_fix_age_ms);
    perform public._pl_raise_unconfirmed_fix(v_fix.fresh, v_fix.precise, v_fix.confirmed, v_fix.distance_m,
                                             p_fix_age_ms is not null, 'stay checked in');
    update public.venue_checkins
       set expires_at = greatest(expires_at, v_want),
           fix_lat = p_lat, fix_lng = p_lng, fix_accuracy_m = p_accuracy_m,
           fix_at = v_fix.fix_at, fix_distance_m = v_fix.distance_m
     where id = v_row.id
    returning * into v_row;
    return v_row;
  end if;

  if v_want <= v_row.expires_at then return v_row; end if;   -- nothing to add (a replay)
  if v_row.location_confirmed then
    v_cap := coalesce(v_row.fix_at, v_row.checked_in_at) + interval '4 hours';
    if v_cap <= v_row.expires_at then
      raise exception using
        message = format('Pickleague last confirmed you at %s (%s), and a check-in lasts at most 4 hours past that. '
                         'To stay checked in, open Pickleague at the court so it can confirm you''re still there.',
                         coalesce((select v.name from public.venues v where v.id = v_row.venue_id), 'the court'),
                         public._pickleague_local_label(coalesce(v_row.fix_at, v_row.checked_in_at),
                                                        public._pickleague_tz_for(v_uid))),
        hint = 'pl:checkin.needs_fix',
        detail = jsonb_build_object('last_fix_at', coalesce(v_row.fix_at, v_row.checked_in_at))::text;
    end if;
    v_want := least(v_want, v_cap);
  end if;
  update public.venue_checkins set expires_at = greatest(expires_at, v_want)
   where id = v_row.id
  returning * into v_row;
  return v_row;
end $function$;

-- checkout_venue: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.checkout_venue(p_id uuid DEFAULT NULL::uuid, p_source text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_fix_age_ms double precision DEFAULT NULL::double precision)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_filter text := case when p_source in ('manual', 'geofence', 'session') then p_source end;
  v_at     timestamptz := least(coalesce(p_at, now()), now());
  v_ids    uuid[];
begin
  if v_uid is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  if p_id is not null then
    with closed as (
      update public.venue_checkins c
         set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_at, c.expires_at))
       where c.id = p_id and c.user_id = v_uid and c.checked_out_at is null
         and (v_filter is null or c.source = v_filter)
      returning c.id)
    select array_agg(closed.id) into v_ids from closed;
    -- A check-in of mine that is already closed (or another source's): a
    -- replay, nothing to do. An id never stored: close my open row instead.
    if v_ids is not null or exists (select 1 from public.venue_checkins c where c.id = p_id and c.user_id = v_uid) then
      perform public._pl_record_checkout_fix(v_ids, p_lat, p_lng, p_accuracy_m, p_fix_age_ms);
      return coalesce(cardinality(v_ids), 0);
    end if;
    if not exists (select 1 from public.venue_checkins c where c.id = p_id) then
      insert into public.presence_closed_ids (user_id, id, closed_at) values (v_uid, p_id, v_at)
      on conflict do nothing;
    end if;
  end if;

  with closed as (
    update public.venue_checkins c
       set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_at, c.expires_at))
     where c.user_id = v_uid and c.checked_out_at is null
       and (v_filter is null or c.source = v_filter)
    returning c.id)
  select array_agg(closed.id) into v_ids from closed;
  perform public._pl_record_checkout_fix(v_ids, p_lat, p_lng, p_accuracy_m, p_fix_age_ms);
  return coalesce(cardinality(v_ids), 0);
end $function$;

-- start_play_session: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.start_play_session(p_id uuid, p_kind text, p_source uuid DEFAULT NULL::uuid, p_venue text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_fix_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_fix_age_ms double precision DEFAULT NULL::double precision)
 RETURNS public.play_sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_at     timestamptz := greatest(least(coalesce(p_at, now()), now()), now() - interval '12 hours');
  v_venue  text := public._pl_canonical_venue(p_venue);
  v_until  timestamptz := greatest(v_at, now()) + interval '180 minutes';
  v_fix    record;
  v_ok     boolean := false;
  v_ci     public.venue_checkins;
  v_closed timestamptz;
  v_row    public.play_sessions;
begin
  if v_uid is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_id is null then
    raise exception using message = 'Couldn''t save your play session because the app sent an incomplete request. Update Pickleague, then start again.', hint = 'pl:request.bad';
  end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));

  select * into v_row from public.play_sessions where id = p_id;
  if v_row.id is not null then
    if v_row.user_id <> v_uid then
      raise exception using message = 'That play session belongs to another account, so it wasn''t saved. Start a new session.', hint = 'pl:session.not_yours';
    end if;
    return v_row;  -- replay
  end if;

  -- Ended before it got here: store it ended; no check-in, other sessions
  -- (one started since) untouched.
  select e.closed_at into v_closed
    from public.presence_closed_ids e where e.user_id = v_uid and e.id = p_id;
  if v_closed is not null then
    insert into public.play_sessions (id, user_id, kind, source_id, venue_id, started_at, ended_at)
    values (p_id, v_uid, p_kind, p_source, v_venue, v_at, greatest(v_at, v_closed))
    returning * into v_row;
    return v_row;
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

  if p_lat is not null and p_lng is not null and abs(p_lat) <= 90 and abs(p_lng) <= 180 then
    select * into v_fix from public._pl_check_fix(v_venue, p_lat, p_lng, p_accuracy_m, p_fix_at, p_fix_age_ms);
    v_ok := coalesce(v_fix.confirmed, false);
  end if;

  select * into v_ci
    from public.venue_checkins c
   where c.user_id = v_uid and c.checked_out_at is null and c.expires_at > now() and c.location_confirmed
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
   order by c.checked_in_at desc
   limit 1;
  if v_ci.id is not null then
    if v_ok then
      update public.venue_checkins
         set expires_at = greatest(expires_at, v_until),
             fix_lat = p_lat, fix_lng = p_lng, fix_accuracy_m = p_accuracy_m,
             fix_at = v_fix.fix_at, fix_distance_m = v_fix.distance_m
       where id = v_ci.id;
    else
      update public.venue_checkins
         set expires_at = greatest(expires_at,
                                   least(v_until, coalesce(v_ci.fix_at, v_ci.checked_in_at) + interval '4 hours'))
       where id = v_ci.id;
    end if;
    return v_row;
  end if;

  if not public._pl_require_fix_shape(p_lat, p_lng) then return v_row; end if;
  if not v_ok then return v_row; end if;

  update public.venue_checkins
     set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_at, expires_at))
   where user_id = v_uid and checked_out_at is null;
  insert into public.venue_checkins
    (id, user_id, venue_id, checked_in_at, expires_at, source,
     location_confirmed, fix_lat, fix_lng, fix_accuracy_m, fix_at, fix_distance_m)
  values
    (p_id, v_uid, v_venue, v_at, v_until, 'session',
     true, p_lat, p_lng, p_accuracy_m, v_fix.fix_at, v_fix.distance_m)
  on conflict (id) do nothing;
  return v_row;
end $function$;

-- end_play_session: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.end_play_session(p_id uuid, p_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_fix_age_ms double precision DEFAULT NULL::double precision)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_at  timestamptz := least(coalesce(p_at, now()), now());
  v_n   int;
  v_ids uuid[];
begin
  if v_uid is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_uid::text));
  update public.play_sessions
     set ended_at = greatest(v_at, started_at)
   where id = p_id and user_id = v_uid and ended_at is null;
  get diagnostics v_n = row_count;

  if v_n = 0 and p_id is not null and not exists (select 1 from public.play_sessions where id = p_id) then
    insert into public.presence_closed_ids (user_id, id, closed_at) values (v_uid, p_id, v_at)
    on conflict do nothing;
  end if;

  with closed as (
    update public.venue_checkins c
       set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_at, c.expires_at))
     where c.id = p_id and c.user_id = v_uid and c.source = 'session' and c.checked_out_at is null
    returning c.id)
  select array_agg(closed.id) into v_ids from closed;
  perform public._pl_record_checkout_fix(v_ids, p_lat, p_lng, p_accuracy_m, p_fix_age_ms);
  return v_n;  -- 0 on a replay
end $function$;

-- resolve_court: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.resolve_court(p_lat double precision, p_lng double precision, p_radius_m double precision DEFAULT 150, p_sport text DEFAULT 'pickleball'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if auth.uid() is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
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
end $function$;

-- ════ Session validity ════════════════════════════════════════════════════════════

-- my_session_validity: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.my_session_validity(p_session uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if not exists (select 1 from public.play_sessions s where s.id = p_session and s.user_id = v_uid) then
    return null;
  end if;
  -- Plus the keys the app words outcomes with (_pl_session_explain); null
  -- stays null.
  return public._pl_refresh_session_validity(p_session) || public._pl_session_explain(p_session);
end $function$;

-- ════ Matches: confirm, the pending notice, the 1-hour expiry ════════════════════════════════════════════════════════════

-- confirm_match: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.confirm_match(p_match_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_match  record;
  v_team   text;
  v_both   boolean := false;
  v_god    boolean;
  v_mine   boolean;
begin
  if v_uid is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;

  select * into v_match from public.matches where id = p_match_id;
  -- 1.0.4's lock screen reads "expired" / "not found" / "no longer pending" as
  -- "Nothing to answer", and its replay check reads "no longer pending": keep
  -- those words in these texts. The hint is the code the app maps to copy.
  if v_match.id is null then
    raise exception using
      message = 'This match was removed: it expired because it wasn''t confirmed within an hour, or someone deleted it. Ask whoever recorded it to enter it again.',
      hint = 'pl:match.removed';
  end if;
  if v_match.status <> 'pending' then
    if v_match.status = 'scheduled' then
      raise exception using
        message = 'This match is no longer pending: it''s scheduled and has no score yet. Record the score after you play it.',
        hint = 'pl:match.scheduled';
    end if;
    raise exception using
      message = 'This match is no longer pending: it''s already confirmed. Nothing more to do.',
      hint = 'pl:match.already_confirmed';
  end if;
  if v_match.confirm_deadline is not null and v_match.confirm_deadline < now() then
    raise exception using
      message = format('Too late to confirm: the hour to confirm this match expired (%s). Ask whoever recorded it to enter it again.',
                       public._pickleague_local_label(v_match.confirm_deadline, public._pickleague_tz_for(v_uid))),
      hint = 'pl:match.confirm_expired',
      detail = jsonb_build_object('deadline', v_match.confirm_deadline)::text;
  end if;

  v_god := public.is_godmode_user();

  -- Godmode: fill both team slots in one shot, status flips to completed.
  if v_god then
    update public.matches
       set team1_confirmed_by = coalesce(team1_confirmed_by, v_uid),
           team2_confirmed_by = coalesce(team2_confirmed_by, v_uid),
           status             = 'completed'
     where id = p_match_id;
    return 'completed';
  end if;

  -- Non-godmode: must be on the match
  if    v_uid in (v_match.player1_id, v_match.partner1_id) then v_team := 'team1';
  elsif v_uid in (v_match.player2_id, v_match.partner2_id) then v_team := 'team2';
  else
    raise exception using message = 'Only players on this match can confirm it.', hint = 'pl:match.not_player';
  end if;
  -- My team had confirmed already (a stale Confirm, or my partner's push).
  v_mine := case when v_team = 'team1' then v_match.team1_confirmed_by is not null
                 else v_match.team2_confirmed_by is not null end;

  if v_team = 'team1' then
    update public.matches set team1_confirmed_by = v_uid where id = p_match_id;
  else
    update public.matches set team2_confirmed_by = v_uid where id = p_match_id;
  end if;

  select (team1_confirmed_by is not null and team2_confirmed_by is not null)
    into v_both from public.matches where id = p_match_id;
  if v_both then
    update public.matches set status = 'completed' where id = p_match_id;
    return 'completed';
  end if;
  -- Still waiting on the other team. 1.0.4 treats any answer but 'already' as
  -- a confirm, as before.
  if v_mine then return 'already_your_team'; end if;
  return 'one_team_confirmed';
end;
$function$;

-- _notify_pending_match: from the live definition (pg_get_functiondef, 2026-10-16).
-- Same recipients as before (every player but the one who confirmed). The
-- text now says who really recorded it (the signed-in caller: a league member
-- who didn't play confirms neither team), tells the recorder's teammates
-- their team is already confirmed instead of asking them to act, and gives
-- the deadline in the recipient's own zone, with what happens after it.
create or replace function public._notify_pending_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_recipient uuid;
  v_recorder  uuid;
  v_entering  text;
  v_league    text;
  v_others    uuid[];
  v_mine      integer;
  v_theirs    integer;
  v_score     text;
  v_on1       boolean;
  v_team_done boolean;
  v_by        text;
  v_title     text;
  v_body      text;
begin
  if new.status <> 'pending' then return new; end if;

  -- Who recorded it: the signed-in caller, else (server-side inserts) the old rule.
  v_recorder := coalesce(auth.uid(), new.team1_confirmed_by, new.team2_confirmed_by, new.player1_id);
  select full_name into v_entering from public.profiles where id = v_recorder;
  select name into v_league from public.leagues where id = new.league_id;

  v_others := array_remove(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id],
                           coalesce(new.team1_confirmed_by, new.team2_confirmed_by));
  v_others := array_remove(v_others, null);

  foreach v_recipient in array v_others loop
    if v_recipient is null then continue; end if;
    if v_recipient = new.team1_confirmed_by or v_recipient = new.team2_confirmed_by then continue; end if;

    -- The score from this recipient's side: Confirm settles exactly this.
    v_on1 := coalesce(v_recipient in (new.player1_id, new.partner1_id), false);
    if v_on1 then
      v_mine := new.player1_score; v_theirs := new.player2_score;
    else
      v_mine := new.player2_score; v_theirs := new.player1_score;
    end if;
    v_score := case
      when v_mine is null or v_theirs is null then 'no score entered'
      when v_mine > v_theirs then format('you won %s-%s', v_mine, v_theirs)
      when v_mine < v_theirs then format('you lost %s-%s', v_mine, v_theirs)
      else format('a %s-%s tie', v_mine, v_theirs)
    end;

    v_team_done := case when v_on1 then new.team1_confirmed_by is not null else new.team2_confirmed_by is not null end;
    v_by := public._pickleague_local_label(new.confirm_deadline, public._pickleague_tz_for(v_recipient));

    if v_team_done then
      -- The recorder's partner: nothing to do.
      v_title := format('🥒 %s recorded your match', coalesce(v_entering, 'A player'));
      v_body := format('In %s: %s. Your team is confirmed. The other team has %s to confirm, or the match is removed.',
                       coalesce(v_league, 'a league'), v_score,
                       case when v_by is null then 'an hour' else 'until ' || v_by end);
    elsif new.team1_confirmed_by is null and new.team2_confirmed_by is null then
      -- Recorded by someone who didn't play: both teams confirm.
      v_title := '🥒 Match needs your team to confirm';
      v_body := format('%s entered a match in %s: %s. Both teams need to confirm %s if that''s right, or it''s removed.',
                       coalesce(v_entering, 'A player'), coalesce(v_league, 'a league'), v_score,
                       case when v_by is null then 'within an hour' else 'by ' || v_by end);
    else
      v_title := '🥒 Match needs your team to confirm';
      v_body := format('%s entered a match in %s: %s. Confirm %s if that''s right, or it''s removed.',
                       coalesce(v_entering, 'A player'), coalesce(v_league, 'a league'), v_score,
                       case when v_by is null then 'within an hour' else 'by ' || v_by end);
    end if;

    insert into public.notifications (user_id, title, body, type, entity_id, entity_type, is_read, category)
    values (v_recipient, v_title, v_body, 'match', new.id, 'match', false, 'notifyMatchConfirms');
  end loop;

  return new;
exception when others then
  return new;
end;
$function$;

-- _pl_notify_match_expired (new, internal): tell every player of a pending
-- match the 1-hour cron just removed why it is gone, and which of their play
-- sessions stopped counting with it (p_valid_before: the sessions it may have
-- counted for before the delete: ended ones that were valid, and the open one
-- it counted for). An ended session is named when it is no longer valid; an
-- open one (never stored valid until it ends) when it now needs a match or
-- drill again, so a running session never goes on "counting" silently on a
-- match that is gone. Times in each recipient's own zone. No entity_id:
-- the match row is gone, and the app greys out a notice whose target is
-- missing (lib/inboxRequests TARGET_TABLES); the tap opens Match History.
-- Category notifyMatchResults (a result, not a request to answer).
create or replace function public._pl_notify_match_expired(m public.matches, p_valid_before uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
  v_tz        text;
  v_on1       boolean;
  v_mine      boolean;
  v_theirs    boolean;
  v_opp       text;
  v_why       text;
  v_body      text;
  v_lost      record;
begin
  for v_recipient in
    select distinct u.id
      from unnest(array[m.player1_id, m.partner1_id, m.player2_id, m.partner2_id]) as u(id)
     where u.id is not null
  loop
    v_tz := public._pickleague_tz_for(v_recipient);
    v_on1 := coalesce(v_recipient in (m.player1_id, m.partner1_id), false);
    v_mine := case when v_on1 then m.team1_confirmed_by is not null else m.team2_confirmed_by is not null end;
    v_theirs := case when v_on1 then m.team2_confirmed_by is not null else m.team1_confirmed_by is not null end;
    v_opp := case when v_on1
                  then concat_ws(' and ', public._pl_display_name(m.player2_id),
                                 case when m.partner2_id is not null then public._pl_display_name(m.partner2_id) end)
                  else concat_ws(' and ', public._pl_display_name(m.player1_id),
                                 case when m.partner1_id is not null then public._pl_display_name(m.partner1_id) end)
             end;
    v_why := case
      when v_mine and not v_theirs then
        'the other team didn''t confirm it within an hour. Record it again and ask them to confirm.'
      when v_theirs and not v_mine then
        'your team didn''t confirm it within an hour. If the score was right, ask them to record it again, then confirm it in time.'
      else
        'neither team confirmed it within an hour. Record it again, and have both teams confirm it.'
    end;
    v_body := format('Your match vs %s (recorded %s) was removed because %s',
                     v_opp, public._pickleague_local_label(m.created_at, v_tz), v_why);

    -- Sessions that counted only through this match.
    for v_lost in
      select ps.started_at, ps.ended_at
        from public.play_sessions ps
       where ps.id = any (coalesce(p_valid_before, '{}'::uuid[]))
         and ps.user_id = v_recipient
         and ((ps.ended_at is not null and not ps.valid)
              or (ps.ended_at is null
                  and (select x.needs from public._pl_session_validity(ps.id) x) = 'match_or_drill'))
       order by ps.started_at
    loop
      v_body := v_body || format(' Your play session from %s no longer counts.',
                                 public._pickleague_local_label(v_lost.started_at, v_tz));
      if v_lost.ended_at is null then
        v_body := v_body || ' Record a match or drill before you end it, or within 2 hours after, to make it count.';
      elsif v_lost.ended_at + interval '2 hours' > now() then
        v_body := v_body || format(' Record a match or drill by %s to make it count.',
                                   public._pickleague_local_label(v_lost.ended_at + interval '2 hours', v_tz));
      end if;
    end loop;

    insert into public.notifications
      (user_id, title, body, type, entity_id, entity_type, is_read, category, push_data)
    values
      (v_recipient, '🥒 Match removed', v_body, 'match', null, 'match', false, 'notifyMatchResults',
       jsonb_build_object('kind', 'match_expired', 'deep_link', 'match/-'));
  end loop;
end $$;
revoke all on function public._pl_notify_match_expired(public.matches, uuid[]) from public, anon, authenticated;

-- expire_pending_matches: from the live definition (pg_get_functiondef, 2026-10-16).
-- Same rows deleted, same count returned (pg_cron, every minute). One delete
-- per match now, so each one's players hear why it is gone
-- (_pl_notify_match_expired). The delete re-checks the condition, so a
-- confirm that lands in between still wins. A failed notice never keeps a
-- match or stops the run.
create or replace function public.expire_pending_matches()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_deleted integer := 0;
  m         public.matches;
  v_valid   uuid[];
begin
  for m in
    select * from public.matches x
     where x.status = 'pending'
       and coalesce(x.confirm_deadline, x.created_at + interval '1 hour') < now()
     order by x.created_at
  loop
    -- The players' sessions that may count through it right now: ended ones
    -- that are valid, and the open one it counts for (open sessions are
    -- never stored valid until they end).
    select coalesce(array_agg(ps.id), '{}'::uuid[]) into v_valid
      from public.play_sessions ps
     where ps.user_id in (m.player1_id, m.partner1_id, m.player2_id, m.partner2_id)
       and (ps.valid
            or (ps.ended_at is null
                and public._pl_match_session(ps.user_id, m.play_session_id, m.created_at) = ps.id))
       and (ps.id = m.play_session_id
            or m.created_at between ps.started_at and coalesce(ps.ended_at, now()) + interval '2 hours');

    delete from public.matches x
     where x.id = m.id
       and x.status = 'pending'
       and coalesce(x.confirm_deadline, x.created_at + interval '1 hour') < now();
    if not found then continue; end if;
    v_deleted := v_deleted + 1;

    begin
      perform public._pl_notify_match_expired(m, v_valid);
    exception when others then
      raise warning 'expire_pending_matches: notice for match % failed: %', m.id, sqlerrm;
    end;
  end loop;
  return v_deleted;
end;
$function$;

-- ════ Drill reviews ════════════════════════════════════════════════════════════

-- submit_drill_review: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.submit_drill_review(p_session_id uuid, p_consistency integer, p_effort integer, p_organization integer, p_intentionality integer, p_fun integer, p_notes text)
 RETURNS TABLE(success boolean, pickles_granted integer, new_balance integer, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_uid        uuid := auth.uid();
  v_session    public.drill_sessions%rowtype;
  v_balance    int;
  v_notes      text;
  v_answered   int := 0;
  v_sum        int := 0;
  v_facet_pick int;
  v_text_pick  int;
  v_total      int;
  c1 int; c2 int; c3 int; c4 int; c5 int;
begin
  if v_uid is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  select pickles into v_balance from public.profiles where id = v_uid;
  v_balance := coalesce(v_balance, 0);

  select * into v_session from public.drill_sessions where id = p_session_id;
  if not found then
    return query select false, 0, v_balance, 'This drill was cancelled or removed, so it can''t be reviewed.'::text;
    return;
  end if;
  if v_uid <> v_session.player1_id and v_uid <> v_session.player2_id then
    return query select false, 0, v_balance, 'Only the two players in this drill can review it.'::text;
    return;
  end if;
  if v_session.starts_at is not null and v_session.starts_at > now() then
    return query select false, 0, v_balance, format('This drill starts %s. You can review it after it starts.',
                  public._pickleague_local_label(v_session.starts_at, public._pickleague_tz_for(v_uid)));
    return;
  end if;
  if exists (
    select 1 from public.drill_session_reviews
     where session_id = p_session_id and user_id = v_uid
  ) then
    return query select false, 0, v_balance, 'You already reviewed this drill. Each drill gets one review.'::text;
    return;
  end if;

  -- Clamp each facet to 1..5, or null when unanswered.
  c1 := case when p_consistency    is null then null else least(greatest(p_consistency,    1), 5) end;
  c2 := case when p_effort         is null then null else least(greatest(p_effort,         1), 5) end;
  c3 := case when p_organization   is null then null else least(greatest(p_organization,   1), 5) end;
  c4 := case when p_intentionality is null then null else least(greatest(p_intentionality, 1), 5) end;
  c5 := case when p_fun            is null then null else least(greatest(p_fun,            1), 5) end;

  if c1 is not null then v_answered := v_answered + 1; v_sum := v_sum + c1; end if;
  if c2 is not null then v_answered := v_answered + 1; v_sum := v_sum + c2; end if;
  if c3 is not null then v_answered := v_answered + 1; v_sum := v_sum + c3; end if;
  if c4 is not null then v_answered := v_answered + 1; v_sum := v_sum + c4; end if;
  if c5 is not null then v_answered := v_answered + 1; v_sum := v_sum + c5; end if;

  if v_answered = 0 then
    return query select false, 0, v_balance, 'Rate at least one thing to send your review.'::text;
    return;
  end if;

  v_notes      := nullif(btrim(coalesce(p_notes, '')), '');
  v_facet_pick := v_answered * 5;                                              -- 5 per facet
  v_text_pick  := least(floor(char_length(coalesce(v_notes, '')) * 0.1)::int, 50); -- 0.1/char, cap 50
  v_total      := v_facet_pick + v_text_pick;

  insert into public.drill_session_reviews
    (session_id, user_id, rating, consistency, effort, organization, intentionality, fun, notes, pickles_granted)
  values
    (p_session_id, v_uid, round(v_sum::numeric / v_answered)::int, c1, c2, c3, c4, c5, v_notes, v_total);

  update public.profiles
     set pickles = pickles + v_total
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_total, v_balance, 'Thanks for reviewing!'::text;
end;
$function$;

-- ════ Friends ════════════════════════════════════════════════════════════

-- send_friend_request: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.send_friend_request(p_user uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me    uuid := auth.uid();
  v_tz    text;
  v_quiet boolean;
  r       public.friendships;
  v_unclaimed boolean;
  v_guest     boolean;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_user is null then
    raise exception using message = 'We couldn''t find that player. Open their profile and try again.', hint = 'pl:player.gone';
  end if;
  if p_user = v_me then
    raise exception using message = 'You can''t add yourself as a friend.', hint = 'pl:friend.self';
  end if;
  if public._pl_presence_viewer_is_guest(v_me) then
    raise exception using message = 'Guest passes can''t add friends. Create an account to add friends.', hint = 'pl:friend.guest_caller';
  end if;
  if not public._pl_friendable(p_user) or public.blocked_between(v_me, p_user) then
    -- Say why only for what the profile already shows anyone (not joined
    -- yet, a guest pass). Deleted, unknown and blocked share the one vague
    -- line, so it never singles out a block (decision 1).
    select p.is_unclaimed, p.is_guest into v_unclaimed, v_guest
      from public.profiles p where p.id = p_user and p.deleted_at is null;
    if coalesce(v_unclaimed, false) then
      raise exception using
        message = format('%s hasn''t joined Pickleague yet, so you can''t add them as a friend.',
                         public._pl_display_name(p_user)),
        hint = 'pl:friend.unclaimed';
    end if;
    if coalesce(v_guest, false) then
      raise exception using
        message = format('%s is on a guest pass, so you can''t add them as a friend until they create an account.',
                         public._pl_display_name(p_user)),
        hint = 'pl:friend.guest';
    end if;
    raise exception using message = 'This player isn''t available', hint = 'pl:friend.unavailable';
  end if;
  perform public._pl_lock_pair(v_me, p_user);

  select * into r from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user);

  if r.status = 'accepted' then return 'already_friends'; end if;   -- 1.0.4 reads any unknown answer as 'already'
  if r.status = 'pending' then
    if r.requester_id = v_me then return 'already'; end if;
    -- They asked me first: this is a yes.
    update public.friendships set status = 'accepted', responded_at = now() where id = r.id;
    perform public._pl_clear_friend_request_notices(p_user, v_me);
    perform public._pl_notify_friend(p_user, v_me, 'friend_accepted');
    return 'accepted';
  end if;

  v_tz := public._pickleague_tz_for(v_me);
  if (select count(*) from public.friend_request_log l
       where l.sender_id = v_me
         and l.sent_at >= (date_trunc('day', now() at time zone v_tz) at time zone v_tz)) >= 20 then
    raise exception using message = 'You''ve sent 20 friend requests today. Try again tomorrow.', hint = 'pl:friend.daily_cap';
  end if;

  v_quiet := coalesce(r.status = 'declined' and r.requester_id = v_me
                      and r.responded_at > now() - interval '30 days', false)
          or exists (select 1 from public.friend_request_log l
                      where l.sender_id = v_me and l.addressee_id = p_user and l.notified
                        and l.sent_at > now() - interval '24 hours');

  if r.id is null then
    insert into public.friendships (requester_id, addressee_id) values (v_me, p_user);
  else
    update public.friendships
       set requester_id = v_me, addressee_id = p_user, status = 'pending',
           created_at = now(), responded_at = null
     where id = r.id;
  end if;
  insert into public.friend_request_log (sender_id, addressee_id, notified) values (v_me, p_user, not v_quiet);
  if not v_quiet then
    perform public._pl_notify_friend(p_user, v_me, 'friend_request');
  end if;
  return 'pending';
end $function$;

-- respond_friend_request: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.respond_friend_request(p_user uuid, p_accept boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
  r    public.friendships;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_user is null or p_user = v_me then return 'gone'; end if;
  perform public._pl_lock_pair(v_me, p_user);

  select * into r from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user);
  if r.id is null or public.blocked_between(v_me, p_user) then return 'gone'; end if;
  if r.status = 'accepted' then return 'accepted'; end if;
  if r.requester_id <> p_user then return 'gone'; end if;   -- my own request to them
  -- Accept on a request I already declined (a stale button): say so, never
  -- 'declined' to an Accept. 1.0.4 reads the unknown answer as 'gone'.
  if r.status = 'declined' then
    return case when coalesce(p_accept, false) then 'already_declined' else 'declined' end;
  end if;

  if coalesce(p_accept, false) then
    update public.friendships set status = 'accepted', responded_at = now() where id = r.id;
    perform public._pl_clear_friend_request_notices(p_user, v_me);
    perform public._pl_notify_friend(p_user, v_me, 'friend_accepted');
    return 'accepted';
  end if;
  update public.friendships set status = 'declined', responded_at = now() where id = r.id;
  perform public._pl_clear_friend_request_notices(p_user, v_me);
  return 'declined';
end $function$;

-- cancel_friend_request: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.cancel_friend_request(p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
  v_n  int;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform public._pl_lock_pair(v_me, p_user);
  delete from public.friendships
   where requester_id = v_me and addressee_id = p_user and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n > 0 then perform public._pl_clear_friend_request_notices(v_me, p_user); end if;
  return v_n > 0;
end $function$;

-- remove_friend: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.remove_friend(p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
  v_n  int;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  perform public._pl_lock_pair(v_me, p_user);
  delete from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user)
     and f.status = 'accepted';
  get diagnostics v_n = row_count;
  delete from public.close_friends
   where (user_id = v_me and friend_id = p_user) or (user_id = p_user and friend_id = v_me);
  return v_n > 0;
end $function$;

-- set_close_friend: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.set_close_friend(p_user uuid, p_on boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if not coalesce(p_on, true) then
    delete from public.close_friends where user_id = v_me and friend_id = p_user;
    return false;
  end if;
  if p_user is null or p_user = v_me or not public.are_friends(v_me, p_user) then
    raise exception using
      message = case when p_user is null or p_user = v_me then 'Only friends can be close friends.'
                     else format('You and %s aren''t friends, so they can''t be a close friend.',
                                 public._pl_display_name(p_user)) end,
      hint = 'pl:friend.not_friends';
  end if;
  insert into public.close_friends (user_id, friend_id) values (v_me, p_user) on conflict do nothing;
  return true;
end $function$;

-- friendship_status_with: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.friendship_status_with(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
  r    public.friendships;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_user = v_me then return jsonb_build_object('status', 'self', 'is_close_friend', false); end if;
  if p_user is null or public._pl_presence_viewer_is_guest(v_me) or not public._pl_friendable(p_user)
     or public.blocked_between(v_me, p_user) then
    return jsonb_build_object('status', 'unavailable', 'is_close_friend', false);
  end if;

  select * into r from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_me, p_user)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_me, p_user);
  return jsonb_build_object(
    'status', case
                when r.status = 'accepted' then 'friends'
                when r.status = 'pending' and r.requester_id = v_me then 'pending_outgoing'
                when r.status = 'pending' then 'pending_incoming'
                else 'none'
              end,
    'is_close_friend', coalesce(r.status = 'accepted', false) and exists (
      select 1 from public.close_friends cf where cf.user_id = v_me and cf.friend_id = p_user));
end $function$;

-- ════ Presence reads and settings ════════════════════════════════════════════════════════════

-- venue_crowd: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.venue_crowd(p_venue_ids text[])
 RETURNS TABLE(venue_id text, here_now integer, band_low numeric, band_high numeric, friends_here integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if coalesce(cardinality(p_venue_ids), 0) > 50 then raise exception 'At most 50 courts at a time'; end if;
  return query
    select r.vid, x.here_now, x.band_low, x.band_high, x.friends_here
      from (select distinct u.vid, public._pl_canonical_venue(u.vid) as canon
              from unnest(p_venue_ids) as u(vid) where u.vid is not null) r
      cross join lateral public._pl_venue_crowd(auth.uid(), r.canon) x
     where r.canon is not null;
end $function$;

-- friends_at_courts: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.friends_at_courts(p_hours integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me    uuid := auth.uid();
  v_since timestamptz := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 12), 24)));
  v_now   jsonb;
  v_courts jsonb;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;

  with cand as (
    select case when f.requester_id = v_me then f.addressee_id else f.requester_id end as uid
      from public.friendships f
     where f.status = 'accepted' and v_me in (f.requester_id, f.addressee_id)
    union
    select mb.user_id
      from public.league_members ma
      join public.leagues l on l.id = ma.league_id and not l.is_open
      join public.league_members mb on mb.league_id = ma.league_id and mb.user_id <> v_me
     where ma.user_id = v_me
       and ma.admitted_closed and mb.admitted_closed
       and (ma.expires_at is null or ma.expires_at > now())
       and (mb.expires_at is null or mb.expires_at > now())
  ),
  seen as (
    select c.id, c.user_id, c.checked_in_at, c.expires_at, c.source,
           coalesce(v.canonical_id, v.id) as canon,
           p.full_name, p.avatar_url, p.avatar_emoji, p.avatar_bg_color
      from cand
      join public.venue_checkins c on c.user_id = cand.uid and c.checked_out_at is null
      join public.venues v on v.id = c.venue_id
      join public.profiles p on p.id = c.user_id and p.deleted_at is null
     where c.expires_at > now()
       and c.checked_in_at > v_since
       and c.location_confirmed
       and public._pl_can_see_presence(v_me, c.user_id, 'checkins') = 'named'
     order by c.checked_in_at desc
     limit 100
  ),
  people as (
    select s.*,
           exists (select 1 from public.close_friends cf where cf.user_id = v_me and cf.friend_id = s.user_id) as is_close,
           ps.kind as session_kind,
           (s.source = 'session' or ps.id is not null) as via_session
      from seen s
      left join lateral (
        select x.id, x.kind
          from public.play_sessions x
         where x.user_id = s.user_id and x.ended_at is null
           and x.started_at > now() - interval '6 hours'
           and (x.id = s.id or x.venue_id in (select v.id from public.venues v
                                               where v.id = s.canon or v.canonical_id = s.canon))
         order by x.started_at desc
         limit 1
      ) ps on true
  ),
  grouped as (
    select pe.canon,
           min(pe.checked_in_at) as since,
           max(pe.expires_at) as until_at,
           count(*) as n,
           jsonb_agg(jsonb_build_object(
             'user_id', pe.user_id, 'full_name', pe.full_name, 'avatar_url', pe.avatar_url,
             'avatar_emoji', pe.avatar_emoji, 'avatar_bg_color', pe.avatar_bg_color,
             'is_close_friend', pe.is_close, 'via_session', pe.via_session,
             'session_kind', pe.session_kind,
             'checked_in_at', pe.checked_in_at, 'expires_at', pe.expires_at)
             order by pe.is_close desc, pe.checked_in_at) as people
      from people pe
     group by pe.canon
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'venue_id', g.canon, 'venue_name', v.name, 'lat', v.lat, 'lng', v.lng,
           'since', g.since, 'until', g.until_at, 'people', g.people,
           'others_here', greatest(0, cr.here_now - g.n
             - case when exists (select 1 from public.venue_checkins m
                                  where m.user_id = v_me and m.checked_out_at is null
                                    and m.expires_at > now() and m.location_confirmed
                                    and m.venue_id in (select x.id from public.venues x
                                                        where x.id = g.canon or x.canonical_id = g.canon))
                    then 1 else 0 end))
           order by g.n desc, g.since), '[]'::jsonb)
    into v_now
    from grouped g
    join public.venues v on v.id = g.canon
    cross join lateral public._pl_venue_crowd(v_me, g.canon) cr;

  with mine as (
    select coalesce(v.canonical_id, v.id) as canon, 'favorite' as reason, 1 as tier,
           extract(epoch from f.created_at) as ord
      from public.court_favorites f join public.venues v on v.id = f.venue_id
     where f.user_id = v_me
    union all
    select coalesce(v.canonical_id, v.id), 'home', 2, -extract(epoch from coalesce(lm.joined_at, now()))
      from public.league_members lm
      join public.leagues l on l.id = lm.league_id and l.home_venue_id is not null
      join public.venues v on v.id = l.home_venue_id
     where lm.user_id = v_me and (lm.expires_at is null or lm.expires_at > now())
    union all
    select coalesce(v.canonical_id, v.id), 'frequent', 3, -count(*)::double precision
      from public.venue_checkins c join public.venues v on v.id = c.venue_id
     where c.user_id = v_me and c.location_confirmed and c.checked_in_at > now() - interval '60 days'
     group by 1
  ),
  pick as (
    select distinct on (m.canon) m.canon, m.reason, m.tier, m.ord
      from mine m
     order by m.canon, m.tier, m.ord
  ),
  -- Every star shows (at most 5); home and frequent courts fill up to 3.
  ranked as (
    select p.*, row_number() over (order by p.tier, p.ord, p.canon) as rn from pick p
  ),
  top as (
    select * from ranked where tier = 1 or rn <= 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'venue_id', t.canon, 'venue_name', v.name, 'reason', t.reason,
           'here_now', cr.here_now, 'band_low', cr.band_low, 'band_high', cr.band_high,
           'friends_here', cr.friends_here)
           order by t.tier, t.ord, t.canon), '[]'::jsonb)
    into v_courts
    from top t
    join public.venues v on v.id = t.canon
    cross join lateral public._pl_venue_crowd(v_me, t.canon) cr;

  return jsonb_build_object('now', v_now, 'courts', v_courts);
end $function$;

-- set_presence_settings: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.set_presence_settings(p_checkins_level text DEFAULT NULL::text, p_plans_level text DEFAULT NULL::text, p_paused_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_clear_pause boolean DEFAULT false, p_consent_seen boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_checkins_level is not null and p_checkins_level not in ('everyone', 'leaguemates', 'friends', 'hidden') then
    raise exception 'Pick who can see you at the courts';
  end if;
  if p_plans_level is not null and p_plans_level not in ('leaguemates', 'friends', 'hidden') then
    raise exception 'Pick who can see your planned games';
  end if;

  insert into public.presence_settings (user_id) values (v_me) on conflict (user_id) do nothing;
  update public.presence_settings set
    checkins_level  = coalesce(p_checkins_level, checkins_level),
    plans_level     = coalesce(p_plans_level, plans_level),
    paused_until    = case
                        when coalesce(p_clear_pause, false) then null
                        when p_paused_until is null then paused_until
                        when p_paused_until > now() then least(p_paused_until, now() + interval '7 days')
                        else null
                      end,
    consent_seen_at = case when coalesce(p_consent_seen, false) then coalesce(consent_seen_at, now())
                           else consent_seen_at end,
    updated_at      = now()
  where user_id = v_me;
  return public.get_my_presence_settings();
end $function$;

-- hide_presence_from: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.hide_presence_from(p_user uuid, p_hidden boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_user is null or p_user = v_me then raise exception using message = 'You can''t hide from yourself. Pick another player.', hint = 'pl:presence.pick_someone'; end if;
  if coalesce(p_hidden, true) then
    if not exists (select 1 from public.profiles p where p.id = p_user) then
      raise exception using message = 'We couldn''t find that player, so there''s nothing to hide from.', hint = 'pl:player.gone';
    end if;
    insert into public.presence_hidden_from (user_id, hidden_user_id) values (v_me, p_user)
    on conflict do nothing;
    return true;
  end if;
  delete from public.presence_hidden_from where user_id = v_me and hidden_user_id = p_user;
  return false;
end $function$;

-- set_court_favorite: from the live definition (pg_get_functiondef, 2026-10-16).
create or replace function public.set_court_favorite(p_venue text, p_on boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me    uuid := auth.uid();
  v_canon text := public._pl_canonical_venue(p_venue);
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if v_canon is null then
    raise exception using message = 'That court isn''t in Pickleague any more, so it can''t be starred.', hint = 'pl:court.gone';
  end if;
  perform pg_advisory_xact_lock(hashtext('court_favorites:' || v_me::text));

  if not coalesce(p_on, true) then
    delete from public.court_favorites f
     where f.user_id = v_me
       and f.venue_id in (select v.id from public.venues v where v.id = v_canon or v.canonical_id = v_canon);
    return false;
  end if;

  if exists (select 1 from public.court_favorites where user_id = v_me and venue_id = v_canon) then
    return true;
  end if;
  if (select count(*) from public.court_favorites where user_id = v_me) >= 5 then
    raise exception using message = 'You can star up to 5 courts. Unstar one to add this one.', hint = 'pl:court.favorites_full';
  end if;
  insert into public.court_favorites (user_id, venue_id) values (v_me, v_canon);
  return true;
end $function$;

