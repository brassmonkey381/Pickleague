-- ============================================================
-- Tournament invite RPC — admin adds an approved registration on
-- behalf of a player (since tournament_registrations RLS only lets
-- users insert their own rows) and notifies the player.
-- ============================================================

create or replace function public.tournament_invite_player(
  p_tournament_id uuid,
  p_user_id       uuid
) returns table (success boolean, message text)
language plpgsql security definer as $$
declare
  v_uid             uuid := auth.uid();
  v_tournament_name text;
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

  -- Caller must be tournament admin / co-admin (or creator), or a league
  -- admin if the tournament is league-scoped.
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

  -- Already in the tournament?
  select status into v_existing_status
    from public.tournament_registrations
   where tournament_id = p_tournament_id and user_id = p_user_id;

  if v_existing_status = 'approved' then
    return query select false, 'Player is already approved'::text; return;
  elsif v_existing_status = 'pending' then
    -- Promote pending to approved
    update public.tournament_registrations
       set status = 'approved'
     where tournament_id = p_tournament_id and user_id = p_user_id;
  elsif v_existing_status is null then
    -- Fresh insert as approved
    insert into public.tournament_registrations (tournament_id, user_id, status)
    values (p_tournament_id, p_user_id, 'approved');
  else
    -- 'rejected' or other → flip back to approved
    update public.tournament_registrations
       set status = 'approved'
     where tournament_id = p_tournament_id and user_id = p_user_id;
  end if;

  -- Notify the player. The notifications RLS already lets tournament
  -- admins insert for entity_type='tournament'.
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    p_user_id,
    'You''re in!',
    format('A tournament admin added you to "%s". Open the tournament to see details.', v_tournament_name),
    'tournament',
    p_tournament_id,
    'tournament'
  );

  return query select true, 'Invited'::text;
end;
$$;

grant execute on function public.tournament_invite_player(uuid, uuid) to authenticated;
