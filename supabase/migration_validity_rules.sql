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
-- my_session_validity, the one new client RPC (checkout_venue and
-- end_play_session are allowlisted by name already).
--
-- No rule here trusts a time the client picks. Each is judged on a server
-- time: when a match row was stored (created_at, stamped by the server), when
-- a drill review was stored, when an arrival fix was taken (dated by its age
-- on the server clock), and a player's sessions never overlap.
--
--   1. Stay proof. venue_checkins.stay_confirmed is true only when the
--      check-in was location-confirmed at arrival AND a later fix confirmed
--      the same court at least 5 minutes after the arrival fix was taken
--      (arrival_fix_at, from the stored fix, never the client's p_at; or
--      checked_in_at, if later). That later fix comes from a check-out:
--      checkout_venue, or end_play_session (End is the check-out of the
--      session's own check-in), both with new optional fix arguments; or
--      from any confirming fix the Phase 1 functions store on the row:
--      extend_checkin, a repeat check-in at the same court, a session start
--      that adopts it. checkout_venue and end_play_session are dropped and
--      recreated with trailing defaulted arguments (p_lat, p_lng,
--      p_accuracy_m, p_fix_age_ms), so every named-argument call from 1.0.4
--      and the current app still resolves. A check-out or End without a fix
--      works exactly as before; a fix never makes one fail.
--   2. Matches. A BEFORE INSERT guard stamps created_at with the server
--      clock on every signed-in insert (that is "recorded" below) and, for
--      anyone but godmode, stores a played match as pending, due within the
--      hour, with only the recorder's own team confirmed (a scheduled one
--      with no confirmations): a client can't assert the other team's
--      confirmation. A pending match with no deadline expires an hour after
--      it was stored. matches.play_session_id links a match to the session
--      it was played in. The app sets it on insert. A BEFORE trigger keeps a
--      link only to a session that exists, belongs to the caller, has the
--      caller among the match's players, and is still open or ended less
--      than 2 hours ago; anything else is stored unlinked (never an error: a
--      Start still in the offline queue must not fail the match). The insert
--      policy also names only the caller's own session.
--   3. play_sessions.valid: a session counts when it lasted 5+ minutes AND
--      a match was linked to it, OR a match the player played in was recorded
--      between started_at and ended_at + 2 h, OR the player completed a drill
--      session held during it (completed = their drill review was stored in
--      that window; held during = scheduled to overlap the session, give or
--      take 30 minutes). A match or drill counts for ONE session of each
--      player: a match for the session it is linked to, else the one it was
--      recorded during, else the latest one that ended before it; a drill for
--      the session started from it, else the one that started closest to it.
--      A player's sessions never overlap: a Start dated before the end of an
--      earlier session starts when that one ended. Recorded is enough to
--      count; a session valid only through matches still pending confirmation
--      has rewards_pending_confirmation = true. Open sessions never count.
--      play_sessions.at_court: a location-confirmed check-in at the session's
--      court overlapped it. Rewards and streak credit need valid AND at_court.
--      Recomputed when a session starts or ends (its neighbours too), when a
--      match is inserted, confirmed, re-linked or deleted (the 1-hour expiry
--      deletes unconfirmed ones), and when a drill review is written or
--      removed. A failed recompute only warns: it never blocks the match,
--      the drill review, the Start or the End.
--   4. my_session_validity(p_session) for the app (owner only).
--   5. A drill's schedule is the server's: clients may update only a drill
--      session's notes and reminder_dismissed_by.
-- ============================================================


