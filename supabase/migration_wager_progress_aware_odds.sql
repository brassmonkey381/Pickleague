-- Progress-aware wager odds.
--
-- The rating-aware fix (migration_wager_rating_aware_rank_odds) priced rank
-- markets by rating + field size, but as-if the tournament had just started:
-- it ignored eliminations, standings, and match status. So an eliminated
-- player was still quoted as the favourite, surviving players got
-- start-of-event odds even as the field narrowed (underpriced late), and a
-- bet could be placed on an already-decided match.
--
-- This migration makes quoting track live state:
--   1. Rank markets drop competitors who can no longer finish #1 (single-elim
--      losers, double-elim two-time losers, non-qualifiers once a playoff
--      bracket exists) and renormalize among who's still alive.
--   2. A standings prior nudges each survivor's effective rating by their net
--      wins so far (a 4-0 player is likelier to win than rating alone says).
--      It is ZERO at tournament start (everyone 0-0), so start-of-event odds
--      and the earlier beta calibration are unchanged.
--   3. place_wager closes the market on a decided match / ended tournament.

-- ── per-user W/L from completed tournament matches ──────────────────────
create or replace function public._wager_tournament_winloss(p_tournament_id uuid)
returns table(user_id uuid, wins int, losses int)
language sql stable security definer set search_path = public as $$
  with decisive as (
    select tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2, tm.winner_team
      from public.tournament_matches tm
     where tm.tournament_id = p_tournament_id
       and tm.status = 'completed'
       and tm.winner_team in ('team1','team2')
       and coalesce(tm.match_type, 'singles') <> 'bye'
  ),
  per as (
    select unnest(array_remove(array[team1_player1, team1_player2], null)) as uid,
           (winner_team = 'team1') as won from decisive
    union all
    select unnest(array_remove(array[team2_player1, team2_player2], null)),
           (winner_team = 'team2') from decisive
  )
  select uid, count(*) filter (where won)::int, count(*) filter (where not won)::int
    from per group by uid;
$$;
revoke execute on function public._wager_tournament_winloss(uuid) from public, anon, authenticated;

