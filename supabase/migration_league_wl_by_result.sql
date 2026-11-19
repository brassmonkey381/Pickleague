-- migration_league_wl_by_result.sql — PKL-048: league W-L counts the match winner.
--
-- Bug B13 (PKL-034 rules review): _apply_plupr_delta_to_league added a win
-- when the PLUPR delta was positive and a loss when it was negative. A narrow
-- win against a stronger-expected margin moves PLUPR down, so it counted as a
-- loss; a tournament placement bonus (apply_tournament_finishes) counted as a
-- win. Now:
--   1. _pl_league_wl(league, user, won, sign) adds (sign 1) or takes back
--      (sign -1) one win or loss; won null does nothing.
--   2. _pl_match_league_wl(...) does that for every player on a match.
--   3. _apply_plupr_delta_to_league moves ratings only (no W-L), so bonuses no
--      longer add a win.
--   4. update_plupr_ratings (league matches), _pl_tm_plupr (tournament matches
--      in a league) and recompute_all_plupr count W-L by the result. Bodies are
--      the live copies (checked 2026-11-18) plus the W-L lines.
--   5. _pl_tm_plupr records 'won' in each plupr_ratings entry; _pl_tm_reverse_one
--      takes back exactly that (older entries: the delta's sign, which is what
--      they added).
-- Matches that move no rating (doubles with an unspecified category) still add
-- no W-L, as before. Existing W-L totals are not recounted (that would be a
-- separate backfill).
-- Safe to re-run.

