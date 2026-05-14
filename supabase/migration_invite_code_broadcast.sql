-- ============================================================
-- In-app invite broadcast for invite_codes.
--
-- Adds send_invite_code_to_users(code_id, user_ids[]) so league /
-- tournament admins can fire a notification (with the code token
-- embedded) to a multi-selected set of players inside the app.
--
-- Tournament codes additionally pre-create a pending
-- tournament_registrations row tied to the code, so the recipient
-- can one-tap accept via the existing tournament_respond_to_invite
-- RPC — same UX as a direct admin invite.
--
-- League codes don't have a pending-registration concept; the
-- notification carries the token and the recipient enters it via
-- the existing "Join with Code" flow.
--
-- Run AFTER:
--   migration_unified_invite_codes.sql
--   migration_tournament_invite_accept_flow.sql
-- ============================================================

create or replace function public.send_invite_code_to_users(
  p_code_id  uuid,
  p_user_ids uuid[]
) returns table (success boolean, sent integer, skipped integer, message text)
language plpgsql security definer as $$
declare
  v_uid          uuid := auth.uid();
  v_code         public.invite_codes%rowtype;
  v_inviter      text;
  v_scope_name   text;
  v_scope_label  text;   -- "league" / "tournament"
  v_sent         integer := 0;
  v_skipped      integer := 0;
  v_user_id      uuid;
  v_existing     text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return query select false, 0, 0, 'Pick at least one player'::text; return;
  end if;

  select * into v_code from public.invite_codes where id = p_code_id;
  if v_code.id is null then
    return query select false, 0, 0, 'Code not found'::text; return;
  end if;
  if not v_code.is_active then
    return query select false, 0, 0, 'This code has been revoked'::text; return;
  end if;
  if v_code.expires_at <= now() then
    return query select false, 0, 0, 'This code has expired'::text; return;
  end if;
  if not public.is_scope_admin(v_code.scope_type, v_code.scope_id) then
    return query select false, 0, 0, 'Only scope admins can broadcast invites'::text; return;
  end if;

  v_scope_label := v_code.scope_type;
  if v_code.scope_type = 'league' then
    select name into v_scope_name from public.leagues where id = v_code.scope_id;
  elsif v_code.scope_type = 'tournament' then
    select name into v_scope_name from public.tournaments where id = v_code.scope_id;
  end if;
  if v_scope_name is null then
    return query select false, 0, 0, 'Scope not found'::text; return;
  end if;

  select full_name into v_inviter from public.profiles where id = v_uid;

  foreach v_user_id in array p_user_ids loop
    begin
      if v_user_id is null or v_user_id = v_uid then
        v_skipped := v_skipped + 1; continue;
      end if;
      if not exists (select 1 from public.profiles where id = v_user_id) then
        v_skipped := v_skipped + 1; continue;
      end if;

      -- Skip users who are already members of the scope.
      if v_code.scope_type = 'league' then
        if exists (
          select 1 from public.league_members
          where league_id = v_code.scope_id and user_id = v_user_id
        ) then
          v_skipped := v_skipped + 1; continue;
        end if;
      elsif v_code.scope_type = 'tournament' then
        select status into v_existing
          from public.tournament_registrations
          where tournament_id = v_code.scope_id and user_id = v_user_id;
        if v_existing = 'approved' then
          v_skipped := v_skipped + 1; continue;
        end if;

        -- Pre-create / refresh a pending registration linked to this code so
        -- the recipient gets the same one-tap accept UX as a direct invite.
        if v_existing is null then
          insert into public.tournament_registrations
            (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
          values
            (v_code.scope_id, v_user_id, 'pending', v_uid, v_code.id);
        else
          update public.tournament_registrations
             set status                  = 'pending',
                 invited_by              = v_uid,
                 redeemed_invite_code_id = v_code.id
           where tournament_id = v_code.scope_id and user_id = v_user_id;
        end if;
      end if;

      -- Notification — body includes the human-readable token so the
      -- recipient can also forward it offline.
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
      values (
        v_user_id,
        format('🎟️ Invite: %s', v_scope_name),
        format(
          '%s invited you to the %s "%s". Tap to open it, or use invite code %s to join.',
          coalesce(v_inviter, 'An admin'),
          v_scope_label,
          v_scope_name,
          v_code.token
        ),
        v_scope_label,
        v_code.scope_id,
        v_scope_label
      );

      v_sent := v_sent + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return query select true, v_sent, v_skipped,
    case when v_sent = 0 then 'No invites sent — everyone you picked is already in.'
         else format('Sent %s invite%s%s.',
              v_sent,
              case when v_sent = 1 then '' else 's' end,
              case when v_skipped > 0 then format(' (%s skipped)', v_skipped) else '' end)
    end::text;
end;
$$;

grant execute on function public.send_invite_code_to_users(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
