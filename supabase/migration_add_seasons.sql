-- ============================================================
-- League Seasons
-- ============================================================

-- Season definitions
create table if not exists public.league_seasons (
  id                   uuid default gen_random_uuid() primary key,
  league_id            uuid references public.leagues(id) on delete cascade not null,
  name                 text not null,
  start_date           date not null,
  end_date             date not null,
  total_weeks          integer not null check (total_weeks between 1 and 52),
  lock_frequency_weeks integer not null check (lock_frequency_weeks between 1 and 12),
  -- How many lock-in periods this season has
  total_periods        integer generated always as (total_weeks / lock_frequency_weeks) stored,
  status               text not null default 'upcoming'
                         check (status in ('upcoming', 'active', 'completed')),
  elo_reset_applied    boolean not null default false,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz default now()
);

alter table public.league_seasons enable row level security;
create policy "Seasons readable by everyone"
  on public.league_seasons for select using (true);
create policy "Privileged members manage seasons"
  on public.league_seasons for all using (
    exists (
      select 1 from public.league_members
      where league_id = league_seasons.league_id
        and user_id = auth.uid()
        and role in ('admin', 'co-admin')
    )
  );

-- Per-period standings snapshots (locked in by admin)
create table if not exists public.season_snapshots (
  id               uuid default gen_random_uuid() primary key,
  season_id        uuid references public.league_seasons(id) on delete cascade not null,
  league_id        uuid references public.leagues(id) on delete cascade not null,
  period_number    integer not null,           -- 1, 2, 3 …
  snapshot_date    date not null,
  user_id          uuid references public.profiles(id) on delete cascade not null,
  elo_at_snapshot  integer not null,
  rank_at_snapshot integer not null,
  wins_in_season   integer not null default 0,
  losses_in_season integer not null default 0,
  created_at       timestamptz default now(),
  unique(season_id, period_number, user_id)
);

alter table public.season_snapshots enable row level security;
create policy "Snapshots readable by everyone"
  on public.season_snapshots for select using (true);
create policy "Privileged members manage snapshots"
  on public.season_snapshots for all using (
    exists (
      select 1 from public.league_members
      where league_id = season_snapshots.league_id
        and user_id = auth.uid()
        and role in ('admin', 'co-admin')
    )
  );

-- Final season standings (computed at season end)
create table if not exists public.season_final_standings (
  id          uuid default gen_random_uuid() primary key,
  season_id   uuid references public.league_seasons(id) on delete cascade not null,
  league_id   uuid references public.leagues(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  final_rank  integer not null,
  median_rank real not null,
  elo_bonus   integer not null default 0,
  new_elo     integer not null,
  created_at  timestamptz default now(),
  unique(season_id, user_id)
);

alter table public.season_final_standings enable row level security;
create policy "Final standings readable by everyone"
  on public.season_final_standings for select using (true);
create policy "Privileged members manage final standings"
  on public.season_final_standings for all using (
    exists (
      select 1 from public.league_members
      where league_id = season_final_standings.league_id
        and user_id = auth.uid()
        and role in ('admin', 'co-admin')
    )
  );

-- ============================================================
-- Function: lock_season_period
-- Computes and stores a standings snapshot for one lock-in period.
-- Ranks players by (wins desc, elo desc) over all league matches
-- from season start up through snapshot_date.
-- ============================================================
create or replace function public.lock_season_period(
  p_season_id     uuid,
  p_period_number integer,
  p_snapshot_date date
)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_start date;
  v_rec          record;
  v_rank         integer := 0;
begin
  -- Permission check: caller must be admin/co-admin in this league
  select league_id, start_date
  into   v_league_id, v_season_start
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

  -- Remove any existing snapshot for this period (allow re-lock)
  delete from public.season_snapshots
  where  season_id     = p_season_id
    and  period_number = p_period_number;

  -- Compute standings over season-to-date matches
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
  end loop;

  -- Activate season if it was still 'upcoming'
  update public.league_seasons
  set status = 'active'
  where id = p_season_id and status = 'upcoming';
end;
$$;

-- ============================================================
-- Function: complete_season
-- Computes final standings (median rank across all periods),
-- inserts into season_final_standings, and applies a soft ELO
-- reset to every participating player:
--   new_elo = 1000 + rank_bonus
-- Rank bonuses: #1→+80  #2→+55  #3→+35  #4→+20  #5→+10  rest→0
-- ============================================================
create or replace function public.complete_season(p_season_id uuid)
returns void language plpgsql security definer as $$
declare
  v_league_id uuid;
  v_player    record;
  v_rank      integer := 0;
  v_bonus     integer;
  v_new_elo   integer;
begin
  select league_id into v_league_id
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
    raise exception 'Only admins and co-admins can complete a season';
  end if;

  if (select elo_reset_applied from public.league_seasons where id = p_season_id) then
    raise exception 'ELO reset has already been applied for this season';
  end if;

  if not exists (select 1 from public.season_snapshots where season_id = p_season_id) then
    raise exception 'Lock in at least one period before completing the season';
  end if;

  -- Compute final standings from median rank across all locked periods
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
    from   medians
    order  by median_rank asc
  ) loop
    v_rank  := v_rank + 1;
    v_bonus := case
      when v_rank = 1 then 80
      when v_rank = 2 then 55
      when v_rank = 3 then 35
      when v_rank = 4 then 20
      when v_rank = 5 then 10
      else 0
    end;
    v_new_elo := 1000 + v_bonus;

    insert into public.season_final_standings (
      season_id, league_id, user_id, final_rank, median_rank, elo_bonus, new_elo
    ) values (
      p_season_id, v_league_id, v_player.user_id,
      v_rank, v_player.median_rank, v_bonus, v_new_elo
    ) on conflict (season_id, user_id) do update
      set final_rank  = excluded.final_rank,
          median_rank = excluded.median_rank,
          elo_bonus   = excluded.elo_bonus,
          new_elo     = excluded.new_elo;

    -- Apply soft ELO reset to global profile rating
    update public.profiles
    set rating         = v_new_elo,
        singles_rating = v_new_elo,
        doubles_rating = v_new_elo
    where id = v_player.user_id;
  end loop;

  -- Mark season complete
  update public.league_seasons
  set status = 'completed', elo_reset_applied = true
  where id = p_season_id;
end;
$$;

-- Grant RPC access to authenticated users
-- (permission checks are enforced inside the functions)
grant execute on function public.lock_season_period(uuid, integer, date) to authenticated;
grant execute on function public.complete_season(uuid) to authenticated;
