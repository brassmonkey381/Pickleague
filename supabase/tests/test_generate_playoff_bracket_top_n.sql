-- ============================================================
-- Tier-3 SQL tests for `public.generate_playoff_bracket` — Top-N coverage.
--
-- Extends `test_generate_playoff_bracket.sql` (Tests A/B cover top_4 and
-- top_2 with 4 singles entrants in round_robin). This file adds:
--
--   Test C: top_8, singles, round_robin, 8 entrants
--           -> one 'quarterfinals' round with 4 matches seeded
--              1v8 / 2v7 / 3v6 / 4v5 (outside-in), return value 4.
--   Test D: top_8, singles, pool_play (round_type='pool'), 8 entrants
--           -> identical flat-standings result (4 QF matches). Confirms
--              the flat top-N branch ignores pool labels.
--   Test E: top_4, doubles, round_robin, 4 teams (8 players)
--           -> one 'semifinals' round with 2 matches; verifies the
--              (lo,hi) doubles standings key and that each playoff match
--              carries both players of a seeded team.
--   Test F: idempotency — a second call to generate_playoff_bracket is a
--           no-op that raises 'Playoff already generated.' and does NOT
--           duplicate rounds.
--   Test G: pending group-play matches -> generate_playoff_bracket raises
--           'Cannot advance — N group-play matches still pending'.
--
-- Each test is wrapped in `begin … rollback`. Assertions raise
-- `assert_failure` and abort the transaction; a clean run prints `ROLLBACK`
-- and no error.
--
-- Setup notes (same as test_generate_playoff_bracket.sql):
--   * We flip session_replication_role to 'replica' around the auth.users +
--     manual profiles inserts so handle_new_user() (which would insert a
--     profiles row missing the required `gender`) doesn't fire; then back to
--     'origin' so playoff-related triggers can fire.
--   * Requires connecting as a role that may set session_replication_role
--     (the postgres role or the MCP service_role; plain `authenticated`
--     can't).
--   * Scores 11-5 satisfy tournament_matches_score_sanity_check
--     (winner >= 11, win-by-2, cap 50).
--
-- Standings tiebreaker: wins desc -> (H2H on 2-way ties) -> point_diff desc
-- -> seed asc. To make standings deterministic and equal to registration
-- seeds, every test rigs a STRICT, DISTINCT wins ladder (no 2-way wins
-- ties), so the H2H branch is never decisive and standings == seeds.
--
-- See `supabase/tests/README.md` for how to run.
-- ============================================================


-- ────────────────────────────────────────────────────────────
--  Test C: top_8, singles, round_robin, 8 entrants
-- ────────────────────────────────────────────────────────────
begin;

do $test_c$
declare
  v_tid       uuid := gen_random_uuid();
  v_rid       uuid := gen_random_uuid();
  v_p         uuid[];                       -- v_p[1..8] player ids, seed i
  v_email     text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_i         integer;
  v_j         integer;
  v_mo        integer := 0;
  v_inserted  integer;
  v_qf_rounds integer;
  v_qf_match  integer;
  v_pairs_ok  integer;
begin
  set local session_replication_role = 'replica';

  v_p := array(select gen_random_uuid() from generate_series(1, 8));

  for v_i in 1..8 loop
    insert into auth.users (id, email)
      values (v_p[v_i], 'c' || v_i || '-' || v_email);
    insert into public.profiles (id, username, full_name, gender)
      values (v_p[v_i],
              'wkr_c_p' || v_i || '_' || substr(v_p[v_i]::text, 1, 8),
              'Wkr C P' || v_i, 'male');
  end loop;

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Wkr Test C - top_8 singles RR', 'round_robin', 'singles', 'top_8', 'active', v_p[1]);

  for v_i in 1..8 loop
    insert into public.tournament_registrations (tournament_id, user_id, status, seed)
      values (v_tid, v_p[v_i], 'approved', v_i);
  end loop;

  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
    values (v_rid, v_tid, 1, 'Round Robin', 'winners');

  -- Full round-robin: lower index ALWAYS beats higher index. Wins ladder
  -- becomes P1=7, P2=6, … P8=0 — strictly distinct, so standings == seeds.
  for v_i in 1..8 loop
    for v_j in (v_i + 1)..8 loop
      insert into public.tournament_matches
        (tournament_id, round_id, match_order, match_type,
         team1_player1, team2_player1, team1_score, team2_score, winner_team, status)
      values
        (v_tid, v_rid, v_mo, 'singles', v_p[v_i], v_p[v_j], 11, 5, 'team1', 'completed');
      v_mo := v_mo + 1;
    end loop;
  end loop;

  v_inserted := public.generate_playoff_bracket(v_tid);

  -- ── Assertions ───────────────────────────────────────────
  assert v_inserted = 4,
    format('Test C: expected generate_playoff_bracket to return 4, got %s', v_inserted);

  select count(*) into v_qf_rounds
    from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'quarterfinals';
  assert v_qf_rounds = 1,
    format('Test C: expected 1 quarterfinals round, got %s', v_qf_rounds);

  -- top_8 must NOT auto-create a third place match round at generation time.
  assert (select count(*) from public.tournament_rounds
            where tournament_id = v_tid and round_type = 'third_place_match') = 0,
    'Test C: top_8 should not create a third_place_match round at generation';

  select count(*) into v_qf_match
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals';
  assert v_qf_match = 4,
    format('Test C: expected 4 quarterfinals matches, got %s', v_qf_match);

  -- Outside-in seeding 1v8, 2v7, 3v6, 4v5. Verify each unordered pair
  -- appears exactly once in the QF round.
  select count(*) into v_pairs_ok
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals'
     and (
       (least(tm.team1_player1, tm.team2_player1) = least(v_p[1], v_p[8])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[1], v_p[8]))
       or (least(tm.team1_player1, tm.team2_player1) = least(v_p[2], v_p[7])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[2], v_p[7]))
       or (least(tm.team1_player1, tm.team2_player1) = least(v_p[3], v_p[6])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[3], v_p[6]))
       or (least(tm.team1_player1, tm.team2_player1) = least(v_p[4], v_p[5])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[4], v_p[5]))
     );
  assert v_pairs_ok = 4,
    format('Test C: expected all 4 outside-in pairings (1v8,2v7,3v6,4v5), matched %s', v_pairs_ok);

  -- match_order should be the canonical outside-in order 0->1v8 … 3->4v5.
  assert (select count(*) from public.tournament_matches tm
            join public.tournament_rounds tr on tr.id = tm.round_id
           where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals'
             and tm.match_order = 0
             and least(tm.team1_player1, tm.team2_player1) = least(v_p[1], v_p[8])
             and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[1], v_p[8])) = 1,
    'Test C: match_order 0 should be the 1v8 (top-seed) match';

  -- Singles bracket matches must have NULL second players.
  assert (select count(*) from public.tournament_matches tm
            join public.tournament_rounds tr on tr.id = tm.round_id
           where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals'
             and (tm.team1_player2 is not null or tm.team2_player2 is not null)) = 0,
    'Test C: singles QF matches should have NULL team*_player2';

  raise notice 'Test C: PASS - top_8 singles RR -> 4 QF matches, outside-in.';
