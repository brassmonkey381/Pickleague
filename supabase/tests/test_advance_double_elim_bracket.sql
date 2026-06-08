-- ============================================================
-- Tier-3 SQL test for `public._advance_double_elim_bracket`
-- (Unit 8 verification sweep).
--
-- Exercises the double-elim advancement trigger end-to-end for clean
-- power-of-2 brackets (N=4 and N=8) plus one odd case (N=6), driving the
-- winners + losers brackets to completion by flipping matches to
-- `completed` with `winner_team` set, and asserting the STRUCTURE the
-- trigger creates (rows, not exceptions — the trigger swallows errors).
--
-- This test validates the FIXED behavior, so the fix function must be
-- loaded inside the same transaction before the asserts run. The whole
-- thing is rolled back at the end, so prod is never touched.
--
--   • psql:        the `\i` line below pulls in the fix automatically:
--                    psql "$DATABASE_URL" -f supabase/tests/test_advance_double_elim_bracket.sql
--   • MCP/SQL ed.: psql meta-commands (`\i`) are NOT supported. Concatenate
--                  the fix migration in front of this file and run as ONE
--                  statement batch, e.g.:
--                    cat supabase/migration_fix_double_elim_advance.sql \
--                        supabase/tests/test_advance_double_elim_bracket.sql
--                  (the create-or-replace runs inside this file's BEGIN and
--                   is rolled back with everything else — prod untouched).
--                  When concatenating, delete the `\i` line below first.
--
-- Clean run = no error + ROLLBACK + all asserts pass.
--
-- BUG under test (fixed by migration_fix_double_elim_advance.sql):
--   The original LB branch treated ANY losers round resolving to one
--   winner as the LB final and created the Grand Final immediately. For
--   power-of-2 brackets that skipped the final drop-in round, eliminating
--   the WB-final loser without a losers-bracket match:
--     N=4 → skipped LB R2 (WB R2 loser never plays in LB)
--     N=8 → skipped LB R4 (WB R3/final loser never plays in LB)
--   The fix only treats LB round (2K-2) — where K = WB round count — as
--   the final, so earlier single-winner consolidation rounds advance.
--
-- Score sanity: winning >= 11, margin >= 2 (we use 11-5).
-- round_type strings: 'winners', 'losers', 'grand_final'.
-- ============================================================

begin;

-- ── Apply the fix inside the transaction (rolled back at the end) ──
-- psql ONLY (delete these 2 lines for MCP/SQL-editor; concatenate the fix
-- migration in front of this file instead — see header).
\set ON_ERROR_STOP on
\i supabase/migration_fix_double_elim_advance.sql

