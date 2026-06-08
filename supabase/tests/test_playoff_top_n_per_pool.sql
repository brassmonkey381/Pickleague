-- ============================================================
-- Tier-3 SQL tests for the Top-N-per-Pool branch of
-- `public.generate_playoff_bracket` (Unit 11).
--
-- Origin of the branch under test:
--   * supabase/migration_playoff_top_n_per_pool.sql      (PR #66)
--   * supabase/migration_playoff_byes_and_per_pool_3pm.sql (PR #69, LIVE)
-- PR #69 is the latest `create or replace` of generate_playoff_bracket and
-- is therefore the definition these tests assert against. The crossover
-- pairings for the power-of-2 configs are IDENTICAL across #66 and #69,
-- so these tests validate both. The non-power-of-2 behavior DIFFERS:
--   * #66: P=3/N=2 (→6) RAISES.
--   * #69: P=3/N=2 (→6) is BYE-PADDED to an 8-slot Quarterfinals (no raise).
-- The guard tests below therefore use bracket sizes that raise in BOTH
-- (P=3/N=1 → 3, P=5/N=1 → 5) and a separate test pins the #69 BYE-pad
-- behavior for 6 so a future regression that drops it is caught.
--
-- Configs covered (pool_count P, per-pool N → bracket size B = P*N):
--   Test 1  P=2 N=1 → 2  (Final: A1 vs B1)
--   Test 2  P=2 N=2 → 4  (SF1 A1vB2, SF2 B1vA2; same-pool only meet in Final)
--   Test 3  P=4 N=2 → 8  (QF A1vD2, D1vB2, B1vC2, C1vA2; no same-pool in R1)
--   Test 4  P=2 N=4 → 8  (unreachable via enum — N capped at 2; hand-traced)
--   Test 5  per-pool standings tiebreaker order (wins → H2H[2-way] → pd → seed)
--   Test 6  pool-letter parsing from "Pool A · Round k" label
--   Test 7  non-power-of-2 guard: P=3 N=1 → 3 RAISES
--   Test 8  non-power-of-2 guard: P=5 N=1 → 5 RAISES
--   Test 9  P=3 N=2 → 6 is BYE-padded to 8 (LIVE #69 behavior; pins it)
--
-- Each test is wrapped in `begin … rollback`. Assertions raise
-- `assert_failure` and abort the transaction; a clean run prints `ROLLBACK`
-- with no error. session_replication_role is flipped to 'replica' around the
-- auth.users + profiles inserts (handle_new_user would otherwise insert a
-- profiles row missing the NOT NULL `gender`), then back to 'origin' so the
-- playoff triggers fire. Scores are 11-5 to satisfy the score sanity check.
--
-- Requires a role that may set session_replication_role (postgres /
-- service_role). See supabase/tests/README.md.
-- ============================================================


-- ════════════════════════════════════════════════════════════
--  Test 1: P=2 pools, N=1 → bracket size 2 (Final A1 vs B1)
--  Each pool has 2 players (so matches exist); take the top 1 of each.
-- ════════════════════════════════════════════════════════════
begin;

do $t1$
declare
  v_tid uuid := gen_random_uuid();
  v_ra  uuid := gen_random_uuid();  -- Pool A round
  v_rb  uuid := gen_random_uuid();  -- Pool B round
  a1 uuid := gen_random_uuid();
  a2 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid();
  b2 uuid := gen_random_uuid();
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_ins int;
  v_finals_n int;
  v_final_match int;
  v_pair int;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (a1,'a1-'||v_em),(a2,'a2-'||v_em),(b1,'b1-'||v_em),(b2,'b2-'||v_em);
  insert into public.profiles (id, username, full_name, gender) values
    (a1,'t1a1_'||substr(a1::text,1,8),'T1 A1','male'),
    (a2,'t1a2_'||substr(a2::text,1,8),'T1 A2','male'),
    (b1,'t1b1_'||substr(b1::text,1,8),'T1 B1','male'),
    (b2,'t1b2_'||substr(b2::text,1,8),'T1 B2','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values
    (v_tid,'T1 top_1_per_pool','pool_play','singles','top_1_per_pool','active',a1);

  insert into public.tournament_registrations (tournament_id,user_id,status,seed) values
    (v_tid,a1,'approved',1),(v_tid,a2,'approved',2),
    (v_tid,b1,'approved',3),(v_tid,b2,'approved',4);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type) values
    (v_ra,v_tid,1,'Pool A · Round 1','winners'),
    (v_rb,v_tid,2,'Pool B · Round 1','winners');

  -- a1 beats a2 ; b1 beats b2 → pool winners a1, b1
  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_ra,0,'singles',a1,a2,11,5,'team1','completed'),
    (v_tid,v_rb,0,'singles',b1,b2,11,5,'team1','completed');

  v_ins := public.generate_playoff_bracket(v_tid);

  select count(*) into v_finals_n
    from public.tournament_rounds
   where tournament_id=v_tid and round_type='finals';
  assert v_finals_n = 1, format('T1: expected 1 finals round, got %s', v_finals_n);

  select count(*) into v_final_match
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='finals';
  assert v_final_match = 1, format('T1: expected 1 finals match, got %s', v_final_match);
  assert v_ins = 1, format('T1: expected return 1, got %s', v_ins);

  -- Final must be A1 (a1) vs B1 (b1), cross-pool.
  select count(*) into v_pair
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='finals'
     and ((tm.team1_player1=a1 and tm.team2_player1=b1)
       or (tm.team1_player1=b1 and tm.team2_player1=a1));
  assert v_pair = 1, 'T1: expected Final = A1(a1) vs B1(b1)';

  raise notice 'Test 1 PASS: P=2 N=1 → Final A1 vs B1.';
end
$t1$;

rollback;


-- ════════════════════════════════════════════════════════════
--  Test 2: P=2 pools, N=2 → bracket size 4
--  Expect Semifinals: SF1 = A1 vs B2, SF2 = B1 vs A2.
--  Same-pool entrants (A1/A2, B1/B2) must be split across SFs so they
--  can only meet in the Final.
-- ════════════════════════════════════════════════════════════
begin;

do $t2$
declare
  v_tid uuid := gen_random_uuid();
  v_ra uuid := gen_random_uuid();
  v_rb uuid := gen_random_uuid();
  a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_ins int; v_sf_n int; v_sf_m int;
  v_sf1 int; v_sf2 int; v_same_pool int;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (a1,'a1-'||v_em),(a2,'a2-'||v_em),(b1,'b1-'||v_em),(b2,'b2-'||v_em);
  insert into public.profiles (id, username, full_name, gender) values
    (a1,'t2a1_'||substr(a1::text,1,8),'T2 A1','male'),
    (a2,'t2a2_'||substr(a2::text,1,8),'T2 A2','male'),
    (b1,'t2b1_'||substr(b1::text,1,8),'T2 B1','male'),
    (b2,'t2b2_'||substr(b2::text,1,8),'T2 B2','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values (v_tid,'T2 top_2_per_pool','pool_play','singles','top_2_per_pool','active',a1);

  insert into public.tournament_registrations (tournament_id,user_id,status,seed) values
    (v_tid,a1,'approved',1),(v_tid,a2,'approved',2),
    (v_tid,b1,'approved',3),(v_tid,b2,'approved',4);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type) values
    (v_ra,v_tid,1,'Pool A · Round 1','winners'),
    (v_rb,v_tid,2,'Pool B · Round 1','winners');

  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_ra,0,'singles',a1,a2,11,5,'team1','completed'),
    (v_tid,v_rb,0,'singles',b1,b2,11,5,'team1','completed');

  v_ins := public.generate_playoff_bracket(v_tid);

  select count(*) into v_sf_n
    from public.tournament_rounds
   where tournament_id=v_tid and round_type='semifinals';
  assert v_sf_n = 1, format('T2: expected 1 semifinals round, got %s', v_sf_n);

  select count(*) into v_sf_m
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='semifinals';
  assert v_sf_m = 2, format('T2: expected 2 SF matches, got %s', v_sf_m);
  assert v_ins = 2, format('T2: expected return 2, got %s', v_ins);

  -- SF1 = A1(a1) vs B2(b2)
  select count(*) into v_sf1
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='semifinals'
     and ((tm.team1_player1=a1 and tm.team2_player1=b2)
       or (tm.team1_player1=b2 and tm.team2_player1=a1));
  assert v_sf1 = 1, 'T2: expected an SF = A1(a1) vs B2(b2)';

  -- SF2 = B1(b1) vs A2(a2)
  select count(*) into v_sf2
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='semifinals'
     and ((tm.team1_player1=b1 and tm.team2_player1=a2)
       or (tm.team1_player1=a2 and tm.team2_player1=b1));
  assert v_sf2 = 1, 'T2: expected an SF = B1(b1) vs A2(a2)';

  -- No semifinal pairs two players from the same pool (A: {a1,a2}, B: {b1,b2}).
  select count(*) into v_same_pool
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='semifinals'
     and ( (tm.team1_player1 in (a1,a2) and tm.team2_player1 in (a1,a2))
        or (tm.team1_player1 in (b1,b2) and tm.team2_player1 in (b1,b2)) );
  assert v_same_pool = 0, 'T2: same-pool entrants must not meet before the Final';

  raise notice 'Test 2 PASS: P=2 N=2 → SF1 A1vB2, SF2 B1vA2, no same-pool SF.';
end
$t2$;

rollback;


-- ════════════════════════════════════════════════════════════
--  Test 3: P=4 pools, N=2 → bracket size 8
--  Expect Quarterfinals (4 matches). Documented pairings:
--    QF1 A1 vs D2, QF2 D1 vs B2, QF3 B1 vs C2, QF4 C1 vs A2.
--  Firm invariant: NO same-pool pair in round 1 (QF).
--  (The docs explicitly relax the "no same-pool before Final" claim for
--   B=8 — only P=2/N=2 fully guarantees it — so we only assert R1 here.)
-- ════════════════════════════════════════════════════════════
begin;

do $t3$
declare
  v_tid uuid := gen_random_uuid();
  v_ra uuid := gen_random_uuid(); v_rb uuid := gen_random_uuid();
  v_rc uuid := gen_random_uuid(); v_rd uuid := gen_random_uuid();
  a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid();
  d1 uuid := gen_random_uuid(); d2 uuid := gen_random_uuid();
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_ins int; v_qf_n int; v_qf_m int;
  v_q1 int; v_q2 int; v_q3 int; v_q4 int; v_same_pool_r1 int;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (a1,'a1-'||v_em),(a2,'a2-'||v_em),(b1,'b1-'||v_em),(b2,'b2-'||v_em),
    (c1,'c1-'||v_em),(c2,'c2-'||v_em),(d1,'d1-'||v_em),(d2,'d2-'||v_em);
  insert into public.profiles (id, username, full_name, gender) values
    (a1,'t3a1_'||substr(a1::text,1,8),'A1','male'),
    (a2,'t3a2_'||substr(a2::text,1,8),'A2','male'),
    (b1,'t3b1_'||substr(b1::text,1,8),'B1','male'),
    (b2,'t3b2_'||substr(b2::text,1,8),'B2','male'),
    (c1,'t3c1_'||substr(c1::text,1,8),'C1','male'),
    (c2,'t3c2_'||substr(c2::text,1,8),'C2','male'),
    (d1,'t3d1_'||substr(d1::text,1,8),'D1','male'),
    (d2,'t3d2_'||substr(d2::text,1,8),'D2','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values (v_tid,'T3 top_2_per_pool 4 pools','pool_play','singles','top_2_per_pool','active',a1);

  insert into public.tournament_registrations (tournament_id,user_id,status,seed) values
    (v_tid,a1,'approved',1),(v_tid,a2,'approved',5),
    (v_tid,b1,'approved',2),(v_tid,b2,'approved',6),
    (v_tid,c1,'approved',3),(v_tid,c2,'approved',7),
    (v_tid,d1,'approved',4),(v_tid,d2,'approved',8);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type) values
    (v_ra,v_tid,1,'Pool A · Round 1','winners'),
    (v_rb,v_tid,2,'Pool B · Round 1','winners'),
    (v_rc,v_tid,3,'Pool C · Round 1','winners'),
    (v_rd,v_tid,4,'Pool D · Round 1','winners');

  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_ra,0,'singles',a1,a2,11,5,'team1','completed'),
    (v_tid,v_rb,0,'singles',b1,b2,11,5,'team1','completed'),
    (v_tid,v_rc,0,'singles',c1,c2,11,5,'team1','completed'),
    (v_tid,v_rd,0,'singles',d1,d2,11,5,'team1','completed');

  v_ins := public.generate_playoff_bracket(v_tid);

  select count(*) into v_qf_n
    from public.tournament_rounds where tournament_id=v_tid and round_type='quarterfinals';
  assert v_qf_n = 1, format('T3: expected 1 quarterfinals round, got %s', v_qf_n);

  select count(*) into v_qf_m
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals';
  assert v_qf_m = 4, format('T3: expected 4 QF matches, got %s', v_qf_m);
  assert v_ins = 4, format('T3: expected return 4, got %s', v_ins);

  -- Documented QF pairings (orientation-agnostic).
  select count(*) into v_q1 from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals'
     and ((tm.team1_player1=a1 and tm.team2_player1=d2) or (tm.team1_player1=d2 and tm.team2_player1=a1));
  assert v_q1 = 1, 'T3: expected QF A1 vs D2';

  select count(*) into v_q2 from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals'
     and ((tm.team1_player1=d1 and tm.team2_player1=b2) or (tm.team1_player1=b2 and tm.team2_player1=d1));
  assert v_q2 = 1, 'T3: expected QF D1 vs B2';

  select count(*) into v_q3 from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals'
     and ((tm.team1_player1=b1 and tm.team2_player1=c2) or (tm.team1_player1=c2 and tm.team2_player1=b1));
  assert v_q3 = 1, 'T3: expected QF B1 vs C2';

  select count(*) into v_q4 from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals'
     and ((tm.team1_player1=c1 and tm.team2_player1=a2) or (tm.team1_player1=a2 and tm.team2_player1=c1));
  assert v_q4 = 1, 'T3: expected QF C1 vs A2';

  -- No same-pool pair in round 1.
  select count(*) into v_same_pool_r1
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals'
     and ( (tm.team1_player1 in (a1,a2) and tm.team2_player1 in (a1,a2))
        or (tm.team1_player1 in (b1,b2) and tm.team2_player1 in (b1,b2))
        or (tm.team1_player1 in (c1,c2) and tm.team2_player1 in (c1,c2))
        or (tm.team1_player1 in (d1,d2) and tm.team2_player1 in (d1,d2)) );
  assert v_same_pool_r1 = 0, 'T3: no same-pool pair allowed in round 1 (QF)';

  raise notice 'Test 3 PASS: P=4 N=2 → QF A1vD2/D1vB2/B1vC2/C1vA2, no same-pool R1.';
