-- ============================================================
-- Court arrival check-ins last 2 hours (was 30 minutes, Doggle's value).
-- Applies on top of the three court arrival files
-- (migration_court_arrival_settings.sql, migration_court_arrival_queue.sql,
-- migration_court_checkin_prompt.sql), after them. Re-runnable: create or
-- replace only, no data change.
--
-- An automatic check-in made by process_court_arrivals now lasts 2 hours from
-- the arrival, as long as a manual check-in's default. Unchanged: the 1-minute
-- dwell, the 5-minute take-back, "Still at <court>?" 5 minutes before the end
-- (once, only while nobody extended it), Stay 1 more hour, the 4-hour cap
-- (extend_checkin), "👋 Checked out" (expire_venue_checkins,
-- _pl_take_back_arrival: neither assumes a length), and the outbox expiries of
-- the pushes ("Checked in" and the failures are worth sending for 30 minutes:
-- how stale a notice may arrive, not how long the check-in lasts).
--
-- "Not extended yet". Before this file, process_court_arrivals (C, "Still at")
-- and cancel_court_arrival (the take-back) each recognised an arrival check-in
-- nobody had extended by expires_at = checked_in_at + interval '30 minutes', a
-- second and third copy of the length. Now:
--   _pl_arrival_length()  the length, written once (process_court_arrivals
--                         sets expires_at = the arrival + it);
--   _pl_arrival_untouched(checked_in_at, expires_at)
--                         its end is still the one the job gave it.
--                         extend_checkin and a Start that adopts it only ever
--                         move expires_at later (greatest(...)), by an hour or
--                         more, so an extended or adopted one never matches.
--                         An arrival check-in made before this file (30
--                         minutes long) still matches, so one that is open
--                         when this is applied keeps its "Still at" and its
--                         take-back.
-- The app's copy of the length: mobile/src/lib/courtArrivalRules.ts
-- (ARRIVAL_CHECKIN_MS; arrivalCheckinUntouched accepts both lengths the same
-- way).
--
-- Replaced, each copied from migration_court_arrival_queue.sql (the only file
-- that defines it) with only the length, the untouched test and their comments
-- changed: cancel_court_arrival, process_court_arrivals. Same signatures,
-- SECURITY DEFINER, search_path '', and the same revoke/grant lines. New
-- internal helpers (execute revoked from clients): _pl_arrival_length,
-- _pl_arrival_untouched.
--
-- Apply order: after the three court arrival files. A re-run of
-- migration_court_arrival_queue.sql puts the 30-minute bodies back, so this
-- file is re-applied after any such re-run (build-presence-test.mjs does).
-- ============================================================


-- ── 1. The length, in one place ────────────────────────────────────────────
create or replace function public._pl_arrival_length()
returns interval
language sql
immutable
security definer
set search_path = ''
as $$
  select interval '2 hours';
$$;
revoke all on function public._pl_arrival_length() from public, anon, authenticated;

-- An arrival check-in whose end is still the one process_court_arrivals gave
-- it: not extended, not adopted by a play session. The 30 minutes are the
-- length before this file, for an arrival check-in made then.
create or replace function public._pl_arrival_untouched(p_checked_in_at timestamptz, p_expires_at timestamptz)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select p_expires_at = p_checked_in_at + public._pl_arrival_length()
      or p_expires_at = p_checked_in_at + interval '30 minutes';
$$;
revoke all on function public._pl_arrival_untouched(timestamptz, timestamptz) from public, anon, authenticated;


-- ── 2. The take-back (from migration_court_arrival_queue.sql) ──────────────

-- The geofence Exit at p_left_at (a replay from the phone's offline queue
-- carries the Exit time; within 2 hours, else now), or Not here (p_not_here,
-- the press time): don't check me in here.
--   dropped  an arrival still waiting out its minute was stopped. With none
--            (yet), a marker refuses an Enter from before I left that lands
--            later, and holds off the next arrival here for 10 minutes.
--   removed  it had become a check-in, now taken back (_pl_take_back_arrival):
--            within 5 minutes of arriving (checked_in_at is the arrival;
--            created_at is the processor's insert, a minute later), not
--            confirmed (Check in now), its end untouched (_pl_arrival_untouched:
--            not extended or adopted), and no play session of mine started
--            here since.
--   closed   an Exit: the same as removed (a later Exit is leaving a real
--            visit, left to the phone's "Leaving X?": background Exits can
--            be spurious). Not here: when nothing was removed, my open
--            check-in here that began by the press is checked out at it.
-- p_venue null (sign-out): stops every arrival of mine still waiting, so
-- nobody is checked in after signing out. The sign-out's own check-out runs
-- beside this and closes what is open, but the job may land an arrival it
-- had already taken after that check-out ran: this waits for the job (the
-- pending rows, then the lock) and checks such an arrival check-in out
-- (closed). Never a take-back here: that would reopen a check-in elsewhere
-- the sign-out just closed.
create or replace function public.cancel_court_arrival(
  p_venue    text default null,
  p_left_at  timestamptz default null,
  p_not_here boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_left    timestamptz := now();
  v_venue   text;
  v_dropped boolean := false;
  v_closed  boolean := false;
  v_removed boolean := false;
  v_ids     uuid[];
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_left_at is not null and p_left_at < now() and p_left_at > now() - interval '2 hours' then
    v_left := p_left_at;
  end if;

  if p_venue is null then
    -- A row the job has already taken (deleted, not yet committed) makes this
    -- wait for the job's commit, then finds it gone.
    update public.pl_pending_arrivals p
       set cancelled_at = v_left
     where p.user_id = v_me and p.cancelled_at is null and p.arrived_at <= v_left;
    v_dropped := found;
    -- After the pending rows, as below. Then every arrival check-in the job
    -- landed is visible: check it out, and drop its unsent "Checked in".
    perform pg_advisory_xact_lock(hashtext('checkin:' || v_me::text));
    with closed as (
      update public.venue_checkins c
         set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_left, c.expires_at))
       where c.user_id = v_me and c.via_arrival and c.checked_out_at is null and c.checked_in_at <= v_left
      returning c.id)
    select array_agg(closed.id) into v_ids from closed;
    v_closed := v_ids is not null;
    if v_closed then
      delete from public.push_outbox o
       where o.recipient_id = v_me and o.notification_id is null
         and o.status in ('pending', 'failed')
         and o.push_data ->> 'checkin_id' in (select x::text from unnest(v_ids) x)
         and o.push_data ->> 'kind' in ('arrival_checkin', 'arrival_extend');
    end if;
    return jsonb_build_object('dropped', v_dropped, 'closed', v_closed, 'removed', false);
  end if;

  v_venue := coalesce(public._pl_canonical_venue(p_venue), p_venue);

  -- Only an arrival from before I left: one after it (I came back) stays.
  update public.pl_pending_arrivals p
     set cancelled_at = v_left
   where p.user_id = v_me and p.venue_id = v_venue
     and p.cancelled_at is null and p.arrived_at <= v_left;
  v_dropped := found;
  if not v_dropped and exists (select 1 from public.venues v where v.id = v_venue) then
    insert into public.pl_pending_arrivals as p (user_id, venue_id, arrived_at, due_at, cancelled_at)
    values (v_me, v_venue, v_left, v_left, v_left)
    on conflict (user_id, venue_id) do update
      set cancelled_at = greatest(p.cancelled_at, excluded.cancelled_at)
      where p.cancelled_at is not null;
  end if;

  -- The lock comes after the pending row, never before: process_court_arrivals
  -- holds the rows it took while it waits for this lock, so taking the lock
  -- first could deadlock with it.
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_me::text));

  select array_agg(c.id) into v_ids
    from public.venue_checkins c
   where c.user_id = v_me
     and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
     and c.via_arrival and not c.arrival_confirmed and c.taken_back_at is null
     and public._pl_arrival_untouched(c.checked_in_at, c.expires_at)
     and c.checked_in_at <= v_left and v_left < c.checked_in_at + interval '5 minutes'
     and not exists (
       select 1 from public.play_sessions s
        where s.user_id = v_me and s.started_at >= c.checked_in_at
          and s.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue));
  v_removed := public._pl_take_back_arrival(v_me, v_ids, v_left);

  if coalesce(p_not_here, false) then
    if not v_removed then
      -- Later, or a check-in I made myself: I'm not here, so check out. A
      -- queued Not here never closes a check-in made after its press.
      update public.venue_checkins c
         set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(v_left, c.expires_at))
       where c.user_id = v_me and c.checked_out_at is null and c.checked_in_at <= v_left
         and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue);
      v_closed := found;
    end if;
  else
    v_closed := v_removed;
  end if;
  return jsonb_build_object('dropped', v_dropped, 'closed', v_closed, 'removed', v_removed);
