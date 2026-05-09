-- ============================================================
-- Godmode delete policies
-- Allows the "godmode" account (Brian Stockman, user_id
-- 252a36e1-5d89-4ad2-8a3e-b786579f019a) to delete leagues and
-- tournaments. Identified by auth user ID for stability — names
-- and usernames can change, IDs cannot.
--
-- Cascading FK deletes on league_members, matches, tournaments,
-- league_seasons, tournament_rounds, tournament_matches, etc. are
-- already declared with `on delete cascade`, so deleting a league
-- or tournament cleans up everything beneath it automatically.
-- ============================================================

-- Helper: returns true if the calling user qualifies for godmode.
create or replace function public.is_godmode_user()
returns boolean language sql stable security definer as $$
  select auth.uid() = '252a36e1-5d89-4ad2-8a3e-b786579f019a'::uuid;
$$;

grant execute on function public.is_godmode_user() to authenticated;

-- Leagues — godmode can delete any league.
drop policy if exists "Godmode can delete leagues" on public.leagues;
create policy "Godmode can delete leagues"
  on public.leagues
  for delete
  using (public.is_godmode_user());

-- Tournaments — godmode can delete any tournament.
drop policy if exists "Godmode can delete tournaments" on public.tournaments;
create policy "Godmode can delete tournaments"
  on public.tournaments
  for delete
  using (public.is_godmode_user());