end
$t3$;

rollback;


-- ════════════════════════════════════════════════════════════
--  Test 4: P=2 pools, N=4 → bracket size 8 (UNREACHABLE via enum).
--  The playoff_format enum only offers top_1_per_pool / top_2_per_pool, so
--  v_per_pool_n maxes at 2. P=2/N=4 (B=8, 2 pools) can never be produced by
--  a real tournament — the 8-and-2-pools pairing branch is dead code reachable
--  only if a 3rd per-pool enum value (top_4_per_pool) were added.
--  We therefore HAND-TRACE it (validated in the PR description) rather than
--  drive it live. Documented pairings:
--    v_seeds (snake) = [A1,B1,A2,B2,A3,B3,A4,B4]
--    v_pairings = [[1,8],[4,5],[2,7],[3,6]] →
--      QF1 A1 vs B4, QF2 B2 vs A3, QF3 B1 vs A4, QF4 A2 vs B3  (all cross-pool)
--    Matches docs/seeding-and-tiebreakers.md §3 exactly.
-- ════════════════════════════════════════════════════════════
do $t4$
begin
  raise notice 'Test 4 NOTE: P=2/N=4 (B=8) unreachable via playoff_format enum (N capped at 2). Hand-traced in PR; pairings match docs §3.';
end
$t4$;


