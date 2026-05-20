-- ============================================================
-- MLP Dreambreaker — singles tiebreaker (5th sub-match)
--
-- When the 4 doubles sub-matches end 2-2, MLP rules call for a
-- 5th sub-match: a singles "Dreambreaker" between one designated
-- player per team. Each captain picks their dreambreaker from
-- their own roster (any of the 4 slot players).
--
-- SCOPE OF THIS MIGRATION (intentionally small):
--   * Add nullable dreambreaker_player_id column to mlp_teams.
--   * Add SECURITY DEFINER RPC mlp_set_dreambreaker so captains
--     (and tournament admins) can set/clear it.
--
-- NOT IN THIS MIGRATION (deferred follow-up):
--   * Inserting the 5th sub-match in _insert_mlp_pairing_matches.
--   * Auto-creating the dreambreaker match when the 4 doubles
--     reach 2-2.
--   * UI for playing the dreambreaker match in tournament detail.
-- ============================================================

-- 1. Column ---------------------------------------------------------------
alter table public.mlp_teams
  add column if not exists dreambreaker_player_id uuid
    references public.profiles(id) on delete set null;

-- 2. mlp_set_dreambreaker — captain/admin sets or clears the singles pick.
--    Mirrors the permission shape of mlp_set_slot. The player must be on
--    the team's own roster (one of the 4 slot ids). Pass null to clear.
create or replace function public.mlp_set_dreambreaker(
  p_team_id uuid,
  p_user_id uuid
) returns void language plpgsql security definer as $$
declare
  v_uid  uuid := auth.uid();
  v_team record;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_team from public.mlp_teams where id = p_team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_uid <> v_team.captain_id and not public._is_tournament_admin(v_team.tournament_id, v_uid) then
    raise exception 'Only the captain or a tournament admin can set the dreambreaker';
  end if;

  if p_user_id is not null
     and p_user_id not in (
       coalesce(v_team.male_1_id,   '00000000-0000-0000-0000-000000000000'::uuid),
       coalesce(v_team.male_2_id,   '00000000-0000-0000-0000-000000000000'::uuid),
       coalesce(v_team.female_1_id, '00000000-0000-0000-0000-000000000000'::uuid),
       coalesce(v_team.female_2_id, '00000000-0000-0000-0000-000000000000'::uuid)
     )
  then
    raise exception 'Dreambreaker must be one of the team''s 4 roster players';
  end if;

  update public.mlp_teams
     set dreambreaker_player_id = p_user_id
   where id = p_team_id;
end;
$$;

grant execute on function public.mlp_set_dreambreaker(uuid, uuid) to authenticated;
