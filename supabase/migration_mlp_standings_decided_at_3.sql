-- PKL-089: an MLP matchup counts in the standings as soon as it is decided.
--   mlp_team_standings counted a matchup only once no game in it was still open, so a team up 3-0 showed 0-0 until the
--   4th game was scored. Now a team with 3 game wins (3 of 4 games, or the Dreambreaker at 2-2) takes the matchup right
--   away. Nothing else changes: the same columns, order and tie rule (PKL-084).
-- Apply: supabase db query --linked -f supabase/migration_mlp_standings_decided_at_3.sql

CREATE OR REPLACE FUNCTION public.mlp_team_standings(p_tournament_id uuid)
 RETURNS TABLE(team_id uuid, team_name text, seed integer, pool_letter text, sub_matches_won integer, sub_matches_lost integer, point_diff integer, tie_rank integer, matchups_won integer, matchups_lost integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format     text;
  v_pool_count integer;
begin
  select coalesce(mlp_play_format, 'round_robin'),
         coalesce(mlp_pool_count, 2)
    into v_format, v_pool_count
    from public.tournaments where id = p_tournament_id;

  return query
  with team_pools as (
    select
      t.id,
      t.name,
      t.seed,
      case when v_format in ('pool_play', 'pool_play_playoff') then
        chr(65 + ((case
          when ((t.seed - 1) % (v_pool_count * 2)) < v_pool_count
            then ((t.seed - 1) % (v_pool_count * 2))
          else  (v_pool_count * 2 - 1) - ((t.seed - 1) % (v_pool_count * 2))
        end)))
      else null end as pool_letter,
      t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id
    from public.mlp_teams t
    where t.tournament_id = p_tournament_id and t.status = 'locked'
  ),
  match_wins as (
    select tp.id as team_id,
           sum(case when
             ((m.winner_team = 'team1' and (m.team1_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team1_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))) or
              (m.winner_team = 'team2' and (m.team2_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team2_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))))
             then 1 else 0 end)::int as wins,
           sum(case when
             ((m.winner_team = 'team2' and (m.team1_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team1_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))) or
              (m.winner_team = 'team1' and (m.team2_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                                            or m.team2_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))))
             then 1 else 0 end)::int as losses,
           coalesce(sum(case
             when m.id is null then 0
             when (m.team1_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
                   or m.team1_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id))
               then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
             else coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
           end), 0)::int as diff
      from team_pools tp
      left join public.tournament_matches m
        on m.tournament_id = p_tournament_id
       and m.status = 'completed'
       and (
         m.team1_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id) or
         m.team1_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id) or
         m.team2_player1 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id) or
         m.team2_player2 in (tp.male_1_id, tp.male_2_id, tp.female_1_id, tp.female_2_id)
       )
     group by tp.id
  ),
  -- PKL-084: a matchup (one tournament round: 4 games, plus a dreambreaker at 2-2) is one win or one loss for the team.
  -- PKL-089: decided as soon as a team has 3 game wins (3 of the 4 games, or the Dreambreaker at 2-2), even while a
  -- game is still open; otherwise once no game in it is open (cancelled = settled) and one team won more.
  meetings as (
    select r.id as round_id, s.team_a_id, s.team_b_id, s.a_wins, s.b_wins
      from public.tournament_rounds r
      cross join lateral public._mlp_round_series_state(r.id) s
     where r.tournament_id = p_tournament_id
       and s.team_a_id is not null and s.team_b_id is not null
       and s.total_completed > 0 and s.a_wins <> s.b_wins
       and (greatest(s.a_wins, s.b_wins) >= 3
            or not exists (select 1 from public.tournament_matches x
                            where x.round_id = r.id and x.status not in ('completed', 'cancelled')))
  ),
  matchup_wl as (
    select tp.id as team_id,
           count(*) filter (where (mt.team_a_id = tp.id and mt.a_wins > mt.b_wins) or (mt.team_b_id = tp.id and mt.b_wins > mt.a_wins))::int as mw,
           count(*) filter (where (mt.team_a_id = tp.id and mt.a_wins < mt.b_wins) or (mt.team_b_id = tp.id and mt.b_wins < mt.a_wins))::int as ml
      from team_pools tp
      left join meetings mt on tp.id in (mt.team_a_id, mt.team_b_id)
     group by tp.id
  )
  select tp.id, tp.name, tp.seed, tp.pool_letter,
         coalesce(mw.wins, 0)   as sub_matches_won,
         coalesce(mw.losses, 0) as sub_matches_lost,
         coalesce(mw.diff, 0)   as point_diff,
         public._pl_tie_rank(p_tournament_id, tp.id, tp.id) as tie_rank,
         coalesce(mu.mw, 0) as matchups_won,
         coalesce(mu.ml, 0) as matchups_lost
    from team_pools tp
    left join match_wins mw on mw.team_id = tp.id
    left join matchup_wl mu on mu.team_id = tp.id
   order by coalesce(tp.pool_letter, ''),
            coalesce(mu.mw, 0) desc,
            coalesce(mu.ml, 0) asc,
            coalesce(mw.diff, 0) desc,
            coalesce(mw.wins, 0) desc,
            coalesce(mw.losses, 0) asc,
            coalesce(public._pl_tie_rank(p_tournament_id, tp.id, tp.id), 2147483647),
            tp.seed;
end;
$function$;
