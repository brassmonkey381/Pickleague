-- ============================================================
-- PKL-037 (server): staged final placement for round robin and pool play,
-- plus the auto-close race.
--
-- Rule decided by Brian, 2026-11-18 (triage-studio items/PKL-037.md):
--   - the Final decides places 1-2;
--   - the Third Place Match decides places 3-4 (bug B1: it decided nothing);
--   - everyone else is placed by the ROUND ROBIN order alone. The playoff
--     matches no longer add wins, points or head-to-head to places 5+.
--   - Final only (no 3PM): 1-2 from the Final, 3..N from the RR order.
--   - Completion stays automatic once the last playoff match is scored.
-- Reference: triage-studio/state/pkl-034/oracle.mjs intuitivePlacements().
--
-- Before (compute_tournament_final_ranks, migration_fix_champion_rank_collision.sql
-- :187-191): rank 1 = Final winner, rank 2 = Final loser, ranks 3+ by the
-- chain over ALL completed matches, the Final and 3PM included. So the 3PM
-- winner could finish 4th, the 3PM loser 5th (B1), and a 3PM loss could drop
-- RR #4 below RR #5; the "exactly 2 share this win count" test also counted
-- the two finalists (B8).
--
-- This file:
--   1. _pl_tournament_group_order(tournament): the round-robin order, the SQL
--      twin of the client comparator (mobile/src/lib/tournamentTiebreakers.ts
--      buildStandingsComparator, via tournamentStandings.computeTeamStandings):
--        wins desc
--        -> head-to-head, only when exactly 2 entrants share that win count
--           (over group matches; a split or no meeting falls through)
--        -> point differential desc
--        -> registration seed asc (a doubles pair takes its lower seed; none = 999)
--        -> (full tie) the lower team key, for a stable order.
--      Entrants are every team in a group-stage match ('winners' / 'pool'
--      round, or no round), pending ones at 0-0, as the client lists them.
--      Teams are fixed pairs in doubles: both partners share one entrant.
--      Returns lo, hi (the pair's two user ids, lo = hi in singles), wins,
--      losses, point_diff, seed, rr_rank. Internal (the client has the same
--      order in computeTeamStandings).
--   2. compute_tournament_final_ranks: round_robin and pool_play use the
--      staged rule. Placement tiers:
--        1 Final winner, 2 Final loser (last completed finals match),
--        3 3PM winner, 4 3PM loser (last completed third_place_match),
--        then other playoff entrants (semifinal / quarterfinal losers when
--        there is no 3PM), deepest round first, then RR order,
--        then everyone else in RR order.
--      An unplayed Final or 3PM (an admin closed early) pins nothing; its
--      players fall into "other playoff entrants".
--      Both partners of a doubles team get the same final_rank. wins /
--      losses stored are over every completed match (unchanged meaning).
--      Approved registrants who never appear in a match still trail by seed.
--      single_elimination / double_elimination keep their bracket path
--      verbatim. rotating_partners / mlp keep the per-player path (wins
--      desc, losses asc, rating desc), except that the champion-badge pin
--      now applies to MLP only: rotating partners has no playoff, so its
--      final places are its standings order (Brian's rule), matching the
--      client's computePlayerStandings.
--   3. _maybe_auto_close_non_elim_tournament locks the tournament row before
--      counting open matches (bug B3: when the Final and the 3PM were saved
--      at the same moment, each transaction still saw the other match open
--      and neither closed the tournament). Now the second one waits for the
--      first, then sees it committed.
--
-- Ranks are computed when the tournament completes (trg_settle_wagers_tournament
-- -> _settle_wagers_for_tournament -> compute_tournament_final_ranks). This file
-- does not recompute ranks of tournaments that already completed. Re-runnable.
-- Apply: supabase db query --linked -f supabase/migration_tournament_staged_placement.sql
-- Test:  state/pkl-035-036-037-test.sql (begin ... rollback).
-- ============================================================


-- ── 1. Round-robin order ────────────────────────────────────────────────────
create or replace function public._pl_tournament_group_order(p_tournament_id uuid)
returns table (lo uuid, hi uuid, wins integer, losses integer, point_diff integer, seed integer, rr_rank integer)
language sql
stable
security definer
set search_path = ''
as $$
  with grp as (
    select m.*,
           least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1))    as a_lo,
           greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) as a_hi,
           least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1))    as b_lo,
           greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) as b_hi
      from public.tournament_matches m
      left join public.tournament_rounds r on r.id = m.round_id
     where m.tournament_id = p_tournament_id
       and m.team1_player1 is not null and m.team2_player1 is not null
       and (r.id is null or r.round_type in ('winners', 'pool'))
  ),
  done as (
    select * from grp where status = 'completed' and winner_team in ('team1', 'team2')
  ),
  ent as (
    select a_lo as lo, a_hi as hi from grp
    union
    select b_lo, b_hi from grp
  ),
  side as (
    select a_lo as lo, a_hi as hi, coalesce(team1_score, 0) as pf, coalesce(team2_score, 0) as pa,
           (winner_team = 'team1')::int as w, (winner_team = 'team2')::int as l
      from done
    union all
    select b_lo, b_hi, coalesce(team2_score, 0), coalesce(team1_score, 0),
           (winner_team = 'team2')::int, (winner_team = 'team1')::int
      from done
  ),
  agg as (
    select e.lo, e.hi,
           coalesce(sum(s.w), 0)::int as wins,
           coalesce(sum(s.l), 0)::int as losses,
           coalesce(sum(s.pf - s.pa), 0)::int as point_diff
      from ent e
      left join side s on s.lo = e.lo and s.hi = e.hi
     group by e.lo, e.hi
  ),
  seeded as (
    select a.*,
           coalesce((select min(tr.seed) from public.tournament_registrations tr
                      where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)), 999)::int as seed
      from agg a
  ),
  pair2 as (
    -- Each entrant whose win count is shared by exactly one other entrant, with that other.
    select s.lo, s.hi, o.lo as o_lo, o.hi as o_hi
      from seeded s
      join seeded o on o.wins = s.wins and (o.lo, o.hi) <> (s.lo, s.hi)
     where (select count(*) from seeded x where x.wins = s.wins) = 2
  ),
  h2h as (
    select p.lo, p.hi,
           sign(coalesce(sum(case
             when d.a_lo = p.lo and d.a_hi = p.hi and d.b_lo = p.o_lo and d.b_hi = p.o_hi
               then case when d.winner_team = 'team1' then 1 else -1 end
             when d.b_lo = p.lo and d.b_hi = p.hi and d.a_lo = p.o_lo and d.a_hi = p.o_hi
               then case when d.winner_team = 'team2' then 1 else -1 end
             else 0 end), 0))::int as h2h_score
      from pair2 p
      left join done d
        on (d.a_lo = p.lo and d.a_hi = p.hi and d.b_lo = p.o_lo and d.b_hi = p.o_hi)
        or (d.b_lo = p.lo and d.b_hi = p.hi and d.a_lo = p.o_lo and d.a_hi = p.o_hi)
     group by p.lo, p.hi
  )
  select s.lo, s.hi, s.wins, s.losses, s.point_diff, s.seed,
         (row_number() over (order by s.wins desc, coalesce(h.h2h_score, 0) desc,
                                      s.point_diff desc, s.seed asc, s.lo asc, s.hi asc))::int as rr_rank
    from seeded s
    left join h2h h on h.lo = s.lo and h.hi = s.hi
