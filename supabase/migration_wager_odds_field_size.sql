-- ============================================================
-- Wager odds: field-size pricing for ranking wagers
--
-- Rank-type wagers (tournament_rank, period_rank, season_rank) are now priced
-- purely by FIELD SIZE rather than a skill softmax:
--
--   probability = 1 / sqrt(N)
--     N = number of competitors:
--       tournament_rank        → approved tournament registrants
--       period_rank/season_rank→ league members
--
-- The existing payout formula is unchanged — odds = (1 - house_edge)/prob with
-- a 5% edge — so the multiplier works out to 0.95 * sqrt(N):
--   2 competitors  → ~1.34x      16 → ~3.80x      30 → ~5.20x
--
-- Head-to-head match / match_score / tournament_match(_score) wagers KEEP their
-- existing skill-based (Bradley-Terry) odds — only the ranking wagers change.
-- The rank>1 longshot shave (×0.5 per rank above 1) and the 0.02/0.95
-- floor/ceil are preserved.
--
-- Run AFTER: migration_add_wagering.sql
-- ============================================================

create or replace function public.calculate_wager_odds(
  p_subject_type text,
  p_subject_id   uuid,
  p_predicate    jsonb
) returns table(probability numeric, odds numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_house_edge   numeric := 0.05;
  v_prob         numeric;
  v_avg1         numeric;
  v_avg2         numeric;
  v_p1           numeric;  -- p(team1 wins)
  v_picked       text;
  v_user_id      uuid;
  v_rank         int;
  v_score1       int;
  v_score2       int;
  v_density      numeric;
  v_winner_team  text;
  v_league_id    uuid;
  v_n            numeric;  -- field size (competitors)
  v_in           int;      -- 1 if picked user is in the field
begin
  if p_subject_type in ('match','match_score') then
    select
      ( coalesce(p1.rating, 3.5)
        + coalesce(prt.rating, coalesce(p1.rating, 3.5)) ) / 2.0,
      ( coalesce(p2.rating, 3.5)
        + coalesce(prt2.rating, coalesce(p2.rating, 3.5)) ) / 2.0
      into v_avg1, v_avg2
      from public.matches m
      left join public.profiles p1   on p1.id   = m.player1_id
      left join public.profiles prt  on prt.id  = m.partner1_id
      left join public.profiles p2   on p2.id   = m.player2_id
      left join public.profiles prt2 on prt2.id = m.partner2_id
      where m.id = p_subject_id;

    if v_avg1 is null then
      return query select 0.5::numeric, 1.90::numeric;
      return;
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
      ( coalesce(p1.rating, 3.5)
        + coalesce(prt.rating, coalesce(p1.rating, 3.5)) ) / 2.0,
      ( coalesce(p2.rating, 3.5)
        + coalesce(prt2.rating, coalesce(p2.rating, 3.5)) ) / 2.0
      into v_avg1, v_avg2
      from public.tournament_matches tm
      left join public.profiles p1   on p1.id   = tm.team1_player1
      left join public.profiles prt  on prt.id  = tm.team1_player2
      left join public.profiles p2   on p2.id   = tm.team2_player1
      left join public.profiles prt2 on prt2.id = tm.team2_player2
      where tm.id = p_subject_id;

    if v_avg1 is null then
      return query select 0.5::numeric, 1.90::numeric;
      return;
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
    -- Field size = approved registrants (individual ranking wager).
    select count(*) into v_n
      from public.tournament_registrations tr
     where tr.tournament_id = p_subject_id
       and tr.status = 'approved';
    -- The picked user must actually be in the field.
    select count(*) into v_in
      from public.tournament_registrations tr
     where tr.tournament_id = p_subject_id
       and tr.status = 'approved'
       and tr.user_id = v_user_id;

    if v_n is null or v_n = 0 or v_in = 0 then
      v_prob := 0.05;
    else
      v_prob := 1.0 / sqrt(v_n);
      -- v1 supports rank=1 cleanly; for higher target ranks shave probability.
      if v_rank > 1 then
        v_prob := v_prob * power(0.5, v_rank - 1);
      end if;
    end if;

  elsif p_subject_type in ('period_rank','season_rank') then
    v_user_id := (p_predicate->>'user_id')::uuid;
    v_rank    := coalesce((p_predicate->>'rank')::int, 1);
    select league_id into v_league_id
      from public.league_seasons where id = p_subject_id;

    if v_league_id is null then
      return query select 0.05::numeric, 18.05::numeric;
      return;
    end if;

    -- Field size = league members (individual ranking wager).
    select count(*) into v_n
      from public.league_members lm
     where lm.league_id = v_league_id;
    select count(*) into v_in
      from public.league_members lm
     where lm.league_id = v_league_id
       and lm.user_id = v_user_id;

    if v_n is null or v_n = 0 or v_in = 0 then
      v_prob := 0.05;
    else
      v_prob := 1.0 / sqrt(v_n);
      if v_rank > 1 then
        v_prob := v_prob * power(0.5, v_rank - 1);
      end if;
    end if;

  else
    v_prob := 0.5;
  end if;

  -- Floor/ceil before applying house edge.
  if v_prob < 0.02 then v_prob := 0.02; end if;
  if v_prob > 0.95 then v_prob := 0.95; end if;

  return query
    select v_prob, round((1.0 - v_house_edge) / v_prob, 3);
end;
$$;

grant execute on function public.calculate_wager_odds(text, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
