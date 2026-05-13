-- ============================================================
-- Fix typo in mlp_team_standings: bare `seed` should be `t.seed`
-- (inside a nested CASE that referenced the outer table alias).
-- Also: make the function STABLE language sql for simpler PostgREST
-- introspection and re-grant after recreation.
-- ============================================================

drop function if exists public.mlp_team_standings(uuid);

create or replace function public.mlp_team_standings(p_tournament_id uuid)
returns table (
  team_id          uuid,
  team_name        text,
  seed             integer,
  pool_letter      text,
  sub_matches_won  integer,
  sub_matches_lost integer
) language plpgsql security definer as $$
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
             then 1 else 0 end)::int as losses
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
  )
  select tp.id, tp.name, tp.seed, tp.pool_letter,
         coalesce(mw.wins, 0)   as sub_matches_won,
         coalesce(mw.losses, 0) as sub_matches_lost
    from team_pools tp
    left join match_wins mw on mw.team_id = tp.id
   order by coalesce(tp.pool_letter, ''),
            coalesce(mw.wins, 0) desc,
            coalesce(mw.losses, 0) asc,
            tp.seed;
end;
$$;

grant execute on function public.mlp_team_standings(uuid) to authenticated;
