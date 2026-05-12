-- ============================================================
-- DESTRUCTIVE RESET — clears all match history and rebases PLUPRs.
--
-- This wipes:
--   * matches (league + casual)
--   * tournament_matches (bracket play)
--   * tournament_rounds (the round containers — re-generated when a
--     tournament re-runs a bracket)
--   * season_snapshots + season_final_standings (derived from matches)
--   * player_location_ratings (per-court PLUPR, derived from matches)
--
-- And rebases:
--   * profiles.{rating, singles_rating, doubles_rating, mixed_doubles_rating} → 3.250
--   * profiles.total_matches_played → 0
--   * profiles.last_match_at → null
--   * league_player_ratings.{ratings, wins, losses} → base
--   * tournaments.bonuses_applied_at → null  (so finishes can be re-awarded)
--
-- It does NOT touch:
--   * profiles.pickles (currency stays)
--   * Tournament registrations / MLP teams / drill requests / sessions
--   * Notifications
--   * Leagues, league memberships, league seasons
--
-- Wrap in BEGIN/ROLLBACK in the SQL Editor if you want a dry-run.  All
-- statements are idempotent — re-running this on an already-reset DB is
-- a no-op.
-- ============================================================

do $$
declare
  v_match_rows           integer;
  v_tm_rows              integer;
  v_round_rows           integer;
  v_snapshot_rows        integer;
  v_final_rows           integer;
  v_court_rating_rows    integer;
begin
  select count(*) into v_match_rows         from public.matches;
  select count(*) into v_tm_rows            from public.tournament_matches;
  select count(*) into v_round_rows         from public.tournament_rounds;
  select count(*) into v_snapshot_rows      from public.season_snapshots;
  select count(*) into v_final_rows         from public.season_final_standings;
  select count(*) into v_court_rating_rows  from public.player_location_ratings;

  raise notice '── Before reset ──';
  raise notice '  matches:                 %', v_match_rows;
  raise notice '  tournament_matches:      %', v_tm_rows;
  raise notice '  tournament_rounds:       %', v_round_rows;
  raise notice '  season_snapshots:        %', v_snapshot_rows;
  raise notice '  season_final_standings:  %', v_final_rows;
  raise notice '  player_location_ratings: %', v_court_rating_rows;
end$$;

-- ── 1. Delete match data ─────────────────────────────────────────
-- Order matters: tournament_matches references tournament_rounds; matches
-- has its own trigger but we're deleting outright so triggers don't fire
-- on UPDATE.  on delete cascade on tournament_matches.round_id handles the
-- match→round side, but we also clear rounds explicitly so the next bracket
-- generation starts from a clean slate.
delete from public.tournament_matches;
delete from public.tournament_rounds;
delete from public.matches;

-- ── 2. Clear derived standings ───────────────────────────────────
delete from public.season_final_standings;
delete from public.season_snapshots;

-- ── 3. Clear court-specific PLUPRs ───────────────────────────────
delete from public.player_location_ratings;

-- ── 4. Rebase profile-level PLUPRs ───────────────────────────────
update public.profiles
   set rating               = 3.250,
       singles_rating       = 3.250,
       doubles_rating       = 3.250,
       mixed_doubles_rating = 3.250,
       total_matches_played = 0,
       last_match_at        = null;

-- ── 5. Rebase per-league PLUPRs (table from migration_plupr_weighted_scoring)
--      `if exists` so this migration is safe to run before that one too.
do $$ begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'league_player_ratings'
  ) then
    update public.league_player_ratings
       set rating               = 3.250,
           singles_rating       = 3.250,
           doubles_rating       = 3.250,
           mixed_doubles_rating = 3.250,
           wins                 = 0,
           losses               = 0,
           updated_at           = now();
  end if;
end$$;

-- ── 6. Unlock tournaments so finishes can be re-awarded ──────────
do $$ begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'tournaments'
       and column_name  = 'bonuses_applied_at'
  ) then
    update public.tournaments set bonuses_applied_at = null;
  end if;
end$$;

-- ── 7. Mark all seasons elo_reset_applied = false so complete_season
--      can re-fire on demand if needed.
update public.league_seasons set elo_reset_applied = false;

do $$
declare
  v_profile_count integer;
  v_lpr_avg       decimal;
begin
  select count(*) into v_profile_count from public.profiles;
  select avg(rating) into v_lpr_avg
    from public.profiles where rating is not null;
  raise notice '── After reset ──';
  raise notice '  profiles rebased: % (avg rating = %)', v_profile_count, v_lpr_avg;
  raise notice 'Done. All match history cleared; PLUPRs at base 3.250.';
end$$;