-- ════════════════════════════════════════════════════════════
--  TEST 1 — N=4, bracket-RESET path (LB finalist wins GF1 → GF2)
-- ════════════════════════════════════════════════════════════
do $t1$
declare
  v_tid    uuid := gen_random_uuid();
  v_wb1    uuid := gen_random_uuid();   -- winners round 1
  v_a uuid := gen_random_uuid();        -- seed 1
  v_b uuid := gen_random_uuid();        -- seed 2
  v_c uuid := gen_random_uuid();        -- seed 3
  v_d uuid := gen_random_uuid();        -- seed 4
  v_m_ad uuid := gen_random_uuid();     -- WB R1 mo0: A vs D
  v_m_bc uuid := gen_random_uuid();     -- WB R1 mo1: B vs C
  v_email text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';

  v_lb1_rid uuid; v_lb2_rid uuid; v_wb2_rid uuid; v_gf1_rid uuid; v_gf2_rid uuid;
  v_lb1_id  uuid; v_lb2_id  uuid; v_wb2_id  uuid; v_gf1_id  uuid; v_gf2_id  uuid;
  v_cnt integer; v_status text;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (v_a, 'a-'||v_email), (v_b, 'b-'||v_email),
    (v_c, 'c-'||v_email), (v_d, 'd-'||v_email);
  insert into public.profiles (id, username, full_name, gender) values
    (v_a, 'de4_a_'||substr(v_a::text,1,8), 'DE4 A', 'male'),
    (v_b, 'de4_b_'||substr(v_b::text,1,8), 'DE4 B', 'male'),
    (v_c, 'de4_c_'||substr(v_c::text,1,8), 'DE4 C', 'male'),
    (v_d, 'de4_d_'||substr(v_d::text,1,8), 'DE4 D', 'male');
  set local session_replication_role = 'origin';

  insert into public.tournaments (id, name, format, match_type, status, created_by)
  values (v_tid, 'DE N=4 reset', 'double_elimination', 'singles', 'active', v_a);

  -- WB round 1 (the only round generateDoubleElim emits).
  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_wb1, v_tid, 1, 'Winners Round 1', 'winners');

  insert into public.tournament_matches
    (id, tournament_id, round_id, match_order, match_type, team1_player1, team2_player1, status)
  values
    (v_m_ad, v_tid, v_wb1, 0, 'singles', v_a, v_d, 'pending'),
    (v_m_bc, v_tid, v_wb1, 1, 'singles', v_b, v_c, 'pending');

  -- Complete WB R1: A>D, B>C.
  update public.tournament_matches set team1_score=11, team2_score=5, winner_team='team1', status='completed' where id=v_m_ad;
  update public.tournament_matches set team1_score=11, team2_score=5, winner_team='team1', status='completed' where id=v_m_bc;

  -- INVARIANT: WB R1 losers (D, C) form LB R1 paired together.
  select id into v_lb1_rid from public.tournament_rounds
   where tournament_id=v_tid and round_type='losers' and round_number=1;
  assert v_lb1_rid is not null, 'T1: LB R1 round should exist after WB R1';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_lb1_rid;
  assert v_cnt = 1, format('T1: LB R1 should have 1 match, got %s', v_cnt);
  select count(*) into v_cnt from public.tournament_matches
   where round_id=v_lb1_rid
     and ((team1_player1=v_d and team2_player1=v_c) or (team1_player1=v_c and team2_player1=v_d));
  assert v_cnt = 1, 'T1: LB R1 match should pair WB R1 losers C vs D';

  -- INVARIANT: WB R2 (the WB final) pairs the two WB R1 winners A vs B.
  select id into v_wb2_rid from public.tournament_rounds
   where tournament_id=v_tid and round_type='winners' and round_number=2;
  assert v_wb2_rid is not null, 'T1: WB R2 should exist';
  select id into v_wb2_id from public.tournament_matches where round_id=v_wb2_rid limit 1;
  select count(*) into v_cnt from public.tournament_matches
   where round_id=v_wb2_rid
     and ((team1_player1=v_a and team2_player1=v_b) or (team1_player1=v_b and team2_player1=v_a));
  assert v_cnt = 1, 'T1: WB R2 should pair WB R1 winners A vs B';

  -- Complete WB R2 (WB final): A>B. B is the WB-final loser.
  update public.tournament_matches set team1_score=11, team2_score=5, winner_team='team1', status='completed' where id=v_wb2_id;

  -- GF must NOT exist yet (LB not done).
  select count(*) into v_cnt from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final';
  assert v_cnt = 0, 'T1: Grand Final must NOT exist before LB completes';

  -- Complete LB R1: C>D.
  select id into v_lb1_id from public.tournament_matches where round_id=v_lb1_rid limit 1;
  -- Ensure C is team1 or team2 — winner_team must reference C. Set winner to whichever side holds C.
  update public.tournament_matches
     set team1_score = case when team1_player1=v_c then 11 else 5 end,
         team2_score = case when team1_player1=v_c then 5 else 11 end,
         winner_team = case when team1_player1=v_c then 'team1' else 'team2' end,
         status='completed'
   where id=v_lb1_id;

  -- INVARIANT (regression): LB R2 (drop-in) created = LB R1 winner C vs WB R2 loser B.
  -- This is the round the BUG skipped.
  select id into v_lb2_rid from public.tournament_rounds
   where tournament_id=v_tid and round_type='losers' and round_number=2;
  assert v_lb2_rid is not null, 'T1 REGRESSION: LB R2 drop-in must exist (WB-final loser needs a LB game)';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_lb2_rid;
  assert v_cnt = 1, format('T1: LB R2 should have 1 match, got %s', v_cnt);
  select count(*) into v_cnt from public.tournament_matches
   where round_id=v_lb2_rid
     and (team1_player1 in (v_b,v_c) and team2_player1 in (v_b,v_c) and team1_player1<>team2_player1);
  assert v_cnt = 1, 'T1: LB R2 must pair LB R1 winner C vs WB R2 loser B';

  -- GF still must NOT exist (LB R2 not played).
  select count(*) into v_cnt from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final';
  assert v_cnt = 0, 'T1: GF must NOT exist before LB R2 completes';

  -- Complete LB R2: C wins → C is LB finalist.
  select id into v_lb2_id from public.tournament_matches where round_id=v_lb2_rid limit 1;
  update public.tournament_matches
     set team1_score = case when team1_player1=v_c then 11 else 5 end,
         team2_score = case when team1_player1=v_c then 5 else 11 end,
         winner_team = case when team1_player1=v_c then 'team1' else 'team2' end,
         status='completed'
   where id=v_lb2_id;

  -- INVARIANT: GF1 created from WB finalist (A) vs LB finalist (C). team1=WB, team2=LB.
  select id into v_gf1_rid from public.tournament_rounds
   where tournament_id=v_tid and round_type='grand_final' and round_number=1;
  assert v_gf1_rid is not null, 'T1: Grand Final round 1 must exist after both finals';
  select id into v_gf1_id from public.tournament_matches where round_id=v_gf1_rid limit 1;
  select count(*) into v_cnt from public.tournament_matches
   where round_id=v_gf1_rid and team1_player1=v_a and team2_player1=v_c;
  assert v_cnt = 1, 'T1: GF1 must be team1=WB finalist A, team2=LB finalist C';

  -- BRACKET RESET: LB finalist (team2 = C) wins GF1 → GF2 must be created.
  update public.tournament_matches set team1_score=5, team2_score=11, winner_team='team2', status='completed' where id=v_gf1_id;
  select id into v_gf2_rid from public.tournament_rounds
   where tournament_id=v_tid and round_type='grand_final' and round_number=2;
  assert v_gf2_rid is not null, 'T1: bracket RESET — LB finalist won GF1, GF2 must exist';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_gf2_rid;
  assert v_cnt = 1, format('T1: GF2 should have 1 match, got %s', v_cnt);
  -- Tournament must NOT be complete yet (GF2 pending).
  select status into v_status from public.tournaments where id=v_tid;
  assert v_status <> 'completed', 'T1: tournament must not complete until GF2 is played';

  -- Complete GF2: A wins → champion.
  select id into v_gf2_id from public.tournament_matches where round_id=v_gf2_rid limit 1;
  update public.tournament_matches
     set team1_score = case when team1_player1=v_a then 11 else 5 end,
         team2_score = case when team1_player1=v_a then 5 else 11 end,
         winner_team = case when team1_player1=v_a then 'team1' else 'team2' end,
         status='completed'
   where id=v_gf2_id;

  -- INVARIANT: exactly one champion; tournament completed.
  select status into v_status from public.tournaments where id=v_tid;
  assert v_status = 'completed', 'T1: tournament must be completed after GF2';
  select count(*) into v_cnt from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final';
  assert v_cnt = 2, format('T1: should have exactly GF1+GF2 (=2 GF rounds) on reset, got %s', v_cnt);

  raise notice 'TEST 1 (N=4, bracket reset): PASS';
