-- generate_playoff_bracket(tournament_id)
-- Generates the first round of a non-MLP single-elim playoff bracket from
-- tournament_matches standings, gated by tournament.playoff_format:
--   'top_2'  → 1 Final + 1 Third Place Match (when at least 4 entrants)
--   'top_4'  → 2 Semifinals (no 3PM today; can be added when there's a UI toggle)
--   'top_8'  → 4 Quarterfinals
-- Standings: wins desc, point differential desc, registration seed asc.
-- Singles standings key on player_id; doubles standings key on the sorted
-- player pair.
--
-- This intentionally only inserts the FIRST playoff round. Subsequent
-- rounds are populated as matches complete (handled by the existing
-- TournamentDetailScreen logic or by a future advancement trigger).

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
  ranked as (
    select lo, hi,
           row_number() over (order by wins desc, point_diff desc, seed asc) as rn
      from with_seed
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

  -- Third Place Match for Top 2 (standings #3 vs #4)
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
