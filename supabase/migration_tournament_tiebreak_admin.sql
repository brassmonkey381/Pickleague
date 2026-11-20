-- migration_tournament_tiebreak_admin.sql: PKL-052. No head-to-head anywhere.
--
-- Brian, 2026-11-19: "lets NEVER use HEAD-to-HEAD at all anywhere in the app
-- for scoring and tiebreaking. Lets just go by W-L and Point Differential. Any
-- ties after that are handled manually by an admin."
--
-- Every ranking, seeding and placement path now orders by:
--   wins desc, losses asc, point differential desc, the admin's tie order,
--   then seed (only so an unset tie stays deterministic; the app shows it as
--   "waiting for the admin").
-- Changed: _pl_tournament_group_order (round robin / pool standings and the
-- staged placement), compute_tournament_final_ranks (bracket placement and
-- every per-player format: rotating partners and MLP lose head-to-head and
-- the PLUPR fallback), generate_playoff_bracket (pool and round robin seeding).
-- New: tournament_tie_orders + set_tournament_tie_order (admin only).
-- Entrant key: '<lo>:<hi>', the smaller and larger player uuid of a team; one
-- player is '<id>:<id>'. The app builds the same key.
-- Safe to re-run.

create table if not exists public.tournament_tie_orders (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  entrant_key   text not null check (entrant_key ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$'),
  tie_rank      integer not null check (tie_rank > 0),
  set_by        uuid references public.profiles (id) on delete set null,
  set_at        timestamptz not null default now(),
  primary key (tournament_id, entrant_key)
);
alter table public.tournament_tie_orders enable row level security;
drop policy if exists tournament_tie_orders_read on public.tournament_tie_orders;
-- Readable wherever the tournament is (the subquery runs under the reader's RLS).
create policy tournament_tie_orders_read on public.tournament_tie_orders
  for select to authenticated, anon
  using (exists (select 1 from public.tournaments t where t.id = tournament_tie_orders.tournament_id));
-- No insert/update/delete policies: writes go through set_tournament_tie_order.
grant select on public.tournament_tie_orders to authenticated, anon;

create or replace function public._pl_tie_rank(p_tournament_id uuid, p_lo uuid, p_hi uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select o.tie_rank from public.tournament_tie_orders o
   where o.tournament_id = p_tournament_id
     and o.entrant_key = least(p_lo, coalesce(p_hi, p_lo))::text || ':' || greatest(p_lo, coalesce(p_hi, p_lo))::text
$$;
revoke execute on function public._pl_tie_rank(uuid, uuid, uuid) from public, anon, authenticated;

-- The admin orders entrants still level on wins, losses and point diff:
-- p_entrant_keys first to last. Re-ranks a completed tournament.
create or replace function public.set_tournament_tie_order(p_tournament_id uuid, p_entrant_keys text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_key text;
  v_i int := 0;
begin
  -- Same people who can create the playoff (generate_playoff_bracket): the
  -- host or a league admin, a tournament admin / co-admin, or godmode.
  if v_uid is null or not (
    public._is_tournament_admin(p_tournament_id, v_uid)
    or exists (
      select 1 from public.tournament_registrations r
       where r.tournament_id = p_tournament_id and r.user_id = v_uid
         and r.status = 'approved' and r.role in ('admin', 'co-admin'))
    or coalesce(public.is_godmode_user(), false)
  ) then
    raise exception 'PL_TIE_NOT_ADMIN: only a tournament admin can set the tie order';
  end if;
  if p_entrant_keys is null or cardinality(p_entrant_keys) < 2 then
    raise exception 'PL_TIE_KEYS: give at least two entrants, first to last';
  end if;
  if cardinality(p_entrant_keys) <> (select count(distinct k) from unnest(p_entrant_keys) k) then
    raise exception 'PL_TIE_KEYS: an entrant is listed twice';
  end if;
  select status into v_status from public.tournaments where id = p_tournament_id;
  foreach v_key in array p_entrant_keys loop
    v_i := v_i + 1;
    insert into public.tournament_tie_orders (tournament_id, entrant_key, tie_rank, set_by, set_at)
    values (p_tournament_id, lower(v_key), v_i, v_uid, now())
    on conflict (tournament_id, entrant_key)
      do update set tie_rank = excluded.tie_rank, set_by = excluded.set_by, set_at = excluded.set_at;
  end loop;
  if v_status = 'completed' then
    perform public.compute_tournament_final_ranks(p_tournament_id);
  end if;
end $$;
revoke execute on function public.set_tournament_tie_order(uuid, text[]) from public, anon;
grant execute on function public.set_tournament_tie_order(uuid, text[]) to authenticated;

CREATE OR REPLACE FUNCTION public._pl_tournament_group_order(p_tournament_id uuid)
 RETURNS TABLE(lo uuid, hi uuid, wins integer, losses integer, point_diff integer, seed integer, rr_rank integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  )
  select s.lo, s.hi, s.wins, s.losses, s.point_diff, s.seed,
         (row_number() over (order by s.wins desc, s.losses asc, s.point_diff desc,
                                      coalesce(public._pl_tie_rank(p_tournament_id, s.lo, s.hi), 2147483647),
                                      s.seed asc, s.lo asc, s.hi asc))::int as rr_rank
    from seeded s
$function$;

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

CREATE OR REPLACE FUNCTION public.generate_playoff_bracket(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid            uuid := auth.uid();
  v_format         text;
  v_match_type     text;
  v_playoff        text;
  v_playoff_n      integer;
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
  v_per_pool_n     integer;
  v_pairings       integer[][];
  v_padded_size    integer;
  v_third          boolean;
begin
  -- Admins only (migration_anon_audit_fixes.sql): anyone, signed out
  -- included, could draw any tournament's playoff. The service role (sims,
  -- scripts) passes; nothing in the database calls this.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_uid is null then
      raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.',
                            hint = 'pl:auth.signed_out';
    end if;
    if not (
      public._is_tournament_admin(p_tournament_id, v_uid)
      or exists (
        select 1 from public.tournament_registrations r
         where r.tournament_id = p_tournament_id
           and r.user_id = v_uid
           and r.status = 'approved'
           and r.role in ('admin', 'co-admin')
      )
      or coalesce(public.is_godmode_user(), false)
    ) then
      raise exception 'Only tournament admins can generate the playoff';
    end if;
  end if;

  select format, match_type, coalesce(playoff_format, 'none'), coalesce(playoff_third_place, false)
    into v_format, v_match_type, v_playoff, v_third
    from public.tournaments where id = p_tournament_id;

  if v_format is null then raise exception 'Tournament % not found', p_tournament_id; end if;
  if v_playoff = 'none' then raise exception 'Tournament has no playoff configured (playoff_format=none)'; end if;
  if v_format not in ('round_robin', 'pool_play') then
    raise exception 'Playoff generation supported for round_robin / pool_play only, not %', v_format;
  end if;

  if v_playoff in ('top_1_per_pool', 'top_2_per_pool') and v_format <> 'pool_play' then
    raise exception 'Playoff format % requires format=pool_play, not %', v_playoff, v_format;
  end if;

  v_per_pool_n := case v_playoff
    when 'top_1_per_pool' then 1
    when 'top_2_per_pool' then 2
    else null
  end;

  if exists (
    select 1 from public.tournament_rounds
     where tournament_id = p_tournament_id
       and round_type in ('quarterfinals','semifinals','finals','third_place_match')
  ) then
    raise exception 'Playoff already generated.';
  end if;

  select count(*) into v_uncompleted
    from public.tournament_matches tm
    join public.tournament_rounds tr on tr.id = tm.round_id
   where tm.tournament_id = p_tournament_id
     and tr.round_type not in ('quarterfinals','semifinals','finals','third_place_match','consolation','losers')
     and tm.status <> 'completed';
  if v_uncompleted > 0 then
    raise exception 'Cannot advance — % group-play matches still pending', v_uncompleted;
  end if;

  if v_per_pool_n is not null then
    select count(distinct upper(substring(tr.label from 'Pool ([A-Z])')))::int
      into v_pool_count
      from public.tournament_rounds tr
     where tr.tournament_id = p_tournament_id and tr.label ~ '^Pool [A-Z]';
    if v_pool_count is null or v_pool_count < 2 then
      raise exception 'top_N_per_pool requires at least 2 labelled pool rounds (found %)', coalesce(v_pool_count, 0);
    end if;

    v_bracket_size := v_pool_count * v_per_pool_n;
    if v_bracket_size not in (2, 4, 6, 8) then
      raise exception
        'top_%_per_pool with % pools yields % entrants — supported sizes are 2/4/6/8. Pick top_2/top_4/top_8 instead.',
        v_per_pool_n, v_pool_count, v_bracket_size;
    end if;

    with pool_matches as (
      select tm.*, upper(substring(tr.label from 'Pool ([A-Z])')) as pool_letter
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
             sum(wins)::int as wins, sum(losses)::int as losses,
             sum(pf)::int - sum(pa)::int as point_diff
        from raw group by pool_letter, lo, hi
    ),
    with_seed as (
      select a.pool_letter, a.lo, a.hi, a.wins, a.losses, a.point_diff,
             coalesce((
               select min(tr.seed) from public.tournament_registrations tr
                where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)
             ), 999) as seed
        from agg a
    ),
    pre as (
      select pool_letter, lo, hi, wins, losses, point_diff, seed,
             row_number() over (partition by pool_letter order by wins desc, point_diff desc, seed asc) as rn
        from with_seed
    ),
    pool_ranked as (
      -- PKL-052: wins, fewer losses, point diff, then the admin's tie order.
      select pool_letter, lo, hi,
             row_number() over (partition by pool_letter order by wins desc, losses asc, point_diff desc,
                                coalesce(public._pl_tie_rank(p_tournament_id, lo, hi), 2147483647), seed asc, lo, hi) as pool_rank
        from pre
    )
    select array_agg(array[lo, coalesce(hi, lo)] order by pool_rank, ascii(pool_letter))
      into v_seeds from pool_ranked where pool_rank <= v_per_pool_n;

    if v_seeds is null or array_length(v_seeds, 1) < v_bracket_size then
      raise exception
        'Not enough entrants in pool standings to seed top % per pool across % pools (need %, got %)',
        v_per_pool_n, v_pool_count, v_bracket_size, coalesce(array_length(v_seeds, 1), 0);
    end if;

    if v_bracket_size = 2 then
      v_pairings := array[ array[1, 2] ]; v_padded_size := 2;
    elsif v_bracket_size = 4 and v_pool_count = 2 then
      v_pairings := array[ array[1, 4], array[2, 3] ]; v_padded_size := 4;
    elsif v_bracket_size = 4 and v_pool_count = 4 then
      v_pairings := array[ array[1, 4], array[2, 3] ]; v_padded_size := 4;
    elsif v_bracket_size = 6 and v_pool_count = 3 then
      -- P=3, N=2: snake [A1, B1, C1, A2, B2, C2]. Apply doc §3 slot-5/slot-6
      -- swap to avoid C1 vs C2 round 1: pairs are 3v5 (C1 vs B2) and 4v6
      -- (A2 vs C2). Match orders: 0=A1-BYE, 1=B1-BYE, 2=C1 vs B2, 3=A2 vs C2.
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 5], array[4, 6] ]; v_padded_size := 8;
    elsif v_bracket_size = 6 and v_pool_count = 6 then
      -- P=6, N=1: snake [A1..F1]. No same-pool conflicts.
      v_pairings := array[ array[1, 0], array[2, 0], array[3, 6], array[4, 5] ]; v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 4 then
      v_pairings := array[ array[1, 8], array[4, 6], array[2, 7], array[3, 5] ]; v_padded_size := 8;
    elsif v_bracket_size = 8 and v_pool_count = 2 then
      v_pairings := array[ array[1, 8], array[4, 5], array[2, 7], array[3, 6] ]; v_padded_size := 8;
    else
      raise exception 'Unsupported top_N_per_pool bracket shape (pools=%, N=%)', v_pool_count, v_per_pool_n;
    end if;

    v_round_label := case v_padded_size when 8 then 'Quarterfinals' when 4 then 'Semifinals' when 2 then 'Finals' end;
    v_round_type  := case v_padded_size when 8 then 'quarterfinals' when 4 then 'semifinals' when 2 then 'finals' end;

    insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
      values (p_tournament_id, 1000, v_round_label, v_round_type)
      returning id into v_round_id;

    -- Two-pass insert to keep the trigger from prematurely advancing. See
    -- comments in the migration source.
    declare
      v_a1 uuid; v_a2 uuid; v_b1 uuid; v_b2 uuid;
      v_pass integer;
      v_is_bye boolean;
    begin
      for v_pass in 1..2 loop
        for v_i in 1..array_length(v_pairings, 1) loop
          v_is_bye := v_pairings[v_i][2] = 0;
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

    return v_matches;
  end if;

  v_playoff_n := case v_playoff when 'top_2' then 2 when 'top_4' then 4 when 'top_8' then 8 else null end;
  if v_playoff_n is null then raise exception 'Unknown playoff_format %', v_playoff; end if;

  with raw as (
    select
      least(team1_player1, coalesce(team1_player2, team1_player1))             as lo,
      greatest(team1_player1, coalesce(team1_player2, team1_player1))          as hi,
      coalesce(team1_score, 0) as pf, coalesce(team2_score, 0) as pa,
      case when winner_team = 'team1' then 1 else 0 end as wins,
      case when winner_team = 'team2' then 1 else 0 end as losses
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
    select lo, hi, sum(wins)::int as wins, sum(losses)::int as losses,
           sum(pf)::int - sum(pa)::int as point_diff
      from raw group by lo, hi
  ),
  with_seed as (
    select a.lo, a.hi, a.wins, a.losses, a.point_diff,
           coalesce((select min(tr.seed) from public.tournament_registrations tr
                      where tr.tournament_id = p_tournament_id and tr.user_id in (a.lo, a.hi)), 999) as seed
      from agg a
  ),
  pre as (
    select lo, hi, wins, losses, point_diff, seed,
           row_number() over (order by wins desc, point_diff desc, seed asc) as rn
      from with_seed
  ),
  ranked as (
    -- PKL-052: wins, fewer losses, point diff, then the admin's tie order.
    select lo, hi,
           row_number() over (order by wins desc, losses asc, point_diff desc,
                              coalesce(public._pl_tie_rank(p_tournament_id, lo, hi), 2147483647), seed asc, lo, hi) as rn
      from pre
  )
  select array_agg(array[lo, coalesce(hi, lo)] order by rn)
    into v_seeds from ranked where rn <= greatest(v_playoff_n, 4);

  if v_seeds is null or array_length(v_seeds, 1) < v_playoff_n then
    raise exception 'Not enough entrants in standings to seed Top % (got %)',
      v_playoff_n, coalesce(array_length(v_seeds, 1), 0);
  end if;

  v_round_label := case v_playoff_n
    when 8 then 'Quarterfinals' when 4 then 'Semifinals' when 2 then 'Finals'
    else format('Playoff Round of %s', v_playoff_n) end;
  v_round_type := case v_playoff_n
    when 8 then 'quarterfinals' when 4 then 'semifinals' when 2 then 'finals'
    else 'winners' end;

  insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
    values (p_tournament_id, 1000, v_round_label, v_round_type)
    returning id into v_round_id;

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
        team1_player1, team1_player2, team2_player1, team2_player2, status
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

    -- The 3rd-place setting decides (PKL-045, Brian's rule 3). Off: only the
    -- Final; places 3 and below follow the round robin.
    if v_playoff_n = 2 and v_third and array_length(v_seeds, 1) >= 4 then
      insert into public.tournament_rounds (tournament_id, round_number, label, round_type)
        values (p_tournament_id, 1100, 'Third Place Match', 'third_place_match')
        returning id into v_round_id;

      v_a1 := v_seeds[3][1]; v_a2 := v_seeds[3][2];
      v_b1 := v_seeds[4][1]; v_b2 := v_seeds[4][2];
      insert into public.tournament_matches (
        tournament_id, round_id, match_order, match_type,
        team1_player1, team1_player2, team2_player1, team2_player2, status
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
$function$;