-- ── eligible field: who can still finish #1, their rating & net wins ─────
create or replace function public._wager_eligible_field(p_tournament_id uuid)
returns table(user_id uuid, rating numeric, net int, eligible boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  v_format      text;
  v_has_playoff boolean;
  v_field_size  int;
  v_max_wins    int;
begin
  select t.format into v_format from public.tournaments t where t.id = p_tournament_id;
  select exists(
    select 1 from public.tournament_rounds tr
     where tr.tournament_id = p_tournament_id
       and tr.round_type in ('quarterfinals','semifinals','finals')
  ) into v_has_playoff;

  -- Round-robin elimination bound: a player is out of #1 contention once they
  -- can't reach the current leader's win total even by winning every remaining
  -- game. In a single round robin each player plays (field-1) games, so their
  -- max achievable wins is (field-1 - losses).
  select count(*) into v_field_size
    from public.tournament_registrations tr
   where tr.tournament_id = p_tournament_id and tr.status = 'approved';
  select coalesce(max(wins), 0) into v_max_wins
    from public._wager_tournament_winloss(p_tournament_id);

  return query
  with wl as (select * from public._wager_tournament_winloss(p_tournament_id)),
  pm as (
    select tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2, tm.winner_team, tm.status
      from public.tournament_matches tm
      join public.tournament_rounds tr on tr.id = tm.round_id
     where tm.tournament_id = p_tournament_id
       and tr.round_type in ('quarterfinals','semifinals','finals')
  ),
  plost as (
    select unnest(array_remove(array[
             case when winner_team = 'team1' then team2_player1 else team1_player1 end,
             case when winner_team = 'team1' then team2_player2 else team1_player2 end], null)) as uid
      from pm where status = 'completed' and winner_team in ('team1','team2')
  ),
  pin as (
    select unnest(array_remove(array[team1_player1, team1_player2, team2_player1, team2_player2], null)) as uid
      from pm
  ),
  palive as (
    select distinct uid from pin where uid not in (select uid from plost)
  )
  select tr.user_id,
         coalesce(p.rating, 3.5)::numeric,
         (coalesce(w.wins, 0) - coalesce(w.losses, 0))::int,
         case v_format
           when 'single_elimination' then coalesce(w.losses, 0) = 0
           when 'double_elimination' then coalesce(w.losses, 0) < 2
           when 'round_robin' then
             case when v_has_playoff then tr.user_id in (select uid from palive)
                  else ((v_field_size - 1) - coalesce(w.losses, 0)) >= v_max_wins end
           when 'pool_play'   then (not v_has_playoff) or tr.user_id in (select uid from palive)
           else true
         end
    from public.tournament_registrations tr
    join public.profiles p on p.id = tr.user_id
    left join wl w on w.user_id = tr.user_id
   where tr.tournament_id = p_tournament_id and tr.status = 'approved';
end;
$$;
revoke execute on function public._wager_eligible_field(uuid) from public, anon, authenticated;

-- ── calculate_wager_odds — rank branch now progress-aware ───────────────
create or replace function public.calculate_wager_odds(p_subject_type text, p_subject_id uuid, p_predicate jsonb)
returns table(probability numeric, odds numeric)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_house_edge   numeric := 0.05;
  v_stand_coef   numeric := 0.50;   -- effective-rating bump per net win (mid-event only)
  v_prob         numeric;
  v_avg1         numeric;
  v_avg2         numeric;
  v_p1           numeric;
  v_picked       text;
  v_user_id      uuid;
  v_rank         int;
  v_score1       int;
  v_score2       int;
  v_density      numeric;
  v_winner_team  text;
  v_league_id    uuid;
  v_format       text;
  v_beta         numeric;
  v_weights      numeric[];
  v_target_idx   int;
  v_n            int;
begin
  if p_subject_type in ('match','match_score') then
    select
      ( coalesce(p1.rating, 3.5) + coalesce(prt.rating, coalesce(p1.rating, 3.5)) ) / 2.0,
      ( coalesce(p2.rating, 3.5) + coalesce(prt2.rating, coalesce(p2.rating, 3.5)) ) / 2.0
      into v_avg1, v_avg2
      from public.matches m
      left join public.profiles p1   on p1.id   = m.player1_id
      left join public.profiles prt  on prt.id  = m.partner1_id
      left join public.profiles p2   on p2.id   = m.player2_id
      left join public.profiles prt2 on prt2.id = m.partner2_id
      where m.id = p_subject_id;

    if v_avg1 is null then return query select 0.5::numeric, 1.90::numeric; return; end if;
    v_p1 := 1.0 / (1.0 + power(10.0, (v_avg2 - v_avg1) * 0.5));

    if p_subject_type = 'match' then
      v_picked := p_predicate->>'winner_team';
      v_prob := case when v_picked = 'team1' then v_p1 else 1.0 - v_p1 end;
    else
      v_score1 := (p_predicate->>'team1_score')::int;
      v_score2 := (p_predicate->>'team2_score')::int;
      v_winner_team := case when v_score1 > v_score2 then 'team1' else 'team2' end;
      v_density := public._wager_score_density(v_score1, v_score2);
      v_prob := (case when v_winner_team = 'team1' then v_p1 else 1.0 - v_p1 end) * v_density;
    end if;

  elsif p_subject_type in ('tournament_match','tournament_match_score') then
    select
      ( coalesce(p1.rating, 3.5) + coalesce(prt.rating, coalesce(p1.rating, 3.5)) ) / 2.0,
      ( coalesce(p2.rating, 3.5) + coalesce(prt2.rating, coalesce(p2.rating, 3.5)) ) / 2.0
      into v_avg1, v_avg2
      from public.tournament_matches tm
      left join public.profiles p1   on p1.id   = tm.team1_player1
      left join public.profiles prt  on prt.id  = tm.team1_player2
      left join public.profiles p2   on p2.id   = tm.team2_player1
      left join public.profiles prt2 on prt2.id = tm.team2_player2
      where tm.id = p_subject_id;

    if v_avg1 is null then return query select 0.5::numeric, 1.90::numeric; return; end if;
    v_p1 := 1.0 / (1.0 + power(10.0, (v_avg2 - v_avg1) * 0.5));

    if p_subject_type = 'tournament_match' then
      v_picked := p_predicate->>'winner_team';
      v_prob := case when v_picked = 'team1' then v_p1 else 1.0 - v_p1 end;
    else
      v_score1 := (p_predicate->>'team1_score')::int;
      v_score2 := (p_predicate->>'team2_score')::int;
      v_winner_team := case when v_score1 > v_score2 then 'team1' else 'team2' end;
      v_density := public._wager_score_density(v_score1, v_score2);
      v_prob := (case when v_winner_team = 'team1' then v_p1 else 1.0 - v_p1 end) * v_density;
    end if;

  elsif p_subject_type = 'tournament_rank' then
    v_user_id := (p_predicate->>'user_id')::uuid;
    v_rank    := coalesce((p_predicate->>'rank')::int, 1);
    select t.format into v_format from public.tournaments t where t.id = p_subject_id;
    v_beta := coalesce(case when v_format in ('single_elimination','double_elimination') then 1.0 else 1.8 end, 1.0);

    -- Weight = 0 for anyone who can no longer finish #1; survivors weighted by
    -- rating plus a net-wins standings bump (zero at the start of the event).
    with f as (
      select ef.user_id, ef.rating, ef.net, ef.eligible,
             row_number() over (order by ef.user_id) as idx
        from public._wager_eligible_field(p_subject_id) ef
    )
    select array_agg(case when eligible then power(10.0, 0.5 * v_beta * (rating + v_stand_coef * net)) else 0 end order by idx),
           max(idx) filter (where user_id = v_user_id),
           count(*)::int
      into v_weights, v_target_idx, v_n
      from f;

    if coalesce(v_n, 0) = 0 or v_target_idx is null then
      v_prob := 0.02;
    else
      v_prob := public._wager_rank_probability(v_weights, v_target_idx, v_rank);
    end if;

  elsif p_subject_type in ('period_rank','season_rank') then
    v_user_id := (p_predicate->>'user_id')::uuid;
    v_rank    := coalesce((p_predicate->>'rank')::int, 1);
    select league_id into v_league_id from public.league_seasons where id = p_subject_id;
    if v_league_id is null then return query select 0.05::numeric, 18.05::numeric; return; end if;
    v_beta := 1.8;

    with field as (
      select lm.user_id,
             power(10.0, 0.5 * v_beta * coalesce(lpr.rating, p.rating, 3.5)) as w,
             row_number() over (order by lm.user_id) as idx
        from public.league_members lm
        left join public.league_player_ratings lpr
               on lpr.league_id = v_league_id and lpr.user_id = lm.user_id
        left join public.profiles p on p.id = lm.user_id
       where lm.league_id = v_league_id
    )
    select array_agg(w order by idx),
           max(idx) filter (where user_id = v_user_id),
           count(*)::int
      into v_weights, v_target_idx, v_n
      from field;

    if coalesce(v_n, 0) = 0 or v_target_idx is null then
      v_prob := 0.05;
    else
      v_prob := public._wager_rank_probability(v_weights, v_target_idx, v_rank);
    end if;

  else
    v_prob := 0.5;
  end if;

  if v_prob < 0.02 then v_prob := 0.02; end if;
  if v_prob > 0.95 then v_prob := 0.95; end if;

  return query select v_prob, round((1.0 - v_house_edge) / v_prob, 3);
end;
$function$;

-- ── place_wager — close markets on decided matches / ended tournaments ──
create or replace function public.place_wager(p_subject_type text, p_subject_id uuid, p_predicate jsonb, p_stake integer)
returns table(success boolean, wager_id uuid, odds numeric, potential_payout integer, balance integer, message text)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_uid       uuid := auth.uid();
  v_balance   int;
  v_prob      numeric;
  v_odds      numeric;
  v_payout    int;
  v_new_id    uuid;
  v_new_bal   int;
  v_exists    boolean := false;
begin
  if v_uid is null then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Not signed in.'; return;
  end if;
  if p_stake is null or p_stake <= 0 then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Stake must be a positive integer.'; return;
  end if;

  if p_subject_type in ('match','match_score') then
    select exists(select 1 from public.matches where id = p_subject_id) into v_exists;
  elsif p_subject_type in ('tournament_match','tournament_match_score') then
    select exists(select 1 from public.tournament_matches where id = p_subject_id) into v_exists;
  elsif p_subject_type = 'tournament_rank' then
    select exists(select 1 from public.tournaments where id = p_subject_id) into v_exists;
  elsif p_subject_type in ('period_rank','season_rank') then
    select exists(select 1 from public.league_seasons where id = p_subject_id) into v_exists;
  else
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Unknown subject type.'; return;
  end if;
  if not v_exists then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Wager subject not found.'; return;
  end if;

  -- Market must still be OPEN: no bets on a match that's already been decided
  -- or a tournament that has ended.
  if p_subject_type in ('match','match_score')
     and exists(select 1 from public.matches where id = p_subject_id and status = 'completed') then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Betting is closed — this match is already decided.'; return;
  elsif p_subject_type in ('tournament_match','tournament_match_score')
     and exists(select 1 from public.tournament_matches where id = p_subject_id and status = 'completed') then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Betting is closed — this match is already decided.'; return;
  elsif p_subject_type = 'tournament_rank'
     and exists(select 1 from public.tournaments where id = p_subject_id and status in ('completed','cancelled')) then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Betting is closed — this tournament has ended.'; return;
  end if;

  if p_subject_type in ('match','tournament_match') then
    if (p_predicate->>'winner_team') not in ('team1','team2') then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include winner_team (team1|team2).'; return;
    end if;
  elsif p_subject_type in ('match_score','tournament_match_score') then
    if (p_predicate->>'team1_score') is null or (p_predicate->>'team2_score') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include team1_score and team2_score.'; return;
    end if;
  elsif p_subject_type = 'tournament_rank' then
    if (p_predicate->>'user_id') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id.'; return;
    end if;
  elsif p_subject_type = 'period_rank' then
    if (p_predicate->>'user_id') is null or (p_predicate->>'period_number') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id and period_number.'; return;
    end if;
  elsif p_subject_type = 'season_rank' then
    if (p_predicate->>'user_id') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id.'; return;
    end if;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid for update;
  if v_balance is null then
    return query select false, null::uuid, null::numeric, null::int, null::int, 'Profile not found.'; return;
  end if;
  if v_balance < p_stake then
    return query select false, null::uuid, null::numeric, null::int, v_balance, format('Not enough pickles. Balance is %s.', v_balance); return;
  end if;

  select co.probability, co.odds into v_prob, v_odds
    from public.calculate_wager_odds(p_subject_type, p_subject_id, p_predicate) as co;
  if v_odds is null or v_odds < 1 then v_odds := 1.0; end if;
  v_payout := floor(p_stake * v_odds)::int;
  if v_payout < p_stake then v_payout := p_stake; end if;

  update public.profiles set pickles = pickles - p_stake where id = v_uid returning pickles into v_new_bal;
  insert into public.wagers (user_id, subject_type, subject_id, predicate, stake, odds, potential_payout)
    values (v_uid, p_subject_type, p_subject_id, p_predicate, p_stake, v_odds, v_payout)
    returning id into v_new_id;

  return query select true, v_new_id, v_odds, v_payout, v_new_bal, 'Wager placed.'::text;
end;
$function$;
