-- ============================================================
-- Restore season_snapshots + season_final_standings (dropped at
-- some point outside the migration tree) and align the auto-lock
-- internal function with the staged baseline_plupr work.
--
-- Bug 1 (primary): the hourly pickleague-auto-lock-periods cron
--   has been failing every hour with:
--     ERROR:  relation "public.season_snapshots" does not exist
--   Both snapshot tables were missing from the DB.
--
-- Bug 2: _lock_season_period_unchecked still hard-codes 3.250 as
--   the soft-reset target and uses the old bonus scale. The newer
--   manual lock_season_period (from migration_league_season_baseline_plupr.sql)
--   already uses league_seasons.baseline_plupr and the new scale,
--   but its sibling was not updated. Auto-lock would have reset
--   every 4.5-league member to ~3.25, not ~4.50+bonus.
--
-- Per-league soft-reset target: writes to league_player_ratings only.
-- Global profiles.rating is untouched (manual lock_season_period
-- handles global resets — that's a separate intent).
-- ============================================================


-- 1. Recreate season_snapshots (PLUPR-era column types).
-- ----------------------------------------------------------------------
create table if not exists public.season_snapshots (
  id               uuid default gen_random_uuid() primary key,
  season_id        uuid references public.league_seasons(id) on delete cascade not null,
  league_id        uuid references public.leagues(id) on delete cascade not null,
  period_number    integer not null,
  snapshot_date    date not null,
  user_id          uuid references public.profiles(id) on delete cascade not null,
  elo_at_snapshot  decimal(6,3) not null,
  rank_at_snapshot integer not null,
  wins_in_season   integer not null default 0,
  losses_in_season integer not null default 0,
  created_at       timestamptz default now(),
  unique(season_id, period_number, user_id)
);

alter table public.season_snapshots enable row level security;
drop policy if exists "Snapshots readable by everyone" on public.season_snapshots;
create policy "Snapshots readable by everyone"
  on public.season_snapshots for select using (true);
drop policy if exists "Privileged members manage snapshots" on public.season_snapshots;
create policy "Privileged members manage snapshots"
  on public.season_snapshots for all using (
    exists (
      select 1 from public.league_members
      where league_id = season_snapshots.league_id
        and user_id = auth.uid()
        and role in ('admin', 'co-admin')
    )
  );


-- 2. Recreate season_final_standings (PLUPR-era column types).
-- ----------------------------------------------------------------------
create table if not exists public.season_final_standings (
  id          uuid default gen_random_uuid() primary key,
  season_id   uuid references public.league_seasons(id) on delete cascade not null,
  league_id   uuid references public.leagues(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  final_rank  integer not null,
  median_rank real not null,
  elo_bonus   decimal(6,3) not null default 0,
  new_elo     decimal(6,3) not null,
  created_at  timestamptz default now(),
  unique(season_id, user_id)
);

alter table public.season_final_standings enable row level security;
drop policy if exists "Final standings readable by everyone" on public.season_final_standings;
create policy "Final standings readable by everyone"
  on public.season_final_standings for select using (true);
drop policy if exists "Privileged members manage final standings" on public.season_final_standings;
create policy "Privileged members manage final standings"
  on public.season_final_standings for all using (
    exists (
      select 1 from public.league_members
      where league_id = season_final_standings.league_id
        and user_id = auth.uid()
        and role in ('admin', 'co-admin')
    )
  );


-- 3. Patch _lock_season_period_unchecked to mirror the staged
--    lock_season_period: read baseline_plupr from the season and
--    use the new bonus scale. Still writes the soft-reset to
--    league_player_ratings (per-league), NOT profiles.rating.
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
  v_baseline     numeric(4,2);
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        numeric(4,2);
  v_new_rating   numeric(5,2);
begin
  select league_id, name, start_date, baseline_plupr
    into v_league_id, v_season_name, v_season_start, v_baseline
    from public.league_seasons
   where id = p_season_id;
  if v_league_id is null then raise exception 'Season not found'; end if;

  delete from public.season_snapshots
   where season_id = p_season_id and period_number = p_period_number;

  for v_rec in (
    with player_stats as (
      select
        lm.user_id,
        coalesce(lpr.rating, v_baseline) as rating,
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

    -- Period-end soft reset to baseline_plupr + PLUPR-scale bonus.
    -- Writes to league_player_ratings only (global profiles.rating untouched).
    v_bonus := case
      when v_rank = 1 then 0.20
      when v_rank = 2 then 0.15
      when v_rank = 3 then 0.10
      when v_rank = 4 then 0.05
      when v_rank = 5 then 0.02
      else 0.00
    end;
    v_new_rating := v_baseline + v_bonus;
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

notify pgrst, 'reload schema';
