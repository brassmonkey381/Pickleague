-- Reject wagers on impossible outcomes.
--
-- calculate_wager_odds floors any unrecognized/impossible predicate to prob
-- 0.02, so betting "finish 3rd in a 2-player tournament", or on a player who
-- isn't even in the field, was ACCEPTED at ~47.5x and could never settle as
-- won — a deceptive guaranteed loss. place_wager now validates the predicate
-- against the actual field before taking the stake:
--   - rank must be >= 1 and <= the number of competitors,
--   - the picked player must actually be in the field,
--   - a rank-1 bet is refused once that player can no longer finish 1st.

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
  v_rk        int;
  v_field     int;
  v_in        boolean;
  v_elig      boolean;
  v_uid_pred  uuid;
  v_league    uuid;
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

  -- Market must still be OPEN.
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

  -- Predicate validation, including IMPOSSIBLE-outcome rejection.
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
    v_uid_pred := (p_predicate->>'user_id')::uuid;
    v_rk := coalesce((p_predicate->>'rank')::int, 1);
    if v_rk < 1 then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Rank must be 1 or higher.'; return;
    end if;
    select count(*), bool_or(tr.user_id = v_uid_pred)
      into v_field, v_in
      from public.tournament_registrations tr
     where tr.tournament_id = p_subject_id and tr.status = 'approved';
    if not coalesce(v_in, false) then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'That player is not in this tournament.'; return;
    end if;
    if v_rk > v_field then
      return query select false, null::uuid, null::numeric, null::int, null::int,
        format('Impossible bet: this tournament has only %s player%s, so no one can finish %s.', v_field, case when v_field = 1 then '' else 's' end, v_rk); return;
    end if;
    if v_rk = 1 then
      select ef.eligible into v_elig from public._wager_eligible_field(p_subject_id) ef where ef.user_id = v_uid_pred;
      if not coalesce(v_elig, true) then
        return query select false, null::uuid, null::numeric, null::int, null::int, 'That player can no longer finish 1st in this tournament.'; return;
      end if;
    end if;

  elsif p_subject_type = 'period_rank' then
    if (p_predicate->>'user_id') is null or (p_predicate->>'period_number') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id and period_number.'; return;
    end if;
    v_uid_pred := (p_predicate->>'user_id')::uuid;
    v_rk := coalesce((p_predicate->>'rank')::int, 1);
    if v_rk < 1 then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Rank must be 1 or higher.'; return;
    end if;
    select league_id into v_league from public.league_seasons where id = p_subject_id;
    select count(*), bool_or(lm.user_id = v_uid_pred)
      into v_field, v_in from public.league_members lm where lm.league_id = v_league;
    if not coalesce(v_in, false) then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'That player is not a member of this league.'; return;
    end if;
    if v_rk > v_field then
      return query select false, null::uuid, null::numeric, null::int, null::int,
        format('Impossible bet: this league has only %s member%s, so no one can finish %s.', v_field, case when v_field = 1 then '' else 's' end, v_rk); return;
    end if;

  elsif p_subject_type = 'season_rank' then
    if (p_predicate->>'user_id') is null then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Predicate must include user_id.'; return;
    end if;
    v_uid_pred := (p_predicate->>'user_id')::uuid;
    v_rk := coalesce((p_predicate->>'rank')::int, 1);
    if v_rk < 1 then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'Rank must be 1 or higher.'; return;
    end if;
    select league_id into v_league from public.league_seasons where id = p_subject_id;
    select count(*), bool_or(lm.user_id = v_uid_pred)
      into v_field, v_in from public.league_members lm where lm.league_id = v_league;
    if not coalesce(v_in, false) then
      return query select false, null::uuid, null::numeric, null::int, null::int, 'That player is not a member of this league.'; return;
    end if;
    if v_rk > v_field then
      return query select false, null::uuid, null::numeric, null::int, null::int,
        format('Impossible bet: this league has only %s member%s, so no one can finish %s.', v_field, case when v_field = 1 then '' else 's' end, v_rk); return;
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
