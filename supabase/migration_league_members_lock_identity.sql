-- ============================================================
-- A league membership can't be moved to another league or player
-- (presence privacy review, 2026-10-16).
--
-- "Admins can update member roles" (migration_add_roles_invites.sql) has no
-- WITH CHECK and no column list, and anon / authenticated held table-wide
-- UPDATE on league_members. Its USING clause (the caller administers the
-- row's league) doubled as the new-row check, so a league admin could rewrite
-- any membership row of a league they run, their own included, to another
-- league they run and to ANY user id. The victim became a member of a closed
-- league without joining it and without a notice (league_members has only
-- AFTER INSERT triggers). Presence trusts closed-league membership
-- (share_closed_league), so that named the victim at every court.
--
-- Now:
--   * clients may update only league_members.role (LeagueMembersScreen's
--     promote / demote). useLeagueJoin's upsert is ON CONFLICT DO NOTHING and
--     needs no UPDATE; expires_at is written only by SECURITY DEFINER code
--     (complete_guest_upgrade);
--   * a trigger refuses any change of league_id or user_id, whoever runs it,
--     in case a later migration grants UPDATE again. No server function moves
--     a membership: leave, then join.
--
-- Stands alone (no presence objects needed). Presence apply order: this file
-- first, then migration_presence_p1_schema.sql (see its APPLY ORDER). No
-- begin/commit; idempotent.
-- ============================================================

revoke update on public.league_members from anon, authenticated;
grant update (role) on public.league_members to authenticated;

create or replace function public._league_members_lock_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.league_id is distinct from old.league_id or new.user_id is distinct from old.user_id then
    raise exception 'A league membership cannot be moved; remove it and add a new one'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._league_members_lock_identity() from public, anon, authenticated;

drop trigger if exists trg_league_members_lock_identity on public.league_members;
create trigger trg_league_members_lock_identity
  before update of league_id, user_id on public.league_members
  for each row execute function public._league_members_lock_identity();
