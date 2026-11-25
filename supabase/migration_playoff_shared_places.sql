-- PKL-085 / PKL-090 (Brian 2026-11-25: "shared 3rd"). Applied by hand, after the rolled-back trial state/pshared3-trial.sql.
-- With no 3rd-place match the two semifinal losers share 3rd (the approved standings rulebook, rule 0.2); teams out in
-- the same earlier playoff round share that place too. Places count like sports results: 1, 2, 3, 3, 5.
--   1. compute_tournament_final_ranks: staged (round robin / pool play + playoff) and MLP. Single and double
--      elimination are unchanged.
--   2. preview_tournament_payout: a place shared by k teams takes the k prize slots it covers (3rd + 4th), split
--      equally, so no prize slot is left unpaid. (MLP's own payout already splits 3rd between the semifinal losers.)
--   3. _pl_tournament_status_notices: "Final placement: 3rd of N" uses the last place number, not the count of places.
-- Placement pay (_pl_placement_pay, 1st-3rd) now reaches both 3rd-place teams. Grants are unchanged.

CREATE OR REPLACE FUNCTION public.compute_tournament_final_ranks(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    ranked_pre as (
      select t.lo, t.hi, tt.wins, tt.losses,
             coalesce((select min(p.tier) from pinned p where p.lo = t.lo and p.hi = t.hi),
                      case when rc.lo is not null then 5 else 6 end) as tier,
             coalesce(rc.deepest, 0) as deepest,
             row_number() over (
               order by coalesce((select min(p.tier) from pinned p where p.lo = t.lo and p.hi = t.hi),
                                 case when rc.lo is not null then 5 else 6 end),
                        coalesce(rc.deepest, 0) desc,
                        coalesce(r.rr_rank, 2147483647),
                        t.lo, t.hi
             ) as rn
        from teams t
        join totals tt on tt.lo = t.lo and tt.hi = t.hi
        left join rr r on r.lo = t.lo and r.hi = t.hi
        left join reached rc on rc.lo = t.lo and rc.hi = t.hi
    ),
    -- Brian 2026-11-25 ("shared 3rd"): playoff teams out in the same round, with no placement match between them,
    -- share the place (no 3rd-place match: both semifinal losers are 3rd; quarterfinal losers 5th). 1, 2, 3, 3, 5.
    ranked_teams as (
      select lo, hi, wins, losses,
             case when tier = 5 then min(rn) over (partition by tier, deepest) else rn end as team_rank
        from ranked_pre
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
             (select count(*) from ranked_teams)
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
    ranked_teams as (
      -- PKL-052: wins, fewer losses, point diff, then the admin's tie order
      -- (seed only keeps an unset tie deterministic). No head-to-head.
      select *, row_number() over (
               order by is_champ desc, is_gf_loser desc, wins desc, losses asc, point_diff desc,
                        coalesce(public._pl_tie_rank(p_tournament_id, lo, hi), 2147483647), seed asc, lo, hi
             ) as team_rank
        from pre
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

  -- PKL-078 (Brian, 2026-11-23: "Whole team shares the place"): MLP places are by team, and every player on a team
  -- takes the team's place, the way doubles partners share one. Final winner 1, Final loser 2, Third Place winner 3,
  -- loser 4, then the other playoff teams (deeper round first), then the rest; inside each tier the team standings
  -- (PKL-077: sub-match W, fewer L, point diff, admin tie order, seed).
  if v_format in ('mlp', 'mlp_random') then
    with st as (
      select s.team_id, s.matchups_won as w, s.matchups_lost as l,
             row_number() over (order by s.matchups_won desc, s.matchups_lost asc, s.point_diff desc, s.sub_matches_won desc, s.sub_matches_lost asc, coalesce(s.tie_rank, 2147483647), s.seed, s.team_id) as rr
        from public.mlp_team_standings(p_tournament_id) s
    ),
    po as (
      select r.id, r.round_type,
             case r.round_type when 'quarterfinals' then 1 when 'semifinals' then 2 when 'third_place_match' then 3 when 'finals' then 4 else 0 end as depth,
             public._mlp_round_winner(r.id) as winner
        from tournament_rounds r
       where r.tournament_id = p_tournament_id
         and r.round_type in ('quarterfinals', 'semifinals', 'third_place_match', 'finals')
    ),
    po_teams as (
      select distinct po.id, po.round_type, po.depth, po.winner, t.id as team_id
        from po
        join tournament_matches m on m.round_id = po.id
        join mlp_teams t on t.tournament_id = p_tournament_id
         and (m.team1_player1 in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id)
           or m.team2_player1 in (t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id))
    ),
    tiers as (
      select st.team_id, st.w, st.l, st.rr,
             coalesce((select min(case
                        when pt.round_type = 'finals' and pt.winner = st.team_id then 1
                        when pt.round_type = 'finals' and pt.winner is not null then 2
                        when pt.round_type = 'third_place_match' and pt.winner = st.team_id then 3
                        when pt.round_type = 'third_place_match' and pt.winner is not null then 4
                        else 5 end)
                         from po_teams pt where pt.team_id = st.team_id), 6) as tier,
             coalesce((select max(pt.depth) from po_teams pt where pt.team_id = st.team_id), 0) as depth
        from st
    ),
    ranked as (
      -- Brian 2026-11-25 ("shared 3rd"): teams out in the same playoff round, no placement match between them, share it.
      select team_id, w, l, case when tier = 5 then min(rn) over (partition by tier, depth) else rn end as team_rank
        from (select team_id, w, l, tier, depth, row_number() over (order by tier, depth desc, rr) as rn from tiers) x
    ),
    members as (
      select r.team_rank, r.w, r.l, u.user_id
        from ranked r
        join mlp_teams t on t.id = r.team_id
        cross join lateral (values (t.male_1_id), (t.male_2_id), (t.female_1_id), (t.female_2_id)) u(user_id)
       where u.user_id is not null
    ),
    leftovers as (
      select tr.user_id, row_number() over (order by coalesce(tr.seed, 999), tr.user_id) as k
        from tournament_registrations tr
       where tr.tournament_id = p_tournament_id and tr.status = 'approved'
         and not exists (select 1 from members m where m.user_id = tr.user_id)
    )
    insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
    select p_tournament_id, user_id, team_rank, w, l from members
    union all
    select p_tournament_id, user_id, (select count(*) from ranked) + k, 0, 0 from leftovers;

    get diagnostics v_rows = row_count;
    return v_rows;
  end if;

  -- Per-player formats (rotating_partners, mlp, ...): wins, fewer losses, point
  -- diff, then the admin's tie order (PKL-052).
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
  ranked as (
    -- PKL-052, every per-player format: wins, fewer losses, point diff, then
    -- the admin's tie order (seed only keeps an unset tie deterministic). No
    -- head-to-head, no rating.
    select pu.user_id, pu.wins, pu.losses,
      row_number() over (order by pu.wins desc, pu.losses asc, coalesce(d.diff, 0) desc,
                                  coalesce(public._pl_tie_rank(p_tournament_id, pu.user_id, pu.user_id), 2147483647),
                                  coalesce(tr.seed, 999) asc, pu.user_id) as rk
    from per_user pu
    left join point_diff d on d.user_id = pu.user_id
    left join tournament_registrations tr on tr.tournament_id = p_tournament_id and tr.user_id = pu.user_id
  ),
  champion_row as (
    -- MLP only. rotating_partners has no playoff, so its places are the
    -- standings order exactly (wins, fewer losses, point diff, then the
    -- admin's tie order), as the client's
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

CREATE OR REPLACE FUNCTION public.preview_tournament_payout(p_tournament_id uuid)
 RETURNS TABLE(place integer, team_id uuid, team_name text, uids uuid[], user_names text[], pool_share integer, share_per_user integer, plupr_bonus numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
declare
  v_format       text;
  v_match_type   text;
  v_pool         integer;
  v_structure    integer[];
  v_slots        integer;
  v_final        record;
  v_winner_uids  uuid[];
  v_loser_uids   uuid[];
  v_winner_pair  uuid;
  v_loser_pair   uuid;
  v_third        record;
  v_third_sides  integer;
begin
  select t.format, t.match_type, coalesce(t.prize_pool, 0),
         coalesce(t.payout_structure, '{60,25,15}')
    into v_format, v_match_type, v_pool, v_structure
    from public.tournaments t where t.id = p_tournament_id;

  if v_format is null then return; end if;
  v_slots := coalesce(array_length(v_structure, 1), 0);
  if v_slots = 0 then return; end if;

  if v_format in ('mlp', 'mlp_random') then
    return query
      select p.place, p.team_id, p.team_name, p.uids, p.user_names,
             p.pool_share, p.share_per_user, p.plupr_bonus
        from public.preview_mlp_tournament_payout(p_tournament_id) p;
    return;
  end if;

  if v_format in ('single_elimination', 'double_elimination') then
    select tm.id,
           tm.team1_player1, tm.team1_player2,
           tm.team2_player1, tm.team2_player2,
           tm.winner_team
      into v_final
      from public.tournament_matches tm
      join public.tournament_rounds  tr on tr.id = tm.round_id
     where tr.tournament_id = p_tournament_id
       and tr.round_type in ('finals', 'grand_final')
       and tm.status = 'completed'
       and tm.winner_team in ('team1', 'team2')
     order by tr.round_number desc, tm.match_order desc
     limit 1;

    if v_final.id is null then return; end if;

    if v_final.winner_team = 'team1' then
      v_winner_uids := array_remove(array[v_final.team1_player1, v_final.team1_player2], null);
      v_loser_uids  := array_remove(array[v_final.team2_player1, v_final.team2_player2], null);
    else
      v_winner_uids := array_remove(array[v_final.team2_player1, v_final.team2_player2], null);
      v_loser_uids  := array_remove(array[v_final.team1_player1, v_final.team1_player2], null);
    end if;

    if v_match_type = 'doubles' and array_length(v_winner_uids, 1) >= 2 then
      select dp.id into v_winner_pair from public.doubles_pairs dp
       where dp.tournament_id = p_tournament_id
         and (
              (dp.partner_1_id = v_winner_uids[1] and dp.partner_2_id = v_winner_uids[2])
           or (dp.partner_1_id = v_winner_uids[2] and dp.partner_2_id = v_winner_uids[1])
         )
       limit 1;
    end if;
    if v_match_type = 'doubles' and array_length(v_loser_uids, 1) >= 2 then
      select dp.id into v_loser_pair from public.doubles_pairs dp
       where dp.tournament_id = p_tournament_id
         and (
              (dp.partner_1_id = v_loser_uids[1] and dp.partner_2_id = v_loser_uids[2])
           or (dp.partner_1_id = v_loser_uids[2] and dp.partner_2_id = v_loser_uids[1])
         )
       limit 1;
    end if;

    return query select
      1,
      v_winner_pair,
      coalesce(
        (select name from public.doubles_pairs where id = v_winner_pair),
        (select string_agg(p.full_name, ' & ' order by p.full_name)
           from public.profiles p where p.id = any(v_winner_uids))
      ),
      v_winner_uids,
      (select array_agg(p.full_name order by p.full_name)
         from public.profiles p where p.id = any(v_winner_uids)),
      floor(v_pool * v_structure[1] / 100.0)::int,
      floor(floor(v_pool * v_structure[1] / 100.0)
            / greatest(coalesce(array_length(v_winner_uids, 1), 0), 1))::int,
      0.500::numeric(6,3);

    if v_slots >= 2 then
      return query select
        2,
        v_loser_pair,
        coalesce(
          (select name from public.doubles_pairs where id = v_loser_pair),
          (select string_agg(p.full_name, ' & ' order by p.full_name)
             from public.profiles p where p.id = any(v_loser_uids))
        ),
        v_loser_uids,
        (select array_agg(p.full_name order by p.full_name)
           from public.profiles p where p.id = any(v_loser_uids)),
        floor(v_pool * v_structure[2] / 100.0)::int,
        floor(floor(v_pool * v_structure[2] / 100.0)
              / greatest(coalesce(array_length(v_loser_uids, 1), 0), 1))::int,
        0.250::numeric(6,3);
    end if;

    if v_slots >= 3 then
      if v_format = 'double_elimination' then
        select tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2, tm.winner_team
          into v_third
          from public.tournament_matches tm
          join public.tournament_rounds tr on tr.id = tm.round_id
         where tr.tournament_id = p_tournament_id
           and tr.round_type = 'losers'
           and tm.status = 'completed' and tm.winner_team in ('team1','team2')
         order by tr.round_number desc, tm.match_order desc
         limit 1;
        if v_third.winner_team is not null then
          return query select
            3, null::uuid,
            (select string_agg(p.full_name, ' & ' order by p.full_name) from public.profiles p
              where p.id = any(case when v_third.winner_team = 'team1'
                                    then array_remove(array[v_third.team2_player1, v_third.team2_player2], null)
                                    else array_remove(array[v_third.team1_player1, v_third.team1_player2], null) end)),
            case when v_third.winner_team = 'team1'
                 then array_remove(array[v_third.team2_player1, v_third.team2_player2], null)
                 else array_remove(array[v_third.team1_player1, v_third.team1_player2], null) end,
            (select array_agg(p.full_name order by p.full_name) from public.profiles p
              where p.id = any(case when v_third.winner_team = 'team1'
                                    then array_remove(array[v_third.team2_player1, v_third.team2_player2], null)
                                    else array_remove(array[v_third.team1_player1, v_third.team1_player2], null) end)),
            floor(v_pool * v_structure[3] / 100.0)::int,
            floor(floor(v_pool * v_structure[3] / 100.0)
                  / greatest(case when v_third.winner_team = 'team1'
                                  then coalesce(array_length(array_remove(array[v_third.team2_player1, v_third.team2_player2], null), 1), 0)
                                  else coalesce(array_length(array_remove(array[v_third.team1_player1, v_third.team1_player2], null), 1), 0) end, 1))::int,
            0.100::numeric(6,3);
        end if;
      else
        select count(*)::int into v_third_sides
          from public.tournament_matches tm
          join public.tournament_rounds tr on tr.id = tm.round_id
          join public.tournament_rounds fin on fin.tournament_id = tr.tournament_id and fin.round_type = 'finals'
         where tr.tournament_id = p_tournament_id
           and tr.round_type = 'winners' and tr.round_number = fin.round_number - 1
           and tm.status = 'completed' and tm.winner_team in ('team1','team2');
        if coalesce(v_third_sides, 0) > 0 then
          return query
            select 3, null::uuid,
                   (select string_agg(p.full_name, ' & ' order by p.full_name) from public.profiles p where p.id = any(l.uids)),
                   l.uids,
                   (select array_agg(p.full_name order by p.full_name) from public.profiles p where p.id = any(l.uids)),
                   floor(v_pool * v_structure[3] / 100.0 / v_third_sides)::int,
                   floor(floor(v_pool * v_structure[3] / 100.0 / v_third_sides)
                         / greatest(coalesce(array_length(l.uids, 1), 0), 1))::int,
                   0.100::numeric(6,3)
              from (
                select case when tm.winner_team = 'team1'
                            then array_remove(array[tm.team2_player1, tm.team2_player2], null)
                            else array_remove(array[tm.team1_player1, tm.team1_player2], null) end as uids
                  from public.tournament_matches tm
                  join public.tournament_rounds tr on tr.id = tm.round_id
                  join public.tournament_rounds fin on fin.tournament_id = tr.tournament_id and fin.round_type = 'finals'
                 where tr.tournament_id = p_tournament_id
                   and tr.round_type = 'winners' and tr.round_number = fin.round_number - 1
                   and tm.status = 'completed' and tm.winner_team in ('team1','team2')
              ) l
             where coalesce(array_length(l.uids, 1), 0) > 0;
        end if;
      end if;
    end if;

    return;
  end if;

  if v_format in ('round_robin', 'pool_play')
     and exists (select 1 from public.tournament_final_ranks fr where fr.tournament_id = p_tournament_id) then
    return query
      with all_places as (
        select fr.final_rank as place, array_agg(fr.user_id order by fr.user_id) as uids
          from public.tournament_final_ranks fr
         where fr.tournament_id = p_tournament_id
         group by fr.final_rank
      ),
      by_place as (
        -- Brian 2026-11-25 ("shared 3rd"): a place shared by k teams (k = its players / the champions' players) spans k prize slots
        select ap.place, ap.uids,
               (select coalesce(sum(v_structure[s]), 0) from generate_series(ap.place,
                  ap.span_end) s) as pct
          from (select a.*, least(v_slots, a.place - 1 + greatest(1, round(cardinality(a.uids)::numeric / greatest(1, (select cardinality(c.uids) from all_places c order by c.place limit 1))))::int) as span_end
            from all_places a) ap
   where ap.place <= v_slots
      )
      select bp.place::int,
             (select dp.id from public.doubles_pairs dp
               where dp.tournament_id = p_tournament_id
                 and array_length(bp.uids, 1) = 2
                 and ((dp.partner_1_id = bp.uids[1] and dp.partner_2_id = bp.uids[2])
                   or (dp.partner_1_id = bp.uids[2] and dp.partner_2_id = bp.uids[1]))
               limit 1) as team_id,
             (select string_agg(p.full_name, ' & ' order by p.full_name)
                from public.profiles p where p.id = any(bp.uids)) as team_name,
             bp.uids,
             (select array_agg(p.full_name order by p.full_name)
                from public.profiles p where p.id = any(bp.uids)) as user_names,
             floor(v_pool * bp.pct / 100.0)::int as pool_share,
             floor(floor(v_pool * bp.pct / 100.0)
                   / greatest(coalesce(array_length(bp.uids, 1), 0), 1))::int as share_per_user,
             case bp.place when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from by_place bp
       order by bp.place;
    return;
  end if;

  if v_format in ('round_robin', 'pool_play') and v_match_type = 'singles' then
    return query
      with stats as (
        select
          r.user_id as uid,
          count(*) filter (
            where m.status = 'completed'
              and ((m.team1_player1 = r.user_id and m.winner_team = 'team1')
                or (m.team2_player1 = r.user_id and m.winner_team = 'team2'))
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when m.team1_player1 = r.user_id then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when m.team2_player1 = r.user_id then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from public.tournament_registrations r
        left join public.tournament_matches m
          on m.tournament_id = r.tournament_id
         and (m.team1_player1 = r.user_id or m.team2_player1 = r.user_id)
        where r.tournament_id = p_tournament_id
          and r.status = 'approved'
        group by r.user_id
      ),
      ranked as (
        select s.uid, p.full_name,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(p.rating, 0) desc, p.id) as rn
          from stats s
          join public.profiles p on p.id = s.uid
      )
      select r.rn::int as place,
             null::uuid as team_id,
             r.full_name as team_name,
             array[r.uid]::uuid[] as uids,
             array[r.full_name]::text[] as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;

  if v_format in ('round_robin', 'pool_play') and v_match_type = 'doubles' then
    return query
      with pair_uids as (
        select dp.id as pair_id, dp.name, dp.captain_id,
               dp.partner_1_id, dp.partner_2_id,
               array_remove(array[dp.partner_1_id, dp.partner_2_id], null) as uids
          from public.doubles_pairs dp
         where dp.tournament_id = p_tournament_id
           and dp.partner_1_id is not null
           and dp.partner_2_id is not null
      ),
      stats as (
        select
          pu.pair_id, pu.name, pu.uids, pu.captain_id,
          count(*) filter (
            where m.status = 'completed' and (
              (m.winner_team = 'team1'
                and ((m.team1_player1 = pu.partner_1_id and m.team1_player2 = pu.partner_2_id)
                  or (m.team1_player1 = pu.partner_2_id and m.team1_player2 = pu.partner_1_id)))
              or
              (m.winner_team = 'team2'
                and ((m.team2_player1 = pu.partner_1_id and m.team2_player2 = pu.partner_2_id)
                  or (m.team2_player1 = pu.partner_2_id and m.team2_player2 = pu.partner_1_id)))
            )
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when (m.team1_player1 = pu.partner_1_id and m.team1_player2 = pu.partner_2_id)
                or (m.team1_player1 = pu.partner_2_id and m.team1_player2 = pu.partner_1_id)
                then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when (m.team2_player1 = pu.partner_1_id and m.team2_player2 = pu.partner_2_id)
                or (m.team2_player1 = pu.partner_2_id and m.team2_player2 = pu.partner_1_id)
                then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from pair_uids pu
        left join public.tournament_matches m
          on m.tournament_id = p_tournament_id
        group by pu.pair_id, pu.name, pu.uids, pu.captain_id, pu.partner_1_id, pu.partner_2_id
      ),
      ranked as (
        select s.pair_id, s.name, s.uids,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(cp.rating, 0) desc, s.pair_id) as rn
          from stats s
          left join public.profiles cp on cp.id = s.captain_id
      )
      select r.rn::int as place,
             r.pair_id as team_id,
             r.name as team_name,
             r.uids as uids,
             (select array_agg(p.full_name order by p.full_name)
                from public.profiles p where p.id = any(r.uids)) as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(floor(v_pool * v_structure[r.rn] / 100.0) / greatest(array_length(r.uids, 1), 1))::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;

  if v_format = 'rotating_partners' then
    if exists (select 1 from public.tournament_final_ranks fr where fr.tournament_id = p_tournament_id) then
      return query
        with all_places as (
          select fr.final_rank as place, array_agg(fr.user_id order by fr.user_id) as uids
            from public.tournament_final_ranks fr
           where fr.tournament_id = p_tournament_id
           group by fr.final_rank
        ),
        by_place as (
          -- Brian 2026-11-25 ("shared 3rd"): a place shared by k teams (k = its players / the champions' players) spans k prize slots
          select ap.place, ap.uids,
                 (select coalesce(sum(v_structure[s]), 0) from generate_series(ap.place,
                    ap.span_end) s) as pct
            from (select a.*, least(v_slots, a.place - 1 + greatest(1, round(cardinality(a.uids)::numeric / greatest(1, (select cardinality(c.uids) from all_places c order by c.place limit 1))))::int) as span_end
            from all_places a) ap
   where ap.place <= v_slots
        )
        select bp.place::int,
               null::uuid as team_id,
               (select string_agg(p.full_name, ' & ' order by p.full_name)
                  from public.profiles p where p.id = any(bp.uids)) as team_name,
               bp.uids,
               (select array_agg(p.full_name order by p.full_name)
                  from public.profiles p where p.id = any(bp.uids)) as user_names,
               floor(v_pool * bp.pct / 100.0)::int as pool_share,
               floor(floor(v_pool * bp.pct / 100.0)
                     / greatest(coalesce(array_length(bp.uids, 1), 0), 1))::int as share_per_user,
               case bp.place when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
          from by_place bp
         order by bp.place;
      return;
    end if;
    return query
      with stats as (
        select
          r.user_id as uid,
          count(*) filter (
            where m.status = 'completed' and (
              (m.winner_team = 'team1' and (m.team1_player1 = r.user_id or m.team1_player2 = r.user_id))
              or
              (m.winner_team = 'team2' and (m.team2_player1 = r.user_id or m.team2_player2 = r.user_id))
            )
          )::int as wins,
          coalesce(sum(
            case
              when m.status <> 'completed' then 0
              when m.team1_player1 = r.user_id or m.team1_player2 = r.user_id
                then coalesce(m.team1_score, 0) - coalesce(m.team2_score, 0)
              when m.team2_player1 = r.user_id or m.team2_player2 = r.user_id
                then coalesce(m.team2_score, 0) - coalesce(m.team1_score, 0)
              else 0
            end
          ), 0)::int as point_diff
        from public.tournament_registrations r
        left join public.tournament_matches m
          on m.tournament_id = r.tournament_id
         and (m.team1_player1 = r.user_id or m.team1_player2 = r.user_id
           or m.team2_player1 = r.user_id or m.team2_player2 = r.user_id)
        where r.tournament_id = p_tournament_id
          and r.status = 'approved'
        group by r.user_id
      ),
      ranked as (
        select s.uid, p.full_name,
               row_number() over (order by s.wins desc, s.point_diff desc, coalesce(p.rating, 0) desc, p.id) as rn
          from stats s
          join public.profiles p on p.id = s.uid
      )
      select r.rn::int as place,
             null::uuid as team_id,
             r.full_name as team_name,
             array[r.uid]::uuid[] as uids,
             array[r.full_name]::text[] as user_names,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as pool_share,
             floor(v_pool * v_structure[r.rn] / 100.0)::int as share_per_user,
             case r.rn when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from ranked r
       where r.rn <= v_slots
       order by r.rn;
    return;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public._pl_tournament_status_notices()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid;
  v_rank    integer;
  v_places  integer;
  v_rr      integer;
  v_pay     integer;
  v_staged  boolean;
  v_title   text;
begin
  if new.status is not distinct from old.status then return null; end if;
  begin
    -- Lock-in: everyone's first match.
    if new.status = 'active' then
      for v_uid in
        select tr.user_id from public.tournament_registrations tr
         where tr.tournament_id = new.id and tr.status = 'approved' and tr.user_id is not null
      loop
        perform public._pl_tm_ready_notice(new.id, v_uid, true);
      end loop;
    end if;

    -- Finished: final placement.
    if new.status = 'completed' then
      if not exists (select 1 from public.tournament_final_ranks where tournament_id = new.id) then
        perform public.compute_tournament_final_ranks(new.id);
      end if;
      select max(final_rank) into v_places from public.tournament_final_ranks where tournament_id = new.id;
      v_staged := new.format in ('round_robin', 'pool_play')
                  and exists (select 1 from public.tournament_rounds r
                               where r.tournament_id = new.id and r.round_type not in ('winners', 'pool'));
      for v_uid in
        select tr.user_id from public.tournament_registrations tr
         where tr.tournament_id = new.id and tr.status = 'approved' and tr.user_id is not null
      loop
        begin
          select fr.final_rank into v_rank from public.tournament_final_ranks fr
           where fr.tournament_id = new.id and fr.user_id = v_uid;
          v_pay := null;
          begin
            select g.paid into v_pay from public.tournament_placement_grants g
             where g.tournament_id = new.id and g.user_id = v_uid;
          exception when undefined_table then v_pay := null;
          end;
          v_rr := case when v_staged then public._pl_tm_rr_place(new.id, v_uid) end;
          v_title := case
            when v_rank = 1 then '🥇 You won ' || new.name || '!'
            when v_rank = 2 then '🥈 2nd place in ' || new.name
            when v_rank = 3 then '🥉 3rd place in ' || new.name
            when v_rank is not null then '🏁 ' || new.name || ': you finished ' || public._pl_ordinal(v_rank)
            else '🏁 ' || new.name || ' is finished' end;
          perform public._pl_tm_notice(
            v_uid, 'tm_finished', new.id, new.id, v_title,
            concat_ws(' ',
              case when v_rank is not null
                   then 'Final placement: ' || public._pl_ordinal(v_rank) || ' of ' || v_places || '.' end,
              case when v_rr is not null
                   then 'Round robin: ' || public._pl_ordinal(v_rr) || '.' end,
              case when coalesce(v_pay, 0) > 0 then '+' || v_pay || ' 🥒 placement pay.' end,
              'Open the tournament for the final table.'));
        exception when others then
          raise warning 'finish notice for % failed: %', v_uid, sqlerrm;
        end;
      end loop;
    end if;
  exception when others then
    raise warning 'tournament status notices failed for %: %', new.id, sqlerrm;
  end;
  return null;
end $function$;
