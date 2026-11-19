-- ============================================================
-- PKL-039 + PKL-049: tournament courts (a queue that calls matches to
-- named courts) and bye-round alerts.
--
-- Brian 2026-11-18: the admin names courts before lock-in; the next match
-- whose players are all free takes the next free court; only called matches
-- can be scored (the host can override); a call sends "you're on Court N".
-- Brian 2026-11-19: "have an option for no courts reserved (players just go
-- to the next available court they can find, which is basically what we
-- have now)". And: "if the player has a BYE round, let them know".
--
-- 1. Columns
--    tournaments.courts text[]       court names in call order; null or empty
--                                    = no courts reserved (play as today).
--    tournament_matches.play_round   the schedule round inside its round
--                                    (round robin / pool / rotating partners),
--                                    written by the app at lock-in. Older rows
--                                    get it from the draw's shape (see 2).
--    tournament_matches.court        the court a match was called to, and
--    tournament_matches.called_at    when. Server-owned: a client write is
--                                    ignored (the guard restores them).
-- 2. _pl_tm_schedule(t): every schedule match with its round. The draws put
--    floor(players / 4) matches in a round for rotating partners and fixed
--    doubles, floor(players / 2) for singles, in match_order; byes are not
--    stored, so a player's byes are the rounds of their group they have no
--    match in (_pl_tm_byes).
-- 3. The queue, _pl_tm_call_next(t): while a court is free, the first open
--    uncalled match (playoff rounds after the schedule, then round, then
--    match_order) whose players are not on a court takes it. Each of its
--    players gets "You're on Court N" (in-app + push). Runs when the
--    tournament goes active, a match is completed or cancelled, the courts
--    change, or new matches are inserted into an active tournament.
-- 4. Scoring gate: with courts reserved, a match that was not called cannot
--    be scored, except by the host (created_by, admin, co-admin) or the
--    service role. Error code PL_TM_NOT_CALLED.
-- 5. Notices (migration_tournament_play_notices.sql is the base):
--    - "your first match" says "Bye in round 1: you sit out first." and,
--      with courts, "You're on Court 2 now." or "We'll push you when a court
--      is free.";
--    - "Up next" says "(round 6, after your bye in round 5)" and the court;
--    - tm_bye: when the round before a player's bye is all scored, they get
--      "Bye this round" naming their next match.
-- Elimination byes (advancing without a match) are out of scope (PKL-049).
-- All functions are internal (EXECUTE revoked); every notice is best effort.
-- Apply: supabase db query --linked -f supabase/migration_tournament_courts_byes.sql
-- Test:  supabase/tests/build-courts-byes-test.mjs (begin ... rollback).
-- ============================================================

alter table public.tournaments        add column if not exists courts     text[];
alter table public.tournament_matches add column if not exists play_round integer;
alter table public.tournament_matches add column if not exists court      text;
alter table public.tournament_matches add column if not exists called_at  timestamptz;

comment on column public.tournaments.courts is
  'PKL-039: court names in call order. Null or empty = no courts reserved (players find an open court).';
comment on column public.tournament_matches.play_round is
  'PKL-049: schedule round inside its tournament_rounds row (round robin, pool, rotating partners). Written at lock-in.';
comment on column public.tournament_matches.court is
  'PKL-039: the court this match was called to (server-owned, migration_tournament_courts_byes.sql).';
comment on column public.tournament_matches.called_at is
  'PKL-039: when the queue called this match to its court (server-owned).';

create index if not exists tournament_matches_called_idx
  on public.tournament_matches (tournament_id) where called_at is not null;


-- ── Helpers ─────────────────────────────────────────────────────────────────