-- ── 1. Stay proof ──────────────────────────────────────────────────────────
alter table public.venue_checkins add column if not exists stay_confirmed          boolean not null default false;
alter table public.venue_checkins add column if not exists arrival_fix_at          timestamptz;
alter table public.venue_checkins add column if not exists checkout_fix_at         timestamptz;
alter table public.venue_checkins add column if not exists checkout_fix_accuracy_m real;
alter table public.venue_checkins add column if not exists checkout_fix_distance_m real;
alter table public.venue_checkins add column if not exists checkout_fix_lat        double precision;
alter table public.venue_checkins add column if not exists checkout_fix_lng        double precision;
comment on column public.venue_checkins.stay_confirmed is
  'Confirmed at the court at arrival AND by a later fix at least 5 minutes after the arrival fix (arrival_fix_at, or '
  'checked_in_at if later): check-out, End, extend, repeat check-in or session start there. Future presence rewards '
  'pay only on a confirmed stay.';
comment on column public.venue_checkins.arrival_fix_at is
  'When the arrival fix was taken, on the server clock (from its age), never the client''s p_at. Set on insert for a '
  'confirmed row. The stay proof counts 5 minutes from here.';
comment on column public.venue_checkins.checkout_fix_lat is
  'The check-out fix, stored only when it confirmed the court (a fix away from the court keeps only its distance).';

-- Confirmed rows stored before this file: the arrival fix was at most 2
-- minutes old when the server stored the row (created_at), so it was taken no
-- earlier than created_at - 2 min. Runs once (later rows get it on insert).
update public.venue_checkins
   set arrival_fix_at = greatest(checked_in_at, created_at - interval '2 minutes')
 where location_confirmed and arrival_fix_at is null;

-- Every confirmed row records when its arrival fix was taken: fix_at, which
-- the Phase 1 functions store on the server clock (now() - its age, or a
-- p_fix_at they already judged fresh, at most a minute ahead: clamped to now).
-- Whatever the inserting code passes is ignored.
create or replace function public._pl_checkin_arrival_fix()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.arrival_fix_at := case when new.location_confirmed then least(coalesce(new.fix_at, now()), now()) end;
  return new;
end $$;
revoke all on function public._pl_checkin_arrival_fix() from public, anon, authenticated;

drop trigger if exists trg_venue_checkins_arrival on public.venue_checkins;
create trigger trg_venue_checkins_arrival
  before insert on public.venue_checkins
  for each row execute function public._pl_checkin_arrival_fix();

-- Any later fix a Phase 1 function stores on a confirmed row (extend_checkin,
-- a repeat check-in at the same court, a session start that adopts it) has
-- already confirmed this court: those functions refuse or skip a fix that
-- doesn't. So a confirmed row whose stored fix moves to 5+ minutes after the
-- arrival fix has a confirmed stay. Counted from the arrival fix, never from
-- checked_in_at alone: a client may backdate that (p_at), not the fix.
create or replace function public._pl_checkin_stay_from_fix()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.location_confirmed and old.location_confirmed and not new.stay_confirmed
     and new.fix_at is not null
     and new.fix_at > coalesce(old.fix_at, '-infinity'::timestamptz)
     and least(new.fix_at, now())
         >= greatest(new.checked_in_at, coalesce(new.arrival_fix_at, new.created_at)) + interval '5 minutes' then
    new.stay_confirmed := true;
  end if;
  return new;
end $$;
revoke all on function public._pl_checkin_stay_from_fix() from public, anon, authenticated;

drop trigger if exists trg_venue_checkins_stay on public.venue_checkins;
create trigger trg_venue_checkins_stay
  before update of fix_at on public.venue_checkins
  for each row execute function public._pl_checkin_stay_from_fix();

-- The check-out fix, recorded on the check-ins one check-out (or End) just
-- closed. Where and how precise comes from the Phase 1 check (_pl_check_fix,
-- called with age 0 so it judges position and precision only). When is judged
-- here, against the check-in's own times, by the fix's age (measured on the
-- device at send time): a check-out queued offline carries the fix taken at
-- the tap, and that is when the player was at the court. A stay counts when
-- the fix confirms the court, the arrival was confirmed, and the fix was taken
-- 5+ minutes after the arrival fix and before the check-in ran out. A fix
-- without an age can't be placed in time and is ignored. Never raises: the
-- check-out has already closed the rows and must stand whatever happens here.
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
                                         and v_fix_at >= greatest(r.checked_in_at, coalesce(r.arrival_fix_at, r.created_at))
                                                         + interval '5 minutes'
                                         and v_fix_at <= r.expires_at)
     where c.id = r.id;
  end loop;