end
$t1$;

-- ════════════════════════════════════════════════════════════
--  TEST 2 — N=8, NON-reset path (WB finalist wins GF1 → no GF2)
-- ════════════════════════════════════════════════════════════
do $t2$
declare
  v_tid uuid := gen_random_uuid();
  v_wb1 uuid := gen_random_uuid();
  v_a uuid:=gen_random_uuid(); v_b uuid:=gen_random_uuid(); v_c uuid:=gen_random_uuid(); v_d uuid:=gen_random_uuid();
  v_e uuid:=gen_random_uuid(); v_f uuid:=gen_random_uuid(); v_g uuid:=gen_random_uuid(); v_h uuid:=gen_random_uuid();
  v_email text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  -- WB R1 matches (1vN seeding): A-H, B-G, C-F, D-E
  v_m_ah uuid:=gen_random_uuid(); v_m_bg uuid:=gen_random_uuid();
  v_m_cf uuid:=gen_random_uuid(); v_m_de uuid:=gen_random_uuid();
  v_rid uuid; v_mid uuid; v_cnt integer; v_status text;
  v_lb1 uuid; v_lb2 uuid; v_lb3 uuid; v_lb4 uuid; v_wb2 uuid; v_wb3 uuid; v_gf1 uuid;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id,email) values
   (v_a,'a-'||v_email),(v_b,'b-'||v_email),(v_c,'c-'||v_email),(v_d,'d-'||v_email),
   (v_e,'e-'||v_email),(v_f,'f-'||v_email),(v_g,'g-'||v_email),(v_h,'h-'||v_email);
  insert into public.profiles (id,username,full_name,gender) values
   (v_a,'de8_a_'||substr(v_a::text,1,8),'DE8 A','male'),
   (v_b,'de8_b_'||substr(v_b::text,1,8),'DE8 B','male'),
   (v_c,'de8_c_'||substr(v_c::text,1,8),'DE8 C','male'),
   (v_d,'de8_d_'||substr(v_d::text,1,8),'DE8 D','male'),
   (v_e,'de8_e_'||substr(v_e::text,1,8),'DE8 E','male'),
   (v_f,'de8_f_'||substr(v_f::text,1,8),'DE8 F','male'),
   (v_g,'de8_g_'||substr(v_g::text,1,8),'DE8 G','male'),
   (v_h,'de8_h_'||substr(v_h::text,1,8),'DE8 H','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments (id,name,format,match_type,status,created_by)
  values (v_tid,'DE N=8 no-reset','double_elimination','singles','active',v_a);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type)
  values (v_wb1,v_tid,1,'Winners Round 1','winners');

  insert into public.tournament_matches
   (id,tournament_id,round_id,match_order,match_type,team1_player1,team2_player1,status)
  values
   (v_m_ah,v_tid,v_wb1,0,'singles',v_a,v_h,'pending'),
   (v_m_bg,v_tid,v_wb1,1,'singles',v_b,v_g,'pending'),
   (v_m_cf,v_tid,v_wb1,2,'singles',v_c,v_f,'pending'),
   (v_m_de,v_tid,v_wb1,3,'singles',v_d,v_e,'pending');

  -- Complete WB R1 — top seeds win: A,B,C,D advance; H,G,F,E drop.
  update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id in (v_m_ah,v_m_bg,v_m_cf,v_m_de);

  -- INVARIANT: WB R1 losers form LB R1 paired (H/G, F/E) → 2 matches.
  select id into v_lb1 from public.tournament_rounds where tournament_id=v_tid and round_type='losers' and round_number=1;
  assert v_lb1 is not null, 'T2: LB R1 must exist';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_lb1;
  assert v_cnt = 2, format('T2: LB R1 should have 2 matches, got %s', v_cnt);

  -- WB R2 created with 2 matches (A/B, C/D).
  select id into v_wb2 from public.tournament_rounds where tournament_id=v_tid and round_type='winners' and round_number=2;
  assert v_wb2 is not null, 'T2: WB R2 must exist';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_wb2;
  assert v_cnt = 2, format('T2: WB R2 should have 2 matches, got %s', v_cnt);

  -- Complete LB R1: team1 wins each match (H, F survive). Deterministic; the
  -- specific survivor identity doesn't matter for the structural asserts.
  for v_mid in select id from public.tournament_matches where round_id=v_lb1 order by match_order loop
    update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id=v_mid;
  end loop;

  -- Complete WB R2: team1 wins each (A>B mo0, C>D mo1). B,D are WB R2 losers.
  for v_mid in select id from public.tournament_matches where round_id=v_wb2 order by match_order loop
    update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id=v_mid;
  end loop;

  -- INVARIANT: LB R2 (drop-in) created with 2 matches (LB R1 winners vs WB R2 losers B,D).
  select id into v_lb2 from public.tournament_rounds where tournament_id=v_tid and round_type='losers' and round_number=2;
  assert v_lb2 is not null, 'T2: LB R2 drop-in must exist after WB R2 + LB R1';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_lb2;
  assert v_cnt = 2, format('T2: LB R2 should have 2 matches, got %s', v_cnt);
  -- The WB R2 losers (B,D) must appear in LB R2.
  select count(*) into v_cnt from public.tournament_matches
   where round_id=v_lb2 and (team1_player1 in (v_b,v_d) or team2_player1 in (v_b,v_d));
  assert v_cnt >= 1, 'T2: WB R2 losers (B/D) must drop into LB R2';

  -- WB R3 (WB final) created with 1 match (A vs C).
  select id into v_wb3 from public.tournament_rounds where tournament_id=v_tid and round_type='winners' and round_number=3;
  assert v_wb3 is not null, 'T2: WB R3 (WB final) must exist';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_wb3;
  assert v_cnt = 1, format('T2: WB R3 should have 1 match, got %s', v_cnt);

  -- Complete WB R3: A>C. C is the WB-final loser (must get a LB R4 game).
  select id into v_mid from public.tournament_matches where round_id=v_wb3 limit 1;
  update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id=v_mid;

  -- GF must NOT exist yet (LB not finished).
  select count(*) into v_cnt from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final';
  assert v_cnt = 0, 'T2: GF must NOT exist before LB completes';

  -- Complete LB R2 (drop-in) → LB R3 (consolidation, 1 match) should appear.
  for v_mid in select id from public.tournament_matches where round_id=v_lb2 order by match_order loop
    update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id=v_mid;
  end loop;
  select id into v_lb3 from public.tournament_rounds where tournament_id=v_tid and round_type='losers' and round_number=3;
  assert v_lb3 is not null, 'T2: LB R3 (consolidation) must exist after LB R2';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_lb3;
  assert v_cnt = 1, format('T2: LB R3 should have 1 match, got %s', v_cnt);

  -- Complete LB R3 (1 winner). BUG would create GF here; FIX must create LB R4 instead.
  select id into v_mid from public.tournament_matches where round_id=v_lb3 limit 1;
  update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id=v_mid;

  -- INVARIANT (regression): GF must NOT exist yet; LB R4 (drop-in vs WB-final loser C) must exist.
  select count(*) into v_cnt from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final';
  assert v_cnt = 0, 'T2 REGRESSION: GF must NOT be created after LB R3 — LB R4 still owed';
  select id into v_lb4 from public.tournament_rounds where tournament_id=v_tid and round_type='losers' and round_number=4;
  assert v_lb4 is not null, 'T2 REGRESSION: LB R4 drop-in must exist (WB-final loser needs a LB game)';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_lb4;
  assert v_cnt = 1, format('T2: LB R4 should have 1 match, got %s', v_cnt);
  -- The WB-final loser C must be in LB R4.
  select count(*) into v_cnt from public.tournament_matches
   where round_id=v_lb4 and (team1_player1=v_c or team2_player1=v_c);
  assert v_cnt = 1, 'T2: WB-final loser C must drop into LB R4';

  -- Complete LB R4 → LB finalist decided → GF1 created.
  select id into v_mid from public.tournament_matches where round_id=v_lb4 limit 1;
  update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id=v_mid;

  -- INVARIANT: GF1 created with team1 = WB finalist A.
  select id into v_gf1 from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final' and round_number=1;
  assert v_gf1 is not null, 'T2: GF1 must exist after LB R4';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_gf1 and team1_player1=v_a;
  assert v_cnt = 1, 'T2: GF1 team1 must be WB finalist A';

  -- NON-RESET: WB finalist (team1 = A) wins GF1 → tournament complete, NO GF2.
  select id into v_mid from public.tournament_matches where round_id=v_gf1 limit 1;
  update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id=v_mid;

  select count(*) into v_cnt from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final' and round_number=2;
  assert v_cnt = 0, 'T2: WB finalist won GF1 → NO GF2 (bracket reset must not fire)';
  select status into v_status from public.tournaments where id=v_tid;
  assert v_status = 'completed', 'T2: tournament must be completed after WB finalist wins GF1';

  raise notice 'TEST 2 (N=8, no reset): PASS';
