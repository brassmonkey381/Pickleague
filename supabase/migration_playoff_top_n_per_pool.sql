-- migration_playoff_top_n_per_pool.sql
--
-- Adds Top-N-per-Pool playoff seeding for non-MLP pool_play tournaments.
-- Two new playoff_format enum values:
--   'top_1_per_pool' — pool winners only advance (crossover seeding)
--   'top_2_per_pool' — top 2 from each pool advance (crossover seeding)
--
-- Builds on PR #62's head-to-head + 3PM logic; the new branch derives a
-- per-pool standing using the same tiebreaker chain (wins → H2H (only on
-- 2-way ties) → point_diff → seed) then takes top N from each pool.
-- Pool identity is parsed out of the existing tournament_rounds.label
-- format "Pool A · Round N".
--
-- Bracket sizes supported:
--   B = 2 → Final + 3PM (same shape as top_2)
--   B = 4 → Semifinals + Final (same shape as top_4)
--   B = 8 → Quarterfinals + Semifinals + Final (same shape as top_8)
-- Non-power-of-2 P*N combinations (P=3, P=6 with N=2) raise an error;
-- the user should pick top_2/top_4/top_8 for those pool counts.
--
-- Crossover seeding chosen (per docs/tournament-formats/seeding-and-tiebreakers.md §3):
--   B=4 (P=2,N=2): SF1=A1 vs B2, SF2=B1 vs A2.
--   B=8 (P=4,N=2): QF1=A1 vs D2, QF2=D1 vs B2, QF3=B1 vs C2, QF4=C1 vs A2
--                  (pool-affinity-corrected snake assignment: pool mates
--                  cannot meet before the Final).
--   B=8 (P=2,N=4): QF1=A1 vs B4, QF2=B2 vs A3, QF3=B1 vs A4, QF4=A2 vs B3.

-- ── 1) Extend playoff_format CHECK constraint ────────────────────
alter table public.tournaments
  drop constraint if exists tournaments_playoff_format_check;

alter table public.tournaments
  add constraint tournaments_playoff_format_check
  check (playoff_format in (
    'none',
    'top_2', 'top_4', 'top_8',
    'top_1_per_pool', 'top_2_per_pool'
  ));


