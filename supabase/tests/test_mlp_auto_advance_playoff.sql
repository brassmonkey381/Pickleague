-- ============================================================
-- Tier-3 SQL tests for MLP playoff auto-advance:
--   public._generate_mlp_playoff_unchecked  (called directly + via trigger)
--   public._maybe_auto_advance_mlp_playoff  (AFTER trigger on
--                                             tournament_matches)
--
-- LIVE function under test is the version installed by
-- `migration_fix_mlp_playoff_divisor.sql` (which runs after
-- `migration_third_place_match.sql`):
--   * round_robin_playoff → top-K by global standings
--     (sub_matches_won desc, sub_matches_lost asc, seed)
--   * pool_play_playoff   → floor(K/pool_count) per pool, then the
--     remainder filled from global standings
--   * playoff_n = 2       → also generates a 'third_place_match' round
--   * Each team-vs-team pairing expands to EXACTLY 4 sub-matches
--     (men's, women's, mixed1, mixed2) via _insert_mlp_pairing_matches
--   * Outside-in pairing: seed v vs seed K-v+1
--
-- Coverage in this file:
--   Test 1  round_robin_playoff,  4 teams, playoff_teams=4
--           → Semifinals (2 rounds), 8 sub-matches, outside-in.
--           Driven by the AFTER trigger (not a direct call).
--   Test 2  round_robin_playoff,  8 teams, playoff_teams=8
--           → Quarterfinals (4 rounds), 16 sub-matches, outside-in.
--   Test 3  pool_play_playoff,    4 teams, 2 pools, playoff_teams=2
--           → Finals (top1 vs top2) + Third Place Match (#3 vs #4),
--           top-per-pool selection, 8 sub-matches total.
--   Test 4  round_robin_playoff,  6 teams, playoff_teams=8  (DIRTY:
--           locked-team count is NOT a clean power of 2 for the
--           requested bracket size). Documents/asserts actual
--           behavior: clamps to the 6 available teams, round_type
--           'winners', label "Playoff Round of 6", 3 pairings, 12
--           sub-matches.
--
-- Conventions (see supabase/tests/README.md):
--   * Each test wrapped in begin; … rollback; — nothing persists.
--   * gen_random_uuid() for every id (profiles, mlp_teams, matches).
--   * session_replication_role='replica' around auth.users + manual
--     profiles inserts so handle_new_user (which would insert a
--     profile missing the required gender) doesn't fire; flipped back
--     to 'origin' so the playoff trigger we test DOES fire.
--   * Scores 11-5 (winner>=11, margin>=2, cap 50).
--
-- DETERMINISM TRICK: generate_mlp_bracket seeds teams 1..N by
--   created_at, and in every group round the LOWER-seeded team is
--   team_a == team1 (team_b is always seed > team_a). So completing
--   EVERY group sub-match with winner_team='team1' makes the lower
--   seed win every sub-match → final standings == seed order exactly.
--   That makes the advancing set and the outside-in pairings fully
--   predictable. (We build the group stage by hand rather than calling
--   the auth-gated generate_mlp_bracket, which would reject our
--   no-auth.uid() test session.)
-- ============================================================


-- ────────────────────────────────────────────────────────────
--  Test 1: round_robin_playoff, 4 teams, playoff_teams=4
--          (driven through the AFTER trigger)
-- ────────────────────────────────────────────────────────────
begin;

do $test_1$
declare
  v_tid    uuid := gen_random_uuid();
  v_email  text := gen_random_uuid()::text;
  v_admin  uuid := gen_random_uuid();
  v_team   uuid;
  v_m1 uuid; v_m2 uuid; v_f1 uuid; v_f2 uuid;
  i        integer;
  v_seeds  uuid[];           -- seeds[k] = team id with seed k

  v_semi_rounds  integer;
  v_semi_matches integer;
  v_pair_1v4     integer;
  v_pair_2v3     integer;
  v_top_seed     uuid;
  v_bot_seed     uuid;
  v_round_id     uuid;
begin
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values (v_admin, 'admin-' || v_email || '@test.invalid');
  insert into public.profiles (id, username, full_name, gender)
    values (v_admin, 'mlp1_admin_' || substr(v_admin::text,1,8), 'MLP1 Admin', 'male');

  insert into public.tournaments
    (id, name, format, match_type, status, created_by,
     mlp_play_format, mlp_pool_count, mlp_playoff_teams)
  values
    (v_tid, 'MLP RR-Playoff 4t', 'mlp_random', 'doubles', 'active', v_admin,
     'round_robin_playoff', 2, 4);

  -- 4 teams, each 2M + 2W of distinct approved players.
  for i in 1..4 loop
    v_m1 := gen_random_uuid(); v_m2 := gen_random_uuid();
    v_f1 := gen_random_uuid(); v_f2 := gen_random_uuid();
    insert into auth.users (id, email) values
      (v_m1, 'm1-'||i||'-'||v_email||'@test.invalid'),
      (v_m2, 'm2-'||i||'-'||v_email||'@test.invalid'),
      (v_f1, 'f1-'||i||'-'||v_email||'@test.invalid'),
      (v_f2, 'f2-'||i||'-'||v_email||'@test.invalid');
    insert into public.profiles (id, username, full_name, gender) values
      (v_m1, 'm1_'||substr(v_m1::text,1,8), 'M1 T'||i, 'male'),
      (v_m2, 'm2_'||substr(v_m2::text,1,8), 'M2 T'||i, 'male'),
      (v_f1, 'f1_'||substr(v_f1::text,1,8), 'F1 T'||i, 'female'),
      (v_f2, 'f2_'||substr(v_f2::text,1,8), 'F2 T'||i, 'female');

    insert into public.tournament_registrations (tournament_id, user_id, status) values
      (v_tid, v_m1, 'approved'), (v_tid, v_m2, 'approved'),
      (v_tid, v_f1, 'approved'), (v_tid, v_f2, 'approved');

    insert into public.mlp_teams
      (tournament_id, name, status, is_random_generated,
       male_1_id, male_2_id, female_1_id, female_2_id, created_at)
    values
      (v_tid, 'Team '||i, 'locked', true, v_m1, v_m2, v_f1, v_f2,
       now() + (i || ' seconds')::interval)         -- deterministic seed order
    returning id into v_team;
    v_seeds[i] := v_team;
  end loop;

  set local session_replication_role = 'origin';

  -- Seed teams 1..N by created_at (matches generate_mlp_bracket).
  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams
     where tournament_id = v_tid and status = 'locked'
  )
  update public.mlp_teams t set seed = s.rn from seeded s where t.id = s.id;

  -- Build RR rounds + 4 sub-matches per pairing (lower seed = team1),
  -- inserted as 'pending' so we can flip them to 'completed' and let
  -- the AFTER trigger fire.
  declare
    ta record; tb record; v_rid uuid; v_rno int := 0;
  begin
    for ta in (select * from public.mlp_teams
                where tournament_id=v_tid and status='locked' order by seed) loop
      for tb in (select * from public.mlp_teams
                  where tournament_id=v_tid and status='locked' and seed > ta.seed
                  order by seed) loop
        v_rno := v_rno + 1;
        insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (v_tid, v_rno, format('%s vs %s', ta.name, tb.name), 'winners')
        returning id into v_rid;
        insert into public.tournament_matches
          (tournament_id, round_id, match_order, match_type, status,
           team1_player1, team1_player2, team2_player1, team2_player2)
        values
          (v_tid, v_rid, 1, 'doubles', 'pending', ta.male_1_id,  ta.male_2_id,  tb.male_1_id,  tb.male_2_id),
          (v_tid, v_rid, 2, 'doubles', 'pending', ta.female_1_id,ta.female_2_id,tb.female_1_id,tb.female_2_id),
          (v_tid, v_rid, 3, 'doubles', 'pending', ta.male_1_id,  ta.female_1_id,tb.male_1_id,  tb.female_1_id),
          (v_tid, v_rid, 4, 'doubles', 'pending', ta.male_2_id,  ta.female_2_id,tb.male_2_id,  tb.female_2_id);
      end loop;
    end loop;
  end;

  -- 4 teams RR = C(4,2)=6 rounds × 4 = 24 sub-matches. Complete them ALL
  -- with team1 winning → standings == seed order. The trigger fires and
  -- generates the playoff.
  update public.tournament_matches
     set team1_score = 11, team2_score = 5, winner_team = 'team1', status = 'completed'
   where tournament_id = v_tid;

  -- ── Assertions ───────────────────────────────────────────
  -- 4 advancing → label 'Semifinals', round_type 'semifinals',
  -- 2 rounds (4/2), each 4 sub-matches → 8 total.
  select count(*) into v_semi_rounds
    from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'semifinals';
  assert v_semi_rounds = 2,
    format('Test 1: expected 2 semifinals rounds, got %s', v_semi_rounds);

  select count(*) into v_semi_matches
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'semifinals';
  assert v_semi_matches = 8,
    format('Test 1: expected 8 semifinals sub-matches (2 pairings x 4), got %s', v_semi_matches);

  -- Each pairing has exactly 4 sub-matches.
  for v_round_id in
    (select id from public.tournament_rounds
      where tournament_id = v_tid and round_type = 'semifinals')
  loop
    if (select count(*) from public.tournament_matches where round_id = v_round_id) <> 4 then
      raise exception 'Test 1: a semifinals round did not expand to exactly 4 sub-matches';
    end if;
  end loop;

  -- Outside-in seeding (standings == seed order): seed1 vs seed4, seed2 vs seed3.
  v_top_seed := v_seeds[1];
  v_bot_seed := v_seeds[4];
  select count(*) into v_pair_1v4
    from public.tournament_rounds tr
   where tr.tournament_id = v_tid and tr.round_type = 'semifinals'
     and exists (
       select 1 from public.tournament_matches m
        where m.round_id = tr.id
          and m.team1_player1 = (select male_1_id from public.mlp_teams where id = v_top_seed)
          and m.team2_player1 = (select male_1_id from public.mlp_teams where id = v_bot_seed)
     );
  assert v_pair_1v4 = 1,
    'Test 1: expected one Semifinals pairing seed1 vs seed4 (outside-in)';

  select count(*) into v_pair_2v3
    from public.tournament_rounds tr
   where tr.tournament_id = v_tid and tr.round_type = 'semifinals'
     and exists (
       select 1 from public.tournament_matches m
        where m.round_id = tr.id
          and m.team1_player1 = (select male_1_id from public.mlp_teams where id = v_seeds[2])
          and m.team2_player1 = (select male_1_id from public.mlp_teams where id = v_seeds[3])
     );
  assert v_pair_2v3 = 1,
    'Test 1: expected one Semifinals pairing seed2 vs seed3 (outside-in)';

  -- No third_place_match (only generated when playoff_teams=2).
  assert (select count(*) from public.tournament_rounds
           where tournament_id = v_tid and round_type='third_place_match') = 0,
    'Test 1: third_place_match should NOT exist for playoff_teams=4';

  raise notice 'Test 1: PASS — RR-playoff 4t via trigger → 2 Semifinals (1v4, 2v3), 8 sub-matches.';
