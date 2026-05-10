-- ============================================================
-- Season / period badges
--
-- Adds five league-category badges tied to season performance,
-- and updates lock_season_period + complete_season to award them
-- automatically. Also patches complete_season to reset the new
-- mixed_doubles_rating column alongside singles / doubles.
-- ============================================================

-- 1. Badge definitions ----------------------------------------------------
insert into public.badges (name, description, icon, category, criteria, sort_order) values
  ('Period Champion',  'Finished #1 in a single locked-in period of a season.',           '🥇', 'league', '{"type":"period_rank","rank":1}', 20),
  ('Season Crown',     'Won the season — finished #1 in the final standings.',             '👑', 'league', '{"type":"season_rank","rank":1}', 21),
  ('Season Silver',    'Finished #2 in the final season standings.',                       '🥈', 'league', '{"type":"season_rank","rank":2}', 22),
  ('Season Bronze',    'Finished #3 in the final season standings.',                       '🥉', 'league', '{"type":"season_rank","rank":3}', 23),
  ('Period Sweeper',   'Finished #1 in every locked-in period of a single season.',        '🌟', 'league', '{"type":"all_periods_first"}',    24)
on conflict (name) do nothing;

-- 2. Helper: award a league badge by name + league + user --------------
create or replace function public.award_league_badge(
  p_user_id  uuid,
  p_league_id uuid,
  p_badge_name text,
  p_context  text default null
) returns void language plpgsql security definer as $$
declare
  v_badge_id uuid;
begin
  select id into v_badge_id from public.badges where name = p_badge_name;
  if v_badge_id is null then return; end if;

  insert into public.player_badges (user_id, badge_id, league_id, context)
  values (p_user_id, v_badge_id, p_league_id, p_context)
  on conflict do nothing;
end;
$$;

-- 3. Replace lock_season_period:
--    * Snapshot standings
--    * Award "Period Champion" to #1
--    * Soft-reset ELO for the next period — top 5 land at 1000 + bonus,
--      everyone else snaps clean to 1000. This rewards strong period
--      finishes with a small head start going into the next period.
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
  v_rec          record;
  v_rank         integer := 0;
  v_bonus        integer;
  v_new_elo      integer;
begin
  select league_id, name, start_date
  into   v_league_id, v_season_name, v_season_start
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

    -- Award Period Champion to whoever lands at #1
    if v_rank = 1 then
      perform public.award_league_badge(
        v_rec.user_id, v_league_id, 'Period Champion',
        format('%s — Period %s', v_season_name, p_period_number)
      );
    end if;

    -- Period-end soft ELO reset: top 5 keep a head start, rest reset clean
    v_bonus := case
      when v_rank = 1 then 80
      when v_rank = 2 then 55
      when v_rank = 3 then 35
      when v_rank = 4 then 20
      when v_rank = 5 then 10
      else 0
    end;
    v_new_elo := 1000 + v_bonus;
    update public.profiles
    set rating               = v_new_elo,
        singles_rating       = v_new_elo,
        doubles_rating       = v_new_elo,
        mixed_doubles_rating = v_new_elo
    where id = v_rec.user_id;
  end loop;

  update public.league_seasons
  set status = 'active'
  where id = p_season_id and status = 'upcoming';
end;
$$;

-- 4. Replace complete_season — adds mixed_doubles_rating reset and
--    awards Season Crown/Silver/Bronze and Period Sweeper.
create or replace function public.complete_season(p_season_id uuid)
returns void language plpgsql security definer as $$
declare
  v_league_id    uuid;
  v_season_name  text;
  v_period_count integer;
  v_player       record;
  v_rank         integer := 0;
  v_bonus        integer;
  v_new_elo      integer;
  v_badge        text;
begin
  select league_id, name into v_league_id, v_season_name
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

  select count(distinct period_number) into v_period_count
  from   public.season_snapshots
  where  season_id = p_season_id;

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

    -- Soft ELO reset across overall + all split ratings
    update public.profiles
    set rating               = v_new_elo,
        singles_rating       = v_new_elo,
        doubles_rating       = v_new_elo,
        mixed_doubles_rating = v_new_elo
    where id = v_player.user_id;

    -- Top-3 season badges
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

    -- Period Sweeper: 1st in every locked period
    if exists (
      select 1
      from   public.season_snapshots
      where  season_id = p_season_id
        and  user_id   = v_player.user_id
      group  by user_id
      having count(*) filter (where rank_at_snapshot = 1) = v_period_count
        and  count(*) = v_period_count
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

grant execute on function public.award_league_badge(uuid, uuid, text, text) to authenticated;
grant execute on function public.lock_season_period(uuid, integer, date)  to authenticated;
grant execute on function public.complete_season(uuid)                    to authenticated;
