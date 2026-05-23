-- ============================================================
-- PLUPR K-factor bump
--
-- Old K values: 0.20 / 0.12 / 0.06 (by experience: <5, <15, else)
-- New K values: 0.35 / 0.22 / 0.15
--
-- Roughly 1.75-2.5x faster rating movement. Pairs with the
-- margin-of-victory rework (migration_plupr_margin_of_victory.sql)
-- whose typical deltas were a bit too sluggish.
-- ============================================================

create or replace function public.update_plupr_ratings()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  GLOBAL_WEIGHT   constant decimal := 0.5;
  r1              decimal; r_p1 decimal := 3.250;
  r2              decimal; r_p2 decimal := 3.250;
  team1_avg       decimal; team2_avg decimal;
  expected_diff   decimal;
  actual_diff     decimal;
  surprise        decimal;
  k_factor        decimal;
  s1              integer; s2 integer;
  delta1          decimal; delta2 decimal;
  won1            boolean;
  cat             text;
  p1_count        integer;
begin
  if TG_OP = 'INSERT' then
    select rating into r1 from public.profiles where id = new.player1_id;
    select rating into r2 from public.profiles where id = new.player2_id;

    if new.match_type = 'doubles' then
      if new.partner1_id is not null then select rating into r_p1 from public.profiles where id = new.partner1_id; end if;
      if new.partner2_id is not null then select rating into r_p2 from public.profiles where id = new.partner2_id; end if;
      team1_avg := (r1 + r_p1) / 2.0;
      team2_avg := (r2 + r_p2) / 2.0;
      cat := public._classify_doubles_with_overrides(
        new.player1_id,  new.player1_gender_override,
        new.partner1_id, new.partner1_gender_override,
        new.player2_id,  new.player2_gender_override,
        new.partner2_id, new.partner2_gender_override
      );
      new.doubles_category := cat;
    else
      team1_avg := r1; team2_avg := r2;
      new.doubles_category := null; cat := null;
    end if;

    new.player1_rating_before := r1;
    new.player2_rating_before := r2;

    if new.match_type = 'doubles' and cat = 'unspecified' then
      new.player1_rating_after := r1;
      new.player2_rating_after := r2;
      new.pending_delta1 := 0;
      new.pending_delta2 := 0;
      return new;
    end if;

    select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.player1_id;
    if    p1_count <  5 then k_factor := 0.35;
    elsif p1_count < 15 then k_factor := 0.22;
    else                     k_factor := 0.15;
    end if;

    won1 := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
    if won1 then
      s1 := coalesce(new.player1_score, 11);
      s2 := coalesce(new.player2_score, 7);
    else
      s1 := coalesce(new.player1_score, 7);
      s2 := coalesce(new.player2_score, 11);
    end if;

    expected_diff := public._plupr_expected_diff(team1_avg, team2_avg);
    actual_diff   := (s1 - s2)::decimal;
    surprise      := (actual_diff - expected_diff) / 10.0;
    delta1 := round((k_factor * surprise)::numeric, 3);
    delta2 := -delta1;

    new.player1_rating_after := greatest(PLUPR_FLOOR, r1 + delta1 * GLOBAL_WEIGHT);
    new.player2_rating_after := greatest(PLUPR_FLOOR, r2 + delta2 * GLOBAL_WEIGHT);
    new.pending_delta1 := delta1;
    new.pending_delta2 := delta2;

    if new.status = 'completed' then
      perform public._apply_match_deltas_to_players(
        new.league_id,
        new.player1_id, new.partner1_id, new.player2_id, new.partner2_id,
        new.match_type, cat, delta1, delta2
      );
    end if;

    return new;
  end if;

  if TG_OP = 'UPDATE' and old.status = 'pending' and new.status = 'completed' then
    if new.pending_delta1 is null or new.pending_delta1 = 0 then
      return new;
    end if;
    perform public._apply_match_deltas_to_players(
      new.league_id,
      new.player1_id, new.partner1_id, new.player2_id, new.partner2_id,
      new.match_type, new.doubles_category, new.pending_delta1, new.pending_delta2
    );
  end if;

  return new;
end;
$$;


create or replace function public.update_plupr_for_tournament_match()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  v_league_id     uuid;
  r1 decimal; r_p1 decimal := 3.250;
  r2 decimal; r_p2 decimal := 3.250;
  team1_avg       decimal; team2_avg decimal;
  expected_diff   decimal;
  actual_diff     decimal;
  surprise        decimal;
  k_factor        decimal := 0.15;
  s1              integer; s2 integer;
  delta1          decimal; delta2 decimal;
  won1            boolean;
  cat             text;
  p1_count        integer;
