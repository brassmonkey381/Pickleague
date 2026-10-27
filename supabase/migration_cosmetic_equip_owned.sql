-- Equip only what you own: Shop cosmetics are equipped through the server,
-- which checks the player owns the item.
--
-- The hole it closes: the equipped-cosmetic columns on profiles
-- (avatar_emoji + avatar_bg_color, name_color, list_name_style_id,
-- profile_name_style_id) were on the profiles column guard's player-editable
-- list (migration_profiles_column_guard.sql), and nothing on the server
-- checked them. The Shop's "Buy & Equip", the Profile inventory's Equip and
-- the Edit profile sheet's Shop avatar all wrote them straight to profiles,
-- so any signed-in player could PATCH /rest/v1/profiles?id=eq.<self> with
-- any Shop item's emoji / color / slug and wear it for free.
--
-- What it does:
--   1. equip_shop_item(p_item_id uuid) returns jsonb, SECURITY DEFINER. The
--      app's one way to equip. Refuses (SQLSTATE P0001, HINT 'pl:<code>',
--      DETAIL {"item": <name>, "badge": <badge name or null>}):
--        pl:auth.signed_out    no session
--        pl:request.bad        no item id
--        pl:shop.item_gone     no such item
--        pl:shop.not_equippable  not something you wear: a decorative badge
--                                (shown from the Profile), a real-world item,
--                                a profile frame, a flair that isn't a name color
--        pl:shop.not_owned     a badge-gated item: the player doesn't hold
--                                its badge (a purchase row alone isn't
--                                enough); any other item: no purchase row
--                                (bought or gifted) and it isn't free
--                                (active, cost 0)
--      Writes the same columns the app wrote (category -> columns):
--        avatar              avatar_emoji = payload.emoji,
--                            avatar_bg_color = payload.bgColor
--        flair (name_color)  name_color = payload.value
--        list_name_style     list_name_style_id = slug
--        profile_name_style  profile_name_style_id = slug
--      Returns those five columns as they now are, for the app to merge.
--   2. unequip_cosmetic(p_category text) returns jsonb, SECURITY DEFINER.
--      Back to the default (null) for 'avatar' (both avatar columns), 'flair'
--      (name_color), 'list_name_style', 'profile_name_style'; anything else
--      is pl:request.bad. Same return as equip_shop_item.
--   3. _pl_profiles_column_guard: the body from
--      migration_profiles_column_guard.sql, unchanged, plus one rule after its
--      server-owned check. A client-role UPDATE (anon / authenticated) that
--      CHANGES an equipped-cosmetic column must change it to null (unequip)
--      or to a value of an item the player owns (the mapping above; the avatar
--      pair is checked together, both null = unequipped). Anything else is
--      refused as a whole with HINT 'pl:shop.not_owned' and DETAIL
--      {"columns": [...]}. A column sent back unchanged still saves (the Edit
--      profile sheet sends the current avatar back with every save).
--      Ownership is read as the caller (the guard is SECURITY INVOKER):
--      player_shop_purchases shows a player all of their own rows (hidden
--      ones included); shop_items, badges and player_badges are readable by
--      everyone.
--      Why the guard and not only the RPC: older app builds still write these
--      columns directly. They keep working for items the player owns, and
--      for unequip.
--      Then the badge cosmetics, the same kind of hole (the app checked them,
--      the server didn't): a CHANGED avatar_id to an unlockable cartoon avatar
--      (18-20) or a play tag ADDED to selected_tags that unlocks with a badge
--      the player hasn't earned is refused with HINT 'pl:profile.locked',
--      DETAIL {"columns": [...], "badges": [<badge names>]}; a selected_tags
--      change that leaves more tags than the player's slots (3, +1 each for
--      Veteran and Top Rated) and more than before is refused with HINT
--      'pl:profile.too_many_tags', DETAIL {"columns": ["selected_tags"],
--      "max_tags": n}. Lists mirror mobile/src/data/profileCustomization.ts.
--   4. gift_shop_item: the body of migration_gift_shop_item_notify.sql plus
--      one refusal: a badge-gated item can't be gifted (they cost 0, so a
--      second account could hand them out free). Same soft return as its
--      other refusals: (false, null, message).
--
-- Untouched, because they are not client roles (the guard lets them by):
-- purchase_shop_item's auto-equip and gift_shop_item (SECURITY DEFINER,
-- owner postgres; a gift does not equip), _grant_unlock_items_on_badge,
-- handle_new_user's sign-up defaults (no cosmetics), _purge_account's
-- tombstone (sets them to null), the shop_items.slug FK (on update cascade /
-- on delete set null), the godmode-create-user edge function and the seed
-- scripts (service_role).
--
-- Re-running migration_profiles_column_guard.sql after this file puts the
-- old guard body back (cosmetics unchecked): re-run this file after it.
-- supabase/tests/check-replaced-functions.mjs lists the guard.
--
-- Idempotent; no top-level transaction. Tests:
-- supabase/tests/cosmetic_equip_personas.sql (build-cosmetic-equip-test.mjs).
-- Apply after migration_profiles_column_guard.sql (and
-- migration_anon_audit_rest.sql) with:
--   supabase db query --linked -f supabase/migration_cosmetic_equip_owned.sql

