-- ============================================================
-- Manual admin "Complete Tournament" RPC
--
-- Escape hatch for tournament admins to flip a tournament's
-- status to 'completed' when the auto-close path doesn't apply
-- (e.g. non-MLP formats, or an MLP series that needs to be
-- closed early for any reason). Payout still happens via the
-- existing auto_payout_* RPCs after the tournament is completed.
--
-- Mirrors the SECURITY DEFINER + is_scope_admin pattern used in
-- migration_tournament_auto_close_payout.sql.
-- ============================================================

create or replace function public.admin_complete_tournament(p_tournament_id uuid)
returns table (success boolean, message text)
language plpgsql security definer as $$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_scope_admin('tournament', p_tournament_id) then
    return query select false, 'Only tournament admins can complete'::text;
    return;
  end if;

  select status into v_status
    from public.tournaments
   where id = p_tournament_id;

  if v_status is null then
    return query select false, 'Tournament not found.'::text;
    return;
  end if;

  if v_status = 'completed' then
    return query select false, 'Tournament already completed.'::text;
    return;
  end if;

  if v_status = 'cancelled' then
    return query select false, 'Tournament is cancelled — cannot complete.'::text;
    return;
  end if;

  if v_status not in ('active', 'registration') then
    return query select false, format('Cannot complete a tournament in status "%s".', v_status)::text;
    return;
  end if;

  update public.tournaments
     set status = 'completed'
   where id = p_tournament_id;

  return query select true, 'Tournament completed.'::text;
end;
$$;

grant execute on function public.admin_complete_tournament(uuid) to authenticated;

notify pgrst, 'reload schema';
