-- Multi-game W/L counting. Each individual game in a best-of-N match
-- now counts as a separate W or L for the players involved. So a
-- best-of-3 that ends 2-1 awards 2 wins + 1 loss to the winning side
-- and 1 win + 2 losses to the losing side. Single-game matches
-- (game_scores IS NULL or empty array) keep the old 1 W / 1 L behavior
-- driven by winner_team.
--
-- Affects:
--   * _lock_season_period_unchecked — wins_in_season / losses_in_season
--     stored in season_snapshots at period lock.
--   * compute_tournament_final_ranks — counts used to sort tournament
--     finishing positions, written into tournament_final_ranks.

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
          when m.id is null then 0
          when m.game_scores is not null and jsonb_typeof(m.game_scores) = 'array' and jsonb_array_length(m.game_scores) > 0 then (
            select count(*)::int from jsonb_array_elements(m.game_scores) g
             where (
               ((m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and (g->>'t1')::int > (g->>'t2')::int)
            or ((m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and (g->>'t2')::int > (g->>'t1')::int)
             ))
          when (m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and m.winner_team='team1' then 1
          when (m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and m.winner_team='team2' then 1
          else 0
        end), 0) as wins,
        coalesce(sum(case
          when m.id is null then 0
          when m.game_scores is not null and jsonb_typeof(m.game_scores) = 'array' and jsonb_array_length(m.game_scores) > 0 then (
            select count(*)::int from jsonb_array_elements(m.game_scores) g
             where (
               ((m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and (g->>'t2')::int > (g->>'t1')::int)
            or ((m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and (g->>'t1')::int > (g->>'t2')::int)
             ))
          when (m.player1_id  = lm.user_id or m.partner1_id = lm.user_id) and m.winner_team='team2' then 1
          when (m.player2_id  = lm.user_id or m.partner2_id = lm.user_id) and m.winner_team='team1' then 1
          else 0
        end), 0) as losses
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

  perform public._settle_wagers_for_period_lock(p_season_id, p_period_number);
end;
$$;


create or replace function public.compute_tournament_final_ranks(p_tournament_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_rows int;
begin
  delete from tournament_final_ranks where tournament_id = p_tournament_id;

  with entrants as (
    select tr.user_id
      from tournament_registrations tr
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
  ),
  match_outcomes as (
    select tm.* from tournament_matches tm
     where tm.tournament_id = p_tournament_id
       and coalesce(tm.status, 'completed') = 'completed'
       and tm.winner_team in ('team1','team2')
  ),
  per_user as (
    select
      e.user_id,
      coalesce(sum(case
        when mo.id is null then 0
        when mo.game_scores is not null and jsonb_typeof(mo.game_scores) = 'array' and jsonb_array_length(mo.game_scores) > 0 then (
          select count(*)::int from jsonb_array_elements(mo.game_scores) g
           where (
             ((mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and (g->>'t1')::int > (g->>'t2')::int)
          or ((mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and (g->>'t2')::int > (g->>'t1')::int)
           ))
        when (mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and mo.winner_team='team1' then 1
        when (mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and mo.winner_team='team2' then 1
        else 0
      end), 0) as wins,
      coalesce(sum(case
        when mo.id is null then 0
        when mo.game_scores is not null and jsonb_typeof(mo.game_scores) = 'array' and jsonb_array_length(mo.game_scores) > 0 then (
          select count(*)::int from jsonb_array_elements(mo.game_scores) g
           where (
             ((mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and (g->>'t2')::int > (g->>'t1')::int)
          or ((mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and (g->>'t1')::int > (g->>'t2')::int)
           ))
        when (mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and mo.winner_team='team2' then 1
        when (mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and mo.winner_team='team1' then 1
        else 0
      end), 0) as losses
    from entrants e
    left join match_outcomes mo
      on e.user_id in (mo.team1_player1, mo.team1_player2, mo.team2_player1, mo.team2_player2)
    group by e.user_id
  ),
  ranked as (
    select pu.user_id, pu.wins, pu.losses,
      row_number() over (order by pu.wins desc, pu.losses asc, coalesce(p.rating, 0) desc) as rk
    from per_user pu
    left join profiles p on p.id = pu.user_id
  ),
  champion_row as (
    select user_id from tournament_champion_badges
     where tournament_id = p_tournament_id
     limit 1
  ),
  with_champion as (
    select r.user_id, r.wins, r.losses,
      case
        when (select user_id from champion_row) is null then r.rk
        when r.user_id = (select user_id from champion_row) then 1
        when r.rk = 1 then 2
        else r.rk
      end as rk
    from ranked r
  )
  insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
  select p_tournament_id, user_id, rk, wins, losses
    from with_champion;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$func$;

grant execute on function public.compute_tournament_final_ranks(uuid) to authenticated;