end
$test_c$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test D: top_8, singles, pool_play (round_type='pool'), 8 entrants
--  Flat top-N branch ignores pool labels -> same 4-QF result.
-- ────────────────────────────────────────────────────────────
begin;

do $test_d$
declare
  v_tid       uuid := gen_random_uuid();
  v_rid_a     uuid := gen_random_uuid();
  v_rid_b     uuid := gen_random_uuid();
  v_p         uuid[];
  v_email     text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_i         integer;
  v_j         integer;
  v_mo        integer := 0;
  v_inserted  integer;
  v_qf_match  integer;
  v_pairs_ok  integer;
begin
  set local session_replication_role = 'replica';

  v_p := array(select gen_random_uuid() from generate_series(1, 8));
  for v_i in 1..8 loop
    insert into auth.users (id, email)
      values (v_p[v_i], 'd' || v_i || '-' || v_email);
    insert into public.profiles (id, username, full_name, gender)
      values (v_p[v_i],
              'wkr_d_p' || v_i || '_' || substr(v_p[v_i]::text, 1, 8),
              'Wkr D P' || v_i, 'male');
  end loop;

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, pool_count, status, created_by)
  values
    (v_tid, 'Wkr Test D - top_8 singles pool', 'pool_play', 'singles', 'top_8', 2, 'active', v_p[1]);

  for v_i in 1..8 loop
    insert into public.tournament_registrations (tournament_id, user_id, status, seed)
      values (v_tid, v_p[v_i], 'approved', v_i);
  end loop;

  -- Two labelled pool rounds with round_type='pool'.
  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
    values (v_rid_a, v_tid, 1, 'Pool A · Round 1', 'pool'),
           (v_rid_b, v_tid, 2, 'Pool B · Round 1', 'pool');

  -- Same strict ladder as Test C, but matches spread across the two pool
  -- rounds. The flat path aggregates across ALL completed matches, so the
  -- ladder still yields P1..P8 distinct wins -> standings == seeds.
  for v_i in 1..8 loop
    for v_j in (v_i + 1)..8 loop
      insert into public.tournament_matches
        (tournament_id, round_id, match_order, match_type,
         team1_player1, team2_player1, team1_score, team2_score, winner_team, status)
      values
        (v_tid, case when (v_mo % 2) = 0 then v_rid_a else v_rid_b end,
         v_mo, 'singles', v_p[v_i], v_p[v_j], 11, 5, 'team1', 'completed');
      v_mo := v_mo + 1;
    end loop;
  end loop;

  v_inserted := public.generate_playoff_bracket(v_tid);

  assert v_inserted = 4,
    format('Test D: expected return 4, got %s', v_inserted);

  assert (select count(*) from public.tournament_rounds
            where tournament_id = v_tid and round_type = 'quarterfinals') = 1,
    'Test D: expected 1 quarterfinals round';

  select count(*) into v_qf_match
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals';
  assert v_qf_match = 4,
    format('Test D: expected 4 QF matches, got %s', v_qf_match);

  select count(*) into v_pairs_ok
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'quarterfinals'
     and (
       (least(tm.team1_player1, tm.team2_player1) = least(v_p[1], v_p[8])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[1], v_p[8]))
       or (least(tm.team1_player1, tm.team2_player1) = least(v_p[2], v_p[7])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[2], v_p[7]))
       or (least(tm.team1_player1, tm.team2_player1) = least(v_p[3], v_p[6])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[3], v_p[6]))
       or (least(tm.team1_player1, tm.team2_player1) = least(v_p[4], v_p[5])
        and greatest(tm.team1_player1, tm.team2_player1) = greatest(v_p[4], v_p[5]))
     );
  assert v_pairs_ok = 4,
    format('Test D: expected outside-in pairings across pools, matched %s', v_pairs_ok);

  raise notice 'Test D: PASS - top_8 singles pool_play -> 4 QF matches (flat).';
