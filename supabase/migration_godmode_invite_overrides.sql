-- ============================================================
-- Godmode (Brian / bsaucey) bypasses for invite + confirm flows.
--
-- 1. confirm_match:        godmode confirms BOTH teams in one call.
-- 2. tournament_invite_player: godmode invites land as 'approved' and
--                               the notification reads "You've been added".
-- 3. tournament_respond_to_invite: godmode can accept/decline on
--                                   anyone's behalf.
-- 4. mlp_invite:           godmode invites auto-slot the player (subject
--                           to the same gender/approval data requirements).
-- 5. mlp_respond_to_join:  godmode can respond as either party.
--
-- Match-entry client-side godmode bypass (status='completed' on insert
-- with both team confirms filled) is wired up in MatchEntryScreen.tsx —
-- the existing trigger already applies PLUPR when status='completed'
-- on insert, so no SQL change needed for that piece.
-- ============================================================


-- 1. confirm_match: when caller is godmode, fill BOTH team slots ----------
create or replace function public.confirm_match(p_match_id uuid)
returns text language plpgsql security definer as $$
declare
  v_uid    uuid := auth.uid();
  v_match  record;
  v_team   text;
  v_both   boolean := false;
  v_god    boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_match from public.matches where id = p_match_id;
  if v_match.id is null then raise exception 'Match not found'; end if;
  if v_match.status <> 'pending' then
    raise exception 'Match is no longer pending';
  end if;
  if v_match.confirm_deadline is not null and v_match.confirm_deadline < now() then
    raise exception 'Confirmation window has expired';
  end if;

  v_god := public.is_godmode_user();

  -- Godmode: fill both team slots in one shot, status flips to completed.
  if v_god then
    update public.matches
       set team1_confirmed_by = coalesce(team1_confirmed_by, v_uid),
           team2_confirmed_by = coalesce(team2_confirmed_by, v_uid),
           status             = 'completed'
     where id = p_match_id;
    return 'completed';
  end if;

  -- Non-godmode: must be on the match
  if    v_uid in (v_match.player1_id, v_match.partner1_id) then v_team := 'team1';
  elsif v_uid in (v_match.player2_id, v_match.partner2_id) then v_team := 'team2';
  else  raise exception 'Only players on this match can confirm it';
  end if;

  if v_team = 'team1' then
    update public.matches set team1_confirmed_by = v_uid where id = p_match_id;
  else
    update public.matches set team2_confirmed_by = v_uid where id = p_match_id;
  end if;

  select (team1_confirmed_by is not null and team2_confirmed_by is not null)
    into v_both from public.matches where id = p_match_id;
  if v_both then
    update public.matches set status = 'completed' where id = p_match_id;
    return 'completed';
  end if;
  return 'one_team_confirmed';
end;
$$;

grant execute on function public.confirm_match(uuid) to authenticated;


-- 2. tournament_invite_player: godmode invites land approved -------------
create or replace function public.tournament_invite_player(
  p_tournament_id uuid,
  p_user_id       uuid
) returns table (success boolean, message text)
language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_tournament_name text;
  v_inviter_name    text;
  v_is_admin        boolean;
  v_existing_status text;
  v_god             boolean := public.is_godmode_user();
  v_target_status   text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_id is null then return query select false, 'Pick a player'::text; return; end if;
  if p_user_id = v_uid then return query select false, 'You can''t invite yourself'::text; return; end if;

  select t.name, (
    v_god
    or t.created_by = v_uid
    or exists (
      select 1 from public.tournament_registrations tr
       where tr.tournament_id = t.id and tr.user_id = v_uid
         and tr.role in ('admin','co-admin') and tr.status = 'approved'
    )
    or (t.league_id is not null and exists (
      select 1 from public.league_members
       where league_id = t.league_id and user_id = v_uid and role in ('admin','co-admin')
    ))
  )
  into v_tournament_name, v_is_admin
  from public.tournaments t
  where t.id = p_tournament_id;

  if v_tournament_name is null then return query select false, 'Tournament not found'::text; return; end if;
  if not v_is_admin           then return query select false, 'Only tournament admins can invite'::text; return; end if;

  select full_name into v_inviter_name from public.profiles where id = v_uid;

  -- Godmode auto-accepts; everyone else goes through the pending flow.
  v_target_status := case when v_god then 'approved' else 'pending' end;

  select status into v_existing_status
    from public.tournament_registrations
   where tournament_id = p_tournament_id and user_id = p_user_id;

  if v_existing_status = 'approved' then
    return query select false, 'Player is already in this tournament'::text; return;
  elsif v_existing_status = 'pending' then
    update public.tournament_registrations
       set status = v_target_status, invited_by = v_uid
     where tournament_id = p_tournament_id and user_id = p_user_id;
  elsif v_existing_status is null then
    insert into public.tournament_registrations (tournament_id, user_id, status, invited_by)
    values (p_tournament_id, p_user_id, v_target_status, v_uid);
  else
    update public.tournament_registrations
       set status = v_target_status, invited_by = v_uid
     where tournament_id = p_tournament_id and user_id = p_user_id;
  end if;

  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    p_user_id,
    case when v_god then 'You''re in!' else 'Tournament invite' end,
    case when v_god
      then format('%s added you to "%s".', coalesce(v_inviter_name, 'A tournament admin'), v_tournament_name)
      else format('%s invited you to "%s". Open the tournament to accept or decline.',
                  coalesce(v_inviter_name, 'A tournament admin'), v_tournament_name)
    end,
    'tournament', p_tournament_id, 'tournament'
  );

  return query select true, (case when v_god then 'Added' else 'Invited' end)::text;