end
$test_1$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test 2: round_robin_playoff, 8 teams, playoff_teams=8
--          (direct call to _generate_mlp_playoff_unchecked)
-- ────────────────────────────────────────────────────────────
begin;

do $test_2$
declare
  v_tid    uuid := gen_random_uuid();
  v_email  text := gen_random_uuid()::text;
  v_admin  uuid := gen_random_uuid();
  v_team   uuid;
  v_m1 uuid; v_m2 uuid; v_f1 uuid; v_f2 uuid;
  i        integer;
  v_seeds  uuid[];
  v_made   integer;

  v_qf_rounds  integer;
  v_qf_matches integer;
  v_pairs_ok   integer;
begin
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values (v_admin, 'admin-' || v_email || '@test.invalid');
  insert into public.profiles (id, username, full_name, gender)
    values (v_admin, 'mlp2_admin_' || substr(v_admin::text,1,8), 'MLP2 Admin', 'male');

  insert into public.tournaments
    (id, name, format, match_type, status, created_by,
     mlp_play_format, mlp_pool_count, mlp_playoff_teams)
  values
    (v_tid, 'MLP RR-Playoff 8t', 'mlp_random', 'doubles', 'active', v_admin,
     'round_robin_playoff', 2, 8);

  for i in 1..8 loop
    v_m1 := gen_random_uuid(); v_m2 := gen_random_uuid();
    v_f1 := gen_random_uuid(); v_f2 := gen_random_uuid();
    insert into auth.users (id, email) values
      (v_m1, 'm1-'||i||'-'||v_email||'@test.invalid'),
      (v_m2, 'm2-'||i||'-'||v_email||'@test.invalid'),
      (v_f1, 'f1-'||i||'-'||v_email||'@test.invalid'),
      (v_f2, 'f2-'||i||'-'||v_email||'@test.invalid');
    insert into public.profiles (id, username, full_name, gender) values
      (v_m1, 'm1_'||substr(v_m1::text,1,8), 'M1 T'||i, 'male'),
      (v_m2, 'm2_'||substr(v_m2::text,1,8), 'M2 T'||i, 'male'),
      (v_f1, 'f1_'||substr(v_f1::text,1,8), 'F1 T'||i, 'female'),
      (v_f2, 'f2_'||substr(v_f2::text,1,8), 'F2 T'||i, 'female');
    insert into public.tournament_registrations (tournament_id, user_id, status) values
      (v_tid, v_m1, 'approved'), (v_tid, v_m2, 'approved'),
      (v_tid, v_f1, 'approved'), (v_tid, v_f2, 'approved');
    insert into public.mlp_teams
      (tournament_id, name, status, is_random_generated,
       male_1_id, male_2_id, female_1_id, female_2_id, created_at)
    values
      (v_tid, 'Team '||i, 'locked', true, v_m1, v_m2, v_f1, v_f2,
       now() + (i || ' seconds')::interval)
    returning id into v_team;
    v_seeds[i] := v_team;
  end loop;

  set local session_replication_role = 'origin';

  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams where tournament_id = v_tid and status = 'locked'
  )
  update public.mlp_teams t set seed = s.rn from seeded s where t.id = s.id;

  -- Group stage inserted directly as 'completed' (no trigger fire on insert)
  -- so we can drive the direct unchecked call below.
  declare
    ta record; tb record; v_rid uuid; v_rno int := 0;
  begin
    for ta in (select * from public.mlp_teams
                where tournament_id=v_tid and status='locked' order by seed) loop
      for tb in (select * from public.mlp_teams
                  where tournament_id=v_tid and status='locked' and seed > ta.seed
                  order by seed) loop
        v_rno := v_rno + 1;
        insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (v_tid, v_rno, format('%s vs %s', ta.name, tb.name), 'winners')
        returning id into v_rid;
        insert into public.tournament_matches
          (tournament_id, round_id, match_order, match_type, status,
           team1_player1, team1_player2, team2_player1, team2_player2,
           team1_score, team2_score, winner_team)
        values
          (v_tid, v_rid, 1, 'doubles', 'completed', ta.male_1_id,  ta.male_2_id,  tb.male_1_id,  tb.male_2_id,  11,5,'team1'),
          (v_tid, v_rid, 2, 'doubles', 'completed', ta.female_1_id,ta.female_2_id,tb.female_1_id,tb.female_2_id,11,5,'team1'),
          (v_tid, v_rid, 3, 'doubles', 'completed', ta.male_1_id,  ta.female_1_id,tb.male_1_id,  tb.female_1_id,11,5,'team1'),
          (v_tid, v_rid, 4, 'doubles', 'completed', ta.male_2_id,  ta.female_2_id,tb.male_2_id,  tb.female_2_id,11,5,'team1');
      end loop;
    end loop;
  end;

  v_made := public._generate_mlp_playoff_unchecked(v_tid);

  -- ── Assertions ───────────────────────────────────────────
  -- 8 teams → Quarterfinals, 4 pairings, 16 sub-matches; return = 16.
  assert v_made = 16,
    format('Test 2: expected _generate_mlp_playoff_unchecked to return 16, got %s', v_made);

  select count(*) into v_qf_rounds
    from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'quarterfinals';
  assert v_qf_rounds = 4,
    format('Test 2: expected 4 quarterfinals rounds, got %s', v_qf_rounds);

  select count(*) into v_qf_matches
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals';
  assert v_qf_matches = 16,
    format('Test 2: expected 16 quarterfinals sub-matches, got %s', v_qf_matches);

  -- Each QF round = exactly 4 sub-matches.
  assert not exists (
    select 1 from public.tournament_rounds tr
     where tr.tournament_id = v_tid and tr.round_type='quarterfinals'
       and (select count(*) from public.tournament_matches m where m.round_id = tr.id) <> 4
  ), 'Test 2: every quarterfinals round must expand to exactly 4 sub-matches';

  -- Outside-in pairs: 1v8, 2v7, 3v6, 4v5 (standings == seed order).
  select count(*) into v_pairs_ok
    from (values (1,8),(2,7),(3,6),(4,5)) p(hi, lo)
   where exists (
     select 1 from public.tournament_rounds tr
      join public.tournament_matches m on m.round_id = tr.id
     where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals'
       and m.team1_player1 = (select male_1_id from public.mlp_teams where id = v_seeds[p.hi])
       and m.team2_player1 = (select male_1_id from public.mlp_teams where id = v_seeds[p.lo])
   );
  assert v_pairs_ok = 4,
    format('Test 2: expected all 4 outside-in pairs (1v8,2v7,3v6,4v5), matched %s', v_pairs_ok);

  raise notice 'Test 2: PASS — RR-playoff 8t → 4 Quarterfinals, 16 sub-matches, outside-in 1v8..4v5.';
