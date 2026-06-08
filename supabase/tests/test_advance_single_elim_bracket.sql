-- ============================================================
-- Tier-3 SQL test for `public._advance_single_elim_bracket`.
--
-- Unit 7 — single-elimination advancement trigger.
--
-- Sweeps bracket sizes:
--   * clean powers of 2:  N ∈ {2, 4, 8}
--   * non-powers of 2:    N ∈ {3, 5, 6, 7}   (top seeds get round-1 byes)
--
-- For each N it builds a synthetic single_elimination tournament exactly
-- the way the mobile client does (TournamentDetailScreen.doLockIn):
--   - approved tournament_registrations with seed = 1..N
--   - one round-1 `winners` round
--   - round-1 tournament_matches ONLY for the surviving (non-bye)
--     pairings, with CONTIGUOUS match_order, matching generateSingleElim +
--     the client's `match_order: i` re-indexing.  Top `pow2-N` seeds have
--     NO round-1 row at all (they "bye").
-- then drives every round to completion round-by-round and asserts:
--   - the bracket converges to exactly ONE champion (tournament.status
--     flips to 'completed' and the final round has a single winner)
--   - for non-power-of-2 N, the bye'd top seeds REACH round 2 (they are
--     not silently dropped — the original bug)
--   - the final round is labelled 'Finals' / round_type='finals'.
--
-- The whole thing runs inside one begin … rollback so nothing persists.
-- It also redefines the FIXED trigger + helper inside the transaction
-- (migration_fix_single_elim_advance.sql), so this file both VALIDATES
-- the fix and serves as its regression test. The redefinition is undone
-- by the rollback, leaving prod untouched.
--
-- The trigger SWALLOWS / warns on errors, so we never rely on an
-- exception surfacing — every assertion is made on the ROWS the trigger
-- created (round counts, participants present, champion).
-- ============================================================

begin;

-- ── 0. Install the FIXED function + helper (rolled back at the end) ──
create or replace function public._se_round1_slot_winner(
  p_round_id      uuid,
  p_seeds         uuid[],
  p_seeds2        uuid[],
  p_pow2          integer,
  p_entrant_count integer,
  p_slot          integer
)
returns table (p1 uuid, p2 uuid)
language plpgsql stable as $$
declare
  v_top_seed integer := p_slot + 1;
  v_bot_seed integer := p_pow2 - p_slot;
  v_top1 uuid; v_top2 uuid;
  v_bot1 uuid; v_bot2 uuid;
  v_m record;
begin
  v_top1 := p_seeds[v_top_seed];
  v_top2 := p_seeds2[v_top_seed];

  if v_bot_seed > p_entrant_count then
    p1 := v_top1; p2 := v_top2; return next; return;
  end if;

  v_bot1 := p_seeds[v_bot_seed];
  v_bot2 := p_seeds2[v_bot_seed];

  select * into v_m
    from public.tournament_matches tm
   where tm.round_id = p_round_id
     and tm.winner_team in ('team1','team2')
     and (
       (tm.team1_player1 = v_top1 and tm.team2_player1 = v_bot1)
       or (tm.team1_player1 = v_bot1 and tm.team2_player1 = v_top1)
     )
   limit 1;

  if v_m.id is null then
    p1 := v_top1; p2 := v_top2; return next; return;
  end if;

  if v_m.winner_team = 'team1' then
    p1 := v_m.team1_player1; p2 := v_m.team1_player2;
  else
    p1 := v_m.team2_player1; p2 := v_m.team2_player2;
  end if;
  return next;
end;
$$;

