-- ============================================================
-- Routine check-ins with a planned play length and closed / open windows
-- (state/routine-checkins-plan.md, with the user's decisions of 2026-10-20 at
-- its top, which win where they differ). Server side only.
--
-- Doggle parity first (the user's standing rule). Doggle's model
-- (db/migrations/0415, 0416, 0443) is ported as is:
--   * court_routines: a court, a wall-clock time in the player's IANA zone, a
--     weekday mask (Mon = 1 ... Sun = 64; weekdays 31, weekends 96, all 127),
--     active. Max 12 per player. Owner-only table, writes by RPC only.
--   * occurrences are rows of court_plans (Doggle's planned visits) for today
--     and tomorrow in the routine's zone, made by materialize_court_routines
--     (pg_cron */15 and on every save), wall clock per date so DST never moves
--     them, skipped when another plan of mine at that court is within 30
--     minutes, unique per (routine_id, routine_date) so a skipped day is never
--     made again. Skip = cancel the occurrence; undo; change today's time.
--   * a routine stop counts from 30 minutes before to 30 minutes after its time
--     (Doggle 0443). An unkept occurrence is deleted at +30 minutes, not kept
--     as "missed".
--   * a reminder at the stop's time (process_court_routine_reminders, */5):
--     10 minutes before to 15 minutes after, once, not when already checked in
--     there or in a play session. "9 AM · Lakeside" / "Your planned check-in.
--     We'll check you in when you get there."
--   * presence_settings.routine_auto_checkin (Doggle's
--     routine_auto_checkin_enabled, default on): an arrival at a routine court
--     during its window checks in even when "Check me in when I arrive" is off.
--     A court switched off for automatic check-in (court_favorites.auto_checkin
--     false) still wins, as Doggle's per-park switch does.
--   * friends see routines through list_profile_court_routines under
--     plans_level (default friends), never across a block, a hide-from, a pause
--     or to a guest. No push to anyone else, per occurrence or otherwise.
--
-- The user's decisions:
--   1. Routines only at STARRED courts. save_court_routine refuses an unstarred
--      court (pl:routine.not_starred). Unstarring a court later leaves its
--      routines dormant: no occurrences, no reminders, no arrival check-in
--      (_pl_court_arrival_off says not_starred), shown with starred = false by
--      list_my_court_routines so the app can offer to star it again.
--   2. Stars are capped at 3 (migration_court_star_cap_three.sql, before this).
--   3. Arrival check-ins last 2 hours (migration_court_arrival_two_hours.sql).
--      Doggle has no planned length: a routine stop's check-in is an ordinary
--      check-in with an ordinary length. So, Doggle-shaped: an arrival at a
--      routine court during its window lasts the ordinary arrival length, cut
--      to the routine's planned end when that comes first (never under 30
--      minutes); when the planned end is later (a 3 or 4 hour routine), the
--      server's "Still at" 5 minutes before becomes "Staying until 12 PM?"
--      (push_data.kind arrival_extend_until, planned_end_at in push_data), and
--      one tap (extend_checkin(p_id, p_until => planned_end_at), unchanged)
--      extends it to the planned end within the existing 4-hour cap.
--
-- New (not in Doggle; kept minimal): a planned length (30 min to 4 h, 15-min
-- steps) and up to 6 windows, each closed group or open play, with a hint
-- from a fixed list and a closed group of the player's friends. The rules are
-- foundation 1.52.0's timeWindows (validateWindows): 1 to 6 windows, sorted,
-- no gap or overlap, the first from 0, the last to the length, 15-minute
-- steps, each at least 15 minutes; mode 'closed' | 'open' | null (not said);
-- hints open: all_levels, near_my_level, 3.0+, 3.5+, 4.0+, 4.5+; closed:
-- friends, competitive; a group of at most 7, non-friends dropped silently.
-- A refusal is pl:windows.bad with DETAIL {"problem": <validateWindows'
-- problem>, "index": n}. On a check-in (set_checkin_plan) windows are
-- absolute; the first starts at the check-in and the last ends at the planned
-- end (the server sets both ends), no step rule there, so "Switch to open play
-- now" can cut at any minute.
--
-- Data:
--   court_routines   NEW (owner-only select)
--   court_plans      NEW, minimal Phase 3 plans table; only routines write it
--                    now (owner-only select)
--   venue_checkins   + planned_end_at, play_windows (absolute), plan_id (the
--                    occurrence it kept), arrival_until (the end the arrival
--                    job gave it: "not extended yet" is expires_at =
--                    arrival_until, or _pl_arrival_untouched's test as
--                    before)
--   presence_settings + routine_auto_checkin
-- A check-in that starts at a routine court within an occurrence's window
-- keeps it (any kind: manual, arrival, a session's): trg_venue_checkins_plan_link
-- links it and copies the occurrence's windows, trg_venue_checkins_plan_kept
-- marks the occurrence completed. Only location-confirmed check-ins keep one.
--
-- Client RPCs (granted to authenticated, in the hardening allowlist):
--   list_my_court_routines, get_court_routine_settings, set_routine_auto_checkin,
--   save_court_routine, set_court_routine_active, delete_court_routine,
--   skip_court_routine_occurrence, unskip_court_routine_occurrence,
--   move_court_routine_occurrence, suggest_court_routines,
--   list_profile_court_routines, set_checkin_plan, venue_open_to_play,
--   court_play_modes
-- Internal (execute revoked from public, anon, authenticated): the window
-- helpers, _pl_is_starred, _pl_routine_plan_at, _pl_materialize_court_routines,
-- materialize_court_routines, process_court_routine_reminders, _pl_court_push,
-- _pl_venue_open_now, the two trigger functions.
--
-- Replaced (same signatures and attributes; each copied from the LATEST file
-- that defines it, only what routines need changed):
--   _pl_court_arrival_off      (migration_court_arrival_queue.sql) routine due
--                              + routine_auto_checkin on overrides 'off'
--   _pl_take_back_arrival      (migration_court_arrival_queue.sql) the
--                              occurrence goes back to planned (Doggle 0433);
--                              the until push is deleted too
--   cancel_court_arrival       (migration_court_arrival_two_hours.sql) "not
--                              extended" also reads arrival_until; sign-out drops
--                              the until push too
--   process_court_arrivals     (migration_court_arrival_two_hours.sql) B: the
--                              occurrence's planned end, windows, plan; C:
--                              "Staying until"
--   _purge_account, prune_presence_history (migration_court_arrival_queue.sql)
--                              + routines and plans
-- NOT replaced, on purpose: venue_crowd and court_presence (RETURNS TABLE: a
-- new column needs a drop, and re-runs of migration_refusal_messages.sql /
-- migration_presence_p1_reads.sql would then fail), friends_at_courts,
-- get_court_arrival_settings, checkin_venue, extend_checkin,
-- start_play_session, expire_venue_checkins. "Open to play" is read through
-- the new venue_open_to_play and court_play_modes instead.
--
-- Not built here (later steps): kept-plan pickles (presence decision 5; no
-- pickle grant path exists for presence yet: court_plans.rewarded_at is
-- reserved for it), friends' "Later today" plans on Home.
--
-- APPLY ORDER: after migration_court_arrival_two_hours.sql and
-- migration_court_star_cap_three.sql (the newest files it builds on), then
-- re-run migration_rls_hardening_2026q3.sql (its allowlist names the client
-- RPCs here). RE-APPLY after any re-run of migration_court_arrival_queue.sql,
-- migration_court_arrival_two_hours.sql, migration_presence_p1_hygiene.sql or
-- migration_moderation_report_block.sql: they put older bodies of the
-- functions above back (build-presence-test.mjs does this). Re-runnable; no
-- begin/commit.
--   supabase db query --linked -f supabase/migration_court_routines.sql
-- ============================================================


-- ── 1. Tables and columns ──────────────────────────────────────────────────

create table if not exists public.court_routines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  venue_id    text not null references public.venues (id) on delete cascade,
  local_time  time not null,
  days        smallint not null,
  tz          text not null,
  length_min  int not null,
  windows     jsonb not null default '[]'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint court_routines_days_chk check (days between 1 and 127),
  constraint court_routines_length_chk check (length_min between 30 and 240 and length_min % 15 = 0)
);
create index if not exists court_routines_user_idx on public.court_routines (user_id);
create index if not exists court_routines_active_idx on public.court_routines (id) where active;
comment on table public.court_routines is
  'Routine check-ins (Doggle checkin_routines): a starred court, a wall-clock time in tz, a weekday mask '
  '(Mon = 1 ... Sun = 64), a planned length and windows (offsets in minutes from the start). Owner-only; '
  'writes through save_court_routine and friends. Occurrences are court_plans rows.';

create table if not exists public.court_plans (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  venue_id       text not null references public.venues (id) on delete cascade,
  planned_at     timestamptz not null,
  planned_end_at timestamptz not null,
  windows        jsonb not null default '[]'::jsonb,
  status         text not null default 'planned'
                 check (status in ('planned', 'cancelled', 'completed', 'missed')),
  routine_id     uuid references public.court_routines (id) on delete set null,
  routine_date   date,
  checkin_id     uuid references public.venue_checkins (id) on delete set null,
  rewarded_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint court_plans_end_chk check (planned_end_at > planned_at)
);
create unique index if not exists court_plans_routine_day_uidx
  on public.court_plans (routine_id, routine_date) where routine_id is not null;
create index if not exists court_plans_user_venue_idx
  on public.court_plans (user_id, venue_id, planned_at) where status = 'planned';
create index if not exists court_plans_checkin_idx on public.court_plans (checkin_id) where checkin_id is not null;
create index if not exists court_plans_planned_idx on public.court_plans (planned_at) where status = 'planned';
comment on table public.court_plans is
  'Planned check-ins (Doggle dog_place_checkin_plans). Only routine occurrences for now (routine_id, routine_date). '
  'windows are absolute ({starts_at, ends_at, mode, hint, group}). Owner-only; a weekly pattern is predictive '
  'location data. rewarded_at is reserved for the kept-plan pickles.';

alter table public.court_routines enable row level security;
alter table public.court_plans    enable row level security;
drop policy if exists court_routines_own on public.court_routines;
create policy court_routines_own on public.court_routines
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists court_plans_own on public.court_plans;
create policy court_plans_own on public.court_plans
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.court_routines, public.court_plans from anon, authenticated;
revoke select on public.court_routines, public.court_plans from anon;

alter table public.venue_checkins add column if not exists planned_end_at timestamptz;
alter table public.venue_checkins add column if not exists play_windows   jsonb;
alter table public.venue_checkins add column if not exists plan_id        uuid references public.court_plans (id) on delete set null;
alter table public.venue_checkins add column if not exists arrival_until  timestamptz;
comment on column public.venue_checkins.planned_end_at is
  'When the player said they would stop (a routine''s end, or set_checkin_plan). expires_at stays the presence end.';
comment on column public.venue_checkins.play_windows is
  'Absolute windows {starts_at, ends_at, mode closed|open|null, hint, group}: closed group or open play.';
comment on column public.venue_checkins.plan_id is 'The court_plans occurrence this check-in kept.';
comment on column public.venue_checkins.arrival_until is
  'The end process_court_arrivals gave an arrival check-in. expires_at = arrival_until means nobody extended it.';

alter table public.presence_settings add column if not exists routine_auto_checkin boolean not null default true;
comment on column public.presence_settings.routine_auto_checkin is
  'Check me in at my routine courts (Doggle routine_auto_checkin_enabled): an arrival during a routine stop''s '
  'window checks in even when auto_checkin is off. A court switched off (court_favorites.auto_checkin) still asks.';


-- ── 2. Windows (foundation 1.52.0 timeWindows rules) ───────────────────────

-- A hint allowed for this mode (open: levels; closed: who). Null hint is fine.
create or replace function public._pl_window_hint_ok(p_mode text, p_hint text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select p_hint is null
      or coalesce((p_mode = 'open'   and p_hint in ('all_levels', 'near_my_level', '3.0+', '3.5+', '4.0+', '4.5+'))
               or (p_mode = 'closed' and p_hint in ('friends', 'competitive')), false);
$$;
revoke all on function public._pl_window_hint_ok(text, text) from public, anon, authenticated;

-- A JSON value's text when it is a string, '?' when it is anything else but
-- null (so a number never passes as a mode), null when null or missing.
create or replace function public._pl_json_str(p jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case when p is null or jsonb_typeof(p) = 'null' then null
              when jsonb_typeof(p) = 'string' then p #>> '{}'
              else '?' end;
$$;
revoke all on function public._pl_json_str(jsonb) from public, anon, authenticated;

-- validateWindows (foundation scheduling/timeWindows.ts) for offset windows
-- {start_min, end_min, mode, hint, group}: null when they pass, else
-- {"problem": ..., "index": n} (-1 = the list as a whole). Stops at the first
-- problem, in the foundation's order. Step 15, shortest 15, at most 6, modes
-- closed / open / null, the hint lists above, a group of at most 7.
create or replace function public._pl_windows_problem(p_windows jsonb, p_length int)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  n    int;
  i    int;
  w    jsonb;
  s    numeric;
  e    numeric;
  prev numeric := 0;
  m    text;
  h    text;
begin
  if p_length is null or p_length <= 0 or p_length % 15 <> 0 then
    return jsonb_build_object('problem', 'bad_length', 'index', -1);
  end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) = 0 then
    return jsonb_build_object('problem', 'empty', 'index', -1);
  end if;
  n := jsonb_array_length(p_windows);
  if n > 6 then return jsonb_build_object('problem', 'too_many', 'index', -1); end if;
  for i in 0 .. n - 1 loop
    w := p_windows -> i;
    if jsonb_typeof(w) is distinct from 'object'
       or jsonb_typeof(w -> 'start_min') is distinct from 'number'
       or jsonb_typeof(w -> 'end_min') is distinct from 'number' then
      return jsonb_build_object('problem', 'off_step', 'index', i);
    end if;
    s := (w ->> 'start_min')::numeric;
    e := (w ->> 'end_min')::numeric;
    if s <> trunc(s) or e <> trunc(e) or mod(s, 15) <> 0 or mod(e, 15) <> 0 then
      return jsonb_build_object('problem', 'off_step', 'index', i);
    end if;
    if e - s < 15 then return jsonb_build_object('problem', 'too_short', 'index', i); end if;
    if i = 0 and s <> 0 then return jsonb_build_object('problem', 'not_from_start', 'index', 0); end if;
    if i > 0 and s > prev then return jsonb_build_object('problem', 'gap', 'index', i); end if;
    if i > 0 and s < prev then return jsonb_build_object('problem', 'overlap', 'index', i); end if;
    m := public._pl_json_str(w -> 'mode');
    if m is not null and m not in ('closed', 'open') then
      return jsonb_build_object('problem', 'bad_mode', 'index', i);
    end if;
    h := public._pl_json_str(w -> 'hint');
    if not public._pl_window_hint_ok(m, h) then
      return jsonb_build_object('problem', 'bad_hint', 'index', i);
    end if;
    if jsonb_typeof(w -> 'group') = 'array' and jsonb_array_length(w -> 'group') > 7 then
      return jsonb_build_object('problem', 'group_too_big', 'index', i);
    end if;
    prev := e;
  end loop;
  if prev <> p_length then return jsonb_build_object('problem', 'not_to_end', 'index', n - 1); end if;
  return null;
end $$;
revoke all on function public._pl_windows_problem(jsonb, int) from public, anon, authenticated;

-- The refusal for a windows problem: pl:windows.bad, DETAIL the problem.
create or replace function public._pl_raise_windows(p_problem jsonb)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  raise exception using
    message = 'Those play windows don''t fit the planned time. Update Pickleague, then set them again.',
    hint = 'pl:windows.bad',
    detail = p_problem::text;
end $$;
revoke all on function public._pl_raise_windows(jsonb) from public, anon, authenticated;

-- A closed group as stored: distinct ids of accepted friends of p_uid, in the
-- order given, at most 7. Anything else (not a friend, not an id) is dropped
-- silently, as Doggle drops dogs you don't own.
create or replace function public._pl_clean_group(p_uid uuid, p_group jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  x     jsonb;
  v_id  uuid;
begin
  if p_group is null or jsonb_typeof(p_group) <> 'array' then return v_out; end if;
  for x in select g from jsonb_array_elements(p_group) g loop
    continue when jsonb_typeof(x) <> 'string'
               or (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_id := (x #>> '{}')::uuid;
    continue when v_id = p_uid or v_out ? v_id::text or not public.are_friends(p_uid, v_id);
    v_out := v_out || to_jsonb(v_id::text);
    exit when jsonb_array_length(v_out) >= 7;
  end loop;
  return v_out;
end $$;
revoke all on function public._pl_clean_group(uuid, jsonb) from public, anon, authenticated;

-- Offset windows as stored on a routine: checked (refused with pl:windows.bad),
-- then rebuilt with only the known keys and the group cleaned. Null or [] is
-- the whole length as one window, mode not said.
create or replace function public._pl_clean_windows(p_uid uuid, p_windows jsonb, p_length int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_problem jsonb;
begin
  if p_windows is null or jsonb_typeof(p_windows) = 'null'
     or (jsonb_typeof(p_windows) = 'array' and jsonb_array_length(p_windows) = 0) then
    return jsonb_build_array(jsonb_build_object('start_min', 0, 'end_min', p_length, 'mode', null, 'hint', null,
                                                'group', '[]'::jsonb));
  end if;
  v_problem := public._pl_windows_problem(p_windows, p_length);
  if v_problem is not null then perform public._pl_raise_windows(v_problem); end if;
  return (
    select jsonb_agg(jsonb_build_object(
             'start_min', (w ->> 'start_min')::numeric::int,
             'end_min',   (w ->> 'end_min')::numeric::int,
             'mode',      public._pl_json_str(w -> 'mode'),
             'hint',      public._pl_json_str(w -> 'hint'),
             'group',     public._pl_clean_group(p_uid, w -> 'group'))
             order by o)
      from jsonb_array_elements(p_windows) with ordinality x(w, o));
end $$;
revoke all on function public._pl_clean_windows(uuid, jsonb, int) from public, anon, authenticated;

-- Offset windows made absolute from p_start (windowsToAbsolute: elapsed
-- minutes, so DST never shifts them).
create or replace function public._pl_windows_at(p_windows jsonb, p_start timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'starts_at', p_start + make_interval(mins => (w ->> 'start_min')::int),
           'ends_at',   p_start + make_interval(mins => (w ->> 'end_min')::int),
           'mode',      w -> 'mode',
           'hint',      w -> 'hint',
           'group',     coalesce(w -> 'group', '[]'::jsonb))
           order by (w ->> 'start_min')::int), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) w;
$$;
revoke all on function public._pl_windows_at(jsonb, timestamptz) from public, anon, authenticated;

-- Absolute windows moved by p_by (an occurrence moved to another time).
create or replace function public._pl_shift_windows(p_windows jsonb, p_by interval)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(w || jsonb_build_object(
           'starts_at', (w ->> 'starts_at')::timestamptz + p_by,
           'ends_at',   (w ->> 'ends_at')::timestamptz + p_by)
           order by (w ->> 'starts_at')::timestamptz), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) w;
$$;
revoke all on function public._pl_shift_windows(jsonb, interval) from public, anon, authenticated;

-- Absolute windows refitted to [p_start, p_end] (a check-in's planned end
-- moved): those starting at or after the end are dropped, the last one kept
-- ends at p_end. Null when none is left.
create or replace function public._pl_fit_windows(p_windows jsonb, p_end timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kept jsonb;
  n      int;
begin
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) = 0 then return null; end if;
  select jsonb_agg(w order by (w ->> 'starts_at')::timestamptz) into v_kept
    from jsonb_array_elements(p_windows) w
   where (w ->> 'starts_at')::timestamptz < p_end;
  if v_kept is null then return null; end if;
  n := jsonb_array_length(v_kept);
  return jsonb_set(v_kept, array[(n - 1)::text, 'ends_at'], to_jsonb(p_end));
end $$;
revoke all on function public._pl_fit_windows(jsonb, timestamptz) from public, anon, authenticated;

-- Absolute windows for a check-in (set_checkin_plan): 1 to 6, in order, each
-- starting where the one before ends (within a minute; snapped), modes, hints
-- and group as on a routine (group cleaned). The first starts at p_start and
-- the last ends at p_end whatever was sent (the server owns both ends); no
-- step rule, so "Switch to open play now" can cut at any minute. Refused with
-- pl:windows.bad: empty, too_many, malformed (a time that doesn't parse),
-- gap, overlap, too_short (a window that ends at or before its start),
-- bad_mode, bad_hint, group_too_big.
create or replace function public._pl_clean_abs_windows(p_uid uuid, p_windows jsonb, p_start timestamptz, p_end timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n     int;
  i     int;
  w     jsonb;
  v_s   timestamptz;
  v_e   timestamptz;
  v_prv timestamptz;
  m     text;
  h     text;
  v_out jsonb := '[]'::jsonb;
begin
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) = 0 then
    perform public._pl_raise_windows(jsonb_build_object('problem', 'empty', 'index', -1));
  end if;
  n := jsonb_array_length(p_windows);
  if n > 6 then perform public._pl_raise_windows(jsonb_build_object('problem', 'too_many', 'index', -1)); end if;
  for i in 0 .. n - 1 loop
    w := p_windows -> i;
    begin
      v_s := (w ->> 'starts_at')::timestamptz;
      v_e := (w ->> 'ends_at')::timestamptz;
    exception when others then
      v_s := null;
    end;
    if jsonb_typeof(w) is distinct from 'object' or v_s is null or v_e is null then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'malformed', 'index', i));
    end if;
    if i = 0 then
      v_s := p_start;
    elsif v_s > v_prv + interval '1 minute' then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'gap', 'index', i));
    elsif v_s < v_prv - interval '1 minute' then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'overlap', 'index', i));
    else
      v_s := v_prv;
    end if;
    if i = n - 1 then v_e := p_end; end if;
    if v_e <= v_s then perform public._pl_raise_windows(jsonb_build_object('problem', 'too_short', 'index', i)); end if;
    m := public._pl_json_str(w -> 'mode');
    if m is not null and m not in ('closed', 'open') then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'bad_mode', 'index', i));
    end if;
    h := public._pl_json_str(w -> 'hint');
    if not public._pl_window_hint_ok(m, h) then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'bad_hint', 'index', i));
    end if;
    if jsonb_typeof(w -> 'group') = 'array' and jsonb_array_length(w -> 'group') > 7 then
      perform public._pl_raise_windows(jsonb_build_object('problem', 'group_too_big', 'index', i));
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'starts_at', v_s, 'ends_at', v_e, 'mode', m, 'hint', h,
      'group', public._pl_clean_group(p_uid, w -> 'group')));
    v_prv := v_e;
  end loop;
  return v_out;
