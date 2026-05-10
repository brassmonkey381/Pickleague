-- ============================================================
-- MLP follow-ups:
--   1. Captain auto-slots into their gender's first open slot when
--      they create the team.
--   2. mlp_invite / mlp_request_join drop notifications on the
--      target user.
--   3. mlp_respond_to_join drops a notification on the original
--      inviter (captain) when a player accepts an invite, and on
--      the original requester (player) when the captain accepts
--      their join request.
-- ============================================================

-- 1. create_mlp_team — also fill the captain's gender slot --------------
create or replace function public.create_mlp_team(
  p_tournament_id uuid,
  p_name          text
) returns uuid language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_format    text;
  v_team_id   uuid;
  v_existing  uuid;
  v_gender    text;
  v_male1     uuid := null;
  v_male2     uuid := null;
  v_female1   uuid := null;
  v_female2   uuid := null;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if length(coalesce(trim(p_name), '')) = 0 then raise exception 'Team name required'; end if;

  select format into v_format from public.tournaments where id = p_tournament_id;
  if v_format is null then raise exception 'Tournament not found'; end if;
  if v_format <> 'mlp' then raise exception 'Only MLP Fixed Teams tournaments accept self-formed teams'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = p_tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into this tournament before creating a team';
  end if;

  select id into v_existing from public.mlp_teams
   where tournament_id = p_tournament_id
     and v_uid in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
   limit 1;
  if v_existing is not null then
    raise exception 'You''re already on a team in this tournament';
  end if;

  -- Captain auto-slots based on their gender (male/other → male_1, female → female_1).
  select gender into v_gender from public.profiles where id = v_uid;
  if v_gender is null or v_gender = 'prefer-not-to-say' then
    raise exception 'Set your gender (male/female/other) on your profile before creating a team';
  end if;

  if v_gender = 'female' then v_female1 := v_uid;
  else                        v_male1   := v_uid;
  end if;

  insert into public.mlp_teams (
    tournament_id, name, captain_id, male_1_id, male_2_id, female_1_id, female_2_id
  ) values (
    p_tournament_id, trim(p_name), v_uid, v_male1, v_male2, v_female1, v_female2
  ) returning id into v_team_id;

  return v_team_id;
end;
$$;

-- 2. Notify-helper to keep the four functions tidy ------------------------
create or replace function public._notify_user(
  p_user_id     uuid,
  p_title       text,
  p_body        text,
  p_entity_id   uuid,
  p_entity_type text
) returns void language plpgsql security definer as $$
begin
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (p_user_id, p_title, p_body, 'tournament', p_entity_id, p_entity_type);
exception when others then
  -- Notification insert failures shouldn't break the parent flow.
  null;
end;
$$;

-- 3. mlp_invite — same logic + notify the invitee ------------------------
create or replace function public.mlp_invite(
  p_team_id uuid,
  p_user_id uuid,
  p_message text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_captain         uuid;
  v_status          text;
  v_tournament_id   uuid;
  v_team_name       text;
  v_tournament_name text;
  v_captain_name    text;
  v_req_id          uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select t.captain_id, t.status, t.tournament_id, t.name, tr.name, p.full_name
    into v_captain, v_status, v_tournament_id, v_team_name, v_tournament_name, v_captain_name
    from public.mlp_teams t
    join public.tournaments tr on tr.id = t.tournament_id
    left join public.profiles p on p.id = v_uid
   where t.id = p_team_id;

  if v_captain is null then raise exception 'Team not found'; end if;
  if v_uid <> v_captain then raise exception 'Only the captain can invite'; end if;
  if v_status <> 'forming' then raise exception 'Team is locked'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_tournament_id and user_id = p_user_id and status = 'approved'
  ) then
    raise exception 'Invitee must be approved into the tournament first';
  end if;

  insert into public.mlp_team_join_requests (team_id, user_id, direction, message, status)
  values (p_team_id, p_user_id, 'invite', p_message, 'pending')
  on conflict (team_id, user_id, direction) do update
    set status = 'pending', message = excluded.message, responded_at = null
  returning id into v_req_id;

  perform public._notify_user(
    p_user_id,
    'MLP team invite',
    format('%s invited you to join %s in %s. Open the tournament to respond.',
           coalesce(v_captain_name, 'A captain'), v_team_name, v_tournament_name),
    v_tournament_id,
    'tournament'
  );

  return v_req_id;
end;
$$;

