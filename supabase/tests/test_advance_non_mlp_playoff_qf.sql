-- ============================================================
-- Tier-3 SQL test for `public._advance_non_mlp_playoff_bracket`.
--
-- Companion to test_advance_non_mlp_playoff_bracket.sql (Test C, which
-- covers SF→Finals for a Top-4 bracket). This file covers the rounds
-- that Test C does not:
--
--   Test D — Top-8 (Quarterfinals → Semifinals → Finals).
--     Hand-craft a Quarterfinals round (4 matches, match_order 0..3,
--     outside-in seeding 1v8 / 2v7 / 3v6 / 4v5). Complete all four QFs
--     and assert the trigger seeds a Semifinals round with the
--     documented outside-in pairing of the QF winners
--     (mo[0]-winner vs mo[3]-winner, mo[1]-winner vs mo[2]-winner).
--     Then complete both SFs and assert a single Finals match pairing
--     the two SF winners → one champion path.
--
--   Test E — Top-4 Third Place Match toggle.
--     With `tournaments.playoff_third_place = true` and
--     `playoff_format = 'top_4'`, completing both Semifinals should
--     create BOTH a Finals round (SF winners) AND a Third Place Match
--     round (round_type 'third_place_match') pairing the two SF LOSERS.
--     This pins the behaviour added in migration_playoff_tiebreaker_and_3pm.sql
--     (#62) and extended in migration_playoff_byes_and_per_pool_3pm.sql (#69):
--     the playoff_third_place toggle is NOT inert for top_4 / top_8.
--
-- Both tests are wrapped in begin; … rollback; so nothing persists.
-- Score values respect tournament_matches_score_sanity_check (11-5).
-- ============================================================

begin;

-- ── Test D — Top-8 QF → SF → Finals outside-in advancement ──────────
do $test_d$
declare
  v_tid          uuid := gen_random_uuid();
  v_qf_rid       uuid := gen_random_uuid();
  v_qf0          uuid := gen_random_uuid();
  v_qf1          uuid := gen_random_uuid();
  v_qf2          uuid := gen_random_uuid();
  v_qf3          uuid := gen_random_uuid();
  -- 8 entrants, seeds 1..8
  v_p1  uuid := gen_random_uuid();
  v_p2  uuid := gen_random_uuid();
  v_p3  uuid := gen_random_uuid();
  v_p4  uuid := gen_random_uuid();
  v_p5  uuid := gen_random_uuid();
  v_p6  uuid := gen_random_uuid();
  v_p7  uuid := gen_random_uuid();
  v_p8  uuid := gen_random_uuid();
  v_email text := 'tier3-test-d-' || gen_random_uuid()::text || '@example.invalid';
  v_label text;
  -- assertion scratch
  v_sf_rid       uuid;
  v_sf_rounds    integer;
  v_sf_matches   integer;
  v_sf_num       integer;
  v_sf0_pair     integer;
  v_sf1_pair     integer;
  v_sf0_id       uuid;
  v_sf1_id       uuid;
  v_finals_rid   uuid;
  v_finals_rounds integer;
  v_finals_match integer;
  v_finals_num   integer;
  v_finals_pair  integer;
begin
  -- Triggers off during setup so handle_new_user doesn't fire.
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values
    (v_p1, 'd1-' || v_email), (v_p2, 'd2-' || v_email),
    (v_p3, 'd3-' || v_email), (v_p4, 'd4-' || v_email),
    (v_p5, 'd5-' || v_email), (v_p6, 'd6-' || v_email),
    (v_p7, 'd7-' || v_email), (v_p8, 'd8-' || v_email);

  insert into public.profiles (id, username, full_name, gender) values
    (v_p1, 'tier3d_p1_' || substr(v_p1::text,1,8), 'Tier3D P1', 'male'),
    (v_p2, 'tier3d_p2_' || substr(v_p2::text,1,8), 'Tier3D P2', 'male'),
    (v_p3, 'tier3d_p3_' || substr(v_p3::text,1,8), 'Tier3D P3', 'male'),
    (v_p4, 'tier3d_p4_' || substr(v_p4::text,1,8), 'Tier3D P4', 'male'),
    (v_p5, 'tier3d_p5_' || substr(v_p5::text,1,8), 'Tier3D P5', 'male'),
    (v_p6, 'tier3d_p6_' || substr(v_p6::text,1,8), 'Tier3D P6', 'male'),
    (v_p7, 'tier3d_p7_' || substr(v_p7::text,1,8), 'Tier3D P7', 'male'),
    (v_p8, 'tier3d_p8_' || substr(v_p8::text,1,8), 'Tier3D P8', 'male');

  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Tier3 Test D - top_8 QF advance', 'round_robin', 'singles', 'top_8', 'active', v_p1);

  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_p1, 'approved', 1), (v_tid, v_p2, 'approved', 2),
    (v_tid, v_p3, 'approved', 3), (v_tid, v_p4, 'approved', 4),
    (v_tid, v_p5, 'approved', 5), (v_tid, v_p6, 'approved', 6),
    (v_tid, v_p7, 'approved', 7), (v_tid, v_p8, 'approved', 8);

  -- Quarterfinals round (round_number 1000, as generate_playoff_bracket uses).
  -- Outside-in seeding: QF0 = 1v8, QF1 = 2v7, QF2 = 3v6, QF3 = 4v5.
  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_qf_rid, v_tid, 1000, 'Quarterfinals', 'quarterfinals');

  insert into public.tournament_matches
    (id, tournament_id, round_id, match_order, match_type,
     team1_player1, team2_player1, status)
  values
    (v_qf0, v_tid, v_qf_rid, 0, 'singles', v_p1, v_p8, 'pending'),
    (v_qf1, v_tid, v_qf_rid, 1, 'singles', v_p2, v_p7, 'pending'),
    (v_qf2, v_tid, v_qf_rid, 2, 'singles', v_p3, v_p6, 'pending'),
    (v_qf3, v_tid, v_qf_rid, 3, 'singles', v_p4, v_p5, 'pending');

  -- Complete QF0, QF1, QF2 — round still incomplete, no Semifinals yet.
  -- QF0: P1 beats P8.  QF1: P2 beats P7.  QF2: P3 beats P6.
  update public.tournament_matches set team1_score=11, team2_score=5,
    winner_team='team1', status='completed' where id = v_qf0;
  update public.tournament_matches set team1_score=11, team2_score=5,
    winner_team='team1', status='completed' where id = v_qf1;
  update public.tournament_matches set team1_score=11, team2_score=5,
    winner_team='team1', status='completed' where id = v_qf2;

  select count(*) into v_sf_rounds from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'semifinals';
  assert v_sf_rounds = 0,
    format('Test D (partial): Semifinals should NOT exist with a QF still pending, got %s', v_sf_rounds);

  -- Complete QF3: P5 beats P4 (team2 wins) — exercises the team2 winner path.
  update public.tournament_matches set team1_score=5, team2_score=11,
    winner_team='team2', status='completed' where id = v_qf3;

  -- ── SF assertions ────────────────────────────────────────────────
  select count(*) into v_sf_rounds from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'semifinals';
  assert v_sf_rounds = 1,
    format('Test D: expected 1 Semifinals round after all QFs complete, got %s', v_sf_rounds);

  select id, round_number, label into v_sf_rid, v_sf_num, v_label
    from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'semifinals' limit 1;
  assert v_sf_num = 1100,
    format('Test D: Semifinals round_number should be QF(1000)+100=1100, got %s', v_sf_num);
  assert v_label = 'Semifinals',
    format('Test D: Semifinals label should be ''Semifinals'', got %s', v_label);

  select count(*) into v_sf_matches from public.tournament_matches
   where round_id = v_sf_rid;
  assert v_sf_matches = 2,
    format('Test D: expected 2 Semifinal matches, got %s', v_sf_matches);

  -- Outside-in: SF mo[0] = QF0-winner(P1) vs QF3-winner(P5).
  select count(*) into v_sf0_pair from public.tournament_matches
   where round_id = v_sf_rid and match_order = 0
     and ((team1_player1 = v_p1 and team2_player1 = v_p5)
       or (team1_player1 = v_p5 and team2_player1 = v_p1));
  assert v_sf0_pair = 1,
    'Test D: SF match_order 0 must pair QF0 winner (P1) vs QF3 winner (P5) — outside-in mo[0] vs mo[3]';

  -- Outside-in: SF mo[1] = QF1-winner(P2) vs QF2-winner(P3).
  select count(*) into v_sf1_pair from public.tournament_matches
   where round_id = v_sf_rid and match_order = 1
     and ((team1_player1 = v_p2 and team2_player1 = v_p3)
       or (team1_player1 = v_p3 and team2_player1 = v_p2));
  assert v_sf1_pair = 1,
    'Test D: SF match_order 1 must pair QF1 winner (P2) vs QF2 winner (P3) — outside-in mo[1] vs mo[2]';

  -- ── Drive SF → Finals ────────────────────────────────────────────
  select id into v_sf0_id from public.tournament_matches
   where round_id = v_sf_rid and match_order = 0;
  select id into v_sf1_id from public.tournament_matches
   where round_id = v_sf_rid and match_order = 1;

  -- Complete SF0 only — Finals must not yet exist.
  update public.tournament_matches set team1_score=11, team2_score=5,
    winner_team = case when team1_player1 = v_p1 then 'team1' else 'team2' end,
    status='completed' where id = v_sf0_id;

  select count(*) into v_finals_rounds from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'finals';
  assert v_finals_rounds = 0,
    format('Test D (partial): Finals should NOT exist with one SF pending, got %s', v_finals_rounds);

  -- Complete SF1 — P2 wins (so finalists are P1 and P2).
  update public.tournament_matches set team1_score=11, team2_score=5,
    winner_team = case when team1_player1 = v_p2 then 'team1' else 'team2' end,
    status='completed' where id = v_sf1_id;

  -- ── Finals assertions ────────────────────────────────────────────
  select count(*) into v_finals_rounds from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'finals';
  assert v_finals_rounds = 1,
    format('Test D: expected 1 Finals round after both SFs complete, got %s', v_finals_rounds);

  select id, round_number into v_finals_rid, v_finals_num from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'finals' limit 1;
  assert v_finals_num = 1200,
    format('Test D: Finals round_number should be SF(1100)+100=1200, got %s', v_finals_num);

  select count(*) into v_finals_match from public.tournament_matches
   where round_id = v_finals_rid;
  assert v_finals_match = 1,
    format('Test D: expected exactly 1 Finals match (single champion path), got %s', v_finals_match);

  -- Finals must pair the two SF winners (P1 vs P2).
  select count(*) into v_finals_pair from public.tournament_matches
   where round_id = v_finals_rid
     and ((team1_player1 = v_p1 and team2_player1 = v_p2)
       or (team1_player1 = v_p2 and team2_player1 = v_p1));
  assert v_finals_pair = 1,
    'Test D: Finals must pair the two SF winners (P1 vs P2)';

  -- No 3PM expected (playoff_third_place defaults to false).
  select count(*) into v_finals_rounds from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'third_place_match';
  assert v_finals_rounds = 0,
    format('Test D: no Third Place Match expected when playoff_third_place is false, got %s', v_finals_rounds);

  raise notice 'Test D: PASS - top_8 QF->SF (outside-in) ->Finals single champion.';
