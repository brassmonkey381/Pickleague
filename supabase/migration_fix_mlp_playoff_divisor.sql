-- ============================================================
-- Fix: MLP pool_play_playoff bracket size when
-- playoff_n / pool_count doesn't divide cleanly
--
-- Bug:
--   The previous body computed
--     v_top_per_pool := greatest(1, v_playoff_n / v_pool_count);
--   and then advanced the top-N from each pool. Integer division
--   silently truncates, so e.g. playoff_n=8 with pool_count=3
--   gives top_per_pool=2 → only 6 teams advance instead of 8.
--   The same problem appears for 3 pools × top 4 (yields 3), or
--   any combination where playoff_n is not a multiple of
--   pool_count.
--
-- Fix (chosen approach):
--   Take floor(playoff_n / pool_count) from EACH pool, then fill
--   the remaining (playoff_n mod pool_count) slots with the
--   next-best teams from the GLOBAL standings (cross-pool
--   tiebreak by sub_matches_won desc, sub_matches_lost asc,
--   seed). This preserves "every pool sends some teams" intuition
--   in the clean case while still guaranteeing exactly playoff_n
--   teams enter the bracket in the non-clean case.
--
--   When playoff_n is a multiple of pool_count, behavior is
--   identical to before (the "leftover" set is empty), so brackets
--   like 4 pools × top 2 = 8 and 2 pools × top 4 = 8 are
--   untouched.
--
-- Run AFTER:
--   migration_third_place_match.sql
-- ============================================================

create or replace function public._generate_mlp_playoff_unchecked(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
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
  v_remainder     integer;
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
     and tm.status <> 'completed';
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
    select array_agg(s.team_id order by s.sub_matches_won desc, s.sub_matches_lost asc, s.seed)
      into v_advanced
      from (select * from public.mlp_team_standings(p_tournament_id) limit v_playoff_n) s;
  else
    -- floor() per-pool, then fill the remainder from global standings.
    -- When playoff_n < pool_count, v_top_per_pool = 0 and the remainder
    -- equals playoff_n — i.e., we just take the top playoff_n globally.
    v_top_per_pool := v_playoff_n / v_pool_count;            -- integer division (floor)
    v_remainder    := v_playoff_n - (v_top_per_pool * v_pool_count);

    with ranked as (
      select team_id, pool_letter, sub_matches_won, sub_matches_lost, seed,
             row_number() over (partition by pool_letter
                                order by sub_matches_won desc, sub_matches_lost asc, seed) as pool_rank,
             row_number() over (order by sub_matches_won desc, sub_matches_lost asc, seed) as global_rank
        from public.mlp_team_standings(p_tournament_id)
    ),
    guaranteed as (
      select team_id, pool_rank, pool_letter, global_rank
        from ranked
       where pool_rank <= v_top_per_pool
    ),
    leftovers as (
      select team_id, pool_rank, pool_letter, global_rank
        from ranked
       where pool_rank > v_top_per_pool
       order by global_rank
       limit greatest(v_remainder, 0)
    ),
    combined as (
      select team_id, pool_rank, pool_letter, global_rank from guaranteed
      union all
      select team_id, pool_rank, pool_letter, global_rank from leftovers
    )
    select array_agg(c.team_id order by c.pool_rank, c.global_rank)
      into v_advanced
      from combined c;

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

  -- When playoff_teams=2, also generate a Third Place Match
  -- between standings #3 and #4 (when at least 4 teams exist).
  if v_playoff_n = 2 then
    if v_format = 'round_robin_playoff' then
      select array_agg(s.team_id order by s.sub_matches_won desc, s.sub_matches_lost asc, s.seed)
        into v_third_pair
        from (
          select * from public.mlp_team_standings(p_tournament_id)
          order by sub_matches_won desc, sub_matches_lost asc, seed
          offset 2 limit 2
        ) s;
    else
      -- Pool play: take the 2nd-best from each pool as the 3rd-place contenders
      -- (mirrors the existing semi-seeding intuition).
      with ranked as (
        select team_id, pool_letter, sub_matches_won, sub_matches_lost, seed,
               row_number() over (partition by pool_letter
                                  order by sub_matches_won desc, sub_matches_lost asc, seed) as pool_rank
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
$$;

grant execute on function public._generate_mlp_playoff_unchecked(uuid) to authenticated;

notify pgrst, 'reload schema';