-- ════════════════════════════════════════════════════════════
--  Test 5: per-pool standings tiebreaker — head-to-head ISOLATED.
--  Pool A has 4 players (w, x, y, q) in a single round-robin, rigged so the
--  TOP-1 slot is a clean 2-way tie between x and y that ONLY head-to-head can
--  break (wins equal AND point_diff equal):
--    w beats x, w beats y, w beats q     → w = 3 wins (clear #1 ... no — see)
--  Actually we want x and y tied for FIRST so top_1_per_pool's cutoff lands
--  exactly on the H2H pair. Construction (4 players: x, y, p, q):
--    x beats y (H2H: x over y)           x: y,p wins, q loss → 2W, pd +6
--    x beats p, x loses to q
--    y beats p, y beats q, y loses to x  y: p,q wins, x loss → 2W, pd +6
--    p beats q                           p: x? no — p lost x & y, beat q → 1W
--    (q beat x, lost y, lost p → 1W)
--  Result pool A: x=2W/+6, y=2W/+6 tied for #1; p=1W, q=1W below.
--  x and y tie on wins (2) AND point_diff (+6); the ONLY remaining
--  discriminator is head-to-head (x beat y) — seed is given to y (better),
--  so if H2H were not applied the tie would fall to point_diff (equal) then
--  to seed → y would win. With top_1_per_pool only #1 advances, so:
--    correct  → x advances, y excluded.
--    H2H-bug  → y advances, x excluded.
--  Pool B: b1 beats b2 → B1 = b1. Bracket size 2 (P=2,N=1) → Final x vs b1.
-- ════════════════════════════════════════════════════════════
begin;

do $t5$
declare
  v_tid uuid := gen_random_uuid();
  v_ra uuid := gen_random_uuid(); v_rb uuid := gen_random_uuid();
  x uuid := gen_random_uuid(); y uuid := gen_random_uuid();
  p uuid := gen_random_uuid(); q uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_ins int;
  v_y_present int;
  v_x_present int;
  v_final_pair int;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (x,'x-'||v_em),(y,'y-'||v_em),(p,'p-'||v_em),(q,'q-'||v_em),
    (b1,'b1-'||v_em),(b2,'b2-'||v_em);
  insert into public.profiles (id, username, full_name, gender) values
    (x,'t5x_'||substr(x::text,1,8),'X','male'),
    (y,'t5y_'||substr(y::text,1,8),'Y','male'),
    (p,'t5p_'||substr(p::text,1,8),'P','male'),
    (q,'t5q_'||substr(q::text,1,8),'Q','male'),
    (b1,'t5b1_'||substr(b1::text,1,8),'B1','male'),
    (b2,'t5b2_'||substr(b2::text,1,8),'B2','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values (v_tid,'T5 tiebreak H2H isolated','pool_play','singles','top_1_per_pool','active',x);

  -- y gets the BETTER (lower) seed so seed-based tiebreak would favor y.
  -- H2H must override seed (and point_diff is equal) to put x ahead.
  insert into public.tournament_registrations (tournament_id,user_id,status,seed) values
    (v_tid,y,'approved',1),(v_tid,x,'approved',2),
    (v_tid,p,'approved',3),(v_tid,q,'approved',4),
    (v_tid,b1,'approved',5),(v_tid,b2,'approved',6);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type) values
    (v_ra,v_tid,1,'Pool A · Round 1','winners'),
    (v_rb,v_tid,2,'Pool B · Round 1','winners');

  -- Pool A single round-robin (6 matches), all 11-5 so |pd| per game = 6.
  --   x beats y  (H2H x>y)        x: +6
  --   x beats p                   x: +6
  --   q beats x                   x: -6   → x = 2W, pd +6
  --   y beats p                   y: +6
  --   y beats q                   y: +6, plus loss to x (-6) → y = 2W, pd +6
  --   p beats q                   p: beat q only → 1W ; q: beat x only → 1W
  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_ra,0,'singles',x,y,11,5,'team1','completed'),  -- x beats y (H2H)
    (v_tid,v_ra,1,'singles',x,p,11,5,'team1','completed'),  -- x beats p
    (v_tid,v_ra,2,'singles',q,x,11,5,'team1','completed'),  -- q beats x
    (v_tid,v_ra,3,'singles',y,p,11,5,'team1','completed'),  -- y beats p
    (v_tid,v_ra,4,'singles',y,q,11,5,'team1','completed'),  -- y beats q
    (v_tid,v_ra,5,'singles',p,q,11,5,'team1','completed');  -- p beats q

  -- Pool B: b1 beats b2 → B1 = b1.
  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_rb,0,'singles',b1,b2,11,5,'team1','completed');

  v_ins := public.generate_playoff_bracket(v_tid);

  -- top_1_per_pool, B=2 → one Finals match (A1 vs B1).
  assert v_ins = 1, format('T5: expected return 1 (Final only), got %s', v_ins);

  -- x (H2H winner) must be the pool-A #1 and appear in the Final.
  select count(*) into v_x_present
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='finals'
     and (tm.team1_player1=x or tm.team2_player1=x);
  assert v_x_present = 1,
    'T5: x must win the 2-way wins+pd tie on head-to-head and reach the Final';

  -- y (lost H2H to x, but better seed and equal pd) must NOT be in the bracket.
  select count(*) into v_y_present
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='finals'
     and (tm.team1_player1=y or tm.team2_player1=y);
  assert v_y_present = 0,
    'T5: y must be excluded — head-to-head outranks seed when wins+pd are tied';

  -- Final must be x vs b1.
  select count(*) into v_final_pair
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='finals'
     and ((tm.team1_player1=x and tm.team2_player1=b1)
       or (tm.team1_player1=b1 and tm.team2_player1=x));
  assert v_final_pair = 1, 'T5: Final must be pool-A #1 (x) vs pool-B #1 (b1)';

  raise notice 'Test 5 PASS: per-pool 2-way tie (wins+pd equal) broken by H2H — x over y.';
