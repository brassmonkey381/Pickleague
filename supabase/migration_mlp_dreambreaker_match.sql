-- ============================================================
-- MLP Dreambreaker — wire up the 5th sub-match.
--
-- PR #63 added mlp_teams.dreambreaker_player_id (captain's singles
-- pick). This migration finishes the loop:
--
--   1. Schema: tournament_matches.is_dreambreaker boolean (default false)
--      marks the 5th, singles, tiebreaker sub-match in a team meeting.
--      tournament_matches.status check now allows 'cancelled' so we can
--      mark the dreambreaker dead when the meeting is decided 3-1 / 4-0.
--
--   2. _insert_mlp_pairing_matches: after the 4 doubles sub-matches,
--      insert a 5th singles row when BOTH teams have set their
--      dreambreaker_player_id. If either is missing, skip the row —
--      the meeting will lock to 2-2 at worst.
--
--   3. _settle_mlp_dreambreaker: AFTER UPDATE OF status trigger on
--      tournament_matches. When a non-dreambreaker sub-match in a
--      round completes:
--        * If one team has ≥3 (non-dreambreaker) wins → cancel the
--          dreambreaker so it doesn't get played.
--        * If 2-2 after all 4 doubles → leave the dreambreaker as
--          'pending' (it'll get played normally).
--
--   4. _maybe_auto_advance_mlp_playoff + _generate_mlp_playoff_unchecked:
--      tighten the "uncompleted" filter to exclude cancelled rows so a
--      cancelled dreambreaker in a pool/RR round doesn't block the
--      auto-advance into the playoff bracket.
--
-- Standings are already correct — mlp_team_standings counts each
-- completed sub-match where any roster player appears, so a played
-- dreambreaker naturally folds into "winning team gets 3 sub-match
-- wins to clinch." Cancelled rows are skipped (m.status = 'completed').
-- ============================================================


-- 1. Schema --------------------------------------------------------------
alter table public.tournament_matches
  add column if not exists is_dreambreaker boolean not null default false;

-- Allow 'cancelled' alongside the existing statuses.
do $$
declare
  v_con text;
begin
  select conname into v_con
    from pg_constraint
   where conrelid = 'public.tournament_matches'::regclass
     and contype  = 'c'
     and conname  = 'tournament_matches_status_check';
  if v_con is not null then
    execute format('alter table public.tournament_matches drop constraint %I', v_con);
  end if;
end $$;

alter table public.tournament_matches
  add constraint tournament_matches_status_check
  check (status in ('pending','in_progress','completed','cancelled'));


-- 2. _insert_mlp_pairing_matches — append the dreambreaker row -----------
-- The function still accepts records and returns the new match_order.
-- After the 4 doubles inserts, we look up both teams' dreambreaker_player_id
-- (the record args may not carry the column, so we re-fetch by id) and
-- only insert the 5th row when BOTH are set.
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
  v_db_a  uuid;
  v_db_b  uuid;
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

  -- 5. Dreambreaker (singles). Only when BOTH captains have picked.
  select dreambreaker_player_id into v_db_a from public.mlp_teams where id = p_team_a.id;
  select dreambreaker_player_id into v_db_b from public.mlp_teams where id = p_team_b.id;
  if v_db_a is not null and v_db_b is not null then
    v_order := v_order + 1;
    insert into public.tournament_matches (
      tournament_id, round_id, match_order, match_type, status,
      team1_player1, team1_player2, team2_player1, team2_player2,
      is_dreambreaker
    ) values (
      p_tournament_id, p_round_id, v_order, 'singles', 'pending',
      v_db_a, null, v_db_b, null,
      true
    );
  end if;

  return v_order;
end;
$$;


-- 3. _settle_mlp_dreambreaker — cancel the 5th sub-match when the
--    meeting is already decided 3-1 or 4-0. AFTER UPDATE OF status.
--    Wrapped in EXCEPTION block so a hiccup never blocks the score
--    update that fired the trigger.
create or replace function public._settle_mlp_dreambreaker()
returns trigger language plpgsql security definer as $$
declare
  v_a_wins      integer;
  v_b_wins      integer;
  v_db_match_id uuid;
  v_db_status   text;
begin
  -- Only act on transitions into 'completed' on a NON-dreambreaker row.
  if new.status <> 'completed' then return new; end if;
  if new.is_dreambreaker then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    -- The dreambreaker (if any) for this round.
    select id, status into v_db_match_id, v_db_status
      from public.tournament_matches
     where round_id = new.round_id
       and is_dreambreaker = true
     limit 1;
    if v_db_match_id is null then return new; end if;
    -- Already settled / in play? Leave it alone.
    if v_db_status <> 'pending' then return new; end if;

    -- Count doubles-row wins per side. _insert_mlp_pairing_matches
    -- always inserts every doubles row with team A on team1 and team B
    -- on team2, so winner_team is a faithful per-side tally for the
    -- meeting.
    select
      count(*) filter (where status = 'completed' and winner_team = 'team1')::int,
      count(*) filter (where status = 'completed' and winner_team = 'team2')::int
      into v_a_wins, v_b_wins
      from public.tournament_matches
     where round_id = new.round_id
       and is_dreambreaker = false;

    if v_a_wins >= 3 or v_b_wins >= 3 then
      -- Meeting decided 3-1 or 4-0. The dreambreaker is moot.
      update public.tournament_matches
         set status = 'cancelled'
       where id = v_db_match_id
         and status = 'pending';
    end if;
    -- 2-2 with 4 done: leave the dreambreaker pending for the players.
  exception when others then
    null;  -- never block the parent update
  end;

  return new;
end;
$$;

drop trigger if exists on_mlp_submatch_settle_dreambreaker on public.tournament_matches;
create trigger on_mlp_submatch_settle_dreambreaker
  after update of status on public.tournament_matches
  for each row execute procedure public._settle_mlp_dreambreaker();


-- 4. Skip cancelled rows when checking "all pool/RR matches done?".
--    A cancelled dreambreaker in a pool/RR round (rare but possible)
--    shouldn't keep the playoff from auto-advancing.
create or replace function public._maybe_auto_advance_mlp_playoff()
returns trigger language plpgsql security definer as $$
declare
  v_format       text;
  v_uncompleted  integer;
  v_has_playoff  boolean;
  v_round_type   text;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select coalesce(mlp_play_format, 'round_robin') into v_format
    from public.tournaments where id = new.tournament_id;
  if v_format not in ('round_robin_playoff', 'pool_play_playoff') then return new; end if;

  select round_type into v_round_type
    from public.tournament_rounds where id = new.round_id;
  if v_round_type not in ('pool', 'winners') then return new; end if;

  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = new.tournament_id
     and tr.round_type in ('pool', 'winners')
     and tm.status not in ('completed', 'cancelled');
  if v_uncompleted > 0 then return new; end if;

  select exists (
    select 1 from public.tournament_rounds
     where tournament_id = new.tournament_id
       and round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
  ) into v_has_playoff;
  if v_has_playoff then return new; end if;

  begin
    perform public._generate_mlp_playoff_unchecked(new.tournament_id);
  exception when others then
    null;
  end;

  return new;
end;
$$;

-- Mirror the cancelled-skip in _generate_mlp_playoff_unchecked so the
-- manual "advance" RPC path agrees with the auto-advance trigger.
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