-- ── 1. equip_shop_item ──────────────────────────────────────────────────────
create or replace function public.equip_shop_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_item  public.shop_items;
  v_badge text;
  v_row   public.profiles;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_item_id is null then
    raise exception using
      message = 'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;

  select * into v_item from public.shop_items where id = p_item_id;
  if not found then
    raise exception using
      message = 'That item isn''t in the Shop any more, so it can''t be equipped. Pull to refresh.',
      hint    = 'pl:shop.item_gone';
  end if;

  if not (v_item.category in ('avatar', 'list_name_style', 'profile_name_style')
          or (v_item.category = 'flair' and v_item.payload ->> 'kind' = 'name_color')) then
    raise exception using
      message = v_item.name || ' isn''t something you equip. Decorative badges show on your profile once you own them; show or hide them from your Profile.',
      detail  = jsonb_build_object('item', v_item.name, 'badge', null)::text,
      hint    = 'pl:shop.not_equippable';
  end if;

  -- Owned: a badge-gated item by holding its badge (a purchase row alone
  -- doesn't count: before this file gift_shop_item could hand one out, and a
  -- badge earned before trg_grant_unlock_items_on_badge has no row); any
  -- other item by a purchase row (bought or gifted) or by being free.
  if not (case
            when v_item.unlock_badge_id is not null then
              exists (select 1 from public.player_badges pb
                       where pb.user_id = v_me and pb.badge_id = v_item.unlock_badge_id)
            else
              exists (select 1 from public.player_shop_purchases p
                       where p.user_id = v_me and p.shop_item_id = v_item.id)
              or (v_item.is_active and v_item.cost = 0)
          end) then
    select b.name into v_badge from public.badges b where b.id = v_item.unlock_badge_id;
    raise exception using
      message = case
        when v_item.unlock_badge_id is not null
          then 'You haven''t unlocked ' || v_item.name || ' yet. Earn the ' || coalesce(v_badge, 'matching') || ' badge, then equip it.'
        else 'You don''t own ' || v_item.name || ' yet, so it can''t be equipped. Buy it in the Shop first.'
      end,
      detail  = jsonb_build_object('item', v_item.name, 'badge', v_badge)::text,
      hint    = 'pl:shop.not_owned';
  end if;

  if v_item.category = 'avatar' then
    update public.profiles
       set avatar_emoji    = v_item.payload ->> 'emoji',
           avatar_bg_color = v_item.payload ->> 'bgColor'
     where id = v_me returning * into v_row;
  elsif v_item.category = 'flair' then
    update public.profiles set name_color = v_item.payload ->> 'value'
     where id = v_me returning * into v_row;
  elsif v_item.category = 'list_name_style' then
    update public.profiles set list_name_style_id = v_item.slug
     where id = v_me returning * into v_row;
  else
    update public.profiles set profile_name_style_id = v_item.slug
     where id = v_me returning * into v_row;
  end if;

  return jsonb_build_object(
    'avatar_emoji',          v_row.avatar_emoji,
    'avatar_bg_color',       v_row.avatar_bg_color,
    'name_color',            v_row.name_color,
    'list_name_style_id',    v_row.list_name_style_id,
    'profile_name_style_id', v_row.profile_name_style_id);
