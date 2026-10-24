-- ============================================================
-- Every check-in starts the play session ("go merge play and check-in").
--
-- The user, 2026-10-24: "should checking-in automatically start a play
-- session? I feel like yes, because even though there's lots of breaks in
-- pickleball, most people consider (time at the courts) equivalent to time
-- spent at pickleball." Approved plan:
--   1. Every check-in starts the play session timer: a check-in by hand
--      (checkin_venue: the centre button, a court card or page, a
--      notification's Check in, a routine's), and an automatic arrival
--      (process_court_arrivals), routine arrivals included.
--   2. A check-out (by hand, by leaving, or by expiry) ends the session. The
--      app then asks "Record a match or drill?" (its End flow); a server-side
--      end reaches the app on its next resume (the island's "session ended").
--   3. (app) Play and Check in are one centre action.
--   4. A taken-back automatic arrival (the 5-minute take-back) removes its
--      session too: no stats left behind.
--
-- How (one trigger-based mechanism; five functions replaced, one condition
-- each, from their live bodies, checked by tests/check-replaced-functions.mjs):
--
--   play_sessions.checkin_id (new): the check-in this session belongs to. A
--   session a check-in started has the check-in's id as its own id too
--   (id = checkin_id), so the app, which picks the check-in's id, can start
--   "the same" session itself on a server without this file (its
--   start_play_session(p_id => <check-in id>) is then a replay here).
--
--   trg_venue_checkins_session (after insert on venue_checkins): an open
--   check-in (not closed, not over, not taken back) of mine
--     * with an open session of mine: that session is adopted (linked) when
--       it has no open check-in yet and is at no court or this court (a
--       "just time it" timer, a Start that landed before its check-in, a
--       Start's own 'session' check-in). One at another court with no open
--       check-in ends where this check-in starts, and a new one starts.
--     * with none: a new 'open_play' session starts at the check-in's time,
--       id = the check-in's id. Not for a 'session' check-in (start_play_
--       session makes those for its own session), nor for an id the app
--       already closed before it landed (presence_closed_ids).
--     * a check-in older than my open session elsewhere (queued offline, it
--       landed late) leaves that session running and starts none.
--   No push: the check-in's own ("Checked in at ...") says it.
--
--   trg_venue_checkins_session_end (after update of checked_out_at,
--   taken_back_at): a check-in that closes ends its open sessions at the
--   check-out (by hand, the expiry job, a check-in elsewhere, sign-out,
--   Not here); a take-back deletes the session the arrival started
--   (id = checkin_id = the arrival) before that; a check-in a take-back
--   reopens (the one the arrival had closed) reopens its session when that
--   is my latest one and ended with the check-in.
--
--   trg_play_sessions_checkin (before insert on play_sessions, before the
--   no-overlap trigger): a Start (start_play_session) right after a check-in
--   started a session takes that one over instead of leaving a stray one: a
--   session my check-in started, at the same court, ended by this Start
--   (ended_at = this start; its check-in still open) under 5 minutes in, with
--   no match linked, is deleted and the new session keeps its start and its
--   check-in. Any other new open session at a court links to my open
--   check-in there, so a check-out ends it as well (Check out = End). Only a
--   check-in with a fix (location_confirmed) is taken over or linked:
--   start_play_session closes a no-fix one when its Start has a fix, which
--   would end the new session at once.
--
--   process_court_arrivals (from migration_court_routines.sql, the live body;
--   one change): "you have a play session running" now means a session with
--   no open check-in. A session that belongs to an open check-in (one that
--   has run out but the expiry job hasn't closed yet included) no longer
--   stops an arrival elsewhere: the arrival closes that check-in (its
--   session ends) and starts its own, as a check-in without a session did.
--
--   cancel_court_arrival (from migration_court_routines.sql, the live body;
--   one change): the take-back still skips an arrival a Start adopted, but
--   not the arrival's own session (s.id <> c.id), which it now always has.
--
--   _pl_venue_open_now, court_play_modes (from migration_court_routines.sql,
--   the live bodies; one condition each): an open_play session counts as
--   "open to play" only when the player started it (Play), not when a
--   check-in started it, so a check-in alone still says nothing (unsaid).
--
--   _pl_take_back_arrival (from migration_court_routines.sql, the live body;
--   one condition): taking an arrival back may reopen a ▶ Play's own
--   'session' check-in the arrival closed (now that a running Play no longer
--   stops an arrival), and with it its session.
--
-- Rewards: no trigger pays for a play session (validity only gates future
-- rewards: valid AND at_court), so an extra session doubles nothing. A Start
-- right after the check-in reuses its session (above), so a match recorded
-- then still counts once, for one session (_pl_match_session). The 6-hour
-- session expiry (expire_play_sessions) is unchanged: a check-in extended past
-- 6 hours keeps going after its session ended. Validity rules unchanged.
--
-- Known gaps (review, 2026-10-24; left for later):
--   * A Start queued offline that lands after a newer check-in elsewhere
--     still ends that check-in's session (start_play_session ends every open
--     session at greatest(its time, their start); not changed here).
--   * A no-fix check-in (builds 1.0.4 and older) then a check-in with a fix
--     at the same court gives two sessions: the first ends at the second.
--   * An arrival at the court where a no-fix ▶ Play runs is still refused
--     ("You have a play session running"); it could link to that session.
--
-- Re-runnable. Re-running migration_court_routines.sql (or the court arrival
-- files) puts the old bodies of the five back: re-run this file afterwards.
-- Internal helpers revoked from public, anon, authenticated;
-- cancel_court_arrival and court_play_modes keep their grants to
-- authenticated. No new client RPC.
-- Persona tests: supabase/tests/checkin_session_personas.sql
-- (build-checkin-session-test.mjs).
-- ============================================================

-- ── 1. The link ────────────────────────────────────────────────────────────
alter table public.play_sessions add column if not exists checkin_id uuid;
comment on column public.play_sessions.checkin_id is
  'The check-in this session belongs to (no FK: check-ins are pruned). id = checkin_id: the check-in started it '
  '(migration_checkin_starts_session.sql). Its check-out ends the session; a take-back of an arrival deletes it.';
create index if not exists play_sessions_checkin_id_idx
  on public.play_sessions (checkin_id) where checkin_id is not null;

-- Open sessions from before this file: a Start's own check-in (same id), or
-- the open check-in it adopted at its court.
update public.play_sessions s
   set checkin_id = coalesce(
         (select c.id from public.venue_checkins c
           where c.id = s.id and c.user_id = s.user_id and c.checked_out_at is null),
         (select c.id from public.venue_checkins c
           where c.user_id = s.user_id and c.checked_out_at is null and c.expires_at > now()
             and s.venue_id is not null
             and c.venue_id in (select v.id from public.venues v where v.id = s.venue_id or v.canonical_id = s.venue_id)
           order by c.checked_in_at desc limit 1))
 where s.ended_at is null and s.checkin_id is null;


-- ── 2. A check-in starts (or adopts) the session ──────────────────────────
create or replace function public._pl_checkin_starts_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s       public.play_sessions;
  v_venue text;
  v_same  boolean;
begin
  if new.checked_out_at is not null or new.expires_at <= now() or new.taken_back_at is not null then
    return null;
  end if;
  v_venue := coalesce((select v.canonical_id from public.venues v where v.id = new.venue_id), new.venue_id);

  select * into s
    from public.play_sessions ps
   where ps.user_id = new.user_id and ps.ended_at is null and ps.started_at > now() - interval '6 hours'
   order by ps.started_at desc
   limit 1;
  if s.id is not null then
    -- Already linked to another open check-in of mine: nothing to do.
    if s.checkin_id is not null and s.checkin_id <> new.id and exists (
         select 1 from public.venue_checkins c
          where c.id = s.checkin_id and c.checked_out_at is null and c.expires_at > now()) then
      return null;
    end if;
    v_same := s.venue_id is null
           or coalesce((select v.canonical_id from public.venues v where v.id = s.venue_id), s.venue_id) = v_venue;
    if v_same then
      update public.play_sessions ps
         set checkin_id = new.id,
             venue_id   = coalesce(ps.venue_id, new.venue_id)
       where ps.id = s.id;
      return null;
    end if;
    -- A check-in older than that session (queued offline, it landed late):
    -- the newer session stays, and this check-in starts none.
    if s.started_at > new.checked_in_at then return null; end if;
    -- A session at another court with no open check-in: I'm here now. One
    -- whose check-in ran out (the expiry job not run yet) ends at its end.
    update public.play_sessions ps
       set ended_at = greatest(ps.started_at, least(new.checked_in_at, now(),
             coalesce((select c.expires_at from public.venue_checkins c
                        where c.id = ps.checkin_id and c.checked_out_at is null), 'infinity'::timestamptz)))
     where ps.id = s.id;
  end if;

  -- A Start's own check-in belongs to its session (start_play_session).
  if new.source = 'session' then return null; end if;
  -- Closed by the app before it landed (an End or a Check out that came first).
  if exists (select 1 from public.presence_closed_ids e where e.user_id = new.user_id and e.id = new.id) then
    return null;
  end if;
  -- One open session per player (a stale one, past the 6-hour expiry's reach).
  update public.play_sessions ps
     set ended_at = greatest(ps.started_at, least(new.checked_in_at, ps.started_at + interval '6 hours'))
   where ps.user_id = new.user_id and ps.ended_at is null;
  insert into public.play_sessions (id, user_id, kind, venue_id, started_at, checkin_id)
  values (new.id, new.user_id, 'open_play', new.venue_id, least(new.checked_in_at, now()), new.id)
  on conflict (id) do nothing;
  return null;
end $$;
revoke all on function public._pl_checkin_starts_session() from public, anon, authenticated;

drop trigger if exists trg_venue_checkins_session on public.venue_checkins;
create trigger trg_venue_checkins_session
  after insert on public.venue_checkins
  for each row execute function public._pl_checkin_starts_session();


-- ── 3. A check-out ends it; a take-back removes it ────────────────────────
create or replace function public._pl_checkin_ends_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A taken-back arrival: the session it started goes (no stats left behind).
  if new.taken_back_at is not null and old.taken_back_at is null then
    delete from public.play_sessions s
     where s.id = new.id and s.user_id = new.user_id and s.checkin_id = new.id;
  end if;

  if new.checked_out_at is not null and old.checked_out_at is null then
    update public.play_sessions s
       set ended_at = greatest(s.started_at, least(new.checked_out_at, now()))
     where s.user_id = new.user_id and s.checkin_id = new.id and s.ended_at is null;
  elsif new.checked_out_at is null and old.checked_out_at is not null then
    -- Reopened (a take-back of the arrival that had closed it): so is its
    -- session, when it ended with the check-in and nothing of mine came after.
    update public.play_sessions s
       set ended_at = null
     where s.user_id = new.user_id and s.checkin_id = new.id and s.ended_at is not null
       and s.started_at > now() - interval '6 hours'
       and s.ended_at between greatest(s.started_at, least(old.checked_out_at, now())) - interval '1 second'
                          and greatest(s.started_at, least(old.checked_out_at, now())) + interval '1 second'
       and not exists (select 1 from public.play_sessions o
                        where o.user_id = s.user_id and o.id <> s.id
                          and (o.ended_at is null or o.started_at >= s.started_at));
  end if;
  return null;
end $$;
revoke all on function public._pl_checkin_ends_session() from public, anon, authenticated;

drop trigger if exists trg_venue_checkins_session_end on public.venue_checkins;
create trigger trg_venue_checkins_session_end
  after update of checked_out_at, taken_back_at on public.venue_checkins
  for each row execute function public._pl_checkin_ends_session();


-- ── 4. A Start takes over the session its check-in just started ───────────
-- Fires before trg_play_sessions_no_overlap (triggers run in name order).
create or replace function public._pl_play_session_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s       public.play_sessions;
  v_venue text;
begin
  if new.ended_at is not null or new.venue_id is null then return new; end if;
  v_venue := coalesce((select v.canonical_id from public.venues v where v.id = new.venue_id), new.venue_id);

  select ps.* into s
    from public.play_sessions ps
    join public.venue_checkins c on c.id = ps.checkin_id
   where ps.user_id = new.user_id and ps.id <> new.id
     and ps.checkin_id = ps.id
     and ps.ended_at is not null
     and ps.ended_at = greatest(new.started_at, ps.started_at)
     and ps.ended_at < ps.started_at + interval '5 minutes'
     and c.user_id = new.user_id and c.checked_out_at is null and c.expires_at > now() and c.location_confirmed
     and coalesce((select v.canonical_id from public.venues v where v.id = ps.venue_id), ps.venue_id) = v_venue
     and not exists (select 1 from public.matches m where m.play_session_id = ps.id)
   order by ps.started_at desc
   limit 1;
  if s.id is not null then
    delete from public.play_sessions ps where ps.id = s.id;
    new.started_at := s.started_at;
    new.checkin_id := s.checkin_id;
    return new;
  end if;

  if new.checkin_id is null then
    select c.id into new.checkin_id
      from public.venue_checkins c
     where c.user_id = new.user_id and c.checked_out_at is null and c.expires_at > now() and c.location_confirmed
       and c.venue_id in (select v.id from public.venues v where v.id = v_venue or v.canonical_id = v_venue)
     order by c.checked_in_at desc
     limit 1;
  end if;
  return new;
end $$;
revoke all on function public._pl_play_session_checkin() from public, anon, authenticated;

drop trigger if exists trg_play_sessions_checkin on public.play_sessions;
create trigger trg_play_sessions_checkin
  before insert on public.play_sessions
  for each row execute function public._pl_play_session_checkin();


-- ── 5. cancel_court_arrival: the arrival's own session doesn't block ──────
-- From migration_court_routines.sql (the live body). Changed: the take-back
-- skips an arrival a Start adopted (a session at the court started since),
-- but not the session the arrival itself started (s.id <> c.id).
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
         and o.push_data ->> 'kind' in ('arrival_checkin', 'arrival_extend', 'arrival_extend_until');
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
     and (c.expires_at = c.arrival_until or public._pl_arrival_untouched(c.checked_in_at, c.expires_at))
     and c.checked_in_at <= v_left and v_left < c.checked_in_at + interval '5 minutes'
     and not exists (
       select 1 from public.play_sessions s
        where s.user_id = v_me and s.started_at >= c.checked_in_at and s.id <> c.id
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


-- ── 6. process_court_arrivals: a check-in's session doesn't block ─────────
-- From migration_court_routines.sql (the live body). Changed: only a session
-- with no open check-in (a timer, or a Start elsewhere that checked nobody
-- in; one that ran out but isn't closed yet still counts) stops an arrival ("You have a play session running"); a session that
-- belongs to an open check-in ends with it when the arrival closes that
-- check-in, and the arrival starts its own (trg_venue_checkins_session).
create or replace function public.process_court_arrivals()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r          record;
  v_venue    text;
  v_name     text;
  v_fail     text;
  v_id       uuid;
  v_until    timestamptz;
  v_closed   uuid[];
  v_plan_id  uuid;
  v_plan_end timestamptz;
  v_windows  jsonb;
  v_tz       text;
  v_mode     text;
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
        -- (expire_play_sessions) would close it. One that belongs to an open
        -- check-in (run out or not) ends with it below, or at its end
        -- (migration_checkin_starts_session.sql).
        if exists (select 1 from public.play_sessions s
                    where s.user_id = r.user_id and s.ended_at is null
                      and s.started_at > now() - interval '6 hours'
                      and not exists (select 1 from public.venue_checkins sc
                                       where sc.id = s.checkin_id and sc.user_id = r.user_id
                                         and sc.checked_out_at is null)) then
          v_fail := 'session';
        else
          v_id := r.checkin_id;
          if v_id is null or exists (select 1 from public.venue_checkins c where c.id = v_id) then
            v_id := gen_random_uuid();
          end if;
          v_until := r.arrived_at + public._pl_arrival_length();
          -- A routine stop (decision 3): its planned end, if first.
          v_plan_id := public._pl_routine_plan_at(r.user_id, v_venue, r.arrived_at);
          v_plan_end := null;
          v_windows := null;
          v_tz := null;
          if v_plan_id is not null then
            select greatest(pl.planned_end_at, r.arrived_at + interval '30 minutes'), pl.windows,
                   coalesce(cr.tz, public._pickleague_tz_for(r.user_id))
              into v_plan_end, v_windows, v_tz
              from public.court_plans pl
              left join public.court_routines cr on cr.id = pl.routine_id
             where pl.id = v_plan_id;
            v_until := least(v_until, v_plan_end);
          end if;
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
             location_confirmed, via_arrival, arrival_closed_ids,
             arrival_until, plan_id, planned_end_at, play_windows)
          values
            (v_id, r.user_id, v_venue, r.arrived_at, v_until, 'geofence',
             true, true, v_closed,
             v_until, v_plan_id, v_plan_end, v_windows);
          if v_plan_id is null then
            perform public._pl_court_arrival_push(
              r.user_id, 'arrival_checkin',
              '✅ Checked in at ' || coalesce(v_name, 'your starred court'),
              'You''re checked in. Check out when you leave, or tap Stay 1 more hour if you''re staying.',
              v_venue, v_name, v_id, v_until, true, now() + interval '30 minutes');
          else
            v_mode := public._pl_windows_summary(v_windows, greatest(now(), r.arrived_at), v_tz);
            perform public._pl_court_push(
              r.user_id,
              '✅ Checked in at ' || coalesce(v_name, 'your starred court') || ' until ' || public._pl_clock(v_plan_end, v_tz),
              coalesce(v_mode || '. ', '') || 'Your planned check-in. Check out when you leave.',
              v_name, now() + interval '30 minutes',
              jsonb_build_object('kind', 'arrival_checkin', 'venue_id', v_venue, 'venue_name', v_name,
                                 'checkin_id', v_id, 'expires_at', v_until, 'via_arrival', true,
                                 'plan_id', v_plan_id, 'planned_end_at', v_plan_end));
          end if;
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
    select c.id, c.user_id, c.venue_id, c.expires_at, c.planned_end_at
      from public.venue_checkins c
     where c.via_arrival and c.checked_out_at is null and c.taken_back_at is null
       and c.expires_at > now() and c.expires_at <= now() + interval '5 minutes'
       and (c.expires_at = c.arrival_until or public._pl_arrival_untouched(c.checked_in_at, c.expires_at))
  loop
    begin
      if public._pl_throttle_ok(r.user_id::text, 'arrival_extend', r.id::text, interval '100 years') then
        select v.name into v_name from public.venues v where v.id = r.venue_id;
        if r.planned_end_at is not null and r.planned_end_at > r.expires_at + interval '1 minute' then
          v_tz := coalesce((select cr.tz from public.court_plans pl
                              join public.court_routines cr on cr.id = pl.routine_id
                             where pl.checkin_id = r.id limit 1),
                           public._pickleague_tz_for(r.user_id));
          perform public._pl_court_push(
            r.user_id,
            'Staying until ' || public._pl_clock(r.planned_end_at, v_tz) || '?',
            'Your check-in at ' || coalesce(v_name, 'the courts') || ' ends in 5 minutes. Tap Stay until then if you''re still playing.',
            v_name, r.expires_at,
            jsonb_build_object('kind', 'arrival_extend_until', 'venue_id', r.venue_id, 'venue_name', v_name,
                               'checkin_id', r.id, 'expires_at', r.expires_at, 'via_arrival', true,
                               'planned_end_at', r.planned_end_at));
        else
          perform public._pl_court_arrival_push(
            r.user_id, 'arrival_extend',
            'Still at ' || coalesce(v_name, 'the courts') || '?',
            'Your check-in ends in 5 minutes. Tap Stay 1 more hour if you''re staying.',
            r.venue_id, v_name, r.id, r.expires_at, true, r.expires_at);
        end if;
      end if;
    exception when others then
      raise warning 'Still at push for check-in % not queued: %', r.id, sqlerrm;
    end;
  end loop;
end $$;
revoke all on function public.process_court_arrivals() from public, anon, authenticated;


-- ── 7. "Open to play": a session a check-in started says nothing ──────────
-- From migration_court_routines.sql (the live bodies). Changed: an open_play
-- session counts as "open to play" (nothing said in the check-in's windows)
-- only when the player started it (Play: its id is a fresh one, or its own
-- 'session' check-in's). One a check-in started (its id is a check-in's made
-- by hand or on arrival: the trigger above, or the app starting it with that
-- id on a server without this file) says nothing about how I'm playing, as
-- the check-in alone said nothing before.
create or replace function public._pl_venue_open_now(p_viewer uuid, p_canon text)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct c.user_id)::int
    from public.venue_checkins c
    join public.profiles p on p.id = c.user_id and p.deleted_at is null
    cross join lateral (select public._pl_checkin_mode_at(c.play_windows, now()) as mode offset 0) m
   where c.venue_id in (select v.id from public.venues v where v.id = p_canon or v.canonical_id = p_canon)
     and c.checked_out_at is null and c.expires_at > now() and c.location_confirmed
     and public._pl_can_see_presence(p_viewer, c.user_id, 'checkins') <> 'none'
     and (m.mode = 'open'
          or (m.mode is null
              and exists (select 1 from public.play_sessions s
                           where s.user_id = c.user_id and s.ended_at is null and s.kind = 'open_play'
                             and s.started_at > now() - interval '6 hours'
                             and not exists (select 1 from public.venue_checkins sc
                                              where sc.id = s.id and sc.source <> 'session')
                             and (s.id = c.id or s.venue_id in (select v.id from public.venues v
                                                                 where v.id = p_canon or v.canonical_id = p_canon)))));
$$;
revoke all on function public._pl_venue_open_now(uuid, text) from public, anon, authenticated;

create or replace function public.court_play_modes(p_venue text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_canon text;
  v_guest boolean;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  v_canon := public._pl_canonical_venue(p_venue);
  if v_canon is null then
    return jsonb_build_object('open_now', 0, 'closed_now', 0, 'unsaid_now', 0, 'players', '[]'::jsonb);
  end if;
  v_guest := public._pl_presence_viewer_is_guest(v_me);
  return (
    with grp as (
      select v.id from public.venues v where v.id = v_canon or v.canonical_id = v_canon
    ),
    here as (
      select c.id, c.user_id, c.play_windows, c.planned_end_at, c.location_confirmed as confirmed,
             public._pl_can_see_presence(v_me, c.user_id, 'checkins') as vis,
             public._pl_windows_now(c.play_windows, now()) as wn,
             exists (select 1 from public.play_sessions s
                      where s.user_id = c.user_id and s.ended_at is null and s.kind = 'open_play'
                        and s.started_at > now() - interval '6 hours'
                        and not exists (select 1 from public.venue_checkins sc
                                         where sc.id = s.id and sc.source <> 'session')
                        and (s.id = c.id or s.venue_id in (select id from grp))) as open_session
        from public.venue_checkins c
        join public.profiles p on p.id = c.user_id and p.deleted_at is null
       where c.venue_id in (select id from grp)
         and c.checked_out_at is null and c.expires_at > now()
         and (c.location_confirmed or c.user_id = v_me)
    ),
    counted as (
      select h.*, coalesce(h.wn ->> 'mode', case when h.open_session then 'open' end) as mode_now
        from here h
       where h.vis <> 'none'
    ),
    -- Who is at this court now, for naming closed-group members.
    present as (
      select distinct c.user_id
        from public.venue_checkins c
       where c.venue_id in (select id from grp)
         and c.checked_out_at is null and c.expires_at > now() and c.location_confirmed
    )
    select jsonb_build_object(
      'open_now',   (select count(distinct x.user_id) from counted x where x.confirmed and x.mode_now = 'open'),
      'closed_now', (select count(distinct x.user_id) from counted x where x.confirmed and x.mode_now = 'closed'),
      'unsaid_now', (select count(distinct x.user_id) from counted x where x.confirmed and x.mode_now is null),
      'players', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'checkin_id',     x.id,
                 'user_id',        x.user_id,
                 'mode_now',       x.mode_now,
                 'mode_until',     x.wn -> 'until',
                 'next_open_at',   x.wn -> 'next_open_at',
                 'planned_end_at', x.planned_end_at,
                 'closed_group', case when x.mode_now = 'closed' then coalesce((
                   select jsonb_agg(jsonb_build_object('user_id', mp.id, 'full_name', mp.full_name) order by mp.full_name, mp.id)
                     from jsonb_array_elements_text(coalesce(x.wn -> 'group', '[]'::jsonb)) g(id)
                     join public.profiles mp on mp.id = g.id::uuid and mp.deleted_at is null
                    where x.user_id = v_me
                       or (not v_guest
                           and mp.id in (select pr.user_id from present pr)
                           and public._pl_can_see_presence(v_me, mp.id, 'checkins') = 'named')), '[]'::jsonb) end)
                 order by (x.user_id = v_me) desc, x.id)
          from counted x
         where x.user_id = v_me or (x.vis = 'named' and not v_guest)), '[]'::jsonb)));
