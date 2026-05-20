-- migration_playoff_tiebreaker_and_3pm.sql
--
-- Two related enhancements to the non-MLP playoff system:
--
-- 5. Head-to-head tiebreaker — insert head-to-head between wins and
--    point_diff in generate_playoff_bracket. When EXACTLY two entrants
--    are tied on wins, the winner of their head-to-head match is seeded
--    higher. With 3+ tied entrants, H2H is skipped (per standard
--    pickleball tiebreak chain; see docs/tournament-formats/seeding-and-tiebreakers.md).
--
-- 6. Third Place Match toggle for Top 4 / Top 8 — adds the
--    `tournaments.playoff_third_place` boolean. When true and
--    playoff_format ∈ ('top_4', 'top_8'), the advancement trigger
--    creates a Third Place Match between the two losing semifinalists
--    once both Semifinals complete. The Top 2 3PM (standings #3 vs #4
--    generated at bracket-gen time) is unchanged.

-- ── 1) Schema change ──────────────────────────────────────────────
alter table public.tournaments
  add column if not exists playoff_third_place boolean not null default false;

comment on column public.tournaments.playoff_third_place is
  'When true AND playoff_format in (top_4, top_8), generate a third place match between losing semifinalists.';


-- ── 2) Redefine generate_playoff_bracket with H2H tiebreaker ──────
create or replace function public.generate_playoff_bracket(p_tournament_id uuid)
returns integer language plpgsql security definer as $$
declare
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
  v_a              uuid[];
  v_b              uuid[];
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

  v_playoff_n := case v_playoff
    when 'top_2' then 2
    when 'top_4' then 4
    when 'top_8' then 8
    else null
  end;
  if v_playoff_n is null then
    raise exception 'Unknown playoff_format %', v_playoff;
  end if;

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

  -- Compute standings. Each completed match contributes one row to each side.
  -- Team key = (lo_player, hi_player) for doubles, (player, null) for singles.
  --
  -- Tiebreaker chain (for non-MLP RR / pool-play seeding):
  --   1. wins desc
  --   2. head-to-head (ONLY when exactly 2 entrants are tied on wins)
  --   3. point_diff desc
  --   4. registration seed asc
  --
  -- The H2H step is implemented as a window-partitioned correction:
  -- after the (wins, point_diff, seed) ordering, for any pair of entrants
  -- tied on wins where exactly 2 entrants share that wins count AND they
  -- played each other to a decisive result, swap them so the H2H winner
  -- comes first.
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
  -- Pre-H2H ordering by (wins desc, point_diff desc, seed asc).
  pre as (
    select lo, hi, wins, losses, point_diff, seed,
           row_number() over (order by wins desc, point_diff desc, seed asc) as rn
      from with_seed
  ),
  -- Identify wins-buckets containing exactly 2 entrants. Those are the
  -- only places where H2H is decisive.
  wins_pairs as (
    select wins
      from with_seed
     group by wins
    having count(*) = 2
  ),
  -- For each 2-entrant tie, fetch the two entrants ordered by current rn.
  ties_2 as (
    select w.wins,
           min(case when sub.rn_within = 1 then sub.lo end) as lo1,
           min(case when sub.rn_within = 1 then sub.hi end) as hi1,
           min(case when sub.rn_within = 2 then sub.lo end) as lo2,
           min(case when sub.rn_within = 2 then sub.hi end) as hi2
      from wins_pairs w
      join (
        select p.*,
               row_number() over (partition by p.wins order by p.rn) as rn_within
          from pre p
      ) sub on sub.wins = w.wins
     group by w.wins
  ),
  -- Compute head-to-head wins between the two entrants in each 2-entrant tie.
  h2h as (
    select t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
           coalesce(sum(
             case
               -- entrant 1 (lo1,hi1) won against entrant 2 (lo2,hi2)
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
  -- For each 2-tied entrant compute a per-row H2H score: +1 if this entrant
  -- won the head-to-head, -1 if lost, 0 if tied (e.g., didn't play, or split).
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

  -- Build the bracket: standard 1vN, 2v(N-1) seeding
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

    -- a[1] and a[2] are equal for singles (lo = hi when team1_player2 is null)
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

  -- Third Place Match for Top 2 (standings #3 vs #4) — unchanged.
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


-- ── 3) Update _advance_non_mlp_playoff_bracket to insert 3PM ──────
-- When semifinals complete AND tournament.playoff_third_place is true AND
-- playoff_format ∈ ('top_4','top_8'), insert a third_place_match round
-- pairing the two losing semifinalists. Done after the Final is created.
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

  -- ── Third Place Match (top_4 / top_8) ─────────────────────────
  -- When the just-completed round is semifinals AND the tournament has
  -- playoff_third_place enabled AND playoff_format ∈ (top_4, top_8), and
  -- exactly 2 semifinal matches with decisive results exist, insert a
  -- third_place_match round between the two losing semifinalists.
  if v_round_type = 'semifinals'
     and v_playoff_3pm
     and v_playoff_format in ('top_4', 'top_8')
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
          -- losing side of v_l1
          case when v_l1.winner_team = 'team1' then v_l1.team2_player1 else v_l1.team1_player1 end,
          case when v_l1.winner_team = 'team1' then v_l1.team2_player2 else v_l1.team1_player2 end,
          -- losing side of v_l2
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
