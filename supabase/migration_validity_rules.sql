-- ============================================================
-- Presence Phase 1.5: validity rules (docs/play-sessions-presence.md,
-- "Phase 1.5: validity rules"; contract: docs/play-sessions-presence-api.md).
--
-- Presence is about being there, rewards are about having played. Nothing in
-- this file changes who is shown at a court: an invalid session still shows
-- the player there. What it adds gates rewards and streaks only (Phase 5 and
-- the kept-plan pickles read it).
--
-- APPLY after the five migration_presence_p1_*.sql files (live 2026-10-16),
-- in one transaction; this file has no begin/commit. Re-runnable: add column
-- if not exists, create or replace, drop ... if exists, guarded backfill.
-- Then re-run migration_rls_hardening_2026q3.sql if you like: it allowlists
-- my_session_validity, the one new client RPC.
--
--   1. Stay proof. venue_checkins.stay_confirmed is true only when the
--      check-in was location-confirmed at arrival AND a later fix confirmed
--      the same court at least 5 minutes after checked_in_at. That later fix
--      comes from checkout_venue (new optional fix arguments) or from any
--      confirming fix the Phase 1 functions store on the row: extend_checkin,
--      a repeat check-in at the same court, a session start that adopts it.
--      checkout_venue is dropped and recreated with trailing defaulted
--      arguments (p_lat, p_lng, p_accuracy_m, p_fix_age_ms), so every named-
--      argument call from 1.0.4 ({p_id, p_source}) and the current app
--      ({p_id, p_source, p_at}) still resolves. A check-out without a fix
--      works exactly as before; a fix never makes a check-out fail.
--   2. matches.play_session_id links a match to the session it was played in.
--      The app sets it on insert (matches are inserted directly under RLS). A
--      BEFORE trigger keeps a link only to a session that exists, belongs to
--      the caller, has the caller among the match's players, and is still
--      open or ended less than 2 hours ago; anything else is stored unlinked
--      (never an error: a Start still in the offline queue must not fail the
--      match). The insert policy also names only the caller's own session.
--   3. play_sessions.valid: a session counts when it lasted 5+ minutes AND
--      a match was linked to it, OR a match the player played in was recorded
--      between started_at and ended_at + 2 h, OR the player completed a drill
--      session in that window (completed = their drill review was submitted,
--      the only record a drill has). Recorded is enough to count; a session
--      valid only through matches still pending confirmation has
--      rewards_pending_confirmation = true. Open sessions never count.
--      Recomputed when a session ends, when a match is inserted, confirmed,
--      re-linked or deleted (the 1-hour expiry deletes unconfirmed ones), and
--      when a drill review is written or removed. A failed recompute only
--      warns: it never blocks the match, the drill review or the End.
--   4. my_session_validity(p_session) for the app (owner only).
-- ============================================================


-- ── 1. Stay proof ──────────────────────────────────────────────────────────
alter table public.venue_checkins add column if not exists stay_confirmed          boolean not null default false;
alter table public.venue_checkins add column if not exists checkout_fix_at         timestamptz;
alter table public.venue_checkins add column if not exists checkout_fix_accuracy_m real;
alter table public.venue_checkins add column if not exists checkout_fix_distance_m real;
alter table public.venue_checkins add column if not exists checkout_fix_lat        double precision;
alter table public.venue_checkins add column if not exists checkout_fix_lng        double precision;
comment on column public.venue_checkins.stay_confirmed is
  'Confirmed at the court at arrival AND by a later fix at least 5 minutes after checked_in_at (check-out, extend, '
  'repeat check-in or session start there). Future presence rewards pay only on a confirmed stay.';
comment on column public.venue_checkins.checkout_fix_lat is
  'The check-out fix, stored only when it confirmed the court (a fix away from the court keeps only its distance).';

-- Any later fix a Phase 1 function stores on a confirmed row (extend_checkin,
-- a repeat check-in at the same court, a session start that adopts it) has
-- already confirmed this court: those functions refuse or skip a fix that
-- doesn't. So a confirmed row whose stored fix moves to 5+ minutes after
-- arrival has a confirmed stay.
create or replace function public._pl_checkin_stay_from_fix()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.location_confirmed and old.location_confirmed and not new.stay_confirmed
     and new.fix_at is not null
     and new.fix_at > coalesce(old.fix_at, '-infinity'::timestamptz)
     and new.fix_at >= new.checked_in_at + interval '5 minutes' then
    new.stay_confirmed := true;
  end if;
  return new;
