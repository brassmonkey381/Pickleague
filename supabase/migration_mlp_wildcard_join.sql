-- ============================================================
-- mlp_respond_to_join: allow wildcard (no-gender / prefer-not-
-- to-say) players to join a team. They fill the side with more
-- open slots, falling back to male_1 / male_2 / female_1 /
-- female_2 in order. This mirrors the wildcard rule already used
-- by generate_random_mlp_teams.
--
-- Run AFTER migration_godmode_invite_overrides.sql (which is the
-- prior definition of mlp_respond_to_join).
-- ============================================================

create or replace function public.mlp_respond_to_join(
  p_request_id uuid,
  p_accept     boolean
) returns void
language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_req             record;
  v_team            record;
  v_gender          text;
  v_target_slot     text;
  v_responder_name  text;
  v_tournament_name text;
  v_god             boolean := public.is_godmode_user();
  v_male_open       integer;
  v_female_open     integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.mlp_team_join_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Request already %', v_req.status; end if;

  select * into v_team from public.mlp_teams where id = v_req.team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_team.status <> 'forming' then raise exception 'Team is locked'; end if;

  -- Godmode bypass: caller doesn't need to be the invitee or captain.
  if not v_god then
    if v_req.direction = 'invite' then
      if v_uid <> v_req.user_id then raise exception 'Only the invitee can respond'; end if;
    else
      if v_uid <> v_team.captain_id then raise exception 'Only the captain can respond'; end if;
    end if;
  end if;

  if not p_accept then
    update public.mlp_team_join_requests
       set status = 'declined', responded_at = now()
     where id = p_request_id;
    return;
  end if;

  -- Accept path
  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_team.tournament_id and user_id = v_req.user_id and status = 'approved'
  ) then
    raise exception 'User is no longer approved into the tournament';
  end if;
  if exists (
    select 1 from public.mlp_teams
     where tournament_id = v_team.tournament_id
       and id <> v_team.id
       and v_req.user_id in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
  ) then
    raise exception 'User is already on another team';
  end if;

  select gender into v_gender from public.profiles where id = v_req.user_id;

  -- ── Slot assignment ─────────────────────────────────────────────────
  -- Pure female → female slot. Pure male/other → male slot. Wildcards
  -- (null / prefer-not-to-say) fill whichever side has MORE open
  -- slots, defaulting to male on a tie. This matches the random
  -- generator's wildcard balancing.
  if v_gender = 'female' then
    if    v_team.female_1_id is null then v_target_slot := 'female_1';
    elsif v_team.female_2_id is null then v_target_slot := 'female_2';
    else  raise exception 'Both female slots are full';
    end if;
  elsif v_gender in ('male', 'other') then
    if    v_team.male_1_id is null then v_target_slot := 'male_1';
    elsif v_team.male_2_id is null then v_target_slot := 'male_2';
    else  raise exception 'Both male slots are full';
    end if;
  else
    -- Wildcard: pick the side with more open slots.
    v_male_open := (case when v_team.male_1_id   is null then 1 else 0 end)
                 + (case when v_team.male_2_id   is null then 1 else 0 end);
    v_female_open := (case when v_team.female_1_id is null then 1 else 0 end)
                   + (case when v_team.female_2_id is null then 1 else 0 end);

    if v_male_open + v_female_open = 0 then
      raise exception 'Team is full';
    end if;

    if v_male_open >= v_female_open then
      if    v_team.male_1_id   is null then v_target_slot := 'male_1';
      elsif v_team.male_2_id   is null then v_target_slot := 'male_2';
      elsif v_team.female_1_id is null then v_target_slot := 'female_1';
      else                                  v_target_slot := 'female_2';
      end if;
    else
      if    v_team.female_1_id is null then v_target_slot := 'female_1';
      elsif v_team.female_2_id is null then v_target_slot := 'female_2';
      elsif v_team.male_1_id   is null then v_target_slot := 'male_1';
      else                                  v_target_slot := 'male_2';
      end if;
    end if;
  end if;

  execute format('update public.mlp_teams set %I_id = $1 where id = $2', v_target_slot)
    using v_req.user_id, v_team.id;

  update public.mlp_team_join_requests
     set status = 'accepted', responded_at = now()
   where id = p_request_id;

  select p.full_name into v_responder_name from public.profiles p where p.id = v_req.user_id;
  select t.name      into v_tournament_name from public.tournaments t where t.id = v_team.tournament_id;

  if v_req.direction = 'invite' then
    -- Invitee accepted (or godmode forced) → notify captain
    if v_team.captain_id is not null and v_team.captain_id <> v_uid then
      perform public._notify_user(
        v_team.captain_id,
        'Invite accepted',
        format('%s joined %s in %s.',
               coalesce(v_responder_name, 'A player'), v_team.name, v_tournament_name),
        v_team.tournament_id,
        'tournament'
      );
    end if;
  else
    -- Captain accepted → notify the requester
    perform public._notify_user(
      v_req.user_id,
      'Join request accepted',
      format('Your request to join %s in %s was accepted.',
             v_team.name, v_tournament_name),
      v_team.tournament_id,
      'tournament'
    );
  end if;
end;
$$;

grant execute on function public.mlp_respond_to_join(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
