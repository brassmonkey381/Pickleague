-- ============================================================
-- Offline check-in time (P1) and league joins from old builds (P2)
-- (docs/play-sessions-presence.md, the user's decisions of 2026-10-16).
--
-- ── P1: a check-in's fix is judged against the tap, not the sync ──────────
-- The fix must have been taken within 2 minutes of the tap (Check in, the
-- lock-screen / arrival Check in, Start at a court). A check-in saved with no
-- signal at the court counts when it syncs later; a fresh fix sent with a tap
-- from long ago is refused.
--
-- Representation: NO signature change and no new argument. Every check-in and
-- Start the app sends, live or queued, already carries three numbers from the
-- phone's own clock: p_at (the tap), p_fix_at (when the fix was taken) and
-- p_fix_age_ms (the fix's age when the request is sent, recomputed at every
-- send). p_fix_age_ms keeps its live meaning (the age at send), which the
-- check-out / End stay proof (_pl_record_checkout_fix) also reads. From them
-- the server works out, and the phone's clock offset cancels in each:
--   age_at_tap = p_at - p_fix_at                 (signed; both phone clock)
--   fix_at     = now() - p_fix_age_ms            (server clock, as before)
--   tap_at     = least(now(), fix_at + age_at_tap)
--              = now() minus the time that passed on the phone between the
--                tap and the send
-- Verdicts (_pl_tap_fix):
--   age_at_tap > +2 min         fix.stale       taken too long before the tap
--   age_at_tap < -2 min         fix.after_tap   taken too long after the tap
--   tap_at < now() - 12 hours   checkin.too_old synced too late to count
-- A call with no tap (p_at null: extend_checkin, any call without one) uses
-- now() as the tap: the old window on the age at send (-5 s to +2 min). A fix
-- with no age (no shipped build sends one) keeps the server-clock check
-- (fix.stale_clock) and also needs |p_at - p_fix_at| <= 2 min, so a backdated
-- tap with a fix from now is refused in every call shape.
--
-- Why not Doggle's form (the age measured AT the tap, live calls send no
-- tap): (1) it dates the fix by a phone-clock tap, so a slow phone or any
-- replay would date the arrival fix early and shorten the Phase 1.5 stay
-- proof, which counts from the arrival fix on the server clock; (2) the
-- runtime-1.0.4 OTA in the field sends p_at on every live call plus the age
-- at send, so under Doggle's meaning the server could not tell its live calls
-- from replays, while this rule judges them exactly and makes its queued
-- check-ins count with the SQL alone; (3) start_play_session must keep p_at
-- on live Starts (decision 2 measures the 5-minute floor on the app's own
-- Start and End). No second number is sent, so nothing has to agree.
--
-- Live calls: the app takes the fix (or reuses one under 60 s old), then
-- stamps the tap, so age_at_tap is about 0 to 70 s whatever the phone's
-- clock says. checked_in_at is tap_at (about now), so a phone whose clock is
-- off is never refused and its check-in is never backdated by the offset
-- (before: a slow phone's p_at backdated it).
--
-- Backdating limit: 12 hours from the tap, for every check-in that carries a
-- fix (the same 12 h start_play_session already allows a Start, decision 2).
-- How a confirmed check-in is stored, matching how check-ins expire
-- (expires_at = tap + minutes; the */10 expire_venue_checkins job sets
-- checked_out_at = expires_at):
--   * still running when it syncs: open from tap to tap + minutes;
--   * already over when it syncs: STORED, already over: checked_in_at = tap,
--     expires_at = tap + minutes (or the start of a later check-in of mine),
--     checked_out_at null so the expiry job closes it like any other, and a
--     queued check-out or End right behind it still records the real leave
--     time and its stay fix. Shown to nobody (every presence read wants
--     expires_at > now()), counted in no crowd, but it is a visit (at_court,
--     the stay proof). The app says so once, in the device's zone (it reads
--     expires_at <= created_at, which no clock offset can fake);
--   * tapped more than 12 hours ago: refused, checkin.too_old.
-- A replay never closes or overrides a check-in of mine made after its tap
-- (the app tries a live call before an older queued one): it ends where that
-- one starts, the quiet same-court path joins only a check-in begun at or
-- before the tap, and a replay's older fix never replaces a newer one.
-- Private rows (no fix, 1.0.4 embedded bundles) are replaced as before. The
-- no-fix path is unchanged (6 h clamp, private row).
-- start_play_session: the session row is unchanged (phone-frame clamp, 12 h);
-- its check-in is judged at the tap and anchored there (tap + 180 min, what a
-- live Start already gets), stored already over when that is past; too_old,
-- after_tap and stale give no check-in and are never an error.
-- extend_checkin: unchanged (never queued, no tap: the tap is the send),
-- except that a confirmed check-in stored already over can't be extended
-- back to life in the minutes before the expiry job closes it
-- (checkin.closed).
--
-- ── P2: league joins from old builds ──────────────────────────────────────
-- Bundles from before 2026-10-14 (1.0.2, 1.0.3, a 1.0.4 install still on its
-- embedded bundle) join an open league with .upsert({league_id, user_id,
-- role}) and no onConflict: PostgREST sends INSERT ... ON CONFLICT (id) DO
-- UPDATE SET league_id, user_id, role. Postgres checks UPDATE privilege on
-- every SET column before it runs, conflict or not, and since
-- migration_league_members_lock_identity.sql clients hold UPDATE on role
-- only: every such join failed with 42501, shown as "You don't have access to
-- that." Granting UPDATE (league_id, user_id) adds no capability:
--   * an UPDATE (a PATCH or an upsert's DO UPDATE) reaches only rows passing
--     "Admins can update member roles" (the caller is 'admin' of the row's
--     league; no WITH CHECK, so the same check applies to the new row);
--   * trg_league_members_lock_identity (BEFORE UPDATE OF league_id, user_id,
--     every role) refuses any real change of either column, so a stored row
--     can still differ only in role, under the same policy as before;
--   * admitted_closed, expires_at, joined_at and id stay ungranted;
--   * the INSERT path is unchanged ("Users can join leagues": yourself, as
--     'member', into an open league, or into a league you created).
-- The trigger now refuses with P0001 and a code (pl:membership.locked)
-- instead of 42501 ("You don't have access to that."). No app path reaches it.
--
-- New codes (HINT 'pl:<code>', mapped in mobile/src/lib/refusals.ts):
--   fix.after_tap      the fix was taken more than 2 minutes after the tap
--   checkin.too_old    a check-in reached Pickleague over 12 hours after its
--                      tap (DETAIL {"tapped_at", "limit_hours"})
--   membership.locked  a league membership's league or player can't change
-- fix.stale is reworded ("taken more than 2 minutes before you tapped"); it
-- keeps "location is out of date" and "2 minutes" for 1.0.4's regexes.
--
-- 1.0.4 on this server: embedded bundles send no fix (unchanged paths). The
-- runtime-1.0.4 OTA sends p_at, p_fix_at and the age at send on every call:
-- live calls are accepted as before (checked_in_at becomes the true server
-- time); its queued check-ins under 12 h now count; over 12 h they get
-- checkin.too_old (a code it doesn't know: it shows its own "more than 2
-- minutes after you tapped" notice, which is still true). No new text uses a
-- network word, "expired", "not found" or errcode 42501.
--
-- Signatures, SECURITY DEFINER, search_path = '' and grants are unchanged;
-- every replaced function starts from its LIVE definition (pg_get_functiondef,
-- 2026-10-16, identical to migration_refusal_messages.sql and
-- migration_league_members_lock_identity.sql). One new internal helper
-- (_pl_tap_fix), revoked from clients; no new client RPC, so the allowlist in
-- migration_rls_hardening_2026q3.sql needs no entry (and it audits no column
-- grants).
--
-- Apply AFTER migration_refusal_messages.sql, and again after any re-run of
-- migration_league_members_lock_identity.sql (its table-level revoke drops
-- the P2 column grant too), migration_presence_p1_checkins.sql,
-- migration_validity_rules.sql or migration_refusal_messages.sql (they put
-- the older function bodies back). Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_checkin_tap_time.sql
-- Release: this SQL first, then the OTA (the app words the old server's
-- texts too). Tested by supabase/tests/tap_time_personas.sql
-- (build-presence-test.mjs).
-- ============================================================

-- ════ P1 helpers ════════════════════════════════════════════════════════════

-- _pl_tap_fix (new, internal): when the tap was and whether the fix belongs
-- to it, on the server's clock. Pure arithmetic on the three phone numbers
-- (see the header); position and precision stay with _pl_check_fix.
--   verdict: 'ok' | 'stale' (fix > 2 min before the tap) | 'after_tap' (fix
--   > 2 min after it) | 'too_old' (tap > 12 h ago) | 'stale_clock' (no age,
--   and the fix is not fresh by the server clock)
create or replace function public._pl_tap_fix(
  p_at timestamptz, p_fix_at timestamptz, p_fix_age_ms double precision,
  out tap_at timestamptz, out fix_at timestamptz, out age_at_tap_ms double precision, out verdict text)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_fix_age_ms is not null and p_at is not null and p_fix_at is not null then
    -- The tap rule. Both differences are on the phone's clock, so its offset
    -- cancels; fix_at and tap_at land on the server's.
    age_at_tap_ms := extract(epoch from (p_at - p_fix_at)) * 1000;
    fix_at := now() - make_interval(secs => greatest(p_fix_age_ms, 0) / 1000.0);
    tap_at := least(now(), fix_at + make_interval(secs => age_at_tap_ms / 1000.0));
    verdict := case
                 when age_at_tap_ms > 120000 then 'stale'
                 when age_at_tap_ms < -120000 then 'after_tap'
                 when tap_at < now() - interval '12 hours' then 'too_old'
                 else 'ok'
               end;
  elsif p_fix_age_ms is not null then
    -- No tap to judge against (extend, or no p_at / p_fix_at): the tap is
    -- the send, and the old window on the age at send applies.
    age_at_tap_ms := p_fix_age_ms;
    fix_at := now() - make_interval(secs => greatest(p_fix_age_ms, 0) / 1000.0);
    tap_at := now();
    verdict := case when p_fix_age_ms between -5000 and 120000 then 'ok' else 'stale' end;
  else
    -- No age (no shipped build): the server clock judges p_fix_at as before,
    -- and a tap must still be within 2 minutes of the fix.
    fix_at := p_fix_at;
    age_at_tap_ms := extract(epoch from (coalesce(p_at, now()) - p_fix_at)) * 1000;
    tap_at := least(coalesce(p_at, now()), now());
    verdict := case
                 when p_fix_at is null
                   or p_fix_at < now() - interval '2 minutes'
                   or p_fix_at > now() + interval '1 minute' then 'stale_clock'
                 when p_at is not null and age_at_tap_ms > 120000 then 'stale'
                 when p_at is not null and age_at_tap_ms < -120000 then 'after_tap'
                 else 'ok'
               end;
  end if;
end $$;
revoke all on function public._pl_tap_fix(timestamptz, timestamptz, double precision) from public, anon, authenticated;

-- _pl_raise_unconfirmed_fix: from the live definition (pg_get_functiondef,
-- 2026-10-16). Only the fix.stale text changes: the 2 minutes are measured
-- from the tap now. Same signature, IMMUTABLE, search_path ''.
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
        message = 'Your location is out of date: it was taken more than 2 minutes before you tapped. Try again at the court.',
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

-- ════ P1 check-ins and play sessions ════════════════════════════════════════

-- checkin_venue: from the live definition (pg_get_functiondef, 2026-10-16).
-- Changed: a fix is judged at the tap (_pl_tap_fix); a confirmed check-in is
-- dated at the tap on the server clock; it ends where a later check-in of
-- mine starts; it is stored even when already over; the quiet path and the
-- one-open-check-in rule never touch a check-in made after the tap. The
-- no-fix path (1.0.4 and older bundles) is unchanged.
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
  v_later   timestamptz;
  v_has_fix boolean;
  v_tap     record;
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

  v_has_fix := public._pl_require_fix_shape(p_lat, p_lng);
  if v_has_fix then
    -- The fix must belong to the tap (within 2 minutes of it), and the tap
    -- must be under 12 hours old; both on the phone's own clock.
    select * into v_tap from public._pl_tap_fix(p_at, p_fix_at, p_fix_age_ms);
    if v_tap.verdict = 'after_tap' then
      raise exception using
        message = 'Your location was taken more than 2 minutes after you tapped Check in, so it can''t show you were at the court then. Check in again when you''re at the court.',
        hint = 'pl:fix.after_tap';
    end if;
    if v_tap.verdict = 'too_old' then
      raise exception using
        message = format('This check-in was saved with no signal at %s and reached Pickleague more than 12 hours later, too late to count. Check in again when you''re at the court.',
                         public._pickleague_local_label(v_tap.tap_at, public._pickleague_tz_for(v_uid))),
        hint = 'pl:checkin.too_old',
        detail = jsonb_build_object('tapped_at', v_tap.tap_at, 'limit_hours', 12)::text;
    end if;
    -- Where and how precise (the freshness above replaces _pl_check_fix's).
    select * into v_fix from public._pl_check_fix(v_venue, p_lat, p_lng, p_accuracy_m, null, 0);
    perform public._pl_raise_unconfirmed_fix(v_tap.verdict = 'ok', v_fix.precise, v_fix.confirmed, v_fix.distance_m,
                                             v_tap.verdict <> 'stale_clock', 'check in');
    v_dist := v_fix.distance_m;
    v_fix_at := v_tap.fix_at;
    -- Dated at the tap, on the server clock (never backdated by a wrong
    -- phone clock, never in the future).
    v_at := v_tap.tap_at;
    -- A check-in of mine made after this tap (a live one that landed before
    -- this queued one): this one ends where that one starts.
    select min(c.checked_in_at) into v_later
      from public.venue_checkins c
     where c.user_id = v_uid and c.location_confirmed and c.checked_in_at > v_at;
  else
    -- No fix (1.0.4 and older bundles): honest time for a queued check-in,
    -- never in the future and never more than 6 hours back.
    v_at := greatest(least(coalesce(p_at, now()), now()), now() - interval '6 hours');
  end if;
  v_until := v_at + make_interval(mins => greatest(15, least(coalesce(p_minutes, 120), 240)));
  if v_later is not null then
    v_until := greatest(least(v_until, v_later), v_at + interval '1 second');
  end if;

  -- Already here (same facility, still open): quiet. A confirmed row is
  -- extended by a confirmed call and returned as is to a call without a fix;
  -- a private row is extended by another call without a fix, and replaced
  -- below by a confirmed one. A confirmed call joins only a check-in that
  -- began at or before its tap.
  select * into v_row
    from public.venue_checkins c
   where c.user_id = v_uid and c.checked_out_at is null and c.expires_at > now()
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
     and (not v_has_fix or c.checked_in_at <= v_at)
   order by c.location_confirmed desc, c.checked_in_at desc
   limit 1;
  if v_row.id is not null and (v_row.location_confirmed or not v_has_fix) then
    if v_row.location_confirmed and v_has_fix then
      -- The new fix confirms I am (or was) still here. It becomes the latest
      -- fix only when it is newer: a replay never moves it back.
      update public.venue_checkins
         set expires_at     = greatest(expires_at, v_until),
             fix_lat        = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then p_lat else fix_lat end,
             fix_lng        = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then p_lng else fix_lng end,
             fix_accuracy_m = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then p_accuracy_m else fix_accuracy_m end,
             fix_distance_m = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then v_dist else fix_distance_m end,
             fix_at         = greatest(fix_at, v_fix_at)
       where id = v_row.id
      returning * into v_row;
    elsif not v_row.location_confirmed and not v_has_fix then
      update public.venue_checkins set expires_at = greatest(expires_at, v_until)
       where id = v_row.id
      returning * into v_row;
    end if;
    return v_row;
  end if;

  -- One open check-in per player. A confirmed call closes mine that began at
  -- or before its tap (and any private row); one made after the tap stays.
  update public.venue_checkins
     set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_at, expires_at))
   where user_id = v_uid and checked_out_at is null
     and (not v_has_fix or not location_confirmed or checked_in_at <= v_at);

  -- Stored even when v_until has passed (a replay that synced after it would
  -- have ended): checked_out_at stays null, so the expiry job closes it at
  -- expires_at, and a queued check-out right behind it records when I left.
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
-- Changed: a confirmed check-in stored already over (a replay that synced
-- after it had ended, see checkin_venue) can't be extended back to life in
-- the minutes before expire_venue_checkins closes it. Everything else is
-- unchanged: no tap (it is never queued), so the tap is the send.
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
  -- Saved with no signal and synced after it had ended (a confirmed
  -- check-in, see checkin_venue): it is over, as if the expiry job had closed
  -- it already. A private (no-fix) row keeps its old behaviour.
  if v_row.location_confirmed and v_row.expires_at <= now() and v_row.expires_at <= v_row.created_at then
    raise exception using
      message = format('Your check-in at %s already ended (%s). Check in again when you''re at the court.',
                       coalesce((select v.name from public.venues v where v.id = v_row.venue_id), 'the court'),
                       public._pickleague_local_label(v_row.expires_at, public._pickleague_tz_for(v_uid))),
      hint = 'pl:checkin.closed',
      detail = jsonb_build_object('ended_at', v_row.expires_at)::text;
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

-- start_play_session: from the live definition (pg_get_functiondef, 2026-10-16).
-- Changed: the session's check-in is judged at the tap and anchored there
-- (tap + 180 min, ending where a later check-in of mine starts), stored even
-- when already over; with a fix confirmed at the tap it adopts only a
-- check-in begun at or before the tap, and never closes one made after it;
-- an adopted check-in takes the fix only when it is newer. The session row
-- itself is unchanged (decision 2: the app's own Start time, clamped to 12 h).
create or replace function public.start_play_session(p_id uuid, p_kind text, p_source uuid DEFAULT NULL::uuid, p_venue text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy_m double precision DEFAULT NULL::double precision, p_fix_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_fix_age_ms double precision DEFAULT NULL::double precision)
 RETURNS public.play_sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid      uuid := auth.uid();
  v_at       timestamptz := greatest(least(coalesce(p_at, now()), now()), now() - interval '12 hours');
  v_venue    text := public._pl_canonical_venue(p_venue);
  v_until    timestamptz := greatest(v_at, now()) + interval '180 minutes';
  v_tap      record;
  v_fix      record;
  v_ok       boolean := false;
  v_tap_at   timestamptz;
  v_fix_at   timestamptz;
  v_ci_until timestamptz;
  v_later    timestamptz;
  v_ci       public.venue_checkins;
  v_closed   timestamptz;
  v_row      public.play_sessions;
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

  -- The session's check-in: the fix must belong to the Start tap and the tap
  -- be under 12 hours old (_pl_tap_fix), at the court and precise
  -- (_pl_check_fix). Anything else starts it untracked, never an error.
  if p_lat is not null and p_lng is not null and abs(p_lat) <= 90 and abs(p_lng) <= 180 then
    select * into v_tap from public._pl_tap_fix(p_at, p_fix_at, p_fix_age_ms);
    select * into v_fix from public._pl_check_fix(v_venue, p_lat, p_lng, p_accuracy_m, null, 0);
    v_ok := v_tap.verdict = 'ok' and coalesce(v_fix.confirmed, false);
    if v_ok then
      v_tap_at := v_tap.tap_at;
      v_fix_at := v_tap.fix_at;
      -- Anchored at the tap (a live Start: now + 180 min, as before); ends
      -- where a later check-in of mine starts.
      select min(c.checked_in_at) into v_later
        from public.venue_checkins c
       where c.user_id = v_uid and c.location_confirmed and c.checked_in_at > v_tap_at;
      v_ci_until := greatest(least(v_tap_at + interval '180 minutes', coalesce(v_later, 'infinity'::timestamptz)),
                             v_tap_at + interval '1 second');
    end if;
  end if;

  select * into v_ci
    from public.venue_checkins c
   where c.user_id = v_uid and c.checked_out_at is null and c.expires_at > now() and c.location_confirmed
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
     and (not v_ok or c.checked_in_at <= v_tap_at)
   order by c.checked_in_at desc
   limit 1;
  if v_ci.id is not null then
    if v_ok then
      update public.venue_checkins
         set expires_at     = greatest(expires_at, v_ci_until),
             fix_lat        = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then p_lat else fix_lat end,
             fix_lng        = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then p_lng else fix_lng end,
             fix_accuracy_m = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then p_accuracy_m else fix_accuracy_m end,
             fix_distance_m = case when v_fix_at > coalesce(fix_at, '-infinity'::timestamptz) then v_fix.distance_m else fix_distance_m end,
             fix_at         = greatest(fix_at, v_fix_at)
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

  -- One open check-in per player: close mine begun at or before the tap
  -- (and any private row), never one made after it.
  update public.venue_checkins
     set checked_out_at = greatest(checked_in_at + interval '1 second', least(v_tap_at, expires_at))
   where user_id = v_uid and checked_out_at is null
     and (not location_confirmed or checked_in_at <= v_tap_at);
  -- Stored even when already over (checked_out_at null: End, or the expiry
  -- jobs, close it).
  insert into public.venue_checkins
    (id, user_id, venue_id, checked_in_at, expires_at, source,
     location_confirmed, fix_lat, fix_lng, fix_accuracy_m, fix_at, fix_distance_m)
  values
    (p_id, v_uid, v_venue, v_tap_at, v_ci_until, 'session',
     true, p_lat, p_lng, p_accuracy_m, v_fix_at, v_fix.distance_m)
  on conflict (id) do nothing;
  return v_row;
end $function$;

-- ════ P2: league joins from old builds ══════════════════════════════════════

-- _league_members_lock_identity: from the live definition (pg_get_functiondef,
-- 2026-10-16). The same check; the refusal is now P0001 with a code and a
-- why-then-what text (rule 11), instead of 42501 ("You don't have access to
-- that."). Not SECURITY DEFINER, search_path '', closed to clients.
create or replace function public._league_members_lock_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.league_id is distinct from old.league_id or new.user_id is distinct from old.user_id then
    raise exception using
      message = 'A league membership can''t be moved to another league or player. Leave the league, then join the one you want.',
      hint = 'pl:membership.locked';
  end if;
  return new;
end $function$;
revoke all on function public._league_members_lock_identity() from public, anon, authenticated;

-- The grant below relies on this trigger: (re)create it here too, unchanged.
drop trigger if exists trg_league_members_lock_identity on public.league_members;
create trigger trg_league_members_lock_identity
  before update of league_id, user_id on public.league_members
  for each row execute function public._league_members_lock_identity();

-- Old bundles' merge upsert names league_id and user_id in its DO UPDATE SET.
-- role is already granted (migration_league_members_lock_identity.sql); no
-- table-level UPDATE, nothing for anon.
grant update (league_id, user_id) on public.league_members to authenticated;
