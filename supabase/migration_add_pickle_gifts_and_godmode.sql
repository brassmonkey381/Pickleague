-- ============================================================
-- Pickle gifts (shop items + raw pickle transfers) + godmode tools
--
-- Adds:
--   * player_shop_purchases.is_hidden / gifted_by_user_id / gift_message
--   * gift_shop_item(item_id, recipient_uid, message)
--   * set_purchase_hidden(purchase_id, hidden)
--   * claim_godmode_pickles()                — 50k grant per call
--   * godmode_gift_pickles(recipient, amount, reason) — direct transfer
--
-- Server-side godmode list is the same single UUID used in the client.
-- ============================================================

-- 1. Purchase columns ----------------------------------------------------
alter table public.player_shop_purchases
  add column if not exists is_hidden          boolean not null default false,
  add column if not exists gifted_by_user_id  uuid    references public.profiles(id) on delete set null,
  add column if not exists gift_message       text;

-- 2. Helper: is_godmode (server-side mirror of mobile/src/lib/godmode.ts) -
create or replace function public.is_godmode_user(p_uid uuid)
returns boolean language sql immutable as $$
  select p_uid in (
    -- Mirror of GODMODE_USER_IDS in mobile/src/lib/godmode.ts.
    -- Add additional uuids on new lines as needed.
    '252a36e1-5d89-4ad2-8a3e-b786579f019a'::uuid
  );
$$;

grant execute on function public.is_godmode_user(uuid) to authenticated;

-- 3. claim_godmode_pickles — every call grants 50,000 to the godmode user
create or replace function public.claim_godmode_pickles()
returns table (success boolean, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid     uuid := auth.uid();
  v_balance integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user(v_uid) then
    return query select false, null::integer, 'Not authorized'::text; return;
  end if;

  update public.profiles set pickles = pickles + 50000
   where id = v_uid
   returning pickles into v_balance;

  return query select true, v_balance, 'Granted 50,000 🥒'::text;
end;
$$;

grant execute on function public.claim_godmode_pickles() to authenticated;

-- 4. godmode_gift_pickles — transfer pickles from godmode caller to anyone
create or replace function public.godmode_gift_pickles(
  p_recipient uuid,
  p_amount    integer,
  p_reason    text default ''
) returns table (success boolean, new_caller_balance integer, new_recipient_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid           uuid := auth.uid();
  v_caller_bal    integer;
  v_recipient_bal integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_godmode_user(v_uid) then
    return query select false, null::integer, null::integer, 'Not authorized'::text; return;
  end if;
  if p_amount is null or p_amount <= 0 then
    return query select false, null::integer, null::integer, 'Amount must be positive'::text; return;
  end if;
  if p_recipient is null then
    return query select false, null::integer, null::integer, 'Pick a recipient'::text; return;
  end if;
  if not exists (select 1 from public.profiles where id = p_recipient) then
    return query select false, null::integer, null::integer, 'Recipient not found'::text; return;
  end if;

  select pickles into v_caller_bal from public.profiles where id = v_uid;
  if v_caller_bal < p_amount then
    return query select false, v_caller_bal, null::integer, 'Not enough pickles'::text; return;
  end if;

  update public.profiles set pickles = pickles - p_amount where id = v_uid     returning pickles into v_caller_bal;
  update public.profiles set pickles = pickles + p_amount where id = p_recipient returning pickles into v_recipient_bal;

  return query select true, v_caller_bal, v_recipient_bal,
    format('Sent %s 🥒 to recipient. %s', p_amount, coalesce(nullif(p_reason, ''), ''));
end;
$$;

grant execute on function public.godmode_gift_pickles(uuid, integer, text) to authenticated;

-- 5. gift_shop_item — anyone can gift; deducts caller's pickles, creates
--    a purchase row on the recipient. No auto-equip on the recipient.
create or replace function public.gift_shop_item(
  p_item_id   uuid,
  p_recipient uuid,
  p_message   text default null
) returns table (success boolean, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid        uuid := auth.uid();
  v_cost       integer;
  v_active     boolean;
  v_balance    integer;
  v_owned      boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_recipient is null or p_recipient = v_uid then
    return query select false, null::integer, 'Pick a different recipient'::text; return;
  end if;

  select cost, is_active into v_cost, v_active from public.shop_items where id = p_item_id;
  if v_cost is null then return query select false, null::integer, 'Item not found'::text; return; end if;
  if not v_active then return query select false, null::integer, 'Item not available'::text; return; end if;

  select exists (
    select 1 from public.player_shop_purchases
    where user_id = p_recipient and shop_item_id = p_item_id
  ) into v_owned;
  if v_owned then
    return query select false, null::integer, 'Recipient already owns this item'::text; return;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid;
  if v_balance < v_cost then
    return query select false, v_balance, 'Not enough pickles'::text; return;
  end if;

  update public.profiles set pickles = pickles - v_cost
   where id = v_uid returning pickles into v_balance;

  insert into public.player_shop_purchases
    (user_id, shop_item_id, cost_paid, gifted_by_user_id, gift_message)
  values (p_recipient, p_item_id, v_cost, v_uid, nullif(p_message, ''));

  return query select true, v_balance, 'Gifted'::text;
end;
$$;

grant execute on function public.gift_shop_item(uuid, uuid, text) to authenticated;

-- 6. set_purchase_hidden — toggle visibility of a purchase you own
create or replace function public.set_purchase_hidden(
  p_purchase_id uuid,
  p_hidden      boolean
) returns void language plpgsql security definer as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  update public.player_shop_purchases
     set is_hidden = p_hidden
   where id = p_purchase_id and user_id = v_uid;
  if not found then
    raise exception 'Purchase not found or not yours';
  end if;
end;
$$;

grant execute on function public.set_purchase_hidden(uuid, boolean) to authenticated;

-- 7. Replace purchase_shop_item to skip auto-equip everywhere; the user
--    chooses what to equip from the Profile inventory. Self-purchases
--    of avatars / flair still happen, but they go into inventory and
--    the user equips manually.
create or replace function public.purchase_shop_item(p_item_id uuid)
returns table (success boolean, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_cost      integer;
  v_active    boolean;
  v_balance   integer;
  v_owned     boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select cost, is_active
    into v_cost, v_active
    from public.shop_items
   where id = p_item_id;

  if v_cost is null then
    return query select false, null::integer, 'Item not found'::text; return;
  end if;
  if not v_active then
    return query select false, null::integer, 'Item not available'::text; return;
  end if;

  select exists (
    select 1 from public.player_shop_purchases
    where user_id = v_uid and shop_item_id = p_item_id
  ) into v_owned;
  if v_owned then
    return query select false, null::integer, 'Already owned'::text; return;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid;
  if v_balance < v_cost then
    return query select false, v_balance, 'Not enough pickles'::text; return;
  end if;

  update public.profiles set pickles = pickles - v_cost
   where id = v_uid
   returning pickles into v_balance;

  insert into public.player_shop_purchases (user_id, shop_item_id, cost_paid)
  values (v_uid, p_item_id, v_cost);

  return query select true, v_balance, 'Purchased'::text;
end;
$$;

grant execute on function public.purchase_shop_item(uuid) to authenticated;
