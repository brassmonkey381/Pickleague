-- Seasons: "periods" read as "rounds", and the season-end bonus counts
-- toward overall PLUPR (Brian, 2026-11-03).
--
--   1. Rounds: the two round badges' descriptions say "round". Their names
--      stay 'Period Champion' / 'Period Sweeper' in the database (functions
--      look badges up by name); the app shows them as Round Champion /
--      Round Sweeper. The "Lock in at least one round" refusal is reworded.
--   2. Season-end bonus on overall PLUPR: the top 5's bonus (0.20 / 0.15 /
--      0.10 / 0.05 / 0.02) still resets League PLUPR as before, and is now
--      also ADDED to overall PLUPR (profiles.rating) when the season had 8+
--      ranked players and the player has 10+ completed league matches inside
--      the season's dates. Guards against farming via tiny leagues. Stored
--      on season_final_standings.overall_bonus (0 when not paid).
--      Runs once per season: elo_reset_applied (FOR UPDATE) still stops a
--      second completion. Seasons already completed are not paid back.
--
-- _complete_season_unchecked is migration_auto_complete_seasons.sql's with
-- those changes; complete_season and the hourly job call it unchanged.
-- Re-runnable.

-- ── 1. Round badges' descriptions ─────────────────────────────────────────
update public.badges set description = 'Finished #1 in a single locked-in round of a season.'
 where name = 'Period Champion';
update public.badges set description = 'Finished #1 in every locked-in round of a single season.'
 where name = 'Period Sweeper';

-- ── 2. Where the overall bonus is recorded ────────────────────────────────
alter table public.season_final_standings
  add column if not exists overall_bonus numeric(4,2) not null default 0;

-- ── 3. The body: as migration_auto_complete_seasons.sql, plus the bonus ───
create or replace function public._complete_season_unchecked(
  p_season_id   uuid,
  p_apply_reset boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_baseline     numeric(4,2);
  v_reset_done   boolean;
  v_period_count integer;
  v_player       record;
  v_rank         integer := 0;
  v_bonus        numeric(4,2);
  v_new_plupr    numeric(5,2);
  v_badge        text;
  v_season_start date;
  v_season_end   date;
  v_players      integer;
  v_overall      numeric(4,2);
begin
  -- FOR UPDATE: a second caller (the admin's button and the hourly job at
  -- once) waits here, then reads elo_reset_applied = true and stops.
  select league_id, name, baseline_plupr, elo_reset_applied
    into v_league_id, v_season_name, v_baseline, v_reset_done
    from public.league_seasons
    where id = p_season_id
    for update;

  if v_league_id is null then
    raise exception 'Season not found';
  end if;

  if v_reset_done then
    raise exception 'ELO reset has already been applied for this season';
  end if;

  if not exists (select 1 from public.season_snapshots where season_id = p_season_id) then
    raise exception 'Lock in at least one round before completing the season';
  end if;

  select start_date, end_date into v_season_start, v_season_end
    from public.league_seasons where id = p_season_id;
  -- The overall bonus needs a real season: 8+ ranked players.
  select count(distinct user_id) into v_players
    from public.season_snapshots where season_id = p_season_id;

  select count(distinct period_number) into v_period_count
    from public.season_snapshots
    where season_id = p_season_id;

  for v_player in (
    with medians as (
      select
        user_id,
        percentile_cont(0.5) within group (order by rank_at_snapshot) as median_rank
      from public.season_snapshots
      where season_id = p_season_id
      group by user_id
    )
    select user_id, median_rank
      from medians
      order by median_rank asc
  ) loop
    v_rank  := v_rank + 1;
    v_bonus := case
      when v_rank = 1 then 0.20
      when v_rank = 2 then 0.15
      when v_rank = 3 then 0.10
      when v_rank = 4 then 0.05
      when v_rank = 5 then 0.02
      else 0
    end;
    v_new_plupr := v_baseline + v_bonus;

    -- The bonus also counts toward overall PLUPR (migration_season_rounds_and_bonus.sql):
    -- ADDED to profiles.rating, never set (a SET once wiped everyone's real
    -- rating), and only for a real season: 8+ ranked players, and 10+
    -- completed league matches by this player inside the season's dates.
    v_overall := 0;
    if v_bonus > 0 and v_players >= 8 and (
      select count(*) from public.matches m
       where m.league_id = v_league_id
         and m.status = 'completed'
         and v_player.user_id in (m.player1_id, m.partner1_id, m.player2_id, m.partner2_id)
         and coalesce(m.played_at, m.created_at)::date between v_season_start and v_season_end
    ) >= 10 then
      v_overall := v_bonus;
      update public.profiles set rating = rating + v_overall where id = v_player.user_id;
    end if;

    insert into public.season_final_standings (
      season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo, overall_bonus
    ) values (
      p_season_id, v_league_id, v_player.user_id,
      v_rank, v_player.median_rank, v_bonus, v_new_plupr, v_overall
    ) on conflict (season_id, user_id) do update
      set final_rank    = excluded.final_rank,
          median_rank   = excluded.median_rank,
          elo_bonus     = excluded.elo_bonus,
          new_elo       = excluded.new_elo,
          overall_bonus = excluded.overall_bonus;

    -- LEAGUE-scoped end-of-season soft reset. Mirrors the period-lock reset
    -- across every rating facet; global profiles.rating is untouched.
    -- Skipped when p_apply_reset is false: the league ratings stay where the
    -- league's matches left them (new_elo above is still the PLUPR the final
    -- standings show).
    if p_apply_reset then
      update public.league_player_ratings
         set rating               = v_new_plupr,
             singles_rating       = v_new_plupr,
             doubles_rating       = v_new_plupr,
             mixed_doubles_rating = v_new_plupr,
             updated_at           = now()
       where league_id = v_league_id and user_id = v_player.user_id;
    end if;

    v_badge := case v_rank
      when 1 then 'Season Crown'
      when 2 then 'Season Silver'
      when 3 then 'Season Bronze'
      else null end;
    if v_badge is not null then
      perform public.award_league_badge(
        v_player.user_id, v_league_id, v_badge, v_season_name
      );
    end if;

    if exists (
      select 1
      from   public.season_snapshots
      where  season_id = p_season_id
        and  user_id   = v_player.user_id
      group  by user_id
      having count(*) filter (where rank_at_snapshot = 1) = count(*)
         and count(*) >= 1
    ) then
      perform public.award_league_badge(
        v_player.user_id, v_league_id, 'Period Sweeper', v_season_name
      );
    end if;
  end loop;

  -- elo_reset_applied is the "already completed" guard (checked above; the
  -- app hides the Complete button on it): true whether or not the reset ran.
  update public.league_seasons
  set status = 'completed', elo_reset_applied = true
  where id = p_season_id;
end;
$$;
revoke execute on function public._complete_season_unchecked(uuid, boolean) from public, anon, authenticated;
grant execute on function public._complete_season_unchecked(uuid, boolean) to service_role;

notify pgrst, 'reload schema';
