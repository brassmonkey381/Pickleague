-- Best-of-N matches: per-game score breakdown. For single-game matches
-- game_scores remains null and existing columns (player1_score/team1_score)
-- hold the per-game score. For multi-game matches game_scores holds the
-- array [{"t1": 11, "t2": 9}, ...] and the existing point columns hold the
-- SUM of points across games (preserves PLUPR delta math, which is based
-- on point totals). winner_team is derived from games-won-majority.

alter table public.matches            add column if not exists game_scores jsonb;
alter table public.tournament_matches add column if not exists game_scores jsonb;
