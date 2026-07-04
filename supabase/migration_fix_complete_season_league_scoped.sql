-- CRITICAL (same class as the lock_season_period bug): complete_season did
-- "update profiles set rating = baseline + bonus" — completing a league
-- season OVERWROTE every member's GLOBAL PLUPR. Global ratings are fed by
-- every league, casual play and tournaments; one league's season ending
-- must not touch them. Found by the league marathon sweep while reading the
-- function to encode multi-season assertions.
--
-- The end-of-season soft reset now targets league_player_ratings (all
-- facets), exactly like _lock_season_period_unchecked's period reset.
-- Everything else is preserved: median-rank final standings, Season
-- Crown/Silver/Bronze + Period Sweeper badges, the elo_reset_applied
-- double-complete guard. service_role/godmode may also call it (sim/cron).

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
  ) and not public.is_godmode_user() and coalesce(auth.role(), '') <> 'service_role' then
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

    -- LEAGUE-scoped end-of-season soft reset (was: profiles.rating — see
    -- header). Mirrors the period-lock reset across every rating facet.
    update public.league_player_ratings
       set rating               = v_new_plupr,
           singles_rating       = v_new_plupr,
           doubles_rating       = v_new_plupr,
           mixed_doubles_rating = v_new_plupr,
           updated_at           = now()
     where league_id = v_league_id and user_id = v_player.user_id;

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

  update public.league_seasons
  set status = 'completed', elo_reset_applied = true
  where id = p_season_id;
end;
$$;
