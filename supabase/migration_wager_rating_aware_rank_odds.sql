-- Rating-aware odds for the RANK markets (tournament_rank / period_rank /
-- season_rank).
--
-- BUG: calculate_wager_odds priced "finish rank r" at 1/sqrt(N) * 0.5^(r-1)
-- for EVERY competitor regardless of skill. The implied probabilities summed
-- to sqrt(N) (2.83 for an 8-field, not ~1), so favourites were massively
-- underpriced (+28% to +67% EV) and underdogs overpriced. A favourite-only
-- betting strategy netted +78% on turnover through the real pipeline
-- (simulations/wager-attack.mjs).
--
-- FIX: price each competitor by the app's OWN pairwise model. The match
-- markets already use p(i beats j) = 1/(1+10^((r_j-r_i)*0.5)); the consistent
-- extension to a full ranking is Plackett-Luce with weights w_i = 10^(0.5*r_i)
-- (sampling the finishing order without replacement, each pick proportional
-- to weight). P(finish exactly rank r) is then exact and closed-form for the
-- podium (r=1,2,3), and crucially SUMS TO 1 across the field for each rank —
-- so the market is balanced and favourites are no longer +EV. Match /
-- match_score branches are unchanged (already Elo-based and balanced).

-- ── Plackett-Luce exact rank probability ────────────────────────────────
-- Given field weights and a target index, the probability the target finishes
-- in EXACTLY rank r (1..3 exact; r>=4 tapers off the podium value). O(N) for
-- r<=2, O(N^2) for r=3 — bounded for r=3 on very large fields to stay snappy
-- in the odds-preview path.
create or replace function public._wager_rank_probability(p_weights numeric[], p_target int, p_rank int)
returns numeric language plpgsql immutable as $$
declare
  n    int := array_length(p_weights, 1);
  s    numeric := 0;
  acc  numeric := 0;
  wt   numeric;
  wj   numeric;
  wk   numeric;
  j    int;
  k    int;
begin
  if n is null or n = 0 or p_target < 1 or p_target > n then
    return 0;
  end if;
  select sum(w) into s from unnest(p_weights) as w;
  if s <= 0 then return 1.0 / n; end if;
  wt := p_weights[p_target];

  if p_rank <= 1 then
    return wt / s;

  elsif p_rank = 2 then
    for j in 1..n loop
      if j = p_target then continue; end if;
      wj := p_weights[j];
      if s - wj > 0 then
        acc := acc + (wj / s) * (wt / (s - wj));
      end if;
    end loop;
    return acc;

  elsif p_rank = 3 and n <= 64 then
    for j in 1..n loop
      if j = p_target then continue; end if;
      wj := p_weights[j];
      if s - wj <= 0 then continue; end if;
      for k in 1..n loop
        if k = p_target or k = j then continue; end if;
        wk := p_weights[k];
        if s - wj - wk > 0 then
          acc := acc + (wj / s) * (wk / (s - wj)) * (wt / (s - wj - wk));
        end if;
      end loop;
    end loop;
    return acc;

  else
    -- Beyond the podium (or huge fields where exact r=3 is too costly),
    -- taper the exact 2nd-place value by half per extra rank.
    return public._wager_rank_probability(p_weights, p_target, 2) * power(0.5, greatest(p_rank, 3) - 2);
  end if;
end;
$$;
revoke execute on function public._wager_rank_probability(numeric[], int, int) from public, anon, authenticated;

-- ── calculate_wager_odds — rank branches now rating-aware ───────────────
create or replace function public.calculate_wager_odds(p_subject_type text, p_subject_id uuid, p_predicate jsonb)
returns table(probability numeric, odds numeric)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_house_edge   numeric := 0.05;
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
  v_weights      numeric[];
  v_target_idx   int;
  v_n            int;
  v_beta         numeric;
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

    if v_avg1 is null then
      return query select 0.5::numeric, 1.90::numeric; return;
    end if;
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

    if v_avg1 is null then
      return query select 0.5::numeric, 1.90::numeric; return;
    end if;
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
    -- Sharpening exponent: elimination formats have high single-match
    -- variance and are well-matched by plain PL (beta=1); "most wins"
    -- formats (round robin, pool play, rotating, MLP) concentrate first
    -- place on the strongest player far more, so sharpen (beta=1.8). Tuned
    -- against Monte-Carlo bracket sims (simulations/wager-calibrate.mjs).
    select case when t.format in ('single_elimination','double_elimination') then 1.0 else 1.8 end
      into v_beta from public.tournaments t where t.id = p_subject_id;
    v_beta := coalesce(v_beta, 1.0);
    -- Plackett-Luce weights over the approved field, keyed on GLOBAL rating
    -- (same facet the match markets price on).
    with field as (
      select tr.user_id,
             power(10.0, 0.5 * v_beta * coalesce(p.rating, 3.5)) as w,
             row_number() over (order by tr.user_id) as idx
        from public.tournament_registrations tr
        join public.profiles p on p.id = tr.user_id
       where tr.tournament_id = p_subject_id and tr.status = 'approved'
    )
    select array_agg(w order by idx),
           max(idx) filter (where user_id = v_user_id),
           count(*)::int
      into v_weights, v_target_idx, v_n
      from field;

    if coalesce(v_n, 0) = 0 or v_target_idx is null then
      v_prob := 0.02;
    else
      v_prob := public._wager_rank_probability(v_weights, v_target_idx, v_rank);
    end if;

  elsif p_subject_type in ('period_rank','season_rank') then
    v_user_id := (p_predicate->>'user_id')::uuid;
    v_rank    := coalesce((p_predicate->>'rank')::int, 1);
    select league_id into v_league_id from public.league_seasons where id = p_subject_id;
    if v_league_id is null then
      return query select 0.05::numeric, 18.05::numeric; return;
    end if;

    -- League standings are decided by rating over many games (an aggregate,
    -- "most wins"-like process), so sharpen like the round-robin case.
    v_beta := 1.8;
    -- Standings order by LEAGUE rating, so weight the field on that (fall
    -- back to global rating, then the 3.5 default).
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

  -- Floor/ceil before applying house edge (unchanged).
  if v_prob < 0.02 then v_prob := 0.02; end if;
  if v_prob > 0.95 then v_prob := 0.95; end if;

  return query
    select v_prob, round((1.0 - v_house_edge) / v_prob, 3);
end;
$function$;