end
$test_d$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test E: top_4, doubles, round_robin, 4 teams (8 players)
--  Verifies (lo,hi) doubles standings key + both players carried.
-- ────────────────────────────────────────────────────────────
begin;

do $test_e$
declare
  v_tid       uuid := gen_random_uuid();
  v_rid       uuid := gen_random_uuid();
  -- team t has players v_t<t>a, v_t<t>b
  v_t1a uuid := gen_random_uuid(); v_t1b uuid := gen_random_uuid();
  v_t2a uuid := gen_random_uuid(); v_t2b uuid := gen_random_uuid();
  v_t3a uuid := gen_random_uuid(); v_t3b uuid := gen_random_uuid();
  v_t4a uuid := gen_random_uuid(); v_t4b uuid := gen_random_uuid();
  v_all uuid[];
  v_email     text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_i         integer;
  v_inserted  integer;
  v_sf_match  integer;
  v_pair_1v4  integer;
  v_pair_2v3  integer;
  v_bad_pairs integer;
begin
  set local session_replication_role = 'replica';

  v_all := array[v_t1a, v_t1b, v_t2a, v_t2b, v_t3a, v_t3b, v_t4a, v_t4b];
  for v_i in 1..8 loop
    insert into auth.users (id, email)
      values (v_all[v_i], 'e' || v_i || '-' || v_email);
    insert into public.profiles (id, username, full_name, gender)
      values (v_all[v_i],
              'wkr_e_p' || v_i || '_' || substr(v_all[v_i]::text, 1, 8),
              'Wkr E P' || v_i, 'male');
  end loop;

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Wkr Test E - top_4 doubles RR', 'round_robin', 'doubles', 'top_4', 'active', v_t1a);

  -- Seed each team's anchor player. The standings seed for a team is
  -- min(seed) over its two members; we set anchors 1..4 and partners 90x.
  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_t1a, 'approved', 1), (v_tid, v_t1b, 'approved', 901),
    (v_tid, v_t2a, 'approved', 2), (v_tid, v_t2b, 'approved', 902),
    (v_tid, v_t3a, 'approved', 3), (v_tid, v_t3b, 'approved', 903),
    (v_tid, v_t4a, 'approved', 4), (v_tid, v_t4b, 'approved', 904);

  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
    values (v_rid, v_tid, 1, 'Round Robin', 'winners');

  -- Doubles round-robin among 4 teams (6 matches). Lower team always wins
  -- -> wins ladder T1=3, T2=2, T3=1, T4=0 (strict) -> standings == seeds.
  insert into public.tournament_matches
    (tournament_id, round_id, match_order, match_type,
     team1_player1, team1_player2, team2_player1, team2_player2,
     team1_score, team2_score, winner_team, status)
  values
    (v_tid, v_rid, 0, 'doubles', v_t1a, v_t1b, v_t2a, v_t2b, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 1, 'doubles', v_t1a, v_t1b, v_t3a, v_t3b, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 2, 'doubles', v_t1a, v_t1b, v_t4a, v_t4b, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 3, 'doubles', v_t2a, v_t2b, v_t3a, v_t3b, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 4, 'doubles', v_t2a, v_t2b, v_t4a, v_t4b, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 5, 'doubles', v_t3a, v_t3b, v_t4a, v_t4b, 11, 5, 'team1', 'completed');

  v_inserted := public.generate_playoff_bracket(v_tid);

  assert v_inserted = 2,
    format('Test E: expected return 2, got %s', v_inserted);

  assert (select count(*) from public.tournament_rounds
            where tournament_id = v_tid and round_type = 'semifinals') = 1,
    'Test E: expected 1 semifinals round';

  select count(*) into v_sf_match
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'semifinals';
  assert v_sf_match = 2,
    format('Test E: expected 2 SF matches, got %s', v_sf_match);

  -- SF1 = team1 (lo,hi of {t1a,t1b}) vs team4 ({t4a,t4b}); order-agnostic
  -- on which side is team1/team2 and which member is player1/player2.
  select count(*) into v_pair_1v4
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'semifinals'
     and (
       (least(tm.team1_player1, tm.team1_player2) = least(v_t1a, v_t1b)
        and greatest(tm.team1_player1, tm.team1_player2) = greatest(v_t1a, v_t1b)
        and least(tm.team2_player1, tm.team2_player2) = least(v_t4a, v_t4b)
        and greatest(tm.team2_player1, tm.team2_player2) = greatest(v_t4a, v_t4b))
       or
       (least(tm.team1_player1, tm.team1_player2) = least(v_t4a, v_t4b)
        and greatest(tm.team1_player1, tm.team1_player2) = greatest(v_t4a, v_t4b)
        and least(tm.team2_player1, tm.team2_player2) = least(v_t1a, v_t1b)
        and greatest(tm.team2_player1, tm.team2_player2) = greatest(v_t1a, v_t1b))
     );
  assert v_pair_1v4 = 1,
    'Test E: expected one SF between seed 1 (team1) and seed 4 (team4), both players present';

  select count(*) into v_pair_2v3
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'semifinals'
     and (
       (least(tm.team1_player1, tm.team1_player2) = least(v_t2a, v_t2b)
        and greatest(tm.team1_player1, tm.team1_player2) = greatest(v_t2a, v_t2b)
        and least(tm.team2_player1, tm.team2_player2) = least(v_t3a, v_t3b)
        and greatest(tm.team2_player1, tm.team2_player2) = greatest(v_t3a, v_t3b))
       or
       (least(tm.team1_player1, tm.team1_player2) = least(v_t3a, v_t3b)
        and greatest(tm.team1_player1, tm.team1_player2) = greatest(v_t3a, v_t3b)
        and least(tm.team2_player1, tm.team2_player2) = least(v_t2a, v_t2b)
        and greatest(tm.team2_player1, tm.team2_player2) = greatest(v_t2a, v_t2b))
     );
  assert v_pair_2v3 = 1,
    'Test E: expected one SF between seed 2 (team2) and seed 3 (team3), both players present';

  -- Every doubles SF match must carry TWO distinct players on each side
  -- (no NULL partners, no duplicated player).
  select count(*) into v_bad_pairs
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid and tr.round_type = 'semifinals'
     and (tm.team1_player2 is null or tm.team2_player2 is null
          or tm.team1_player1 = tm.team1_player2
          or tm.team2_player1 = tm.team2_player2);
  assert v_bad_pairs = 0,
    'Test E: every doubles SF side must have two distinct, non-null players';

  raise notice 'Test E: PASS - top_4 doubles RR -> SF 1v4 & 2v3, doubles key.';
