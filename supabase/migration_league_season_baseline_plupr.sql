-- ============================================================
-- league_seasons.baseline_plupr — soft-reset target for each season
--
-- Bug: `lock_season_period` and `complete_season` reset members'
-- `profiles.rating` to `1000 + bonus`. That was correct on the old
-- ELO scale; after the PLUPR conversion (3.0–5.0 typical range), it
-- catapults every member to ~1080. Seasons are effectively bricked
-- at the soft-reset step today.
--
-- Fix: store a per-season `baseline_plupr` (e.g. 4.5 for a 4.5 league).
-- The end-of-period reset becomes `baseline + plupr_bonus` where the
-- bonus is in PLUPR points, not ELO points.
--
-- Backfill: for every existing league_seasons row, parse the parent
-- `leagues.name` for a PLUPR-style number (e.g. "HUB 4.5 League" →
-- 4.5, "3.5 Sunday Pickleball" → 3.5). Fallback: 3.5.
--
-- Run AFTER:
--   migration_audit_fixes_2026q2.sql
-- (which contains the latest merged definitions of lock_season_period
--  and complete_season).
-- ============================================================


-- 1. Schema --------------------------------------------------------------
alter table public.league_seasons
  add column if not exists baseline_plupr numeric(4,2) not null default 3.5;

-- Guard against absurd baselines.
alter table public.league_seasons
  drop constraint if exists league_seasons_baseline_plupr_range;
alter table public.league_seasons
  add constraint league_seasons_baseline_plupr_range
  check (baseline_plupr between 2.00 and 6.50);


-- 2. Backfill from league names ------------------------------------------
--    Try the "X.Y" pattern first (most specific), then the bare integer.
--    Anything that doesn't parse stays at the 3.5 default.
update public.league_seasons ls
   set baseline_plupr = case
     when fractional.match is not null
          and fractional.match::numeric between 2.00 and 6.50
       then fractional.match::numeric
     when whole.match is not null
          and whole.match::numeric between 2 and 6
       then whole.match::numeric
     else baseline_plupr  -- keep the default
   end
  from public.leagues l,
       lateral (select (regexp_match(l.name, '([2-6]\.[0-9])'))[1] as match) fractional,
       lateral (select (regexp_match(l.name, '\m([2-6])\M'))[1]      as match) whole
 where ls.league_id = l.id;


-- 3. Rewrite lock_season_period to use baseline_plupr --------------------
--    PLUPR bonuses for the top-5 finishers (in PLUPR points, not ELO):
--      Rank 1 → +0.20
--      Rank 2 → +0.15
--      Rank 3 → +0.10
--      Rank 4 → +0.05
--      Rank 5 → +0.02
--    Everyone else snaps clean to the baseline.
--    Only the OVERALL `rating` column is reset; split ratings preserved.
--    Prior-champion badge revoke logic preserved from the merged audit version.
create or replace function public.lock_season_period(
  p_season_id     uuid,
  p_period_number integer,
  p_snapshot_date date
)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_season_start date;
  v_baseline     numeric(4,2);
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        numeric(4,2);
  v_new_plupr    numeric(5,2);
