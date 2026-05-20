-- ============================================================
-- Tier-3 SQL tests for `public.generate_playoff_bracket`.
--
-- Test A: playoff_format='top_4' with 4 entrants
--   -> one round_type='semifinals' round with 2 matches seeded
--      1v4 and 2v3.
-- Test B: playoff_format='top_2' with 4 entrants
--   -> one round_type='finals' round (1 match, seeds 1v2)
--      AND one round_type='third_place_match' round (1 match,
--      seeds 3v4).
--
-- Each test is wrapped in `begin … rollback`. Assertions raise
-- `assert_failure` and abort the transaction; a clean run prints
-- `ROLLBACK` and no error.
--
-- Setup notes:
--   * profiles.id references auth.users(id), and profiles has
--     several NOT NULL columns (gender, username, full_name) and
--     a handle_new_user() trigger that inserts a placeholder
--     profile row missing the required gender field. So we
--     temporarily flip `session_replication_role` to 'replica'
--     around the auth.users insert + the manual profiles insert,
--     then back to 'origin' so the playoff-related triggers we
--     actually want to exercise can fire.
--   * Requires connecting as a role that may set
--     session_replication_role (the postgres role or the MCP
--     service_role; standard `authenticated` can't).
--
-- KNOWN ISSUE (PR landing): the live `generate_playoff_bracket`
-- currently fails with `function min(uuid) does not exist` because
-- a parallel branch's H2H-tiebreaker migration introduced that bug.
-- Tests A and B exercise the canonical behavior described in
-- `migration_generate_playoff_bracket.sql` and will pass once the
-- H2H regression is fixed. See `supabase/tests/README.md`.
--
-- See `supabase/tests/README.md` for how to run.
-- ============================================================


-- ────────────────────────────────────────────────────────────
--  Test A: top_4 with 4 entrants
-- ────────────────────────────────────────────────────────────
begin;

do $test_a$
declare
  v_tid       uuid := gen_random_uuid();
  v_rid       uuid := gen_random_uuid();
  v_p1        uuid := gen_random_uuid();
  v_p2        uuid := gen_random_uuid();
  v_p3        uuid := gen_random_uuid();
  v_p4        uuid := gen_random_uuid();
  v_email_p   text := 'tier3-test-a-' || gen_random_uuid()::text || '@example.invalid';
  v_inserted  integer;
  v_sf_count  integer;
  v_match_n   integer;
  v_pair_1v4  integer;
  v_pair_2v3  integer;
begin
  -- Triggers off so handle_new_user (which inserts a profiles row
  -- without the required `gender`) doesn't fire.
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values
    (v_p1, 'a1-' || v_email_p),
    (v_p2, 'a2-' || v_email_p),
    (v_p3, 'a3-' || v_email_p),
    (v_p4, 'a4-' || v_email_p);

  insert into public.profiles (id, username, full_name, gender) values
    (v_p1, 'tier3a_p1_' || substr(v_p1::text, 1, 8), 'Tier3A P1', 'male'),
    (v_p2, 'tier3a_p2_' || substr(v_p2::text, 1, 8), 'Tier3A P2', 'male'),
    (v_p3, 'tier3a_p3_' || substr(v_p3::text, 1, 8), 'Tier3A P3', 'male'),
    (v_p4, 'tier3a_p4_' || substr(v_p4::text, 1, 8), 'Tier3A P4', 'male');

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Tier3 Test A - top_4', 'round_robin', 'singles', 'top_4', 'active', v_p1);

  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_p1, 'approved', 1),
    (v_tid, v_p2, 'approved', 2),
    (v_tid, v_p3, 'approved', 3),
    (v_tid, v_p4, 'approved', 4);

  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_rid, v_tid, 1, 'Round Robin', 'winners');

  -- Wins ladder rigged P1=3, P2=2, P3=1, P4=0. Scores 11-5 satisfy
  -- tournament_matches_score_sanity_check (winner>=11, win-by-2, cap 50).
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

  v_inserted := public.generate_playoff_bracket(v_tid);

  -- ── Assertions ───────────────────────────────────────────
  select count(*) into v_sf_count
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type = 'semifinals';
  assert v_sf_count = 1,
    format('Test A: expected 1 semifinals round, got %s', v_sf_count);

  select count(*) into v_match_n
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid
     and tr.round_type = 'semifinals';
  assert v_match_n = 2,
    format('Test A: expected 2 semifinals matches, got %s', v_match_n);

  assert v_inserted = 2,
    format('Test A: expected generate_playoff_bracket to return 2, got %s', v_inserted);

  select count(*) into v_pair_1v4
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid
     and tr.round_type = 'semifinals'
     and (
       (tm.team1_player1 = v_p1 and tm.team2_player1 = v_p4)
       or (tm.team1_player1 = v_p4 and tm.team2_player1 = v_p1)
     );
  assert v_pair_1v4 = 1,
    'Test A: expected one Semifinals match between seed 1 (P1) and seed 4 (P4)';

  select count(*) into v_pair_2v3
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid
     and tr.round_type = 'semifinals'
     and (
       (tm.team1_player1 = v_p2 and tm.team2_player1 = v_p3)
       or (tm.team1_player1 = v_p3 and tm.team2_player1 = v_p2)
     );
  assert v_pair_2v3 = 1,
    'Test A: expected one Semifinals match between seed 2 (P2) and seed 3 (P3)';

  raise notice 'Test A: PASS - Semifinals round, 1v4 and 2v3 pairings.';
