-- Display-only tournament attribution for league matches recorded from Home.
--
-- A recorded match still REQUIRES a league (matches.league_id stays NOT NULL).
-- This adds an OPTIONAL tournament tag used purely for display/attribution.
-- It does NOT participate in any PLUPR / standings / bracket trigger logic;
-- none of the existing match triggers reference this column.
--
-- Idempotent: safe to re-run.
alter table public.matches
  add column if not exists tournament_id uuid
  references public.tournaments(id) on delete set null;