create or replace function public._advance_single_elim_bracket()
returns trigger language plpgsql security definer as $$
declare
  v_format          text;
  v_match_type      text;
  v_round_number    integer;
  v_round_type      text;
  v_min_round_num   integer;
  v_is_first_round  boolean;
  v_uncompleted     integer;
  v_winner_count    integer;
  v_next_round_id   uuid;
  v_next_round_num  integer;
  v_next_round_type text;
  v_next_label      text;
  v_pair_count      integer;
  v_i               integer;
  v_w1              record;
  v_w2              record;
  v_entrant_count   integer;
  v_pow2            integer;
  v_slot_matches    integer;
  v_round2_pairs    integer;
  v_seeds           uuid[];
  v_seeds2          uuid[];
  v_top_seed        integer;
  v_bot_seed        integer;
  v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    select format, match_type
      into v_format, v_match_type
      from public.tournaments
     where id = new.tournament_id;
    -- Bug #4 fix: single_elimination ONLY (DE is owned by its dedicated
    -- trigger; this trigger used to prematurely complete DE at the WB final).
    if v_format <> 'single_elimination' then
      return new;
    end if;

    select round_number, round_type
      into v_round_number, v_round_type
      from public.tournament_rounds
     where id = new.round_id;
    if v_round_number is null then return new; end if;

    select count(*) into v_uncompleted
      from public.tournament_matches
     where round_id = new.round_id
       and status <> 'completed';
    if v_uncompleted > 0 then return new; end if;

    v_next_round_num := v_round_number + 1;
    if exists (
      select 1 from public.tournament_rounds
       where tournament_id = new.tournament_id
         and round_number = v_next_round_num
    ) then
      return new;
    end if;

    select min(round_number) into v_min_round_num
      from public.tournament_rounds
     where tournament_id = new.tournament_id
       and round_type in ('winners', 'finals', 'quarterfinals', 'semifinals');
    v_is_first_round := (v_round_number = coalesce(v_min_round_num, v_round_number));

    select count(*) into v_winner_count
      from public.tournament_matches
     where round_id = new.round_id
       and winner_team in ('team1', 'team2');

    if v_is_first_round
       and v_format = 'single_elimination'
       and coalesce(v_match_type, 'singles') = 'singles' then
      select array_agg(user_id order by ord)
        into v_seeds
        from (
          select r.user_id,
                 row_number() over (
                   order by r.seed asc nulls last, r.registered_at asc, r.user_id
                 ) as ord
            from public.tournament_registrations r
           where r.tournament_id = new.tournament_id
             and r.status = 'approved'
        ) s;
      v_seeds2 := v_seeds;
      v_entrant_count := coalesce(array_length(v_seeds, 1), 0);

      if v_entrant_count >= 3 and v_entrant_count > v_winner_count * 2 then
        v_pow2 := 1;
        while v_pow2 < v_entrant_count loop v_pow2 := v_pow2 * 2; end loop;
        v_slot_matches := v_pow2 / 2;
        v_round2_pairs := v_slot_matches / 2;

        if v_round2_pairs >= 1 then
          if v_round2_pairs = 1 then
            v_next_round_type := 'finals';
            v_next_label      := 'Finals';
          else
            v_next_round_type := 'winners';
            v_next_label      := format('Round %s', v_next_round_num);
          end if;

          insert into public.tournament_rounds
            (tournament_id, round_number, label, round_type)
          values
            (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type)
          returning id into v_next_round_id;

          for v_i in 0 .. (v_round2_pairs - 1) loop
            select sw.p1, sw.p2 into v_a1, v_a2
              from public._se_round1_slot_winner(
                     new.round_id, v_seeds, v_seeds2, v_pow2, v_entrant_count, v_i) sw;
            select sw.p1, sw.p2 into v_b1, v_b2
              from public._se_round1_slot_winner(
                     new.round_id, v_seeds, v_seeds2, v_pow2, v_entrant_count,
                     v_slot_matches - 1 - v_i) sw;

            if v_a1 is null or v_b1 is null then
              continue;
            end if;

            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2,
              team2_player1, team2_player2,
              status
            )
            values (
              new.tournament_id, v_next_round_id, v_i,
              'singles',
              v_a1, null,
              v_b1, null,
              'pending'
            );
          end loop;

          return new;
        end if;
      end if;
    end if;

    if v_winner_count <= 1 then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status <> 'completed';
      return new;
    end if;

    v_pair_count := v_winner_count / 2;
    if v_pair_count < 1 then return new; end if;

    if v_pair_count = 1 then
      v_next_round_type := 'finals';
      v_next_label      := 'Finals';
    else
      v_next_round_type := 'winners';
      v_next_label      := format('Round %s', v_next_round_num);
    end if;

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type)
    returning id into v_next_round_id;

    for v_i in 0..(v_pair_count - 1) loop
      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1','team2')
      )
      select * into v_w1 from ordered where rn = v_i * 2;

      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1','team2')
      )
      select * into v_w2 from ordered where rn = v_i * 2 + 1;

      if v_w1 is null or v_w2 is null then
        continue;
      end if;

      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1, team1_player2,
        team2_player1, team2_player2,
        status
      )
      values (
        new.tournament_id,
        v_next_round_id,
        v_i,
        coalesce(v_match_type, 'singles'),
        case when v_w1.winner_team = 'team1' then v_w1.team1_player1 else v_w1.team2_player1 end,
        case when v_w1.winner_team = 'team1' then v_w1.team1_player2 else v_w1.team2_player2 end,
        case when v_w2.winner_team = 'team1' then v_w2.team1_player1 else v_w2.team2_player1 end,
        case when v_w2.winner_team = 'team1' then v_w2.team1_player2 else v_w2.team2_player2 end,
        'pending'
      );
    end loop;

  exception when others then
    raise warning '_advance_single_elim_bracket failed for tournament % round %: % / %',
      new.tournament_id, new.round_id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;