-- ── 2) Redefine generate_playoff_bracket with top-N-per-pool branch ──
create or replace function public.generate_playoff_bracket(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
  v_format         text;
  v_match_type     text;
  v_playoff        text;
  v_playoff_n      integer;   -- N (top N per pool); null for non-per-pool variants
  v_uncompleted    integer;
  v_round_id       uuid;
  v_round_type     text;
  v_round_label    text;
  v_match_order    integer := 0;
  v_matches        integer := 0;
  v_i              integer;
  v_seeds          uuid[][];
  v_a              uuid[];
  v_b              uuid[];
  v_pool_count     integer;
  v_bracket_size   integer;
  v_per_pool_n     integer;   -- entrants per pool to take (N in top_N_per_pool)
  v_pairings       integer[][]; -- [bracket_slot1, bracket_slot2] per match
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
    -- Compute per-pool standings using the same tiebreaker chain as the
    -- flat path: wins desc → H2H (only when exactly 2 entrants in a pool
    -- are tied on wins) → point_diff desc → seed asc. Pool identity is
    -- parsed from tournament_rounds.label "Pool A · Round N" — we take
    -- the character following "Pool ".

    select count(distinct upper(substring(tr.label from 'Pool ([A-Z])')))::int
      into v_pool_count
      from public.tournament_rounds tr
     where tr.tournament_id = p_tournament_id
       and tr.label ~ '^Pool [A-Z]';
    if v_pool_count is null or v_pool_count < 2 then
      raise exception 'top_N_per_pool requires at least 2 labelled pool rounds (found %)', coalesce(v_pool_count, 0);
    end if;

    v_bracket_size := v_pool_count * v_per_pool_n;
    if v_bracket_size not in (2, 4, 8) then
      raise exception
        'top_%_per_pool with % pools yields % entrants — only powers of 2 (2/4/8) supported. Pick top_2/top_4/top_8 instead.',
        v_per_pool_n, v_pool_count, v_bracket_size;
    end if;

    -- Build per-pool standings, then take top N from each pool. The CTE
    -- chain mirrors the flat-path tiebreaker logic, scoped per pool.
    with pool_matches as (
      -- All completed matches with pool letter derived from round label.
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
    -- 2-entrant wins-ties within each pool — H2H applies.
    wins_pairs as (
      select pool_letter, wins
        from with_seed
       group by pool_letter, wins
      having count(*) = 2
    ),
    -- Postgres has no min(uuid) aggregate, so self-join on rn_within
    -- instead of pivoting via min(case when …). Matches PR #65 fix.
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
    -- Build the seed array. Snake order across (pool_rank, pool_letter):
    --   pool_rank=1 tier: A1, B1, C1, D1 (alphabetical by pool letter)
    --   pool_rank=2 tier: A2, B2, C2, D2
    -- Caller re-pairs into crossover slots below.
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

    -- v_seeds is in snake order:
    --   indices 1..P:       A1, B1, C1, D1 (the "#1 per pool" tier)
    --   indices P+1..2P:    A2, B2, C2, D2 (the "#2 per pool" tier)
    --
    -- Build crossover pairings as [seed_idx_1, seed_idx_2] (1-based).
    -- Pairings encode the canonical crossover layout from
    -- docs/tournament-formats/seeding-and-tiebreakers.md §3, with
    -- pool-affinity correction so same-pool entrants can only meet in the
    -- Final.

    if v_bracket_size = 2 then
      -- P=2, N=1: A1 vs B1 (Final).
      v_pairings := array[ array[1, 2] ];
    elsif v_bracket_size = 4 and v_pool_count = 2 then
      -- P=2, N=2: SF1=A1 vs B2, SF2=B1 vs A2.
      -- v_seeds = [A1, B1, A2, B2]; mapping: 1,4 / 2,3.
      v_pairings := array[ array[1, 4], array[2, 3] ];
    elsif v_bracket_size = 4 and v_pool_count = 4 then
      -- P=4, N=1: A1, B1, C1, D1 → standard 1v4, 2v3 by overall rank.
      -- v_seeds = [A1, B1, C1, D1] in pool-letter alphabetical order;
      -- SF1 = A1 vs D1, SF2 = B1 vs C1.
      v_pairings := array[ array[1, 4], array[2, 3] ];
    elsif v_bracket_size = 8 and v_pool_count = 4 then
      -- P=4, N=2: QF1=A1 vs D2, QF2=D1 vs B2, QF3=B1 vs C2, QF4=C1 vs A2
      -- (pool-affinity-corrected; see seeding-and-tiebreakers.md §3).
      -- v_seeds (snake): [A1, B1, C1, D1, A2, B2, C2, D2]
      --                     1   2   3   4   5   6   7   8
      v_pairings := array[ array[1, 8], array[4, 6], array[2, 7], array[3, 5] ];
    elsif v_bracket_size = 8 and v_pool_count = 2 then
      -- P=2, N=4: QF1=A1 vs B4, QF2=B2 vs A3, QF3=B1 vs A4, QF4=A2 vs B3.
      -- v_seeds (snake): [A1, B1, A2, B2, A3, B3, A4, B4]
      --                     1   2   3   4   5   6   7   8
      v_pairings := array[ array[1, 8], array[4, 5], array[2, 7], array[3, 6] ];
    else
      raise exception 'Unsupported top_N_per_pool bracket shape (pools=%, N=%)',
        v_pool_count, v_per_pool_n;
    end if;

    -- Round label / type from bracket size.
    v_round_label := case v_bracket_size
      when 8 then 'Quarterfinals'
      when 4 then 'Semifinals'
      when 2 then 'Finals'
    end;
    v_round_type := case v_bracket_size
      when 8 then 'quarterfinals'
      when 4 then 'semifinals'
      when 2 then 'finals'
    end;

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (p_tournament_id, 1000, v_round_label, v_round_type)
      returning id into v_round_id;

    for v_i in 1..array_length(v_pairings, 1) loop
      v_a := v_seeds[v_pairings[v_i][1]];
      v_b := v_seeds[v_pairings[v_i][2]];

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
        v_a[1],
        case when v_match_type = 'doubles' and v_a[1] <> v_a[2] then v_a[2] else null end,
        v_b[1],
        case when v_match_type = 'doubles' and v_b[1] <> v_b[2] then v_b[2] else null end,
        'pending'
      );
      v_match_order := v_match_order + 1;
      v_matches := v_matches + 1;
    end loop;

    -- No automatic 3PM for top_N_per_pool — the playoff_third_place
    -- toggle in the advancement trigger handles top_4/top_8 SE only.
    -- Top-N-per-pool brackets can wire that in later if requested.

    return v_matches;
  end if;

  -- ── FLAT TOP-N PATH (mirrors PR #62 + #65 min(uuid) fix) ──────
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
  -- Postgres has no min(uuid) aggregate, so self-join on rn_within
  -- instead of pivoting (matches PR #65 fix).
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
   where rn <= greatest(v_playoff_n, 4);  -- need top 4 for the 3PM in top_2

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

  for v_i in 0..(v_playoff_n / 2 - 1) loop
    v_a := v_seeds[v_i + 1];
    v_b := v_seeds[v_playoff_n - v_i];

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
      v_a[1],
      case when v_match_type = 'doubles' and v_a[1] <> v_a[2] then v_a[2] else null end,
      v_b[1],
      case when v_match_type = 'doubles' and v_b[1] <> v_b[2] then v_b[2] else null end,
      'pending'
    );
    v_match_order := v_match_order + 1;
    v_matches := v_matches + 1;
  end loop;

  if v_playoff_n = 2 and array_length(v_seeds, 1) >= 4 then
    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (p_tournament_id, 1100, 'Third Place Match', 'third_place_match')
      returning id into v_round_id;

    v_a := v_seeds[3];
    v_b := v_seeds[4];
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
      v_a[1],
      case when v_match_type = 'doubles' and v_a[1] <> v_a[2] then v_a[2] else null end,
      v_b[1],
      case when v_match_type = 'doubles' and v_b[1] <> v_b[2] then v_b[2] else null end,
      'pending'
    );
    v_matches := v_matches + 1;
  end if;

  return v_matches;
end;
$$;

grant execute on function public.generate_playoff_bracket(uuid) to authenticated;

notify pgrst, 'reload schema';