exception when others then
  raise warning 'check-out fix not recorded: %', sqlerrm;
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

-- end_play_session: Phase 1 behaviour unchanged (migration_presence_p1_checkins.sql
-- section 5: ends my session, closes the check-in it opened, an adopted one
-- stays open, an id never stored is remembered as ended, a replay returns 0),
-- plus the optional fix. End is the check-out of the session's own check-in,
-- so its fix is that check-in's stay proof, recorded only on a check-in this
-- call closed (a replay, an adopted check-in or an End that beats its Start
-- records nothing). Live signature checked 2026-10-16 with
-- pg_get_function_identity_arguments: (p_id uuid, p_at timestamp with time
-- zone). Both keep their name, position and default, so 1.0.4's and the
-- current app's {p_id, p_at} and sign-out's positional call still resolve.
drop function if exists public.end_play_session(uuid, timestamptz);

create or replace function public.end_play_session(
  p_id         uuid,
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
  v_uid uuid := auth.uid();
  v_at  timestamptz := least(coalesce(p_at, now()), now());
  v_n   int;
  v_ids uuid[];
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
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
end $$;
revoke execute on function public.end_play_session(uuid, timestamptz, double precision, double precision, double precision, double precision) from public, anon;
grant execute on function public.end_play_session(uuid, timestamptz, double precision, double precision, double precision, double precision) to authenticated;


-- ── 2. Matches ─────────────────────────────────────────────────────────────
alter table public.matches add column if not exists play_session_id uuid
  references public.play_sessions (id) on delete set null;
create index if not exists matches_play_session_id_idx on public.matches (play_session_id)
  where play_session_id is not null;
comment on column public.matches.play_session_id is
  'The play session this match was played in (set by the app from the session). Kept only for the recorder''s own '
  'session, open or ended under 2 h ago, with the recorder among the players; otherwise stored null.';

-- A direct client insert can't assert a time or a confirmation (matches are
-- inserted under RLS, which checks only league membership, and clients have
-- no UPDATE policy, so this covers every client write):
--   * every signed-in insert gets created_at = now(): "recorded" is the
--     server's clock (the validity window reads it), never the client's;
--   * for anyone but godmode, a played match is stored pending, due within
--     the hour, with only the recorder's own team confirmed, and never both
--     teams by one caller (self vs self could then confirm alone); a
--     scheduled one (ScheduleMatchScreen) carries no confirmations.
-- Godmode keeps its confirmed insert; server-side inserts (auth.uid() null:
-- seeds, backfills) are untouched. The trigger's name must sort BEFORE
-- 'on_match_completed': BEFORE triggers fire in name order, and
-- update_plupr_ratings applies PLUPR at once on a 'completed' insert.
create or replace function public._pl_matches_client_insert_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return new; end if;
  new.created_at := now();
  if public.is_godmode_user(v_uid) then return new; end if;
  if new.status = 'scheduled' then
    new.confirm_deadline   := null;
    new.team1_confirmed_by := null;
    new.team2_confirmed_by := null;
    return new;
  end if;
  new.status             := 'pending';
  new.confirm_deadline   := now() + interval '1 hour';
  new.team1_confirmed_by := case when v_uid in (new.player1_id, new.partner1_id) then v_uid end;
  new.team2_confirmed_by := case when new.team1_confirmed_by is null
                                  and v_uid in (new.player2_id, new.partner2_id) then v_uid end;
  return new;
end $$;
revoke all on function public._pl_matches_client_insert_guard() from public, anon, authenticated;

drop trigger if exists a_matches_client_insert_guard on public.matches;
create trigger a_matches_client_insert_guard
  before insert on public.matches
  for each row execute function public._pl_matches_client_insert_guard();

