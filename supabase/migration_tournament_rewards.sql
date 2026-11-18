-- ============================================================
-- PKL-042: tournament rewards (Brian's picks, 2026-11-18).
--
--   1. Placement pay: 1st 150, 2nd 100, 3rd 100, 4th and below 0 pickles,
--      to every player at that place (both doubles partners).
--   2. It scales with field size: x players/8, clamped to [1, 2], rounded to
--      a whole pickle (x1 at 8 players, x1.5 at 12, x2 at 16 or more).
--      Field size = approved registrants (players, not teams).
--   3. Placement pay is OUTSIDE the 500/day play cap. "Tournament played"
--      (+50, _grant_tournament_participation_bonus) and match pay stay inside.
--   4. Tournament matches pay the normal match curve.
--   "Tournament played" stays 50; no per-win bonus. The real-play guard
--   (_pl_tournament_real_play: 4+ approved players who played) and
--   once-only grants are kept.
--
-- Before:
--   - The only placement pay was the podium badge (Tournament Champion /
--     Silver / Bronze, flat 150 each, inside the cap, _grant_pickles_on_badge
--     in migration_pickle_economy_guards.sql). Those badges are awarded only
--     by auto_payout_tournament, which an admin runs by hand and which needs
--     a prize pool, so a tournament with no pot paid no placement at all
--     (the PKL-034 run).
--   - Match pay (_grant_match_game_bonus, migration_fair_rewards.sql) is a
--     trigger on public.matches only. PKL-035 does NOT write tournament
--     matches into public.matches (that would also fire ~25 other match
--     triggers: badges, streaks, court bonuses, wagers, confirm flow), so
--     tournament matches would still pay nothing without item 4 below.
--
-- This file:
--   1. tournament_placement_grants (one row per tournament and player) and
--      _pl_placement_pay(place, players).
--   2. _grant_tournament_placement_pay: AFTER UPDATE OF status on
--      tournaments, when it becomes completed. Named to fire after
--      trg_settle_wagers_tournament (which computes the final ranks; AFTER
--      triggers fire in name order) and before trg_tournament_status_notices
--      (PKL-036), whose "you finished Nth" notice reports the pay. If the
--      ranks are missing (settle rolled back) it computes them. Not in the
--      play-cap source lists, so the cap trigger leaves it alone.
--   3. _grant_pickles_on_badge: a podium badge no longer pays pickles for a
--      tournament that already paid placement (it would pay twice); for a
--      tournament without a placement grant (completed before this file) it
--      pays as before.
--   4. tournament_match_bonus_grants and _grant_tournament_match_bonus: the
--      match curve for a completed tournament match, for every player on it
--      (all 4 in doubles). The day's count and the "3 per exact group in
--      12 hours" rule count league AND tournament matches together;
--      _grant_match_game_bonus is re-issued to count tournament matches too,
--      so the curve is one curve. Inside the cap. No separate push: the
--      PKL-036 score notice carries the amount.
--   5. The play-cap lists (_pl_play_cap_left, _pl_profiles_play_cap) add
--      _grant_tournament_match_bonus; pickle_ledger_sources labels both new
--      sources.
-- Re-runnable.
-- Apply after migration_tournament_staged_placement.sql:
--   supabase db query --linked -f supabase/migration_tournament_rewards.sql
-- Test: state/pkl-035-036-037-test.sql (begin ... rollback).
-- ============================================================


-- ── 1. Placement pay table and amount ───────────────────────────────────────
create table if not exists public.tournament_placement_grants (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  place         integer not null,
  players       integer not null,
  paid          integer not null,
  granted_at    timestamptz not null default now(),
  primary key (tournament_id, user_id)
);
alter table public.tournament_placement_grants enable row level security;
drop policy if exists "Own placement grants" on public.tournament_placement_grants;
create policy "Own placement grants" on public.tournament_placement_grants
  for select using (user_id = auth.uid());
revoke all on table public.tournament_placement_grants from anon;
grant select on table public.tournament_placement_grants to authenticated;

create or replace function public._pl_placement_pay(p_place integer, p_players integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select round(
           (case p_place when 1 then 150 when 2 then 100 when 3 then 100 else 0 end)
           * least(2.0, greatest(1.0, coalesce(p_players, 0)::numeric / 8.0))
         )::integer
$$;
revoke all on function public._pl_placement_pay(integer, integer) from public, anon, authenticated;


-- ── 2. Pay placement when a tournament completes ────────────────────────────
create or replace function public._grant_tournament_placement_pay()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_players integer;
  v_row     record;
  v_pay     integer;
  v_rows    integer;
begin
  if new.status <> 'completed' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'completed' then return new; end if;
  begin
    if not public._pl_tournament_real_play(new.id) then return new; end if;
    if not exists (select 1 from public.tournament_final_ranks where tournament_id = new.id) then
      perform public.compute_tournament_final_ranks(new.id);
    end if;

    select count(*)::int into v_players
      from public.tournament_registrations
     where tournament_id = new.id and status = 'approved' and user_id is not null;

    for v_row in
      select fr.user_id, fr.final_rank
        from public.tournament_final_ranks fr
        join public.tournament_registrations tr
          on tr.tournament_id = fr.tournament_id and tr.user_id = fr.user_id and tr.status = 'approved'
       where fr.tournament_id = new.id and fr.final_rank between 1 and 3
    loop
      begin
        v_pay := public._pl_placement_pay(v_row.final_rank, v_players);
        insert into public.tournament_placement_grants (tournament_id, user_id, place, players, paid)
        values (new.id, v_row.user_id, v_row.final_rank, v_players, v_pay)
        on conflict (tournament_id, user_id) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 and v_pay > 0 then
          update public.profiles set pickles = coalesce(pickles, 0) + v_pay where id = v_row.user_id;
        end if;
      exception when others then
        raise warning 'placement pay failed for % in %: %', v_row.user_id, new.id, sqlerrm;
      end;
    end loop;
  exception when others then
    raise warning 'placement pay skipped for tournament %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._grant_tournament_placement_pay() from public, anon, authenticated;

drop trigger if exists trg_tournament_placement_pay on public.tournaments;
create trigger trg_tournament_placement_pay
  after update of status on public.tournaments
  for each row execute function public._grant_tournament_placement_pay();


-- ── 3. Podium badges don't pay twice ────────────────────────────────────────
-- As in migration_pickle_economy_guards.sql (= live copy, 2026-11-18), plus
-- the placement-grant check for the three tournament podium badges.
create or replace function public._grant_pickles_on_badge()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_badge_name text;
  v_comp       boolean;
  v_key        text;
  v_real       boolean;
  v_tid        uuid;
  v_pay        integer;
  v_rows       integer;
begin
  if current_setting('pickleague.skip_badge_pickle_grant', true) = 'on' then
    return new;
  end if;

  select name into v_badge_name from public.badges where id = new.badge_id;
  if v_badge_name is null then return new; end if;

  -- Competitions pay only with real play, everything once (migration_pickle_economy_guards.sql §2).
  v_comp := v_badge_name in ('Period Champion', 'Period Sweeper', 'Season Crown', 'Season Silver',
                             'Season Bronze', 'Tournament Champion', 'Tournament Silver', 'Tournament Bronze');
  if v_comp then
    v_key := coalesce(new.league_id::text, '') || '|' || coalesce(new.context, '');
    if new.league_id is not null then
      v_real := public._pl_league_real_play(new.league_id);
    else
      -- A podium badge: the payout wrote this player's champion row just before.
      select tcb.tournament_id into v_tid
        from public.tournament_champion_badges tcb
       where tcb.user_id = new.user_id
       order by tcb.awarded_at desc nulls last
       limit 1;
      v_real := v_tid is not null and public._pl_tournament_real_play(v_tid);
      -- PKL-042: placement was already paid when the tournament completed.
      if v_real and v_badge_name in ('Tournament Champion', 'Tournament Silver', 'Tournament Bronze')
         and exists (select 1 from public.tournament_placement_grants g
                      where g.tournament_id = v_tid and g.user_id = new.user_id) then
        return new;
      end if;
    end if;
    if not coalesce(v_real, false) then return new; end if;
  else
    v_key := '';
  end if;

  v_pay := least(150, public._pl_play_cap_left(new.user_id));
  insert into public.pickle_badge_payouts (user_id, badge_id, scope_key, paid)
  values (new.user_id, new.badge_id, v_key, v_pay)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 or v_pay <= 0 then return new; end if;

  update public.profiles set pickles = coalesce(pickles, 0) + v_pay where id = new.user_id;

  begin
    perform public._notify_user(
      new.user_id,
      format('🥒 +%s pickles for earning %s!', v_pay, v_badge_name),
      format('You received %s 🥒 for earning the %s badge. Tap to see your shop balance.', v_pay, v_badge_name),
      new.user_id,
      'shop'
    );
  exception when others then null;
  end;

  return new;
end;
$function$;
revoke all on function public._grant_pickles_on_badge() from public, anon, authenticated;


-- ── 4. Match pay for tournament matches ─────────────────────────────────────
create table if not exists public.tournament_match_bonus_grants (
  match_id   uuid not null references public.tournament_matches(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  games      integer not null,
  paid       integer not null,
  granted_at timestamptz not null default now(),
  primary key (match_id, user_id)
);
alter table public.tournament_match_bonus_grants enable row level security;
drop policy if exists "Own tournament match pay" on public.tournament_match_bonus_grants;
create policy "Own tournament match pay" on public.tournament_match_bonus_grants
  for select using (user_id = auth.uid());
revoke all on table public.tournament_match_bonus_grants from anon;
grant select on table public.tournament_match_bonus_grants to authenticated;
create index if not exists idx_tm_bonus_grants_user_time
  on public.tournament_match_bonus_grants (user_id, granted_at desc);

-- How many paid matches (league or tournament) this player has today, not
-- counting p_skip_match. Shared by both pay triggers.
create or replace function public._pl_paid_matches_today(p_uid uuid, p_skip_match uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with b as (
    select ((now() at time zone public._pickleague_tz_for(p_uid))::date)::timestamp
             at time zone public._pickleague_tz_for(p_uid) as day_start
  )
  select (
    (select count(*) from public.match_game_bonus_grants g, b
      where g.user_id = p_uid and g.match_id is distinct from p_skip_match
        and coalesce(g.paid, 25 * g.games) > 0 and g.granted_at >= b.day_start)
  + (select count(*) from public.tournament_match_bonus_grants g, b
      where g.user_id = p_uid and g.match_id is distinct from p_skip_match
        and g.paid > 0 and g.granted_at >= b.day_start)
  )::integer
$$;
revoke all on function public._pl_paid_matches_today(uuid, uuid) from public, anon, authenticated;

-- How many paid matches with exactly this player set (sorted ids) this player
-- has within 12 hours of p_at, league and tournament together.
create or replace function public._pl_paid_group_matches(p_uid uuid, p_players uuid[], p_at timestamptz, p_skip_match uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (
    (select count(*)
       from public.match_game_bonus_grants g
       join public.matches x on x.id = g.match_id
      where g.user_id = p_uid and g.match_id is distinct from p_skip_match
        and coalesce(x.played_at, x.created_at) between p_at - interval '12 hours' and p_at + interval '12 hours'
        and (select array_agg(u order by u)
               from unnest(array[x.player1_id, x.partner1_id, x.player2_id, x.partner2_id]) as u
              where u is not null) = p_players
        and coalesce(g.paid, 25 * g.games) > 0)
  + (select count(*)
       from public.tournament_match_bonus_grants g
       join public.tournament_matches x on x.id = g.match_id
      where g.user_id = p_uid and g.match_id is distinct from p_skip_match
        and coalesce(x.completed_at, g.granted_at) between p_at - interval '12 hours' and p_at + interval '12 hours'
        and (select array_agg(u order by u)
               from unnest(array[x.team1_player1, x.team1_player2, x.team2_player1, x.team2_player2]) as u
              where u is not null) = p_players
        and g.paid > 0)
  )::integer
$$;
revoke all on function public._pl_paid_group_matches(uuid, uuid[], timestamptz, uuid) from public, anon, authenticated;

create or replace function public._grant_tournament_match_bonus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid;
  v_games   integer;
  v_bonus   integer;
  v_rows    integer;
  v_players uuid[];
  v_n       integer;
begin
  if new.status <> 'completed' or new.winner_team is null
     or new.team1_player1 is null or new.team2_player1 is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'completed' then return new; end if;

  v_games := least(greatest(coalesce(jsonb_array_length(new.game_scores), 1), 1), 5);
  select array_agg(u order by u) into v_players
    from unnest(array[new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2]) as u
   where u is not null;

  foreach v_uid in array v_players loop
    begin
      -- The same curve as _grant_match_game_bonus: 40 for the day's first 3
      -- paid matches (league or tournament), then 35, 30, ... 5, then 0.
      v_n := public._pl_paid_matches_today(v_uid, new.id) + 1;
      v_bonus := case when v_n <= 3 then 40 else greatest(40 - 5 * (v_n - 3), 0) end;
      if public._pl_paid_group_matches(v_uid, v_players, coalesce(new.completed_at, now()), new.id) >= 3 then
        v_bonus := 0;
      end if;
      v_bonus := greatest(least(v_bonus, public._pl_play_cap_left(v_uid)), 0);

      insert into public.tournament_match_bonus_grants (match_id, user_id, games, paid)
      values (new.id, v_uid, v_games, v_bonus)
      on conflict (match_id, user_id) do nothing;
      get diagnostics v_rows = row_count;
      if v_rows > 0 and v_bonus > 0 then
        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;
      end if;
    exception when others then
      raise warning 'tournament match pay failed for % on %: %', v_uid, new.id, sqlerrm;
    end;
  end loop;
  return new;
end $$;
revoke all on function public._grant_tournament_match_bonus() from public, anon, authenticated;

-- 'trg_tm_match_pay' fires before 'trg_tm_score_notices' (PKL-036), which
-- reads the grant to put the amount in the score notice.
drop trigger if exists trg_tm_match_pay on public.tournament_matches;
create trigger trg_tm_match_pay
  after insert or update of status on public.tournament_matches
  for each row execute function public._grant_tournament_match_bonus();

-- League matches: as in migration_fair_rewards.sql (= live copy, 2026-11-18),
-- except the day's count and the group rule also count tournament matches.
create or replace function public._grant_match_game_bonus()
returns trigger language plpgsql security definer as $$
declare
  v_uid   uuid;
  v_games integer;
  v_bonus integer;
  v_rowcount integer;
  v_players uuid[];
  v_n     integer;
  v_group integer;
begin
  if coalesce(new.status, 'completed') <> 'completed' then return new; end if;

  v_games := least(greatest(coalesce(jsonb_array_length(new.game_scores), 1), 1), 5);

  select array_agg(u order by u) into v_players
    from unnest(array[new.player1_id, new.partner1_id, new.player2_id, new.partner2_id]) as u
   where u is not null;

  for v_uid in
    select distinct uid from (values
      (new.player1_id), (new.partner1_id), (new.player2_id), (new.partner2_id)
    ) as t(uid)
    where uid is not null
  loop
    begin
      -- The day's curve: this player's nth paid match today (league or
      -- tournament), whoever it's with. 1-3 pay 40, then 35 .. 5, 0 from the 12th.
      v_n := public._pl_paid_matches_today(v_uid, new.id) + 1;
      v_bonus := case when v_n <= 3 then 40 else greatest(40 - 5 * (v_n - 3), 0) end;

      -- Each exact group pays this player for at most 3 matches within 12 hours.
      v_group := public._pl_paid_group_matches(v_uid, v_players, coalesce(new.played_at, now()), new.id);
      if v_group >= 3 then v_bonus := 0; end if;
      v_bonus := greatest(least(v_bonus, public._pl_play_cap_left(v_uid)), 0);

      insert into public.match_game_bonus_grants(match_id, user_id, games, paid)
        values (new.id, v_uid, v_games, v_bonus)
        on conflict (match_id, user_id) do nothing;
      get diagnostics v_rowcount = row_count;
      if v_rowcount > 0 and v_bonus > 0 then
        update public.profiles set pickles = coalesce(pickles, 0) + v_bonus where id = v_uid;
        begin
          perform public._notify_user(
            v_uid,
            format('🥒 +%s pickles for your match!', v_bonus),
            case when v_n <= 3
                 then format('You earned %s 🥒 for playing. Your first 3 matches each day pay the most.', v_bonus)
                 else format('You earned %s 🥒 for playing. Each match today pays a little less; tomorrow starts at 40 again.', v_bonus) end,
            v_uid,
            'shop'
          );
        exception when others then null;
        end;
      end if;
    exception when others then null;
    end;
  end loop;
  return new;
end;
$$;
revoke all on function public._grant_match_game_bonus() from public, anon, authenticated;


-- ── 5. Play cap lists and ledger labels ─────────────────────────────────────
-- As in migration_place_stays.sql (the latest); '_grant_tournament_match_bonus'
-- joins both lists. '_grant_tournament_placement_pay' is deliberately absent.
create or replace function public._pl_play_cap_left(p_uid uuid)
returns integer
language plpgsql
volatile    -- sees the rows earlier grants of the same transaction wrote
security definer
set search_path = ''
as $$
declare
  v_tz    text := public._pickleague_tz_for(p_uid);
  v_start timestamptz := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  v_paid  integer;
begin
  select coalesce(sum(l.delta), 0)::integer into v_paid
    from public.pickle_ledger l
   where l.profile_id = p_uid
     and l.created_at >= v_start
     and l.delta > 0
     and l.source = any (array[
       '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
       '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review',
       '_grant_new_opponent_bonus', '_grant_checkin_match_bonus', '_pl_settle_place_stay',
       '_grant_tournament_match_bonus']);
  return greatest(500 - v_paid, 0);
end $$;
revoke execute on function public._pl_play_cap_left(uuid) from public, anon, authenticated;

create or replace function public._pl_profiles_play_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src  text;
  v_left integer;
begin
  if coalesce(new.pickles, 0) <= coalesce(old.pickles, 0) then
    return new;
  end if;
  begin
    v_src := public._pl_play_source();
    if v_src = any (array[
         '_grant_match_game_bonus', '_grant_daily_streak_bonus', '_grant_court_bonus',
         '_grant_pickles_on_badge', '_grant_tournament_participation_bonus', 'submit_drill_review',
         '_grant_new_opponent_bonus', '_grant_checkin_match_bonus', '_pl_settle_place_stay',
         '_grant_tournament_match_bonus']) then
      v_left := public._pl_play_cap_left(new.id);
      if new.pickles - coalesce(old.pickles, 0) > v_left then
        new.pickles := coalesce(old.pickles, 0) + v_left;
      end if;
    end if;
  exception when others then
    raise warning 'play cap: left a % pickles raise on profile % unchecked (%: %)',
      new.pickles - coalesce(old.pickles, 0), new.id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public._pl_profiles_play_cap() from public, anon, authenticated;

insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  ('_grant_tournament_match_bonus',   1, 'Tournament match played', 'earn', 'match',      false, 'pay per tournament match, the match curve, inside the daily cap'),
  ('_grant_tournament_placement_pay', 1, 'Tournament placement',    'earn', 'tournament', false, 'pay for finishing 1st to 3rd, scaled by field size, outside the daily cap')
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;

notify pgrst, 'reload schema';