create or replace function public._pl_league_wl(
  p_league uuid, p_user uuid, p_won boolean, p_sign integer default 1
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_league is null or p_user is null or p_won is null then return; end if;
  insert into public.league_player_ratings (league_id, user_id)
    values (p_league, p_user) on conflict do nothing;
  update public.league_player_ratings
     set wins   = greatest(0, wins   + case when p_won     then p_sign else 0 end),
         losses = greatest(0, losses + case when not p_won then p_sign else 0 end),
         updated_at = now()
   where league_id = p_league and user_id = p_user;
end $$;
revoke all on function public._pl_league_wl(uuid, uuid, boolean, integer) from public, anon, authenticated;

create or replace function public._pl_match_league_wl(
  p_league uuid, p_t1p1 uuid, p_t1p2 uuid, p_t2p1 uuid, p_t2p2 uuid,
  p_match_type text, p_team1_won boolean, p_sign integer default 1
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_league is null or p_team1_won is null then return; end if;
  perform public._pl_league_wl(p_league, p_t1p1, p_team1_won, p_sign);
  perform public._pl_league_wl(p_league, p_t2p1, not p_team1_won, p_sign);
  if p_match_type = 'doubles' then
    perform public._pl_league_wl(p_league, p_t1p2, p_team1_won, p_sign);
    perform public._pl_league_wl(p_league, p_t2p2, not p_team1_won, p_sign);
  end if;
end $$;
revoke all on function public._pl_match_league_wl(uuid, uuid, uuid, uuid, uuid, text, boolean, integer) from public, anon, authenticated;

-- Ratings only. Was: + wins/losses by the sign of p_delta.
CREATE OR REPLACE FUNCTION public._apply_plupr_delta_to_league(p_league_id uuid, p_user_id uuid, p_delta numeric, p_cat text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  PLUPR_FLOOR constant decimal := 2.000;
begin
  if p_league_id is null or p_user_id is null then return; end if;
  -- Ensure the row exists (handles users who play before formal membership)
  insert into public.league_player_ratings (league_id, user_id)
    values (p_league_id, p_user_id) on conflict do nothing;

  update public.league_player_ratings
     set rating = greatest(PLUPR_FLOOR, rating + p_delta),
         singles_rating       = case when p_cat = 'singles'  then greatest(PLUPR_FLOOR, singles_rating       + p_delta) else singles_rating       end,
         doubles_rating       = case when p_cat = 'gendered' then greatest(PLUPR_FLOOR, doubles_rating       + p_delta) else doubles_rating       end,
         mixed_doubles_rating = case when p_cat = 'mixed'    then greatest(PLUPR_FLOOR, mixed_doubles_rating + p_delta) else mixed_doubles_rating end,
         updated_at = now()
   where league_id = p_league_id and user_id = p_user_id;
end;
$function$;


CREATE OR REPLACE FUNCTION public.update_plupr_ratings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    -- K by experience and the move cap: _plupr_delta (migration_plupr_bigger_moves.sql).
    delta1 := public._plupr_delta(p1_count, surprise);
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
      -- League W-L by the match result (PKL-048).
      perform public._pl_match_league_wl(new.league_id, new.player1_id, new.partner1_id, new.player2_id, new.partner2_id,
        new.match_type,
        case when new.winner_team in ('team1', 'team2') then new.winner_team = 'team1'
             when new.winner_id is not null then new.winner_id in (new.player1_id, new.partner1_id) end, 1);
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
    -- League W-L by the match result (PKL-048).
    perform public._pl_match_league_wl(new.league_id, new.player1_id, new.partner1_id, new.player2_id, new.partner2_id,
      new.match_type,
      case when new.winner_team in ('team1', 'team2') then new.winner_team = 'team1'
           when new.winner_id is not null then new.winner_id in (new.player1_id, new.partner1_id) end, 1);
  end if;

  return new;
end;
$function$;


CREATE OR REPLACE FUNCTION public.recompute_all_plupr()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
        coalesce(tm.completed_at, tm.scheduled_at, tm.created_at) as ts,
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
    delta1 := public._plupr_delta(p1_played, surprise);
    delta2 := -delta1;

    if rec.league_id is not null then
      -- League W-L by the match result (PKL-048), not by the PLUPR sign.
      perform public._pl_match_league_wl(rec.league_id, rec.t1p1, rec.t1p2, rec.t2p1, rec.t2p2, rec.match_type,
        case when rec.winner_team in ('team1', 'team2') then rec.winner_team = 'team1'
             when rec.winner_id is not null then rec.winner_id in (rec.t1p1, rec.t1p2) end, 1);
      -- League matches AND league tournament matches: league full, overall half.
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
      -- Standalone tournament: overall PLUPR, full delta.
      perform public._apply_plupr_delta_to_global(rec.t1p1, delta1, case when rec.match_type='singles' then 'singles' else cat end);
      perform public._apply_plupr_delta_to_global(rec.t2p1, delta2, case when rec.match_type='singles' then 'singles' else cat end);
      if rec.match_type='doubles' then
        if rec.t1p2 is not null then perform public._apply_plupr_delta_to_global(rec.t1p2, delta1, cat); end if;
        if rec.t2p2 is not null then perform public._apply_plupr_delta_to_global(rec.t2p2, delta2, cat); end if;
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
$function$;
revoke all on function public.recompute_all_plupr() from public, anon, authenticated;


create or replace function public._pl_tm_reverse_one(
  p_league uuid, p_uid uuid, p_cat text, p_entry jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_g  numeric := coalesce((p_entry->>'after')::numeric   - (p_entry->>'before')::numeric, 0);
  v_f  numeric := coalesce((p_entry->>'fafter')::numeric  - (p_entry->>'fbefore')::numeric, 0);
  v_l  numeric := coalesce((p_entry->>'lafter')::numeric  - (p_entry->>'lbefore')::numeric, 0);
  v_lf numeric := coalesce((p_entry->>'lfafter')::numeric - (p_entry->>'lfbefore')::numeric, 0);
  v_d  numeric := coalesce((p_entry->>'delta')::numeric, 0);
  -- 'won' is recorded since PKL-048; older entries added W-L by the delta's sign.
  v_won boolean := case when p_entry ? 'won' then (p_entry->>'won')::boolean
                        when v_d > 0 then true when v_d < 0 then false end;
begin
  if p_uid is null or p_entry is null then return; end if;
  update public.profiles
     set rating = rating - v_g,
         singles_rating       = case when p_cat = 'singles'  then singles_rating       - v_f else singles_rating       end,
         doubles_rating       = case when p_cat = 'gendered' then doubles_rating       - v_f else doubles_rating       end,
         mixed_doubles_rating = case when p_cat = 'mixed'    then mixed_doubles_rating - v_f else mixed_doubles_rating end
   where id = p_uid;
  if p_league is not null then
    update public.league_player_ratings
       set rating = rating - v_l,
           singles_rating       = case when p_cat = 'singles'  then singles_rating       - v_lf else singles_rating       end,
           doubles_rating       = case when p_cat = 'gendered' then doubles_rating       - v_lf else doubles_rating       end,
           mixed_doubles_rating = case when p_cat = 'mixed'    then mixed_doubles_rating - v_lf else mixed_doubles_rating end,
           wins   = greatest(0, wins   - case when v_won is true  then 1 else 0 end),
           losses = greatest(0, losses - case when v_won is false then 1 else 0 end),
           updated_at = now()
     where league_id = p_league and user_id = p_uid;
  end if;
end $$;
revoke all on function public._pl_tm_reverse_one(uuid, uuid, text, jsonb) from public, anon, authenticated;


create or replace function public._pl_tm_plupr()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  GLOBAL_WEIGHT constant numeric := 0.5;
  v_is      boolean;
  v_was     boolean := false;
  v_changed boolean := false;
  v_league  uuid;
  v_w       numeric;
  r1 numeric; r_p1 numeric := 3.250;
  r2 numeric; r_p2 numeric := 3.250;
  t1avg numeric; t2avg numeric;
  cat text; fcat text;
  p1_count integer;
  s1 integer; s2 integer;
  d1 numeric;
  v_r jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then
    if old.plupr_applied_at is not null then
      perform public._pl_tm_reverse_row(old.plupr_league_id, old.plupr_category, old.plupr_ratings);
    end if;
    return old;
  end if;

  -- Server-owned columns: whatever a client sent is replaced.
  if tg_op = 'INSERT' then
    new.completed_at := null;
    new.plupr_delta := null; new.plupr_league_id := null; new.plupr_global_weight := null;
    new.plupr_category := null; new.plupr_ratings := null; new.plupr_applied_at := null;
  else
    new.completed_at := old.completed_at;
    new.plupr_delta := old.plupr_delta; new.plupr_league_id := old.plupr_league_id;
    new.plupr_global_weight := old.plupr_global_weight; new.plupr_category := old.plupr_category;
    new.plupr_ratings := old.plupr_ratings; new.plupr_applied_at := old.plupr_applied_at;
    v_was := old.status = 'completed' and old.winner_team is not null
             and old.team1_player1 is not null and old.team2_player1 is not null;
  end if;

  v_is := new.status = 'completed' and new.winner_team in ('team1', 'team2')
          and new.team1_player1 is not null and new.team2_player1 is not null;

  if tg_op = 'UPDATE' and v_was and v_is then
    v_changed := (new.team1_score, new.team2_score, new.winner_team, new.match_type,
                  new.team1_player1, new.team1_player2, new.team2_player1, new.team2_player2,
                  new.team1_player1_gender_override, new.team1_player2_gender_override,
                  new.team2_player1_gender_override, new.team2_player2_gender_override)
                 is distinct from
                 (old.team1_score, old.team2_score, old.winner_team, old.match_type,
                  old.team1_player1, old.team1_player2, old.team2_player1, old.team2_player2,
                  old.team1_player1_gender_override, old.team1_player2_gender_override,
                  old.team2_player1_gender_override, old.team2_player2_gender_override);
    if not v_changed then return new; end if;            -- a re-save: nothing to do
    if old.plupr_applied_at is null then return new; end if;  -- completed before this file (or unspecified doubles): leave it
  end if;

  -- Undo what this row applied when it stops counting or its result changed.
  if tg_op = 'UPDATE' and old.plupr_applied_at is not null and (not v_is or v_changed) then
    perform public._pl_tm_reverse_row(old.plupr_league_id, old.plupr_category, old.plupr_ratings);
    new.plupr_delta := null; new.plupr_league_id := null; new.plupr_global_weight := null;
    new.plupr_category := null; new.plupr_ratings := null; new.plupr_applied_at := null;
  end if;

  if not v_is then
    new.completed_at := null;
    return new;
  end if;
  if not v_was then new.completed_at := now(); end if;

  -- Apply. Same rating math as update_plupr_for_tournament_match.
  select league_id into v_league from public.tournaments where id = new.tournament_id;
  v_w := case when v_league is not null then GLOBAL_WEIGHT else 1.0 end;

  select rating into r1 from public.profiles where id = new.team1_player1;
  select rating into r2 from public.profiles where id = new.team2_player1;
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then select rating into r_p1 from public.profiles where id = new.team1_player2; end if;
    if new.team2_player2 is not null then select rating into r_p2 from public.profiles where id = new.team2_player2; end if;
    t1avg := (r1 + r_p1) / 2.0;
    t2avg := (r2 + r_p2) / 2.0;
    cat := public._classify_doubles_with_overrides(
      new.team1_player1, new.team1_player1_gender_override,
      new.team1_player2, new.team1_player2_gender_override,
      new.team2_player1, new.team2_player1_gender_override,
      new.team2_player2, new.team2_player2_gender_override);
    fcat := cat;
  else
    t1avg := r1; t2avg := r2; cat := null; fcat := 'singles';
  end if;

  new.plupr_category := fcat;
  if new.match_type = 'doubles' and cat = 'unspecified' then return new; end if;

  select coalesce(total_matches_played, 0) into p1_count from public.profiles where id = new.team1_player1;
  -- A correction: this match is already in the count; K reads the count before it.
  if v_was then p1_count := greatest(0, p1_count - 1); end if;

  if new.winner_team = 'team1' then
    s1 := coalesce(new.team1_score, 11); s2 := coalesce(new.team2_score, 7);
  else
    s1 := coalesce(new.team1_score, 7);  s2 := coalesce(new.team2_score, 11);
  end if;

  d1 := public._plupr_delta(p1_count,
          ((s1 - s2)::numeric - public._plupr_expected_diff(t1avg, t2avg)) / 10.0);

  v_r := v_r || jsonb_build_object(new.team1_player1::text,
           public._pl_tm_apply_one(v_league, new.team1_player1, d1, v_w, fcat));
  v_r := v_r || jsonb_build_object(new.team2_player1::text,
           public._pl_tm_apply_one(v_league, new.team2_player1, -d1, v_w, fcat));
  if new.match_type = 'doubles' then
    if new.team1_player2 is not null then
      v_r := v_r || jsonb_build_object(new.team1_player2::text,
               public._pl_tm_apply_one(v_league, new.team1_player2, d1, v_w, fcat));
    end if;
    if new.team2_player2 is not null then
      v_r := v_r || jsonb_build_object(new.team2_player2::text,
               public._pl_tm_apply_one(v_league, new.team2_player2, -d1, v_w, fcat));
    end if;
  end if;

  -- League W-L by the match result (PKL-048). Each entry records it so a
  -- correction or delete takes back exactly what was added.
  if v_league is not null then
    perform public._pl_league_wl(v_league, new.team1_player1, new.winner_team = 'team1', 1);
    perform public._pl_league_wl(v_league, new.team2_player1, new.winner_team = 'team2', 1);
    v_r := jsonb_set(v_r, array[new.team1_player1::text, 'won'], to_jsonb(new.winner_team = 'team1'));
    v_r := jsonb_set(v_r, array[new.team2_player1::text, 'won'], to_jsonb(new.winner_team = 'team2'));
    if new.match_type = 'doubles' then
      if new.team1_player2 is not null then
        perform public._pl_league_wl(v_league, new.team1_player2, new.winner_team = 'team1', 1);
        v_r := jsonb_set(v_r, array[new.team1_player2::text, 'won'], to_jsonb(new.winner_team = 'team1'));
      end if;
      if new.team2_player2 is not null then
        perform public._pl_league_wl(v_league, new.team2_player2, new.winner_team = 'team2', 1);
        v_r := jsonb_set(v_r, array[new.team2_player2::text, 'won'], to_jsonb(new.winner_team = 'team2'));
      end if;
    end if;
  end if;

  new.plupr_delta := d1;
  new.plupr_league_id := v_league;
  new.plupr_global_weight := v_w;
  new.plupr_ratings := v_r;
  new.plupr_applied_at := now();
  return new;
end $$;
revoke all on function public._pl_tm_plupr() from public, anon, authenticated;

notify pgrst, 'reload schema';
