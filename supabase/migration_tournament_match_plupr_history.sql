-- ============================================================
-- PKL-035: a scored tournament match moves PLUPR like a league match and
-- shows in match history, exactly once.
--
-- Found in the PKL-034 live run (2026-11-18): Brian's 7 tournament matches
-- left his PLUPR unchanged while profiles.total_matches_played went 6 -> 13,
-- and none of them showed in any match history.
--
-- Root cause (read from the live functions, 2026-11-18):
--   1. update_plupr_for_tournament_match (migration_plupr_bigger_moves.sql)
--      sends a tournament match in a LEAGUE to league_player_ratings only.
--      profiles.rating / singles_rating / doubles_rating never move. A league
--      match (update_plupr_ratings -> _apply_match_deltas_to_players) moves
--      league PLUPR by the full delta AND overall PLUPR by half of it. So the
--      QA tournament (in a league) changed nothing Brian could see.
--   2. Match history (MatchHistoryScreen) reads only public.matches. A
--      tournament match lives in public.tournament_matches and is never read
--      there. The match count trigger (migration_match_count_fix.sql) counts
--      both tables, which is why total_matches_played went up.
--   3. Exactly-once was fragile: PLUPR fired only on the transition into
--      completed and stored nothing, so a godmode correction (completed ->
--      completed) left the old result in the ratings, and a reset to pending
--      and back applied the match twice.
--
-- This file:
--   1. tournament_matches gets server-owned columns recording what was
--      applied: completed_at, plupr_delta (team 1's full delta; team 2 got
--      the opposite), plupr_league_id, plupr_global_weight, plupr_category
--      ('singles' | 'gendered' | 'mixed' | 'unspecified') and plupr_ratings
--      ({"<user id>": {"before", "after", "fbefore", "fafter", "lbefore", "lafter", ...}}: overall, facet and
--      league PLUPR around this match, for every player, partners included).
--      A client write to them is ignored (the trigger restores them).
--   2. _pl_tm_plupr, a BEFORE INSERT / UPDATE / DELETE trigger, replaces
--      on_tournament_match_completed:
--        - league tournament: league PLUPR full delta + overall PLUPR half,
--          exactly what _apply_match_deltas_to_players does for a league
--          match (the same _apply_plupr_delta_to_league / _global helpers);
--        - standalone tournament: overall PLUPR full delta (unchanged);
--        - doubles: all 4 players (team1_player2 / team2_player2 too), the
--          facet by category; 'unspecified' doubles (a player with no gender)
--          move nothing, the same rule as league matches;
--        - a corrected score (completed -> completed with different scores,
--          winner, players or type, only godmode / service_role can do that)
--          reverses what this row applied and applies the new result;
--        - completed -> not completed, or a delete (including a tournament
--          delete cascading), reverses it;
--        - a row completed before this file has no record of what it applied:
--          it is left alone (no double count, no reversal).
--      The K-factor still reads total_matches_played before this match
--      counts (BEFORE trigger; the count trigger is AFTER), as before.
--   3. recompute_all_plupr (the canonical rebuild) applies the same rule, so
--      a replay matches live play: league tournament matches now also move
--      overall PLUPR by half.
--   4. get_tournament_match_history(p_user_id, p_league_id, p_limit): the
--      completed tournament matches shaped like match-history rows
--      (player1/partner1/player2/partner2, scores, played_at, the tournament
--      and league, player embeds, and plupr_ratings for the PLUPR change).
--      SECURITY INVOKER, so tournament_matches RLS (closed leagues) applies.
--      MatchHistoryScreen merges it into the list.
--
-- Existing ratings are NOT recomputed (new matches only). Re-runnable.
-- Apply: supabase db query --linked -f supabase/migration_tournament_match_plupr_history.sql
-- Test:  state/pkl-035-036-037-test.sql (begin ... rollback).
-- ============================================================


-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table public.tournament_matches
  add column if not exists completed_at        timestamptz,
  add column if not exists plupr_delta         numeric,
  add column if not exists plupr_league_id     uuid,
  add column if not exists plupr_global_weight numeric,
  add column if not exists plupr_category      text,
  add column if not exists plupr_ratings       jsonb,
  add column if not exists plupr_applied_at    timestamptz;

