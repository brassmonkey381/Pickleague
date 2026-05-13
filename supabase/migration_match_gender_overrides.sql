-- ============================================================
-- Per-match gender overrides.
--
-- Players without a gender on their profile (or who selected
-- 'prefer-not-to-say') can now play in matches. The entering user
-- declares a one-off gender for the match — saved on the row.
--
-- The PLUPR triggers use COALESCE(override, profile.gender) for
-- classification, so a player without a profile gender still ends up
-- counted toward Gendered or Mixed Doubles based on the per-match
-- declaration. No profile data is changed.
-- ============================================================


-- 1. Override columns on matches ----------------------------------------
alter table public.matches
  add column if not exists player1_gender_override  text
    check (player1_gender_override  is null or player1_gender_override  in ('male','female','other')),
  add column if not exists partner1_gender_override text
    check (partner1_gender_override is null or partner1_gender_override in ('male','female','other')),
  add column if not exists player2_gender_override  text
    check (player2_gender_override  is null or player2_gender_override  in ('male','female','other')),
  add column if not exists partner2_gender_override text
    check (partner2_gender_override is null or partner2_gender_override in ('male','female','other'));


-- 2. Override columns on tournament_matches -----------------------------
alter table public.tournament_matches
  add column if not exists team1_player1_gender_override text
    check (team1_player1_gender_override is null or team1_player1_gender_override in ('male','female','other')),
  add column if not exists team1_player2_gender_override text
    check (team1_player2_gender_override is null or team1_player2_gender_override in ('male','female','other')),
  add column if not exists team2_player1_gender_override text
    check (team2_player1_gender_override is null or team2_player1_gender_override in ('male','female','other')),
  add column if not exists team2_player2_gender_override text
    check (team2_player2_gender_override is null or team2_player2_gender_override in ('male','female','other'));


-- 3. Helper that classifies based on EFFECTIVE genders (override → profile)
-- ----------------------------------------------------------------------
create or replace function public._effective_gender(
  p_user_id  uuid,
  p_override text
) returns text language sql stable as $$
  select case
    when p_override in ('male','female','other') then p_override
    else (select gender from public.profiles where id = p_user_id)
  end;
$$;

create or replace function public._classify_doubles_with_overrides(
  p_p1 uuid, p_p1_override text,
  p_pp1 uuid, p_pp1_override text,
  p_p2 uuid, p_p2_override text,
  p_pp2 uuid, p_pp2_override text
) returns text language plpgsql stable as $$
declare
  g1  text := public._effective_gender(p_p1,  p_p1_override);
  g2  text := public._effective_gender(p_pp1, p_pp1_override);
  g3  text := public._effective_gender(p_p2,  p_p2_override);
  g4  text := public._effective_gender(p_pp2, p_pp2_override);
  has_unset boolean;
  has_male  boolean;
  has_female boolean;
begin
  -- 'other' is a wildcard for classification purposes: it can play on either
  -- team's gender side. If any player has neither an override nor a profile
  -- gender (or prefer-not-to-say), they're 'unset' → return unspecified.
  has_unset  := g1 is null or g1 = 'prefer-not-to-say'
             or g2 is null or g2 = 'prefer-not-to-say'
             or g3 is null or g3 = 'prefer-not-to-say'
             or g4 is null or g4 = 'prefer-not-to-say';
  if has_unset then return 'unspecified'; end if;

  has_male   := g1 = 'male'   or g2 = 'male'   or g3 = 'male'   or g4 = 'male';
  has_female := g1 = 'female' or g2 = 'female' or g3 = 'female' or g4 = 'female';

  if has_male and has_female then return 'mixed'; end if;
  return 'gendered';
end;
$$;


-- 4. update_plupr_ratings — use override-aware classification ------------
create or replace function public.update_plupr_ratings()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR   constant decimal := 2.000;
  PLUPR_DIV     constant decimal := 2.0;
  GLOBAL_WEIGHT constant decimal := 0.5;
  r1            decimal; r_p1 decimal := 3.250;
  r2            decimal; r_p2 decimal := 3.250;
  team1_avg     decimal; team2_avg decimal;
  expected1     decimal;
  k_factor      decimal;
  margin_factor decimal;
  win_score     integer; loss_score integer;
  delta1        decimal; delta2 decimal;
  won1          boolean;
  cat           text;
  p1_count      integer;
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
    if    p1_count <  5 then k_factor := 0.20;
    elsif p1_count < 15 then k_factor := 0.12;
    else                     k_factor := 0.06;
    end if;

    won1 := (new.winner_team = 'team1') or (new.winner_id = new.player1_id);
    if won1 then win_score := coalesce(new.player1_score, 11); loss_score := coalesce(new.player2_score, 0);
    else         win_score := coalesce(new.player2_score, 11); loss_score := coalesce(new.player1_score, 0);
    end if;
    margin_factor := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;

    expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));
    delta1 := round((k_factor * margin_factor * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
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

  -- UPDATE path: apply stored deltas on pending→completed transition.
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


-- 5. update_plupr_for_tournament_match — same override-aware classification
-- ----------------------------------------------------------------------
create or replace function public.update_plupr_for_tournament_match()
returns trigger language plpgsql security definer as $$
declare
  PLUPR_FLOOR     constant decimal := 2.000;
  PLUPR_DIV       constant decimal := 2.0;
  v_league_id     uuid;
  r1 decimal; r_p1 decimal := 3.250;
  r2 decimal; r_p2 decimal := 3.250;
  team1_avg       decimal; team2_avg decimal;
  expected1       decimal;
  k_factor        decimal := 0.06;
  margin_factor   decimal;
  win_score       integer; loss_score integer;
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
  if    p1_count <  5 then k_factor := 0.20;
  elsif p1_count < 15 then k_factor := 0.12;
  else                     k_factor := 0.06;
  end if;

  won1 := new.winner_team = 'team1';
  if won1 then win_score := coalesce(new.team1_score, 11); loss_score := coalesce(new.team2_score, 0);
  else         win_score := coalesce(new.team2_score, 11); loss_score := coalesce(new.team1_score, 0);
  end if;
  margin_factor := 0.6 + greatest(0, win_score - loss_score)::decimal / greatest(win_score, 1) * 0.4;

  expected1 := 1.0 / (1.0 + power(10.0, (team2_avg - team1_avg) / PLUPR_DIV));
  delta1 := round((k_factor * margin_factor * (case when won1 then 1.0 - expected1 else 0.0 - expected1 end))::numeric, 3);
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