-- The 1-hour expiry (migration_match_confirm_flow.sql, pg_cron every minute),
-- plus: a pending match stored with no deadline (before the guard above) goes
-- an hour after it was stored, so no pending match lives forever. Everything
-- else as it was, attributes included: no search_path is set here, because
-- the delete fires the matches triggers (side-effect reversal and others),
-- which run with this function's search_path.
create or replace function public.expire_pending_matches()
returns integer language plpgsql security definer as $$
declare
  v_deleted integer;
begin
  delete from public.matches
   where status = 'pending'
     and coalesce(confirm_deadline, created_at + interval '1 hour') < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

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
alter table public.play_sessions add column if not exists at_court                     boolean not null default false;
alter table public.play_sessions drop constraint if exists play_sessions_valid_reason_check;
alter table public.play_sessions add constraint play_sessions_valid_reason_check check (
  valid_reason is null
  or valid_reason in ('open', 'too_short', 'no_match_or_drill', 'linked_match', 'match_in_window', 'drill_in_window'));
create index if not exists play_sessions_user_started_idx on public.play_sessions (user_id, started_at desc);
comment on column public.play_sessions.valid is
  'Played: 5+ minutes AND a linked match, a match recorded during the session or within 2 h of its end, or a drill '
  'held during it and completed in that window, each counted for one session only. Never true while open. '
  'Rewards and streak credit need valid AND at_court. Presence ignores it.';
comment on column public.play_sessions.valid_reason is
  'linked_match | match_in_window | drill_in_window when valid; open | too_short | no_match_or_drill when not.';
comment on column public.play_sessions.rewards_pending_confirmation is
  'Valid only through matches still waiting for the other team to confirm: rewards wait for the confirmation. '
  'Clients can''t assert a confirmation (the matches insert guard), so the server''s word.';
comment on column public.play_sessions.at_court is
  'A location-confirmed check-in at the session''s court overlapped it (from its arrival fix). Rewards and streak '
  'credit need valid AND at_court; an untracked session can be valid without it.';

-- A player's sessions never overlap. A Start dated before the end of one of
-- my earlier sessions (a backdated p_at, or a late Start that arrives after
-- newer ones) starts when the latest of them ended (or, for one still open,
-- when it started); a late Start stored already ended then ends no earlier.
-- Honest Starts arrive in order and are never moved. Without this, sessions
-- could be stacked after the fact around one match.
create or replace function public._pl_play_sessions_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_floor timestamptz;
begin
  select max(coalesce(s.ended_at, s.started_at)) into v_floor
    from public.play_sessions s
   where s.user_id = new.user_id and s.id <> new.id;
  if v_floor is not null and new.started_at < v_floor then
    new.started_at := v_floor;
  end if;
  if new.ended_at is not null and new.ended_at < new.started_at then
    new.ended_at := new.started_at;
  end if;
  return new;
end $$;
revoke all on function public._pl_play_sessions_no_overlap() from public, anon, authenticated;

drop trigger if exists trg_play_sessions_no_overlap on public.play_sessions;
create trigger trg_play_sessions_no_overlap
  before insert on public.play_sessions
  for each row execute function public._pl_play_sessions_no_overlap();

-- The one session of p_user a match counts for: the session it is linked to;
-- else the one it was recorded during (p_at = matches.created_at); else the
-- latest one that ended before it, within 2 h. A session that ended under 5
-- minutes never takes a match (it falls to the next one). Null: none.
create or replace function public._pl_match_session(p_user uuid, p_linked uuid, p_at timestamptz)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.play_sessions s
   where s.user_id = p_user
     and (s.ended_at is null or s.ended_at - s.started_at >= interval '5 minutes')
     and (s.id = p_linked
          or p_at between s.started_at and coalesce(s.ended_at, now()) + interval '2 hours')
   order by (s.id = p_linked) desc nulls last,
            (p_at <= coalesce(s.ended_at, now())) desc nulls last,
            s.ended_at desc nulls first,
            s.id
   limit 1
