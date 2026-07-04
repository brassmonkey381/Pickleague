-- Unify tournament rankings on the canonical tiebreaker chain.
--
-- Before this migration THREE different chains decided "who finished where":
--   - client standings + playoff seeding:  wins → 2-way head-to-head →
--     point differential → registration seed  (the documented canonical
--     chain, mirrored in mobile/src/lib/tournamentTiebreakers.ts)
--   - compute_tournament_final_ranks (settles wagers, feeds displays):
--     wins → fewest losses → profile rating — no point diff, no H2H, no
--     seed. Doubles worse still: the champion pin looked up ONE badge row
--     (limit 1), so one champion partner got rank 1 and the other floated
--     on the generic sort — a wager on the floating partner "finishing #1"
--     LOST even though their team won the tournament (settlement compares
--     ranks exactly).
--   - preview_tournament_payout (RR/pool): wins → point diff → rating.
--
-- Now:
--   1. For fixed-team formats (round_robin / pool_play / single_elimination
--      / double_elimination) final ranks are computed per TEAM with the
--      canonical chain — champion-badge team pinned first, then wins desc,
--      2-way H2H, point diff desc, seed asc — and BOTH partners carry the
--      team's rank (rank = team position: champions 1, runners-up 2, …).
--      MLP and rotating_partners keep the per-user path (lineups change
--      per match, so "team" isn't well defined there).
--   2. preview_tournament_payout's RR/pool branches read the STORED final
--      ranks when they exist (grouping shared ranks into podium places, so
--      a doubles pair splits its place's share), falling back to the local
--      derivation only pre-completion — same pattern rotating_partners
--      already uses.

create or replace function public.compute_tournament_final_ranks(p_tournament_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_rows   int;
  v_format text;
begin
  select format into v_format from tournaments where id = p_tournament_id;
  delete from tournament_final_ranks where tournament_id = p_tournament_id;

  if v_format in ('round_robin', 'pool_play', 'single_elimination', 'double_elimination') then
    -- ── Team-canonical path ────────────────────────────────────────────
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
      -- Last completed finals / grand-final match (bracket formats only) —
      -- its loser is pinned to 2nd place, because raw win counts misorder
      -- elimination podiums (a losers-bracket run can out-win the GF loser).
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
    -- Ranks are computed AT completion, before payout awards champion
    -- badges — so the champion pin must come from the grand-final WINNER
    -- itself. (In double elim a losers-bracket run can out-WIN the GF
    -- winner on raw count; without this pin the champion could rank 2nd.)
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
    -- Approved entrants who never appear in a completed match still get a
    -- trailing rank (by seed) so wagers on them settle instead of hanging.
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

  -- ── Per-user path (MLP / rotating partners — lineups change per match) ──
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
    select user_id from tournament_champion_badges
     where tournament_id = p_tournament_id
     limit 1
  ),
  with_champion as (
    select r.user_id, r.wins, r.losses,
      case
        when (select user_id from champion_row) is null then r.rk
        when r.user_id = (select user_id from champion_row) then 1
        when r.rk = 1 then 2
        else r.rk
      end as rk
    from ranked r
  )
  insert into tournament_final_ranks (tournament_id, user_id, final_rank, wins, losses)
  select p_tournament_id, user_id, rk, wins, losses
    from with_champion;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- == payout reads the stored ranks for RR / pool play ==
-- (body copied from migration_fix_elim_third_place_columns with the
--  final-ranks-first branch inserted before the local RR/pool derivations)
create or replace function public.preview_tournament_payout(p_tournament_id uuid)
returns table (
  place           integer,
  team_id         uuid,
  team_name       text,
  uids            uuid[],
  user_names      text[],
  pool_share      integer,
  share_per_user  integer,
  plupr_bonus     numeric(6,3)
)
language plpgsql stable security definer as $$
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

  -- ── MLP delegates to its dedicated RPC ────────────────────────
  if v_format in ('mlp', 'mlp_random') then
    return query
      select p.place, p.team_id, p.team_name, p.uids, p.user_names,
             p.pool_share, p.share_per_user, p.plupr_bonus
        from public.preview_mlp_tournament_payout(p_tournament_id) p;
    return;
  end if;

  -- ── Single / double elimination — finals / grand_final winner ─
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

    -- 3rd place. Previously undistributed for elimination formats, silently
    -- stranding that share of the pot. Double elim: the loser of the last
    -- losers-bracket match is an unambiguous #3. Single elim: the two
    -- semifinal losers tie for 3rd and SPLIT its share.
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
        -- single elim: losers of the round directly below the finals round
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

  -- ── Round robin / pool play — STORED final ranks first ────────
  -- The podium must match tournament_final_ranks (canonical chain, settles
  -- wagers, drives displays). Shared team ranks group into places so a
  -- doubles pair splits its place's share. The local derivations below
  -- remain only as the pre-completion fallback.
  if v_format in ('round_robin', 'pool_play')
     and exists (select 1 from public.tournament_final_ranks fr where fr.tournament_id = p_tournament_id) then
    return query
      with by_place as (
        select fr.final_rank as place, array_agg(fr.user_id order by fr.user_id) as uids
          from public.tournament_final_ranks fr
         where fr.tournament_id = p_tournament_id and fr.final_rank <= v_slots
         group by fr.final_rank
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
             floor(v_pool * v_structure[bp.place] / 100.0)::int as pool_share,
             floor(floor(v_pool * v_structure[bp.place] / 100.0)
                   / greatest(coalesce(array_length(bp.uids, 1), 0), 1))::int as share_per_user,
             case bp.place when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
        from by_place bp
       order by bp.place;
    return;
  end if;

  -- ── Round robin / pool play (singles) ─────────────────────────
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

  -- ── Round robin / pool play (doubles) ─────────────────────────
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

  -- ── Rotating partners: per-individual wins ────────────────────
  if v_format = 'rotating_partners' then
    -- The podium must match the STORED final standings (tournament_final_ranks
    -- is computed at completion, settles wagers, and is what the app shows).
    -- Re-deriving here with different tiebreakers (point_diff vs losses)
    -- crowned the wrong champion whenever wins tied. Fall back to the local
    -- stats only when final ranks are missing.
    if exists (select 1 from public.tournament_final_ranks fr where fr.tournament_id = p_tournament_id) then
      return query
        select fr.final_rank::int as place,
               null::uuid as team_id,
               p.full_name as team_name,
               array[fr.user_id]::uuid[] as uids,
               array[p.full_name]::text[] as user_names,
               floor(v_pool * v_structure[fr.final_rank] / 100.0)::int as pool_share,
               floor(v_pool * v_structure[fr.final_rank] / 100.0)::int as share_per_user,
               case fr.final_rank when 1 then 0.500 when 2 then 0.250 when 3 then 0.100 else 0 end::numeric(6,3) as plupr_bonus
          from public.tournament_final_ranks fr
          join public.profiles p on p.id = fr.user_id
         where fr.tournament_id = p_tournament_id
           and fr.final_rank <= v_slots
         order by fr.final_rank;
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
$$;
