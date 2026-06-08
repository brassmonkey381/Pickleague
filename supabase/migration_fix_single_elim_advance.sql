-- ============================================================
-- migration_fix_single_elim_advance.sql
--
-- BUG FIX (Unit 7 — single-elim advancement trigger):
--   public._advance_single_elim_bracket() silently DROPPED bye'd top
--   seeds in non-power-of-2 single/double-elimination brackets.
--
-- Root cause
-- ----------
-- The mobile bracket generator (generateSingleElim in
-- mobile/src/lib/tournament.ts) pads the entrant list to the next power
-- of 2 with BYE sentinels and then *skips* any round-1 pairing that
-- touches a BYE. The lock-in flow (TournamentDetailScreen.doLockIn)
-- persists ONLY the surviving matches and re-indexes match_order to be
-- contiguous (0,1,2,…). The result: for N not a power of 2, the top
-- `pow2 - N` seeds have NO round-1 tournament_matches row at all — they
-- exist only as approved tournament_registrations rows (with a `seed`).
--
-- The old trigger built the next round purely from "winners of the
-- just-completed round". A bye'd seed is never a winner of round 1
-- (it has no row), so it was never carried forward:
--   * N=3/5 → trigger saw a single round-1 match, decided
--     winner_count <= 1, and flipped the tournament to 'completed',
--     crowning a bottom-half seed and dropping every bye'd seed.
--   * N=6/7 → trigger paired only the surviving winners and produced a
--     too-small "Finals", again dropping the bye'd top seeds.
-- The body was also wrapped in `exception when others then null`, so any
-- internal error was swallowed and the bracket simply stalled silently.
--
-- The fix
-- -------
-- Detect the FIRST bracket round (the lowest round_number among the
-- tournament's single/double-elim rounds). On that round's completion,
-- reconstruct the full padded bracket from the approved
-- tournament_registrations (ordered by seed), re-derive each round-1
-- bracket slot's winner (a bye'd seed "wins" its phantom slot), and emit
-- the next round with the canonical outside-in pairing
--   match j  =  winner(slot-match j)  vs  winner(slot-match pow2/2-1-j)
-- so bye'd seeds re-enter at their correct bracket position. For clean
-- powers of 2 there are no byes and the behaviour is identical to before
-- (every slot maps to a real round-1 match).
--
-- Rounds 2→3→… (where every participant already has a real match row)
-- keep using the simple adjacent-winner pairing, which is correct once
-- round 2 is laid out in bracket-slot order.
--
-- Also: the catch-all now RAISES WARNING (instead of silently NULL) so a
-- genuine failure is observable in the Postgres logs while still never
-- aborting the user's score-submission transaction.
--
-- NOTE: This file is a stand-alone create-or-replace. The human applies
-- it to prod manually (the agent never calls apply_migration).
-- ============================================================

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

  -- First-round reconstruction state
  v_entrant_count   integer;
  v_pow2            integer;
  v_slot_matches    integer;   -- pow2 / 2 = number of round-1 bracket slots
  v_round2_pairs    integer;   -- pow2 / 4 = matches in the reconstructed round 2
  v_seeds           uuid[];    -- seed-ordered participant1 ids (1-based)
  v_seeds2          uuid[];    -- seed-ordered participant2 ids (doubles); = same as v_seeds for singles
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
    if v_format not in ('single_elimination', 'double_elimination') then
      return new;
    end if;

    select round_number, round_type
      into v_round_number, v_round_type
      from public.tournament_rounds
     where id = new.round_id;
    if v_round_number is null then return new; end if;

    -- All matches in the just-completed round must be done.
    select count(*) into v_uncompleted
      from public.tournament_matches
     where round_id = new.round_id
       and status <> 'completed';
    if v_uncompleted > 0 then return new; end if;

    -- Idempotency: bail if the next round_number already exists.
    v_next_round_num := v_round_number + 1;
    if exists (
      select 1 from public.tournament_rounds
       where tournament_id = new.tournament_id
         and round_number = v_next_round_num
    ) then
      return new;
    end if;

    -- Is this the first bracket round? (lowest round_number among this
    -- tournament's elim rounds). Only the first round can hide bye'd seeds;
    -- every later round has a real match row for each surviving entrant.
    select min(round_number) into v_min_round_num
      from public.tournament_rounds
     where tournament_id = new.tournament_id
       and round_type in ('winners', 'finals', 'quarterfinals', 'semifinals');
    v_is_first_round := (v_round_number = coalesce(v_min_round_num, v_round_number));

    select count(*) into v_winner_count
      from public.tournament_matches
     where round_id = new.round_id
       and winner_team in ('team1', 'team2');

    -- ── FIRST-ROUND PATH: reconstruct the padded bracket ──────────
    -- Carry bye'd top seeds (absent from round 1) into round 2 at their
    -- correct bracket positions. Engage only when the entrant count is
    -- larger than 2× the round-1 winner count (i.e. some seeds had byes).
    --
    -- SCOPE: single_elimination + singles only.
    --   * Doubles: registrations are per-PLAYER (two rows per team), so the
    --     seed list / pow2 math would be off by 2× and pair individual
    --     players as teams — corrupting the bracket. The client does not
    --     generate bye'd doubles single-elim brackets, so we fall back to
    --     the (byes-unaware) legacy path, no worse than pre-fix behaviour.
    --   * double_elimination: advancement is owned by the dedicated
    --     _advance_double_elim_bracket trigger (winners/losers/grand-final/
    --     bracket-reset). This trigger also fires for DE for historical
    --     reasons; we deliberately do NOT engage the reconstruction path
    --     there so we add zero new behaviour to the double-elim flow.
    if v_is_first_round
       and v_format = 'single_elimination'
       and coalesce(v_match_type, 'singles') = 'singles' then
      -- Seed-ordered approved entrants. NULLS LAST keeps any unseeded
      -- registrations after the seeded ones, matching the client which
      -- seeds before generating the bracket.
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
      -- Singles: participant2 mirrors participant1 (single token per seed),
      -- so the doubles team1_player2/team2_player2 columns stay NULL below.
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

          -- Round-2 match v_i pairs slot-winner v_i with slot-winner
          -- (slot_matches - 1 - v_i): canonical outside-in.
          for v_i in 0 .. (v_round2_pairs - 1) loop
            -- top participant = winner of round-1 bracket slot v_i
            select sw.p1, sw.p2 into v_a1, v_a2
              from public._se_round1_slot_winner(
                     new.round_id, v_seeds, v_seeds2, v_pow2, v_entrant_count, v_i) sw;
            -- bottom participant = winner of round-1 bracket slot (slot_matches-1-v_i)
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
              'singles',          -- reconstruction path is singles-only (gated above)
              v_a1, null,
              v_b1, null,
              'pending'
            );
          end loop;

          return new;   -- first-round reconstruction handled.
        end if;
      end if;
    end if;

    -- ── LEGACY PATH (clean powers of 2, and rounds 2→3→…) ─────────
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
    -- Do NOT silently swallow: surface the failure in the Postgres log so a
    -- stalled bracket is diagnosable, while still never aborting the user's
    -- score-submission transaction.
    raise warning '_advance_single_elim_bracket failed for tournament % round %: % / %',
      new.tournament_id, new.round_id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;


-- ── Helper: winner occupying round-1 bracket slot k (0-indexed) ──────
-- Slot k pairs seed (k+1) against seed (pow2-k). If the bottom seed
-- exceeds the entrant count it is a BYE and the top seed auto-advances.
-- Otherwise we read the completed round-1 match row that contains both
-- seeds' tokens and return the winning side's tokens.
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
    -- BYE: top seed auto-advances.
    p1 := v_top1; p2 := v_top2; return next; return;
  end if;

  v_bot1 := p_seeds[v_bot_seed];
  v_bot2 := p_seeds2[v_bot_seed];

  -- Locate the completed round-1 match between these two seeds and return
  -- the winning side's player tokens. Match on participant identity rather
  -- than match_order (which the client re-indexes contiguously).
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
    -- No matching row (defensive): return the top seed so the bracket
    -- still advances rather than silently dropping a slot.
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

notify pgrst, 'reload schema';