begin
  if not (
    (TG_OP = 'UPDATE' and old.status <> 'completed' and new.status = 'completed')
    or (TG_OP = 'INSERT' and new.status = 'completed')
  ) then return new; end if;
  if new.winner_team is null or new.team1_player1 is null or new.team2_player1 is null then return new; end if;

  select league_id into v_league_id from public.tournaments where id = new.tournament_id;

  select rating into r1 from public.profiles where id = new.team1_player1;
  select rating into r2 from public.profiles where id = new.team2_player1;
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then select rating into r_p1 from public.profiles where id = new.team1_player2; end if;
    if new.team2_player2 is not null then select rating into r_p2 from public.profiles where id = new.team2_player2; end if;
    team1_avg := (r1 + r_p1) / 2.0;
    team2_avg := (r2 + r_p2) / 2.0;
    cat := public._classify_doubles_with_overrides(
      new.team1_player1, new.team1_player1_gender_override,
      new.team1_player2, new.team1_player2_gender_override,
      new.team2_player1, new.team2_player1_gender_override,
      new.team2_player2, new.team2_player2_gender_override
    );
  else
    team1_avg := r1; team2_avg := r2; cat := null;
  end if;

  if new.match_type = 'doubles' and cat = 'unspecified' then return new; end if;

  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.team1_player1;
  if    p1_count <  5 then k_factor := 0.35;
  elsif p1_count < 15 then k_factor := 0.22;
  else                     k_factor := 0.15;
  end if;

  won1 := new.winner_team = 'team1';
  if won1 then
    s1 := coalesce(new.team1_score, 11);
    s2 := coalesce(new.team2_score, 7);
  else
    s1 := coalesce(new.team1_score, 7);
    s2 := coalesce(new.team2_score, 11);
  end if;

  expected_diff := public._plupr_expected_diff(team1_avg, team2_avg);
  actual_diff   := (s1 - s2)::decimal;
  surprise      := (actual_diff - expected_diff) / 10.0;
  delta1 := round((k_factor * surprise)::numeric, 3);
  delta2 := -delta1;

  if v_league_id is not null then
    perform public._apply_plupr_delta_to_league(v_league_id, new.team1_player1, delta1, case when new.match_type='singles' then 'singles' else cat end);
    perform public._apply_plupr_delta_to_league(v_league_id, new.team2_player1, delta2, case when new.match_type='singles' then 'singles' else cat end);
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then perform public._apply_plupr_delta_to_league(v_league_id, new.team1_player2, delta1, cat); end if;
      if new.team2_player2 is not null then perform public._apply_plupr_delta_to_league(v_league_id, new.team2_player2, delta2, cat); end if;
    end if;
  else
    perform public._apply_plupr_delta_to_global(new.team1_player1, delta1, case when new.match_type='singles' then 'singles' else cat end);
    perform public._apply_plupr_delta_to_global(new.team2_player1, delta2, case when new.match_type='singles' then 'singles' else cat end);
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then perform public._apply_plupr_delta_to_global(new.team1_player2, delta1, cat); end if;
      if new.team2_player2 is not null then perform public._apply_plupr_delta_to_global(new.team2_player2, delta2, cat); end if;
    end if;
  end if;

  return new;
end;
$$;


create or replace function public.recompute_all_plupr()
returns void language plpgsql security definer as $$
declare
  PLUPR_BASE  constant decimal := 3.250;
  GLOBAL_WT   constant decimal := 0.5;
  rec         record;
  r1 decimal; r_p1 decimal; r2 decimal; r_p2 decimal;
  team1_avg   decimal; team2_avg decimal;
  expected_diff decimal;
  actual_diff   decimal;
  surprise      decimal;
  k_factor    decimal;
  s1          integer; s2 integer;
  delta1      decimal; delta2 decimal;
  won1        boolean;
  cat         text;
  match_idx   integer := 0;
  p1_played   integer;