end $$;
revoke all on function public.cancel_court_arrival(text, timestamptz, boolean) from public, anon;
grant execute on function public.cancel_court_arrival(text, timestamptz, boolean) to authenticated;


-- ── 3. The processor (from migration_court_arrival_queue.sql) ─────────────
-- pg_cron, every 20 seconds (pickleague-process-court-arrivals, unchanged).
-- A. Markers from Exits are needed only while an Enter could still be on its
--    way: purged after 2 hours.
-- B. Arrivals that stayed a minute become check-ins (row 61). Skipped
--    quietly: switched off (everywhere or here) or unstarred while it waited
--    (their own choice; the app takes "At X?" down when they make it); an
--    open check-in of mine at this court already (it is never touched);
--    a confirmed check-in of mine elsewhere begun after the arrival (I moved
--    on, and it stands, as checkin_venue never closes one made after its
--    tap); checked out under this id before it landed (Check out on the
--    phone's own "Checked in"). Told why ("Not checked in at <court>"): the
--    court is gone, a play session is running, or anything failing. No
--    consent re-check: consent can't be withdrawn (consent_seen_at only ever
--    stamps).
-- C. "Still at <court>?" 5 minutes before an arrival check-in ends, once, and
--    only while its end is untouched (_pl_arrival_untouched: extending was a
--    choice to stay; Stay 1 more hour sends its own reminders on the phone).
-- Doggle's deferred friend push is not ported: Pickleague has no friend
-- check-in push yet (row 64).
create or replace function public.process_court_arrivals()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        record;
  v_venue  text;
  v_name   text;
  v_fail   text;
  v_id     uuid;
  v_until  timestamptz;
  v_closed uuid[];
