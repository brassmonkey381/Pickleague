-- migration_playoff_top2_third_place.sql — PKL-045: the playoff draw follows the 3rd-place setting.
--
-- generate_playoff_bracket always added a Third Place Match (RR #3 vs #4) to a
-- top_2 playoff, whatever tournaments.playoff_third_place said. Brian's rule 3
-- (2026-11-18): follow the setting. With only a Final, places 1-2 come from it
-- and places 3 and below from the round robin (compute_tournament_final_ranks
-- already does that when there is no 3PM).
--   1. generate_playoff_bracket: the live copy (checked 2026-11-18) plus the
--      playoff_third_place gate on the top_2 3PM. top_4 / top_8 unchanged
--      (their 3PM is added after the semifinals, already gated).
--   2. Tournaments created as top_2 before the app offered the switch for it
--      were promised "Final plus a Third Place Match" and stored false. Those
--      not yet drawn and not finished get playoff_third_place = true, so they
--      play what their page said.
-- Safe to re-run.

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
    wins_pairs as (
      select pool_letter, wins from with_seed group by pool_letter, wins having count(*) = 2
    ),
    pool_ranked_pairs as (
      select p.*, row_number() over (partition by p.pool_letter, p.wins order by p.rn) as rn_within
        from pre p
    ),
    ties_2 as (
      select w.pool_letter, w.wins, e1.lo as lo1, e1.hi as hi1, e2.lo as lo2, e2.hi as hi2
        from wins_pairs w
        join pool_ranked_pairs e1 on e1.pool_letter = w.pool_letter and e1.wins = w.wins and e1.rn_within = 1
        join pool_ranked_pairs e2 on e2.pool_letter = w.pool_letter and e2.wins = w.wins and e2.rn_within = 2
    ),
    h2h as (
      select t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2,
             coalesce(sum(case
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
               ) then 1 else 0 end)::int, 0) as h2h_wins_1,
             coalesce(sum(case
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
               ) then 1 else 0 end)::int, 0) as h2h_wins_2
        from ties_2 t left join pool_matches pm on pm.pool_letter = t.pool_letter
       group by t.pool_letter, t.wins, t.lo1, t.hi1, t.lo2, t.hi2
    ),
    h2h_per_entrant as (
      select p.pool_letter, p.lo, p.hi, p.wins, p.point_diff, p.seed,
             coalesce(case
               when h.h2h_wins_1 = h.h2h_wins_2 then 0
               when (p.lo = h.lo1 and p.hi = h.hi1) then
                 case when h.h2h_wins_1 > h.h2h_wins_2 then 1 else -1 end
               when (p.lo = h.lo2 and p.hi = h.hi2) then
                 case when h.h2h_wins_2 > h.h2h_wins_1 then 1 else -1 end
               else 0 end, 0) as h2h_score
        from pre p
        left join h2h h on h.pool_letter = p.pool_letter and h.wins = p.wins
                       and ((p.lo = h.lo1 and p.hi = h.hi1) or (p.lo = h.lo2 and p.hi = h.hi2))
    ),
    pool_ranked as (
      select pool_letter, lo, hi,
             row_number() over (partition by pool_letter order by wins desc, h2h_score desc, point_diff desc, seed asc) as pool_rank
        from h2h_per_entrant
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
           coalesce(sum(case
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
             ) then 1 else 0 end)::int, 0) as h2h_wins_1,
           coalesce(sum(case
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
             ) then 1 else 0 end)::int, 0) as h2h_wins_2
      from ties_2 t left join public.tournament_matches m
        on m.tournament_id = p_tournament_id and m.status = 'completed'
     group by t.wins, t.lo1, t.hi1, t.lo2, t.hi2
  ),
  h2h_per_entrant as (
    select p.lo, p.hi, p.wins, p.point_diff, p.seed,
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
  ranked as (
    select lo, hi,
           row_number() over (order by wins desc, h2h_score desc, point_diff desc, seed asc) as rn
      from h2h_per_entrant
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


-- 2. Keep what existing top_2 tournaments were promised.
update public.tournaments t
   set playoff_third_place = true
 where t.playoff_format = 'top_2'
   and t.format in ('round_robin', 'pool_play')
   and coalesce(t.playoff_third_place, false) = false
   and t.status <> 'completed'
   and not exists (select 1 from public.tournament_rounds r
                    where r.tournament_id = t.id
                      and r.round_type in ('quarterfinals', 'semifinals', 'finals', 'third_place_match'));

revoke execute on function public.generate_playoff_bracket(uuid) from public, anon;
grant execute on function public.generate_playoff_bracket(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
