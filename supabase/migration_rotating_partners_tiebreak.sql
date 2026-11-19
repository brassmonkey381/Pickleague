-- migration_rotating_partners_tiebreak.sql — PKL-044: rotating-partners ties.
--
-- Brian 2026-11-18: "PKL-044: 1 yes, 2 head to head then points difference".
-- Rotating-partners final ranks were wins, fewer losses, rating, then chance.
-- Now, for players level on wins AND losses:
--   1. head-to-head: whole matches won minus lost, counting only matches where
--      at least one other player of that tied group was on the other side
--      (one match counts once). Two tied players: plain head-to-head. Three or
--      more: a mini-table among them, applied once (not re-applied to players
--      still level after it);
--   2. point difference over all their completed matches;
--   3. overall PLUPR; then the database's order (chance).
-- MLP's per-player path is unchanged. The client twin is computePlayerStandings
-- / tiedOpponentRecord (mobile/src/lib/tournamentStandings.ts).
-- Item 1 (byes rotate, equal matches) is the app's schedule generator; no SQL.
-- compute_tournament_final_ranks is migration_tournament_staged_placement.sql's
-- body (applied 2026-11-18) with only the per-player ranking changed.
-- Safe to re-run.

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

  -- Per-player formats (rotating_partners, mlp, ...). rotating_partners breaks
  -- ties on wins and losses by head-to-head, then point diff, then rating
  -- (PKL-044); mlp keeps wins, losses, rating.
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
  point_diff as (
    -- Points for minus against over the player's completed matches, as the
    -- client's computePlayerStandings (pf - pa).
    select e.user_id,
           coalesce(sum(case
             when mo.id is null then 0
             when e.user_id in (mo.team1_player1, mo.team1_player2) then coalesce(mo.team1_score, 0) - coalesce(mo.team2_score, 0)
             else coalesce(mo.team2_score, 0) - coalesce(mo.team1_score, 0)
           end), 0) as diff
      from entrants e
      left join match_outcomes mo
        on e.user_id in (mo.team1_player1, mo.team1_player2, mo.team2_player1, mo.team2_player2)
     group by e.user_id
  ),
  tied_h2h as (
    -- Head-to-head inside a group level on wins AND losses: whole matches won
    -- minus lost where at least one other player of the group was on the
    -- other side (tiedOpponentRecord in lib/tournamentStandings.ts). One pass
    -- over the whole group; 2 tied = plain head-to-head, 3+ = a mini-table.
    select pu.user_id,
           sum(case when (pu.user_id in (mo.team1_player1, mo.team1_player2)) = (mo.winner_team = 'team1')
                    then 1 else -1 end) as net
      from per_user pu
      join match_outcomes mo
        on pu.user_id in (mo.team1_player1, mo.team1_player2, mo.team2_player1, mo.team2_player2)
     where exists (
       select 1 from per_user o
        where o.user_id <> pu.user_id and o.wins = pu.wins and o.losses = pu.losses
          and (
            (pu.user_id in (mo.team1_player1, mo.team1_player2) and o.user_id in (mo.team2_player1, mo.team2_player2))
         or (pu.user_id in (mo.team2_player1, mo.team2_player2) and o.user_id in (mo.team1_player1, mo.team1_player2))
          ))
     group by pu.user_id
  ),
  ranked as (
    select pu.user_id, pu.wins, pu.losses,
      row_number() over (order by pu.wins desc, pu.losses asc,
                                  case when v_format = 'rotating_partners' then coalesce(h.net, 0) else 0 end desc,
                                  case when v_format = 'rotating_partners' then coalesce(d.diff, 0) else 0 end desc,
                                  coalesce(p.rating, 0) desc) as rk
    from per_user pu
    left join profiles p on p.id = pu.user_id
    left join tied_h2h h on h.user_id = pu.user_id
    left join point_diff d on d.user_id = pu.user_id
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

notify pgrst, 'reload schema';