end
$test_a$;

rollback;


-- ────────────────────────────────────────────────────────────
--  Test B: top_2 with 4 entrants — Finals + Third Place Match
-- ────────────────────────────────────────────────────────────
begin;

do $test_b$
declare
  v_tid          uuid := gen_random_uuid();
  v_rid          uuid := gen_random_uuid();
  v_p1           uuid := gen_random_uuid();
  v_p2           uuid := gen_random_uuid();
  v_p3           uuid := gen_random_uuid();
  v_p4           uuid := gen_random_uuid();
  v_email_p      text := 'tier3-test-b-' || gen_random_uuid()::text || '@example.invalid';
  v_inserted     integer;
  v_finals_n     integer;
  v_third_n      integer;
  v_finals_match integer;
  v_third_match  integer;
  v_pair_1v2     integer;
  v_pair_3v4     integer;
begin
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values
    (v_p1, 'b1-' || v_email_p),
    (v_p2, 'b2-' || v_email_p),
    (v_p3, 'b3-' || v_email_p),
    (v_p4, 'b4-' || v_email_p);

  insert into public.profiles (id, username, full_name, gender) values
    (v_p1, 'tier3b_p1_' || substr(v_p1::text, 1, 8), 'Tier3B P1', 'male'),
    (v_p2, 'tier3b_p2_' || substr(v_p2::text, 1, 8), 'Tier3B P2', 'male'),
    (v_p3, 'tier3b_p3_' || substr(v_p3::text, 1, 8), 'Tier3B P3', 'male'),
    (v_p4, 'tier3b_p4_' || substr(v_p4::text, 1, 8), 'Tier3B P4', 'male');

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Tier3 Test B - top_2', 'round_robin', 'singles', 'top_2', 'active', v_p1);

  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_p1, 'approved', 1),
    (v_tid, v_p2, 'approved', 2),
    (v_tid, v_p3, 'approved', 3),
    (v_tid, v_p4, 'approved', 4);

  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_rid, v_tid, 1, 'Round Robin', 'winners');

  -- Same wins ladder: P1=3, P2=2, P3=1, P4=0 → standings 1..4 match seeds 1..4.
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

  v_inserted := public.generate_playoff_bracket(v_tid);

  -- ── Assertions ───────────────────────────────────────────
  select count(*) into v_finals_n
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type = 'finals';
  assert v_finals_n = 1,
    format('Test B: expected 1 finals round, got %s', v_finals_n);

  select count(*) into v_third_n
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type = 'third_place_match';
  assert v_third_n = 1,
    format('Test B: expected 1 third_place_match round, got %s', v_third_n);

  select count(*) into v_finals_match
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid
     and tr.round_type = 'finals';
  assert v_finals_match = 1,
    format('Test B: expected 1 finals match, got %s', v_finals_match);

  select count(*) into v_third_match
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid
     and tr.round_type = 'third_place_match';
  assert v_third_match = 1,
    format('Test B: expected 1 third_place_match match, got %s', v_third_match);

  assert v_inserted = 2,
    format('Test B: expected generate_playoff_bracket to return 2, got %s', v_inserted);

  -- Finals pairing = seeds 1v2 (P1 vs P2).
  select count(*) into v_pair_1v2
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid
     and tr.round_type = 'finals'
     and (
       (tm.team1_player1 = v_p1 and tm.team2_player1 = v_p2)
       or (tm.team1_player1 = v_p2 and tm.team2_player1 = v_p1)
     );
  assert v_pair_1v2 = 1,
    'Test B: expected Finals to be seed 1 (P1) vs seed 2 (P2)';

  -- Third Place pairing = seeds 3v4 (P3 vs P4).
  select count(*) into v_pair_3v4
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tr.tournament_id = v_tid
     and tr.round_type = 'third_place_match'
     and (
       (tm.team1_player1 = v_p3 and tm.team2_player1 = v_p4)
       or (tm.team1_player1 = v_p4 and tm.team2_player1 = v_p3)
     );
  assert v_pair_3v4 = 1,
    'Test B: expected Third Place Match to be seed 3 (P3) vs seed 4 (P4)';

  raise notice 'Test B: PASS - Finals (1v2) + Third Place Match (3v4).';
end
$test_b$;

rollback;