end
$test_e$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test F: idempotency — second call is a no-op (raises, no dup rounds)
-- ────────────────────────────────────────────────────────────
begin;

do $test_f$
declare
  v_tid       uuid := gen_random_uuid();
  v_rid       uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid(); v_p2 uuid := gen_random_uuid();
  v_p3 uuid := gen_random_uuid(); v_p4 uuid := gen_random_uuid();
  v_all uuid[];
  v_email     text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_i         integer;
  v_first     integer;
  v_rounds_before integer;
  v_rounds_after  integer;
  v_raised    boolean := false;
begin
  set local session_replication_role = 'replica';

  v_all := array[v_p1, v_p2, v_p3, v_p4];
  for v_i in 1..4 loop
    insert into auth.users (id, email)
      values (v_all[v_i], 'f' || v_i || '-' || v_email);
    insert into public.profiles (id, username, full_name, gender)
      values (v_all[v_i],
              'wkr_f_p' || v_i || '_' || substr(v_all[v_i]::text, 1, 8),
              'Wkr F P' || v_i, 'male');
  end loop;

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Wkr Test F - idempotency', 'round_robin', 'singles', 'top_4', 'active', v_p1);

  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_p1, 'approved', 1), (v_tid, v_p2, 'approved', 2),
    (v_tid, v_p3, 'approved', 3), (v_tid, v_p4, 'approved', 4);

  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
    values (v_rid, v_tid, 1, 'Round Robin', 'winners');

  insert into public.tournament_matches
    (tournament_id, round_id, match_order, match_type,
     team1_player1, team2_player1, team1_score, team2_score, winner_team, status)
  values
    (v_tid, v_rid, 0, 'singles', v_p1, v_p2, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 1, 'singles', v_p1, v_p3, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 2, 'singles', v_p1, v_p4, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 3, 'singles', v_p2, v_p3, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 4, 'singles', v_p2, v_p4, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 5, 'singles', v_p3, v_p4, 11, 5, 'team1', 'completed');

  v_first := public.generate_playoff_bracket(v_tid);
  assert v_first = 2, format('Test F: first call expected 2, got %s', v_first);

  select count(*) into v_rounds_before
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type in ('quarterfinals','semifinals','finals','third_place_match');

  -- Second call must raise 'Playoff already generated.' and create nothing.
  begin
    perform public.generate_playoff_bracket(v_tid);
  exception when others then
    v_raised := true;
    assert sqlerrm like '%already generated%',
      format('Test F: expected "Playoff already generated." on 2nd call, got: %s', sqlerrm);
  end;

  assert v_raised,
    'Test F: second generate_playoff_bracket call should have raised, but did not';

  select count(*) into v_rounds_after
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type in ('quarterfinals','semifinals','finals','third_place_match');
  assert v_rounds_after = v_rounds_before,
    format('Test F: playoff rounds changed after 2nd call (before=%s after=%s)',
           v_rounds_before, v_rounds_after);

  -- And no duplicate playoff matches.
  assert (select count(*) from public.tournament_matches tm
            join public.tournament_rounds tr on tr.id = tm.round_id
           where tr.tournament_id = v_tid and tr.round_type = 'semifinals') = 2,
    'Test F: semifinals matches should still be exactly 2 after 2nd call';

  raise notice 'Test F: PASS - idempotent (2nd call raises, no duplication).';
