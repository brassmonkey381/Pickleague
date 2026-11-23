-- migration_mlp_playoff_ranks_tiebreak.sql (PKL-077, PKL-078, PKL-079)
--
-- PKL-079: the MLP Final was never created when a semifinal ended 3-1 or 4-0. Its dreambreaker is cancelled, and
--   _advance_mlp_playoff_round counted it as pending. A cancelled match is now settled. (PKL-060 R2 -Stall run.)
-- PKL-077: MLP standings and the MLP playoff seeding ignored PKL-052 (sub-match W, then L, then seed). They now go
--   W, fewer L, point diff, the admin's tie order, seed. mlp_team_standings gains point_diff and tie_rank columns
--   (its result type changes, so it is dropped and re-created with the same grants).
-- PKL-078 (Brian: "Whole team shares the place"): MLP final places are by team, every player on a team takes the
--   team's place; only one champion used to be pinned and the rest were ranked as individuals.
-- Only these parts change; the rest is the live definitions as of 2026-11-23.

drop function if exists public.mlp_team_standings(uuid);
CREATE OR REPLACE FUNCTION public.mlp_team_standings(p_tournament_id uuid)
 RETURNS TABLE(team_id uuid, team_name text, seed integer, pool_letter text, sub_matches_won integer, sub_matches_lost integer, point_diff integer, tie_rank integer)
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
  )
  select tp.id, tp.name, tp.seed, tp.pool_letter,
         coalesce(mw.wins, 0)   as sub_matches_won,
         coalesce(mw.losses, 0) as sub_matches_lost,
         coalesce(mw.diff, 0)   as point_diff,
         public._pl_tie_rank(p_tournament_id, tp.id, tp.id) as tie_rank
    from team_pools tp
    left join match_wins mw on mw.team_id = tp.id
   order by coalesce(tp.pool_letter, ''),
            coalesce(mw.wins, 0) desc,
            coalesce(mw.losses, 0) asc,
            coalesce(mw.diff, 0) desc,
            coalesce(public._pl_tie_rank(p_tournament_id, tp.id, tp.id), 2147483647),
            tp.seed;
