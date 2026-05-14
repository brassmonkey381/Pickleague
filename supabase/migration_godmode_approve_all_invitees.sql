-- ============================================================
-- Godmode shortcut: force-approve every pending/rejected
-- registration on a tournament in one shot.
--
-- The existing `_charge_tournament_ante` trigger (defined in
-- migration_unified_invite_codes.sql) fires automatically on
-- the status flip → pickle-ante accounting still happens.
-- ============================================================

create or replace function public.godmode_approve_all_invitees(p_tournament_id uuid)
returns table (approved_count integer, message text)
language plpgsql security definer as $$
declare
  v_tournament_name text;
  v_count           integer := 0;
  v_row             record;
begin
  if not public.is_godmode_user(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select name into v_tournament_name
    from public.tournaments
   where id = p_tournament_id;

  if v_tournament_name is null then
    raise exception 'Tournament not found';
  end if;

  for v_row in
    update public.tournament_registrations
       set status = 'approved'
     where tournament_id = p_tournament_id
       and status in ('pending', 'rejected')
    returning user_id
  loop
    v_count := v_count + 1;
    begin
      insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
      values (
        v_row.user_id,
        '🎟️ You''ve been added to a tournament',
        format('An admin force-approved your registration to "%s".', v_tournament_name),
        'tournament',
        p_tournament_id,
        'tournament'
      );
    exception when others then
      null;
    end;
  end loop;

  return query select v_count, format('Approved %s registration(s).', v_count);
end;
$$;

grant execute on function public.godmode_approve_all_invitees(uuid) to authenticated;

notify pgrst, 'reload schema';
