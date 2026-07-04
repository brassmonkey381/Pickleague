-- gift_shop_item silently delivered gifts: the recipient's purchase row was
-- created (with gifted_by + message) but NO notification was ever sent — the
-- only way to discover a gift was to stumble on it in the shop. Found by the
-- extras sweep. Body verbatim plus the notification (item name + gifter +
-- their message).

create or replace function public.gift_shop_item(p_item_id uuid, p_recipient uuid, p_message text default null::text)
returns table(success boolean, new_balance integer, message text)
language plpgsql security definer as $$
declare
  v_uid        uuid := auth.uid();
  v_cost       integer;
  v_active     boolean;
  v_balance    integer;
  v_owned      boolean;
  v_item_name  text;
  v_giver_name text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_recipient is null or p_recipient = v_uid then
    return query select false, null::integer, 'Pick a different recipient'::text; return;
  end if;

  select cost, is_active, name into v_cost, v_active, v_item_name from public.shop_items where id = p_item_id;
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

  select full_name into v_giver_name from public.profiles where id = v_uid;
  insert into public.notifications (user_id, title, body, type, entity_id, entity_type)
  values (
    p_recipient,
    '🎁 You received a gift!',
    format('%s gifted you "%s"%s',
           coalesce(v_giver_name, 'Someone'), coalesce(v_item_name, 'a shop item'),
           case when nullif(p_message, '') is not null then format(' — "%s"', p_message) else '.' end),
    'info', p_item_id, 'shop_item'
  );

  return query select true, v_balance, 'Gifted'::text;
end;
$$;
