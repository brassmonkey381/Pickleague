-- ============================================================
-- Real-world redemption gifting + shipping addresses
--
-- Adds shipping_address (jsonb) + gifted_by_user_id + gift_message
-- columns to redemption_orders, makes redeem_real_world_item
-- require an address, and adds gift_real_world_item so a player
-- can spend their own pickles to send a physical item to another
-- player. The gifter supplies the recipient's shipping address.
--
-- shipping_address shape (jsonb):
--   {
--     "name":        "Jane Doe",
--     "line1":       "123 Main St",
--     "line2":       "Apt 4",          (optional)
--     "city":        "Seattle",
--     "state":       "WA",
--     "postal_code": "98101",
--     "country":     "US",
--     "phone":       "+15555550100"    (optional)
--   }
--
-- Run AFTER migration_shop_real_world_redemptions.sql.
-- ============================================================


-- 1. Schema additions ---------------------------------------------------
alter table public.redemption_orders
  add column if not exists shipping_address  jsonb,
  add column if not exists gifted_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists gift_message      text;


-- 2. Helper: validate that the address has the minimum required fields.
--    Trims whitespace before checking so " " is treated as empty.
create or replace function public._redemption_address_valid(p_addr jsonb)
returns boolean language sql immutable as $$
  select p_addr is not null
     and length(coalesce(btrim(p_addr ->> 'name'),        '')) > 0
     and length(coalesce(btrim(p_addr ->> 'line1'),       '')) > 0
     and length(coalesce(btrim(p_addr ->> 'city'),        '')) > 0
     and length(coalesce(btrim(p_addr ->> 'postal_code'), '')) > 0
     and length(coalesce(btrim(p_addr ->> 'country'),     '')) > 0;
$$;


-- 3. Replace redeem_real_world_item to require shipping_address. --------
drop function if exists public.redeem_real_world_item(uuid);
create or replace function public.redeem_real_world_item(
  p_item_id          uuid,
  p_shipping_address jsonb
)
returns table (
  success      boolean,
  new_balance  integer,
  pickles_paid integer,
  discount_pct integer,
  message      text
)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_cost      integer;
  v_active    boolean;
  v_category  text;
  v_slug      text;
  v_name      text;
  v_balance   integer;
  v_discount  integer := 0;
  v_effective integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  if not public._redemption_address_valid(p_shipping_address) then
    return query select false, null::integer, 0, 0,
      'Shipping address is required (name, line1, city, postal_code, country)'::text; return;
  end if;

  select cost, is_active, category, slug, name
    into v_cost, v_active, v_category, v_slug, v_name
    from public.shop_items
   where id = p_item_id;

  if v_cost is null then
    return query select false, null::integer, 0, 0, 'Item not found'::text; return;
  end if;
  if not v_active then
    return query select false, null::integer, 0, 0, 'Item not available'::text; return;
  end if;
  if v_category <> 'real_world' then
    return query select false, null::integer, 0, 0,
      'Use purchase_shop_item for non-redemption items'::text; return;
  end if;

  select d.discount_pct into v_discount
    from public.current_real_world_discounts() d
   where d.slug = v_slug;
  if v_discount is null then v_discount := 0; end if;

  v_effective := floor(v_cost * (100 - v_discount) / 100.0)::integer;

  select pickles into v_balance from public.profiles where id = v_uid;
  if v_balance < v_effective then
    return query select false, v_balance, v_effective, v_discount, 'Not enough pickles'::text; return;
  end if;

  update public.profiles set pickles = pickles - v_effective
    where id = v_uid
    returning pickles into v_balance;

  insert into public.redemption_orders
    (user_id, shop_item_id, pickles_paid, base_pickles, discount_pct, shipping_address)
  values (v_uid, p_item_id, v_effective, v_cost, v_discount, p_shipping_address);

  begin
    perform public._notify_user(
      v_uid,
      format('🎁 Redemption queued: %s', v_name),
      format('Your redemption for %s is pending. We''ll ship to the address you provided.', v_name),
      v_uid,
      'shop'
    );
  exception when others then null;
  end;

  return query select true, v_balance, v_effective, v_discount, 'Redeemed!'::text;
end;
$$;

grant execute on function public.redeem_real_world_item(uuid, jsonb) to authenticated;


-- 4. gift_real_world_item — gifter pays, recipient receives the order. --
--    Gifter provides the recipient's shipping address (typically because
--    they know it; if not, they can coordinate offline before gifting).
create or replace function public.gift_real_world_item(
  p_item_id          uuid,
  p_recipient        uuid,
  p_message          text,
  p_shipping_address jsonb
)
returns table (
  success      boolean,
  new_balance  integer,
  pickles_paid integer,
  discount_pct integer,
  message      text
)
language plpgsql security definer as $$
declare
  v_uid       uuid := auth.uid();
  v_cost      integer;
  v_active    boolean;
  v_category  text;
  v_slug      text;
  v_name      text;
  v_gifter    text;
  v_balance   integer;
  v_discount  integer := 0;
  v_effective integer;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_recipient is null or p_recipient = v_uid then
    return query select false, null::integer, 0, 0, 'Pick a different recipient'::text; return;
  end if;
  if not exists (select 1 from public.profiles where id = p_recipient) then
    return query select false, null::integer, 0, 0, 'Recipient not found'::text; return;
  end if;
  if not public._redemption_address_valid(p_shipping_address) then
    return query select false, null::integer, 0, 0,
      'Shipping address is required (name, line1, city, postal_code, country)'::text; return;
  end if;

  select cost, is_active, category, slug, name
    into v_cost, v_active, v_category, v_slug, v_name
    from public.shop_items
   where id = p_item_id;

  if v_cost is null then
    return query select false, null::integer, 0, 0, 'Item not found'::text; return;
  end if;
  if not v_active then
    return query select false, null::integer, 0, 0, 'Item not available'::text; return;
  end if;
  if v_category <> 'real_world' then
    return query select false, null::integer, 0, 0,
      'Use gift_shop_item for non-redemption items'::text; return;
  end if;

  select d.discount_pct into v_discount
    from public.current_real_world_discounts() d
   where d.slug = v_slug;
  if v_discount is null then v_discount := 0; end if;

  v_effective := floor(v_cost * (100 - v_discount) / 100.0)::integer;

  select pickles, full_name into v_balance, v_gifter
    from public.profiles where id = v_uid;
  if v_balance < v_effective then
    return query select false, v_balance, v_effective, v_discount, 'Not enough pickles'::text; return;
  end if;

  update public.profiles set pickles = pickles - v_effective
    where id = v_uid
    returning pickles into v_balance;

  insert into public.redemption_orders
    (user_id, shop_item_id, pickles_paid, base_pickles, discount_pct,
     shipping_address, gifted_by_user_id, gift_message)
  values (p_recipient, p_item_id, v_effective, v_cost, v_discount,
          p_shipping_address, v_uid, nullif(btrim(p_message), ''));

  -- Notify the recipient that someone sent them something.
  begin
    perform public._notify_user(
      p_recipient,
      format('🎁 You received a gift: %s', v_name),
      format('%s sent you %s. It''ll ship to the address %s provided.',
             coalesce(v_gifter, 'Someone'), v_name, coalesce(v_gifter, 'they')),
      p_recipient,
      'shop'
    );
  exception when others then null;
  end;

  return query select true, v_balance, v_effective, v_discount, 'Gifted'::text;
end;
$$;

grant execute on function public.gift_real_world_item(uuid, uuid, text, jsonb) to authenticated;


notify pgrst, 'reload schema';