end
$test_2$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test 3: pool_play_playoff, 4 teams, 2 pools, playoff_teams=2
--          → Finals (top1 vs top2) + Third Place Match (#3 vs #4)
-- ────────────────────────────────────────────────────────────
begin;

do $test_3$
declare
  v_tid    uuid := gen_random_uuid();
  v_email  text := gen_random_uuid()::text;
  v_admin  uuid := gen_random_uuid();
  v_team   uuid;
  v_m1 uuid; v_m2 uuid; v_f1 uuid; v_f2 uuid;
  i        integer;
  v_seeds  uuid[];
  v_made   integer;

  v_finals_rounds  integer;
  v_finals_matches integer;
  v_third_rounds   integer;
  v_third_matches  integer;
  v_finals_pair    integer;
begin
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values (v_admin, 'admin-' || v_email || '@test.invalid');
  insert into public.profiles (id, username, full_name, gender)
    values (v_admin, 'mlp3_admin_' || substr(v_admin::text,1,8), 'MLP3 Admin', 'male');

  insert into public.tournaments
    (id, name, format, match_type, status, created_by,
     mlp_play_format, mlp_pool_count, mlp_playoff_teams)
  values
    (v_tid, 'MLP Pool-Playoff 4t/2p', 'mlp_random', 'doubles', 'active', v_admin,
     'pool_play_playoff', 2, 2);

  for i in 1..4 loop
    v_m1 := gen_random_uuid(); v_m2 := gen_random_uuid();
    v_f1 := gen_random_uuid(); v_f2 := gen_random_uuid();
    insert into auth.users (id, email) values
      (v_m1, 'm1-'||i||'-'||v_email||'@test.invalid'),
      (v_m2, 'm2-'||i||'-'||v_email||'@test.invalid'),
      (v_f1, 'f1-'||i||'-'||v_email||'@test.invalid'),
      (v_f2, 'f2-'||i||'-'||v_email||'@test.invalid');
    insert into public.profiles (id, username, full_name, gender) values
      (v_m1, 'm1_'||substr(v_m1::text,1,8), 'M1 T'||i, 'male'),
      (v_m2, 'm2_'||substr(v_m2::text,1,8), 'M2 T'||i, 'male'),
      (v_f1, 'f1_'||substr(v_f1::text,1,8), 'F1 T'||i, 'female'),
      (v_f2, 'f2_'||substr(v_f2::text,1,8), 'F2 T'||i, 'female');
    insert into public.tournament_registrations (tournament_id, user_id, status) values
      (v_tid, v_m1, 'approved'), (v_tid, v_m2, 'approved'),
      (v_tid, v_f1, 'approved'), (v_tid, v_f2, 'approved');
    insert into public.mlp_teams
      (tournament_id, name, status, is_random_generated,
       male_1_id, male_2_id, female_1_id, female_2_id, created_at)
    values
      (v_tid, 'Team '||i, 'locked', true, v_m1, v_m2, v_f1, v_f2,
       now() + (i || ' seconds')::interval)
    returning id into v_team;
    v_seeds[i] := v_team;
  end loop;

  set local session_replication_role = 'origin';

  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams where tournament_id = v_tid and status = 'locked'
  )
  update public.mlp_teams t set seed = s.rn from seeded s where t.id = s.id;

  -- pool_count=2, 4 teams → pool window = 2*2 = 4. Snake pool_idx:
  --   pidx = case (seed-1)%4 < 2 then (seed-1)%4 else 3-((seed-1)%4)
  --   seed1→0(A), seed2→1(B), seed3→1(B), seed4→0(A).
  -- Pool A = {seed1, seed4}; Pool B = {seed2, seed3}.
  -- Lower seed = team1; make team1 win both pool finals → standings:
  --   Pool A: seed1(4w) > seed4(0); Pool B: seed2(4w) > seed3(0).
  -- top_per_pool = floor(K/pool_count) = floor(2/2) = 1 → {seed1, seed2}.
  -- remainder = 2 - 1*2 = 0. Finals outside-in over [seed1, seed2] → seed1 v seed2.
  -- Third place (playoff_n=2, pool variant): pool_rank=2 per pool ordered by
  --   pool_letter → {seed4 (A#2), seed3 (B#2)}.
  declare
    ta record; tb record; v_rid uuid; v_rno int := 0;
    v_pool text; v_pidx int;
  begin
    for v_pidx in 0..1 loop
      v_pool := chr(65 + v_pidx);
      for ta in (
        select *, (case when ((seed-1)%4) < 2 then ((seed-1)%4) else 3-((seed-1)%4) end) as pidx
          from public.mlp_teams where tournament_id=v_tid and status='locked' order by seed
      ) loop
        if ta.pidx <> v_pidx then continue; end if;
        for tb in (
          select *, (case when ((seed-1)%4) < 2 then ((seed-1)%4) else 3-((seed-1)%4) end) as pidx
            from public.mlp_teams where tournament_id=v_tid and status='locked' and seed > ta.seed order by seed
        ) loop
          if tb.pidx <> v_pidx then continue; end if;
          v_rno := v_rno + 1;
          insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
          values (v_tid, v_rno, format('Pool %s · %s vs %s', v_pool, ta.name, tb.name), 'pool')
          returning id into v_rid;
          insert into public.tournament_matches
            (tournament_id, round_id, match_order, match_type, status,
             team1_player1, team1_player2, team2_player1, team2_player2,
             team1_score, team2_score, winner_team)
          values
            (v_tid, v_rid, 1, 'doubles', 'completed', ta.male_1_id,  ta.male_2_id,  tb.male_1_id,  tb.male_2_id,  11,5,'team1'),
            (v_tid, v_rid, 2, 'doubles', 'completed', ta.female_1_id,ta.female_2_id,tb.female_1_id,tb.female_2_id,11,5,'team1'),
            (v_tid, v_rid, 3, 'doubles', 'completed', ta.male_1_id,  ta.female_1_id,tb.male_1_id,  tb.female_1_id,11,5,'team1'),
            (v_tid, v_rid, 4, 'doubles', 'completed', ta.male_2_id,  ta.female_2_id,tb.male_2_id,  tb.female_2_id,11,5,'team1');
        end loop;
      end loop;
    end loop;
  end;

  v_made := public._generate_mlp_playoff_unchecked(v_tid);

  -- ── Assertions ───────────────────────────────────────────
  -- playoff_n=2 → Finals (2 advancing = 1 pairing) + Third Place Match.
  -- Finals=4 subs, 3PM=4 subs → return 8.
  assert v_made = 8,
    format('Test 3: expected return 8 (Finals 4 + Third Place 4), got %s', v_made);

  select count(*) into v_finals_rounds
    from public.tournament_rounds where tournament_id=v_tid and round_type='finals';
  assert v_finals_rounds = 1,
    format('Test 3: expected 1 finals round, got %s', v_finals_rounds);

  select count(*) into v_finals_matches
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='finals';
  assert v_finals_matches = 4,
    format('Test 3: expected 4 finals sub-matches, got %s', v_finals_matches);

  select count(*) into v_third_rounds
    from public.tournament_rounds where tournament_id=v_tid and round_type='third_place_match';
  assert v_third_rounds = 1,
    format('Test 3: expected 1 third_place_match round, got %s', v_third_rounds);

  select count(*) into v_third_matches
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='third_place_match';
  assert v_third_matches = 4,
    format('Test 3: expected 4 third_place_match sub-matches, got %s', v_third_matches);

  -- Finals must pair the two pool winners: seed1 (Pool A #1) vs seed2 (Pool B #1).
  select count(*) into v_finals_pair
    from public.tournament_rounds tr join public.tournament_matches m on m.round_id=tr.id
   where tr.tournament_id=v_tid and tr.round_type='finals'
     and (
       (m.team1_player1 = (select male_1_id from public.mlp_teams where id=v_seeds[1])
        and m.team2_player1 = (select male_1_id from public.mlp_teams where id=v_seeds[2]))
       or
       (m.team1_player1 = (select male_1_id from public.mlp_teams where id=v_seeds[2])
        and m.team2_player1 = (select male_1_id from public.mlp_teams where id=v_seeds[1]))
     );
  assert v_finals_pair = 1,
    'Test 3: Finals must pair the two pool winners (seed1 vs seed2)';

  raise notice 'Test 3: PASS — pool-playoff 4t/2p, K=2 → Finals (seed1 v seed2) + Third Place Match, 8 sub-matches.';
end
$test_3$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test 4: DIRTY — round_robin_playoff, 6 teams, playoff_teams=8
--          (locked-team count is NOT a clean power of 2 for the
--           requested bracket size). Documents actual behavior.
-- ────────────────────────────────────────────────────────────
begin;

do $test_4$
declare
  v_tid    uuid := gen_random_uuid();
  v_email  text := gen_random_uuid()::text;
  v_admin  uuid := gen_random_uuid();
  v_team   uuid;
  v_m1 uuid; v_m2 uuid; v_f1 uuid; v_f2 uuid;
  i        integer;
  v_seeds  uuid[];
  v_made   integer;

  v_winners_rounds   integer;
  v_winners_matches  integer;
  v_qf_sf_fin        integer;
begin
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values (v_admin, 'admin-' || v_email || '@test.invalid');
  insert into public.profiles (id, username, full_name, gender)
    values (v_admin, 'mlp4_admin_' || substr(v_admin::text,1,8), 'MLP4 Admin', 'male');

  insert into public.tournaments
    (id, name, format, match_type, status, created_by,
     mlp_play_format, mlp_pool_count, mlp_playoff_teams)
  values
    (v_tid, 'MLP RR-Playoff 6t (req 8)', 'mlp_random', 'doubles', 'active', v_admin,
     'round_robin_playoff', 2, 8);   -- request 8 but only 6 teams exist

  for i in 1..6 loop
    v_m1 := gen_random_uuid(); v_m2 := gen_random_uuid();
    v_f1 := gen_random_uuid(); v_f2 := gen_random_uuid();
    insert into auth.users (id, email) values
      (v_m1, 'm1-'||i||'-'||v_email||'@test.invalid'),
      (v_m2, 'm2-'||i||'-'||v_email||'@test.invalid'),
      (v_f1, 'f1-'||i||'-'||v_email||'@test.invalid'),
      (v_f2, 'f2-'||i||'-'||v_email||'@test.invalid');
    insert into public.profiles (id, username, full_name, gender) values
      (v_m1, 'm1_'||substr(v_m1::text,1,8), 'M1 T'||i, 'male'),
      (v_m2, 'm2_'||substr(v_m2::text,1,8), 'M2 T'||i, 'male'),
      (v_f1, 'f1_'||substr(v_f1::text,1,8), 'F1 T'||i, 'female'),
      (v_f2, 'f2_'||substr(v_f2::text,1,8), 'F2 T'||i, 'female');
    insert into public.tournament_registrations (tournament_id, user_id, status) values
      (v_tid, v_m1, 'approved'), (v_tid, v_m2, 'approved'),
      (v_tid, v_f1, 'approved'), (v_tid, v_f2, 'approved');
    insert into public.mlp_teams
      (tournament_id, name, status, is_random_generated,
       male_1_id, male_2_id, female_1_id, female_2_id, created_at)
    values
      (v_tid, 'Team '||i, 'locked', true, v_m1, v_m2, v_f1, v_f2,
       now() + (i || ' seconds')::interval)
    returning id into v_team;
    v_seeds[i] := v_team;
  end loop;

  set local session_replication_role = 'origin';

  with seeded as (
    select id, row_number() over (order by created_at) as rn
      from public.mlp_teams where tournament_id = v_tid and status = 'locked'
  )
  update public.mlp_teams t set seed = s.rn from seeded s where t.id = s.id;

  declare
    ta record; tb record; v_rid uuid; v_rno int := 0;
  begin
    for ta in (select * from public.mlp_teams
                where tournament_id=v_tid and status='locked' order by seed) loop
      for tb in (select * from public.mlp_teams
                  where tournament_id=v_tid and status='locked' and seed > ta.seed
                  order by seed) loop
        v_rno := v_rno + 1;
        insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (v_tid, v_rno, format('%s vs %s', ta.name, tb.name), 'winners')
        returning id into v_rid;
        insert into public.tournament_matches
          (tournament_id, round_id, match_order, match_type, status,
           team1_player1, team1_player2, team2_player1, team2_player2,
           team1_score, team2_score, winner_team)
        values
          (v_tid, v_rid, 1, 'doubles', 'completed', ta.male_1_id,  ta.male_2_id,  tb.male_1_id,  tb.male_2_id,  11,5,'team1'),
          (v_tid, v_rid, 2, 'doubles', 'completed', ta.female_1_id,ta.female_2_id,tb.female_1_id,tb.female_2_id,11,5,'team1'),
          (v_tid, v_rid, 3, 'doubles', 'completed', ta.male_1_id,  ta.female_1_id,tb.male_1_id,  tb.female_1_id,11,5,'team1'),
          (v_tid, v_rid, 4, 'doubles', 'completed', ta.male_2_id,  ta.female_2_id,tb.male_2_id,  tb.female_2_id,11,5,'team1');
      end loop;
    end loop;
  end;

  v_made := public._generate_mlp_playoff_unchecked(v_tid);

  -- ── DOCUMENTED BEHAVIOR ───────────────────────────────────
  -- Requested 8 but only 6 teams exist. round_robin_playoff does
  -- `LIMIT v_playoff_n` over standings → returns the 6 available.
  -- v_team_count = 6 (NOT a power of 2). The label CASE has no
  -- branch for 6, so:
  --   label      = 'Playoff Round of 6'
  --   round_type = 'winners'  (the CASE else branch)
  --   pairings   = 6/2 = 3  → 12 sub-matches; return = 12.
  -- i.e. the function CLAMPS to available teams and produces a
  -- non-power-of-2 "round of 6" rather than raising. This is a
  -- LATENT structural smell (see PR notes): a "round of 6" is not a
  -- valid single-elim round, and it reuses round_type 'winners' —
  -- the SAME type the group stage uses — which means the auto-advance
  -- gate ("all winners/pool matches complete") now also counts these
  -- playoff matches. Re-running generate would be blocked, and the
  -- "uncompleted" gate could mis-fire. We assert the current behavior
  -- so any future change to it is intentional and visible.
  assert v_made = 12,
    format('Test 4: expected return 12 (3 pairings x 4) for clamped 6-team bracket, got %s', v_made);

  select count(*) into v_winners_rounds
    from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'winners'
     and label like 'Playoff Round of 6%';
  assert v_winners_rounds = 3,
    format('Test 4: expected 3 playoff rounds labeled "Playoff Round of 6", got %s', v_winners_rounds);

  select count(*) into v_winners_matches
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id = v_tid and tr.round_type='winners'
     and tr.label like 'Playoff Round of 6%';
  assert v_winners_matches = 12,
    format('Test 4: expected 12 sub-matches across the clamped playoff, got %s', v_winners_matches);

  -- Confirm it did NOT mislabel as quarterfinals/semifinals/finals/3pm.
  select count(*) into v_qf_sf_fin
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type in ('quarterfinals','semifinals','finals','third_place_match');
  assert v_qf_sf_fin = 0,
    format('Test 4: clamped 6-team bracket should not create qf/sf/finals/3pm rounds, got %s', v_qf_sf_fin);

  -- Outside-in over 6: seed1 v seed6, seed2 v seed5, seed3 v seed4.
  assert (
    select count(*) from (values (1,6),(2,5),(3,4)) p(hi,lo)
     where exists (
       select 1 from public.tournament_rounds tr
        join public.tournament_matches m on m.round_id = tr.id
       where tr.tournament_id = v_tid and tr.round_type='winners'
         and tr.label like 'Playoff Round of 6%'
         and m.team1_player1 = (select male_1_id from public.mlp_teams where id = v_seeds[p.hi])
         and m.team2_player1 = (select male_1_id from public.mlp_teams where id = v_seeds[p.lo])
     )
  ) = 3, 'Test 4: expected outside-in pairs 1v6, 2v5, 3v4 in the clamped bracket';

  raise notice 'Test 4: PASS (documents behavior) — 6 locked teams w/ playoff_teams=8 CLAMPS to a non-power-of-2 "Playoff Round of 6" (round_type winners), 3 pairings, 12 sub-matches. Latent smell, see PR.';
end
$test_4$;

rollback;