end $$;
revoke all on function public._pl_clean_abs_windows(uuid, jsonb, timestamptz, timestamptz) from public, anon, authenticated;

-- modeAt (foundation) for absolute windows at p_at: {mode, position
-- inside|before|after, until (end of the run of that mode; null after the
-- last), next_mode, next_at (the next run's mode and start), next_open_at
-- (the next open window's start after p_at), group (the current window's)}.
-- Before the first window its mode applies; after the last, the last one's
-- carries on (Stay 1 more hour keeps it). Null when there are no windows.
create or replace function public._pl_windows_now(p_windows jsonb, p_at timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_w   jsonb[];
  v_s   timestamptz[];
  v_e   timestamptz[];
  v_m   text[];
  n     int;
  i     int;
  idx   int;
  pos   text := 'inside';
  v_run int;
  v_nxt timestamptz;
begin
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) = 0 then return null; end if;
  begin
    select array_agg(w order by (w ->> 'starts_at')::timestamptz),
           array_agg((w ->> 'starts_at')::timestamptz order by (w ->> 'starts_at')::timestamptz),
           array_agg((w ->> 'ends_at')::timestamptz order by (w ->> 'starts_at')::timestamptz),
           array_agg(w ->> 'mode' order by (w ->> 'starts_at')::timestamptz)
      into v_w, v_s, v_e, v_m
      from jsonb_array_elements(p_windows) w;
  exception when others then
    return null;
  end;
  n := cardinality(v_s);
  for i in 1 .. n loop
    if p_at >= v_s[i] and p_at < v_e[i] then idx := i; exit; end if;
  end loop;
  if idx is null then
    if p_at < v_s[1] then
      idx := 1; pos := 'before';
    elsif p_at >= v_e[n] then
      idx := n; pos := 'after';
    else
      -- In a gap: the one before carries on.
      for i in 1 .. n loop
        if v_e[i] <= p_at then idx := i; end if;
      end loop;
    end if;
  end if;
  v_run := idx;
  while v_run < n and v_m[v_run + 1] is not distinct from v_m[idx] loop v_run := v_run + 1; end loop;
  for i in 1 .. n loop
    if v_m[i] = 'open' and v_s[i] > p_at then v_nxt := v_s[i]; exit; end if;
  end loop;
  return jsonb_build_object(
    'mode',         v_m[idx],
    'position',     pos,
    'until',        case when pos = 'after' then null else v_e[v_run] end,
    'next_mode',    case when pos <> 'after' and v_run < n then v_m[v_run + 1] end,
    'next_at',      case when pos <> 'after' and v_run < n then v_s[v_run + 1] end,
    'next_open_at', v_nxt,
    'group',        coalesce(v_w[idx] -> 'group', '[]'::jsonb));
end $$;
revoke all on function public._pl_windows_now(jsonb, timestamptz) from public, anon, authenticated;

-- The mode in force at p_at: 'open', 'closed', or null (not said / no windows).
create or replace function public._pl_checkin_mode_at(p_windows jsonb, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public._pl_windows_now(p_windows, p_at) ->> 'mode';
$$;
revoke all on function public._pl_checkin_mode_at(jsonb, timestamptz) from public, anon, authenticated;

-- "9 AM" / "10:30 AM" in p_tz (an invalid or null zone: the default).
create or replace function public._pl_clock(p_at timestamptz, p_tz text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_local timestamp;
begin
  if p_at is null then return null; end if;
  v_local := p_at at time zone case when public._pickleague_valid_tz(p_tz) then p_tz
                                    else public._pickleague_default_tz() end;
  return to_char(v_local, 'FMHH12')
      || case when extract(minute from v_local) = 0 then '' else to_char(v_local, ':MI') end
      || ' ' || to_char(v_local, 'AM');
end $$;
revoke all on function public._pl_clock(timestamptz, text) from public, anon, authenticated;

-- formatWindowsFrom (foundation): "Closed group until 10:30 AM, then open
-- play", "Open play until 12 PM", "Open play from 10:30 AM" (nothing said
-- until then). Null when there is nothing to say.
create or replace function public._pl_windows_summary(p_windows jsonb, p_at timestamptz, p_tz text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v     jsonb := public._pl_windows_now(p_windows, p_at);
  v_lbl text;
  v_nxt text;
begin
  if v is null or v ->> 'position' = 'after' then return null; end if;
  v_lbl := case v ->> 'mode' when 'closed' then 'Closed group' when 'open' then 'Open play' end;
  v_nxt := case v ->> 'next_mode' when 'closed' then 'closed group' when 'open' then 'open play' end;
  if v_lbl is null then
    if v_nxt is null then return null; end if;
    return initcap(left(v_nxt, 1)) || substr(v_nxt, 2) || ' from ' || public._pl_clock((v ->> 'next_at')::timestamptz, p_tz);
  end if;
  return v_lbl || ' until ' || public._pl_clock((v ->> 'until')::timestamptz, p_tz)
      || coalesce(', then ' || v_nxt, '');
end $$;
revoke all on function public._pl_windows_summary(jsonb, timestamptz, text) from public, anon, authenticated;


-- ── 3. Occurrences ─────────────────────────────────────────────────────────

-- p_uid has starred this court (or a duplicate row of its facility).
create or replace function public._pl_is_starred(p_uid uuid, p_venue text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.court_favorites f
     where f.user_id = p_uid
       and f.venue_id in (select v.id from public.venues v
                           where v.id = coalesce(public._pl_canonical_venue(p_venue), p_venue)
                              or v.canonical_id = coalesce(public._pl_canonical_venue(p_venue), p_venue)));
$$;
revoke all on function public._pl_is_starred(uuid, text) from public, anon, authenticated;

-- The planned occurrence of mine at this court whose window holds p_at (30
-- minutes before to 30 minutes after its time, Doggle 0443), the nearest one
-- when two do. Null when none.
create or replace function public._pl_routine_plan_at(p_uid uuid, p_venue text, p_at timestamptz)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pl.id
    from public.court_plans pl
   where pl.user_id = p_uid and pl.status = 'planned'
     and pl.venue_id in (select v.id from public.venues v
                          where v.id = coalesce(public._pl_canonical_venue(p_venue), p_venue)
                             or v.canonical_id = coalesce(public._pl_canonical_venue(p_venue), p_venue))
     and p_at between pl.planned_at - interval '30 minutes' and pl.planned_at + interval '30 minutes'
   order by abs(extract(epoch from (p_at - pl.planned_at))), pl.id
   limit 1;
$$;
revoke all on function public._pl_routine_plan_at(uuid, text, timestamptz) from public, anon, authenticated;

-- Doggle's materialize_checkin_routines (0415), with the clock passed in (the
-- persona tests move it; everything else passes now()). For each active
-- routine (one, or all) at a court its player still stars: today and tomorrow
-- in its zone, on its days, the wall clock per date (DST never shifts it),
-- not already past, not within 30 minutes of another planned or kept plan of
-- mine at that court; a day already made (a skipped one too) is never made
-- again. Windows made absolute from the start. Returns how many were made.
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
      for d in select g::date from generate_series(v_today, v_today + 1, interval '1 day') g loop
        continue when (r.days & (1 << (extract(isodow from d)::int - 1))) = 0;
        v_at := (d + r.local_time) at time zone r.tz;
        continue when v_at <= p_now;
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

-- pg_cron (*/15, pickleague-materialize-court-routines) and every save. The
-- whole run (p_routine null) first tidies up: an occurrence nobody kept goes
-- away 30 minutes after its time (Doggle 0443: deleted, not 'missed'), and
-- the upcoming occurrences of a court no longer starred go too (the routine
-- stays, dormant, until it is starred again).
create or replace function public.materialize_court_routines(p_routine uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_routine is null then
    delete from public.court_plans pl
     where pl.routine_id is not null and pl.status = 'planned'
       and pl.planned_at < now() - interval '30 minutes';
    delete from public.court_plans pl
     where pl.routine_id is not null and pl.status = 'planned'
       and not public._pl_is_starred(pl.user_id, pl.venue_id);
  end if;
  return public._pl_materialize_court_routines(p_routine, now());
end $$;
revoke all on function public.materialize_court_routines(uuid) from public, anon, authenticated;


-- ── 4. A check-in keeps an occurrence ──────────────────────────────────────
-- Any location-confirmed check-in that starts at a routine court within an
-- occurrence's window keeps it (Doggle _link_checkin_to_matching_plan): the
-- link and the occurrence's windows before insert, the occurrence completed
-- after. process_court_arrivals sets plan_id itself (with the planned end);
-- this then only completes the occurrence.
create or replace function public._pl_checkin_link_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan uuid;
begin
  if new.plan_id is null and new.location_confirmed then
    v_plan := public._pl_routine_plan_at(new.user_id, new.venue_id, new.checked_in_at);
    if v_plan is not null then
      new.plan_id := v_plan;
      if new.play_windows is null then
        new.play_windows := (select pl.windows from public.court_plans pl where pl.id = v_plan);
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._pl_checkin_link_plan() from public, anon, authenticated;

create or replace function public._pl_checkin_plan_kept()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.court_plans pl
     set status = 'completed', checkin_id = new.id, updated_at = now()
   where pl.id = new.plan_id and pl.status = 'planned';
  return null;
end $$;
revoke all on function public._pl_checkin_plan_kept() from public, anon, authenticated;

drop trigger if exists trg_venue_checkins_plan_link on public.venue_checkins;
create trigger trg_venue_checkins_plan_link
  before insert on public.venue_checkins
  for each row execute function public._pl_checkin_link_plan();
drop trigger if exists trg_venue_checkins_plan_kept on public.venue_checkins;
create trigger trg_venue_checkins_plan_kept
  after insert on public.venue_checkins
  for each row when (new.plan_id is not null)
  execute function public._pl_checkin_plan_kept();


-- ── 5. Pushes ──────────────────────────────────────────────────────────────
-- A routine push straight into the outbox, as _pl_court_arrival_push does
-- (category notifyAutoCheckins, outbox kind 'info', deep link home/- when the
-- court's name is known), with any push_data (its 'kind' picks the buttons in
-- send-push). Never raises.
create or replace function public._pl_court_push(
  p_uid          uuid,
  p_title        text,
  p_body         text,
  p_venue_name   text,
  p_push_expires timestamptz,
  p_data         jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.push_outbox
    (recipient_id, kind, category, title, body, deep_link, expires_at, push_data)
  values (
    p_uid, 'info', 'notifyAutoCheckins', p_title, p_body,
    case when p_venue_name is not null then 'home/-' end,
    p_push_expires,
    jsonb_strip_nulls(coalesce(p_data, '{}'::jsonb)));
exception when others then
  raise warning 'court push % for % not queued: %', p_data ->> 'kind', p_uid, sqlerrm;
end $$;
revoke all on function public._pl_court_push(uuid, text, text, text, timestamptz, jsonb) from public, anon, authenticated;


-- ── 6. Owner RPCs ──────────────────────────────────────────────────────────

-- Doggle list_my_checkin_routines (0416, 0443): every routine of mine with its
-- court (lat/lng, radius from the outline for the routine fence tier),
-- whether I still star it and its per-court switch, the length and windows,
-- 'next' (the next occurrence still in play: today's until 30 minutes after
-- its time) and 'occurrences' (all of those, today's and tomorrow's).
create or replace function public.list_my_court_routines()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',           cr.id,
             'venue_id',     cr.venue_id,
             'venue_name',   v.name,
             'lat',          v.lat,
             'lng',          v.lng,
             'radius_m',     case when v.area_sqm > 0 then round(sqrt(v.area_sqm / pi()))::int end,
             'starred',      public._pl_is_starred(v_me, cr.venue_id),
             'auto_checkin', coalesce((select bool_or(f.auto_checkin) from public.court_favorites f
                                        where f.user_id = v_me
                                          and f.venue_id in (select x.id from public.venues x
                                                              where x.id = cr.venue_id or x.canonical_id = cr.venue_id)), false),
             'local_time',   to_char(cr.local_time, 'HH24:MI'),
             'days',         cr.days,
             'tz',           cr.tz,
             'length_min',   cr.length_min,
             'windows',      cr.windows,
             'active',       cr.active,
             'next', (
               select jsonb_build_object('plan_id', pl.id, 'planned_at', pl.planned_at,
                                         'planned_end_at', pl.planned_end_at, 'status', pl.status)
                 from public.court_plans pl
                where pl.routine_id = cr.id
                  and pl.planned_at > now() - interval '30 minutes'
                  and pl.status in ('planned', 'cancelled', 'completed')
                order by pl.planned_at
                limit 1),
             'occurrences', coalesce((
               select jsonb_agg(jsonb_build_object('plan_id', pl.id, 'planned_at', pl.planned_at,
                                                   'planned_end_at', pl.planned_end_at, 'status', pl.status,
                                                   'windows', pl.windows)
                                order by pl.planned_at)
                 from public.court_plans pl
                where pl.routine_id = cr.id
                  and pl.planned_at > now() - interval '30 minutes'
                  and pl.status in ('planned', 'cancelled', 'completed')), '[]'::jsonb))
             order by cr.local_time, v.name, cr.id)
      from public.court_routines cr
      join public.venues v on v.id = cr.venue_id
     where cr.user_id = v_me), '[]'::jsonb);