end
$t5$;

rollback;


-- ════════════════════════════════════════════════════════════
--  Test 6: pool-letter parsing from "Pool A · Round k" labels.
--  Multiple rounds per pool (Round 1, Round 2) confirm the function counts
--  DISTINCT pool letters (2), not distinct rounds (4), and aggregates
--  matches across rounds of the same pool.
-- ════════════════════════════════════════════════════════════
begin;

do $t6$
declare
  v_tid uuid := gen_random_uuid();
  v_ra1 uuid := gen_random_uuid(); v_ra2 uuid := gen_random_uuid();
  v_rb1 uuid := gen_random_uuid(); v_rb2 uuid := gen_random_uuid();
  a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid(); a3 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid(); b3 uuid := gen_random_uuid();
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_ins int; v_finals_n int; v_pair int;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (a1,'a1-'||v_em),(a2,'a2-'||v_em),(a3,'a3-'||v_em),
    (b1,'b1-'||v_em),(b2,'b2-'||v_em),(b3,'b3-'||v_em);
  insert into public.profiles (id, username, full_name, gender) values
    (a1,'t6a1_'||substr(a1::text,1,8),'A1','male'),
    (a2,'t6a2_'||substr(a2::text,1,8),'A2','male'),
    (a3,'t6a3_'||substr(a3::text,1,8),'A3','male'),
    (b1,'t6b1_'||substr(b1::text,1,8),'B1','male'),
    (b2,'t6b2_'||substr(b2::text,1,8),'B2','male'),
    (b3,'t6b3_'||substr(b3::text,1,8),'B3','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values (v_tid,'T6 label parsing','pool_play','singles','top_1_per_pool','active',a1);

  insert into public.tournament_registrations (tournament_id,user_id,status,seed) values
    (v_tid,a1,'approved',1),(v_tid,a2,'approved',2),(v_tid,a3,'approved',3),
    (v_tid,b1,'approved',4),(v_tid,b2,'approved',5),(v_tid,b3,'approved',6);

  -- Two rounds per pool, exact "Pool X · Round k" labels (· = U+00B7).
  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type) values
    (v_ra1,v_tid,1,'Pool A · Round 1','winners'),
    (v_ra2,v_tid,2,'Pool A · Round 2','winners'),
    (v_rb1,v_tid,3,'Pool B · Round 1','winners'),
    (v_rb2,v_tid,4,'Pool B · Round 2','winners');

  -- Pool A: a1 beats a2 (R1), a2 beats a3 (R1), a1 beats a3 (R2)
  --   → a1 = 2 wins (pool winner)
  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_ra1,0,'singles',a1,a2,11,5,'team1','completed'),
    (v_tid,v_ra1,1,'singles',a2,a3,11,5,'team1','completed'),
    (v_tid,v_ra2,0,'singles',a1,a3,11,5,'team1','completed');
  -- Pool B: b1 beats b2, b2 beats b3, b1 beats b3 → b1 winner
  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_rb1,0,'singles',b1,b2,11,5,'team1','completed'),
    (v_tid,v_rb1,1,'singles',b2,b3,11,5,'team1','completed'),
    (v_tid,v_rb2,0,'singles',b1,b3,11,5,'team1','completed');

  v_ins := public.generate_playoff_bracket(v_tid);

  -- 2 distinct pools, N=1 → bracket size 2 → Finals a1 vs b1.
  select count(*) into v_finals_n
    from public.tournament_rounds where tournament_id=v_tid and round_type='finals';
  assert v_finals_n = 1,
    format('T6: expected 1 finals round (2 distinct pools, not 4 rounds), got %s', v_finals_n);
  assert v_ins = 1, format('T6: expected return 1, got %s', v_ins);

  select count(*) into v_pair
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='finals'
     and ((tm.team1_player1=a1 and tm.team2_player1=b1)
       or (tm.team1_player1=b1 and tm.team2_player1=a1));
  assert v_pair = 1, 'T6: Final must be pool-A winner a1 vs pool-B winner b1';

  raise notice 'Test 6 PASS: pool letters parsed across multiple rounds per pool.';
