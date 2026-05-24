-- ============================================================
-- Real-world redemptions tab for the Pickle Shop
--
-- Adds a 'real_world' shop category for physical goods that
-- players can redeem with pickles. Pricing convention: 1000
-- pickles = $1.00, so cost = usdCents * 10.
--
-- Daily discount carousel: 4 random items each day get
-- 20/15/10/5% off, deterministically picked from today's UTC
-- date so the rotation flips at midnight UTC and every client
-- sees the same set.
--
-- Redemptions live in their own redemption_orders table (not
-- player_shop_purchases), because (a) the same physical item
-- can be redeemed many times, while cosmetics are gated by
-- player_shop_purchases' unique (user_id, shop_item_id), and
-- (b) redemptions need a fulfillment lifecycle (pending →
-- fulfilled / cancelled) that doesn't apply to cosmetics.
--
-- Run AFTER:
--   migration_add_pickles_shop.sql
--   migration_shop_rewards_and_progress_badges.sql
-- ============================================================


-- 1. Allow 'real_world' in shop_items.category --------------------------
do $$
declare v_conname text;
begin
  select c.conname
    into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'shop_items'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%category%';

  if v_conname is not null then
    execute format('alter table public.shop_items drop constraint %I', v_conname);
  end if;

  alter table public.shop_items
    add constraint shop_items_category_check
    check (category in ('avatar', 'cosmetic_badge', 'flair', 'profile_frame', 'real_world'));
end $$;


-- 2. Redemption orders --------------------------------------------------
create table if not exists public.redemption_orders (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid references public.profiles(id)  on delete cascade not null,
  shop_item_id  uuid references public.shop_items(id) on delete restrict not null,
  pickles_paid  integer not null,
  base_pickles  integer not null,
  discount_pct  integer not null default 0,
  status        text not null default 'pending'
                  check (status in ('pending', 'fulfilled', 'cancelled')),
  created_at    timestamptz not null default now(),
  fulfilled_at  timestamptz,
  notes         text
);

alter table public.redemption_orders enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'redemption_orders' and policyname = 'Users see own redemption orders') then
    create policy "Users see own redemption orders" on public.redemption_orders
      for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'redemption_orders' and policyname = 'Users create own redemption orders') then
    create policy "Users create own redemption orders" on public.redemption_orders
      for insert with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'redemption_orders' and policyname = 'Service role manages redemption orders') then
    create policy "Service role manages redemption orders" on public.redemption_orders
      for all using (auth.role() = 'service_role');
  end if;
end $$;

create index if not exists idx_redemption_orders_user   on public.redemption_orders(user_id, created_at desc);
create index if not exists idx_redemption_orders_status on public.redemption_orders(status, created_at);


-- 3. Today's rotating discount carousel ---------------------------------
--    Stable per-day shuffle: hash(slug || today's date) sort, take 4,
--    assign 20/15/10/5%. Reruns within the same UTC day return the same
--    set; rotation flips at midnight UTC.
create or replace function public.current_real_world_discounts()
returns table (slug text, discount_pct integer)
language sql stable security definer as $$
  select s.slug,
         (array[20, 15, 10, 5])[s.rn] as discount_pct
    from (
      select slug,
             row_number() over (order by hashtext(slug || current_date::text)) as rn
        from public.shop_items
       where category = 'real_world' and is_active = true
    ) s
   where s.rn <= 4;
$$;
grant execute on function public.current_real_world_discounts() to authenticated;


-- 4. Redeem RPC ---------------------------------------------------------
--    Applies today's discount server-side so the client can't fake one.
create or replace function public.redeem_real_world_item(p_item_id uuid)
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

  insert into public.redemption_orders (user_id, shop_item_id, pickles_paid, base_pickles, discount_pct)
  values (v_uid, p_item_id, v_effective, v_cost, v_discount);

  begin
    perform public._notify_user(
      v_uid,
      format('🎁 Redemption queued: %s', v_name),
      format('Your redemption for %s is pending. An admin will reach out to arrange delivery.', v_name),
      v_uid,
      'shop'
    );
  exception when others then null;
  end;

  return query select true, v_balance, v_effective, v_discount, 'Redeemed!'::text;
end;
$$;

grant execute on function public.redeem_real_world_item(uuid) to authenticated;


-- 5. Seed catalog (8 items, ~1000 pickles per $1.00) --------------------
--    payload.usdCents drives the "$XX.XX" badge in the UI. purchaseUrl
--    is optional — when present the card can deep-link to where the item
--    is sold online.
insert into public.shop_items (slug, category, name, description, icon, cost, payload, sort_order) values
  ('redeem-franklin-x40-3pack',     'real_world', 'Franklin X-40 (3-pack)',
     'Three USAPA-approved outdoor pickleballs. Tournament standard.',
     '🟡',  9990,  '{"usdCents":999,  "purchaseUrl":"https://www.franklinsports.com"}', 10),
  ('redeem-onix-lifetime-6pack',    'real_world', 'Onix Lifetime (6-pack)',
     'Six durable indoor/outdoor pickleballs. Sized for cooler weather.',
     '🟢', 22990,  '{"usdCents":2299, "purchaseUrl":"https://www.onixpickleball.com"}', 11),
  ('redeem-selkirk-luxx-control',   'real_world', 'Selkirk Sport LUXX Control',
     'Top-tier control paddle. Pro-level feel with elongated sweet spot.',
     '🥒', 199990, '{"usdCents":19999,"purchaseUrl":"https://www.selkirk.com"}',        12),
  ('redeem-franklin-indoor-12pack', 'real_world', 'Franklin Indoor (12-pack)',
     'A dozen indoor pickleballs. Quieter, lighter, ideal for gym play.',
     '🟠', 29990,  '{"usdCents":2999, "purchaseUrl":"https://www.franklinsports.com"}', 13),
  ('redeem-onix-pro-backpack',      'real_world', 'Onix Pro Team Backpack',
     'Paddle pockets, ventilated shoe area, water bottle holders.',
     '🎒', 79990,  '{"usdCents":7999, "purchaseUrl":"https://www.onixpickleball.com"}', 14),
  ('redeem-pickle-gloves',          'real_world', 'Pickleball Gloves (pair)',
     'Tacky-grip palms with breathable mesh backs. Sweat-proof your serve.',
     '🧤', 24990,  '{"usdCents":2499}', 15),
  ('redeem-court-tape-kit',         'real_world', 'Court Boundary Tape Kit',
     'Mark a full regulation court on any flat surface in about 10 minutes.',
     '📏', 44990,  '{"usdCents":4499}', 16),
  ('redeem-selkirk-latitude',       'real_world', 'Selkirk Latitude Paddle',
     'Forgiving widebody face. Great all-around pick for any level.',
     '🪶', 89990,  '{"usdCents":8999, "purchaseUrl":"https://www.selkirk.com"}',        17)
on conflict (slug) do nothing;


notify pgrst, 'reload schema';
