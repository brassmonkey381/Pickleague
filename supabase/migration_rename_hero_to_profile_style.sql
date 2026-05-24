-- ============================================================
-- Rename hero_name_style -> profile_name_style.
--
-- Flair (legacy name colors) and the new animated styles are both
-- profile-side cosmetics. We collapse them under one UX bucket
-- ("Profile Styles") in the shop. Schema-wise, we drop the "hero"
-- nomenclature; flair stays its own category for backward compat but
-- renders alongside profile_name_style in the same shop tab.
-- ============================================================

-- 1. Drop the constraint FIRST so the UPDATE doesn't violate the old check.
alter table public.shop_items drop constraint if exists shop_items_category_check;

-- 2. Rename category value on existing rows.
update public.shop_items set category = 'profile_name_style' where category = 'hero_name_style';

-- 3. Re-add the constraint with the new value list.
alter table public.shop_items
  add constraint shop_items_category_check
  check (category in (
    'avatar', 'cosmetic_badge', 'flair', 'profile_frame', 'real_world',
    'list_name_style', 'profile_name_style'
  ));

-- 3. Rename column on profiles.
alter table public.profiles
  rename column hero_name_style_id to profile_name_style_id;

-- 4. Repoint the purchase_shop_item RPC at the renamed column / category.
create or replace function public.purchase_shop_item(p_item_id uuid)
returns table (success boolean, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid          uuid := auth.uid();
  v_cost         integer;
  v_category     text;
  v_payload      jsonb;
  v_slug         text;
  v_unlock_badge uuid;
  v_balance      integer;
begin
  if v_uid is null then
    return query select false, 0, 'Not authenticated';
    return;
  end if;

  select cost, category, payload, slug, unlock_badge_id
    into v_cost, v_category, v_payload, v_slug, v_unlock_badge
    from public.shop_items where id = p_item_id and is_active = true;

  if v_cost is null then
    return query select false, 0, 'Item not found';
    return;
  end if;

  if v_unlock_badge is not null then
    return query select false, 0, 'This item unlocks via badge progression, not purchase';
    return;
  end if;

  -- Owned check (skip real_world which is stackable).
  if v_category <> 'real_world' and exists (
    select 1 from public.player_shop_purchases
     where user_id = v_uid and shop_item_id = p_item_id
  ) then
    return query select false, 0, 'Already owned';
    return;
  end if;

  select pickles into v_balance from public.profiles where id = v_uid for update;
  if v_balance is null then v_balance := 0; end if;
  if v_balance < v_cost then
    return query select false, v_balance, 'Insufficient pickles';
    return;
  end if;

  update public.profiles set pickles = v_balance - v_cost where id = v_uid;
  insert into public.player_shop_purchases (user_id, shop_item_id, cost_paid)
    values (v_uid, p_item_id, v_cost);

  -- Auto-equip side effects.
  if v_category = 'avatar' then
    update public.profiles
       set avatar_emoji    = v_payload->>'emoji',
           avatar_bg_color = v_payload->>'bgColor'
     where id = v_uid;
  elsif v_category = 'flair' and v_payload->>'kind' = 'name_color' then
    update public.profiles set name_color = v_payload->>'value' where id = v_uid;
  elsif v_category = 'list_name_style' then
    update public.profiles set list_name_style_id = v_slug where id = v_uid;
  elsif v_category = 'profile_name_style' then
    update public.profiles set profile_name_style_id = v_slug where id = v_uid;
  end if;

  return query select true, v_balance - v_cost, 'Purchased';
end;
$$;