end
$t6$;

rollback;


-- ════════════════════════════════════════════════════════════
--  Test 7: non-power-of-2 guard — P=3 pools, N=1 → bracket size 3 RAISES.
--  3 ∉ {2,4,6,8}; must raise a clear exception, not build a bracket.
-- ════════════════════════════════════════════════════════════
begin;

do $t7$
declare
  v_tid uuid := gen_random_uuid();
  v_ra uuid := gen_random_uuid(); v_rb uuid := gen_random_uuid(); v_rc uuid := gen_random_uuid();
  a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid();
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_raised boolean := false;
  v_playoff_rounds int;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (a1,'a1-'||v_em),(a2,'a2-'||v_em),(b1,'b1-'||v_em),(b2,'b2-'||v_em),
    (c1,'c1-'||v_em),(c2,'c2-'||v_em);
  insert into public.profiles (id, username, full_name, gender) values
    (a1,'t7a1_'||substr(a1::text,1,8),'A1','male'),
    (a2,'t7a2_'||substr(a2::text,1,8),'A2','male'),
    (b1,'t7b1_'||substr(b1::text,1,8),'B1','male'),
    (b2,'t7b2_'||substr(b2::text,1,8),'B2','male'),
    (c1,'t7c1_'||substr(c1::text,1,8),'C1','male'),
    (c2,'t7c2_'||substr(c2::text,1,8),'C2','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values (v_tid,'T7 P=3 N=1 (B=3) guard','pool_play','singles','top_1_per_pool','active',a1);

  insert into public.tournament_registrations (tournament_id,user_id,status,seed) values
    (v_tid,a1,'approved',1),(v_tid,a2,'approved',2),
    (v_tid,b1,'approved',3),(v_tid,b2,'approved',4),
    (v_tid,c1,'approved',5),(v_tid,c2,'approved',6);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type) values
    (v_ra,v_tid,1,'Pool A · Round 1','winners'),
    (v_rb,v_tid,2,'Pool B · Round 1','winners'),
    (v_rc,v_tid,3,'Pool C · Round 1','winners');

  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_ra,0,'singles',a1,a2,11,5,'team1','completed'),
    (v_tid,v_rb,0,'singles',b1,b2,11,5,'team1','completed'),
    (v_tid,v_rc,0,'singles',c1,c2,11,5,'team1','completed');

  begin
    perform public.generate_playoff_bracket(v_tid);
  exception when others then
    v_raised := true;
    raise notice 'T7: expected exception raised: %', sqlerrm;
  end;

  assert v_raised, 'T7: P=3 N=1 (bracket size 3) MUST raise, not silently build';

  select count(*) into v_playoff_rounds
    from public.tournament_rounds
   where tournament_id=v_tid
     and round_type in ('quarterfinals','semifinals','finals','third_place_match');
  assert v_playoff_rounds = 0,
    format('T7: no playoff round must be created on guard failure, found %s', v_playoff_rounds);

  raise notice 'Test 7 PASS: P=3 N=1 (B=3) guard raises, no bracket built.';
