-- ============================================================
-- MLP playoff formats.
--
-- Adds a per-tournament `mlp_play_format` knob with four modes:
--   'round_robin'         — every team plays every team. Final by W-L.
--   'pool_play'           — split into pools, RR within pool, final by pool W-L.
--   'round_robin_playoff' — RR + top-N to single-elim playoff.
--   'pool_play_playoff'   — pool play + top-N per pool to single-elim.
--
-- Plus knobs:
--   mlp_pool_count           — pools count for pool_play[_playoff], default 2
--   mlp_playoff_teams        — total teams that advance to the playoff,
--                              default 4 (must be power of 2: 2 / 4 / 8)
--
-- generate_mlp_bracket branches on the format. For the _playoff variants
-- it ONLY generates the pool/RR rounds — the admin calls
-- generate_mlp_playoff after those matches complete.
-- ============================================================


-- 1. Schema --------------------------------------------------------------
alter table public.tournaments
  add column if not exists mlp_play_format text not null default 'round_robin'
    check (mlp_play_format in ('round_robin', 'pool_play', 'round_robin_playoff', 'pool_play_playoff')),
  add column if not exists mlp_pool_count   integer not null default 2
    check (mlp_pool_count between 2 and 8),
  add column if not exists mlp_playoff_teams integer not null default 4
    check (mlp_playoff_teams in (2, 4, 8));


-- 2. Internal: insert the 4 sub-matches for a team-vs-team pairing.
-- Takes the starting match_order, returns the new max (start + 4).
-- (Earlier draft used INOUT + returns void which Postgres rejects:
--  "function result type must be integer because of OUT parameters".)
-- ------------------------------------------------------------------------
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


-- 3. generate_mlp_bracket — branches on mlp_play_format ------------------
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
  v_team          record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can generate the bracket';
  end if;

  select mlp_play_format, mlp_pool_count
    into v_format, v_pool_count
    from public.tournaments where id = p_tournament_id;

  select count(*) into v_team_count
    from public.mlp_teams
   where tournament_id = p_tournament_id and status = 'locked';

  if v_team_count < 2 then
    raise exception 'Need at least 2 locked teams (got %)', v_team_count;
  end if;

  -- Wipe any prior generated rounds/matches.
  delete from public.tournament_matches where tournament_id = p_tournament_id;
  delete from public.tournament_rounds   where tournament_id = p_tournament_id;

  -- Seed teams in-order by created_at.
  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams
     where tournament_id = p_tournament_id and status = 'locked'
  )
  update public.mlp_teams t set seed = s.rn from seeded s where t.id = s.id;

  -- For pool variants: assign a pool letter (A, B, C, ...) via snake-draft.
  if v_format in ('pool_play', 'pool_play_playoff') then
    if v_team_count < v_pool_count * 2 then
      raise exception 'Need at least % teams (% per pool) for % pools (got %)',
        v_pool_count * 2, 2, v_pool_count, v_team_count;
    end if;
    -- Snake-assign each team to a pool. Result lives on tournament_rounds-style
    -- labels; we just need to know which teams are in which pool for the loop.
    -- We'll re-fetch with pool letter computed inline below.
  end if;

  if v_format in ('round_robin', 'round_robin_playoff') then
    -- Flat round-robin between all locked teams (existing behavior).
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
    -- Pool play. Walk every pair of teams in the SAME pool.
    -- Pool index = snake-draft from seed: seed 1→A, 2→B, ... , N→last, N+1→last, N+2→...
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

  -- Activate the tournament so the schedule UI renders.
  update public.tournaments set status = 'active'
   where id = p_tournament_id and status = 'registration';

  return v_matches;
end;
$$;

grant execute on function public.generate_mlp_bracket(uuid) to authenticated;