-- "4" -> "Court 4"; "Center" -> "Center".
create or replace function public._pl_tm_court_label(p_court text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when trim(p_court) ~ '^[0-9]+$' then 'Court ' || trim(p_court) else trim(p_court) end
$$;
revoke all on function public._pl_tm_court_label(text) from public, anon, authenticated;

-- True when the tournament has courts reserved.
create or replace function public._pl_tm_has_courts(p_tournament uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(cardinality(array_remove(t.courts, '')), 0) > 0
    from public.tournaments t where t.id = p_tournament
$$;
revoke all on function public._pl_tm_has_courts(uuid) from public, anon, authenticated;

-- [4] -> 'round 4'; [4,5] -> 'rounds 4 and 5'; [3,4,5] -> 'rounds 3, 4 and 5'.
create or replace function public._pl_tm_rounds_text(p_rounds integer[])
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(cardinality(p_rounds), 0) = 0 then null
    when cardinality(p_rounds) = 1 then 'round ' || p_rounds[1]
    else 'rounds ' || array_to_string(p_rounds[1:cardinality(p_rounds) - 1], ', ')
         || ' and ' || p_rounds[cardinality(p_rounds)] end
$$;
revoke all on function public._pl_tm_rounds_text(integer[]) from public, anon, authenticated;

-- Every schedule match of a tournament with its round. Schedule = the
-- round robin / pool / rotating partners rounds; playoffs and other formats
-- return nothing.
create or replace function public._pl_tm_schedule(p_tournament uuid)
returns table (match_id uuid, round_id uuid, play_round integer, match_order integer)
language sql
stable
security definer
set search_path = ''
as $$
  with t as (
    select id, format, match_type from public.tournaments
     where id = p_tournament and format in ('rotating_partners', 'round_robin', 'pool_play')
  ), ms as (
    select m.id, m.round_id, m.match_order, m.play_round,
           m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2
      from public.tournament_matches m
      join t on t.id = m.tournament_id
      left join public.tournament_rounds r on r.id = m.round_id
     where coalesce(r.round_type, 'winners') in ('winners', 'pool')
       and m.team1_player1 is not null and m.team2_player1 is not null
  ), grp as (
    select ms.round_id, count(distinct u.u)::int as players
      from ms cross join lateral (values (ms.team1_player1), (ms.team1_player2),
                                         (ms.team2_player1), (ms.team2_player2)) u(u)
     where u.u is not null
     group by ms.round_id
  )
  select ms.id, ms.round_id,
         coalesce(ms.play_round,
           ((row_number() over (partition by ms.round_id order by ms.match_order, ms.id) - 1)
             / greatest(1, g.players / case when t.format = 'rotating_partners' or t.match_type = 'doubles'
                                            then 4 else 2 end))::int + 1),
         ms.match_order
    from ms join grp g on g.round_id is not distinct from ms.round_id cross join t
$$;
revoke all on function public._pl_tm_schedule(uuid) from public, anon, authenticated;

-- The schedule round of one match, or null (playoff, other formats).
create or replace function public._pl_tm_round_of(p_match uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select s.play_round
    from public.tournament_matches m
    cross join lateral public._pl_tm_schedule(m.tournament_id) s
   where m.id = p_match and s.match_id = p_match
$$;
revoke all on function public._pl_tm_round_of(uuid) from public, anon, authenticated;

-- A player's bye rounds: the rounds of their group (round_id) in which they
-- have no match, ascending. Empty for other formats.
create or replace function public._pl_tm_byes(p_tournament uuid, p_user uuid)
returns integer[]
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select s.*, m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2
      from public._pl_tm_schedule(p_tournament) s
      join public.tournament_matches m on m.id = s.match_id
  ), mine as (
    select distinct s.round_id from s
     where p_user in (s.team1_player1, s.team1_player2, s.team2_player1, s.team2_player2)
  ), span as (
    select s.round_id, max(s.play_round) as last_round from s join mine using (round_id) group by s.round_id
  )
  select coalesce(array_agg(r.n order by r.n), '{}')
    from span
    cross join lateral generate_series(1, span.last_round) r(n)
   where not exists (
     select 1 from s
      where s.round_id is not distinct from span.round_id and s.play_round = r.n
        and p_user in (s.team1_player1, s.team1_player2, s.team2_player1, s.team2_player2))
$$;
revoke all on function public._pl_tm_byes(uuid, uuid) from public, anon, authenticated;

-- The byes right before a player's match: rounds after their previous
-- schedule match and before this one. Empty when there is none.
create or replace function public._pl_tm_byes_before(p_tournament uuid, p_user uuid, p_match uuid)
returns integer[]
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select s.*, m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2
      from public._pl_tm_schedule(p_tournament) s
      join public.tournament_matches m on m.id = s.match_id
  ), me as (
    select play_round, round_id from s where s.match_id = p_match
  ), prev as (
    select coalesce(max(s.play_round), 0) as r
      from s, me
     where s.round_id is not distinct from me.round_id and s.play_round < me.play_round
       and p_user in (s.team1_player1, s.team1_player2, s.team2_player1, s.team2_player2)
  )
  select coalesce(array_agg(b order by b), '{}')
    from unnest(public._pl_tm_byes(p_tournament, p_user)) b, me, prev
   where b > prev.r and b < me.play_round
$$;
revoke all on function public._pl_tm_byes_before(uuid, uuid, uuid) from public, anon, authenticated;

-- With courts reserved: where a player's match stands. ' You''re on Court 2
-- now.' / ' We''ll push you when a court is free.' / '' without courts.
create or replace function public._pl_tm_court_text(p_match uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not public._pl_tm_has_courts(m.tournament_id) then ''
    when m.called_at is not null and m.court is not null
      then ' You''re on ' || public._pl_tm_court_label(m.court) || ' now.'
    else ' We''ll push you when a court is free.' end
    from public.tournament_matches m where m.id = p_match
$$;
revoke all on function public._pl_tm_court_text(uuid) from public, anon, authenticated;

-- " (round 6, after your bye in round 5)" / " (round 2)" / "" (not a schedule match).
create or replace function public._pl_tm_round_text(p_tournament uuid, p_user uuid, p_match uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public._pl_tm_round_of(p_match) is null then ''
    else ' (round ' || public._pl_tm_round_of(p_match)
      || coalesce(', after your ' || case when cardinality(b.b) > 1 then 'byes' else 'bye' end
                  || ' in ' || public._pl_tm_rounds_text(b.b), '')
      || ')' end
    from (select public._pl_tm_byes_before(p_tournament, p_user, p_match) as b) b
$$;
revoke all on function public._pl_tm_round_text(uuid, uuid, uuid) from public, anon, authenticated;


-- ── Notices: "Up next" and the first match (replace the PKL-036 bodies) ────

-- "Up next (round 6, after your bye in round 5): You & Sam vs Alex & Jo
-- (your match 5 of 8). You're on Court 2 now."
create or replace function public._pl_tm_next_text(p_tournament uuid, p_user uuid, p_mark boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  -- A match already called to a court comes first (the queue may call a
  -- later match of theirs while an earlier one waits for a busy player).
  select x.* into v from public._pl_tm_player_matches(p_tournament, p_user) x
    join public.tournament_matches cm on cm.id = x.match_id
   where x.is_open order by (cm.called_at is null), x.pos limit 1;
  if v.match_id is null then return null; end if;
  if p_mark then
    insert into public.reminder_log (kind, entity_id, user_id)
    values ('tm_ready', v.match_id, p_user) on conflict do nothing;
  end if;
  return 'Up next'
      || case when v.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match', 'grand_final', 'losers')
              then ' (' || coalesce(v.round_label, 'playoff') || ')'
              else public._pl_tm_round_text(p_tournament, p_user, v.match_id) end
      || ': ' || public._pl_tm_line(v.match_id, p_user)
      || ' (your match ' || v.pos || ' of ' || v.total || ').'
      || public._pl_tm_court_text(v.match_id);
end $$;
revoke all on function public._pl_tm_next_text(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public._pl_tm_ready_notice(p_tournament uuid, p_user uuid, p_first boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      record;
  v_name text;
  v_m    record;
  v_bye  integer[];
  v_rd   integer;
begin
  -- A match already called to a court comes first (the queue may call a
  -- later match of theirs while an earlier one waits for a busy player).
  select x.* into v from public._pl_tm_player_matches(p_tournament, p_user) x
    join public.tournament_matches cm on cm.id = x.match_id
   where x.is_open order by (cm.called_at is null), x.pos limit 1;
  if v.match_id is null then return false; end if;
  select name into v_name from public.tournaments where id = p_tournament;
  select court, called_at into v_m from public.tournament_matches where id = v.match_id;
  v_bye := public._pl_tm_byes_before(p_tournament, p_user, v.match_id);
  v_rd  := public._pl_tm_round_of(v.match_id);
  return public._pl_tm_notice(
    p_user, 'tm_ready', v.match_id, p_tournament,
    case when p_first and v_m.called_at is not null
           then '🏓 ' || v_name || ' is on: you''re on ' || public._pl_tm_court_label(v_m.court)
         when p_first then '🏓 ' || v_name || ' is on: your first match'
         when v.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match', 'grand_final', 'losers')
           then '🏓 Up next in ' || v_name || ': ' || coalesce(v.round_label, 'playoff')
         else '🏓 Up next in ' || v_name end,
    case when p_first and cardinality(v_bye) > 0
         then 'Bye in ' || public._pl_tm_rounds_text(v_bye) || ': you sit out first. ' else '' end
      || public._pl_tm_line(v.match_id, p_user)
      || ' (your match ' || v.pos || ' of ' || v.total
      || case when v_rd is not null then ', round ' || v_rd else '' end || ').'
      || public._pl_tm_court_text(v.match_id)
      || ' Open the tournament to play.');
end $$;
revoke all on function public._pl_tm_ready_notice(uuid, uuid, boolean) from public, anon, authenticated;


-- ── Bye this round ─────────────────────────────────────────────────────────
-- After a score: if that match's round is now all scored, every player of
-- the group who sits out the next round hears it (once per bye stretch).
create or replace function public._pl_tm_bye_notices(p_match uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t     record;
  v_m     record;
  v_r     integer;
  v_next  integer;
  v_first uuid;
  v_uid   uuid;
  v_bye   integer[];
  v_run   integer[];
  v_txt   text;
begin
  select tournament_id, round_id into v_m from public.tournament_matches where id = p_match;
  select id, name, status into v_t from public.tournaments where id = v_m.tournament_id;
  if v_t.id is null or v_t.status <> 'active' then return; end if;
  v_r := public._pl_tm_round_of(p_match);
  if v_r is null then return; end if;
  -- The round is done only when every match of it is completed or cancelled.
  if exists (select 1 from public._pl_tm_schedule(v_t.id) s
               join public.tournament_matches m on m.id = s.match_id
              where s.round_id is not distinct from v_m.round_id and s.play_round = v_r
                and m.status not in ('completed', 'cancelled')) then
    return;
  end if;
  v_next := v_r + 1;
  select s.match_id into v_first from public._pl_tm_schedule(v_t.id) s
   where s.round_id is not distinct from v_m.round_id and s.play_round = v_next
   order by s.match_order limit 1;
  if v_first is null then return; end if;   -- no next round

  for v_uid in
    select distinct u.u
      from public._pl_tm_schedule(v_t.id) s
      join public.tournament_matches m on m.id = s.match_id
      cross join lateral (values (m.team1_player1), (m.team1_player2), (m.team2_player1), (m.team2_player2)) u(u)
     where s.round_id is not distinct from v_m.round_id and u.u is not null
  loop
    begin
      v_bye := public._pl_tm_byes(v_t.id, v_uid);
      if not (v_next = any(v_bye)) then continue; end if;
      -- The run of consecutive byes that starts at v_next.
      select array_agg(b order by b) into v_run
        from unnest(v_bye) b
       where b >= v_next
         and b - v_next = (select count(*) from unnest(v_bye) c where c >= v_next and c < b);
      v_txt := public._pl_tm_next_text(v_t.id, v_uid, false);
      perform public._pl_tm_notice(
        v_uid, 'tm_bye', v_first, v_t.id,
        '🪑 Bye this round in ' || v_t.name,
        'You sit out ' || public._pl_tm_rounds_text(v_run) || '. '
          || coalesce(v_txt, 'Your matches are done; the final table comes when the last round is scored.'));
    exception when others then
      raise warning 'bye notice for % failed: %', v_uid, sqlerrm;
    end;
  end loop;
end $$;
revoke all on function public._pl_tm_bye_notices(uuid) from public, anon, authenticated;


-- ── The court queue ─────────────────────────────────────────────────────────
create or replace function public._pl_tm_call_next(p_tournament uuid, p_notify boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t      record;
  v_court  text;
  v_m      record;
  v_uid    uuid;
  v_called integer := 0;
  v_label  text;
begin
  -- One caller at a time per tournament.
  select id, name, status, courts into v_t from public.tournaments where id = p_tournament for update;
  if v_t.id is null or v_t.status <> 'active' or not public._pl_tm_has_courts(p_tournament) then return 0; end if;

  foreach v_court in array array_remove(v_t.courts, '') loop
    if exists (select 1 from public.tournament_matches m
                where m.tournament_id = p_tournament and m.court = v_court and m.called_at is not null
                  and m.status not in ('completed', 'cancelled')) then
      continue;
    end if;
    select m.id, m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2 into v_m
      from public.tournament_matches m
      left join public.tournament_rounds r on r.id = m.round_id
      left join public._pl_tm_schedule(p_tournament) s on s.match_id = m.id
     where m.tournament_id = p_tournament
       and m.status not in ('completed', 'cancelled')
       and m.called_at is null
       and coalesce(m.match_type, '') <> 'bye'
       and m.team1_player1 is not null and m.team2_player1 is not null
       and not exists (
         select 1 from public.tournament_matches b
          where b.tournament_id = p_tournament and b.called_at is not null
            and b.status not in ('completed', 'cancelled')
            and array[b.team1_player1, b.team1_player2, b.team2_player1, b.team2_player2]
                && array_remove(array[m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2], null))
     order by coalesce(r.round_number, 0), coalesce(s.play_round, 0), m.match_order, m.id
     limit 1;
    exit when v_m.id is null;   -- nothing fits; the next court can't do better

    perform set_config('pl.tm_server', '1', true);
    update public.tournament_matches set court = v_court, called_at = now() where id = v_m.id;
    perform set_config('pl.tm_server', '', true);
    v_called := v_called + 1;

    if p_notify then
      v_label := public._pl_tm_court_label(v_court);
      foreach v_uid in array array_remove(array[v_m.team1_player1, v_m.team1_player2,
                                                 v_m.team2_player1, v_m.team2_player2], null) loop
        begin
          perform public._pl_tm_notice(
            v_uid, 'tm_court', v_m.id, p_tournament,
            '🏓 You''re on ' || v_label || ' in ' || v_t.name,
            public._pl_tm_line(v_m.id, v_uid) || '. Head to ' || v_label || ' now.');
        exception when others then
          raise warning 'court notice for % failed: %', v_uid, sqlerrm;
        end;
      end loop;
    end if;
    v_m := null;
  end loop;
  return v_called;
exception when others then
  perform set_config('pl.tm_server', '', true);
  raise warning 'court queue failed for %: %', p_tournament, sqlerrm;
  return 0;
end $$;
revoke all on function public._pl_tm_call_next(uuid, boolean) from public, anon, authenticated;


-- ── Guard + scoring gate (BEFORE INSERT / UPDATE on tournament_matches) ────
create or replace function public._pl_tm_court_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_t    record;
  v_host boolean;
begin
  if coalesce(current_setting('pl.tm_server', true), '') = '1' then return new; end if;
  -- Service role and direct SQL (no signed-in user): anything goes.
  if v_uid is null then return new; end if;

  if tg_op = 'INSERT' then
    new.court := null; new.called_at := null;
    return new;
  end if;

  -- Server-owned: restore.
  new.court := old.court; new.called_at := old.called_at;
  if new.play_round is distinct from old.play_round and old.play_round is not null then
    new.play_round := old.play_round;
  end if;

  -- Scoring an uncalled match with courts reserved.
  if new.status = 'completed' and old.status is distinct from 'completed' and old.called_at is null then
    select id, status, created_by into v_t from public.tournaments where id = new.tournament_id;
    if v_t.status = 'active' and public._pl_tm_has_courts(new.tournament_id) then
      v_host := v_t.created_by = v_uid or exists (
        select 1 from public.tournament_registrations tr
         where tr.tournament_id = new.tournament_id and tr.user_id = v_uid
           and tr.status = 'approved' and tr.role in ('admin', 'co-admin'));
      if not v_host then
        raise exception 'PL_TM_NOT_CALLED: This match has not been called to a court yet. You will get a push when it is your turn; the host can score it early.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._pl_tm_court_guard() from public, anon, authenticated;

drop trigger if exists trg_tm_court_guard on public.tournament_matches;
create trigger trg_tm_court_guard
  before insert or update on public.tournament_matches
  for each row execute function public._pl_tm_court_guard();


-- ── Triggers that run the queue and the bye alerts ─────────────────────────
-- A match completed or cancelled: free its court, call the next. Sorts before
-- trg_tm_score_notices, so "Up next" already knows the new calls.
create or replace function public._pl_tm_court_queue_on_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('completed', 'cancelled') and old.status is distinct from new.status then
    perform public._pl_tm_call_next(new.tournament_id, true);
  end if;
  return null;
end $$;
revoke all on function public._pl_tm_court_queue_on_match() from public, anon, authenticated;

drop trigger if exists trg_tm_court_queue on public.tournament_matches;
create trigger trg_tm_court_queue
  after update of status on public.tournament_matches
  for each row execute function public._pl_tm_court_queue_on_match();

-- Bye this round: after the score notices (name sorts after trg_tm_score_notices).
create or replace function public._pl_tm_bye_on_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('completed', 'cancelled') and old.status is distinct from new.status then
    begin
      perform public._pl_tm_bye_notices(new.id);
    exception when others then
      raise warning 'bye notices failed for %: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end $$;
revoke all on function public._pl_tm_bye_on_match() from public, anon, authenticated;

drop trigger if exists trg_tm_zz_bye_notices on public.tournament_matches;
create trigger trg_tm_zz_bye_notices
  after update of status on public.tournament_matches
  for each row execute function public._pl_tm_bye_on_match();

-- New matches in an active tournament (a playoff drawn): call at commit.
create or replace function public._pl_tm_court_queue_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._pl_tm_call_next(new.tournament_id, true);
  return null;
end $$;
revoke all on function public._pl_tm_court_queue_on_insert() from public, anon, authenticated;

drop trigger if exists trg_tm_court_queue_insert on public.tournament_matches;
create constraint trigger trg_tm_court_queue_insert
  after insert on public.tournament_matches
  deferrable initially deferred
  for each row execute function public._pl_tm_court_queue_on_insert();

-- The tournament goes active (lock-in) or its courts change. Lock-in calls
-- quietly: the first-match notice (trg_tournament_status_notices, which
-- sorts after this one) says who is on which court.
create or replace function public._pl_tm_court_queue_on_tournament()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    perform public._pl_tm_call_next(new.id, false);
  elsif new.status = 'active' and new.courts is distinct from old.courts then
    perform public._pl_tm_call_next(new.id, true);
  end if;
  return null;
end $$;
revoke all on function public._pl_tm_court_queue_on_tournament() from public, anon, authenticated;

drop trigger if exists trg_tournament_courts_call on public.tournaments;
create trigger trg_tournament_courts_call
  after update of status, courts on public.tournaments
  for each row execute function public._pl_tm_court_queue_on_tournament();
