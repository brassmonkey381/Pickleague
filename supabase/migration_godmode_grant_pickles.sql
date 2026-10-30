-- ============================================================
-- God mode: grant myself any amount of pickles.
--
-- The user, 2026-10-29: "please give my godmode console the ability to gift
-- myself any amount of pickles." godmode_gift_pickles moves pickles from the
-- God mode balance to someone (so it can't top up the God mode account), and
-- claim_godmode_pickles grants a fixed 50,000 and isn't callable since the
-- RLS hardening. This one takes an amount.
--
--   * God mode only (is_godmode_user); anyone else gets success = false.
--   * 1 to 10,000,000 per call, and the balance can't pass 2,000,000,000
--     (profiles.pickles is an integer).
--   * Credits the caller only, never another player.
--   * The ledger shows it as "God mode top-up" (gold, admin), like
--     claim_godmode_pickles: pickle_ledger_sources gets a row for it.
--
-- Re-runnable. Grants itself to authenticated and is on the allowlist in
-- migration_rls_hardening_2026q3.sql, so a hardening re-run keeps it.
-- ============================================================

create or replace function public.godmode_grant_pickles(p_amount integer)
returns table (success boolean, new_balance integer, message text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_balance integer;
begin
  if v_uid is null or not public.is_godmode_user(v_uid) then
    return query select false, null::integer, 'Not authorized'::text; return;
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 10000000 then
    return query select false, null::integer, 'Pick an amount from 1 to 10,000,000.'::text; return;
  end if;

  select p.pickles into v_balance from public.profiles p where p.id = v_uid for update;
  if v_balance is null then
    return query select false, null::integer, 'Profile not found'::text; return;
  end if;
  if v_balance::bigint + p_amount > 2000000000 then
    return query select false, v_balance, 'That would pass 2,000,000,000 pickles.'::text; return;
  end if;

  update public.profiles set pickles = pickles + p_amount
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_balance, format('Granted %s pickles', to_char(p_amount, 'FM999,999,999'));
end $$;

revoke all on function public.godmode_grant_pickles(integer) from public, anon;
grant execute on function public.godmode_grant_pickles(integer) to authenticated, service_role;

insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  ('godmode_grant_pickles', 1, 'God mode top-up', 'bonus', 'admin', true, 'an admin grant, not earned')
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;