$$;
revoke all on function public._pl_match_session(uuid, uuid, timestamptz) from public, anon, authenticated;

-- The one session of p_user a drill counts for. The review (stored at
-- p_reviewed_at) must land in the session's window, and the drill must have
-- been held during the session: scheduled to overlap it, give or take 30
-- minutes (a drill from another day never counts). Of those: the session
-- started from this drill, else the one that started closest to the drill.
create or replace function public._pl_drill_session(
  p_user        uuid,
  p_drill       uuid,
  p_reviewed_at timestamptz,
  p_starts_at   timestamptz,
  p_length_min  int
) returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.play_sessions s
   where s.user_id = p_user
     and (s.ended_at is null or s.ended_at - s.started_at >= interval '5 minutes')
     and p_reviewed_at between s.started_at and coalesce(s.ended_at, now()) + interval '2 hours'
     and p_starts_at < coalesce(s.ended_at, now()) + interval '30 minutes'
     and p_starts_at + make_interval(mins => coalesce(p_length_min, 60)) > s.started_at - interval '30 minutes'
   order by (s.kind = 'drill' and s.source_id = p_drill) desc nulls last,
            abs(extract(epoch from (s.started_at - p_starts_at))),
            s.id
   limit 1
$$;
revoke all on function public._pl_drill_session(uuid, uuid, timestamptz, timestamptz, int) from public, anon, authenticated;

-- The rule, computed (no writes). reason is null for an unknown session.
-- needs: what is still missing ('minutes' | 'match_or_drill'), null when
-- nothing is. window_ends_at: ended_at + 2 h (null while open). Dropped first:
-- at_court is a new OUT parameter.
drop function if exists public._pl_session_validity(uuid);
create function public._pl_session_validity(
  p_session          uuid,
  out valid          boolean,
  out reason         text,
  out pending        boolean,
  out needs          text,
  out window_ends_at timestamptz,
  out at_court       boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  s            public.play_sessions;
  v_until      timestamptz;
  v_linked     boolean;
  v_window     boolean;
  v_match_done boolean;
  v_drill      boolean;
begin
  valid := false;
  pending := false;
  at_court := false;
  select * into s from public.play_sessions ps where ps.id = p_session;
  if s.id is null then return; end if;

  window_ends_at := s.ended_at + interval '2 hours';
  v_until := coalesce(s.ended_at, now()) + interval '2 hours';

  -- At the court: a location-confirmed check-in of mine at this session's
  -- court (the session's own, or one it adopted) overlapped it, counted from
  -- its arrival fix.
  at_court := s.venue_id is not null and exists (
    select 1
      from public.venue_checkins c
     where c.user_id = s.user_id
       and c.location_confirmed
       and c.venue_id in (select v.id from public.venues v where v.id = s.venue_id or v.canonical_id = s.venue_id)
       and coalesce(c.arrival_fix_at, c.checked_in_at) < coalesce(s.ended_at, now())
       and coalesce(c.checked_out_at, c.expires_at) > s.started_at);

  -- Matches the player played in (recorded: pending or completed; never a
  -- scheduled one), linked to this session or recorded in its window, that
  -- count for this session and no other of mine.
  select coalesce(bool_or(x.linked), false),
         coalesce(bool_or(not x.linked), false),
         coalesce(bool_or(x.done), false)
    into v_linked, v_window, v_match_done
    from (select coalesce(m.play_session_id = s.id, false) as linked,
                 m.status = 'completed' as done
            from public.matches m
           where m.status in ('pending', 'completed')
             and (m.player1_id = s.user_id or m.player2_id = s.user_id
                  or m.partner1_id = s.user_id or m.partner2_id = s.user_id)
             and (m.play_session_id = s.id
                  or m.created_at between s.started_at and v_until)
             and public._pl_match_session(s.user_id, m.play_session_id, m.created_at) = s.id) x;

  -- A drill session of mine, held during this session, that I completed
  -- (reviewed) in the window, and that counts for this session and no other.
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
  pending := not (v_match_done or v_drill);
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
         at_court                     = v.at_court,
         validated_at                 = case when not v.valid then null
                                             when ps.valid then coalesce(ps.validated_at, now())
                                             else now() end
   where ps.id = p_session
     and (ps.valid, ps.valid_reason, ps.rewards_pending_confirmation, ps.at_court)
         is distinct from (v.valid, v.reason, v.pending, v.at_court);
  return jsonb_build_object(
    'valid', v.valid,
    'reason', v.reason,
    'needs', v.needs,
    'window_ends_at', v.window_ends_at,
    'rewards_pending_confirmation', v.pending,
    'at_court', v.at_court);
end $$;
revoke all on function public._pl_refresh_session_validity(uuid) from public, anon, authenticated;

-- The sessions a record at p_at by p_users can change: p_linked, and every
-- ended session of theirs whose window [started_at, ended_at + 2 h] holds p_at
-- (the one it counts for is among them, and so is any it moved from).
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
-- match, the drill review, the Start or the End always lands.
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
        new.created_at));
    end if;
    if tg_op in ('UPDATE', 'DELETE') then
      v_ids := v_ids || array(select public._pl_sessions_around(
        old.play_session_id,
        array[old.player1_id, old.partner1_id, old.player2_id, old.partner2_id],
        old.created_at));
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
     or update of status, play_session_id, created_at, player1_id, player2_id, partner1_id, partner2_id
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
-- stored already ended) is judged then. A match or drill counts for one
-- session only, so a session that starts, ends or moves can take one from, or
-- give one back to, my other sessions: those whose windows overlap its window
-- (before and after the change) are judged again too. The refresh writes only
-- the validity columns, so it doesn't fire this trigger again.
create or replace function public._pl_play_sessions_refresh_validity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := new.started_at;
  v_to   timestamptz := coalesce(new.ended_at, now()) + interval '2 hours';
  v_id   uuid;