end $$;
revoke all on function public.court_play_modes(text) from public, anon;
grant execute on function public.court_play_modes(text) to authenticated;


-- ── 8. The take-back gives a Play's check-in back too ─────────────────────
-- From migration_court_routines.sql (the live body). Changed: an arrival
-- elsewhere now closes a running Play's own 'session' check-in (above: its
-- session no longer blocks the arrival), which ends that session. Taking the
-- arrival back reopens that check-in too, when its session ended with it
-- (within a second of the check-out, in the last 6 hours); the end trigger
-- (section 3) then reopens the session. Before, a 'session' check-in was
-- never reopened: a running Play stopped the arrival instead.
create or replace function public._pl_take_back_arrival(p_uid uuid, p_ids uuid[], p_left timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  t        record;
  v_any    boolean := false;
  v_reopen uuid;
begin
  if p_uid is null or p_ids is null or cardinality(p_ids) = 0 then return false; end if;
  for t in
    update public.venue_checkins c
       set taken_back_at      = now(),
           location_confirmed = false,
           plan_id            = null,
           checked_out_at     = coalesce(c.checked_out_at,
                                         greatest(c.checked_in_at + interval '1 second',
                                                  least(coalesce(p_left, now()), c.expires_at)))
     where c.id = any (p_ids) and c.user_id = p_uid and c.via_arrival and c.taken_back_at is null
    returning c.id, c.checked_in_at, c.arrival_closed_ids
  loop
    v_any := true;
    delete from public.push_outbox o
     where o.recipient_id = p_uid and o.notification_id is null
       and o.status in ('pending', 'failed')
       and o.push_data ->> 'checkin_id' = t.id::text
       and o.push_data ->> 'kind' in ('arrival_checkin', 'arrival_extend', 'arrival_extend_until');

    update public.court_plans pl
       set status = 'planned', checkin_id = null, updated_at = now()
     where pl.checkin_id = t.id and pl.user_id = p_uid and pl.status = 'completed';

    if t.arrival_closed_ids is not null
       and not exists (select 1 from public.venue_checkins o
                        where o.user_id = p_uid and o.checked_out_at is null and o.expires_at > now()) then
      select c.id into v_reopen
        from public.venue_checkins c
       where c.id = any (t.arrival_closed_ids) and c.user_id = p_uid
         and c.checked_out_at is not null and c.checked_out_at <= t.checked_in_at
         and c.taken_back_at is null and c.expires_at > now()
         -- A Play's own check-in too, when the arrival ended its session
         -- (its end trigger then gives the session back as well).
         and (c.source <> 'session'
              or exists (select 1 from public.play_sessions s
                          where s.id = c.id and s.user_id = p_uid and s.checkin_id = c.id
                            and s.started_at > now() - interval '6 hours'
                            and s.ended_at between c.checked_out_at - interval '1 second'
                                               and c.checked_out_at + interval '1 second'))
       order by c.checked_in_at desc
       limit 1;
      if v_reopen is not null then
        update public.venue_checkins set checked_out_at = null where id = v_reopen;
      end if;
    end if;
  end loop;
  return v_any;
end $$;
revoke all on function public._pl_take_back_arrival(uuid, uuid[], timestamptz) from public, anon, authenticated;