-- ── 1. The sweep ────────────────────────────────────────────────
-- A single driver block runs every bracket size. For each N it sets up
-- the tournament + round-1 matches, then loops: complete every pending
-- match in the lowest-numbered round that still has pending matches
-- (team1 always wins, so the higher-up team1_player1 advances — which is
-- the top seed in every reconstructed pairing), let the trigger build the
-- next round, and repeat until no pending matches remain. Then assert.

do $sweep$
declare
  v_sizes      integer[] := array[2, 4, 8, 3, 5, 6, 7];
  v_n          integer;
  v_tid        uuid;
  v_r1_rid     uuid;
  v_players    uuid[];
  v_email_base text;
  v_pow2       integer;
  v_byes       integer;
  v_i          integer;
  v_mo         integer;
  v_p1         uuid;
  v_p2         uuid;
  v_guard      integer;
  v_pending    integer;
  v_open_round uuid;

  -- assertion helpers
  v_round2_rid       uuid;
  v_r2_player_count  integer;
  v_bye_present      integer;
  v_final_rid        uuid;
  v_final_type       text;
  v_final_winners    integer;
  v_status           text;
  v_distinct_champs  integer;
  v_champ            uuid;
begin
  foreach v_n in array v_sizes loop
    -- ── compute padding ──
    v_pow2 := 1;
    while v_pow2 < v_n loop v_pow2 := v_pow2 * 2; end loop;
    v_byes := v_pow2 - v_n;

    -- ── fresh ids ──
    v_tid    := gen_random_uuid();
    v_r1_rid := gen_random_uuid();
    v_players := array[]::uuid[];
    v_email_base := 'se-' || gen_random_uuid()::text || '@test.invalid';

    -- Triggers off so handle_new_user (which needs `gender`) doesn't fire.
    set local session_replication_role = 'replica';

    for v_i in 1..v_n loop
      v_p1 := gen_random_uuid();
      v_players := v_players || v_p1;
      insert into auth.users (id, email)
        values (v_p1, 's' || v_i || '-' || v_email_base);
      insert into public.profiles (id, username, full_name, gender)
        values (v_p1,
                'se_' || substr(v_p1::text, 1, 12),
                'SE Player ' || v_i,
                'male');
    end loop;

    set local session_replication_role = 'origin';

    -- ── tournament + seeded registrations (seed = rank, 1 = best) ──
    insert into public.tournaments
      (id, name, format, match_type, status, created_by)
    values
      (v_tid, 'SE sweep N=' || v_n, 'single_elimination', 'singles', 'active',
       v_players[1]);

    for v_i in 1..v_n loop
      insert into public.tournament_registrations
        (tournament_id, user_id, status, seed)
      values (v_tid, v_players[v_i], 'approved', v_i);
    end loop;

    -- ── round 1 (winners) ──
    insert into public.tournament_rounds
      (id, tournament_id, round_number, label, round_type)
    values
      (v_r1_rid, v_tid, 1, 'Single Elim Schedule', 'winners');

    -- ── round-1 matches: mirror generateSingleElim + doLockIn ──
    -- padded slots = [s1..sN, BYE×byes]; pair slot i vs slot pow2-1-i;
    -- skip any pairing that touches a BYE; persist surviving matches with
    -- CONTIGUOUS match_order. Top `byes` seeds therefore have NO row.
    v_mo := 0;
    for v_i in 0 .. (v_pow2 / 2 - 1) loop
      -- slot i (0-indexed) -> seed i+1 ; slot pow2-1-i -> seed pow2-i
      -- A slot is a BYE when its seed index > N.
      if (v_i + 1) <= v_n and (v_pow2 - v_i) <= v_n then
        v_p1 := v_players[v_i + 1];            -- top seed
        v_p2 := v_players[v_pow2 - v_i];       -- bottom seed
        insert into public.tournament_matches
          (tournament_id, round_id, match_order, match_type,
           team1_player1, team2_player1, status)
        values
          (v_tid, v_r1_rid, v_mo, 'singles', v_p1, v_p2, 'pending');
        v_mo := v_mo + 1;
      end if;
    end loop;

    -- ── drive to completion ──
    -- Repeatedly pick the lowest-numbered round that still has pending
    -- matches and complete them (team1 wins 11-5). Completing the last
    -- match in a round fires the trigger which builds the next round.
    v_guard := 0;
    loop
      v_guard := v_guard + 1;
      exit when v_guard > 64;   -- safety net against an infinite loop

      select tr.id into v_open_round
        from public.tournament_rounds tr
       where tr.tournament_id = v_tid
         and exists (
           select 1 from public.tournament_matches tm
            where tm.round_id = tr.id and tm.status <> 'completed'
         )
       order by tr.round_number asc
       limit 1;

      exit when v_open_round is null;   -- no pending matches anywhere

      update public.tournament_matches
         set team1_score = 11,
             team2_score = 5,
             winner_team = 'team1',
             status      = 'completed'
       where round_id = v_open_round
         and status <> 'completed';
    end loop;

    -- ════════════════════════════════════════════════════════════
    --   ASSERTIONS
    -- ════════════════════════════════════════════════════════════

    -- (a) Champion: tournament flipped to completed, and the final round
    --     has exactly one winning match (one champion remains).
    select status into v_status from public.tournaments where id = v_tid;
    assert v_status = 'completed',
      format('N=%s: tournament should be completed, got status=%s', v_n, v_status);

    -- The last bracket round = highest round_number. It must be a single
    -- match with a winner. For N>2 the trigger creates a dedicated 'finals'
    -- round; for N=2 the sole round-1 ('winners') row IS the final (the app
    -- never creates a separate Finals for a 2-entrant bracket), so accept it.
    select tr.id, tr.round_type
      into v_final_rid, v_final_type
      from public.tournament_rounds tr
     where tr.tournament_id = v_tid
     order by tr.round_number desc
     limit 1;

    assert (v_final_type = 'finals') or (v_n = 2 and v_final_type = 'winners'),
      format('N=%s: final round_type should be finals (or winners for N=2), got %s',
             v_n, v_final_type);

    select count(*) into v_final_winners
      from public.tournament_matches
     where round_id = v_final_rid
       and winner_team in ('team1','team2');
    assert v_final_winners = 1,
      format('N=%s: finals should have exactly 1 decided match, got %s',
             v_n, v_final_winners);

    -- Exactly one distinct champion across the finals match.
    select count(distinct champ) into v_distinct_champs
      from (
        select case when winner_team = 'team1' then team1_player1
                    else team2_player1 end as champ
          from public.tournament_matches
         where round_id = v_final_rid
           and winner_team in ('team1','team2')
      ) c;
    assert v_distinct_champs = 1,
      format('N=%s: expected exactly 1 champion, got %s', v_n, v_distinct_champs);

    -- (b) For BYE brackets: the bye'd top seeds must REACH round 2 (the
    --     core regression). Round 2 = round_number 2. The top `byes`
    --     seeds (players[1..byes]) must each appear in a round-2 match.
    if v_byes > 0 then
      select tr.id into v_round2_rid
        from public.tournament_rounds tr
       where tr.tournament_id = v_tid
         and tr.round_number = 2
       limit 1;
      assert v_round2_rid is not null,
        format('N=%s: a round 2 should have been created (byes=%s)', v_n, v_byes);

      for v_i in 1 .. v_byes loop
        select count(*) into v_bye_present
          from public.tournament_matches
         where round_id = v_round2_rid
           and v_players[v_i] in
               (team1_player1, team1_player2, team2_player1, team2_player2);
        assert v_bye_present >= 1,
          format('N=%s: bye''d seed #%s was DROPPED — not present in round 2 (the bug)',
                 v_n, v_i);
      end loop;
    end if;

    -- (c) Champion sanity: with team1 always winning, the overall #1 seed
    --     (players[1]) advances through every round and must be champion.
    --     This pins down that no top seed is lost mid-bracket.
    select case when winner_team = 'team1' then team1_player1 else team2_player1 end
      into v_champ
      from public.tournament_matches
     where round_id = v_final_rid
       and winner_team in ('team1','team2')
     limit 1;
    assert v_champ = v_players[1],
      format('N=%s: champion should be the #1 seed (team1 always wins), got a different player', v_n);

    raise notice 'N=% : PASS (pow2=%, byes=%, champion=#1 seed, byes reached R2)',
      v_n, v_pow2, v_byes;
  end loop;

  raise notice 'ALL SIZES PASS: %', v_sizes;