$$;
revoke all on function public._pl_tournament_group_order(uuid) from public, anon, authenticated;


-- ── 2. Final ranks ──────────────────────────────────────────────────────────
create or replace function public.compute_tournament_final_ranks(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows   int;
  v_format text;
begin
  select format into v_format from tournaments where id = p_tournament_id;
  delete from tournament_final_ranks where tournament_id = p_tournament_id;

  -- Staged: round robin / pool play (+ optional playoff). PKL-037.
  if v_format in ('round_robin', 'pool_play') then
    with rr as (
      select * from public._pl_tournament_group_order(p_tournament_id)
    ),
    pm as (
      -- Playoff matches with both sides set.
      select m.*, r.round_type, r.round_number,
             least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1))    as a_lo,
             greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)) as a_hi,
             least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1))    as b_lo,
             greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)) as b_hi
        from tournament_matches m
        join tournament_rounds r on r.id = m.round_id
       where m.tournament_id = p_tournament_id
         and r.round_type not in ('winners', 'pool')
         and m.team1_player1 is not null and m.team2_player1 is not null
    ),
    fin as (
      select * from pm
       where round_type in ('finals', 'grand_final') and status = 'completed' and winner_team in ('team1', 'team2')
       order by round_number desc, match_order desc limit 1
    ),
    third as (
      select * from pm
       where round_type = 'third_place_match' and status = 'completed' and winner_team in ('team1', 'team2')
       order by round_number desc, match_order desc limit 1
    ),
    pinned as (
      select case when winner_team = 'team1' then a_lo else b_lo end as lo,
             case when winner_team = 'team1' then a_hi else b_hi end as hi, 1 as tier from fin
      union all
      select case when winner_team = 'team1' then b_lo else a_lo end,
             case when winner_team = 'team1' then b_hi else a_hi end, 2 from fin
      union all
      select case when winner_team = 'team1' then a_lo else b_lo end,
             case when winner_team = 'team1' then a_hi else b_hi end, 3 from third
      union all
      select case when winner_team = 'team1' then b_lo else a_lo end,
             case when winner_team = 'team1' then b_hi else a_hi end, 4 from third
    ),
    reached as (
      -- Deepest playoff round each team played in.
      select lo, hi, max(round_number) as deepest from (
        select a_lo as lo, a_hi as hi, round_number from pm
        union all
        select b_lo, b_hi, round_number from pm
      ) x group by lo, hi
    ),
    teams as (
      select lo, hi from rr
      union
      select lo, hi from reached
    ),
    totals as (
      -- W-L over every completed match, playoff included (the stored meaning).
      select t.lo, t.hi,
             coalesce(sum(case when (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)), greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1))) = (t.lo, t.hi) and m.winner_team = 'team1' then 1
                               when (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)), greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1))) = (t.lo, t.hi) and m.winner_team = 'team2' then 1
                               else 0 end), 0)::int as wins,
             coalesce(sum(case when (least(m.team1_player1, coalesce(m.team1_player2, m.team1_player1)), greatest(m.team1_player1, coalesce(m.team1_player2, m.team1_player1))) = (t.lo, t.hi) and m.winner_team = 'team2' then 1
                               when (least(m.team2_player1, coalesce(m.team2_player2, m.team2_player1)), greatest(m.team2_player1, coalesce(m.team2_player2, m.team2_player1))) = (t.lo, t.hi) and m.winner_team = 'team1' then 1
                               else 0 end), 0)::int as losses
        from teams t
        left join tournament_matches m
          on m.tournament_id = p_tournament_id and m.status = 'completed' and m.winner_team in ('team1', 'team2')
         and m.team1_player1 is not null and m.team2_player1 is not null
         and t.lo in (m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2)
       group by t.lo, t.hi
    ),
    ranked_teams as (
      select t.lo, t.hi, tt.wins, tt.losses,
             row_number() over (
               order by coalesce((select min(p.tier) from pinned p where p.lo = t.lo and p.hi = t.hi),
                                 case when rc.lo is not null then 5 else 6 end),
                        coalesce(rc.deepest, 0) desc,
                        coalesce(r.rr_rank, 2147483647),
                        t.lo, t.hi
             ) as team_rank
        from teams t
        join totals tt on tt.lo = t.lo and tt.hi = t.hi
        left join rr r on r.lo = t.lo and r.hi = t.hi
        left join reached rc on rc.lo = t.lo and rc.hi = t.hi
    ),
    team_users as (
      select team_rank, wins, losses, lo as user_id from ranked_teams
      union
      select team_rank, wins, losses, hi from ranked_teams
    ),
    leftovers as (
      select tr.user_id, coalesce(tr.seed, 999) as seed
        from tournament_registrations tr
       where tr.tournament_id = p_tournament_id and tr.status = 'approved'
         and not exists (select 1 from team_users tu where tu.user_id = tr.user_id)
    ),
    leftover_ranked as (
      select user_id,
             (select coalesce(max(team_rank), 0) from ranked_teams)
               + row_number() over (order by seed asc, user_id asc) as team_rank
        from leftovers
    )
    insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
    select p_tournament_id, user_id, team_rank, wins, losses from team_users
    union all
    select p_tournament_id, user_id, team_rank, 0, 0 from leftover_ranked;

    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  -- Bracket formats: unchanged from migration_fix_champion_rank_collision.sql.
  if v_format in ('single_elimination', 'double_elimination') then
    with raw as (
      select least(team1_player1, coalesce(team1_player2, team1_player1))    as lo,
             greatest(team1_player1, coalesce(team1_player2, team1_player1)) as hi,
             coalesce(team1_score, 0) as pf, coalesce(team2_score, 0) as pa,
             case when winner_team = 'team1' then 1 else 0 end as wins,
             case when winner_team = 'team2' then 1 else 0 end as losses
        from tournament_matches
       where tournament_id = p_tournament_id and status = 'completed'
         and winner_team in ('team1','team2') and team1_player1 is not null
      union all
      select least(team2_player1, coalesce(team2_player2, team2_player1)),
             greatest(team2_player1, coalesce(team2_player2, team2_player1)),
             coalesce(team2_score, 0), coalesce(team1_score, 0),
             case when winner_team = 'team2' then 1 else 0 end,
             case when winner_team = 'team1' then 1 else 0 end
        from tournament_matches
       where tournament_id = p_tournament_id and status = 'completed'
         and winner_team in ('team1','team2') and team2_player1 is not null
    ),
    agg as (
      select lo, hi, sum(wins)::int as wins, sum(losses)::int as losses,
             sum(pf)::int - sum(pa)::int as point_diff
        from raw group by lo, hi
    ),
    gf as (
      select tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2, tm.winner_team
        from tournament_matches tm
        join tournament_rounds tr on tr.id = tm.round_id
       where tm.tournament_id = p_tournament_id
         and tr.round_type in ('finals', 'grand_final')
         and tm.status = 'completed' and tm.winner_team in ('team1','team2')
       order by tr.round_number desc, tm.match_order desc
       limit 1
    ),
    gf_loser as (
      select least(case when winner_team = 'team1' then team2_player1 else team1_player1 end,
                   coalesce(case when winner_team = 'team1' then team2_player2 else team1_player2 end,
                            case when winner_team = 'team1' then team2_player1 else team1_player1 end)) as lo,
             greatest(case when winner_team = 'team1' then team2_player1 else team1_player1 end,
                      coalesce(case when winner_team = 'team1' then team2_player2 else team1_player2 end,
                               case when winner_team = 'team1' then team2_player1 else team1_player1 end)) as hi
        from gf
    ),
    gf_winner as (
      select least(case when winner_team = 'team1' then team1_player1 else team2_player1 end,
                   coalesce(case when winner_team = 'team1' then team1_player2 else team2_player2 end,
                            case when winner_team = 'team1' then team1_player1 else team2_player1 end)) as lo,
             greatest(case when winner_team = 'team1' then team1_player1 else team2_player1 end,
                      coalesce(case when winner_team = 'team1' then team1_player2 else team2_player2 end,
                               case when winner_team = 'team1' then team1_player1 else team2_player1 end)) as hi
        from gf
    ),
    with_seed as (
      select a.*, coalesce((
               select min(tr.seed) from tournament_registrations tr
                where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)
             ), 999) as seed,
             (exists (
               select 1 from tournament_champion_badges cb
                where cb.tournament_id = p_tournament_id and cb.user_id in (a.lo, a.hi)
             ) or exists (
               select 1 from gf_winner g where g.lo = a.lo and g.hi = a.hi
             )) as is_champ,
             exists (
               select 1 from gf_loser g where g.lo = a.lo and g.hi = a.hi
             ) as is_gf_loser
        from agg a
    ),
    pre as (
      select *, row_number() over (order by wins desc, point_diff desc, seed asc) as rn
        from with_seed
    ),
    wins_pairs as (select wins from with_seed group by wins having count(*) = 2),
    ranked_pairs as (
      select p.*, row_number() over (partition by p.wins order by p.rn) as rn_within from pre p
    ),
    ties_2 as (
      select w.wins, e1.lo as lo1, e1.hi as hi1, e2.lo as lo2, e2.hi as hi2
        from wins_pairs w
        join ranked_pairs e1 on e1.wins = w.wins and e1.rn_within = 1
        join ranked_pairs e2 on e2.wins = w.wins and e2.rn_within = 2
    ),
    h2h as (
      select t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
             coalesce(sum(case when (
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
               ) then 1 else 0 end)::int, 0) as h2h_wins_1,
             coalesce(sum(case when (
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
               ) then 1 else 0 end)::int, 0) as h2h_wins_2
        from ties_2 t
        left join tournament_matches m
          on m.tournament_id = p_tournament_id and m.status = 'completed'
       group by t.wins, t.lo1, t.hi1, t.lo2, t.hi2
    ),
    h2h_per_team as (
      select p.lo, p.hi, p.wins, p.losses, p.point_diff, p.seed, p.is_champ, p.is_gf_loser,
             coalesce(case
               when h.h2h_wins_1 = h.h2h_wins_2 then 0
               when (p.lo = h.lo1 and p.hi = h.hi1) then
                 case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
               when (p.lo = h.lo2 and p.hi = h.hi2) then
                 case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
               else 0 end, 0) as h2h_score
        from pre p
        left join h2h h on h.wins = p.wins
                       and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
    ),
    ranked_teams as (
      select *, row_number() over (
               order by is_champ desc, is_gf_loser desc, wins desc, h2h_score desc, point_diff desc, seed asc
             ) as team_rank
        from h2h_per_team
    ),
    team_users as (
      select team_rank, wins, losses, lo as user_id from ranked_teams
      union all
      select team_rank, wins, losses, hi from ranked_teams where hi <> lo
    ),
    leftovers as (
      select tr.user_id,
             coalesce(tr.seed, 999) as seed
        from tournament_registrations tr
       where tr.tournament_id = p_tournament_id and tr.status = 'approved'
         and not exists (select 1 from team_users tu where tu.user_id = tr.user_id)
    ),
    leftover_ranked as (
      select user_id,
             (select coalesce(max(team_rank), 0) from ranked_teams)
               + row_number() over (order by seed asc) as team_rank
        from leftovers
    )
    insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
    select p_tournament_id, user_id, team_rank, wins, losses from team_users
    union all
    select p_tournament_id, user_id, team_rank, 0, 0 from leftover_ranked;

    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  -- Per-player formats (rotating_partners, mlp, ...): unchanged.
  with entrants as (
    select tr.user_id
      from tournament_registrations tr
     where tr.tournament_id = p_tournament_id
       and tr.status = 'approved'
  ),
  match_outcomes as (
    select tm.* from tournament_matches tm
     where tm.tournament_id = p_tournament_id
       and coalesce(tm.status, 'completed') = 'completed'
       and tm.winner_team in ('team1','team2')
  ),
  per_user as (
    select
      e.user_id,
      coalesce(sum(case
        when mo.id is null then 0
        when mo.game_scores is not null and jsonb_typeof(mo.game_scores) = 'array' and jsonb_array_length(mo.game_scores) > 0 then (
          select count(*)::int from jsonb_array_elements(mo.game_scores) g
           where (
             ((mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and (g->>'t1')::int > (g->>'t2')::int)
          or ((mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and (g->>'t2')::int > (g->>'t1')::int)
           ))
        when (mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and mo.winner_team='team1' then 1
        when (mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and mo.winner_team='team2' then 1
        else 0
      end), 0) as wins,
      coalesce(sum(case
        when mo.id is null then 0
        when mo.game_scores is not null and jsonb_typeof(mo.game_scores) = 'array' and jsonb_array_length(mo.game_scores) > 0 then (
          select count(*)::int from jsonb_array_elements(mo.game_scores) g
           where (
             ((mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and (g->>'t2')::int > (g->>'t1')::int)
          or ((mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and (g->>'t1')::int > (g->>'t2')::int)
           ))
        when (mo.team1_player1 = e.user_id or mo.team1_player2 = e.user_id) and mo.winner_team='team2' then 1
        when (mo.team2_player1 = e.user_id or mo.team2_player2 = e.user_id) and mo.winner_team='team1' then 1
        else 0
      end), 0) as losses
    from entrants e
    left join match_outcomes mo
      on e.user_id in (mo.team1_player1, mo.team1_player2, mo.team2_player1, mo.team2_player2)
    group by e.user_id
  ),
  ranked as (
    select pu.user_id, pu.wins, pu.losses,
      row_number() over (order by pu.wins desc, pu.losses asc, coalesce(p.rating, 0) desc) as rk
    from per_user pu
    left join profiles p on p.id = pu.user_id
  ),
  champion_row as (
    -- MLP only. rotating_partners has no playoff, so its places are the
    -- standings order exactly (wins, fewer losses, rating), as the client's
    -- computePlayerStandings shows them; a champion badge (written by a payout
    -- AFTER ranks exist) must not reorder them on a later recompute.
    select user_id from tournament_champion_badges
     where tournament_id = p_tournament_id
       and v_format in ('mlp', 'mlp_random')
     limit 1
  ),
  with_champion as (
    select r.user_id, r.wins, r.losses,
           row_number() over (
             order by case when r.user_id = (select user_id from champion_row) then 0 else 1 end,
                      r.rk
           ) as rk
    from ranked r
  )
  insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
  select p_tournament_id, user_id, rk, wins, losses
    from with_champion;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;
revoke execute on function public.compute_tournament_final_ranks(uuid) from public, anon, authenticated;


-- ── 3. Auto-close: serialize on the tournament row (B3) ─────────────────────
-- As in migration_autoclose_respects_playoff.sql (= live copy, 2026-11-18),
-- plus the row lock before the open-match count.
create or replace function public._maybe_auto_close_non_elim_tournament()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_format   text;
  v_status   text;
  v_playoff  text;
  v_pending  integer;
begin
  if new.status <> 'completed' then return new; end if;
  if TG_OP = 'UPDATE' and old.status = 'completed' then return new; end if;

  begin
    -- FOR UPDATE: two scores saved at once (the Final and the 3PM) queue here.
    -- The second one then counts open matches with a fresh snapshot (READ
    -- COMMITTED) and sees the first one's match completed.
    select format, status, coalesce(playoff_format, 'none')
      into v_format, v_status, v_playoff
      from public.tournaments where id = new.tournament_id
       for update;

    if v_format not in ('round_robin', 'pool_play', 'rotating_partners') then
      return new;
    end if;
    if v_status <> 'active' then return new; end if;

    -- A configured playoff must actually run before the tournament can close.
    if v_playoff <> 'none' and not exists (
      select 1 from public.tournament_rounds r
       where r.tournament_id = new.tournament_id
         and r.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match')
    ) then
      return new;
    end if;

    select count(*) into v_pending
      from public.tournament_matches
     where tournament_id = new.tournament_id
       and status <> 'completed';

    if v_pending = 0 then
      update public.tournaments
         set status = 'completed'
       where id = new.tournament_id
         and status = 'active';
    end if;
  exception when others then
    null; -- never block the score update
  end;

  return new;
end;
$function$;
revoke execute on function public._maybe_auto_close_non_elim_tournament() from public, anon, authenticated;

notify pgrst, 'reload schema';