end;
$$;
revoke execute on function public.equip_shop_item(uuid) from public, anon;
grant execute on function public.equip_shop_item(uuid) to authenticated;

-- ── 2. unequip_cosmetic ─────────────────────────────────────────────────────
create or replace function public.unequip_cosmetic(p_category text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.profiles;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  if p_category = 'avatar' then
    update public.profiles set avatar_emoji = null, avatar_bg_color = null
     where id = v_me returning * into v_row;
  elsif p_category = 'flair' then
    update public.profiles set name_color = null where id = v_me returning * into v_row;
  elsif p_category = 'list_name_style' then
    update public.profiles set list_name_style_id = null where id = v_me returning * into v_row;
  elsif p_category = 'profile_name_style' then
    update public.profiles set profile_name_style_id = null where id = v_me returning * into v_row;
  else
    raise exception using
      message = 'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;

  return jsonb_build_object(
    'avatar_emoji',          v_row.avatar_emoji,
    'avatar_bg_color',       v_row.avatar_bg_color,
    'name_color',            v_row.name_color,
    'list_name_style_id',    v_row.list_name_style_id,
    'profile_name_style_id', v_row.profile_name_style_id);
end;
$$;
revoke execute on function public.unequip_cosmetic(text) from public, anon;
grant execute on function public.unequip_cosmetic(text) to authenticated;

-- ── 3. The guard: equipped cosmetics only to what the player owns ───────────
-- The body of migration_profiles_column_guard.sql, then the cosmetic rule.
-- SECURITY INVOKER on purpose: it has to see the caller's role.
create or replace function public._pl_profiles_column_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_editable constant text[] := array[
    -- profile basics (EditProfileSheet)
    'full_name', 'username', 'tagline', 'gender', 'selected_tags',
    'avatar_id', 'avatar_url', 'badges_public',
    -- equipped cosmetics (EditProfileSheet, ProfileScreen, ShopScreen)
    'avatar_emoji', 'avatar_bg_color', 'name_color',
    'list_name_style_id', 'profile_name_style_id',
    -- availability grid (ProfileScreen)
    'availability',
    -- drilling (DrillScreen)
    'drilling_enabled', 'drill_availability', 'drill_shot_prefs',
    'drill_partner_prefs', 'drill_custom_tags',
    -- kept unchanged by trg_profiles_referral_guard (silently)
    'referral_code', 'invited_by'
  ];
  v_new jsonb;
  v_old jsonb;
  v_bad text[];
  v_cos text[] := '{}';
  v_badges    text[];
  v_av_lock   text[] := '{}';
  v_tag_lock  text[] := '{}';
  v_tag_slots integer;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception using
      message = 'Your Pickleague profile is created when you sign up, so it can''t be created from the app.',
      detail  = '{"columns": ["*"]}',
      hint    = 'pl:profile.server_owned';
  end if;

  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  select array_agg(k order by k) into v_bad
    from jsonb_object_keys(v_new) as k
   where k <> all (c_editable)
     and v_new -> k is distinct from v_old -> k;

  if v_bad is not null then
    raise exception using
      message = 'Pickleague keeps this part of your profile up to date itself, so it can''t be changed from the app: '
                || array_to_string(v_bad, ', ') || '.',
      detail  = jsonb_build_object('columns', to_jsonb(v_bad))::text,
      hint    = 'pl:profile.server_owned';
  end if;

  -- Equipped cosmetics (migration_cosmetic_equip_owned.sql): a change is to
  -- null (unequip) or to an item the player owns (or a free one).
  if (new.avatar_emoji, new.avatar_bg_color) is distinct from (old.avatar_emoji, old.avatar_bg_color)
     and not (new.avatar_emoji is null and new.avatar_bg_color is null)
     and not exists (
       select 1 from public.shop_items i
        where i.category = 'avatar'
          and i.payload ->> 'emoji' = new.avatar_emoji
          and i.payload ->> 'bgColor' is not distinct from new.avatar_bg_color
          and ((i.unlock_badge_id is null
                and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
                     or (i.is_active and i.cost = 0)))
               or (i.unlock_badge_id is not null
                   and exists (select 1 from public.player_badges pb where pb.user_id = new.id and pb.badge_id = i.unlock_badge_id)))) then
    v_cos := v_cos || array['avatar_bg_color', 'avatar_emoji'];
  end if;
  if new.list_name_style_id is distinct from old.list_name_style_id
     and new.list_name_style_id is not null
     and not exists (
       select 1 from public.shop_items i
        where i.category = 'list_name_style' and i.slug = new.list_name_style_id
          and ((i.unlock_badge_id is null
                and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
                     or (i.is_active and i.cost = 0)))
               or (i.unlock_badge_id is not null
                   and exists (select 1 from public.player_badges pb where pb.user_id = new.id and pb.badge_id = i.unlock_badge_id)))) then
    v_cos := v_cos || 'list_name_style_id'::text;
  end if;
  if new.name_color is distinct from old.name_color
     and new.name_color is not null
     and not exists (
       select 1 from public.shop_items i
        where i.category = 'flair' and i.payload ->> 'kind' = 'name_color' and i.payload ->> 'value' = new.name_color
          and ((i.unlock_badge_id is null
                and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
                     or (i.is_active and i.cost = 0)))
               or (i.unlock_badge_id is not null
                   and exists (select 1 from public.player_badges pb where pb.user_id = new.id and pb.badge_id = i.unlock_badge_id)))) then
    v_cos := v_cos || 'name_color'::text;
  end if;
  if new.profile_name_style_id is distinct from old.profile_name_style_id
     and new.profile_name_style_id is not null
     and not exists (
       select 1 from public.shop_items i
        where i.category = 'profile_name_style' and i.slug = new.profile_name_style_id
          and ((i.unlock_badge_id is null
                and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
                     or (i.is_active and i.cost = 0)))
               or (i.unlock_badge_id is not null
                   and exists (select 1 from public.player_badges pb where pb.user_id = new.id and pb.badge_id = i.unlock_badge_id)))) then
    v_cos := v_cos || 'profile_name_style_id'::text;
  end if;

  if cardinality(v_cos) > 0 then
    raise exception using
      message = 'Your profile wasn''t saved: you can only equip Shop items you own. Buy it in the Shop first, or pick one from your inventory.',
      detail  = jsonb_build_object('columns', to_jsonb(v_cos))::text,
      hint    = 'pl:shop.not_owned';
  end if;

  -- Badge cosmetics (not Shop items): the unlockable cartoon avatars, the
  -- badge play tags and the extra tag slots. The same lists as the app's
  -- mobile/src/data/profileCustomization.ts (AVATARS / PLAY_TAGS unlock,
  -- BASE_TAG_SLOTS, TAG_SLOT_UNLOCKS); mobile/src/data/__tests__/
  -- profileCustomizationServer.test.ts fails when the two differ. A badge counts in any league
  -- and hidden or not, as on the Profile. Only what the update CHANGES is
  -- checked: an avatar or tag already on the profile stays, and so does a tag
  -- list that doesn't grow, even if a badge was taken back since.
  if new.avatar_id is distinct from old.avatar_id
     or new.selected_tags is distinct from old.selected_tags then
    select coalesce(array_agg(distinct b.name), '{}') into v_badges
      from public.player_badges pb join public.badges b on b.id = pb.badge_id
     where pb.user_id = new.id;

    if new.avatar_id is distinct from old.avatar_id then
      select coalesce(array_agg(u.badge), '{}') into v_av_lock
        from (values (18, 'Hot Streak'), (19, 'League Leader'), (20, 'Top Rated')) as u(avatar_id, badge)
       where u.avatar_id = new.avatar_id and u.badge <> all (v_badges);
    end if;

    if new.selected_tags is distinct from old.selected_tags then
      select coalesce(array_agg(distinct u.badge), '{}') into v_tag_lock
        from (values
          ('hot-streak-slayer', 'Hot Streak'),      ('league-dominator', 'Dominant'),
          ('the-legend',        'Veteran'),         ('iron-defender',    'Iron Player'),
          ('hat-trick-hero',    'Hat Trick'),       ('home-court-king',  'Home Court Hero'),
          ('the-champion',      'Top Rated'),       ('globe-trotter',    'Court Hopper'),
          ('double-trouble',    'Doubles Dynamo'),  ('single-minded',    'Singles Specialist'),
          ('comeback-machine',  'Comeback King'),   ('the-leader',       'League Leader')
        ) as u(slug, badge)
       where u.slug = any (coalesce(new.selected_tags, '{}'))
         and u.slug <> all (coalesce(old.selected_tags, '{}'))
         and u.badge <> all (v_badges);
    end if;

    if cardinality(v_av_lock) + cardinality(v_tag_lock) > 0 then
      raise exception using
        message = 'Your profile wasn''t saved: '
                  || case when cardinality(v_av_lock) > 0 and cardinality(v_tag_lock) = 0 then 'that avatar'
                          when cardinality(v_av_lock) = 0 then 'that play tag'
                          else 'that avatar and play tag' end
                  || ' unlocks with a badge you haven''t earned yet ('
                  || array_to_string(array(select distinct x from unnest(v_av_lock || v_tag_lock) x order by x), ', ')
                  || '). Earn it first, or pick an unlocked one.',
        detail  = jsonb_build_object(
                    'columns', to_jsonb(array_remove(array[
                                 case when cardinality(v_av_lock) > 0 then 'avatar_id' end,
                                 case when cardinality(v_tag_lock) > 0 then 'selected_tags' end], null)),
                    'badges',  to_jsonb(array(select distinct x from unnest(v_av_lock || v_tag_lock) x order by x)))::text,
        hint    = 'pl:profile.locked';
    end if;

    if new.selected_tags is distinct from old.selected_tags then
      v_tag_slots := 3 + cardinality(array(select x from unnest(array['Veteran', 'Top Rated']) x
                                            where x = any (v_badges)));
      if coalesce(cardinality(new.selected_tags), 0)
           > greatest(v_tag_slots, coalesce(cardinality(old.selected_tags), 0)) then
        raise exception using
          message = 'Your profile wasn''t saved: you can show up to ' || v_tag_slots
                    || ' play tags. Remove one, or earn the Veteran or Top Rated badge for another slot.',
          detail  = jsonb_build_object('columns', '["selected_tags"]'::jsonb, 'max_tags', v_tag_slots)::text,
          hint    = 'pl:profile.too_many_tags';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public._pl_profiles_column_guard() from public, anon, authenticated;
