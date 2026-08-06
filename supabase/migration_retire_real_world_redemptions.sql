-- Retire the real-world redemption tab ahead of App Store submission.
--
-- WHY: pickles are earned, never purchased, so the Shop is not an IAP problem.
-- But the app also lets players stake pickles on match/rank outcomes
-- (mobile/src/lib/wager.ts). "Stake a currency on a contest, then redeem it for
-- goods with a stated dollar value" is the shape App Review reads as gambling
-- under Guideline 5.3 — even when the currency was free. Removing the
-- real-world redemptions removes the prize-of-value leg, which leaves the
-- wagers as a pure leaderboard mechanic.
--
-- WHAT THIS DOES NOT DO: it does not drop redemption_orders, its rows, or the
-- functions. Six pending orders exist (all on the owner's own account) and the
-- table is the only record of them. Retiring is reversible; dropping is not.
--
-- Client-side, ShopScreen no longer renders the 'real_world' tab at all. This
-- migration is the belt to that suspenders: web clients can hold a stale JS
-- bundle, and any future OTA rollback would otherwise re-expose a live path.

-- 1. Nothing in the category is purchasable any more. -------------------
update public.shop_items
   set is_active = false
 where category = 'real_world';

-- 2. Revoke the two entry points. Both are SECURITY DEFINER, so an
--    unrevoked grant is a live path regardless of what the client renders.
revoke execute on function public.redeem_real_world_item(uuid, jsonb)
  from public, anon, authenticated;

revoke execute on function public.gift_real_world_item(uuid, uuid, text, jsonb)
  from public, anon, authenticated;

-- The daily discount carousel only ever priced real_world items, and the
-- client no longer calls it.
revoke execute on function public.current_real_world_discounts()
  from public, anon, authenticated;

-- 3. Leave redemption_orders in place, RLS untouched, rows intact. Fulfil
--    the outstanding six by hand (or mark them cancelled and refund the
--    pickles) — deliberately not automated here, since that is a judgment
--    call about what those players are owed.