end
$test_d$;


-- ── Test E — Top-4 Third Place Match toggle (playoff_third_place) ───
do $test_e$
declare
  v_tid       uuid := gen_random_uuid();
  v_sf_rid    uuid := gen_random_uuid();
  v_sf0       uuid := gen_random_uuid();
  v_sf1       uuid := gen_random_uuid();
  v_p1        uuid := gen_random_uuid();   -- seed 1
  v_p2        uuid := gen_random_uuid();   -- seed 2
  v_p3        uuid := gen_random_uuid();   -- seed 3
  v_p4        uuid := gen_random_uuid();   -- seed 4
  v_email     text := 'tier3-test-e-' || gen_random_uuid()::text || '@example.invalid';
  v_finals_rid uuid;
  v_3pm_rid    uuid;
  v_finals_n   integer;
  v_3pm_n      integer;
  v_finals_pair integer;
  v_3pm_pair    integer;
begin
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values
    (v_p1, 'e1-' || v_email), (v_p2, 'e2-' || v_email),
    (v_p3, 'e3-' || v_email), (v_p4, 'e4-' || v_email);

  insert into public.profiles (id, username, full_name, gender) values
    (v_p1, 'tier3e_p1_' || substr(v_p1::text,1,8), 'Tier3E P1', 'male'),
    (v_p2, 'tier3e_p2_' || substr(v_p2::text,1,8), 'Tier3E P2', 'male'),
    (v_p3, 'tier3e_p3_' || substr(v_p3::text,1,8), 'Tier3E P3', 'male'),
    (v_p4, 'tier3e_p4_' || substr(v_p4::text,1,8), 'Tier3E P4', 'male');

  set local session_replication_role = 'origin';

  -- playoff_third_place = TRUE is the point of this test.
  insert into public.tournaments
    (id, name, format, match_type, playoff_format, playoff_third_place, status, created_by)
  values
    (v_tid, 'Tier3 Test E - top_4 3PM toggle', 'round_robin', 'singles', 'top_4', true, 'active', v_p1);

  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_p1, 'approved', 1), (v_tid, v_p2, 'approved', 2),
    (v_tid, v_p3, 'approved', 3), (v_tid, v_p4, 'approved', 4);

  -- Semifinals: SF0 = P1 vs P4, SF1 = P2 vs P3 (outside-in top_4 seeding).
  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_sf_rid, v_tid, 1000, 'Semifinals', 'semifinals');

  insert into public.tournament_matches
    (id, tournament_id, round_id, match_order, match_type,
     team1_player1, team2_player1, status)
  values
    (v_sf0, v_tid, v_sf_rid, 0, 'singles', v_p1, v_p4, 'pending'),
    (v_sf1, v_tid, v_sf_rid, 1, 'singles', v_p2, v_p3, 'pending');

  -- Complete SF0: P1 beats P4 (loser P4). Complete SF1: P2 beats P3 (loser P3).
  update public.tournament_matches set team1_score=11, team2_score=5,
    winner_team='team1', status='completed' where id = v_sf0;
  update public.tournament_matches set team1_score=11, team2_score=5,
    winner_team='team1', status='completed' where id = v_sf1;

  -- ── Finals assertions ────────────────────────────────────────────
  select count(*) into v_finals_n from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'finals';
  assert v_finals_n = 1,
    format('Test E: expected 1 Finals round, got %s', v_finals_n);

  select id into v_finals_rid from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'finals' limit 1;
  select count(*) into v_finals_pair from public.tournament_matches
   where round_id = v_finals_rid
     and ((team1_player1 = v_p1 and team2_player1 = v_p2)
       or (team1_player1 = v_p2 and team2_player1 = v_p1));
  assert v_finals_pair = 1,
    'Test E: Finals must pair the two SF winners (P1 vs P2)';

  -- ── Third Place Match assertions ─────────────────────────────────
  select count(*) into v_3pm_n from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'third_place_match';
  assert v_3pm_n = 1,
    format('Test E: playoff_third_place=true on top_4 must create exactly 1 Third Place Match round, got %s', v_3pm_n);

  select id into v_3pm_rid from public.tournament_rounds
   where tournament_id = v_tid and round_type = 'third_place_match' limit 1;

  select count(*) into v_3pm_pair from public.tournament_matches
   where round_id = v_3pm_rid;
  assert v_3pm_pair = 1,
    format('Test E: expected exactly 1 Third Place Match, got %s', v_3pm_pair);

  -- 3PM must pair the two SF LOSERS (P4 from SF0, P3 from SF1).
  select count(*) into v_3pm_pair from public.tournament_matches
   where round_id = v_3pm_rid
     and ((team1_player1 = v_p4 and team2_player1 = v_p3)
       or (team1_player1 = v_p3 and team2_player1 = v_p4));
  assert v_3pm_pair = 1,
    'Test E: Third Place Match must pair the two SF LOSERS (P4 vs P3)';

  raise notice 'Test E: PASS - top_4 playoff_third_place toggle creates a 3PM from SF losers.';
end
$test_e$;

rollback;