begin
  -- A.
  delete from public.pl_pending_arrivals p
   where p.cancelled_at is not null and p.cancelled_at < now() - interval '2 hours';

  -- B.
  for r in
    delete from public.pl_pending_arrivals p
     where p.due_at <= now() and p.cancelled_at is null
    returning p.user_id, p.venue_id, p.arrived_at, p.checkin_id
  loop
    v_venue := null;
    v_name := null;
    v_fail := null;
    begin
      v_venue := public._pl_canonical_venue(r.venue_id);
      if v_venue is null then
        v_fail := 'court_gone';
      else
        select v.name into v_name from public.venues v where v.id = v_venue;
        if public._pl_court_arrival_off(r.user_id, v_venue) is not null then continue; end if;
        perform pg_advisory_xact_lock(hashtext('checkin:' || r.user_id::text));
        if exists (select 1 from public.venue_checkins c
                    where c.user_id = r.user_id and c.checked_out_at is null and c.expires_at > now()
                      and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue))
        then continue; end if;
        if exists (select 1 from public.venue_checkins c
                    where c.user_id = r.user_id and c.checked_out_at is null and c.expires_at > now()
                      and c.location_confirmed and c.checked_in_at > r.arrived_at)
        then continue; end if;
        if r.checkin_id is not null
           and exists (select 1 from public.presence_closed_ids e where e.user_id = r.user_id and e.id = r.checkin_id)
        then continue; end if;

        -- A session nobody ended counts as running until the 6-hour expiry
        -- (expire_play_sessions) would close it.
        if exists (select 1 from public.play_sessions s
                    where s.user_id = r.user_id and s.ended_at is null
                      and s.started_at > now() - interval '6 hours') then
          v_fail := 'session';
        else
          v_id := r.checkin_id;
          if v_id is null or exists (select 1 from public.venue_checkins c where c.id = v_id) then
            v_id := gen_random_uuid();
          end if;
          v_until := r.arrived_at + public._pl_arrival_length();
          -- One open check-in per player (S11): mine elsewhere ends at the
          -- arrival, and the arrival remembers it for a take-back. One that
          -- has already run out is left to expire_venue_checkins, which
          -- closes it at its own end and says so (and the two jobs never
          -- update the same rows at once).
          with closed as (
            update public.venue_checkins c
               set checked_out_at = greatest(c.checked_in_at + interval '1 second', least(r.arrived_at, c.expires_at))
             where c.user_id = r.user_id and c.checked_out_at is null and c.expires_at > now()
            returning c.id)
          select array_agg(closed.id) into v_closed from closed;
          -- No fix (S4): trg_venue_checkins_arrival leaves arrival_fix_at null.
          insert into public.venue_checkins
            (id, user_id, venue_id, checked_in_at, expires_at, source,
             location_confirmed, via_arrival, arrival_closed_ids)
          values
            (v_id, r.user_id, v_venue, r.arrived_at, v_until, 'geofence',
             true, true, v_closed);
          perform public._pl_court_arrival_push(
            r.user_id, 'arrival_checkin',
            '✅ Checked in at ' || coalesce(v_name, 'your starred court'),
            'You''re checked in. Check out when you leave, or tap Stay 1 more hour if you''re staying.',
            v_venue, v_name, v_id, v_until, true, now() + interval '30 minutes');
        end if;
      end if;
    exception when others then
      raise warning 'court arrival for % at % failed: % (%)', r.user_id, r.venue_id, sqlerrm, sqlstate;
      v_fail := 'error';
    end;
    -- The phone said "Checking you in here in a minute", so say why not.
    if v_fail is not null then
      perform public._pl_court_arrival_push(
        r.user_id, 'arrival_failed',
        'Not checked in at ' || coalesce(v_name, 'your starred court'),
        case v_fail
          when 'court_gone' then 'That court isn''t in Pickleague anymore, so we couldn''t check you in.'
          when 'session' then 'You have a play session running, so we didn''t check you in here.'
          else 'Something went wrong on our side, so we couldn''t check you in. Open Pickleague to check in.'
        end,
        coalesce(v_venue, r.venue_id), v_name, null, null, true, now() + interval '30 minutes');
    end if;
  end loop;

  -- C.
  for r in
    select c.id, c.user_id, c.venue_id, c.expires_at
      from public.venue_checkins c
     where c.via_arrival and c.checked_out_at is null and c.taken_back_at is null
       and c.expires_at > now() and c.expires_at <= now() + interval '5 minutes'
       and public._pl_arrival_untouched(c.checked_in_at, c.expires_at)
  loop
    begin
      if public._pl_throttle_ok(r.user_id::text, 'arrival_extend', r.id::text, interval '100 years') then
        select v.name into v_name from public.venues v where v.id = r.venue_id;
        perform public._pl_court_arrival_push(
          r.user_id, 'arrival_extend',
          'Still at ' || coalesce(v_name, 'the courts') || '?',
          'Your check-in ends in 5 minutes. Tap Stay 1 more hour if you''re staying.',
          r.venue_id, v_name, r.id, r.expires_at, true, r.expires_at);
      end if;
    exception when others then
      raise warning 'Still at push for check-in % not queued: %', r.id, sqlerrm;
    end;
  end loop;
end $$;
revoke all on function public.process_court_arrivals() from public, anon, authenticated;


notify pgrst, 'reload schema';