end
$t7$;

rollback;


-- ════════════════════════════════════════════════════════════
--  Test 8: non-power-of-2 guard — P=5 pools, N=1 → bracket size 5 RAISES.
--  5 ∉ {2,4,6,8}; must raise (this size raises in BOTH #66 and #69).
-- ════════════════════════════════════════════════════════════
begin;

do $t8$
declare
  v_tid uuid := gen_random_uuid();
  v_r uuid;
  pl uuid[];
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_letters text[] := array['A','B','C','D','E'];
  v_i int; v_p1 uuid; v_p2 uuid;
  v_raised boolean := false; v_playoff_rounds int;
  v_owner uuid := gen_random_uuid();
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values (v_owner,'own-'||v_em);
  insert into public.profiles (id, username, full_name, gender)
    values (v_owner,'t8own_'||substr(v_owner::text,1,8),'Owner','male');

  -- 5 pools × 2 players.
  for v_i in 1..5 loop
    v_p1 := gen_random_uuid(); v_p2 := gen_random_uuid();
    pl := array_append(pl, v_p1); pl := array_append(pl, v_p2);
    insert into auth.users (id, email) values
      (v_p1, v_letters[v_i]||'1-'||v_em),
      (v_p2, v_letters[v_i]||'2-'||v_em);
    insert into public.profiles (id, username, full_name, gender) values
      (v_p1, 't8'||v_letters[v_i]||'1_'||substr(v_p1::text,1,8), v_letters[v_i]||'1','male'),
      (v_p2, 't8'||v_letters[v_i]||'2_'||substr(v_p2::text,1,8), v_letters[v_i]||'2','male');
  end loop;
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values (v_tid,'T8 P=5 N=1 (B=5) guard','pool_play','singles','top_1_per_pool','active',v_owner);

  for v_i in 1..10 loop
    insert into public.tournament_registrations (tournament_id,user_id,status,seed)
      values (v_tid, pl[v_i], 'approved', v_i);
  end loop;

  -- One round per pool, p1 beats p2 in each.
  for v_i in 1..5 loop
    v_r := gen_random_uuid();
    insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type)
      values (v_r, v_tid, v_i, 'Pool '||v_letters[v_i]||' · Round 1', 'winners');
    insert into public.tournament_matches
      (tournament_id,round_id,match_order,match_type,
       team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
    values
      (v_tid, v_r, 0, 'singles', pl[(v_i-1)*2+1], pl[(v_i-1)*2+2], 11, 5, 'team1', 'completed');
  end loop;

  begin
    perform public.generate_playoff_bracket(v_tid);
  exception when others then
    v_raised := true;
    raise notice 'T8: expected exception raised: %', sqlerrm;
  end;

  assert v_raised, 'T8: P=5 N=1 (bracket size 5) MUST raise, not silently build';

  select count(*) into v_playoff_rounds
    from public.tournament_rounds
   where tournament_id=v_tid
     and round_type in ('quarterfinals','semifinals','finals','third_place_match');
  assert v_playoff_rounds = 0,
    format('T8: no playoff round must be created on guard failure, found %s', v_playoff_rounds);

  raise notice 'Test 8 PASS: P=5 N=1 (B=5) guard raises, no bracket built.';
end
$t8$;

rollback;


-- ════════════════════════════════════════════════════════════
--  Test 9: P=3 pools, N=2 → bracket size 6.
--  LIVE behavior (PR #69): BYE-pad to an 8-slot Quarterfinals — TWO BYE
--  matches (match_type='bye', status='completed') for the top 2 seeds plus
--  TWO real pending QFs. (In PR #66 this RAISED; #69 supersedes it.)
--  Pins the live behavior so a regression that drops BYE-padding is caught.
--  Also asserts the two real QFs are not same-pool round-1 matches.
-- ════════════════════════════════════════════════════════════
begin;

do $t9$
declare
  v_tid uuid := gen_random_uuid();
  v_ra uuid := gen_random_uuid(); v_rb uuid := gen_random_uuid(); v_rc uuid := gen_random_uuid();
  a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid();
  b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
  c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid();
  v_em text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  v_ins int; v_qf_n int; v_qf_total int; v_bye int; v_real int;
  v_same_pool_r1 int;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (a1,'a1-'||v_em),(a2,'a2-'||v_em),(b1,'b1-'||v_em),(b2,'b2-'||v_em),
    (c1,'c1-'||v_em),(c2,'c2-'||v_em);
  insert into public.profiles (id, username, full_name, gender) values
    (a1,'t9a1_'||substr(a1::text,1,8),'A1','male'),
    (a2,'t9a2_'||substr(a2::text,1,8),'A2','male'),
    (b1,'t9b1_'||substr(b1::text,1,8),'B1','male'),
    (b2,'t9b2_'||substr(b2::text,1,8),'B2','male'),
    (c1,'t9c1_'||substr(c1::text,1,8),'C1','male'),
    (c2,'t9c2_'||substr(c2::text,1,8),'C2','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments
    (id,name,format,match_type,playoff_format,status,created_by)
  values (v_tid,'T9 P=3 N=2 (B=6) BYE-pad','pool_play','singles','top_2_per_pool','active',a1);

  -- Seeds: pool winners A1,B1 are the top-2 overall (lowest seeds) so they
  -- should receive the BYEs.
  insert into public.tournament_registrations (tournament_id,user_id,status,seed) values
    (v_tid,a1,'approved',1),(v_tid,b1,'approved',2),(v_tid,c1,'approved',3),
    (v_tid,a2,'approved',4),(v_tid,b2,'approved',5),(v_tid,c2,'approved',6);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type) values
    (v_ra,v_tid,1,'Pool A · Round 1','winners'),
    (v_rb,v_tid,2,'Pool B · Round 1','winners'),
    (v_rc,v_tid,3,'Pool C · Round 1','winners');

  insert into public.tournament_matches
    (tournament_id,round_id,match_order,match_type,
     team1_player1,team2_player1,team1_score,team2_score,winner_team,status)
  values
    (v_tid,v_ra,0,'singles',a1,a2,11,5,'team1','completed'),
    (v_tid,v_rb,0,'singles',b1,b2,11,5,'team1','completed'),
    (v_tid,v_rc,0,'singles',c1,c2,11,5,'team1','completed');

  v_ins := public.generate_playoff_bracket(v_tid);

  select count(*) into v_qf_n
    from public.tournament_rounds where tournament_id=v_tid and round_type='quarterfinals';
  assert v_qf_n = 1, format('T9: expected 1 quarterfinals round (BYE-padded), got %s', v_qf_n);

  select count(*) into v_qf_total
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals';
  assert v_qf_total = 4,
    format('T9: expected 4 QF rows (2 BYE + 2 real) in 8-slot pad, got %s', v_qf_total);
  assert v_ins = 4, format('T9: expected return 4, got %s', v_ins);

  select count(*) into v_bye
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals'
     and tm.match_type='bye' and tm.status='completed' and tm.team2_player1 is null;
  assert v_bye = 2, format('T9: expected 2 BYE matches, got %s', v_bye);

  select count(*) into v_real
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals'
     and tm.match_type<>'bye' and tm.status='pending'
     and tm.team1_player1 is not null and tm.team2_player1 is not null;
  assert v_real = 2, format('T9: expected 2 real pending QFs, got %s', v_real);

  -- The two real QFs must not be same-pool round-1 matches.
  select count(*) into v_same_pool_r1
    from public.tournament_matches tm join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='quarterfinals' and tm.match_type<>'bye'
     and ( (tm.team1_player1 in (a1,a2) and tm.team2_player1 in (a1,a2))
        or (tm.team1_player1 in (b1,b2) and tm.team2_player1 in (b1,b2))
        or (tm.team1_player1 in (c1,c2) and tm.team2_player1 in (c1,c2)) );
  assert v_same_pool_r1 = 0, 'T9: BYE-padded real QFs must not be same-pool R1 matches';

  raise notice 'Test 9 PASS: P=3 N=2 (B=6) BYE-padded to 8-slot QF (2 BYE + 2 real), no same-pool R1.';
end
$t9$;

rollback;