end;
$function$;
grant execute on function public.mlp_team_standings(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public._advance_mlp_playoff_round()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_round_type      text;
  v_tournament_id   uuid;
  v_pending         integer;
  v_round_ids       uuid[];
  v_round_id        uuid;
  v_winners         uuid[];
  v_target_type     text;
  v_target_label    text;
  v_target_base_no  integer;
  v_team_a          record;
  v_team_b          record;
  v_new_round_id    uuid;
  v_match_order     integer;
  v_pair_count      integer;
  v_i               integer;
  v_a_idx           integer;
  v_b_idx           integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select tr.round_type, tr.tournament_id
    into v_round_type, v_tournament_id
    from public.tournament_rounds tr
   where tr.id = new.round_id;

  if v_round_type not in ('quarterfinals', 'semifinals') then return new; end if;

  begin
    select count(*) into v_pending
      from public.tournament_matches tm
      join public.tournament_rounds tr on tr.id = tm.round_id
     where tr.tournament_id = v_tournament_id
       and tr.round_type   = v_round_type
       and tm.status not in ('completed', 'cancelled');
    if v_pending > 0 then return new; end if;

    if v_round_type = 'quarterfinals' then
      v_target_type    := 'semifinals';
      v_target_label   := 'Semifinals';
      v_target_base_no := 1100;
    else
      v_target_type    := 'finals';
      v_target_label   := 'Finals';
      v_target_base_no := 1200;
    end if;

    if exists (
      select 1 from public.tournament_rounds
       where tournament_id = v_tournament_id
         and round_type    = v_target_type
    ) then
      return new;
    end if;

    select array_agg(tr.id order by tr.round_number)
      into v_round_ids
      from public.tournament_rounds tr
     where tr.tournament_id = v_tournament_id
       and tr.round_type    = v_round_type;

    v_winners := array[]::uuid[];
    foreach v_round_id in array v_round_ids loop
      v_winners := v_winners || public._mlp_round_winner(v_round_id);
    end loop;

    if array_length(v_winners, 1) is null
       or array_position(v_winners, null) is not null then
      return new;
    end if;

    v_pair_count  := array_length(v_winners, 1) / 2;
    if v_pair_count < 1 then return new; end if;

    v_match_order := coalesce((
      select max(tm.match_order) from public.tournament_matches tm
       where tm.tournament_id = v_tournament_id
    ), 0);

    for v_i in 0..(v_pair_count - 1) loop
      v_a_idx := v_i + 1;
      v_b_idx := array_length(v_winners, 1) - v_i;

      select * into v_team_a from public.mlp_teams where id = v_winners[v_a_idx];
      select * into v_team_b from public.mlp_teams where id = v_winners[v_b_idx];

      if v_team_a.id is null or v_team_b.id is null then continue; end if;

      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (
        v_tournament_id,
        v_target_base_no + v_i + 1,
        format('%s · %s vs %s', v_target_label, v_team_a.name, v_team_b.name),
        v_target_type
      )
      returning id into v_new_round_id;

      v_match_order := public._insert_mlp_pairing_matches(
        v_tournament_id, v_new_round_id, v_team_a, v_team_b, v_match_order
      );
    end loop;
  exception when others then
    null;
  end;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public._generate_mlp_playoff_unchecked(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_format        text;
  v_pool_count    integer;
  v_playoff_n     integer;
  v_uncompleted   integer;
  v_advanced      uuid[];
  v_third_pair    uuid[];
  v_team_a        record;
  v_team_b        record;
  v_round_id      uuid;
  v_match_order   integer := 0;
  v_matches       integer := 0;
  v_label         text;
  v_team_count    integer;
  v_top_per_pool  integer;
  v_i             integer;
begin
  select coalesce(mlp_play_format, 'round_robin'),
         coalesce(mlp_pool_count, 2),
         coalesce(mlp_playoff_teams, 4)
    into v_format, v_pool_count, v_playoff_n
    from public.tournaments where id = p_tournament_id;

  if v_format not in ('round_robin_playoff', 'pool_play_playoff') then
    raise exception 'Tournament format % does not include a playoff stage', v_format;
  end if;

  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = p_tournament_id
     and tr.round_type in ('pool', 'winners')
     and tm.status not in ('completed', 'cancelled');
  if v_uncompleted > 0 then
    raise exception 'Cannot advance — % pool/round-robin matches still pending', v_uncompleted;
  end if;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
  ) then
    raise exception 'Playoff already generated.';
  end if;

  if v_format = 'round_robin_playoff' then
    select array_agg(s.team_id order by s.sub_matches_won desc, s.sub_matches_lost asc, s.point_diff desc, coalesce(s.tie_rank, 2147483647), s.seed)
      into v_advanced
      from (select * from public.mlp_team_standings(p_tournament_id) limit v_playoff_n) s;
  else
    v_top_per_pool := greatest(1, v_playoff_n / v_pool_count);
    with ranked as (
      select team_id, pool_letter, sub_matches_won, sub_matches_lost, point_diff, tie_rank, seed,
             row_number() over (partition by pool_letter
                                order by sub_matches_won desc, sub_matches_lost asc, point_diff desc, coalesce(tie_rank, 2147483647), seed) as pool_rank
        from public.mlp_team_standings(p_tournament_id)
    )
    select array_agg(r.team_id order by r.pool_rank, r.pool_letter)
      into v_advanced
      from ranked r where r.pool_rank <= v_top_per_pool;
    if array_length(v_advanced, 1) > v_playoff_n then
      v_advanced := v_advanced[1:v_playoff_n];
    end if;
  end if;

  v_team_count := coalesce(array_length(v_advanced, 1), 0);
  if v_team_count < 2 then
    raise exception 'Not enough teams to seed a playoff (got %)', v_team_count;
  end if;

  v_label := case v_team_count
    when 8 then 'Quarterfinals'
    when 4 then 'Semifinals'
    when 2 then 'Finals'
    else format('Playoff Round of %s', v_team_count)
  end;

  for v_i in 0..(v_team_count / 2 - 1) loop
    select * into v_team_a from public.mlp_teams where id = v_advanced[v_i + 1];
    select * into v_team_b from public.mlp_teams where id = v_advanced[v_team_count - v_i];

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (
      p_tournament_id,
      1000 + v_i + 1,
      format('%s · %s vs %s', v_label, v_team_a.name, v_team_b.name),
      case v_team_count
        when 8 then 'quarterfinals'
        when 4 then 'semifinals'
        when 2 then 'finals'
        else 'winners'
      end
    )
    returning id into v_round_id;

    v_match_order := public._insert_mlp_pairing_matches(p_tournament_id, v_round_id, v_team_a, v_team_b, v_match_order);
    v_matches := v_matches + 4;
  end loop;

  if v_playoff_n = 2 then
    if v_format = 'round_robin_playoff' then
      select array_agg(s.team_id order by s.sub_matches_won desc, s.sub_matches_lost asc, s.point_diff desc, coalesce(s.tie_rank, 2147483647), s.seed)
        into v_third_pair
        from (
          select * from public.mlp_team_standings(p_tournament_id)
          order by sub_matches_won desc, sub_matches_lost asc, point_diff desc, coalesce(tie_rank, 2147483647), seed
          offset 2 limit 2
        ) s;
    else
      with ranked as (
        select team_id, pool_letter, sub_matches_won, sub_matches_lost, point_diff, tie_rank, seed,
               row_number() over (partition by pool_letter
                                  order by sub_matches_won desc, sub_matches_lost asc, point_diff desc, coalesce(tie_rank, 2147483647), seed) as pool_rank
          from public.mlp_team_standings(p_tournament_id)
      )
      select array_agg(r.team_id order by r.pool_letter)
        into v_third_pair
        from ranked r where r.pool_rank = 2;
    end if;

    if v_third_pair is not null and array_length(v_third_pair, 1) = 2 then
      select * into v_team_a from public.mlp_teams where id = v_third_pair[1];
      select * into v_team_b from public.mlp_teams where id = v_third_pair[2];

      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (
        p_tournament_id,
        1100,
        format('Third Place Match · %s vs %s', v_team_a.name, v_team_b.name),
        'third_place_match'
      )
      returning id into v_round_id;

      v_match_order := public._insert_mlp_pairing_matches(p_tournament_id, v_round_id, v_team_a, v_team_b, v_match_order);
      v_matches := v_matches + 4;
    end if;
  end if;

  return v_matches;
end;
$function$;

CREATE OR REPLACE FUNCTION public.compute_tournament_final_ranks(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows   int;
  v_format text;
begin
  select format into v_format from tournaments where id = p_tournament_id;
  delete from tournament_final_ranks where tournament_id = p_tournament_id;

  -- Staged: round robin / pool play (+ optional playoff). PKL-037.
  if v_format in ('round_robin', 'pool_play') then
    with rr as (
      select * from public._pl_tournament_group_order(p_tournament_id)
    ),
    pm as (
      -- Playoff matches with both sides set.
      select m.*, r.round_type, r.round_number,
             least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1))    as a_lo,
             greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) as a_hi,
             least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1))    as b_lo,
             greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) as b_hi
        from tournament_matches m
        join tournament_rounds r on r.id = m.round_id
       where m.tournament_id = p_tournament_id
         and r.round_type not in ('winners', 'pool')
         and m.team1_player1 is not null and m.team2_player1 is not null
    ),
    fin as (
      select * from pm
       where round_type in ('finals', 'grand_final') and status = 'completed' and winner_team in ('team1', 'team2')
       order by round_number desc, match_order desc limit 1
    ),
    third as (
      select * from pm
       where round_type = 'third_place_match' and status = 'completed' and winner_team in ('team1', 'team2')
       order by round_number desc, match_order desc limit 1
    ),
    pinned as (
      select case when winner_team = 'team1' then a_lo else b_lo end as lo,
             case when winner_team = 'team1' then a_hi else b_hi end as hi, 1 as tier from fin
      union all
      select case when winner_team = 'team1' then b_lo else a_lo end,
             case when winner_team = 'team1' then b_hi else a_hi end, 2 from fin
      union all
      select case when winner_team = 'team1' then a_lo else b_lo end,
             case when winner_team = 'team1' then a_hi else b_hi end, 3 from third
      union all
      select case when winner_team = 'team1' then b_lo else a_lo end,
             case when winner_team = 'team1' then b_hi else a_hi end, 4 from third
    ),
    reached as (
      -- Deepest playoff round each team played in.
      select lo, hi, max(round_number) as deepest from (
        select a_lo as lo, a_hi as hi, round_number from pm
        union all
        select b_lo, b_hi, round_number from pm
      ) x group by lo, hi
    ),
    teams as (
      select lo, hi from rr
      union
      select lo, hi from reached
    ),
    totals as (
      -- W-L over every completed match, playoff included (the stored meaning).
      select t.lo, t.hi,
             coalesce(sum(case when (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)), greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1))) = (t.lo, t.hi) and m.winner_team = 'team1' then 1
                               when (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)), greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1))) = (t.lo, t.hi) and m.winner_team = 'team2' then 1
                               else 0 end), 0)::int as wins,
             coalesce(sum(case when (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)), greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1))) = (t.lo, t.hi) and m.winner_team = 'team2' then 1
                               when (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)), greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1))) = (t.lo, t.hi) and m.winner_team = 'team1' then 1
                               else 0 end), 0)::int as losses
        from teams t
        left join tournament_matches m
          on m.tournament_id = p_tournament_id and m.status = 'completed' and m.winner_team in ('team1', 'team2')
         and m.team1_player1 is not null and m.team2_player1 is not null
         and t.lo in (m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2)
       group by t.lo, t.hi
    ),
    ranked_teams as (
      select t.lo, t.hi, tt.wins, tt.losses,
             row_number() over (
               order by coalesce((select min(p.tier) from pinned p where p.lo = t.lo and p.hi = t.hi),
                                 case when rc.lo is not null then 5 else 6 end),
                        coalesce(rc.deepest, 0) desc,
                        coalesce(r.rr_rank, 2147483647),
                        t.lo, t.hi
             ) as team_rank
        from teams t
        join totals tt on tt.lo = t.lo and tt.hi = t.hi
        left join rr r on r.lo = t.lo and r.hi = t.hi
        left join reached rc on rc.lo = t.lo and rc.hi = t.hi
    ),
    team_users as (
      select team_rank, wins, losses, lo as user_id from ranked_teams
      union
      select team_rank, wins, losses, hi from ranked_teams
    ),
    leftovers as (
      select tr.user_id, coalesce(tr.seed, 999) as seed
        from tournament_registrations tr
       where tr.tournament_id = p_tournament_id and tr.status = 'approved'
         and not exists (select 1 from team_users tu where tu.user_id = tr.user_id)
    ),
    leftover_ranked as (
      select user_id,
             (select coalesce(max(team_rank), 0) from ranked_teams)
               + row_number() over (order by seed asc, user_id asc) as team_rank
        from leftovers
    )
    insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
    select p_tournament_id, user_id, team_rank, wins, losses from team_users
    union all
    select p_tournament_id, user_id, team_rank, 0, 0 from leftover_ranked;

    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  -- Bracket formats: unchanged from migration_fix_champion_rank_collision.sql.
  if v_format in ('single_elimination', 'double_elimination') then
    with raw as (
      select least(team1_player1, coalesce(team1_player2, team1_player1))    as lo,
             greatest(team1_player1, coalesce(team1_player2, team1_player1)) as hi,
             coalesce(team1_score, 0) as pf, coalesce(team2_score, 0) as pa,
             case when winner_team = 'team1' then 1 else 0 end as wins,
             case when winner_team = 'team2' then 1 else 0 end as losses
        from tournament_matches
       where tournament_id = p_tournament_id and status = 'completed'
         and winner_team in ('team1','team2') and team1_player1 is not null
      union all
      select least(team2_player1, coalesce(team2_player2, team2_player1)),
             greatest(team2_player1, coalesce(team2_player2, team2_player1)),
             coalesce(team2_score, 0), coalesce(team1_score, 0),
             case when winner_team = 'team2' then 1 else 0 end,
             case when winner_team = 'team1' then 1 else 0 end
        from tournament_matches
       where tournament_id = p_tournament_id and status = 'completed'
         and winner_team in ('team1','team2') and team2_player1 is not null
    ),
    agg as (
      select lo, hi, sum(wins)::int as wins, sum(losses)::int as losses,
             sum(pf)::int - sum(pa)::int as point_diff
        from raw group by lo, hi
    ),
    gf as (
      select tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2, tm.winner_team
        from tournament_matches tm
        join tournament_rounds tr on tr.id = tm.round_id
       where tm.tournament_id = p_tournament_id
         and tr.round_type in ('finals', 'grand_final')
         and tm.status = 'completed' and tm.winner_team in ('team1','team2')
       order by tr.round_number desc, tm.match_order desc
       limit 1
    ),
    gf_loser as (
      select least(case when winner_team = 'team1' then team2_player1 else team1_player1 end,
                   coalesce(case when winner_team = 'team1' then team2_player2 else team1_player2 end,
                            case when winner_team = 'team1' then team2_player1 else team1_player1 end)) as lo,
             greatest(case when winner_team = 'team1' then team2_player1 else team1_player1 end,
                      coalesce(case when winner_team = 'team1' then team2_player2 else team1_player2 end,
                               case when winner_team = 'team1' then team2_player1 else team1_player1 end)) as hi
        from gf
    ),
    gf_winner as (
      select least(case when winner_team = 'team1' then team1_player1 else team2_player1 end,
                   coalesce(case when winner_team = 'team1' then team1_player2 else team2_player2 end,
                            case when winner_team = 'team1' then team1_player1 else team2_player1 end)) as lo,
             greatest(case when winner_team = 'team1' then team1_player1 else team2_player1 end,
                      coalesce(case when winner_team = 'team1' then team1_player2 else team2_player2 end,
                               case when winner_team = 'team1' then team1_player1 else team2_player1 end)) as hi
        from gf
    ),
    with_seed as (
      select a.*, coalesce((
               select min(tr.seed) from tournament_registrations tr
                where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)
             ), 999) as seed,
             (exists (
               select 1 from tournament_champion_badges cb
                where cb.tournament_id = p_tournament_id and cb.user_id in (a.lo, a.hi)
             ) or exists (
               select 1 from gf_winner g where g.lo = a.lo and g.hi = a.hi
             )) as is_champ,
             exists (
               select 1 from gf_loser g where g.lo = a.lo and g.hi = a.hi
             ) as is_gf_loser
        from agg a
    ),
    pre as (
      select *, row_number() over (order by wins desc, point_diff desc, seed asc) as rn
        from with_seed
    ),
    ranked_teams as (
      -- PKL-052: wins, fewer losses, point diff, then the admin's tie order
      -- (seed only keeps an unset tie deterministic). No head-to-head.
      select *, row_number() over (
               order by is_champ desc, is_gf_loser desc, wins desc, losses asc, point_diff desc,
                        coalesce(public._pl_tie_rank(p_tournament_id, lo, hi), 2147483647), seed asc, lo, hi
             ) as team_rank
        from pre
    ),
    team_users as (
      select team_rank, wins, losses, lo as user_id from ranked_teams
      union all
      select team_rank, wins, losses, hi from ranked_teams where hi <> lo
    ),
    leftovers as (
      select tr.user_id,
             coalesce(tr.seed, 999) as seed
        from tournament_registrations tr
       where tr.tournament_id = p_tournament_id and tr.status = 'approved'
         and not exists (select 1 from team_users tu where tu.user_id = tr.user_id)
    ),
    leftover_ranked as (
      select user_id,
             (select coalesce(max(team_rank), 0) from ranked_teams)
               + row_number() over (order by seed asc) as team_rank
        from leftovers
    )
    insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
    select p_tournament_id, user_id, team_rank, wins, losses from team_users
    union all
    select p_tournament_id, user_id, team_rank, 0, 0 from leftover_ranked;

    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  -- PKL-078 (Brian, 2026-11-23: "Whole team shares the place"): MLP places are by team, and every player on a team
  -- takes the team's place, the way doubles partners share one. Final winner 1, Final loser 2, Third Place winner 3,
  -- loser 4, then the other playoff teams (deeper round first), then the rest; inside each tier the team standings
  -- (PKL-077: sub-match W, fewer L, point diff, admin tie order, seed).
  if v_format in ('mlp', 'mlp_random') then
    with st as (
      select s.team_id, s.sub_matches_won as w, s.sub_matches_lost as l,
             row_number() over (order by s.sub_matches_won desc, s.sub_matches_lost asc, s.point_diff desc,
                                         coalesce(s.tie_rank, 2147483647), s.seed, s.team_id) as rr
        from public.mlp_team_standings(p_tournament_id) s
    ),
    po as (
      select r.id, r.round_type,
             case r.round_type when 'quarterfinals' then 1 when 'semifinals' then 2 when 'third_place_match' then 3 when 'finals' then 4 else 0 end as depth,
             public._mlp_round_winner(r.id) as winner
        from tournament_rounds r
       where r.tournament_id = p_tournament_id
         and r.round_type in ('quarterfinals', 'semifinals', 'third_place_match', 'finals')
    ),
    po_teams as (
      select distinct po.id, po.round_type, po.depth, po.winner, t.id as team_id
        from po
        join tournament_matches m on m.round_id = po.id
        join mlp_teams t on t.tournament_id = p_tournament_id
         and (m.team1_player1 in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
           or m.team2_player1 in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id))
    ),
    tiers as (
      select st.team_id, st.w, st.l, st.rr,
             coalesce((select min(case
                        when pt.round_type = 'finals' and pt.winner = st.team_id then 1
                        when pt.round_type = 'finals' and pt.winner is not null then 2
                        when pt.round_type = 'third_place_match' and pt.winner = st.team_id then 3
                        when pt.round_type = 'third_place_match' and pt.winner is not null then 4
                        else 5 end)
                         from po_teams pt where pt.team_id = st.team_id), 6) as tier,
             coalesce((select max(pt.depth) from po_teams pt where pt.team_id = st.team_id), 0) as depth
        from st
    ),
    ranked as (
      select team_id, w, l, row_number() over (order by tier, depth desc, rr) as team_rank from tiers
    ),
    members as (
      select r.team_rank, r.w, r.l, u.user_id
        from ranked r
        join mlp_teams t on t.id = r.team_id
        cross join lateral (values (t.male_1_id), (t.male_2_id), (t.female_1_id), (t.female_2_id)) u(user_id)
       where u.user_id is not null
    ),
    leftovers as (
      select tr.user_id, row_number() over (order by coalesce(tr.seed, 999), tr.user_id) as k
        from tournament_registrations tr
       where tr.tournament_id = p_tournament_id and tr.status = 'approved'
         and not exists (select 1 from members m where m.user_id = tr.user_id)
    )
    insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
    select p_tournament_id, user_id, team_rank, w, l from members
    union all
    select p_tournament_id, user_id, (select coalesce(max(team_rank), 0) from ranked) + k, 0, 0 from leftovers;

    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  -- Per-player formats (rotating_partners, mlp, ...): wins, fewer losses, point
  -- diff, then the admin's tie order (PKL-052).
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
  point_diff as (
    -- Points for minus against over the player's completed matches, as the
    -- client's computePlayerStandings (pf - pa).
    select e.user_id,
           coalesce(sum(case
             when mo.id is null then 0
             when e.user_id in (mo.team1_player1, mo.team1_player2) then coalesce(mo.team1_score, 0) - coalesce(mo.team2_score, 0)
             else coalesce(mo.team2_score, 0) - coalesce(mo.team1_score, 0)
           end), 0) as diff
      from entrants e
      left join match_outcomes mo
        on e.user_id in (mo.team1_player1, mo.team1_player2, mo.team2_player1, mo.team2_player2)
     group by e.user_id
  ),
  ranked as (
    -- PKL-052, every per-player format: wins, fewer losses, point diff, then
    -- the admin's tie order (seed only keeps an unset tie deterministic). No
    -- head-to-head, no rating.
    select pu.user_id, pu.wins, pu.losses,
      row_number() over (order by pu.wins desc, pu.losses asc, coalesce(d.diff, 0) desc,
                                  coalesce(public._pl_tie_rank(p_tournament_id, pu.user_id, pu.user_id), 2147483647),
                                  coalesce(tr.seed, 999) asc, pu.user_id) as rk
    from per_user pu
    left join point_diff d on d.user_id = pu.user_id
    left join tournament_registrations tr on tr.tournament_id = p_tournament_id and tr.user_id = pu.user_id
  ),
  champion_row as (
    -- MLP only. rotating_partners has no playoff, so its places are the
    -- standings order exactly (wins, fewer losses, point diff, then the
    -- admin's tie order), as the client's
    -- computePlayerStandings shows them; a champion badge (written by a payout
    -- AFTER ranks exist) must not reorder them on a later recompute.
    select user_id from tournament_champion_badges
     where tournament_id = p_tournament_id
       and v_format in ('mlp', 'mlp_random')
     limit 1
  ),
  with_champion as (
    select r.user_id, r.wins, r.losses,
           row_number() over (
             order by case when r.user_id = (select user_id from champion_row) then 0 else 1 end,
                      r.rk
           ) as rk
    from ranked r
  )
  insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
  select p_tournament_id, user_id, rk, wins, losses
    from with_champion;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;
