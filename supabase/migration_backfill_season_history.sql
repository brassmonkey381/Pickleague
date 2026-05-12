-- ============================================================
-- backfill_season_history(season_id)
--
-- Idempotently fills in:
--   * One season_snapshots row per (member, period) for periods 1..N
--   * One season_final_standings row per member, ranked by median period rank
--
-- Use this when you have match history but no standings yet (e.g. an
-- existing season that pre-dated the lock-in workflow).
--
-- Differences vs. calling lock_season_period in a loop:
--   * Does NOT touch league_player_ratings (no PLUPR soft-resets between
--     periods).  Running it twice is safe.
--   * Does NOT update league_seasons.elo_reset_applied — the season can
--     still be "live-completed" later via complete_season if desired.
--   * Idempotent: wipes existing snapshots + final standings for the
--     season at the top so re-runs always produce the same output.
--
-- Ranking matches the production sort:
--   league PLUPR desc → (wins - losses) desc → wins desc.
-- ============================================================

create or replace function public.backfill_season_history(p_season_id uuid)
returns table (period_number integer, snapshot_date date, ranked_players integer)
language plpgsql security definer as $$
declare
  v_league_id            uuid;
  v_season_name          text;
  v_start                date;
  v_total_periods        integer;
  v_lock_freq_weeks      integer;
  v_uid                  uuid := auth.uid();
  v_p                    integer;
  v_snapshot             date;
  v_rec                  record;
  v_rank                 integer;
  v_period_count         integer;
  v_inserted_for_period  integer;
  v_final_rank           integer;
begin
  -- Look up season
  select league_id, name, start_date, total_periods, lock_frequency_weeks
    into v_league_id, v_season_name, v_start, v_total_periods, v_lock_freq_weeks
    from public.league_seasons
   where id = p_season_id;
  if v_league_id is null then raise exception 'Season not found'; end if;

  -- Permission: must be league admin/co-admin OR godmode
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not (
    public.is_godmode_user()
    or exists (
      select 1 from public.league_members
       where league_id = v_league_id and user_id = v_uid
         and role in ('admin','co-admin')
    )
  ) then
    raise exception 'Only league admins/co-admins (or godmode) can backfill season standings';
  end if;

  -- Idempotency: wipe existing snapshots + final standings for THIS season
  delete from public.season_final_standings where season_id = p_season_id;
  delete from public.season_snapshots        where season_id = p_season_id;

  -- ── Snapshot each period ──────────────────────────────────────
  for v_p in 1..v_total_periods loop
    v_snapshot := v_start + (v_p * v_lock_freq_weeks) * interval '7 days';
    v_rank := 0;
    v_inserted_for_period := 0;

    for v_rec in (
      with player_stats as (
        select
          lm.user_id,
          coalesce(lpr.rating, 3.250) as rating,
          coalesce(sum(case
            when (m.player1_id  = lm.user_id and m.winner_team = 'team1') or
                 (m.partner1_id = lm.user_id and m.winner_team = 'team1') or
                 (m.player2_id  = lm.user_id and m.winner_team = 'team2') or
                 (m.partner2_id = lm.user_id and m.winner_team = 'team2')
            then 1 else 0 end), 0) as wins,
          coalesce(sum(case
            when (m.player1_id  = lm.user_id and m.winner_team = 'team2') or
                 (m.partner1_id = lm.user_id and m.winner_team = 'team2') or
                 (m.player2_id  = lm.user_id and m.winner_team = 'team1') or
                 (m.partner2_id = lm.user_id and m.winner_team = 'team1')
            then 1 else 0 end), 0) as losses
        from public.league_members lm
        left join public.league_player_ratings lpr
          on  lpr.league_id = v_league_id
          and lpr.user_id   = lm.user_id
        left join public.matches m
          on  m.league_id   = v_league_id
          and coalesce(m.status, 'completed') = 'completed'
          and m.played_at::date between v_start and v_snapshot
          and (
            m.player1_id  = lm.user_id or m.partner1_id = lm.user_id or
            m.player2_id  = lm.user_id or m.partner2_id = lm.user_id
          )
        where lm.league_id = v_league_id
        group by lm.user_id, lpr.rating
      )
      select user_id, rating, wins, losses
        from player_stats
       order by rating desc nulls last,
                (wins - losses) desc,
                wins desc
    ) loop
      v_rank := v_rank + 1;
      insert into public.season_snapshots (
        season_id, league_id, period_number, snapshot_date,
        user_id, elo_at_snapshot, rank_at_snapshot, wins_in_season, losses_in_season
      ) values (
        p_season_id, v_league_id, v_p, v_snapshot,
        v_rec.user_id, v_rec.rating, v_rank, v_rec.wins, v_rec.losses
      );
      v_inserted_for_period := v_inserted_for_period + 1;
    end loop;

    period_number  := v_p;
    snapshot_date  := v_snapshot;
    ranked_players := v_inserted_for_period;
    return next;
  end loop;

  -- ── Final standings: median rank across the locked periods ───
  select count(distinct season_snapshots.period_number)
    into v_period_count
    from public.season_snapshots where season_id = p_season_id;

  if v_period_count > 0 then
    v_final_rank := 0;
    for v_rec in (
      with medians as (
        select user_id,
               percentile_cont(0.5) within group (order by rank_at_snapshot) as median_rank
          from public.season_snapshots
         where season_id = p_season_id
         group by user_id
      )
      select user_id, median_rank from medians order by median_rank asc
    ) loop
      v_final_rank := v_final_rank + 1;
      insert into public.season_final_standings (
        season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo
      ) values (
        p_season_id, v_league_id, v_rec.user_id,
        v_final_rank, v_rec.median_rank,
        -- We do NOT apply bonuses here — this is a historical view, not a
        -- live season-complete.  Use complete_season() if you want bonuses.
        0.000, 3.250
      );
    end loop;
  end if;
end;
$$;

grant execute on function public.backfill_season_history(uuid) to authenticated;
