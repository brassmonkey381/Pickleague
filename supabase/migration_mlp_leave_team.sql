-- ============================================================
-- MLP: members can leave a team they're on.
--
--   Captain leaves   → the whole team is deleted (which by FK
--                       cascade clears mlp_team_join_requests too).
--                       All other slot members become unattached and
--                       can join/create another team.
--   Non-captain leaves → only their slot is nulled out; team keeps
--                         forming with the remaining members.
--
-- Only allowed while the team is 'forming'.  Locked teams need an
-- admin/captain to unlock manually (or use mlp_set_slot to swap).
-- Tournament admins can also use this on behalf of any member.
-- ============================================================

create or replace function public.mlp_leave_team(p_team_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_uid          uuid := auth.uid();
  v_team         record;
  v_target_user  uuid := auth.uid();
  v_is_admin     boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_team from public.mlp_teams where id = p_team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_team.status <> 'forming' then
    raise exception 'Team is locked — ask the captain to unlock or use slot swap';
  end if;

  v_is_admin := public._is_tournament_admin(v_team.tournament_id, v_uid);

  -- Caller must be a member of this team (or a tournament admin acting on
  -- their own behalf).  Admins removing OTHER players should use
  -- mlp_set_slot to null the specific slot.
  if v_uid <> v_team.captain_id
     and v_uid <> v_team.male_1_id and v_uid <> v_team.male_2_id
     and v_uid <> v_team.female_1_id and v_uid <> v_team.female_2_id
     and not v_is_admin then
    raise exception 'Only members of this team can leave it';
  end if;

  -- Captain leaving → delete the whole team.  FK cascade on
  -- mlp_team_join_requests.team_id cleans up pending invites/requests.
  if v_target_user = v_team.captain_id then
    delete from public.mlp_teams where id = p_team_id;
    return;
  end if;

  -- Non-captain → null out only the leaver's slot.
  if v_target_user = v_team.male_1_id then
    update public.mlp_teams set male_1_id   = null where id = p_team_id;
  elsif v_target_user = v_team.male_2_id then
    update public.mlp_teams set male_2_id   = null where id = p_team_id;
  elsif v_target_user = v_team.female_1_id then
    update public.mlp_teams set female_1_id = null where id = p_team_id;
  elsif v_target_user = v_team.female_2_id then
    update public.mlp_teams set female_2_id = null where id = p_team_id;
  end if;
end;
$$;

revoke all on function public.mlp_leave_team(uuid) from public;
grant execute on function public.mlp_leave_team(uuid) to authenticated;
