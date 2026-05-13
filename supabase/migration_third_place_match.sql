-- ============================================================
-- "Top 2" playoff now includes a 3rd-place match
--
-- Previously, mlp_playoff_teams=2 generated only a Grand Final
-- (top 1 vs top 2). With this migration, it also generates a
-- separate "Third Place Match" between standings #3 and #4
-- (when at least 4 teams exist).
--
-- Structure for round_robin_playoff / pool_play_playoff with
-- mlp_playoff_teams=2:
--   • Round_type 'finals'             — top 1 vs top 2   → 1st / 2nd
--   • Round_type 'third_place_match'  — top 3 vs top 4   → 3rd / 4th
--
-- Both rounds contain the standard 4 MLP rotation sub-matches.
-- Auto-close waits for BOTH series to be decided. Payout
-- resolves 3rd / 4th places from the third_place_match winner
-- and loser respectively.
--
-- Run AFTER:
--   migration_mlp_auto_advance_playoff.sql
--   migration_tournament_auto_close_payout.sql
-- ============================================================


-- 1. CHECK constraint — allow the new round_type ------------------------
do $$
declare
  v_con text;
begin
  select conname into v_con
    from pg_constraint
   where conrelid = 'public.tournament_rounds'::regclass
     and contype  = 'c'
     and pg_get_constraintdef(oid) like '%round_type%';
  if v_con is not null then
    execute format('alter table public.tournament_rounds drop constraint %I', v_con);
  end if;
end $$;

alter table public.tournament_rounds
  add constraint tournament_rounds_round_type_check
  check (round_type in (
    'pool','winners','losers','quarterfinals','semifinals','finals',
    'consolation','third_place_match'
  ));