create index if not exists idx_tournament_matches_completed_at
  on public.tournament_matches (completed_at desc) where status = 'completed';


-- ── 2. Apply / reverse one player ───────────────────────────────────────────

-- Applies one player's delta through the canonical helpers and returns the
-- ratings around it: overall (before/after), the overall facet for this
-- match's category (fbefore/fafter), league (lbefore/lafter) and league facet
-- (lfbefore/lfafter). The helpers floor at 2.000, so these are the real moves.
create or replace function public._pl_tm_apply_one(
  p_league uuid, p_uid uuid, p_delta numeric, p_weight numeric, p_cat text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g0 numeric; g1 numeric; f0 numeric; f1 numeric;
  l0 numeric; l1 numeric; lf0 numeric; lf1 numeric;
begin
  if p_uid is null then return null; end if;
  select rating, case p_cat when 'singles' then singles_rating when 'gendered' then doubles_rating
                            when 'mixed' then mixed_doubles_rating end
    into g0, f0 from public.profiles where id = p_uid;
  if p_league is not null then
    -- No row yet: the helper creates it at the column defaults, 3.250.
    insert into public.league_player_ratings (league_id, user_id)
      values (p_league, p_uid) on conflict do nothing;
    select rating, case p_cat when 'singles' then singles_rating when 'gendered' then doubles_rating
                              when 'mixed' then mixed_doubles_rating end
      into l0, lf0 from public.league_player_ratings where league_id = p_league and user_id = p_uid;
    perform public._apply_plupr_delta_to_league(p_league, p_uid, p_delta, p_cat);
    select rating, case p_cat when 'singles' then singles_rating when 'gendered' then doubles_rating
                              when 'mixed' then mixed_doubles_rating end
      into l1, lf1 from public.league_player_ratings where league_id = p_league and user_id = p_uid;
  end if;
  perform public._apply_plupr_delta_to_global(p_uid, p_delta * p_weight, p_cat);
  select rating, case p_cat when 'singles' then singles_rating when 'gendered' then doubles_rating
                            when 'mixed' then mixed_doubles_rating end
    into g1, f1 from public.profiles where id = p_uid;
  return jsonb_build_object('before', g0, 'after', g1, 'fbefore', f0, 'fafter', f1,
                            'lbefore', l0, 'lafter', l1, 'lfbefore', lf0, 'lfafter', lf1,
                            'delta', p_delta);
end $$;
revoke all on function public._pl_tm_apply_one(uuid, uuid, numeric, numeric, text) from public, anon, authenticated;

-- Undoes what _pl_tm_apply_one did for one player: each rating by its recorded
-- move, and the league win or loss that the delta's sign added
-- (migration_plupr_weighted_scoring.sql:93-94). No floor here: each recorded
-- move is the real (already floored) one, so undoing every row of a tournament
-- in any order (a cascade delete) lands exactly on the start, where a floor
-- applied mid-way would make the result depend on the order. A correction
-- re-applies right after, through the flooring helpers.
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
           wins   = greatest(0, wins   - case when v_d > 0 then 1 else 0 end),
           losses = greatest(0, losses - case when v_d < 0 then 1 else 0 end),
           updated_at = now()
     where league_id = p_league and user_id = p_uid;
  end if;
end $$;
revoke all on function public._pl_tm_reverse_one(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Reverses everything a row recorded in plupr_ratings.
create or replace function public._pl_tm_reverse_row(
  p_league uuid, p_cat text, p_ratings jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
begin
  if p_ratings is null then return; end if;
  for k in select jsonb_object_keys(p_ratings) loop
    perform public._pl_tm_reverse_one(p_league, k::uuid, p_cat, p_ratings->k);
  end loop;
end $$;
revoke all on function public._pl_tm_reverse_row(uuid, text, jsonb) from public, anon, authenticated;


-- ── 3. The trigger ──────────────────────────────────────────────────────────
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

  new.plupr_delta := d1;
  new.plupr_league_id := v_league;
  new.plupr_global_weight := v_w;
  new.plupr_ratings := v_r;
  new.plupr_applied_at := now();
  return new;
end $$;
revoke all on function public._pl_tm_plupr() from public, anon, authenticated;

-- The old AFTER trigger goes; this one runs BEFORE so it can record what it
-- applied on the row itself. Named to sort after trg_lock_completed_tournament_match
-- and trg_require_complete_doubles_teams (BEFORE triggers fire in name order),
-- so a refused write never reaches it.
drop trigger if exists on_tournament_match_completed on public.tournament_matches;
drop trigger if exists trg_tm_plupr on public.tournament_matches;
create trigger trg_tm_plupr
  before insert or update or delete on public.tournament_matches
  for each row execute function public._pl_tm_plupr();

-- Kept for anything that still calls it by name; no trigger uses it now.
revoke all on function public.update_plupr_for_tournament_match() from public, anon, authenticated;


-- ── 4. recompute_all_plupr: league tournament matches also move overall PLUPR by half ──
-- As in migration_plupr_bigger_moves.sql (identical to the live copy,
-- checked 2026-11-18); only the tournament-match-in-a-league branch changes.
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


-- ── 5. Match history rows for tournament matches ────────────────────────────
create or replace function public.get_tournament_match_history(
  p_user_id   uuid    default null,
  p_league_id uuid    default null,
  p_limit     integer default 300
)
returns table (
  id uuid, tournament_id uuid, tournament_name text, league_id uuid, league_name text,
  round_label text, match_type text, doubles_category text,
  player1_id uuid, partner1_id uuid, player2_id uuid, partner2_id uuid,
  player1_score integer, player2_score integer, winner_team text,
  played_at timestamptz, game_scores jsonb, plupr_ratings jsonb,
  player1 jsonb, partner1 jsonb, player2 jsonb, partner2 jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with src as (
    select tm.*, t.name as t_name, t.league_id as t_league, r.label as r_label,
           coalesce(tm.completed_at, tm.scheduled_at, tm.created_at) as at
      from public.tournament_matches tm
      join public.tournaments t on t.id = tm.tournament_id
      left join public.tournament_rounds r on r.id = tm.round_id
     where tm.status = 'completed'
       and tm.winner_team in ('team1', 'team2')
       and tm.team1_player1 is not null and tm.team2_player1 is not null
       and (p_user_id is null
            or p_user_id in (tm.team1_player1, tm.team1_player2, tm.team2_player1, tm.team2_player2))
       and (p_league_id is null or t.league_id = p_league_id)
     order by at desc
     limit greatest(1, least(coalesce(p_limit, 300), 1000))
  )
  select x.id, x.tournament_id, x.t_name, x.t_league, l.name, x.r_label,
         x.match_type,
         case when x.match_type = 'doubles'
              then coalesce(x.plupr_category,
                            public.classify_doubles_match(x.team1_player1, x.team1_player2,
                                                          x.team2_player1, x.team2_player2))
         end,
         x.team1_player1, x.team1_player2, x.team2_player1, x.team2_player2,
         x.team1_score, x.team2_score, x.winner_team,
         x.at, x.game_scores, x.plupr_ratings,
         (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'name_color', p.name_color,
                                    'list_name_style_id', p.list_name_style_id, 'deleted_at', p.deleted_at)
            from public.profiles p where p.id = x.team1_player1),
         (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'name_color', p.name_color,
                                    'list_name_style_id', p.list_name_style_id, 'deleted_at', p.deleted_at)
            from public.profiles p where p.id = x.team1_player2),
         (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'name_color', p.name_color,
                                    'list_name_style_id', p.list_name_style_id, 'deleted_at', p.deleted_at)
            from public.profiles p where p.id = x.team2_player1),
         (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'name_color', p.name_color,
                                    'list_name_style_id', p.list_name_style_id, 'deleted_at', p.deleted_at)
            from public.profiles p where p.id = x.team2_player2)
    from src x
    left join public.leagues l on l.id = x.t_league
   order by x.at desc
$$;
revoke all on function public.get_tournament_match_history(uuid, uuid, integer) from public, anon;
grant execute on function public.get_tournament_match_history(uuid, uuid, integer) to authenticated;

notify pgrst, 'reload schema';
