-- ============================================================
-- Tournament direct invites carry an invite code in the notification.
--
-- Extends tournament_invite_player to additionally:
--   * Mint a single-use invite_codes row scoped to the tournament,
--     owned by the inviter (so any subsidy accounting they configure
--     on the code applies).
--   * Link the new (or refreshed) registration to that code via
--     redeemed_invite_code_id, so when the invitee accepts the
--     existing _charge_tournament_ante trigger honors the subsidy.
--   * Embed the human-readable token in the notification body so
--     the recipient can either one-tap accept inside the app or
--     forward the code to someone else.
--
-- Run AFTER:
--   migration_tournament_invite_accept_flow.sql
--   migration_unified_invite_codes.sql
-- ============================================================

-- The prior version returned (success boolean, message text). Postgres
-- won't let CREATE OR REPLACE change the OUT-parameter row type, so we
-- drop first and recreate.
drop function if exists public.tournament_invite_player(uuid, uuid);

create or replace function public.tournament_invite_player(
  p_tournament_id uuid,
  p_user_id       uuid
) returns table (success boolean, message text, invite_token text)
language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_tournament_name text;
  v_inviter_name    text;
  v_is_admin        boolean;
  v_existing_status text;
  v_code_id         uuid;
  v_code_token      text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_user_id is null then
    return query select false, 'Pick a player'::text, null::text; return;
  end if;
  if p_user_id = v_uid then
    return query select false, 'You can''t invite yourself'::text, null::text; return;
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
    return query select false, 'Tournament not found'::text, null::text; return;
  end if;
  if not v_is_admin then
    return query select false, 'Only tournament admins can invite'::text, null::text; return;
  end if;

  -- Caller's display name (for the notification body)
  select full_name into v_inviter_name from public.profiles where id = v_uid;

  -- Mint a single-use code for this invite. max_uses=1 so it can't be
  -- forwarded indefinitely; default 7-day expiry. No subsidy by default —
  -- admins can mint subsidized codes separately via create_invite_code.
  insert into public.invite_codes
    (scope_type, scope_id, created_by, max_uses, expires_at, pickle_subsidy)
  values
    ('tournament', p_tournament_id, v_uid, 1, now() + interval '7 days', 0)
  returning id, token into v_code_id, v_code_token;

  select status into v_existing_status
    from public.tournament_registrations
   where tournament_id = p_tournament_id and user_id = p_user_id;

  if v_existing_status = 'approved' then
    return query select false, 'Player is already in this tournament'::text, null::text; return;
  elsif v_existing_status = 'pending' then
    -- Promote an existing join-request into an invite (set invited_by + link code).
    update public.tournament_registrations
       set invited_by              = v_uid,
           redeemed_invite_code_id = v_code_id
     where tournament_id = p_tournament_id and user_id = p_user_id;
  elsif v_existing_status is null then
    insert into public.tournament_registrations
      (tournament_id, user_id, status, invited_by, redeemed_invite_code_id)
    values (p_tournament_id, p_user_id, 'pending', v_uid, v_code_id);
  else
    -- 'rejected' or anything else → reset to a fresh invite.
    update public.tournament_registrations
       set status                  = 'pending',
           invited_by              = v_uid,
           redeemed_invite_code_id = v_code_id
     where tournament_id = p_tournament_id and user_id = p_user_id;
  end if;

  -- Notify the invitee. The body includes the code so they can either
  -- accept in-app or forward the token if they prefer.
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    p_user_id,
    format('🎟️ Tournament invite: %s', v_tournament_name),
    format(
      '%s invited you to "%s". Tap to accept or decline — or use invite code %s if you''d rather join by code.',
      coalesce(v_inviter_name, 'A tournament admin'),
      v_tournament_name,
      v_code_token
    ),
    'tournament',
    p_tournament_id,
    'tournament'
  );

  return query select true, 'Invited'::text, v_code_token;
end;
$$;

grant execute on function public.tournament_invite_player(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