end
$test_f$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test G: pending group-play matches -> raises a clear exception
-- ────────────────────────────────────────────────────────────
begin;

do $test_g$
declare
  v_tid       uuid := gen_random_uuid();
  v_rid       uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid(); v_p2 uuid := gen_random_uuid();
  v_p3 uuid := gen_random_uuid(); v_p4 uuid := gen_random_uuid();
  v_all uuid[];
  v_email     text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_i         integer;
  v_raised    boolean := false;
  v_rounds    integer;
begin
  set local session_replication_role = 'replica';

  v_all := array[v_p1, v_p2, v_p3, v_p4];
  for v_i in 1..4 loop
    insert into auth.users (id, email)
      values (v_all[v_i], 'g' || v_i || '-' || v_email);
    insert into public.profiles (id, username, full_name, gender)
      values (v_all[v_i],
              'wkr_g_p' || v_i || '_' || substr(v_all[v_i]::text, 1, 8),
              'Wkr G P' || v_i, 'male');
  end loop;

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Wkr Test G - pending group play', 'round_robin', 'singles', 'top_4', 'active', v_p1);

  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_p1, 'approved', 1), (v_tid, v_p2, 'approved', 2),
    (v_tid, v_p3, 'approved', 3), (v_tid, v_p4, 'approved', 4);

  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
    values (v_rid, v_tid, 1, 'Round Robin', 'winners');

  -- 5 completed + 1 still pending -> generation must refuse.
  insert into public.tournament_matches
    (tournament_id, round_id, match_order, match_type,
     team1_player1, team2_player1, team1_score, team2_score, winner_team, status)
  values
    (v_tid, v_rid, 0, 'singles', v_p1, v_p2, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 1, 'singles', v_p1, v_p3, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 2, 'singles', v_p1, v_p4, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 3, 'singles', v_p2, v_p3, 11, 5, 'team1', 'completed'),
    (v_tid, v_rid, 4, 'singles', v_p2, v_p4, 11, 5, 'team1', 'completed');

  insert into public.tournament_matches
    (tournament_id, round_id, match_order, match_type,
     team1_player1, team2_player1, status)
  values
    (v_tid, v_rid, 5, 'singles', v_p3, v_p4, 'pending');

  begin
    perform public.generate_playoff_bracket(v_tid);
  exception when others then
    v_raised := true;
    assert sqlerrm like '%still pending%' or sqlerrm like '%Cannot advance%',
      format('Test G: expected a pending-group-play exception, got: %s', sqlerrm);
  end;

  assert v_raised,
    'Test G: generate_playoff_bracket should raise when group-play matches are pending';

  -- Nothing should have been created.
  select count(*) into v_rounds
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type in ('quarterfinals','semifinals','finals','third_place_match');
  assert v_rounds = 0,
    format('Test G: no playoff rounds should exist after a refused call, got %s', v_rounds);

  raise notice 'Test G: PASS - pending group play -> clear exception, no rounds.';
end
$test_g$;

rollback;