end $$;
revoke all on function public.list_my_court_routines() from public, anon;
grant execute on function public.list_my_court_routines() to authenticated;

-- "Check me in at my routine courts".
create or replace function public.get_court_routine_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  return jsonb_build_object('routine_auto_checkin',
    coalesce((select s.routine_auto_checkin from public.presence_settings s where s.user_id = v_me), true));
end $$;
revoke all on function public.get_court_routine_settings() from public, anon;
grant execute on function public.get_court_routine_settings() to authenticated;

create or replace function public.set_routine_auto_checkin(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  insert into public.presence_settings (user_id) values (v_me) on conflict (user_id) do nothing;
  update public.presence_settings
     set routine_auto_checkin = coalesce(p_on, true), updated_at = now()
   where user_id = v_me;
  return public.get_court_routine_settings();
end $$;
revoke all on function public.set_routine_auto_checkin(boolean) from public, anon;
grant execute on function public.set_routine_auto_checkin(boolean) to authenticated;

-- Doggle save_checkin_routine: new (p_routine_id null) or an edit of mine.
-- The court must be one I star (decision 1). Time to the minute, days 1-127,
-- length 30-240 in 15-minute steps, windows per the rules above (null or []
-- = the whole length, not said), zone from the device else my Pickleague
-- zone. Max 12. Upcoming planned occurrences are re-made from the new
-- settings; skipped days stay skipped. Returns list_my_court_routines().
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

  delete from public.court_plans
   where routine_id = v_id and status = 'planned' and planned_at > now();
  perform public._pl_materialize_court_routines(v_id, now());
  return public.list_my_court_routines();
end $$;
revoke all on function public.save_court_routine(uuid, text, time, integer, text, integer, jsonb) from public, anon;
grant execute on function public.save_court_routine(uuid, text, time, integer, text, integer, jsonb) to authenticated;

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
    delete from public.court_plans
     where routine_id = p_routine_id and status = 'planned' and planned_at > now();
  end if;
  return public.list_my_court_routines();
end $$;
revoke all on function public.set_court_routine_active(uuid, boolean) from public, anon;
grant execute on function public.set_court_routine_active(uuid, boolean) to authenticated;

-- Upcoming occurrences go with it; past ones stay as plain plans.
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
   where routine_id = p_routine_id and status in ('planned', 'cancelled') and planned_at > now();
  delete from public.court_routines where id = p_routine_id and user_id = v_me;
  return public.list_my_court_routines();
end $$;
revoke all on function public.delete_court_routine(uuid) from public, anon;
grant execute on function public.delete_court_routine(uuid) to authenticated;

-- "Skip today": cancel one occurrence of mine still in play (its window not
-- over, not kept). The (routine_id, routine_date) row stays, so it is never
-- made again. Its reminder, if not sent yet, is dropped.
create or replace function public.skip_court_routine_occurrence(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  update public.court_plans
     set status = 'cancelled', updated_at = now()
   where id = p_plan_id and user_id = v_me and routine_id is not null
     and status in ('planned', 'cancelled') and planned_at > now() - interval '30 minutes';
  if not found then
    raise exception using message = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.', hint = 'pl:plan.gone';
  end if;
  delete from public.push_outbox o
   where o.recipient_id = v_me and o.notification_id is null and o.status in ('pending', 'failed')
     and o.push_data ->> 'kind' = 'routine_reminder' and o.push_data ->> 'plan_id' = p_plan_id::text;
  return public.list_my_court_routines();
end $$;
revoke all on function public.skip_court_routine_occurrence(uuid) from public, anon;
grant execute on function public.skip_court_routine_occurrence(uuid) to authenticated;

-- Undo a skip (Doggle unskip_checkin_routine_occurrence): a skipped
-- occurrence of mine whose time hasn't come yet.
create or replace function public.unskip_court_routine_occurrence(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  update public.court_plans
     set status = 'planned', updated_at = now()
   where id = p_plan_id and user_id = v_me and routine_id is not null
     and status in ('cancelled', 'planned') and planned_at > now();
  if not found then
    raise exception using message = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.', hint = 'pl:plan.gone';
  end if;
  return public.list_my_court_routines();
end $$;
revoke all on function public.unskip_court_routine_occurrence(uuid) from public, anon;
grant execute on function public.unskip_court_routine_occurrence(uuid) to authenticated;

-- "Change today's time": one planned occurrence of mine still in play moves
-- to p_at (to the minute), later than now and on the same day in the
-- routine's zone; its end and windows move with it. Its reminder re-arms
-- (an unsent one for the old time is dropped).
create or replace function public.move_court_routine_occurrence(p_plan_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_pl  record;
  v_at  timestamptz := date_trunc('minute', p_at);
  v_by  interval;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  select pl.id, pl.planned_at, pl.routine_date, pl.status, coalesce(cr.tz, public._pickleague_tz_for(v_me)) as tz
    into v_pl
    from public.court_plans pl
    left join public.court_routines cr on cr.id = pl.routine_id
   where pl.id = p_plan_id and pl.user_id = v_me and pl.routine_id is not null
   for update of pl;
  if not found or v_pl.status <> 'planned' or v_pl.planned_at <= now() - interval '30 minutes' then
    raise exception using message = 'That routine check-in is already over, so it can''t be changed. Pull to refresh.', hint = 'pl:plan.gone';
  end if;
  if v_at is null or v_at <= now() or (v_at at time zone v_pl.tz)::date <> v_pl.routine_date then
    raise exception using message = 'Pick a later time on the same day.', hint = 'pl:plan.bad_time';
  end if;
  v_by := v_at - v_pl.planned_at;
  update public.court_plans
     set planned_at = v_at, planned_end_at = planned_end_at + v_by,
         windows = public._pl_shift_windows(windows, v_by), updated_at = now()
   where id = p_plan_id;
  delete from public.push_outbox o
   where o.recipient_id = v_me and o.notification_id is null and o.status in ('pending', 'failed')
     and o.push_data ->> 'kind' = 'routine_reminder' and o.push_data ->> 'plan_id' = p_plan_id::text;
  return public.list_my_court_routines();
end $$;
revoke all on function public.move_court_routine_occurrence(uuid, timestamptz) from public, anon;
grant execute on function public.move_court_routine_occurrence(uuid, timestamptz) to authenticated;

-- Doggle suggest_checkin_routines: a habit is 3+ different days in the last 6
-- weeks at the same court, within 40 minutes of the same time of day, on
-- weekdays or on weekends. From my location-confirmed check-ins only (never
-- taken back), at courts I star (decision 1), not already covered by a
-- routine of mine. Plus a length: the habit's median stay, to 30 minutes,
-- 30 min to 4 h. At most 3.
create or replace function public.suggest_court_routines(p_tz text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_tz text;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  v_tz := case when public._pickleague_valid_tz(p_tz)
                    and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then p_tz
               else public._pickleague_tz_for(v_me) end;
  return coalesce((
    with c as (
      select coalesce(public._pl_canonical_venue(ci.venue_id), ci.venue_id) as venue_id,
             (ci.checked_in_at at time zone v_tz)::date as day,
             (extract(hour from ci.checked_in_at at time zone v_tz) * 60
              + extract(minute from ci.checked_in_at at time zone v_tz))::int as mins,
             greatest(1, extract(epoch from (coalesce(ci.checked_out_at, ci.expires_at) - ci.checked_in_at)) / 60)::int as len
        from public.venue_checkins ci
       where ci.user_id = v_me
         and ci.location_confirmed and ci.taken_back_at is null
         and ci.checked_in_at > now() - interval '42 days'
    ),
    w as (
      select c.*, extract(isodow from c.day)::int <= 5 as wk from c
       where public._pl_is_starred(v_me, c.venue_id)
    ),
    clusters as (
      select a.venue_id, a.wk,
             count(distinct b.day) as n,
             percentile_disc(0.5) within group (order by b.mins) as med,
             percentile_disc(0.5) within group (order by b.len) as med_len,
             bit_or(1 << (extract(isodow from b.day)::int - 1)) as seen
        from w a
        join w b on b.venue_id = a.venue_id and b.wk = a.wk and abs(b.mins - a.mins) <= 40
       group by a.venue_id, a.wk, a.day, a.mins
    ),
    ranked as (
      select cl.*, row_number() over (partition by cl.venue_id, cl.wk order by cl.n desc, cl.med) as rk
        from clusters cl
       where cl.n >= 3
    ),
    best as (
      select r1.venue_id, r1.wk, r1.n,
             (round(r1.med / 15.0) * 15)::int as mins,
             least(240, greatest(30, (round(r1.med_len / 30.0) * 30)::int)) as length_min,
             case when r1.wk then (case when (select count(*) from generate_series(0, 4) i where (r1.seen & (1 << i)) <> 0) >= 3
                                        then 31 else r1.seen & 31 end)
                  else r1.seen & 96 end as days
        from ranked r1
       where not exists (
         select 1 from ranked r2
          where r2.venue_id = r1.venue_id and r2.wk = r1.wk and r2.rk < r1.rk
            and abs(r2.med - r1.med) <= 60)
    ),
    fresh as (
      select bt.*, make_time(least(bt.mins, 1425) / 60, least(bt.mins, 1425) % 60, 0) as at_time
        from best bt
       where bt.days > 0
         and not exists (
           select 1 from public.court_routines cr
            where cr.user_id = v_me
              and cr.venue_id = bt.venue_id
              and (cr.days & bt.days) <> 0
              and abs(extract(epoch from (cr.local_time - make_time(least(bt.mins, 1425) / 60, least(bt.mins, 1425) % 60, 0))) / 60) <= 45)
       order by bt.n desc
       limit 3
    )
    select jsonb_agg(jsonb_build_object(
             'venue_id',   f.venue_id,
             'venue_name', v.name,
             'local_time', to_char(f.at_time, 'HH24:MI'),
             'days',       f.days,
             'length_min', f.length_min,
             'visits',     f.n)
             order by f.n desc, f.mins)
      from fresh f
      join public.venues v on v.id = f.venue_id), '[]'::jsonb);
end $$;
revoke all on function public.suggest_court_routines(text) from public, anon;
grant execute on function public.suggest_court_routines(text) to authenticated;

-- Doggle list_profile_checkin_routines: a player's active routines (at courts
-- they still star) as I may see them: all of mine; another player's only when
-- I see their plans by name (_pl_can_see_presence 'plans': plans_level,
-- default friends; never across a block, a hide-from, a pause, to a guest or
-- for a deleted account). Others never see a closed group's members.
create or replace function public.list_profile_court_routines(p_profile uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_profile is null then return '[]'::jsonb; end if;
  if p_profile <> v_me and public._pl_can_see_presence(v_me, p_profile, 'plans') <> 'named' then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'venue_id',   cr.venue_id,
             'venue_name', v.name,
             'local_time', to_char(cr.local_time, 'HH24:MI'),
             'days',       cr.days,
             'tz',         cr.tz,
             'length_min', cr.length_min,
             'windows',    case when p_profile = v_me then cr.windows
                                else (select coalesce(jsonb_agg(w - 'group' order by o), '[]'::jsonb)
                                        from jsonb_array_elements(cr.windows) with ordinality x(w, o)) end)
             order by cr.local_time, v.name, cr.id)
      from public.court_routines cr
      join public.venues v on v.id = cr.venue_id
     where cr.user_id = p_profile and cr.active
       and public._pl_is_starred(p_profile, cr.venue_id)), '[]'::jsonb);
end $$;
revoke all on function public.list_profile_court_routines(uuid) from public, anon;
grant execute on function public.list_profile_court_routines(uuid) to authenticated;

-- A planned end and windows on my open check-in (the check-in sheet's "How
-- long?" and "Closed group / Open play", sent after checkin_venue in the same
-- queue entry; "Switch to open play now" sends the split windows).
--   p_planned_end  null: windows only, the end stays as it is. Else later
--                  than now (pl:plan.bad_end); the check-in then runs to it
--                  (expires_at = planned_end_at), within extend_checkin's
--                  caps: 4 hours from now, and for a location-confirmed
--                  check-in 4 hours past its last fix (a cap never cuts it
--                  below its current end). Earlier than its end shortens it.
--   p_windows      absolute windows (see _pl_clean_abs_windows); null keeps
--                  the ones it has, fitted to the end; [] clears them.
-- Returns the check-in's plan fields and its mode now.
create or replace function public.set_checkin_plan(
  p_checkin     uuid,
  p_planned_end timestamptz default null,
  p_windows     jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_row  public.venue_checkins;
  v_end      timestamptz;
  v_plan_end timestamptz;
  v_cap      timestamptz;
  v_win      jsonb;
begin
  if v_me is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if p_checkin is null then
    raise exception using message = 'Couldn''t save your plan because the app sent an incomplete request. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  perform pg_advisory_xact_lock(hashtext('checkin:' || v_me::text));
  select * into v_row from public.venue_checkins c where c.id = p_checkin and c.user_id = v_me;
  if v_row.id is null then
    raise exception using
      message = 'You''re not checked in anywhere, so there''s nothing to plan. Check in when you''re at a court.',
      hint = 'pl:checkin.none';
  end if;
  if v_row.checked_out_at is not null or v_row.taken_back_at is not null or v_row.expires_at <= now() then
    raise exception using
      message = format('Your check-in at %s already ended (%s). Check in again when you''re at the court.',
                       coalesce((select v.name from public.venues v where v.id = v_row.venue_id), 'the court'),
                       public._pickleague_local_label(coalesce(v_row.checked_out_at, v_row.expires_at),
                                                      public._pickleague_tz_for(v_me))),
      hint = 'pl:checkin.closed',
      detail = jsonb_build_object('ended_at', coalesce(v_row.checked_out_at, v_row.expires_at))::text;
  end if;

  if p_planned_end is null then
    -- Windows only: the check-in's end stays (an arrival check-in stays
    -- "not extended"); the windows run to its planned end, else its end.
    v_end := v_row.expires_at;
    v_plan_end := coalesce(v_row.planned_end_at, v_row.expires_at);
  else
    v_plan_end := date_trunc('minute', p_planned_end);
    if v_plan_end <= now() then
      raise exception using message = 'Pick an end time later than now.', hint = 'pl:plan.bad_end';
    end if;
    v_cap := now() + interval '4 hours';
    if v_row.location_confirmed then
      v_cap := least(v_cap, coalesce(v_row.fix_at, v_row.checked_in_at) + interval '4 hours');
    end if;
    v_plan_end := least(v_plan_end, greatest(v_cap, v_row.expires_at));
    v_end := v_plan_end;
  end if;

  if p_windows is null then
    v_win := public._pl_fit_windows(v_row.play_windows, v_plan_end);
  elsif jsonb_typeof(p_windows) = 'array' and jsonb_array_length(p_windows) = 0 then
    v_win := null;
  else
    v_win := public._pl_clean_abs_windows(v_me, p_windows, v_row.checked_in_at, v_plan_end);
  end if;

  update public.venue_checkins
     set planned_end_at = case when p_planned_end is null then planned_end_at else v_plan_end end,
         expires_at     = v_end,
         play_windows   = v_win
   where id = v_row.id
  returning * into v_row;
  return jsonb_build_object(
    'checkin_id',     v_row.id,
    'venue_id',       v_row.venue_id,
    'checked_in_at',  v_row.checked_in_at,
    'expires_at',     v_row.expires_at,
    'planned_end_at', v_row.planned_end_at,
    'play_windows',   v_row.play_windows,
    'plan_id',        v_row.plan_id,
    'mode_now',       public._pl_checkin_mode_at(v_row.play_windows, now()));
end $$;
revoke all on function public.set_checkin_plan(uuid, timestamptz, jsonb) from public, anon;
grant execute on function public.set_checkin_plan(uuid, timestamptz, jsonb) to authenticated;


-- ── 7. Open to play (others' view) ─────────────────────────────────────────

-- How many players at one facility are open to play now, as p_viewer counts
-- them (internal): location-confirmed open check-ins in an open window, plus
-- an open_play session's player whose check-in isn't in a closed window.
-- Counted like venue_crowd's here_now: hidden and paused players too, a
-- blocked pair (either way) never.
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
                             and (s.id = c.id or s.venue_id in (select v.id from public.venues v
                                                                 where v.id = p_canon or v.canonical_id = p_canon)))));