-- 4. mlp_team_standings — sub-matches won per team (sorted) -------------
-- Used by the playoff advance flow + the UI's standings view.
create or replace function public.mlp_team_standings(p_tournament_id uuid)
returns table (
  team_id        uuid,
  team_name      text,
  seed           integer,
  pool_letter    text,
  sub_matches_won  integer,
  sub_matches_lost integer
) language plpgsql security definer as $$
declare
  v_format     text;
  v_pool_count integer;
begin
  select mlp_play_format, mlp_pool_count
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
          else  (v_pool_count * 2 - 1) - ((seed - 1) % (v_pool_count * 2))
        end)))
      else null end as pool_letter,
      t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id
    from public.mlp_teams t
    where t.tournament_id = p_tournament_id and t.status = 'locked'
  ),
  match_wins as (
    -- For each completed tournament match, count which team-of-MLP won
    -- (by checking if any of that team's roster IDs appears on the winning side).
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


-- 5. generate_mlp_playoff — admin advances top teams to single-elim ------
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
  v_round_no      integer;
  v_match_order   integer := 0;
  v_matches       integer := 0;
  v_label         text;
  v_team_count    integer;
  v_top_per_pool  integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public._is_tournament_admin(p_tournament_id, v_uid) then
    raise exception 'Only tournament admins can advance to playoffs';
  end if;

  select mlp_play_format, mlp_pool_count, mlp_playoff_teams
    into v_format, v_pool_count, v_playoff_n
    from public.tournaments where id = p_tournament_id;

  if v_format not in ('round_robin_playoff', 'pool_play_playoff') then
    raise exception 'Tournament format % does not include a playoff stage', v_format;
  end if;

  -- All pool/RR matches must be completed.
  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = p_tournament_id
     and tr.round_type in ('pool', 'winners')
     and tm.status <> 'completed';
  if v_uncompleted > 0 then
    raise exception 'Cannot advance — % pool/round-robin matches still pending', v_uncompleted;
  end if;

  -- Don't allow re-generation if a playoff already exists.
  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type in ('quarterfinals', 'semifinals', 'finals')
  ) then
    raise exception 'Playoff already generated. Delete it manually before re-running.';
  end if;

  -- Determine advancing teams.
  if v_format = 'round_robin_playoff' then
    select array_agg(team_id order by sub_matches_won desc, sub_matches_lost asc, seed)
      into v_advanced
      from public.mlp_team_standings(p_tournament_id)
     limit v_playoff_n;
  else
    -- Pool play: top N per pool, then concatenate, alternating pools for seeding.
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
    -- Trim to v_playoff_n in case integer rounding left one extra.
    if array_length(v_advanced, 1) > v_playoff_n then
      v_advanced := v_advanced[1:v_playoff_n];
    end if;
  end if;

  v_team_count := coalesce(array_length(v_advanced, 1), 0);
  if v_team_count < 2 then
    raise exception 'Not enough teams to seed a playoff (got %)', v_team_count;
  end if;

  -- Round-1 pairings: 1 vs N, 2 vs N-1, ...
  -- Round label: quarterfinals when 8 teams, semifinals when 4, finals when 2.
  v_round_no := 1000;  -- offset so playoff rounds come after pool/RR
  v_label := case v_team_count
    when 8 then 'Quarterfinals'
    when 4 then 'Semifinals'
    when 2 then 'Finals'
    else format('Playoff Round of %s', v_team_count)
  end;

  -- Insert ONE round per round-1 matchup so the schedule groups read naturally.
  for v_team_count in (
    select count(*) as c from generate_series(1, array_length(v_advanced, 1) / 2)
  ) loop null; end loop;

  v_team_count := array_length(v_advanced, 1);
  for v_round_no in 0..(v_team_count / 2 - 1) loop
    -- Look up the two teams' full rows for the pairing-insert helper.
    select * into v_team_a from public.mlp_teams where id = v_advanced[v_round_no + 1];
    select * into v_team_b from public.mlp_teams where id = v_advanced[v_team_count - v_round_no];

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (
      p_tournament_id,
      1000 + v_round_no + 1,
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
