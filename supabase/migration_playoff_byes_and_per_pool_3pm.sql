-- migration_playoff_byes_and_per_pool_3pm.sql
--
-- Two related enhancements to the Top-N-per-pool playoff (PR #66):
--
-- A. BYE-padding for 6-entrant brackets. When P × N = 6 (i.e., P=3/N=2 or
--    P=6/N=1), pad to an 8-slot Quarterfinals round where the top 2 seeds
--    each get a BYE (match_type='bye', team2 columns NULL, status='completed',
--    winner_team='team1'). The existing advancement trigger sees all 4 QFs
--    "complete" and pairs winners outside-in into Semifinals (so the BYE
--    advances naturally). Crossover slots use the swap rule from
--    docs/tournament-formats/seeding-and-tiebreakers.md §3 to avoid same-pool
--    round-1 matches.
--
-- B. Third Place Match for Top-N-per-pool variants. PR #62 only inserted a
--    3PM for top_4 / top_8 SE brackets when playoff_third_place=true.
--    Extend that to top_1_per_pool / top_2_per_pool too, so the toggle
--    works uniformly across all SE playoff formats.
--
-- Schema change:
--   - Extend tournament_matches.match_type CHECK to allow 'bye'.
--
-- Function changes:
--   - generate_playoff_bracket: handle bracket_size=6 → pad to 8 with BYEs.
--   - _advance_non_mlp_playoff_bracket: include the per-pool variants in
--     the 3PM gate.

-- ── 1) Extend match_type check to allow 'bye' ──────────────────────
alter table public.tournament_matches
  drop constraint if exists tournament_matches_match_type_check;

alter table public.tournament_matches
  add constraint tournament_matches_match_type_check
  check (match_type in ('singles', 'doubles', 'bye'));