-- trg_profiles_column_guard (migration_profiles_column_guard.sql) already runs
-- this function; it is not recreated here, so applying takes no ACCESS
-- EXCLUSIVE lock on profiles.

-- ── 4. gift_shop_item: no gifting badge-gated items ─────────────────────────
-- Badge-gated items are seeded at cost 0 (migration_name_styles.sql) and the
-- Shop hides their gift button, but gift_shop_item itself never checked
-- unlock_badge_id: any account could gift a badge item to another for 0
-- pickles. The body of migration_gift_shop_item_notify.sql, unchanged, plus
-- that refusal (same soft return shape the Shop already shows: success false
-- and a message). Ownership above no longer trusts a purchase row for a gated
-- item anyway; this stops new ones being made.
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
  v_gate_badge uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_recipient is null or p_recipient = v_uid then
    return query select false, null::integer, 'Pick a different recipient'::text; return;
  end if;

  select cost, is_active, name, unlock_badge_id into v_cost, v_active, v_item_name, v_gate_badge from public.shop_items where id = p_item_id;
  if v_cost is null then return query select false, null::integer, 'Item not found'::text; return; end if;
  if not v_active then return query select false, null::integer, 'Item not available'::text; return; end if;
  -- migration_cosmetic_equip_owned.sql: a badge-gated item is earned, not given.
  if v_gate_badge is not null then
    return query select false, null::integer,
      format('%s unlocks when a player earns the %s badge, so it can''t be gifted. Pick another item to gift.',
             v_item_name, coalesce((select b.name from public.badges b where b.id = v_gate_badge), 'matching'))::text;
    return;
  end if;

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