-- 4. mlp_request_join — same logic + notify the team captain --------------
create or replace function public.mlp_request_join(
  p_team_id uuid,
  p_message text default null
) returns uuid language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_team_record     record;
  v_tournament_name text;
  v_player_name     text;
  v_req_id          uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select t.id, t.status, t.tournament_id, t.name, t.captain_id, tr.name as tname, p.full_name as player_name
    into v_team_record
    from public.mlp_teams t
    join public.tournaments tr on tr.id = t.tournament_id
    left join public.profiles p on p.id = v_uid
   where t.id = p_team_id;

  if v_team_record.id is null then raise exception 'Team not found'; end if;
  if v_team_record.status <> 'forming' then raise exception 'Team is locked'; end if;

  if not exists (
    select 1 from public.tournament_registrations
     where tournament_id = v_team_record.tournament_id and user_id = v_uid and status = 'approved'
  ) then
    raise exception 'You must be approved into the tournament before requesting to join a team';
  end if;

  if exists (
    select 1 from public.mlp_teams
     where tournament_id = v_team_record.tournament_id
       and v_uid in (captain_id, male_1_id, male_2_id, female_1_id, female_2_id)
  ) then
    raise exception 'You''re already on a team in this tournament';
  end if;

  insert into public.mlp_team_join_requests (team_id, user_id, direction, message, status)
  values (p_team_id, v_uid, 'request', p_message, 'pending')
  on conflict (team_id, user_id, direction) do update
    set status = 'pending', message = excluded.message, responded_at = null
  returning id into v_req_id;

  -- Notify captain (if any)
  if v_team_record.captain_id is not null then
    perform public._notify_user(
      v_team_record.captain_id,
      'New join request',
      format('%s wants to join %s. Open the tournament to accept or decline.',
             coalesce(v_team_record.player_name, 'Someone'), v_team_record.name),
      v_team_record.tournament_id,
      'tournament'
    );
  end if;

  return v_req_id;
end;
$$;

-- 5. mlp_respond_to_join — notify the other party on accept ---------------
create or replace function public.mlp_respond_to_join(
  p_request_id uuid,
  p_accept     boolean
) returns void language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_req             record;
  v_team            record;
  v_gender          text;
  v_target_slot     text;
  v_responder_name  text;
  v_tournament_name text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_req from public.mlp_team_join_requests where id = p_request_id;
  if v_req.id is null then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'Request already %', v_req.status; end if;

  select * into v_team from public.mlp_teams where id = v_req.team_id;
  if v_team.id is null then raise exception 'Team not found'; end if;
  if v_team.status <> 'forming' then raise exception 'Team is locked'; end if;

  if v_req.direction = 'invite' then
    if v_uid <> v_req.user_id then raise exception 'Only the invitee can respond'; end if;
  else
    if v_uid <> v_team.captain_id then raise exception 'Only the captain can respond'; end if;
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
  if v_gender is null or v_gender = 'prefer-not-to-say' then
    raise exception 'Player must set their gender (male/female/other) before joining a team';
  end if;

  if v_gender = 'female' then
    if v_team.female_1_id is null then v_target_slot := 'female_1';
    elsif v_team.female_2_id is null then v_target_slot := 'female_2';
    else raise exception 'Both female slots are full';
    end if;
  else
    if v_team.male_1_id is null then v_target_slot := 'male_1';
    elsif v_team.male_2_id is null then v_target_slot := 'male_2';
    else raise exception 'Both male slots are full';
    end if;
  end if;

  execute format(
    'update public.mlp_teams set %I_id = $1 where id = $2',
    v_target_slot
  ) using v_req.user_id, v_team.id;

  update public.mlp_team_join_requests
     set status = 'accepted', responded_at = now()
   where id = p_request_id;

  -- Notify the OTHER side that the join completed
  select p.full_name into v_responder_name from public.profiles p where p.id = v_uid;
  select t.name      into v_tournament_name from public.tournaments t where t.id = v_team.tournament_id;

  if v_req.direction = 'invite' then
    -- Captain originated the invite → captain gets notified the invitee accepted
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
    -- Player originated the request → player gets notified the captain accepted
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

grant execute on function public._notify_user(uuid, text, text, uuid, text)        to authenticated;
grant execute on function public.create_mlp_team(uuid, text)                       to authenticated;
grant execute on function public.mlp_invite(uuid, uuid, text)                      to authenticated;
grant execute on function public.mlp_request_join(uuid, text)                      to authenticated;
grant execute on function public.mlp_respond_to_join(uuid, boolean)                to authenticated;