begin
  select league_id, name, start_date, baseline_plupr
  into   v_league_id, v_season_name, v_season_start, v_baseline
  from   public.league_seasons
  where  id = p_season_id;

  if v_league_id is null then
    raise exception 'Season not found';
  end if;

  if not exists (
    select 1 from public.league_members
    where  league_id = v_league_id
      and  user_id   = auth.uid()
      and  role in ('admin', 'co-admin')
  ) then
    raise exception 'Only admins and co-admins can lock season standings';
  end if;

  delete from public.season_snapshots
  where  season_id     = p_season_id
    and  period_number = p_period_number;

  for v_rec in (
    with player_stats as (
      select
        lm.user_id,
        p.rating,
        coalesce(sum(
          case
            when (m.player1_id  = lm.user_id and m.winner_team = 'team1') or
                 (m.partner1_id = lm.user_id and m.winner_team = 'team1') or
                 (m.player2_id  = lm.user_id and m.winner_team = 'team2') or
                 (m.partner2_id = lm.user_id and m.winner_team = 'team2')
            then 1 else 0 end
        ), 0) as wins,
        coalesce(sum(
          case
            when (m.player1_id  = lm.user_id and m.winner_team = 'team2') or
                 (m.partner1_id = lm.user_id and m.winner_team = 'team2') or
                 (m.player2_id  = lm.user_id and m.winner_team = 'team1') or
                 (m.partner2_id = lm.user_id and m.winner_team = 'team1')
            then 1 else 0 end
        ), 0) as losses
      from public.league_members lm
      join public.profiles p on p.id = lm.user_id
      left join public.matches m
        on  m.league_id  = v_league_id
        and m.played_at::date between v_season_start and p_snapshot_date
        and (
          m.player1_id  = lm.user_id or m.partner1_id = lm.user_id or
          m.player2_id  = lm.user_id or m.partner2_id = lm.user_id
        )
      where lm.league_id = v_league_id
      group by lm.user_id, p.rating
    )
    select user_id, rating, wins, losses
    from   player_stats
    order  by wins desc, rating desc
  ) loop
    v_rank := v_rank + 1;
    insert into public.season_snapshots (
      season_id, league_id, period_number, snapshot_date,
      user_id, elo_at_snapshot, rank_at_snapshot, wins_in_season, losses_in_season
    ) values (
      p_season_id, v_league_id, p_period_number, p_snapshot_date,
      v_rec.user_id, v_rec.rating, v_rank, v_rec.wins, v_rec.losses
    );

    if v_rank = 1 then
      delete from public.player_badges
      where  badge_id  = (select id from public.badges where name = 'Period Champion')
        and  league_id = v_league_id
        and  context   = format('%s — Period %s', v_season_name, p_period_number);

      perform public.award_league_badge(
        v_rec.user_id, v_league_id, 'Period Champion',
        format('%s — Period %s', v_season_name, p_period_number)
      );
    end if;

    v_bonus := case
      when v_rank = 1 then 0.20
      when v_rank = 2 then 0.15
      when v_rank = 3 then 0.10
      when v_rank = 4 then 0.05
      when v_rank = 5 then 0.02
      else 0
    end;
    v_new_plupr := v_baseline + v_bonus;
    update public.profiles
       set rating = v_new_plupr
     where id = v_rec.user_id;
  end loop;

  update public.league_seasons
  set status = 'active'
  where id = p_season_id and status = 'upcoming';
end;
$$;


-- 4. Rewrite complete_season similarly -----------------------------------
create or replace function public.complete_season(p_season_id uuid)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_baseline     numeric(4,2);
  v_period_count integer;
  v_player       record;
  v_rank         integer := 0;
  v_bonus        numeric(4,2);
  v_new_plupr    numeric(5,2);
  v_badge        text;
begin
  select league_id, name, baseline_plupr
    into v_league_id, v_season_name, v_baseline
    from public.league_seasons
    where id = p_season_id;

  if v_league_id is null then
    raise exception 'Season not found';
  end if;

  if not exists (
    select 1 from public.league_members
    where  league_id = v_league_id
      and  user_id   = auth.uid()
      and  role in ('admin', 'co-admin')
  ) then
    raise exception 'Only admins and co-admins can complete a season';
  end if;

  if (select elo_reset_applied from public.league_seasons where id = p_season_id) then
    raise exception 'ELO reset has already been applied for this season';
  end if;

  if not exists (select 1 from public.season_snapshots where season_id = p_season_id) then
    raise exception 'Lock in at least one period before completing the season';
  end if;

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

    insert into public.season_final_standings (
      season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo
    ) values (
      p_season_id, v_league_id, v_player.user_id,
      v_rank, v_player.median_rank, v_bonus, v_new_plupr
    ) on conflict (season_id, user_id) do update
      set final_rank  = excluded.final_rank,
          median_rank = excluded.median_rank,
          elo_bonus   = excluded.elo_bonus,
          new_elo     = excluded.new_elo;

    update public.profiles
       set rating = v_new_plupr
     where id = v_player.user_id;

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

    -- Period Sweeper: every snapshot the player appears in was rank 1.
    -- Late joiners with all-rank-1 partial coverage still qualify.
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

  update public.league_seasons
  set status = 'completed', elo_reset_applied = true
  where id = p_season_id;
end;
$$;


-- 5. Grants --------------------------------------------------------------
grant execute on function public.lock_season_period(uuid, integer, date) to authenticated;
grant execute on function public.complete_season(uuid)                  to authenticated;

notify pgrst, 'reload schema';