end
$sweep$;

-- ── 2. Bug #4 regression: this trigger must NOT touch double_elimination ──
-- A double_elimination tournament driven to its winners-bracket final must
-- stay 'active' (DE completes only via the grand final, handled by the
-- dedicated _advance_double_elim_bracket trigger). With the pre-fix guard
-- (which included 'double_elimination'), the legacy "winner_count <= 1 ->
-- mark completed" path fired here and prematurely completed the DE
-- tournament at the WB final. The fixed guard returns early for DE.
do $de_guard$
declare
  v_tid  uuid := gen_random_uuid();
  v_wb1  uuid := gen_random_uuid();
  v_a uuid:=gen_random_uuid(); v_b uuid:=gen_random_uuid();
  v_c uuid:=gen_random_uuid(); v_d uuid:=gen_random_uuid();
  v_email text := 'se-de-' || gen_random_uuid()::text || '@test.invalid';
  v_m_ad uuid:=gen_random_uuid(); v_m_bc uuid:=gen_random_uuid();
  v_wb2 uuid; v_wb2_m uuid; v_status text; v_gf integer;
begin
  set local session_replication_role = 'replica';
  insert into auth.users (id, email) values
    (v_a,'a-'||v_email),(v_b,'b-'||v_email),(v_c,'c-'||v_email),(v_d,'d-'||v_email);
  insert into public.profiles (id, username, full_name, gender) values
    (v_a,'sde_a_'||substr(v_a::text,1,8),'SDE A','male'),
    (v_b,'sde_b_'||substr(v_b::text,1,8),'SDE B','male'),
    (v_c,'sde_c_'||substr(v_c::text,1,8),'SDE C','male'),
    (v_d,'sde_d_'||substr(v_d::text,1,8),'SDE D','male');
  set local session_replication_role = 'origin';

  insert into public.tournaments (id, name, format, match_type, status, created_by)
  values (v_tid, 'DE guard N=4', 'double_elimination', 'singles', 'active', v_a);
  insert into public.tournament_rounds (id, tournament_id, round_number, label, round_type)
  values (v_wb1, v_tid, 1, 'Winners Round 1', 'winners');
  insert into public.tournament_matches
    (id, tournament_id, round_id, match_order, match_type, team1_player1, team2_player1, status)
  values (v_m_ad, v_tid, v_wb1, 0, 'singles', v_a, v_d, 'pending'),
         (v_m_bc, v_tid, v_wb1, 1, 'singles', v_b, v_c, 'pending');

  -- Complete WB R1 → dedicated DE trigger builds WB R2 + LB R1.
  update public.tournament_matches set team1_score=11, team2_score=5, winner_team='team1', status='completed' where id in (v_m_ad, v_m_bc);
  select id into v_wb2 from public.tournament_rounds where tournament_id=v_tid and round_type='winners' and round_number=2;
  select id into v_wb2_m from public.tournament_matches where round_id=v_wb2 limit 1;

  -- Complete the WB final (1 winner). The single-elim trigger MUST NOT complete it.
  update public.tournament_matches set team1_score=11, team2_score=5, winner_team='team1', status='completed' where id=v_wb2_m;

  select status into v_status from public.tournaments where id=v_tid;
  select count(*) into v_gf from public.tournament_rounds where tournament_id=v_tid and round_type='grand_final';
  assert v_status = 'active',
    format('Bug #4 regression: DE must stay active after WB final (single-elim trigger must not complete it), got status=%s', v_status);

  raise notice 'Bug #4 regression PASS: single-elim trigger left double_elim untouched (status=%, grand_final_rounds=%)', v_status, v_gf;
end
$de_guard$;

rollback;