end
$t2$;

-- ════════════════════════════════════════════════════════════
--  TEST 3 — N=6 odd case: documents the odd-loser-bye LB limitation.
--  generateSingleElim pads 6→8 and DROPS BYE matches, so the top 2
--  seeds (A,B) get WB R1 byes and are absent from WB R1. WB R1 has only
--  2 played matches (C-F, D-E). The trigger never injects the bye'd
--  seeds into WB R2, so the WB bracket cannot complete from this seed
--  alone. We assert the DOCUMENTED behavior: WB R1 has 2 matches, LB R1
--  pairs the 2 WB R1 losers, and (limitation) no further WB round is
--  auto-built for the absent bye seeds. This is the limitation noted at
--  migration_double_elim_advancement.sql lines ~295-302.
-- ════════════════════════════════════════════════════════════
do $t3$
declare
  v_tid uuid := gen_random_uuid();
  v_wb1 uuid := gen_random_uuid();
  v_a uuid:=gen_random_uuid(); v_b uuid:=gen_random_uuid(); v_c uuid:=gen_random_uuid();
  v_d uuid:=gen_random_uuid(); v_e uuid:=gen_random_uuid(); v_f uuid:=gen_random_uuid();
  v_email text := 'wkr-' || gen_random_uuid()::text || '@test.invalid';
  -- 6 seeds padded to 8 → byes for A(s1),B(s2). Played: C(s3)-F(s6), D(s4)-E(s5).
  v_m_cf uuid:=gen_random_uuid(); v_m_de uuid:=gen_random_uuid();
  v_lb1 uuid; v_cnt integer;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id,email) values
   (v_a,'a-'||v_email),(v_b,'b-'||v_email),(v_c,'c-'||v_email),
   (v_d,'d-'||v_email),(v_e,'e-'||v_email),(v_f,'f-'||v_email);
  insert into public.profiles (id,username,full_name,gender) values
   (v_a,'de6_a_'||substr(v_a::text,1,8),'DE6 A','male'),
   (v_b,'de6_b_'||substr(v_b::text,1,8),'DE6 B','male'),
   (v_c,'de6_c_'||substr(v_c::text,1,8),'DE6 C','male'),
   (v_d,'de6_d_'||substr(v_d::text,1,8),'DE6 D','male'),
   (v_e,'de6_e_'||substr(v_e::text,1,8),'DE6 E','male'),
   (v_f,'de6_f_'||substr(v_f::text,1,8),'DE6 F','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments (id,name,format,match_type,status,created_by)
  values (v_tid,'DE N=6 odd','double_elimination','singles','active',v_a);

  insert into public.tournament_rounds (id,tournament_id,round_number,label,round_type)
  values (v_wb1,v_tid,1,'Winners Round 1','winners');

  -- Only the 2 non-BYE WB R1 matches exist (mirrors generateSingleElim drop).
  insert into public.tournament_matches
   (id,tournament_id,round_id,match_order,match_type,team1_player1,team2_player1,status)
  values
   (v_m_cf,v_tid,v_wb1,0,'singles',v_c,v_f,'pending'),
   (v_m_de,v_tid,v_wb1,1,'singles',v_d,v_e,'pending');

  update public.tournament_matches set team1_score=11,team2_score=5,winner_team='team1',status='completed' where id in (v_m_cf,v_m_de);

  -- WB R1 had 2 played matches.
  select count(*) into v_cnt from public.tournament_matches where round_id=v_wb1;
  assert v_cnt = 2, format('T3: WB R1 should have 2 played matches, got %s', v_cnt);

  -- LB R1 pairs the 2 WB R1 losers (F, E).
  select id into v_lb1 from public.tournament_rounds where tournament_id=v_tid and round_type='losers' and round_number=1;
  assert v_lb1 is not null, 'T3: LB R1 must exist';
  select count(*) into v_cnt from public.tournament_matches where round_id=v_lb1;
  assert v_cnt = 1, format('T3: LB R1 should have 1 match (F vs E), got %s', v_cnt);
  select count(*) into v_cnt from public.tournament_matches
   where round_id=v_lb1 and ((team1_player1=v_f and team2_player1=v_e) or (team1_player1=v_e and team2_player1=v_f));
  assert v_cnt = 1, 'T3: LB R1 must pair WB R1 losers F vs E';

  -- WB advancement: 2 winners (C,D) pair into WB R2. The bye seeds A,B are
  -- NOT injected (documented limitation) — WB R2 holds only C vs D.
  select count(*) into v_cnt from public.tournament_rounds where tournament_id=v_tid and round_type='winners' and round_number=2;
  assert v_cnt = 1, 'T3: WB R2 created from the 2 played-round winners';
  select count(*) into v_cnt from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id=tm.round_id
   where tr.tournament_id=v_tid and tr.round_type='winners' and tr.round_number=2
     and (tm.team1_player1 in (v_a,v_b) or tm.team2_player1 in (v_a,v_b));
  assert v_cnt = 0, 'T3 (documented limitation): bye seeds A,B are NOT auto-injected into WB R2';

  raise notice 'TEST 3 (N=6 odd): PASS — documents odd-loser-bye LB limitation';
end
$t3$;

rollback;
