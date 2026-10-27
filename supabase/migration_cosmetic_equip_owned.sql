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
--        pl:shop.not_owned     no purchase row for it (bought, gifted or
--                                unlocked by a badge), and it isn't a free
--                                item (active, cost 0, no badge gate)
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
--      ones included) and shop_items is readable by everyone.
--      Why the guard and not only the RPC: older app builds still write these
--      columns directly. They keep working for items the player owns, and
--      for unequip.
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

  if not exists (select 1 from public.player_shop_purchases p
                  where p.user_id = v_me and p.shop_item_id = v_item.id)
     and not (v_item.is_active and v_item.cost = 0 and v_item.unlock_badge_id is null) then
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
          and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
               or (i.is_active and i.cost = 0 and i.unlock_badge_id is null))) then
    v_cos := v_cos || array['avatar_bg_color', 'avatar_emoji'];
  end if;
  if new.list_name_style_id is distinct from old.list_name_style_id
     and new.list_name_style_id is not null
     and not exists (
       select 1 from public.shop_items i
        where i.category = 'list_name_style' and i.slug = new.list_name_style_id
          and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
               or (i.is_active and i.cost = 0 and i.unlock_badge_id is null))) then
    v_cos := v_cos || 'list_name_style_id'::text;
  end if;
  if new.name_color is distinct from old.name_color
     and new.name_color is not null
     and not exists (
       select 1 from public.shop_items i
        where i.category = 'flair' and i.payload ->> 'kind' = 'name_color' and i.payload ->> 'value' = new.name_color
          and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
               or (i.is_active and i.cost = 0 and i.unlock_badge_id is null))) then
    v_cos := v_cos || 'name_color'::text;
  end if;
  if new.profile_name_style_id is distinct from old.profile_name_style_id
     and new.profile_name_style_id is not null
     and not exists (
       select 1 from public.shop_items i
        where i.category = 'profile_name_style' and i.slug = new.profile_name_style_id
          and (exists (select 1 from public.player_shop_purchases p where p.user_id = new.id and p.shop_item_id = i.id)
               or (i.is_active and i.cost = 0 and i.unlock_badge_id is null))) then
    v_cos := v_cos || 'profile_name_style_id'::text;
  end if;

  if cardinality(v_cos) > 0 then
    raise exception using
      message = 'Your profile wasn''t saved: you can only equip Shop items you own. Buy it in the Shop first, or pick one from your inventory.',
      detail  = jsonb_build_object('columns', to_jsonb(v_cos))::text,
      hint    = 'pl:shop.not_owned';
  end if;
  return new;
end;
$$;
revoke execute on function public._pl_profiles_column_guard() from public, anon, authenticated;
-- trg_profiles_column_guard (migration_profiles_column_guard.sql) already runs
-- this function; it is not recreated here, so applying takes no ACCESS
-- EXCLUSIVE lock on profiles.
