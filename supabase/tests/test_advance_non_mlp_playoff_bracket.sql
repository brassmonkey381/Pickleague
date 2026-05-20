-- ============================================================
-- Tier-3 SQL test for `public._advance_non_mlp_playoff_bracket`.
--
-- Test C: Set up a Top-4 playoff with both Semifinal matches
--   inserted as `pending`. Complete the first SF (no advance —
--   round still has a pending sibling). Complete the second SF —
--   the trigger should now create a `finals` round with one
--   match populated by the two SF winners (outside-in pairing:
--   match_order 0's winner vs match_order 1's winner).
-- ============================================================

begin;

do $test_c$
declare
  v_tid           uuid := gen_random_uuid();
  v_rr_rid        uuid := gen_random_uuid();
  v_sf_rid        uuid := gen_random_uuid();
  v_sf1_id        uuid := gen_random_uuid();
  v_sf2_id        uuid := gen_random_uuid();
  v_p1            uuid := gen_random_uuid();
  v_p2            uuid := gen_random_uuid();
  v_p3            uuid := gen_random_uuid();
  v_p4            uuid := gen_random_uuid();
  v_email_p       text := 'tier3-test-c-' || gen_random_uuid()::text || '@example.invalid';
  v_finals_count  integer;
  v_finals_rid    uuid;
  v_finals_match  integer;
  v_pair_w1w2     integer;
begin
  -- Triggers off so handle_new_user (which inserts a profiles row
  -- without the required `gender`) doesn't fire during setup.
  set local session_replication_role = 'replica';

  insert into auth.users (id, email) values
    (v_p1, 'c1-' || v_email_p),
    (v_p2, 'c2-' || v_email_p),
    (v_p3, 'c3-' || v_email_p),
    (v_p4, 'c4-' || v_email_p);

  insert into public.profiles (id, username, full_name, gender) values
    (v_p1, 'tier3c_p1_' || substr(v_p1::text, 1, 8), 'Tier3C P1', 'male'),
    (v_p2, 'tier3c_p2_' || substr(v_p2::text, 1, 8), 'Tier3C P2', 'male'),
    (v_p3, 'tier3c_p3_' || substr(v_p3::text, 1, 8), 'Tier3C P3', 'male'),
    (v_p4, 'tier3c_p4_' || substr(v_p4::text, 1, 8), 'Tier3C P4', 'male');

  set local session_replication_role = 'origin';

  -- Trigger gates on format in ('round_robin','pool_play'), so we need one.
  insert into public.tournaments
    (id, name, format, match_type, playoff_format, status, created_by)
  values
    (v_tid, 'Tier3 Test C - advance trigger', 'round_robin', 'singles', 'top_4', 'active', v_p1);

  insert into public.tournament_registrations (tournament_id, user_id, status, seed) values
    (v_tid, v_p1, 'approved', 1),
    (v_tid, v_p2, 'approved', 2),
    (v_tid, v_p3, 'approved', 3),
    (v_tid, v_p4, 'approved', 4);

  -- Placeholder RR round — we hand-craft the SF round directly rather than
  -- calling generate_playoff_bracket, so this trigger is exercised in isolation.
  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_rr_rid, v_tid, 1, 'Round Robin', 'winners');

  -- SF#0 (mo=0) = P1 vs P4, SF#1 (mo=1) = P2 vs P3 — top_4 outside-in seeding.
  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_sf_rid, v_tid, 1000, 'Semifinals', 'semifinals');

  insert into public.tournament_matches
    (id, tournament_id, round_id, match_order, match_type,
     team1_player1, team2_player1, status)
  values
    (v_sf1_id, v_tid, v_sf_rid, 0, 'singles', v_p1, v_p4, 'pending'),
    (v_sf2_id, v_tid, v_sf_rid, 1, 'singles', v_p2, v_p3, 'pending');

  -- Complete SF#0 — round still has SF#1 pending, so no Finals yet.
  update public.tournament_matches
     set team1_score = 11,
         team2_score = 5,
         winner_team = 'team1',
         status      = 'completed'
   where id = v_sf1_id;

  select count(*) into v_finals_count
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type = 'finals';
  assert v_finals_count = 0,
    format('Test C (partial): Finals should NOT exist yet, got %s', v_finals_count);

  -- Complete SF#1 — both SFs done, trigger should now create Finals.
  update public.tournament_matches
     set team1_score = 11,
         team2_score = 5,
         winner_team = 'team1',
         status      = 'completed'
   where id = v_sf2_id;

  -- ── Assertions ───────────────────────────────────────────
  select count(*) into v_finals_count
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type = 'finals';
  assert v_finals_count = 1,
    format('Test C: expected 1 finals round after both SFs complete, got %s', v_finals_count);

  select id into v_finals_rid
    from public.tournament_rounds
   where tournament_id = v_tid
     and round_type = 'finals'
   limit 1;

  select count(*) into v_finals_match
    from public.tournament_matches
   where round_id = v_finals_rid;
  assert v_finals_match = 1,
    format('Test C: expected 1 finals match, got %s', v_finals_match);

  -- Outside-in pairing with 2 matches = mo[0] winner (P1) vs mo[1] winner (P2).
  select count(*) into v_pair_w1w2
    from public.tournament_matches
   where round_id = v_finals_rid
     and (
       (team1_player1 = v_p1 and team2_player1 = v_p2)
       or (team1_player1 = v_p2 and team2_player1 = v_p1)
     );
  assert v_pair_w1w2 = 1,
    'Test C: Finals match should pair the two SF winners (P1 vs P2)';

  raise notice 'Test C: PASS - Finals auto-created from completed Semifinals.';
end
$test_c$;

rollback;