begin
  update public.profiles
     set rating = PLUPR_BASE, singles_rating = PLUPR_BASE,
         doubles_rating = PLUPR_BASE, mixed_doubles_rating = PLUPR_BASE,
         total_matches_played = 0;
  update public.league_player_ratings
     set rating = PLUPR_BASE, singles_rating = PLUPR_BASE,
         doubles_rating = PLUPR_BASE, mixed_doubles_rating = PLUPR_BASE,
         wins = 0, losses = 0;

  for rec in (
    with combined as (
      select
        'league_match'::text  as src,
        m.played_at           as ts,
        m.created_at          as ord,
        m.league_id           as league_id,
        m.match_type, m.doubles_category,
        m.player1_id  as t1p1, m.partner1_id as t1p2,
        m.player2_id  as t2p1, m.partner2_id as t2p2,
        m.winner_team, m.player1_score as score1, m.player2_score as score2,
        m.winner_id
      from public.matches m
      where coalesce(m.status, 'completed') = 'completed'
      union all
      select
        'tourn_match'::text                            as src,
        coalesce(tm.scheduled_at, tm.created_at)       as ts,
        tm.created_at                                  as ord,
        t.league_id                                    as league_id,
        tm.match_type,
        public.classify_doubles_match(tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2),
        tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2,
        tm.winner_team, tm.team1_score, tm.team2_score,
        null::uuid
      from public.tournament_matches tm
      join public.tournaments t on t.id = tm.tournament_id
      where tm.status = 'completed' and tm.winner_team is not null
    )
    select * from combined
    order by ts asc nulls last, ord asc
  ) loop
    match_idx := match_idx + 1;

    if rec.match_type = 'doubles' and rec.doubles_category = 'unspecified' then
      continue;
    end if;

    select rating into r1 from public.profiles where id = rec.t1p1;
    select rating into r2 from public.profiles where id = rec.t2p1;
    r_p1 := 3.250; r_p2 := 3.250;
    if rec.match_type = 'doubles' then
      if rec.t1p2 is not null then select rating into r_p1 from public.profiles where id = rec.t1p2; end if;
      if rec.t2p2 is not null then select rating into r_p2 from public.profiles where id = rec.t2p2; end if;
      team1_avg := (r1 + r_p1) / 2.0;
      team2_avg := (r2 + r_p2) / 2.0;
      cat := rec.doubles_category;
    else
      team1_avg := r1; team2_avg := r2; cat := null;
    end if;

    select coalesce(total_matches_played, 0) into p1_played from public.profiles where id = rec.t1p1;
    if    p1_played <  5 then k_factor := 0.35;
    elsif p1_played < 15 then k_factor := 0.22;
    else                      k_factor := 0.15;
    end if;

    won1 := (rec.winner_team = 'team1') or (rec.winner_id = rec.t1p1);
    if won1 then
      s1 := coalesce(rec.score1, 11);
      s2 := coalesce(rec.score2, 7);
    else
      s1 := coalesce(rec.score1, 7);
      s2 := coalesce(rec.score2, 11);
    end if;

    expected_diff := public._plupr_expected_diff(team1_avg, team2_avg);
    actual_diff   := (s1 - s2)::decimal;
    surprise      := (actual_diff - expected_diff) / 10.0;
    delta1 := round((k_factor * surprise)::numeric, 3);
    delta2 := -delta1;

    if rec.src = 'league_match' then
      perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
      perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
      if rec.match_type='doubles' then
        if rec.t1p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p2, delta1, cat); end if;
        if rec.t2p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p2, delta2, cat); end if;
      end if;
      perform public._apply_plupr_delta_to_global(rec.t1p1, delta1 * GLOBAL_WT, case when rec.match_type='singles' then 'singles' else cat end);
      perform public._apply_plupr_delta_to_global(rec.t2p1, delta2 * GLOBAL_WT, case when rec.match_type='singles' then 'singles' else cat end);
      if rec.match_type='doubles' then
        if rec.t1p2 is not null then perform public._apply_plupr_delta_to_global(rec.t1p2, delta1 * GLOBAL_WT, cat); end if;
        if rec.t2p2 is not null then perform public._apply_plupr_delta_to_global(rec.t2p2, delta2 * GLOBAL_WT, cat); end if;
      end if;
    else
      if rec.league_id is not null then
        perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
        perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
        if rec.match_type='doubles' then
          if rec.t1p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t1p2, delta1, cat); end if;
          if rec.t2p2 is not null then perform public._apply_plupr_delta_to_league(rec.league_id, rec.t2p2, delta2, cat); end if;
        end if;
      else
        perform public._apply_plupr_delta_to_global(rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
        perform public._apply_plupr_delta_to_global(rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
        if rec.match_type='doubles' then
          if rec.t1p2 is not null then perform public._apply_plupr_delta_to_global(rec.t1p2, delta1, cat); end if;
          if rec.t2p2 is not null then perform public._apply_plupr_delta_to_global(rec.t2p2, delta2, cat); end if;
        end if;
      end if;
    end if;

    update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1
     where id in (rec.t1p1, rec.t2p1);
    if rec.match_type='doubles' then
      update public.profiles set total_matches_played = coalesce(total_matches_played, 0) + 1
       where id in (rec.t1p2, rec.t2p2) and id is not null;
    end if;
  end loop;

  raise notice 'recompute_all_plupr: processed % matches', match_idx;
end;
$$;