$$;
revoke all on function public._pl_venue_open_now(uuid, text) from public, anon, authenticated;

-- "6 here · 4 open to play": open_now for up to 50 courts, one row per known
-- venue id asked for (as asked), beside venue_crowd (whose columns stay as
-- they are). Works for guests too (counts only).
create or replace function public.venue_open_to_play(p_venue_ids text[])
returns table (venue_id text, open_now int)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out'; end if;
  if coalesce(cardinality(p_venue_ids), 0) > 50 then
    raise exception using message = 'Couldn''t load the courts because the app asked for too many at once. Update Pickleague, then try again.', hint = 'pl:request.bad';
  end if;
  return query
    select r.vid, public._pl_venue_open_now(auth.uid(), r.canon)
      from (select distinct u.vid, public._pl_canonical_venue(u.vid) as canon
              from unnest(p_venue_ids) as u(vid) where u.vid is not null) r
     where r.canon is not null;
end $$;
revoke all on function public.venue_open_to_play(text[]) from public, anon;
grant execute on function public.venue_open_to_play(text[]) to authenticated;

-- One court's play modes, beside court_presence (same visibility):
--   open_now / closed_now / unsaid_now  counts over everyone counted there
--     (anonymous players too: what a count needs, nothing more)
--   players  one entry per row I see by name (and my own), keyed by
--     checkin_id and user_id as court_presence names them: mode_now
--     ('open' also for an open_play session with nothing said), mode_until,
--     next_open_at, planned_end_at, and for a closed group:
--       closed_group  me: every member of my own group, with names;
--                     others: only the members checked in at this court now
--                     whom I see by name there. Anyone else stays "Closed
--                     group" (decision 4).
-- Guests get the counts and their own row only.
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