-- ── 2) Redefine generate_playoff_bracket with 6-entrant BYE padding ──
create or replace function public.generate_playoff_bracket(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_format         text;
  v_match_type     text;
  v_playoff        text;
  v_playoff_n      integer;   -- N for flat top_2/top_4/top_8; null for per-pool
  v_uncompleted    integer;
  v_round_id       uuid;
  v_round_type     text;
  v_round_label    text;
  v_match_order    integer := 0;
  v_matches        integer := 0;
  v_i              integer;
  v_seeds          uuid[][];
  v_pool_count     integer;
  v_bracket_size   integer;
  v_per_pool_n     integer;   -- entrants per pool to take (N in top_N_per_pool)
  v_pairings       integer[][]; -- [bracket_slot1, bracket_slot2] per match
  v_padded_size    integer;   -- next power of 2 ≥ v_bracket_size
begin
  select format, match_type, coalesce(playoff_format, 'none')
    into v_format, v_match_type, v_playoff
    from public.tournaments where id = p_tournament_id;

  if v_format is null then
    raise exception 'Tournament % not found', p_tournament_id;
  end if;
  if v_playoff = 'none' then
    raise exception 'Tournament has no playoff configured (playoff_format=none)';
  end if;
  if v_format not in ('round_robin', 'pool_play') then
    raise exception 'Playoff generation supported for round_robin / pool_play only, not %', v_format;
  end if;

  -- top_N_per_pool variants require pool_play.
  if v_playoff in ('top_1_per_pool', 'top_2_per_pool') and v_format <> 'pool_play' then
    raise exception 'Playoff format % requires format=pool_play, not %', v_playoff, v_format;
  end if;

  v_per_pool_n := case v_playoff
    when 'top_1_per_pool' then 1
    when 'top_2_per_pool' then 2
    else null
  end;

  -- Don't allow re-generation
  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type in ('quarterfinals','semifinals','finals','third_place_match')
  ) then
    raise exception 'Playoff already generated.';
  end if;

  -- All group-play matches must be completed
  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = p_tournament_id
     and tr.round_type not in ('quarterfinals','semifinals','finals','third_place_match','consolation','losers')
     and tm.status <> 'completed';
  if v_uncompleted > 0 then
    raise exception 'Cannot advance — % group-play matches still pending', v_uncompleted;
  end if;

  -- Branch: top-N-per-pool path or flat top-N path.
  if v_per_pool_n is not null then
    -- ── TOP N PER POOL PATH ────────────────────────────────────
    select count(distinct upper(substring(tr.label from 'Pool ([A-Z])')))::int
      into v_pool_count
      from public.tournament_rounds tr
     where tr.tournament_id = p_tournament_id
       and tr.label ~ '^Pool [A-Z]';
    if v_pool_count is null or v_pool_count < 2 then
      raise exception 'top_N_per_pool requires at least 2 labelled pool rounds (found %)', coalesce(v_pool_count, 0);
    end if;

    v_bracket_size := v_pool_count * v_per_pool_n;
    if v_bracket_size not in (2, 4, 6, 8) then
      raise exception
        'top_%_per_pool with % pools yields % entrants — supported sizes are 2/4/6/8. Pick top_2/top_4/top_8 instead.',
        v_per_pool_n, v_pool_count, v_bracket_size;
    end if;

    -- Build per-pool standings, then take top N from each pool.
    with pool_matches as (
      select tm.*,
             upper(substring(tr.label from 'Pool ([A-Z])')) as pool_letter
        from public.tournament_matches tm
        join public.tournament_rounds tr on tr.id = tm.round_id
       where tm.tournament_id = p_tournament_id
         and tm.status = 'completed'
         and tr.label ~ '^Pool [A-Z]'
    ),
    raw as (
      select pool_letter,
             least(team1_player1, coalesce(team1_player2, team1_player1))    as lo,
             greatest(team1_player1, coalesce(team1_player2, team1_player1)) as hi,
             coalesce(team1_score, 0) as pf,
             coalesce(team2_score, 0) as pa,
             case when winner_team = 'team1' then 1 else 0 end as wins,
             case when winner_team = 'team2' then 1 else 0 end as losses
        from pool_matches
      union all
      select pool_letter,
             least(team2_player1, coalesce(team2_player2, team2_player1)),
             greatest(team2_player1, coalesce(team2_player2, team2_player1)),
             coalesce(team2_score, 0), coalesce(team1_score, 0),
             case when winner_team = 'team2' then 1 else 0 end,
             case when winner_team = 'team1' then 1 else 0 end
        from pool_matches
    ),
    agg as (
      select pool_letter, lo, hi,
             sum(wins)::int   as wins,
             sum(losses)::int as losses,
             sum(pf)::int - sum(pa)::int as point_diff
        from raw
       group by pool_letter, lo, hi
    ),
    with_seed as (
      select a.pool_letter, a.lo, a.hi, a.wins, a.losses, a.point_diff,
             coalesce((
               select min(tr.seed)
                 from public.tournament_registrations tr
                where tr.tournament_id = p_tournament_id
                  and tr.user_id in (a.lo, a.hi)
             ), 999) as seed
        from agg a
    ),
    pre as (
      select pool_letter, lo, hi, wins, losses, point_diff, seed,
             row_number() over (
               partition by pool_letter
               order by wins desc, point_diff desc, seed asc
             ) as rn
        from with_seed
    ),
    wins_pairs as (
      select pool_letter, wins
        from with_seed
       group by pool_letter, wins
      having count(*) = 2
    ),
    pool_ranked_pairs as (
      select p.*,
             row_number() over (
               partition by p.pool_letter, p.wins
               order by p.rn
             ) as rn_within
        from pre p
    ),
    ties_2 as (
      select w.pool_letter, w.wins,
             e1.lo as lo1, e1.hi as hi1,
             e2.lo as lo2, e2.hi as hi2
        from wins_pairs w
        join pool_ranked_pairs e1
          on e1.pool_letter = w.pool_letter and e1.wins = w.wins and e1.rn_within = 1
        join pool_ranked_pairs e2
          on e2.pool_letter = w.pool_letter and e2.wins = w.wins and e2.rn_within = 2
    ),
    h2h as (
      select t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
             coalesce(sum(
               case
                 when (
                   (least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo1
                    and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi1
                    and least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo2
                    and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi2
                    and pm.winner_team = 'team1')
                   or
                   (least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo1
                    and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi1
                    and least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo2
                    and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi2
                    and pm.winner_team = 'team2')
                 ) then 1
                 else 0
               end
             )::int, 0) as h2h_wins_1,
             coalesce(sum(
               case
                 when (
                   (least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo2
                    and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi2
                    and least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo1
                    and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi1
                    and pm.winner_team = 'team1')
                   or
                   (least(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.lo2
                    and greatest(pm.team2_player1, coalesce(pm.team2_player2, pm.team2_player1)) = t.hi2
                    and least(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.lo1
                    and greatest(pm.team1_player1, coalesce(pm.team1_player2, pm.team1_player1)) = t.hi1
                    and pm.winner_team = 'team2')
                 ) then 1
                 else 0
               end
             )::int, 0) as h2h_wins_2
        from ties_2 t
        left join pool_matches pm on pm.pool_letter = t.pool_letter
       group by t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2
    ),
    h2h_per_entrant as (
      select p.pool_letter, p.lo, p.hi, p.wins, p.point_diff, p.seed,
             coalesce(
               case
                 when h.h2h_wins_1 = h.h2h_wins_2 then 0
                 when (p.lo = h.lo1 and p.hi = h.hi1) then
                   case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
                 when (p.lo = h.lo2 and p.hi = h.hi2) then
                   case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
                 else 0
               end,
               0
             ) as h2h_score
        from pre p
        left join h2h h on h.pool_letter = p.pool_letter
                       and h.wins = p.wins
                       and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
    ),
    pool_ranked as (
      select pool_letter, lo, hi,
             row_number() over (
               partition by pool_letter
               order by wins desc, h2h_score desc, point_diff desc, seed asc
             ) as pool_rank
        from h2h_per_entrant
    )
    select array_agg(array[lo, coalesce(hi, lo)] order by pool_rank, ascii(pool_letter))
      into v_seeds
      from pool_ranked
     where pool_rank <= v_per_pool_n;

    if v_seeds is null or array_length(v_seeds, 1) < v_bracket_size then
      raise exception
        'Not enough entrants in pool standings to seed top % per pool across % pools (need %, got %)',
        v_per_pool_n, v_pool_count, v_bracket_size,
        coalesce(array_length(v_seeds, 1), 0);
    end if;

    -- Crossover pairings, encoded as [seed_idx_1, seed_idx_2] (1-based).
    -- v_seeds is snake order: indices 1..P = "#1 tier" (A1, B1, C1…),
    -- indices P+1..2P = "#2 tier" (A2, B2, C2…).
    if v_bracket_size = 2 then
      -- P=2, N=1: A1 vs B1 (Final).
      v_pairings := array[ array[1, 2] ];
      v_padded_size := 2;
    elsif v_bracket_size = 4 and v_pool_count = 2 then
      -- P=2, N=2: SF1=A1 vs B2, SF2=B1 vs A2.
      -- v_seeds = [A1, B1, A2, B2].
      v_pairings := array[ array[1, 4], array[2, 3] ];
      v_padded_size := 4;
    elsif v_bracket_size = 4 and v_pool_count = 4 then
      -- P=4, N=1: SF1 = A1 vs D1, SF2 = B1 vs C1.
      v_pairings := array[ array[1, 4], array[2, 3] ];
      v_padded_size := 4;
    elsif v_bracket_size = 6 and v_pool_count = 3 then
      -- P=3, N=2 → 6 entrants. Pad to 8-slot Quarterfinals; top 2 seeds
      -- (A1, B1) get BYEs. Snake order (in v_seeds) = [A1, B1, C1, A2, B2, C2]
      --                                                  1   2   3   4   5   6
      -- The 8-slot crossover layout (1v8, 4v5, 2v7, 3v6) puts seeds 3 and 6
      -- against each other — i.e., C1 vs C2 — a same-pool round-1 match.
      -- The fix (per docs/tournament-formats/seeding-and-tiebreakers.md §3)
      -- is to swap the contents of slot 5 and slot 6 in the bracket layout,
      -- which we encode here by pairing snake-idx 3 with snake-idx 5 (B2)
      -- and snake-idx 4 with snake-idx 6 (C2):
      --   QF match_order 0 = A1-BYE      (slot 1 - sentinel BYE)
      --   QF match_order 1 = B1-BYE      (slot 2 - sentinel BYE)
      --   QF match_order 2 = C1 vs B2    (snake idx 3 vs 5)
      --   QF match_order 3 = A2 vs C2    (snake idx 4 vs 6)
      -- Outside-in pairing in the advancement trigger then yields:
      --   SF1 (mo 0 + mo 3): A1 (bye)  vs (A2 or C2)
      --   SF2 (mo 1 + mo 2): B1 (bye)  vs (C1 or B2)
      -- so no same-pool round-1 conflict and no same-pool SF conflict for
      -- pool A; the only residual is C1/C2 reuniting in SF2 only if both
      -- their halves win — which matches the doc's recommendation.
      -- Sentinel slot 0 = BYE (handled below in the match-insert loop).
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 5], array[4, 6] ];
      v_padded_size := 8;
    elsif v_bracket_size = 6 and v_pool_count = 6 then
      -- P=6, N=1 → 6 entrants. Pad to 8-slot Quarterfinals; top 2 seeds
      -- (A1, B1) get BYEs. Snake order (all #1 tier) = [A1, B1, C1, D1, E1, F1].
      -- No same-pool conflicts (one entrant per pool), so use a straight
      -- 1v8/4v5/2v7/3v6 crossover with the bottom-4 slots holding C1..F1.
      -- QF match_order: 0=A1-BYE, 1=B1-BYE, 2=C1 vs F1, 3=D1 vs E1.
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 6], array[4, 5] ];
      v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 4 then
      -- P=4, N=2: pool-affinity-corrected crossover.
      -- v_seeds (snake): [A1, B1, C1, D1, A2, B2, C2, D2]
      v_pairings := array[ array[1, 8], array[4, 6], array[2, 7], array[3, 5] ];
      v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 2 then
      -- P=2, N=4: snake assignment.
      -- v_seeds (snake): [A1, B1, A2, B2, A3, B3, A4, B4]
      v_pairings := array[ array[1, 8], array[4, 5], array[2, 7], array[3, 6] ];
      v_padded_size := 8;
    else
      raise exception 'Unsupported top_N_per_pool bracket shape (pools=%, N=%)',
        v_pool_count, v_per_pool_n;
    end if;

    -- Round label / type from padded bracket size (8 for BYE-padded 6).
    v_round_label := case v_padded_size
      when 8 then 'Quarterfinals'
      when 4 then 'Semifinals'
      when 2 then 'Finals'
    end;
    v_round_type := case v_padded_size
      when 8 then 'quarterfinals'
      when 4 then 'semifinals'
      when 2 then 'finals'
    end;

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (p_tournament_id, 1000, v_round_label, v_round_type)
      returning id into v_round_id;

    -- NOTE on 2D array indexing: Postgres does not auto-slice a 2D array
    -- with a single index (v_seeds[k] returns NULL on a 2D array, not the
    -- k-th row). Index both dimensions directly (v_seeds[k][1] and
    -- v_seeds[k][2]) to avoid silently inserting NULL player IDs.
    --
    -- NOTE on insert order: BYE rows are inserted with status='completed'
    -- so they would fire trg_advance_non_mlp_playoff_bracket immediately.
    -- If we inserted all BYEs first, the trigger would see v_uncompleted=0
    -- (no pending rows in this round yet) and prematurely create the
    -- Semifinals using just the BYE winners. To prevent that, insert all
    -- PENDING (actual-match) rows first; once any pending row exists in
    -- the round the trigger sees v_uncompleted > 0 on subsequent BYE
    -- inserts and bails. The trigger only fires productively once the
    -- user records the actual match scores.
    declare
      v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
      v_pass integer;
      v_is_bye boolean;
    begin
      for v_pass in 1..2 loop
        for v_i in 1..array_length(v_pairings, 1) loop
          v_is_bye := v_pairings[v_i][2] = 0;
          -- Pass 1: only the actual matches. Pass 2: only the BYEs.
          continue when (v_pass = 1 and v_is_bye) or (v_pass = 2 and not v_is_bye);

          v_a1 := v_seeds[v_pairings[v_i][1]][1];
          v_a2 := v_seeds[v_pairings[v_i][1]][2];

          if v_is_bye then
            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2, team2_player1, team2_player2,
              status, winner_team
            )
            values (
              p_tournament_id, v_round_id, v_i - 1,
              'bye',
              v_a1,
              case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
              null, null,
              'completed', 'team1'
            );
          else
            v_b1 := v_seeds[v_pairings[v_i][2]][1];
            v_b2 := v_seeds[v_pairings[v_i][2]][2];
            insert into public.tournament_matches (
              tournament_id, round_id, match_order, match_type,
              team1_player1, team1_player2, team2_player1, team2_player2,
              status
            )
            values (
              p_tournament_id, v_round_id, v_i - 1,
              case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
              v_a1,
              case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
              v_b1,
              case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
              'pending'
            );
          end if;
          v_matches := v_matches + 1;
        end loop;
      end loop;
    end;

    -- 3PM for per-pool variants is handled in _advance_non_mlp_playoff_bracket
    -- once semifinals complete (see §3 below).

    return v_matches;
  end if;

  -- ── FLAT TOP-N PATH (mirrors PR #62 + #65) ────────────────────
  v_playoff_n := case v_playoff
    when 'top_2' then 2
    when 'top_4' then 4
    when 'top_8' then 8
    else null
  end;
  if v_playoff_n is null then
    raise exception 'Unknown playoff_format %', v_playoff;
  end if;

  with raw as (
    select
      least(team1_player1, coalesce(team1_player2, team1_player1))             as lo,
      greatest(team1_player1, coalesce(team1_player2, team1_player1))          as hi,
      coalesce(team1_score, 0)                                                 as pf,
      coalesce(team2_score, 0)                                                 as pa,
      case when winner_team = 'team1' then 1 else 0 end                        as wins,
      case when winner_team = 'team2' then 1 else 0 end                        as losses
    from public.tournament_matches
    where tournament_id = p_tournament_id and status = 'completed'
    union all
    select
      least(team2_player1, coalesce(team2_player2, team2_player1)),
      greatest(team2_player1, coalesce(team2_player2, team2_player1)),
      coalesce(team2_score, 0), coalesce(team1_score, 0),
      case when winner_team = 'team2' then 1 else 0 end,
      case when winner_team = 'team1' then 1 else 0 end
    from public.tournament_matches
    where tournament_id = p_tournament_id and status = 'completed'
  ),
  agg as (
    select lo, hi,
           sum(wins)::int   as wins,
           sum(losses)::int as losses,
           sum(pf)::int - sum(pa)::int as point_diff
      from raw
     group by lo, hi
  ),
  with_seed as (
    select a.lo, a.hi, a.wins, a.losses, a.point_diff,
           coalesce((
             select min(tr.seed)
               from public.tournament_registrations tr
              where tr.tournament_id = p_tournament_id
                and tr.user_id in (a.lo, a.hi)
           ), 999) as seed
      from agg a
  ),
  pre as (
    select lo, hi, wins, losses, point_diff, seed,
           row_number() over (order by wins desc, point_diff desc, seed asc) as rn
      from with_seed
  ),
  wins_pairs as (
    select wins
      from with_seed
     group by wins
    having count(*) = 2
  ),
  ranked_pairs as (
    select p.*,
           row_number() over (partition by p.wins order by p.rn) as rn_within
      from pre p
  ),
  ties_2 as (
    select w.wins,
           e1.lo as lo1, e1.hi as hi1,
           e2.lo as lo2, e2.hi as hi2
      from wins_pairs w
      join ranked_pairs e1 on e1.wins = w.wins and e1.rn_within = 1
      join ranked_pairs e2 on e2.wins = w.wins and e2.rn_within = 2
  ),
  h2h as (
    select t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
           coalesce(sum(
             case
               when (
                 (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo1
                  and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi1
                  and least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo2
                  and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi2
                  and m.winner_team = 'team1')
                 or
                 (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo1
                  and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi1
                  and least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo2
                  and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi2
                  and m.winner_team = 'team2')
               ) then 1
               else 0
             end
           )::int, 0) as h2h_wins_1,
           coalesce(sum(
             case
               when (
                 (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo2
                  and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi2
                  and least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo1
                  and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi1
                  and m.winner_team = 'team1')
                 or
                 (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.lo2
                  and greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) = t.hi2
                  and least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.lo1
                  and greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) = t.hi1
                  and m.winner_team = 'team2')
               ) then 1
               else 0
             end
           )::int, 0) as h2h_wins_2
      from ties_2 t
      left join public.tournament_matches m
        on m.tournament_id = p_tournament_id
       and m.status = 'completed'
     group by t.wins, t.lo1, t.hi1, t.lo2, t.hi2
  ),
  h2h_per_entrant as (
    select p.lo, p.hi, p.wins, p.point_diff, p.seed,
           coalesce(
             case
               when h.h2h_wins_1 = h.h2h_wins_2 then 0
               when (p.lo = h.lo1 and p.hi = h.hi1) then
                 case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
               when (p.lo = h.lo2 and p.hi = h.hi2) then
                 case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
               else 0
             end,
             0
           ) as h2h_score
      from pre p
      left join h2h h on h.wins = p.wins
                     and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
  ),
  ranked as (
    select lo, hi,
           row_number() over (
             order by wins desc,
                      h2h_score desc,
                      point_diff desc,
                      seed asc
           ) as rn
      from h2h_per_entrant
  )
  select array_agg(array[lo, coalesce(hi, lo)] order by rn)
    into v_seeds
    from ranked
   where rn <= greatest(v_playoff_n, 4);

  if v_seeds is null or array_length(v_seeds, 1) < v_playoff_n then
    raise exception 'Not enough entrants in standings to seed Top % (got %)',
      v_playoff_n, coalesce(array_length(v_seeds, 1), 0);
  end if;

  v_round_label := case v_playoff_n
    when 8 then 'Quarterfinals'
    when 4 then 'Semifinals'
    when 2 then 'Finals'
    else format('Playoff Round of %s', v_playoff_n)
  end;
  v_round_type := case v_playoff_n
    when 8 then 'quarterfinals'
    when 4 then 'semifinals'
    when 2 then 'finals'
    else 'winners'
  end;

  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (p_tournament_id, 1000, v_round_label, v_round_type)
    returning id into v_round_id;

  -- Index 2D v_seeds with both dims (see NOTE above). Pre-PR #62 the code
  -- did `v_a := v_seeds[k]` which silently returned NULL, producing playoff
  -- rows with NULL player IDs. This fix uses v_seeds[k][1]/[2] directly.
  declare
    v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
  begin
    for v_i in 0..(v_playoff_n / 2 - 1) loop
      v_a1 := v_seeds[v_i + 1][1];
      v_a2 := v_seeds[v_i + 1][2];
      v_b1 := v_seeds[v_playoff_n - v_i][1];
      v_b2 := v_seeds[v_playoff_n - v_i][2];

      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1,
        team1_player2,
        team2_player1,
        team2_player2,
        status
      )
      values (
        p_tournament_id, v_round_id, v_match_order,
        case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
        v_a1,
        case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
        v_b1,
        case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
        'pending'
      );
      v_match_order := v_match_order + 1;
      v_matches := v_matches + 1;
    end loop;

    if v_playoff_n = 2 and array_length(v_seeds, 1) >= 4 then
      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (p_tournament_id, 1100, 'Third Place Match', 'third_place_match')
        returning id into v_round_id;

      v_a1 := v_seeds[3][1];
      v_a2 := v_seeds[3][2];
      v_b1 := v_seeds[4][1];
      v_b2 := v_seeds[4][2];
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1,
        team1_player2,
        team2_player1,
        team2_player2,
        status
      )
      values (
        p_tournament_id, v_round_id, 0,
        case when v_match_type = 'doubles' then 'doubles' else 'singles' end,
        v_a1,
        case when v_match_type = 'doubles' and v_a1 <> v_a2 then v_a2 else null end,
        v_b1,
        case when v_match_type = 'doubles' and v_b1 <> v_b2 then v_b2 else null end,
        'pending'
      );
      v_matches := v_matches + 1;
    end if;
  end;

  return v_matches;