begin
  begin
    if new.ended_at is not null or (tg_op = 'UPDATE' and old.ended_at is not null) then
      perform public._pl_refresh_session_validity(new.id);
    end if;
    if tg_op = 'UPDATE' then
      v_from := least(v_from, old.started_at);
      v_to := greatest(v_to, coalesce(old.ended_at, now()) + interval '2 hours');
    end if;
    for v_id in
      select s.id
        from public.play_sessions s
       where s.user_id = new.user_id and s.id <> new.id and s.ended_at is not null
         and s.started_at <= v_to
         and s.ended_at + interval '2 hours' >= v_from
    loop
      perform public._pl_refresh_session_validity(v_id);
    end loop;
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
--    window_ends_at timestamptz | null, rewards_pending_confirmation boolean,
--    at_court boolean}
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


-- ── 5. A drill's schedule is the server's ──────────────────────────────────
-- A drill counts for a session only when it was held during it (section 3),
-- so its time must not be the client's to move. The "Participants update
-- sessions" policy names no columns, and clients held UPDATE on all of them
-- (a participant could move starts_at to make a future drill reviewable now).
-- The app updates only reminder_dismissed_by (HomeScreen); no SQL function
-- updates the table (only the admin backfill_drill_start_times.sql does), and
-- inserts are untouched. Revoking the table privilege also revokes the column
-- ones, then the two client columns are granted back.
revoke update on public.drill_sessions from authenticated, anon;
grant update (notes, reminder_dismissed_by) on public.drill_sessions to authenticated;


-- ── 6. Backfill ────────────────────────────────────────────────────────────
-- Sessions that ended before this file: judged once now (5 on 2026-10-16).
do $$
declare v_id uuid;
begin
  for v_id in select s.id from public.play_sessions s where s.ended_at is not null loop
    perform public._pl_refresh_session_validity(v_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
