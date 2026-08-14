-- ============================================================
-- Welcome grant: 2500 -> 1000 (reverts part of
-- migration_bump_base_pickle_grants.sql).
--
-- That migration was an explicit pre-launch generosity bump for a small
-- friends-only user base, with a note to "rebalance before any wider release".
-- This is that rebalance for the signup grant specifically.
--
-- It also fixes a copy inconsistency: the welcome modal in HomeScreen.tsx has
-- always read "Here's 1,000 pickles to get you started", so a new account was
-- told 1,000 and handed 2,500 in the same dialog.
--
-- Deliberately NOT reverted here, because they are earned rather than granted
-- at signup and were not part of the complaint:
--   first match   500  (_grant_first_match_bonus)
--   badge earned  150  (_grant_pickles_on_badge)
--
-- Forward-looking only. Accounts that already claimed 2,500 keep it; the
-- one-time flag profiles.welcome_pickles_granted means they cannot re-claim.
-- To pull the extra 1,500 back off existing accounts, run this by hand — it is
-- left commented out because it is destructive and cannot be undone:
--
--   update public.profiles
--      set pickles = greatest(0, pickles - 1500)
--    where welcome_pickles_granted;
--
-- Note it would take balances negative-adjusted to 0 for anyone who has already
-- spent below 1,500, and it cannot tell a welcome pickle apart from an earned
-- one. Check `select count(*) from public.profiles where welcome_pickles_granted
-- and pickles < 1500;` before deciding.
-- ============================================================

create or replace function public.claim_welcome_pickles()
returns table (granted boolean, new_balance integer)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_already   boolean;
  v_balance   integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select welcome_pickles_granted, pickles
    into v_already, v_balance
    from public.profiles
   where id = v_uid;

  if v_already then
    return query select false, v_balance;
    return;
  end if;

  update public.profiles
     set pickles                 = pickles + 1000,
         welcome_pickles_granted = true
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_balance;
end;
$$;

-- create or replace preserves the existing ACL, but this RPC is client-callable
-- and on the allowlist in migration_rls_hardening_2026q3.sql, so state it.
grant execute on function public.claim_welcome_pickles() to authenticated;