-- 2. Bracket generator — add third-place round for playoff_teams=2 ------
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
  v_i             integer;
  v_total_teams   integer;
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
    v_top_per_pool := greatest(1, v_playoff_n / v_pool_count);
    with ranked as (
      select team_id, pool_letter, sub_matches_won, sub_matches_lost, seed,
             row_number() over (partition by pool_letter
                                order by sub_matches_won desc, sub_matches_lost asc, seed) as pool_rank
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

  -- NEW: when playoff_teams=2, also generate a Third Place Match
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


-- 3. Auto-close trigger — wait for finals AND third_place_match to settle
create or replace function public._maybe_auto_close_mlp_tournament()
returns trigger language plpgsql security definer as $$
declare
  v_round_type  text;
  v_undecided   integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select round_type into v_round_type
    from public.tournament_rounds where id = new.round_id;
  if v_round_type not in ('finals', 'third_place_match') then return new; end if;

  begin
    -- A playoff round is "decided" when one team has > half rotation wins
    -- OR every rotation has been completed (the latter handles 2-2 ties).
    select count(*) into v_undecided
      from public.tournament_rounds tr
      join lateral public._mlp_round_series_state(tr.id) s on true
     where tr.tournament_id = new.tournament_id
       and tr.round_type in ('finals', 'third_place_match')
       and not (
         s.a_wins > s.total_matches / 2
         or s.b_wins > s.total_matches / 2
         or s.total_completed >= s.total_matches
       );

    if v_undecided = 0 then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status <> 'completed';
    end if;
  exception when others then
    null; -- never block the score update
  end;

  return new;
end;
$$;


-- 4. preview_mlp_tournament_payout — resolve 3rd from third_place_match,
--    4th from the third_place_match loser. Falls back to semifinal losers
--    when no third_place_match exists (for playoff_teams=4 etc.).
create or replace function public.preview_mlp_tournament_payout(p_tournament_id uuid)
returns table (
  place           integer,
  team_id         uuid,
  team_name       text,
  uids            uuid[],
  user_names      text[],
  pool_share      integer,
  share_per_user  integer,
  plupr_bonus     numeric(6,3)
) language plpgsql stable security definer as $$
declare
  v_pool       integer;
  v_structure  integer[];
  v_finals     record;
  v_third_m    record;
  v_winner     uuid;
  v_loser      uuid;
  v_winner_name text;
  v_loser_name  text;
  v_third_winner uuid;
  v_third_loser  uuid;
  v_third_winner_name text;
  v_third_loser_name  text;
  v_a_rr_diff  integer;
  v_b_rr_diff  integer;
  v_a_seed     integer;
  v_b_seed     integer;
  v_a_better   boolean;
  v_semi_third uuid[];
  v_semi_third_names text[];
begin
  select prize_pool, payout_structure into v_pool, v_structure
    from public.tournaments where id = p_tournament_id;
  if v_pool is null then v_pool := 0; end if;
  if v_structure is null then v_structure := '{60,25,15}'; end if;

  -- Finals series state
  select tr.id as round_id, s.*
    into v_finals
    from public.tournament_rounds tr
    join lateral public._mlp_round_series_state(tr.id) s on true
   where tr.tournament_id = p_tournament_id
     and tr.round_type = 'finals'
   order by tr.round_number desc
   limit 1;
  if v_finals.team_a_id is null then return; end if;

  -- Tiebreaker cascade for finals
  if v_finals.a_wins <> v_finals.b_wins then
    v_a_better := v_finals.a_wins > v_finals.b_wins;
  elsif (v_finals.a_points - v_finals.b_points) <> 0 then
    v_a_better := (v_finals.a_points - v_finals.b_points) > 0;
  else
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_a_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_a_id;
    select coalesce(s.sub_matches_won - s.sub_matches_lost, 0) into v_b_rr_diff
      from public.mlp_team_standings(p_tournament_id) s where s.team_id = v_finals.team_b_id;
    if coalesce(v_a_rr_diff, 0) <> coalesce(v_b_rr_diff, 0) then
      v_a_better := coalesce(v_a_rr_diff, 0) > coalesce(v_b_rr_diff, 0);
    else
      select t.seed into v_a_seed from public.mlp_teams t where t.id = v_finals.team_a_id;
      select t.seed into v_b_seed from public.mlp_teams t where t.id = v_finals.team_b_id;
      if coalesce(v_a_seed, 999) <> coalesce(v_b_seed, 999) then
        v_a_better := coalesce(v_a_seed, 999) < coalesce(v_b_seed, 999);
      else
        v_a_better := true;
      end if;
    end if;
  end if;

  if v_a_better then
    v_winner := v_finals.team_a_id; v_winner_name := v_finals.team_a_name;
    v_loser  := v_finals.team_b_id; v_loser_name  := v_finals.team_b_name;
  else
    v_winner := v_finals.team_b_id; v_winner_name := v_finals.team_b_name;
    v_loser  := v_finals.team_a_id; v_loser_name  := v_finals.team_a_name;
  end if;

  -- 1st place
  return query
    select 1, v_winner, v_winner_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_winner),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_winner),
           floor(v_pool * v_structure[1] / 100.0)::int,
           floor(floor(v_pool * v_structure[1] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_winner), 0), 1))::int,
           0.500::numeric(6,3);

  -- 2nd place
  if array_length(v_structure, 1) >= 2 then
    return query
    select 2, v_loser, v_loser_name,
           (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
              from public.mlp_teams where id = v_loser),
           (select array_agg(p.full_name order by p.full_name)
              from public.mlp_teams t
              join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
             where t.id = v_loser),
           floor(v_pool * v_structure[2] / 100.0)::int,
           floor(floor(v_pool * v_structure[2] / 100.0) /
                  coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                   from public.mlp_teams where id = v_loser), 0), 1))::int,
           0.250::numeric(6,3);
  end if;

  -- 3rd / 4th — prefer the explicit Third Place Match when it exists
  if array_length(v_structure, 1) >= 3 then
    select tr.id as round_id, s.*
      into v_third_m
      from public.tournament_rounds tr
      join lateral public._mlp_round_series_state(tr.id) s on true
     where tr.tournament_id = p_tournament_id
       and tr.round_type = 'third_place_match'
     order by tr.round_number desc
     limit 1;

    if v_third_m.team_a_id is not null then
      -- Same cascade as finals (rotation wins → points → fall back to seed)
      if v_third_m.a_wins <> v_third_m.b_wins then
        v_a_better := v_third_m.a_wins > v_third_m.b_wins;
      elsif (v_third_m.a_points - v_third_m.b_points) <> 0 then
        v_a_better := (v_third_m.a_points - v_third_m.b_points) > 0;
      else
        select t.seed into v_a_seed from public.mlp_teams t where t.id = v_third_m.team_a_id;
        select t.seed into v_b_seed from public.mlp_teams t where t.id = v_third_m.team_b_id;
        v_a_better := coalesce(v_a_seed, 999) < coalesce(v_b_seed, 999);
      end if;

      if v_a_better then
        v_third_winner := v_third_m.team_a_id; v_third_winner_name := v_third_m.team_a_name;
        v_third_loser  := v_third_m.team_b_id; v_third_loser_name  := v_third_m.team_b_name;
      else
        v_third_winner := v_third_m.team_b_id; v_third_winner_name := v_third_m.team_b_name;
        v_third_loser  := v_third_m.team_a_id; v_third_loser_name  := v_third_m.team_a_name;
      end if;

      return query
      select 3, v_third_winner, v_third_winner_name,
             (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
                from public.mlp_teams where id = v_third_winner),
             (select array_agg(p.full_name order by p.full_name)
                from public.mlp_teams t
                join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
               where t.id = v_third_winner),
             floor(v_pool * v_structure[3] / 100.0)::int,
             floor(floor(v_pool * v_structure[3] / 100.0) /
                    coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                     from public.mlp_teams where id = v_third_winner), 0), 1))::int,
             0.100::numeric(6,3);

      -- 4th place — the third_place_match loser, if structure has a 4th slot
      if array_length(v_structure, 1) >= 4 then
        return query
        select 4, v_third_loser, v_third_loser_name,
               (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
                  from public.mlp_teams where id = v_third_loser),
               (select array_agg(p.full_name order by p.full_name)
                  from public.mlp_teams t
                  join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
                 where t.id = v_third_loser),
               floor(v_pool * v_structure[4] / 100.0)::int,
               floor(floor(v_pool * v_structure[4] / 100.0) /
                      coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                       from public.mlp_teams where id = v_third_loser), 0), 1))::int,
               0.050::numeric(6,3);
      end if;
    else
      -- Fallback: tied semifinal losers (existing behavior for playoff_teams=4)
      with semi_state as (
        select s.* from public.tournament_rounds tr
          join lateral public._mlp_round_series_state(tr.id) s on true
         where tr.tournament_id = p_tournament_id
           and tr.round_type = 'semifinals'
      ),
      losers as (
        select
          case
            when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_id else team_a_id end)
            when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_id else team_a_id end)
            else team_b_id
          end as team_id,
          case
            when a_wins <> b_wins                       then (case when a_wins > b_wins then team_b_name else team_a_name end)
            when (a_points - b_points) <> 0             then (case when a_points > b_points then team_b_name else team_a_name end)
            else team_b_name
          end as team_name
          from semi_state
         where team_a_id is not null and team_b_id is not null
      )
      select array_agg(l.team_id), array_agg(l.team_name)
        into v_semi_third, v_semi_third_names
        from losers l;

      if v_semi_third is not null and array_length(v_semi_third, 1) > 0 then
        return query
        select 3, l.team_id, l.team_name,
               (select array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null)
                  from public.mlp_teams where id = l.team_id),
               (select array_agg(p.full_name order by p.full_name)
                  from public.mlp_teams t
                  join public.profiles p on p.id in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
                 where t.id = l.team_id),
               floor((v_pool * v_structure[3] / 100.0) / array_length(v_semi_third, 1))::int,
               floor(floor((v_pool * v_structure[3] / 100.0) / array_length(v_semi_third, 1)) /
                      coalesce(nullif((select array_length(array_remove(array[male_1_id, male_2_id, female_1_id, female_2_id], null), 1)
                                       from public.mlp_teams where id = l.team_id), 0), 1))::int,
               0.100::numeric(6,3)
          from (
            select unnest(v_semi_third) as team_id, unnest(v_semi_third_names) as team_name
          ) l;
      end if;
    end if;
  end if;
end;
$$;


-- 5. Grants --------------------------------------------------------------
grant execute on function public._generate_mlp_playoff_unchecked(uuid) to authenticated;
grant execute on function public.preview_mlp_tournament_payout(uuid)   to authenticated;

notify pgrst, 'reload schema';
