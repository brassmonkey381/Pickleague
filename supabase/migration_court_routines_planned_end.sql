-- ============================================================
-- Routine check-ins: the closed / open split reaches its open part.
-- Follow-up to migration_court_routines.sql, from the user's report of
-- 2026-10-22 ("the split of closed / open time during a window does not seem
-- to work") and the reviews of the fix (rounds 1 to 4). Three parts:
--   A. a check-in that keeps a routine occurrence also takes its planned end
--      (_pl_checkin_link_plan);
--   B. a routine saved or edited during its stop's window acts today
--      (_pl_materialize_court_routines, save_court_routine);
--   C. a routine deleted or paused during its stop's window takes today's
--      occurrence with it (delete_court_routine, set_court_routine_active).
--
-- ── A. The planned end ──────────────────────────────────────────────────────
-- Before: trg_venue_checkins_plan_link (before insert on venue_checkins)
-- linked a location-confirmed check-in to the occurrence it starts in and
-- copied the occurrence's windows, but left planned_end_at null. On the web
-- (no geofence arrivals) every routine check-in is made by hand and lasted
-- the 2 hours the app asked for, so a 3-hour routine split closed 2 h / open
-- 1 h ended while still closed (live, rolled back: check-in until 10:41, open
-- play from 10:51). Nothing offered the rest: "Staying until" keys off
-- planned_end_at, and the web gets no push. With planned_end_at null,
-- set_checkin_plan also ran the windows to expires_at, so any save cut the
-- open part off.
--
-- Now: the link also sets planned_end_at to the occurrence's planned end, at
-- least 30 minutes after the check-in: the rule process_court_arrivals (B)
-- uses for an arrival, which puts no other cap on it (the 4-hour caps apply
-- when the check-in is extended to it: extend_checkin, set_checkin_plan). A
-- planned end already on the row is kept (process_court_arrivals sets
-- plan_id itself, so the link skips its rows anyway).
--
-- expires_at is NOT stretched to the planned end (decided 2026-10-22):
--   * Doggle (db/migrations/0443_routine_window_30.sql): _check_in_dog_place
--     links a check-in to its planned visit through
--     _link_checkin_to_matching_plan, which only marks the plan completed;
--     the check-in keeps its ordinary length. Doggle has no planned length.
--   * The user's decision 3 (migration_court_routines.sql header): an arrival
--     at a routine court lasts the ordinary arrival length, cut to the planned
--     end when that comes first; a later planned end is one tap away
--     ("Staying until 12 PM?", extend_checkin to it).
--   * set_checkin_plan stretches a check-in only to an end the player sends.
-- So a check-in made by hand lasts what the app asked for. The app asks for
-- the routine's length when a stop with an occurrence is due at that court,
-- never under 2 hours (D1, 2026-10-22: "pickleball sessions should start at
-- 2 hours"), by hand and from a notification's Check in (lib/courtCheckin
-- manualCheckinMinutes: the routine reminder's planned_end_at, else the
-- routines copy), and the line under a check-in offers "Stay until" while
-- planned_end_at is later than expires_at (CheckinPlanLine: the web's way to
-- the open part, and an older build's check-in's), up to what extend_checkin
-- gives without a fix: least(planned end, now + 4 h, coalesce(fix_at,
-- checked_in_at) + 4 h) (stayUntilOffer; asked for more, extend_checkin
-- refuses with pl:checkin.needs_fix once that cap is the end already).
-- Persona checks: R15, R16 (tests/court_routines_personas.sql).
--
-- ── B. A routine saved or edited during its window ──────────────────────────
-- Before: _pl_materialize_court_routines skipped a time already past
-- (continue when v_at <= p_now), and save_court_routine re-made only the
-- occurrences still ahead (planned_at > now()). So a routine saved at 9:44
-- for 9:34 got only tomorrow's occurrence, and an edit at 9:40 kept today's
-- 9:34 occurrence with its old windows and planned end; a check-in by hand
-- then kept nothing new (live, rolled back: probe X4, plan_id, play_windows
-- and planned_end_at all null), while the app counted the stop as due from
-- the weekly time and asked its length (fixed in the app too: only a stop
-- with an occurrence counts, lib/courtRoutineRules routineOccurrenceEndAt).
-- The app's 15-minute time picker makes this the usual case when testing
-- (at 2:37, pick 2:30).
--
-- Now:
--   * _pl_materialize_court_routines makes an occurrence while its window is
--     still open: its time no more than 30 minutes ago (v_at > p_now - 30
--     minutes; the window of _pl_routine_plan_at and the app's stopDueAt),
--     looking at yesterday too, so a window that crosses midnight counts.
--     Everything else is as before: a day already made (skipped, kept or
--     moved) is never made again, nor one within 30 minutes of another plan
--     of mine at that court. The tidy-up in materialize_court_routines
--     deletes an unkept occurrence once its time is more than 30 minutes ago
--     (planned_at < now() - 30 minutes), so the two never meet: nothing it
--     deleted is made again.
--   * save_court_routine re-makes the planned occurrences still in play: its
--     time ahead OR within the last 30 minutes (planned_at > now() - 30
--     minutes), so an edit during the window gives today's occurrence the new
--     time, length and windows (a new row; a time now more than 30 minutes
--     past makes none). A kept (completed) or skipped (cancelled) one stays
--     as it is, as before.
-- Doggle differs here (the lead's decision, round 3): its materializer also
-- skips a time already past (0415 continue when v_at <= now()) and its save
-- re-makes only occurrences ahead (planned_at > now()); a stop set up during
-- its own window waits for the next day there.
--
-- D2 (an open check-in adopting an occurrence whose window opens later) is
-- NOT done here: Doggle does something different, so Doggle wins. There a
-- check-in keeps a routine stop only when it is made within the stop's
-- window (_link_checkin_to_matching_plan at insert, and the
-- process_planned_checkin_rewards sweep, both on the check-in's created_at,
-- 0443); a check-in already open when the window opens keeps nothing, the
-- reminder skips the player as "Already there" (0415
-- process_routine_reminders), and the unkept stop is deleted at +30 minutes.
-- Pickleague already does the same (_pl_checkin_link_plan on insert only;
-- process_court_routine_reminders skips a player checked in there;
-- materialize_court_routines' tidy-up). Persona check R18.
--
-- ── C. A routine deleted or paused during its window ────────────────────────
-- Before (review round 4, gap 1; live, rolled back: probes Z4, Z5, Z7):
-- delete_court_routine and set_court_routine_active (false) took away only
-- the occurrences still ahead (planned_at > now()), which B makes the wrong
-- set: today's occurrence lives up to 30 minutes after its time. Deleted in
-- the window, today's stayed planned with routine_id null (on delete set
-- null), and nothing ever took it away (the tidy-up in
-- materialize_court_routines keys on routine_id). So a check-in by hand kept
-- it and took the deleted routine's windows and planned end; the
-- routine-window override in _pl_court_arrival_off still let a phone arrival
-- check in with automatic check-in off; and a new routine at that time made
-- nothing today (the leftover failed its 30-minute check). A tester deleting
-- a 12:00 routine closed then open and saving a 12:00 one open then closed
-- got the OLD split on a check-in by hand (the original report's symptom).
-- Paused in the window, a check-in still took the split, and the list showed
-- the stop as next.
--
-- Now:
--   * delete_court_routine takes every occurrence of the routine nobody kept
--     (planned or skipped, any time): with its routine gone none can be made
--     again or tidied up, and only routines write court_plans (Doggle keeps
--     past ones "as ordinary plans"; Pickleague has none). A kept
--     (completed) one stays, routine_id cleared, with its check-in.
--   * set_court_routine_active (false) takes the planned occurrences still
--     in play: ahead, or within 30 minutes after their time (the rule of
--     save_court_routine above). A skipped day stays skipped, so a resume
--     never makes it again; a resume during the window makes today's again
--     (the materializer, B), as a save would.
-- Doggle differs (0415: planned_at > now() in both) only because its
-- materializer never makes an occurrence already past. Persona check R19.
--
-- Replaced (same signatures and attributes; execute stays revoked from
-- public, anon, authenticated for the two internal ones, granted to
-- authenticated for the three client RPCs; the trigger itself is unchanged):
--   _pl_checkin_link_plan           (migration_court_routines.sql) + planned_end_at
--   _pl_materialize_court_routines  (migration_court_routines.sql) in-window today
--   save_court_routine              (migration_court_routines.sql) re-makes in-window
--   set_court_routine_active        (migration_court_routines.sql) pause takes in-window
--   delete_court_routine            (migration_court_routines.sql) takes every unkept one
--
-- APPLY ORDER: after migration_court_routines.sql. RE-APPLY after any re-run
-- of migration_court_routines.sql: it puts the old bodies back
-- (build-court-routines-test.mjs and build-presence-test.mjs do this, and
-- state/server-batch2-apply.ps1 applies this file after it when present).
-- Re-runnable; no begin/commit.
--   supabase db query --linked -f supabase/migration_court_routines_planned_end.sql
-- ============================================================


-- ── A. A check-in keeps an occurrence: its windows and planned end ─────────
create or replace function public._pl_checkin_link_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan uuid;
  v_occ  public.court_plans;
begin
  if new.plan_id is null and new.location_confirmed then
    v_plan := public._pl_routine_plan_at(new.user_id, new.venue_id, new.checked_in_at);
    if v_plan is not null then
      select * into v_occ from public.court_plans pl where pl.id = v_plan;
      new.plan_id := v_plan;
      if new.play_windows is null then
        new.play_windows := v_occ.windows;
      end if;
      -- process_court_arrivals' rule: the occurrence's end, at least 30
      -- minutes after the check-in. expires_at stays as asked (see above).
      if new.planned_end_at is null then
        new.planned_end_at := greatest(v_occ.planned_end_at, new.checked_in_at + interval '30 minutes');
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._pl_checkin_link_plan() from public, anon, authenticated;


-- ── B. Occurrences made while their window is open ─────────────────────────
-- Doggle's materialize_checkin_routines (0415), with the clock passed in (the
-- persona tests move it; everything else passes now()). For each active
-- routine (one, or all) at a court its player still stars: yesterday, today
-- and tomorrow in its zone, on its days, the wall clock per date (DST never
-- shifts it), its window not over (its time no more than 30 minutes ago: a
-- routine saved or edited during its window acts today), not within 30
-- minutes of another planned or kept plan of mine at that court; a day
-- already made (a skipped one too) is never made again. Windows made absolute
-- from the start. Returns how many were made.
create or replace function public._pl_materialize_court_routines(p_routine uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  d       date;
  v_today date;
  v_at    timestamptz;
  v_plan  uuid;
  v_n     int := 0;
begin
  for r in
    select cr.id, cr.user_id, cr.venue_id, cr.local_time, cr.days, cr.tz, cr.length_min, cr.windows
      from public.court_routines cr
     where cr.active and (p_routine is null or cr.id = p_routine)
       and public._pl_is_starred(cr.user_id, cr.venue_id)
  loop
    begin
      v_today := (p_now at time zone r.tz)::date;
      for d in select g::date from generate_series(v_today - 1, v_today + 1, interval '1 day') g loop
        continue when (r.days & (1 << (extract(isodow from d)::int - 1))) = 0;
        v_at := (d + r.local_time) at time zone r.tz;
        -- Its window (30 minutes either side, _pl_routine_plan_at) is over.
        continue when v_at <= p_now - interval '30 minutes';
        continue when exists (
          select 1 from public.court_plans x
           where x.user_id = r.user_id
             and x.venue_id = r.venue_id
             and x.status in ('planned', 'completed')
             and x.planned_at between v_at - interval '30 minutes' and v_at + interval '30 minutes');
        v_plan := null;
        insert into public.court_plans (user_id, venue_id, planned_at, planned_end_at, windows, status, routine_id, routine_date)
        values (r.user_id, r.venue_id, v_at, v_at + make_interval(mins => r.length_min),
                public._pl_windows_at(r.windows, v_at), 'planned', r.id, d)
        on conflict (routine_id, routine_date) where routine_id is not null do nothing
        returning id into v_plan;
        if v_plan is not null then v_n := v_n + 1; end if;
      end loop;
    exception when others then
      raise warning 'materialize_court_routines: routine % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return v_n;
end $$;
revoke all on function public._pl_materialize_court_routines(uuid, timestamptz) from public, anon, authenticated;

-- Doggle save_checkin_routine: new (p_routine_id null) or an edit of mine.
-- The court must be one I star (decision 1). Time to the minute, days 1-127,
-- length 30-240 in 15-minute steps, windows per the rules above (null or []
-- = the whole length, not said), zone from the device else my Pickleague
-- zone. Max 12. The planned occurrences still in play (ahead, or within 30
-- minutes after their time: the window) are re-made from the new settings;
-- kept and skipped days stay as they are. Returns list_my_court_routines().
create or replace function public.save_court_routine(
  p_routine_id uuid,
  p_venue      text,
  p_local_time time,
  p_days       integer,
  p_tz         text,
  p_length_min integer,
  p_windows    jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_id      uuid := p_routine_id;
  v_venue   text;
  v_tz      text;
  v_time    time;
  v_windows jsonb;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_venue is null or btrim(p_venue) = '' then
    raise exception using message = 'Couldn''t save your routine because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  if v_id is not null and not exists (select 1 from public.court_routines where id = v_id and user_id = v_me) then
    raise exception using message = 'That routine isn''t in your list any more. Pull to refresh.', hint = 'pl:routine.not_found';
  end if;
  v_venue := public._pl_canonical_venue(p_venue);
  if v_venue is null then
    raise exception using message = 'That court isn''t in Pickleague any more, so it can''t be in your routine. Pick another court.', hint = 'pl:court.gone';
  end if;
  if not public._pl_is_starred(v_me, v_venue) then
    raise exception using message = 'Routines are for your starred courts. Star this court first, then add it to your routine.', hint = 'pl:routine.not_starred';
  end if;
  if p_days is null or p_days < 1 or p_days > 127 then
    raise exception using message = 'Pick at least one day for this routine.', hint = 'pl:routine.bad_days';
  end if;
  if p_local_time is null then
    raise exception using message = 'Pick a time for this routine.', hint = 'pl:routine.bad_time';
  end if;
  if p_length_min is null or p_length_min < 30 or p_length_min > 240 or p_length_min % 15 <> 0 then
    raise exception using message = 'Pick how long you play: 30 minutes to 4 hours.', hint = 'pl:routine.bad_length';
  end if;
  v_time := make_time(extract(hour from p_local_time)::int, extract(minute from p_local_time)::int, 0);
  v_tz := case when public._pickleague_valid_tz(p_tz)
                    and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then p_tz
               else public._pickleague_tz_for(v_me) end;
  v_windows := public._pl_clean_windows(v_me, p_windows, p_length_min);

  if v_id is null then
    -- One at a time per player, so two saves can't both pass the cap.
    perform pg_advisory_xact_lock(hashtext('court_routines:' || v_me::text));
    if (select count(*) from public.court_routines where user_id = v_me) >= 12 then
      raise exception using message = 'You can have up to 12 routine check-ins. Delete one to add this one.', hint = 'pl:routine.limit';
    end if;
    insert into public.court_routines (user_id, venue_id, local_time, days, tz, length_min, windows)
    values (v_me, v_venue, v_time, p_days, v_tz, p_length_min, v_windows)
    returning id into v_id;
  else
    update public.court_routines
       set venue_id = v_venue, local_time = v_time, days = p_days, tz = v_tz,
           length_min = p_length_min, windows = v_windows, updated_at = now()
     where id = v_id and user_id = v_me;
    if not found then
      raise exception using message = 'That routine isn''t in your list any more. Pull to refresh.', hint = 'pl:routine.not_found';
    end if;
  end if;

  -- Still in play: ahead, or in its window (today's, during an edit at 9:40
  -- of a 9:34 routine). Re-made below with the new settings.
  delete from public.court_plans
   where routine_id = v_id and status = 'planned' and planned_at > now() - interval '30 minutes';
  perform public._pl_materialize_court_routines(v_id, now());
  return public.list_my_court_routines();
end $$;
revoke all on function public.save_court_routine(uuid, text, time, integer, text, integer, jsonb) from public, anon;
grant execute on function public.save_court_routine(uuid, text, time, integer, text, integer, jsonb) to authenticated;


-- ── C. A routine deleted or paused during its window ───────────────────────
-- Pause or resume one of mine. Paused: the planned occurrences still in play
-- (ahead, or within 30 minutes after their time: today's during its window)
-- go; a skipped day stays skipped. Resumed: the materializer makes what is
-- due (today's too while its window is open).
create or replace function public.set_court_routine_active(p_routine_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  update public.court_routines set active = coalesce(p_active, true), updated_at = now()
   where id = p_routine_id and user_id = v_me;
  if not found then
    raise exception using message = 'That routine isn''t in your list any more. Pull to refresh.', hint = 'pl:routine.not_found';
  end if;
  if coalesce(p_active, true) then
    perform public._pl_materialize_court_routines(p_routine_id, now());
  else
    -- Still in play: ahead, or in its window (paused at 9:40 for 9:34).
    delete from public.court_plans
     where routine_id = p_routine_id and status = 'planned' and planned_at > now() - interval '30 minutes';
  end if;
  return public.list_my_court_routines();
end $$;
revoke all on function public.set_court_routine_active(uuid, boolean) from public, anon;
grant execute on function public.set_court_routine_active(uuid, boolean) to authenticated;

-- Every occurrence nobody kept goes with it (planned or skipped, today's
-- during its window too): with the routine gone, none can be made again or
-- tidied up (routine_id goes null). A kept one stays with its check-in.
create or replace function public.delete_court_routine(p_routine_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if not exists (select 1 from public.court_routines where id = p_routine_id and user_id = v_me) then
    raise exception using message = 'That routine isn''t in your list any more. Pull to refresh.', hint = 'pl:routine.not_found';
  end if;
  delete from public.court_plans
   where routine_id = p_routine_id and status in ('planned', 'cancelled');
  delete from public.court_routines where id = p_routine_id and user_id = v_me;
  return public.list_my_court_routines();
end $$;
revoke all on function public.delete_court_routine(uuid) from public, anon;
grant execute on function public.delete_court_routine(uuid) to authenticated;