end;
$$;

grant execute on function public.tournament_invite_player(uuid, uuid) to authenticated;


-- 3. tournament_respond_to_invite: godmode can respond for anyone --------
create or replace function public.tournament_respond_to_invite(
  p_registration_id uuid,
  p_accept          boolean
) returns void
language plpgsql security definer as $$
declare
  v_uid              uuid := auth.uid();
  v_reg              record;
  v_tournament_name  text;
  v_responder_name   text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select tr.*, t.name as tournament_name
    into v_reg
    from public.tournament_registrations tr
    join public.tournaments t on t.id = tr.tournament_id
   where tr.id = p_registration_id;

  if v_reg.id is null then raise exception 'Invite not found'; end if;
  -- Godmode bypass: caller doesn't have to be the invitee.
  if v_reg.user_id <> v_uid and not public.is_godmode_user() then
    raise exception 'Only the invitee can respond';
  end if;
  if v_reg.invited_by is null then raise exception 'This registration was not an invite'; end if;
  if v_reg.status <> 'pending' then raise exception 'Invite already %', v_reg.status; end if;

  select full_name into v_responder_name from public.profiles where id = v_reg.user_id;
  v_tournament_name := v_reg.tournament_name;

  if p_accept then
    update public.tournament_registrations set status = 'approved' where id = p_registration_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (
      v_reg.invited_by,
      'Invite accepted',
      format('%s accepted your invitation to "%s".',
             coalesce(v_responder_name, 'A player'), v_tournament_name),
      'tournament', v_reg.tournament_id, 'tournament'
    );
  else
    update public.tournament_registrations set status = 'rejected' where id = p_registration_id;
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (
      v_reg.invited_by,
      'Invite declined',
      format('%s declined your invitation to "%s".',
             coalesce(v_responder_name, 'A player'), v_tournament_name),
      'tournament', v_reg.tournament_id, 'tournament'
    );
  end if;
end;
$$;

grant execute on function public.tournament_respond_to_invite(uuid, boolean) to authenticated;


-- 4. mlp_invite: godmode invites get auto-accepted via the existing
--    response function (which itself now has a godmode bypass — see #5).
-- ----------------------------------------------------------------------
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
  v_god             boolean := public.is_godmode_user();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select t.captain_id, t.status, t.tournament_id, t.name, tr.name, p.full_name
    into v_captain, v_status, v_tournament_id, v_team_name, v_tournament_name, v_captain_name
    from public.mlp_teams t
    join public.tournaments tr on tr.id = t.tournament_id
    left join public.profiles p on p.id = v_uid
   where t.id = p_team_id;

  if v_captain is null then raise exception 'Team not found'; end if;
  -- Godmode bypass: caller doesn't have to be the captain.
  if v_uid <> v_captain and not v_god then raise exception 'Only the captain can invite'; end if;
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

  -- Godmode: immediately accept the invite on the invitee's behalf.
  -- mlp_respond_to_join's own godmode bypass (added below) handles auth.
  if v_god then
    perform public.mlp_respond_to_join(v_req_id, true);
  end if;

  return v_req_id;
end;
$$;

grant execute on function public.mlp_invite(uuid, uuid, text) to authenticated;


-- 5. mlp_respond_to_join: godmode can respond as either party ------------
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
  if v_gender is null or v_gender = 'prefer-not-to-say' then
    raise exception 'Player must set their gender (male/female/other) before joining a team';
  end if;

  if v_gender = 'female' then
    if    v_team.female_1_id is null then v_target_slot := 'female_1';
    elsif v_team.female_2_id is null then v_target_slot := 'female_2';
    else  raise exception 'Both female slots are full';
    end if;
  else
    if    v_team.male_1_id is null then v_target_slot := 'male_1';
    elsif v_team.male_2_id is null then v_target_slot := 'male_2';
    else  raise exception 'Both male slots are full';
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
