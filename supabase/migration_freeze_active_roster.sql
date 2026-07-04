-- Roster freeze while a tournament is ACTIVE.
--
-- Found by the ugly-path sweep: "Users can withdraw own registration" (RLS
-- DELETE) has no status guard, so an approved player could delete their
-- registration mid-bracket. Advancement triggers reconstruct round-1 slots
-- by ordering registrations on seed, and standings/payout queries join
-- registrations — a vanished row silently corrupts all of them. Admin kicks
-- (approved → rejected) mid-play corrupt the same queries.
--
-- Rule: once status = 'active', registration rows are frozen — no deletes,
-- no leaving 'approved'. Organizers handle no-shows by recording the
-- matches as forfeits/scores (or godmode repairs). Registration-phase and
-- post-completion behavior is unchanged (pre-lock withdrawals still refund
-- antes via trg_refund_ante_on_reg_change).

create or replace function public._freeze_active_tournament_roster()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_reg    record;
begin
  v_reg := case when tg_op = 'DELETE' then old else new end;

  -- Only transitions that remove someone from the live bracket matter.
  if tg_op = 'UPDATE' and not (old.status = 'approved' and new.status <> 'approved') then
    return new;
  end if;
  if tg_op = 'DELETE' and old.status <> 'approved' then
    return old;
  end if;

  select status into v_status from public.tournaments where id = v_reg.tournament_id;
  if v_status = 'active' and coalesce(auth.role(), '') <> 'service_role' and not public.is_godmode_user() then
    raise exception 'The roster is locked while the tournament is live. Record their remaining matches as forfeits instead.';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke execute on function public._freeze_active_tournament_roster() from public, anon, authenticated;

drop trigger if exists trg_freeze_active_roster on public.tournament_registrations;
create trigger trg_freeze_active_roster
  before update or delete on public.tournament_registrations
  for each row execute function public._freeze_active_tournament_roster();
