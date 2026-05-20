-- Tournaments.playoff_format — generalized playoff selector for non-MLP
-- formats (round_robin, pool_play). MLP keeps its own `mlp_playoff_teams`
-- column for the existing MLP playoff bracket. Future PRs will extend the
-- enum (top_4_de, top_8_de, etc.) when the bracket-generation SQL gains
-- the matching code paths.
--
-- Values today:
--   'none'   — no playoff; final standings come from group play
--   'top_2'  — Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4)
--   'top_4'  — Semifinals + Finals (single-elim)
--   'top_8'  — Quarterfinals + Semifinals + Finals (single-elim)
--
-- The picker in CreateTournamentScreen only surfaces this column when the
-- larger format is round_robin or pool_play. MLP tournaments continue to
-- use mlp_playoff_teams.

alter table public.tournaments
  add column if not exists playoff_format text not null default 'none'
    check (playoff_format in ('none', 'top_2', 'top_4', 'top_8'));

notify pgrst, 'reload schema';
