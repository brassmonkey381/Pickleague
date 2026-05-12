-- ============================================================
-- Period standings sort order:
--   1. PLUPR (rating) descending — the primary measure of skill
--   2. Net record (wins - losses) descending — tiebreak by W-L
--   3. Total wins descending — final tiebreak when net record matches
--
-- Previously this was `order by wins desc, rating desc`, which ranked
-- a 5-1 player above a 4-0 player at much higher rating.  Flipping the
-- precedence makes PLUPR the primary key.
--
-- This rewrites lock_season_period in-place; everything else (PLUPR
-- soft-reset bonuses, badge award, season status flip) is identical
-- to migration_convert_to_plupr.sql.
-- ============================================================

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
  v_bonus        decimal;
  v_new_rating   decimal;
begin
  select league_id, name, start_date
    into v_league_id, v_season_name, v_season_start
    from public.league_seasons
   where id = p_season_id;

  if v_league_id is null then raise exception 'Season not found'; end if;

  if not exists (
    select 1 from public.league_members
    where league_id = v_league_id and user_id = auth.uid()
      and role in ('admin','co-admin')
  ) then
    raise exception 'Only admins and co-admins can lock season standings';
  end if;

  delete from public.season_snapshots
   where season_id = p_season_id and period_number = p_period_number;

  for v_rec in (
    with player_stats as (
      select
        lm.user_id,
        p.rating,
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
      join public.profiles p on p.id = lm.user_id
      left join public.matches m
        on  m.league_id   = v_league_id
        and m.played_at::date between v_season_start and p_snapshot_date
        and (
          m.player1_id  = lm.user_id or m.partner1_id = lm.user_id or
          m.player2_id  = lm.user_id or m.partner2_id = lm.user_id
        )
      where lm.league_id = v_league_id
      group by lm.user_id, p.rating
    )
    select user_id, rating, wins, losses
      from player_stats
     -- PLUPR primary, net W-L secondary, raw wins as final tiebreak.
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

    -- Period-end soft reset to PLUPR base + bonus
    v_bonus := case
      when v_rank = 1 then 0.400
      when v_rank = 2 then 0.275
      when v_rank = 3 then 0.175
      when v_rank = 4 then 0.100
      when v_rank = 5 then 0.050
      else 0.000
    end;
    v_new_rating := 3.250 + v_bonus;
    update public.profiles
       set rating               = v_new_rating,
           singles_rating       = v_new_rating,
           doubles_rating       = v_new_rating,
           mixed_doubles_rating = v_new_rating
     where id = v_rec.user_id;
  end loop;

  update public.league_seasons
     set status = 'active'
   where id = p_season_id and status = 'upcoming';
end;
$$;

grant execute on function public.lock_season_period(uuid, integer, date) to authenticated;