end;
$$;

grant execute on function public.generate_playoff_bracket(uuid) to authenticated;


-- ── 3) Extend 3PM gate to top_N_per_pool variants ──────────────────
-- PR #62 only inserted a 3PM for top_4 / top_8 SE brackets when the
-- playoff_third_place toggle was on. Extend the gate so top_1_per_pool /
-- top_2_per_pool also produce a 3PM between losing semifinalists.
create or replace function public._advance_non_mlp_playoff_bracket()
returns trigger language plpgsql security definer as $$
declare
  v_format             text;
  v_match_type         text;
  v_playoff_3pm        boolean;
  v_playoff_format     text;
  v_round_type         text;
  v_round_number       integer;
  v_uncompleted        integer;
  v_next_round_id      uuid;
  v_next_round_num     integer;
  v_next_round_type    text;
  v_next_label         text;
  v_count              integer;
  v_i                  integer;
  v_w1                 record;
  v_w2                 record;
  v_3pm_round_id       uuid;
  v_3pm_exists         boolean;
  v_l1                 record;
  v_l2                 record;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  select format, match_type,
         coalesce(playoff_third_place, false),
         coalesce(playoff_format, 'none')
    into v_format, v_match_type, v_playoff_3pm, v_playoff_format
    from public.tournaments
   where id = new.tournament_id;
  if v_format not in ('round_robin', 'pool_play') then return new; end if;

  select round_type, round_number
    into v_round_type, v_round_number
    from public.tournament_rounds
   where id = new.round_id;
  if v_round_type not in ('quarterfinals', 'semifinals') then return new; end if;

  select count(*) into v_uncompleted
    from public.tournament_matches
   where round_id = new.round_id
     and status <> 'completed';
  if v_uncompleted > 0 then return new; end if;

  if v_round_type = 'quarterfinals' then
    v_next_round_type := 'semifinals';
    v_next_label      := 'Semifinals';
  else
    v_next_round_type := 'finals';
    v_next_label      := 'Finals';
  end if;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = new.tournament_id
       and round_type = v_next_round_type
  ) then
    return new;
  end if;

  select count(*) into v_count
    from public.tournament_matches
   where round_id = new.round_id
     and winner_team in ('team1', 'team2');
  if v_count < 2 then return new; end if;

  v_next_round_num := coalesce(v_round_number, 1000) + 100;
  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (new.tournament_id, v_next_round_num, v_next_label, v_next_round_type)
    returning id into v_next_round_id;

  for v_i in 0..(v_count / 2 - 1) loop
    with ordered as (
      select tm.*,
             row_number() over (order by match_order, id) - 1 as rn
        from public.tournament_matches tm
       where tm.round_id = new.round_id
         and tm.winner_team in ('team1', 'team2')
    )
    select * into v_w1 from ordered where rn = v_i;

    with ordered as (
      select tm.*,
             row_number() over (order by match_order, id) - 1 as rn
        from public.tournament_matches tm
       where tm.round_id = new.round_id
         and tm.winner_team in ('team1', 'team2')
    )
    select * into v_w2 from ordered where rn = v_count - 1 - v_i;

    if v_w1 is null or v_w2 is null then continue; end if;
    if v_w1.id = v_w2.id then continue; end if;

    insert into public.tournament_matches (
      tournament_id, round_id, match_order, match_type,
      team1_player1,
      team1_player2,
      team2_player1,
      team2_player2,
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

  -- ── Third Place Match ─────────────────────────────────────────
  -- When the just-completed round is semifinals AND playoff_third_place is
  -- on AND playoff_format is any SE variant that produces a single
  -- "losing semifinalist" pair, insert a third_place_match round.
  -- Skip BYE rows (match_type='bye') when picking losing semifinalists —
  -- but in practice semifinals are always full matches once the bracket
  -- advances, so the only constraint is v_count = 2 actual semifinals.
  if v_round_type = 'semifinals'
     and v_playoff_3pm
     and v_playoff_format in ('top_4', 'top_8', 'top_1_per_pool', 'top_2_per_pool')
     and v_count = 2
  then
    select exists (
      select 1 from public.tournament_rounds
       where tournament_id = new.tournament_id
         and round_type = 'third_place_match'
    ) into v_3pm_exists;

    if not v_3pm_exists then
      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1', 'team2')
      )
      select * into v_l1 from ordered where rn = 0;

      with ordered as (
        select tm.*,
               row_number() over (order by match_order, id) - 1 as rn
          from public.tournament_matches tm
         where tm.round_id = new.round_id
           and tm.winner_team in ('team1', 'team2')
      )
      select * into v_l2 from ordered where rn = 1;

      if v_l1 is not null and v_l2 is not null and v_l1.id <> v_l2.id then
        insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
          values (new.tournament_id, v_next_round_num + 50, 'Third Place Match', 'third_place_match')
          returning id into v_3pm_round_id;

        insert into public.tournament_matches (
          tournament_id, round_id, match_order, match_type,
          team1_player1,
          team1_player2,
          team2_player1,
          team2_player2,
          status
        )
        values (
          new.tournament_id,
          v_3pm_round_id,
          0,
          coalesce(v_match_type, 'singles'),
          case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
          case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
          case when v_l2.winner_team = 'team1' then v_l2.team2_player1 else v_l2.team1_player1 end,
          case when v_l2.winner_team = 'team1' then v_l2.team2_player2 else v_l2.team1_player2 end,
          'pending'
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;

notify pgrst, 'reload schema';
