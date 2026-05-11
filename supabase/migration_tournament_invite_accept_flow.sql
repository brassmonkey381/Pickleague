-- ============================================================
-- Convert tournament direct invites into a real two-step flow:
--
--   admin invites user  → invitee gets a pending registration with
--                          invited_by = admin and a notification
--   user accepts        → status flips to 'approved' AND the admin
--                          who invited gets a notification
--   user declines       → status flips to 'rejected' AND the admin
--                          gets a notification (so they can plan)
--
-- Mirrors the existing MLP invite-accept pattern.  Drill requests
-- already work this way (via triggers, see migration_add_drilling.sql).
-- ============================================================

-- 1. Track who sent the invite (null when the user requested in themselves)
alter table public.tournament_registrations
  add column if not exists invited_by uuid references public.profiles(id) on delete set null;

-- 2. tournament_invite_player — switch from auto-approve to 'pending' invite.
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
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_id is null then
    return query select false, 'Pick a player'::text; return;
  end if;
  if p_user_id = v_uid then
    return query select false, 'You can''t invite yourself'::text; return;
  end if;

  -- Caller authority check (creator, tournament admin/co-admin, or league admin).
  select t.name, exists (
    select 1 from public.tournaments tt
    where tt.id = p_tournament_id
      and (
        tt.created_by = v_uid
        or exists (
          select 1 from public.tournament_registrations tr
          where tr.tournament_id = tt.id and tr.user_id = v_uid
            and tr.role in ('admin','co-admin') and tr.status = 'approved'
        )
        or (tt.league_id is not null and exists (
          select 1 from public.league_members
          where league_id = tt.league_id and user_id = v_uid and role in ('admin','co-admin')
        ))
      )
  )
  into v_tournament_name, v_is_admin
  from public.tournaments t
  where t.id = p_tournament_id;

  if v_tournament_name is null then
    return query select false, 'Tournament not found'::text; return;
  end if;
  if not v_is_admin then
    return query select false, 'Only tournament admins can invite'::text; return;
  end if;

  -- Caller's display name (for the notification body)
  select full_name into v_inviter_name from public.profiles where id = v_uid;

  select status into v_existing_status
    from public.tournament_registrations
   where tournament_id = p_tournament_id and user_id = p_user_id;

  if v_existing_status = 'approved' then
    return query select false, 'Player is already in this tournament'::text; return;
  elsif v_existing_status = 'pending' then
    -- Promote an existing join-request into an invite (set invited_by).
    update public.tournament_registrations
       set invited_by = v_uid
     where tournament_id = p_tournament_id and user_id = p_user_id;
  elsif v_existing_status is null then
    insert into public.tournament_registrations (tournament_id, user_id, status, invited_by)
    values (p_tournament_id, p_user_id, 'pending', v_uid);
  else
    -- 'rejected' or anything else → reset to a fresh invite.
    update public.tournament_registrations
       set status = 'pending', invited_by = v_uid
     where tournament_id = p_tournament_id and user_id = p_user_id;
  end if;

  -- Notify the invitee. The notifications RLS already allows tournament
  -- admins to insert for entity_type='tournament'.
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    p_user_id,
    'Tournament invite',
    format('%s invited you to "%s". Open the tournament to accept or decline.',
           coalesce(v_inviter_name, 'A tournament admin'), v_tournament_name),
    'tournament',
    p_tournament_id,
    'tournament'
  );

  return query select true, 'Invited'::text;
end;
$$;

grant execute on function public.tournament_invite_player(uuid, uuid) to authenticated;

-- 3. tournament_respond_to_invite — invitee accepts or declines.
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
  if v_reg.user_id <> v_uid then raise exception 'Only the invitee can respond'; end if;
  if v_reg.invited_by is null then raise exception 'This registration was not an invite'; end if;
  if v_reg.status <> 'pending' then raise exception 'Invite already %', v_reg.status; end if;

  select full_name into v_responder_name from public.profiles where id = v_uid;
  v_tournament_name := v_reg.tournament_name;

  if p_accept then
    update public.tournament_registrations
       set status = 'approved'
     where id = p_registration_id;

    -- Notify the inviter that the invite was accepted.
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (
      v_reg.invited_by,
      'Invite accepted',
      format('%s accepted your invitation to "%s".',
             coalesce(v_responder_name, 'A player'), v_tournament_name),
      'tournament',
      v_reg.tournament_id,
      'tournament'
    );
  else
    update public.tournament_registrations
       set status = 'rejected'
     where id = p_registration_id;

    -- Notify the inviter that the invite was declined (so they can plan around it).
    insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
    values (
      v_reg.invited_by,
      'Invite declined',
      format('%s declined your invitation to "%s".',
             coalesce(v_responder_name, 'A player'), v_tournament_name),
      'tournament',
      v_reg.tournament_id,
      'tournament'
    );
  end if;
end;
$$;

grant execute on function public.tournament_respond_to_invite(uuid, boolean) to authenticated;
