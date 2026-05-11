-- ============================================================
-- Godmode delete RPCs (bypass RLS entirely).
--
-- The original migration_add_godmode_delete.sql adds RLS DELETE
-- policies on leagues/tournaments, but those policies only work
-- if the migration was actually applied to the production project
-- and if no other RLS policy on the table contradicts them.  These
-- SECURITY DEFINER RPCs are bulletproof: they check is_godmode_user()
-- inside the function and then do the delete as the function owner,
-- which is `postgres` and is not subject to RLS.
-- ============================================================

create or replace function public.godmode_delete_tournament(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_godmode_user() then
    raise exception 'Not authorized';
  end if;
  delete from public.tournaments where id = p_tournament_id;
end;
$$;

revoke all on function public.godmode_delete_tournament(uuid) from public;
grant execute on function public.godmode_delete_tournament(uuid) to authenticated;

create or replace function public.godmode_delete_league(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_godmode_user() then
    raise exception 'Not authorized';
  end if;
  delete from public.leagues where id = p_league_id;
end;
$$;

revoke all on function public.godmode_delete_league(uuid) from public;
grant execute on function public.godmode_delete_league(uuid) to authenticated;
