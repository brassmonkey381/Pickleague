-- ============================================================
-- Fix for: function result type must be integer because of OUT parameters.
--
-- The first version of _insert_mlp_pairing_matches used `INOUT integer`
-- alongside `returns void`, which Postgres rejects. Refactor to a plain
-- IN parameter + `returns integer` (returns the new match_order after
-- the 4 inserts). Both callers updated.
-- ============================================================


-- 1. Helper: insert the 4 sub-matches for a team-vs-team pairing.
--    Takes the starting match_order, returns the new max (start + 4).
-- ----------------------------------------------------------------------
drop function if exists public._insert_mlp_pairing_matches(uuid, uuid, record, record, integer);

create or replace function public._insert_mlp_pairing_matches(
  p_tournament_id uuid,
  p_round_id      uuid,
  p_team_a        record,
  p_team_b        record,
  p_start_order   integer
) returns integer
language plpgsql as $$
declare
  v_order integer := p_start_order;
begin
  -- 1. Men's
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.male_1_id, p_team_a.male_2_id, p_team_b.male_1_id, p_team_b.male_2_id
  );
  -- 2. Women's
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.female_1_id, p_team_a.female_2_id, p_team_b.female_1_id, p_team_b.female_2_id
  );
  -- 3. Mixed 1
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.male_1_id, p_team_a.female_1_id, p_team_b.male_1_id, p_team_b.female_1_id
  );
  -- 4. Mixed 2
  v_order := v_order + 1;
  insert into public.tournament_matches (
    tournament_id, round_id, match_order, match_type, status,
    team1_player1, team1_player2, team2_player1, team2_player2
  ) values (
    p_tournament_id, p_round_id, v_order, 'doubles', 'pending',
    p_team_a.male_2_id, p_team_a.female_2_id, p_team_b.male_2_id, p_team_b.female_2_id
  );

  return v_order;
end;
$$;


-- 2. generate_mlp_bracket — branches on mlp_play_format. Same body as
--    the format migration, but uses the new helper signature.
-- ----------------------------------------------------------------------
create or replace function public.generate_mlp_bracket(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_uid           uuid := auth.uid();
  v_format        text;
  v_pool_count    integer;
  v_team_count    integer;
  v_matches       integer := 0;
  v_team_a        record;
  v_team_b        record;
  v_round_id      uuid;
  v_round_no      integer := 0;
  v_match_order   integer := 0;
  v_pool_idx      integer;
  v_pool_letter   text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can generate the bracket';
  end if;

  select coalesce(mlp_play_format, 'round_robin'),
         coalesce(mlp_pool_count, 2)
    into v_format, v_pool_count
    from public.tournaments where id = p_tournament_id;

  select count(*) into v_team_count
    from public.mlp_teams
   where tournament_id = p_tournament_id and status = 'locked';

  if v_team_count < 2 then
    raise exception 'Need at least 2 locked teams (got %)', v_team_count;
  end if;

  delete from public.tournament_matches where tournament_id = p_tournament_id;
  delete from public.tournament_rounds   where tournament_id = p_tournament_id;

  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams
     where tournament_id = p_tournament_id and status = 'locked'
  )
  update public.mlp_teams t set seed = s.rn from seeded s where t.id = s.id;

  if v_format in ('round_robin', 'round_robin_playoff') then
    for v_team_a in (
      select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id
        from public.mlp_teams
       where tournament_id = p_tournament_id and status = 'locked'
       order by seed
    ) loop
      for v_team_b in (
        select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id
          from public.mlp_teams
         where tournament_id = p_tournament_id and status = 'locked'
           and seed > v_team_a.seed
         order by seed
      ) loop
        v_round_no := v_round_no + 1;
        insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (p_tournament_id, v_round_no, format('%s vs %s', v_team_a.name, v_team_b.name), 'winners')
        returning id into v_round_id;

        v_match_order := public._insert_mlp_pairing_matches(p_tournament_id, v_round_id, v_team_a, v_team_b, v_match_order);
        v_matches := v_matches + 4;
      end loop;
    end loop;
  else
    if v_team_count < v_pool_count * 2 then
      raise exception 'Need at least % teams (% per pool) for % pools (got %)',
        v_pool_count * 2, 2, v_pool_count, v_team_count;
    end if;
    for v_pool_idx in 0..(v_pool_count - 1) loop
      v_pool_letter := chr(65 + v_pool_idx);
      for v_team_a in (
        select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id,
               ((case
                  when ((seed - 1) % (v_pool_count * 2)) < v_pool_count
                    then ((seed - 1) % (v_pool_count * 2))
                  else  (v_pool_count * 2 - 1) - ((seed - 1) % (v_pool_count * 2))
                end)) as pool_idx
          from public.mlp_teams
         where tournament_id = p_tournament_id and status = 'locked'
         order by seed
      ) loop
        if v_team_a.pool_idx <> v_pool_idx then continue; end if;
        for v_team_b in (
          select id, name, seed, male_1_id, male_2_id, female_1_id, female_2_id,
                 ((case
                    when ((seed - 1) % (v_pool_count * 2)) < v_pool_count
                      then ((seed - 1) % (v_pool_count * 2))
                    else  (v_pool_count * 2 - 1) - ((seed - 1) % (v_pool_count * 2))
                  end)) as pool_idx
            from public.mlp_teams
           where tournament_id = p_tournament_id and status = 'locked'
             and seed > v_team_a.seed
           order by seed
        ) loop
          if v_team_b.pool_idx <> v_pool_idx then continue; end if;
          v_round_no := v_round_no + 1;
          insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
          values (
            p_tournament_id, v_round_no,
            format('Pool %s · %s vs %s', v_pool_letter, v_team_a.name, v_team_b.name),
            'pool'
          )
          returning id into v_round_id;

          v_match_order := public._insert_mlp_pairing_matches(p_tournament_id, v_round_id, v_team_a, v_team_b, v_match_order);
          v_matches := v_matches + 4;
        end loop;
      end loop;
    end loop;
  end if;

  update public.tournaments set status = 'active'
   where id = p_tournament_id and status = 'registration';

  return v_matches;
end;
$$;

grant execute on function public.generate_mlp_bracket(uuid) to authenticated;


-- 3. generate_mlp_playoff — same body as the format migration, new helper signature.
-- ----------------------------------------------------------------------
create or replace function public.generate_mlp_playoff(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_uid           uuid := auth.uid();
  v_format        text;
  v_pool_count    integer;
  v_playoff_n     integer;
  v_uncompleted   integer;
  v_advanced      uuid[];
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
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can advance to playoffs';
  end if;

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
       and round_type in ('quarterfinals', 'semifinals', 'finals')
  ) then
    raise exception 'Playoff already generated. Delete it manually before re-running.';
  end if;

  if v_format = 'round_robin_playoff' then
    select array_agg(team_id order by sub_matches_won desc, sub_matches_lost asc, seed)
      into v_advanced
      from (
        select * from public.mlp_team_standings(p_tournament_id) limit v_playoff_n
      ) s;
  else
    v_top_per_pool := greatest(1, v_playoff_n / v_pool_count);
    with ranked as (
      select team_id, pool_letter, sub_matches_won, sub_matches_lost, seed,
             row_number() over (partition by pool_letter
                                order by sub_matches_won desc, sub_matches_lost asc, seed) as pool_rank
        from public.mlp_team_standings(p_tournament_id)
    )
    select array_agg(team_id order by pool_rank, pool_letter)
      into v_advanced
      from ranked where pool_rank <= v_top_per_pool;
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

  return v_matches;
end;
$$;

grant execute on function public.generate_mlp_playoff(uuid) to authenticated;
