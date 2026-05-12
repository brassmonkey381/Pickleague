-- ============================================================
-- Auto-lock season periods at 11:59pm on the day the period ends.
--
-- Approach:
--   1. Extract the body of lock_season_period into an internal "_unchecked"
--      variant that skips the auth.uid() admin check.
--   2. Keep the public lock_season_period auth-gated for manual lock-ins.
--   3. New auto_lock_due_periods() walks every active season, finds
--      periods whose snapshot date is in the past AND whose snapshot
--      rows don't already exist, and locks each one.
--   4. pg_cron schedule runs auto_lock_due_periods() once an hour. Since
--      lock_season_period is idempotent (delete then re-insert snapshots
--      for that period), re-runs are safe — but the "no snapshot exists"
--      precheck means we don't redundantly bonus-reset league PLUPRs.
--
-- Requires: pg_cron extension enabled in the Supabase project (it's
-- pre-installed on Supabase; this just runs `create extension if not exists`).
-- ============================================================

create extension if not exists pg_cron;


-- 1. Internal: same logic as lock_season_period but no auth check.
-- ----------------------------------------------------------------------
create or replace function public._lock_season_period_unchecked(
  p_season_id     uuid,
  p_period_number integer,
  p_snapshot_date date
)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_season_start date;
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        decimal;
  v_new_rating   decimal;
begin
  select league_id, name, start_date
    into v_league_id, v_season_name, v_season_start
    from public.league_seasons
   where id = p_season_id;
  if v_league_id is null then raise exception 'Season not found'; end if;

  delete from public.season_snapshots
   where season_id = p_season_id and period_number = p_period_number;

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
        and m.played_at::date between v_season_start and p_snapshot_date
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
      p_season_id, v_league_id, p_period_number, p_snapshot_date,
      v_rec.user_id, v_rec.rating, v_rank, v_rec.wins, v_rec.losses
    );

    if v_rank = 1 then
      perform public.award_league_badge(
        v_rec.user_id, v_league_id, 'Period Champion',
        format('%s — Period %s', v_season_name, p_period_number)
      );
    end if;

    -- Period-end soft reset to LEAGUE PLUPR base + bonus (global is untouched).
    v_bonus := case
      when v_rank = 1 then 0.400
      when v_rank = 2 then 0.275
      when v_rank = 3 then 0.175
      when v_rank = 4 then 0.100
      when v_rank = 5 then 0.050
      else 0.000
    end;
    v_new_rating := 3.250 + v_bonus;
    update public.league_player_ratings
       set rating               = v_new_rating,
           singles_rating       = v_new_rating,
           doubles_rating       = v_new_rating,
           mixed_doubles_rating = v_new_rating,
           updated_at           = now()
     where league_id = v_league_id and user_id = v_rec.user_id;
  end loop;

  update public.league_seasons
     set status = 'active'
   where id = p_season_id and status = 'upcoming';
end;
$$;


-- 2. Public lock_season_period: keeps the auth check; delegates to _unchecked.
-- ----------------------------------------------------------------------
create or replace function public.lock_season_period(
  p_season_id     uuid,
  p_period_number integer,
  p_snapshot_date date
)
returns void language plpgsql security definer as $$
declare
  v_league_id uuid;
begin
  select league_id into v_league_id from public.league_seasons where id = p_season_id;
  if v_league_id is null then raise exception 'Season not found'; end if;

  if not exists (
    select 1 from public.league_members
     where league_id = v_league_id and user_id = auth.uid()
       and role in ('admin','co-admin')
  ) then
    raise exception 'Only admins and co-admins can lock season standings';
  end if;

  perform public._lock_season_period_unchecked(p_season_id, p_period_number, p_snapshot_date);
end;
$$;

grant execute on function public.lock_season_period(uuid, integer, date) to authenticated;


-- 3. The actual auto-lock walker.
--    Finds every (season, period) where snapshot_date <= today AND no
--    snapshots exist for that period, then locks it.
-- ----------------------------------------------------------------------
create or replace function public.auto_lock_due_periods()
returns integer language plpgsql security definer as $$
declare
  v_season       record;
  v_p            integer;
  v_snapshot     date;
  v_today        date := (now() at time zone 'UTC')::date;
  v_locked_count integer := 0;
begin
  for v_season in (
    select id, league_id, start_date, total_periods, lock_frequency_weeks
      from public.league_seasons
     where status in ('upcoming', 'active')
  ) loop
    for v_p in 1..v_season.total_periods loop
      v_snapshot := v_season.start_date + (v_p * v_season.lock_frequency_weeks) * interval '7 days';
      -- Has this period's end date already passed?
      continue when v_snapshot > v_today;
      -- Already locked?
      continue when exists (
        select 1 from public.season_snapshots
         where season_id = v_season.id and period_number = v_p
      );

      perform public._lock_season_period_unchecked(v_season.id, v_p, v_snapshot);
      v_locked_count := v_locked_count + 1;
    end loop;
  end loop;

  return v_locked_count;
end;
$$;

grant execute on function public.auto_lock_due_periods() to authenticated;


-- 4. pg_cron schedule: run hourly. Idempotent — only locks periods whose
--    end date has passed AND aren't already snapshotted. Hourly cadence
--    means a 1-hour worst-case latency between 11:59pm and the lock.
-- ----------------------------------------------------------------------
-- Drop any prior schedule before reinstalling.
do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'pickleague-auto-lock-periods';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end$$;

select cron.schedule(
  'pickleague-auto-lock-periods',
  '5 * * * *',                                -- every hour at :05
  $cmd$ select public.auto_lock_due_periods(); $cmd$
);
