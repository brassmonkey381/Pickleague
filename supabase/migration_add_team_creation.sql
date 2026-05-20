-- tournaments.team_creation — captures whether the team-pairing for Doubles
-- or the team-rosters for MLP are user-defined ('fixed') or auto-generated
-- by the system ('random' / snake-draft).
--
-- For MLP, the legacy `format='mlp'` vs `format='mlp_random'` distinction
-- still encodes the same thing — the new column is duplicative for MLP and
-- authoritative for non-MLP doubles, where there was no prior column.
--
-- Singles tournaments ignore this value.

alter table public.tournaments
  add column if not exists team_creation text default 'fixed'
    check (team_creation in ('fixed', 'random'));

notify pgrst, 'reload schema';