end $$;
revoke all on function public._pl_checkin_stay_from_fix() from public, anon, authenticated;

drop trigger if exists trg_venue_checkins_stay on public.venue_checkins;
create trigger trg_venue_checkins_stay
  before update of fix_at on public.venue_checkins
  for each row execute function public._pl_checkin_stay_from_fix();

-- The check-out fix, recorded on the check-ins one check-out just closed.
-- Where and how precise comes from the Phase 1 check (_pl_check_fix, called
-- with age 0 so it judges position and precision only). When is judged here,
-- against the check-in's own times, by the fix's age (measured on the device
-- at send time): a check-out queued offline carries the fix taken at the tap,
-- and that is when the player was at the court. A stay counts when the fix
-- confirms the court, the arrival was confirmed, and the fix was taken 5+
-- minutes after arrival and before the check-in ran out. A fix without an age
-- can't be placed in time and is ignored. Never raises: the check-out has
-- already closed the rows and must stand whatever happens here.
create or replace function public._pl_record_checkout_fix(
  p_ids        uuid[],
  p_lat        double precision,
  p_lng        double precision,
  p_accuracy_m double precision,
  p_fix_age_ms double precision
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fix_at timestamptz;
  v_fix    record;
  r        public.venue_checkins;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return; end if;
  if p_fix_age_ms is null or p_fix_age_ms < -5000 then return; end if;
  v_fix_at := now() - make_interval(secs => greatest(p_fix_age_ms, 0) / 1000.0);

  for r in select * from public.venue_checkins c where c.id = any (p_ids) loop
    select * into v_fix from public._pl_check_fix(r.venue_id, p_lat, p_lng, p_accuracy_m, null, 0);
    update public.venue_checkins c
       set checkout_fix_at         = v_fix_at,
           checkout_fix_accuracy_m = p_accuracy_m,
           checkout_fix_distance_m = v_fix.distance_m,
           checkout_fix_lat        = case when coalesce(v_fix.confirmed, false) then p_lat end,
           checkout_fix_lng        = case when coalesce(v_fix.confirmed, false) then p_lng end,
           stay_confirmed          = c.stay_confirmed
                                     or (r.location_confirmed
                                         and coalesce(v_fix.confirmed, false)
                                         and v_fix_at >= r.checked_in_at + interval '5 minutes'
                                         and v_fix_at <= r.expires_at)
     where c.id = r.id;
  end loop;
exception when others then
  raise warning 'checkout_venue: check-out fix not recorded: %', sqlerrm;
end $$;
revoke all on function public._pl_record_checkout_fix(uuid[], double precision, double precision, double precision, double precision)
  from public, anon, authenticated;

-- checkout_venue: Phase 1 behaviour unchanged (see migration_presence_p1_checkins.sql
-- section 4: p_source is a filter, an unknown id falls back to my open rows
-- and is remembered as closed, a replay returns 0), plus the optional fix.
-- Live signature checked 2026-10-16 with pg_get_function_identity_arguments:
-- (p_id uuid, p_source text, p_at timestamp with time zone). Every existing
-- parameter keeps its name, position and default.
drop function if exists public.checkout_venue(uuid, text, timestamptz);

create or replace function public.checkout_venue(
  p_id         uuid default null,
  p_source     text default null,
  p_at         timestamptz default null,
  p_lat        double precision default null,
  p_lng        double precision default null,
  p_accuracy_m double precision default null,
  p_fix_age_ms double precision default null
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_filter text := case when p_source in ('manual', 'geofence', 'session') then p_source end;
  v_at     timestamptz := least(coalesce(p_at, now()), now());
  v_ids    uuid[];
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
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
end $$;
revoke execute on function public.checkout_venue(uuid, text, timestamptz, double precision, double precision, double precision, double precision) from public, anon;
grant execute on function public.checkout_venue(uuid, text, timestamptz, double precision, double precision, double precision, double precision) to authenticated;


-- ── 2. Matches played in a session ─────────────────────────────────────────
alter table public.matches add column if not exists play_session_id uuid
  references public.play_sessions (id) on delete set null;
create index if not exists matches_play_session_id_idx on public.matches (play_session_id)
  where play_session_id is not null;
comment on column public.matches.play_session_id is
  'The play session this match was played in (set by the app from the session). Kept only for the recorder''s own '
  'session, open or ended under 2 h ago, with the recorder among the players; otherwise stored null.';

-- Keep a link only when it is honest; otherwise store the match unlinked.
-- Never raises: recording the match matters more than the link.
create or replace function public._pl_matches_link_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner  uuid;
  v_ended  timestamptz;
  v_caller uuid;
begin
  if new.play_session_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.play_session_id is not distinct from old.play_session_id then return new; end if;
  begin
    v_caller := auth.uid();
    select s.user_id, s.ended_at into v_owner, v_ended
      from public.play_sessions s where s.id = new.play_session_id;
    if v_owner is null                                     -- not stored (yet): its Start may still be queued
       or (v_caller is not null and v_owner <> v_caller)   -- only my own session
       or not coalesce(v_owner = any (array_remove(
            array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id], null)), false)
       or v_ended < now() - interval '2 hours' then       -- too late to say it was played then
      new.play_session_id := null;
    end if;
  exception when others then
    raise warning 'matches: play session link dropped: %', sqlerrm;
    new.play_session_id := null;
  end;
  return new;
end $$;
revoke all on function public._pl_matches_link_session() from public, anon, authenticated;

drop trigger if exists trg_matches_link_session on public.matches;
create trigger trg_matches_link_session
  before insert or update of play_session_id on public.matches
  for each row execute function public._pl_matches_link_session();

-- The insert policy (schema.sql) plus: a link names only my own session. The
-- trigger above has already dropped any other link by the time this runs
-- (RLS checks the row after BEFORE triggers), so this never refuses an honest
-- insert; it holds the line if the trigger is ever disabled.
drop policy if exists "League members can record matches" on public.matches;
create policy "League members can record matches" on public.matches for insert with check (
  exists (select 1 from public.league_members lm
           where lm.league_id = matches.league_id and lm.user_id = auth.uid())
  and (matches.play_session_id is null
       or exists (select 1 from public.play_sessions s
                   where s.id = matches.play_session_id and s.user_id = auth.uid()))
);


-- ── 3. Session validity ────────────────────────────────────────────────────
alter table public.play_sessions add column if not exists valid                        boolean not null default false;
alter table public.play_sessions add column if not exists valid_reason                 text;
alter table public.play_sessions add column if not exists validated_at                 timestamptz;
alter table public.play_sessions add column if not exists rewards_pending_confirmation boolean not null default false;
alter table public.play_sessions drop constraint if exists play_sessions_valid_reason_check;
alter table public.play_sessions add constraint play_sessions_valid_reason_check check (
  valid_reason is null
  or valid_reason in ('open', 'too_short', 'no_match_or_drill', 'linked_match', 'match_in_window', 'drill_in_window'));
create index if not exists play_sessions_user_started_idx on public.play_sessions (user_id, started_at desc);
comment on column public.play_sessions.valid is
  'Counts for rewards and streaks: 5+ minutes AND a linked match, a match recorded during the session or within 2 h '
  'of its end, or a drill completed in that window. Never true while open. Presence ignores it.';
comment on column public.play_sessions.valid_reason is
  'linked_match | match_in_window | drill_in_window when valid; open | too_short | no_match_or_drill when not.';
comment on column public.play_sessions.rewards_pending_confirmation is
  'Valid only through matches still waiting for the other team to confirm: rewards wait for the confirmation.';

-- The rule, computed (no writes). reason is null for an unknown session.
-- needs: what is still missing ('minutes' | 'match_or_drill'), null when
-- nothing is. window_ends_at: ended_at + 2 h (null while open).
create or replace function public._pl_session_validity(
  p_session          uuid,
  out valid          boolean,
  out reason         text,
  out pending        boolean,
  out needs          text,
  out window_ends_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  s             public.play_sessions;
  v_until       timestamptz;
  v_linked      boolean;
  v_linked_done boolean;
  v_window      boolean;
  v_window_done boolean;
  v_drill       boolean;
begin
  valid := false;
  pending := false;
  select * into s from public.play_sessions ps where ps.id = p_session;
  if s.id is null then return; end if;

  window_ends_at := s.ended_at + interval '2 hours';
  v_until := coalesce(s.ended_at, now()) + interval '2 hours';

  -- Matches the player played in (recorded: pending or completed; never a
  -- scheduled one), linked to this session or recorded in its window.
  select coalesce(bool_or(x.linked), false),
         coalesce(bool_or(x.linked and x.done), false),
         coalesce(bool_or(x.in_window), false),
         coalesce(bool_or(x.in_window and x.done), false)
    into v_linked, v_linked_done, v_window, v_window_done
    from (select coalesce(m.play_session_id = s.id, false) as linked,
                 coalesce(coalesce(m.created_at, m.played_at) between s.started_at and v_until, false) as in_window,
                 m.status = 'completed' as done
            from public.matches m
           where m.status in ('pending', 'completed')
             and (m.player1_id = s.user_id or m.player2_id = s.user_id
                  or m.partner1_id = s.user_id or m.partner2_id = s.user_id)
             and (m.play_session_id = s.id
                  or coalesce(m.created_at, m.played_at) between s.started_at and v_until)) x;

  -- A drill session of mine that I completed (reviewed) in the window.
  select exists (
    select 1
      from public.drill_session_reviews r
      join public.drill_sessions d on d.id = r.session_id
     where r.user_id = s.user_id
       and (d.player1_id = s.user_id or d.player2_id = s.user_id)
       and r.created_at between s.started_at and v_until)
    into v_drill;

  if s.ended_at is null then
    reason := 'open';
    needs := case when now() - s.started_at < interval '5 minutes' then 'minutes'
                  when v_linked or v_window or v_drill then null
                  else 'match_or_drill' end;
    return;
  end if;
  if s.ended_at - s.started_at < interval '5 minutes' then
    reason := 'too_short';
    needs := 'minutes';
    return;
  end if;
  if v_linked then reason := 'linked_match';
  elsif v_window then reason := 'match_in_window';
  elsif v_drill then reason := 'drill_in_window';
  else
    reason := 'no_match_or_drill';
    needs := 'match_or_drill';
    return;
  end if;
  valid := true;
  pending := not (v_linked_done or v_window_done or v_drill);
end $$;
revoke all on function public._pl_session_validity(uuid) from public, anon, authenticated;

-- Recompute and store (writes only when something changed). Returns what
-- my_session_validity answers, or null for an unknown session.
create or replace function public._pl_refresh_session_validity(p_session uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select * into v from public._pl_session_validity(p_session);
  if v.reason is null then return null; end if;
  update public.play_sessions ps
     set valid                        = v.valid,
         valid_reason                 = v.reason,
         rewards_pending_confirmation = v.pending,
         validated_at                 = case when not v.valid then null
                                             when ps.valid then coalesce(ps.validated_at, now())
                                             else now() end
   where ps.id = p_session
     and (ps.valid, ps.valid_reason, ps.rewards_pending_confirmation)
         is distinct from (v.valid, v.reason, v.pending);
  return jsonb_build_object(
    'valid', v.valid,
    'reason', v.reason,
    'needs', v.needs,
    'window_ends_at', v.window_ends_at,
    'rewards_pending_confirmation', v.pending);
end $$;
revoke all on function public._pl_refresh_session_validity(uuid) from public, anon, authenticated;

-- The sessions a record at p_at by p_users can change: p_linked, and every
-- ended session of theirs whose window [started_at, ended_at + 2 h] holds p_at.
create or replace function public._pl_sessions_around(p_linked uuid, p_users uuid[], p_at timestamptz)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.play_sessions s
   where s.id = p_linked
      or (s.user_id = any (p_users)
          and s.ended_at is not null
          and s.started_at <= p_at
          and s.ended_at + interval '2 hours' >= p_at)
$$;
revoke all on function public._pl_sessions_around(uuid, uuid[], timestamptz) from public, anon, authenticated;

-- Triggers. Each one swallows its own failure (a warning in the log): the
-- match, the drill review or the End always lands.
create or replace function public._pl_matches_refresh_validity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}';
  v_id  uuid;
begin
  begin
    if tg_op in ('INSERT', 'UPDATE') then
      v_ids := v_ids || array(select public._pl_sessions_around(
        new.play_session_id,
        array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id],
        coalesce(new.created_at, new.played_at)));
    end if;
    if tg_op in ('UPDATE', 'DELETE') then
      v_ids := v_ids || array(select public._pl_sessions_around(
        old.play_session_id,
        array[old.player1_id, old.partner1_id, old.player2_id, old.partner2_id],
        coalesce(old.created_at, old.played_at)));
    end if;
    for v_id in select distinct u from unnest(v_ids) u loop
      perform public._pl_refresh_session_validity(v_id);
    end loop;
  exception when others then
    raise warning 'Session validity not refreshed for match %: %',
      case when tg_op = 'DELETE' then old.id else new.id end, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public._pl_matches_refresh_validity() from public, anon, authenticated;

drop trigger if exists trg_matches_session_validity on public.matches;
create trigger trg_matches_session_validity
  after insert or delete
     or update of status, play_session_id, created_at, played_at, player1_id, player2_id, partner1_id, partner2_id
  on public.matches
  for each row execute function public._pl_matches_refresh_validity();

create or replace function public._pl_drill_reviews_refresh_validity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  begin
    for v_id in
      select public._pl_sessions_around(
        null,
        array[case when tg_op = 'DELETE' then old.user_id else new.user_id end],
        case when tg_op = 'DELETE' then old.created_at else new.created_at end)
    loop
      perform public._pl_refresh_session_validity(v_id);
    end loop;
  exception when others then
    raise warning 'Session validity not refreshed for a drill review: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public._pl_drill_reviews_refresh_validity() from public, anon, authenticated;

drop trigger if exists trg_drill_reviews_session_validity on public.drill_session_reviews;
create trigger trg_drill_reviews_session_validity
  after insert or delete on public.drill_session_reviews
  for each row execute function public._pl_drill_reviews_refresh_validity();

-- A session that ends (End, a newer Start, the 6-hour expiry, a late Start
-- stored already ended) is judged then. The refresh writes only the validity
-- columns, so it doesn't fire this trigger again.
create or replace function public._pl_play_sessions_refresh_validity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if new.ended_at is not null or (tg_op = 'UPDATE' and old.ended_at is not null) then
      perform public._pl_refresh_session_validity(new.id);
    end if;
  exception when others then
    raise warning 'Session validity not refreshed for session %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public._pl_play_sessions_refresh_validity() from public, anon, authenticated;

drop trigger if exists trg_play_sessions_validity on public.play_sessions;
create trigger trg_play_sessions_validity
  after insert or update of started_at, ended_at on public.play_sessions
  for each row execute function public._pl_play_sessions_refresh_validity();


-- ── 4. my_session_validity ─────────────────────────────────────────────────
-- For the app's end-of-session flow and summaries. Owner only: null for a
-- session that isn't mine or isn't stored yet (a Start still queued), the
-- same answer either way. Recomputes and stores, so a session a failed
-- refresh left behind is healed the next time its owner looks.
--   {valid boolean, reason text, needs 'minutes' | 'match_or_drill' | null,
--    window_ends_at timestamptz | null, rewards_pending_confirmation boolean}
create or replace function public.my_session_validity(p_session uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.play_sessions s where s.id = p_session and s.user_id = v_uid) then
    return null;
  end if;
  return public._pl_refresh_session_validity(p_session);
end $$;
revoke all on function public.my_session_validity(uuid) from public, anon;
grant execute on function public.my_session_validity(uuid) to authenticated;


-- ── 5. Backfill ────────────────────────────────────────────────────────────
-- Sessions that ended before this file: judged once now (5 on 2026-10-16).
do $$
declare v_id uuid;
begin
  for v_id in select s.id from public.play_sessions s where s.ended_at is not null loop
    perform public._pl_refresh_session_validity(v_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