-- ── 8. Court arrival, taught about routines ────────────────────────────────

-- _pl_court_arrival_off: from migration_court_arrival_queue.sql (its only
-- definition). Changed: switched off everywhere ('off': "Check me in when I
-- arrive" off, or "Notice me at starred courts" at Off) no longer stops an
-- arrival during a routine stop's window (_pl_routine_plan_at, now) while
-- "Check me in at my routine courts" is on (Doggle: routine stops check in
-- whatever the favorites switch says). Routines live only at starred courts,
-- so 'not_starred' and the per-court 'off_here' still apply (a court switched
-- off still asks, as Doggle's per-park switch). Same signature.
create or replace function public._pl_court_arrival_off(p_uid uuid, p_venue text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_auto    boolean;
  v_radius  int;
  v_routine boolean;
  v_here    boolean;
begin
  select s.auto_checkin, s.court_radius_m, s.routine_auto_checkin into v_auto, v_radius, v_routine
    from public.presence_settings s where s.user_id = p_uid;
  if (not coalesce(v_auto, true) or coalesce(v_radius, 100) <= 0)
     and not (coalesce(v_routine, true) and public._pl_routine_plan_at(p_uid, p_venue, now()) is not null) then
    return 'off';
  end if;
  select f.auto_checkin into v_here
    from public.court_favorites f
   where f.user_id = p_uid
     and f.venue_id in (select v.id from public.venues v where v.id = p_venue or v.canonical_id = p_venue)
   order by f.auto_checkin desc
   limit 1;
  if v_here is null then return 'not_starred'; end if;
  if not v_here then return 'off_here'; end if;
  return null;
end $$;
revoke all on function public._pl_court_arrival_off(uuid, text) from public, anon, authenticated;

-- _pl_take_back_arrival: from migration_court_arrival_queue.sql (its only
-- definition). Changed: a taken-back check-in gives back the routine
-- occurrence it kept (planned again, as Doggle 0433 does), and its unsent
-- "Staying until" goes with its other pushes.
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
         and c.taken_back_at is null and c.source <> 'session' and c.expires_at > now()
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

-- cancel_court_arrival: from migration_court_arrival_two_hours.sql (the
-- latest). Changed: "its end untouched" is also expires_at = arrival_until
-- (a routine arrival may end before the 2 hours, at its planned end), beside
-- _pl_arrival_untouched as before (a check-in from before this file, or one
-- whose times were moved together); the sign-out drops an unsent "Staying
-- until" too.
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

-- process_court_arrivals: from migration_court_arrival_two_hours.sql (the
-- latest). Changed:
-- B. An arrival within a routine occurrence's window (_pl_routine_plan_at at
--    the arrival) keeps it: the check-in records the occurrence (plan_id; the
--    after-insert trigger marks it completed), its windows and its planned
--    end (at least 30 minutes after the arrival), and ends at the arrival +
--    the arrival length or at the planned end, whichever is first.
--    arrival_until records that end for every arrival check-in. The push
--    says "until <planned end>" and the mode now ("Closed group until 10:30
--    AM, then open play"), with plan_id and planned_end_at in push_data.
-- C. "Not extended yet" is also expires_at = arrival_until (beside the old test),
--    and when the planned end is later, the push asks "Staying until 12 PM?"
--    (push_data.kind arrival_extend_until, planned_end_at): Stay until runs
--    extend_checkin(p_id, p_until => planned_end_at).
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


-- ── 9. Reminder at each stop's time (Doggle process_routine_reminders) ─────
-- pg_cron, every 5 minutes (pickleague-court-routine-reminders). One push per
-- occurrence (and per time: a moved one re-arms), from 10 minutes before to
-- 15 minutes after its time, while it is planned, at a court I still star,
-- not when I'm already checked in there or in a play session. Category
-- notifyAutoCheckins (the phone's "Check-in automation" switch).
-- push_data.kind routine_reminder (buttons: Check in / Skip today), plan_id,
-- venue_id, venue_name, planned_at, planned_end_at.
create or replace function public.process_court_routine_reminders()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r      record;
  v_auto boolean;
begin
  for r in
    select pl.id as plan_id, pl.user_id, pl.venue_id, pl.planned_at, pl.planned_end_at,
           coalesce(cr.tz, public._pickleague_tz_for(pl.user_id)) as tz, v.name as venue_name,
           coalesce((select s.routine_auto_checkin from public.presence_settings s where s.user_id = pl.user_id), true) as routine_on
      from public.court_plans pl
      join public.court_routines cr on cr.id = pl.routine_id
      left join public.venues v on v.id = pl.venue_id
     where pl.status = 'planned'
       and pl.planned_at <= now() + interval '10 minutes'
       and pl.planned_at > now() - interval '15 minutes'
       and public._pl_is_starred(pl.user_id, pl.venue_id)
       and not exists (
         select 1 from public.venue_checkins c
          where c.user_id = pl.user_id and c.checked_out_at is null and c.expires_at > now()
            and c.taken_back_at is null
            and c.venue_id in (select x.id from public.venues x where x.id = pl.venue_id or x.canonical_id = pl.venue_id))
       and not exists (
         select 1 from public.play_sessions s
          where s.user_id = pl.user_id and s.ended_at is null and s.started_at > now() - interval '6 hours')
  loop
    begin
      if public._pl_throttle_ok(r.user_id::text, 'routine_reminder',
                                r.plan_id::text || ':' || extract(epoch from r.planned_at)::bigint::text,
                                interval '100 years') then
        v_auto := r.routine_on and coalesce((
          select bool_or(f.auto_checkin) from public.court_favorites f
           where f.user_id = r.user_id
             and f.venue_id in (select x.id from public.venues x where x.id = r.venue_id or x.canonical_id = r.venue_id)), false);
        perform public._pl_court_push(
          r.user_id,
          public._pl_clock(r.planned_at, r.tz) || ' · ' || coalesce(r.venue_name, 'your court'),
          case when v_auto then 'Your planned check-in. We''ll check you in when you get there.'
               else 'Your planned check-in. Tap Check in when you get there.' end,
          r.venue_name, r.planned_at + interval '30 minutes',
          jsonb_build_object('kind', 'routine_reminder', 'plan_id', r.plan_id, 'venue_id', r.venue_id,
                             'venue_name', r.venue_name, 'planned_at', r.planned_at,
                             'planned_end_at', r.planned_end_at));
      end if;
    exception when others then
      raise warning 'process_court_routine_reminders: plan % failed: %', r.plan_id, sqlerrm;
    end;
  end loop;
end $$;
revoke all on function public.process_court_routine_reminders() from public, anon, authenticated;


-- ── 10. Account hygiene ────────────────────────────────────────────────────

-- _purge_account: from migration_court_arrival_queue.sql (the latest). Plus
-- the routines and plans (before the check-ins: a kept plan points at one).
create or replace function public._purge_account(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_uid is null then
    raise exception 'No account given';
  end if;

  -- Waiting arrivals first: one the court arrival job has already taken
  -- (deleted, not yet committed) makes this wait for the job's commit, so the
  -- check-in it lands is there for the venue_checkins delete below, and its
  -- push for the push_outbox one (each statement sees what committed before
  -- it). Deleted last, that check-in would outlive the account.
  delete from public.pl_pending_arrivals           where user_id      = p_uid;

  delete from public.push_tokens                   where user_id      = p_uid;
  delete from public.notifications                 where user_id      = p_uid;
  delete from public.drill_request_messages        where sender_id    = p_uid;
  delete from public.drill_requests                where from_user_id = p_uid or to_user_id = p_uid;
  delete from public.drill_session_reviews         where user_id      = p_uid;
  delete from public.doubles_pair_join_requests    where user_id      = p_uid;
  delete from public.league_join_requests          where user_id      = p_uid;
  delete from public.mlp_team_join_requests        where user_id      = p_uid;
  delete from public.tournament_partner_requests   where requester_id = p_uid or requested_id = p_uid;
  delete from public.profile_claims                where profile_id   = p_uid;
  delete from public.venue_submission_affirmations where profile_id   = p_uid;
  delete from public.event_slot_votes              where user_id      = p_uid;
  delete from public.player_paddles                where user_id      = p_uid;
  delete from public.match_paddle_usage            where user_id      = p_uid;
  delete from public.player_shop_purchases         where user_id      = p_uid;
  delete from public.redemption_orders             where user_id      = p_uid;
  delete from public.ftue_grants                   where user_id      = p_uid;
  delete from public.league_members                where user_id      = p_uid;
  delete from public.user_blocks where blocker_id = p_uid or blocked_id = p_uid;

  -- Routine check-ins (migration_court_routines.sql): a weekly pattern is
  -- predictive location data.
  delete from public.court_plans          where user_id   = p_uid;
  delete from public.court_routines       where user_id   = p_uid;

  -- Presence and friends (migration_presence_p1_*.sql).
  delete from public.venue_checkins       where user_id   = p_uid;
  delete from public.play_sessions        where user_id   = p_uid;
  delete from public.presence_settings    where user_id   = p_uid;
  delete from public.presence_hidden_from where user_id   = p_uid or hidden_user_id = p_uid;
  delete from public.close_friends        where user_id   = p_uid or friend_id      = p_uid;
  delete from public.friendships          where requester_id = p_uid or addressee_id = p_uid;
  delete from public.friend_request_log   where sender_id = p_uid or addressee_id   = p_uid;
  delete from public.court_favorites      where user_id   = p_uid;
  delete from public.presence_closed_ids  where user_id   = p_uid;
  delete from public.notifications
   where entity_type = 'friend' and entity_id = p_uid
     and push_data ->> 'kind' in ('friend_request', 'friend_accepted');

  -- Court arrivals (migration_court_arrival_queue.sql; the waiting ones went
  -- first, above).
  delete from public.pl_throttle          where scope        = p_uid::text;
  delete from public.push_outbox          where recipient_id = p_uid;

  update public.profiles set
    full_name             = '[deleted account]',
    username              = 'deleted_' || left(replace(p_uid::text, '-', ''), 12),
    avatar_url            = null,
    avatar_emoji          = null,
    avatar_bg_color       = null,
    profile_frame         = null,
    name_color            = null,
    list_name_style_id    = null,
    profile_name_style_id = null,
    tagline               = null,
    phone                 = null,
    dupr_id               = null,
    selected_tags         = '{}',
    availability          = '{}',
    drill_availability    = '{}'::jsonb,
    drill_shot_prefs      = '{}',
    drill_partner_prefs   = '{}',
    drill_custom_tags     = '{}',
    drilling_enabled      = false,
    badges_public         = false,
    pickles               = 0,
    is_unclaimed          = false,
    claim_source          = null,
    guest_expires_at      = null,
    deleted_at            = now()
  where id = p_uid;

  delete from auth.users where id = p_uid;
end;
$$;

comment on function public._purge_account(uuid) is
  'Internal. Anonymises a profile to a tombstone and deletes the auth user. '
  'Reached only through delete_my_account() (self) or moderator_eject_user().';

revoke all on function public._purge_account(uuid) from public, anon, authenticated;

-- prune_presence_history: from migration_court_arrival_queue.sql (the
-- latest). Plus plans older than 90 days (a skipped or kept day is needed
-- only while it could be made again: today and tomorrow).
create or replace function public.prune_presence_history() returns void
language sql security definer set search_path = '' as $$
  delete from public.venue_checkins
   where coalesce(checked_out_at, expires_at) < now() - interval '180 days';
  delete from public.friend_request_log
   where sent_at < now() - interval '30 days';
  delete from public.presence_closed_ids
   where created_at < now() - interval '2 days';
  delete from public.pl_throttle
   where last_at < now() - interval '2 days';
  delete from public.court_plans
   where planned_at < now() - interval '90 days';
$$;
revoke execute on function public.prune_presence_history() from public, anon, authenticated;


-- ── 11. Schedule ───────────────────────────────────────────────────────────
-- Unscheduled first, so a re-run replaces them.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'pickleague-materialize-court-routines') then
    perform cron.unschedule('pickleague-materialize-court-routines');
  end if;
  perform cron.schedule('pickleague-materialize-court-routines', '*/15 * * * *',
    $c$ select public.materialize_court_routines(); $c$);
  if exists (select 1 from cron.job where jobname = 'pickleague-court-routine-reminders') then
    perform cron.unschedule('pickleague-court-routine-reminders');
  end if;
  perform cron.schedule('pickleague-court-routine-reminders', '*/5 * * * *',
    $c$ select public.process_court_routine_reminders(); $c$);
end $$;

notify pgrst, 'reload schema';
