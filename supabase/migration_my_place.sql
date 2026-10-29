-- ============================================================
-- My Place, phase 2: the server for the decoratable room.
--
-- My Place is Doggle's Pet Home on the kit's /room module (expo-foundation
-- 1.78.0+): a fixed set of anchored SLOTS, one owned item per slot. Players
-- only choose which item fills a slot; they never move, resize or arrange
-- anything. Where each slot is drawn is ONE admin layout for every room,
-- written only by the God mode account through save_room_layout.
--
-- Brian's decisions (2026-10-27, binding):
--   * Slots anchored exactly like Doggle. No player arrangement mode, ever.
--   * Named "My Place". Visible to signed-in players, blocks applied both ways,
--     with a per-owner setting: friends (default) | only_me.
--   * Decor is sold inside My Place, in pickles. Not a Shop tab, so it has its
--     own tables and buy RPC (buy_home_item), with purchase_shop_item's balance
--     lock and the pickle_ledger conventions. shop_items is not touched.
--
-- Design (Doggle 0012 / 0090 / 0291, plus the kit's server contract in
-- expo-foundation UPGRADING.md 1.78.0):
--
-- ── Tables (RLS on all; no client write policies; writes only via RPCs) ──
--   room_layout     (id text pk default 'default', layout jsonb, updated_at,
--                    updated_by). layout = {"version": 1, "placements":
--                    {slotId: {kind, cx, bottom, w, z?, flip?}}} (fields by
--                    kind, see _pl_room_layout_problem). Signed-in players read
--                    it; save_room_layout writes it. Stored whole: keys the
--                    server does not check (a newer build's slots) are kept.
--   home_slots      The server's copy of the app's slot STRUCTURE (id, label,
--                    kind, fits, parent_id, sort), so equip can check fit and
--                    the parent rule. Placements are not here (the layout is),
--                    and SlotDef[] stays the app's source: phase 4 adds a
--                    vitest that fails when the two differ (the same pattern as
--                    profileCustomizationServer.test.ts). Seeded below.
--   home_items      The catalog: id, name, slot_group (the kit's `fits`),
--                    cost (pickles, 0 = free), rarity, season, available_from,
--                    available_until (exclusive), art_key (bundled art),
--                    art_aspect, icon, sort, is_starter. Signed-in players read
--                    it all (the app hides ended items a player doesn't own).
--                    Retire an item with available_until = now() and
--                    is_starter = false, never a delete: owned and equipped
--                    rows reference it on delete restrict, so deleting an
--                    item someone bought is refused, not a silent loss.
--   home_item_art   item_id -> art_svg (server-provided SVG, sanitized on the
--                    device). Separate so catalog lists stay light. Readable by
--                    signed-in players.
--   home_owned_items (owner_id, item_id, acquired_at, cost_paid, source
--                    'buy' | 'starter' | 'grant'). A player reads their own.
--   home_equipped   (owner_id, slot_id, item_id, updated_at); pk (owner, slot)
--                    = one item per slot; unique (owner, item) = an item is in
--                    one slot at a time (equipping it elsewhere moves it). A
--                    player reads their own; others' come from get_home.
--   home_settings   (owner_id, visibility 'friends' | 'only_me', updated_at).
--                    No row = friends. A player reads their own.
--   home_starter_claims (owner_id, claimed_at): the free starter set, once.
--
-- ── Client RPCs (SECURITY DEFINER, search_path '', authenticated only, all
--    in migration_rls_hardening_2026q3.sql's allowlist) ───────────────────
--   get_home(p_owner uuid default null) -> jsonb
--     null / your own id: {owner_id, is_me: true, visibility, equipped:
--       {slot: item}, item_ids: [equipped ids], owned: [ids], starter_claimed,
--       balance}. Someone else's: {owner_id, is_me: false, visibility,
--       equipped, item_ids}. Layout-independent: the app reads room_layout
--       and the catalog itself.
--   buy_home_item(p_item_id text) -> jsonb {item_id, cost, balance,
--       already_owned}. Already owned = success, nothing charged (a retried
--       buy is safe). Does not equip: the kit's useRoomShop calls equip next.
--   equip_home_item(p_slot_id text, p_item_id text) -> jsonb {slot_id,
--       item_id, moved_from, equipped}. Any slot but the avatar's (attached
--       slots too, like the kit's useRoomShop). The parent rule walks the
--       whole chain like the kit's emptyParentSlot (avatar parents count as
--       there).
--   clear_home_slot(p_slot_id text) -> jsonb {slot_id, cleared, equipped}.
--       An empty slot clears fine (cleared false). Items sitting on it stay
--       equipped; the kit hides them until the slot is filled again.
--   set_my_place_visibility(p_visibility text) -> jsonb {visibility}
--   claim_my_place_starter() -> jsonb {claimed, claimed_at, items, equipped}.
--       Once per account; a second call is not an error (claimed false), so
--       the app can call it every time My Place opens until it sticks. Each
--       starter item goes in the first slot (by sort) it fits that is empty
--       and whose parent chain is filled.
--   save_room_layout(p_layout jsonb) -> jsonb {id, updated_at}. God mode only
--       (is_godmode_user(auth.uid()), the one hardcoded admin id, mirroring
--       mobile/src/lib/godmode.ts). Shape checked server side.
--
-- ── Refusals (SQLSTATE P0001, HINT 'pl:<code>', a message for people;
--    DETAIL a small JSON object where noted) ───────────────────────────────
--   auth.signed_out       no session (every RPC)
--   request.bad           a missing id, or a visibility that isn't friends / only_me
--   admin.only            save_room_layout by anyone but God mode
--   home.layout_bad       DETAIL {slot, reason}: the layout's shape
--   home.layout_newer     DETAIL {version}: any version above 1 (as the kit's migrateLayout reads it)
--   home.item_gone        DETAIL {item_id}: no such catalog item
--   home.not_yet          DETAIL {item, available_from}: not on sale yet
--   home.ended            DETAIL {item, available_until}: its drop has ended
--   home.not_enough       DETAIL {item, cost, balance, short}
--   home.slot_unknown     DETAIL {slot_id}: a slot this server doesn't know
--   home.wrong_slot       DETAIL {item, slot, fits, slot_fits}: doesn't fit, or the avatar spot
--   home.not_owned        DETAIL {item}
--   home.parent_empty     DETAIL {slot, parent}: it sits on an empty spot (the first one down the chain)
--   player.gone           get_home: the owner deleted their account (or never existed)
--   home.unavailable      get_home: a block between you, either way
--   home.guest            get_home: a guest pass visiting someone else
--   home.private          DETAIL {name}: the owner set Only me
--   home.friends_only     DETAIL {name}: the owner shares with friends; you aren't one
--
-- ── Pickles ───────────────────────────────────────────────────────────────
--   buy_home_item locks the buyer's profiles row (select ... for update), as
--   purchase_shop_item does, then takes the price in the same transaction as
--   the owned row. migration_pickle_ledger.sql's capture trigger writes the
--   ledger row: pickle_ledger_sources gains ('buy_home_item', -1, 'My Place
--   purchase', spend, shop), and the RPC names the item through
--   pl.pickle_reason ("My Place: Maple Floor") and pl.pickle_meta {item_id,
--   item}. A free item takes no pickles and writes no ledger row.
--
-- ── Account deletion ──────────────────────────────────────────────────────
--   _purge_account tombstones the profile (deleted_at set), so the FKs' on
--   delete cascade never fires. trg_profiles_my_place_purge (AFTER UPDATE on
--   profiles WHEN deleted_at becomes non-null; the ledger's pattern) deletes
--   the account's owned items, equipped map, settings and starter claim.
--   _purge_account itself is not replaced.
--
-- New internal functions (execute revoked from public, anon, authenticated):
--   _pl_room_layout_problem(jsonb), _pl_home_equipped(uuid),
--   _pl_home_empty_parent(uuid, text), _pl_my_place_purge() (trigger).
-- Replaced: none (check-replaced-functions.mjs needs no entry).
--
-- ── Locks ─────────────────────────────────────────────────────────────────
--   Every RPC that writes a player's rows (buy, equip, clear, the starter
--   claim) first locks that player's profiles row (select ... for update), so
--   two calls from one player at once (a double tap, two devices) run one
--   after the other: the second sees the first's rows and never trips a raw
--   unique-key error.
--   New tables only, plus one CREATE OR REPLACE TRIGGER on profiles (SHARE ROW
--   EXCLUSIVE: profile writes wait until the file's transaction ends, reads
--   don't). RLS and policies are created only when missing, so a re-run takes
--   no ACCESS EXCLUSIVE lock.
--
-- Idempotent; no top-level transaction. Seeds: slots upserted, the layout row
-- only when missing, the placeholder items only into an empty catalog (so a
-- re-run never undoes an admin edit and never brings back a retired or
-- deleted placeholder). Persona test: supabase/tests/my_place_personas.sql
--   (node supabase/tests/build-my-place-test.mjs <out.sql>).
-- Contract for the phase 4 screens: docs/my-place.md.
-- Apply after migration_pickle_ledger.sql with:
--   supabase db query --linked -f supabase/migration_my_place.sql
-- ============================================================


-- ════ 1. Tables ══════════════════════════════════════════════════════════
create table if not exists public.room_layout (
  id         text primary key default 'default',
  layout     jsonb not null default '{"version": 1, "placements": {}}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.room_layout is
  'migration_my_place.sql: the admin''s My Place layout, one placement per slot. Written only by save_room_layout.';

create table if not exists public.home_slots (
  id        text primary key,
  label     text not null,
  kind      text not null,
  fits      text not null,
  parent_id text,
  sort      integer not null default 0,
  constraint home_slots_id_chk check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint home_slots_kind_chk check (kind in ('furniture', 'prop', 'free', 'wide', 'floor', 'avatar', 'attached', 'backdrop'))
);
comment on table public.home_slots is
  'migration_my_place.sql: the server''s copy of the app''s My Place slot structure (fit groups, parents), for equip checks. Mirrors the app''s SlotDef[].';

create table if not exists public.home_items (
  id              text primary key,
  name            text not null,
  slot_group      text not null,
  cost            integer not null default 0,
  rarity          text not null default 'common',
  season          text,
  available_from  timestamptz,
  available_until timestamptz,
  art_key         text,
  art_aspect      numeric,
  icon            text,
  sort            integer not null default 0,
  is_starter      boolean not null default false,
  created_at      timestamptz not null default now(),
  constraint home_items_id_chk check (id ~ '^[a-z0-9_]{1,64}$'),
  constraint home_items_name_chk check (btrim(name) <> ''),
  constraint home_items_cost_chk check (cost >= 0 and cost <= 1000000),
  constraint home_items_rarity_chk check (rarity in ('common', 'rare', 'legendary')),
  constraint home_items_season_chk check (season is null or season ~ '^\d{4}-\d{2}$'),
  constraint home_items_window_chk check (available_from is null or available_until is null or available_until > available_from),
  constraint home_items_aspect_chk check (art_aspect is null or art_aspect > 0)
);
comment on table public.home_items is
  'migration_my_place.sql: the My Place decor catalog, sold in pickles by buy_home_item. Art SVG lives in home_item_art.';

create table if not exists public.home_item_art (
  item_id    text primary key references public.home_items (id) on delete cascade,
  art_svg    text not null,
  updated_at timestamptz not null default now(),
  constraint home_item_art_size_chk check (octet_length(art_svg) <= 100000)
);

create table if not exists public.home_owned_items (
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  item_id     text not null references public.home_items (id) on delete restrict,
  acquired_at timestamptz not null default now(),
  cost_paid   integer not null default 0,
  source      text not null default 'buy',
  primary key (owner_id, item_id),
  constraint home_owned_items_source_chk check (source in ('buy', 'starter', 'grant'))
);
create index if not exists home_owned_items_item_idx on public.home_owned_items (item_id);

create table if not exists public.home_equipped (
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  slot_id    text not null,
  item_id    text not null references public.home_items (id) on delete restrict,
  updated_at timestamptz not null default now(),
  primary key (owner_id, slot_id),
  constraint home_equipped_one_slot_per_item unique (owner_id, item_id)
);
create index if not exists home_equipped_item_idx on public.home_equipped (item_id);

create table if not exists public.home_settings (
  owner_id   uuid primary key references public.profiles (id) on delete cascade,
  visibility text not null default 'friends',
  updated_at timestamptz not null default now(),
  constraint home_settings_visibility_chk check (visibility in ('friends', 'only_me'))
);

create table if not exists public.home_starter_claims (
  owner_id   uuid primary key references public.profiles (id) on delete cascade,
  claimed_at timestamptz not null default now()
);

-- RLS and the read policies, only when missing (no ACCESS EXCLUSIVE on a re-run).
do $$
declare
  t text;
begin
  foreach t in array array['room_layout', 'home_slots', 'home_items', 'home_item_art', 'home_owned_items',
                           'home_equipped', 'home_settings', 'home_starter_claims'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;

  -- Shared, read by every signed-in player.
  foreach t in array array['room_layout', 'home_slots', 'home_items', 'home_item_art'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                      and policyname = t || '_select_signed_in') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select_signed_in', t);
    end if;
  end loop;

  -- A player's own rows. Other players' rooms come from get_home.
  foreach t in array array['home_owned_items', 'home_equipped', 'home_settings', 'home_starter_claims'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
                      and policyname = t || '_select_own') then
      execute format('create policy %I on public.%I for select to authenticated using (owner_id = (select auth.uid()))',
                     t || '_select_own', t);
    end if;
  end loop;

  -- Select only for clients; every write goes through the RPCs below.
  foreach t in array array['room_layout', 'home_slots', 'home_items', 'home_item_art', 'home_owned_items',
                           'home_equipped', 'home_settings', 'home_starter_claims'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;


-- ════ 2. Seeds ═══════════════════════════════════════════════════════════
-- The layout row: empty placements = every slot at the app's code default.
insert into public.room_layout (id, layout) values ('default', '{"version": 1, "placements": {}}'::jsonb)
on conflict (id) do nothing;

-- The slot structure (phase 4's SlotDef[] must match: id, label, kind, fits,
-- parent). Upserted: this file is the server's source for it.
insert into public.home_slots (id, label, kind, fits, parent_id, sort) values
  ('wallpaper',    'Wallpaper',    'backdrop',  'wallpaper',   null,    10),
  ('floor',        'Floor',        'backdrop',  'floor',       null,    20),
  ('rug',          'Rug',          'wide',      'rug',         null,    30),
  ('window',       'Window',       'free',      'window',      null,    40),
  ('wall_art',     'Wall art',     'free',      'wall_art',    null,    50),
  ('paddle_rack',  'Paddle rack',  'free',      'paddle_rack', null,    60),
  ('ceiling',      'Ceiling',      'free',      'ceiling',     null,    70),
  ('shelf',        'Shelf',        'furniture', 'shelf',       null,    80),
  ('shelf_item',   'Shelf top',    'prop',      'shelf_item',  'shelf', 90),
  ('couch',        'Couch',        'furniture', 'couch',       null,   100),
  ('couch_pillow', 'Couch pillow', 'prop',      'couch_pillow', 'couch', 110),
  ('accent',       'Corner',       'floor',     'accent',      null,   120),
  ('accent2',      'Second corner', 'floor',    'accent',      null,   130),
  ('avatar',       'You',          'avatar',    'avatar',      null,   900)
on conflict (id) do update
  set label = excluded.label, kind = excluded.kind, fits = excluded.fits,
      parent_id = excluded.parent_id, sort = excluded.sort;

-- Placeholder catalog (art_svg null: the kit draws its dashed placeholder).
-- The real ~30 items come in phase 3; these ids start with ph_ so phase 3 can
-- retire them (available_until = now(), is_starter = false; see home_items).
-- Seeded only into an empty catalog: a re-run never resets a price and never
-- brings back a placeholder that was retired or deleted.
do $$
begin
if not exists (select 1 from public.home_items) then
insert into public.home_items (id, name, slot_group, cost, rarity, season, available_from, available_until, art_key, art_aspect, icon, sort, is_starter) values
  ('ph_wall_white',     'Plain Walls',        'wallpaper',    0,    'common',    null, null, null, null, null, '🏠', 10, true),
  ('ph_floor_maple',    'Maple Floor',        'floor',        0,    'common',    null, null, null, null, null, '🪵', 20, true),
  ('ph_couch_basic',    'Comfy Couch',        'couch',        0,    'common',    null, null, null, null, null, '🛋️', 30, true),
  ('ph_plant',          'Potted Plant',       'accent',       0,    'common',    null, null, null, null, null, '🪴', 40, true),
  ('ph_wall_court',     'Court Green Walls',  'wallpaper',    900,  'common',    null, null, null, null, null, '🟩', 50, false),
  ('ph_floor_court',    'Court Lines Floor',  'floor',        1200, 'common',    null, null, null, null, null, '🎾', 60, false),
  ('ph_rug_ball',       'Pickleball Rug',     'rug',          900,  'common',    null, null, null, null, null, '🟡', 70, false),
  ('ph_window_park',    'Park View Window',   'window',       1500, 'common',    null, null, null, null, null, '🪟', 80, false),
  ('ph_poster',         'Tournament Poster',  'wall_art',     900,  'common',    null, null, null, null, null, '🖼️', 90, false),
  ('ph_paddle_rack',    'Paddle Wall Rack',   'paddle_rack',  2500, 'rare',      null, null, null, null, null, '🏓', 100, false),
  ('ph_ceiling_fan',    'Ceiling Fan',        'ceiling',      900,  'common',    null, null, null, null, null, '🌀', 110, false),
  ('ph_shelf',          'Wooden Shelf',       'shelf',        1200, 'common',    null, null, null, null, null, '📚', 120, false),
  ('ph_trophy',         'Gold Trophy',        'shelf_item',   5000, 'legendary', null, null, null, null, null, '🏆', 130, false),
  ('ph_pillow_ball',    'Ball Pillow',        'couch_pillow', 900,  'common',    null, null, null, null, null, '🟢', 140, false),
  ('ph_ball_bucket',    'Ball Bucket',        'accent',       900,  'common',    null, null, null, null, null, '🪣', 150, false)
on conflict (id) do nothing;
end if;
end $$;

-- The ledger's wording for a My Place buy (migration_pickle_ledger.sql rule 3).
insert into public.pickle_ledger_sources (source, sign, reason, kind, category, is_bonus, why) values
  ('buy_home_item', -1, 'My Place purchase', 'spend', 'shop', false, null)
on conflict (source, sign) do update
  set reason = excluded.reason, kind = excluded.kind, category = excluded.category,
      is_bonus = excluded.is_bonus, why = excluded.why;


-- ════ 3. Internal helpers ════════════════════════════════════════════════
-- What is wrong with a layout, or null when it is fine: {slot, reason}, or
-- {version} for a newer version. The kit's validatePlacement rules
-- (expo-foundation src/room/layout.ts): right kind for a known slot, every
-- field a number, positions within -1..2, the size above 0 and at most 4,
-- `ar` above 0, `z` a number (null is "not set" for those two). `flip` is
-- not checked: the kit reads only `flip: true` and ignores anything else. Any
-- version above 1 is a newer layout ({version}), as migrateLayout reads it.
-- A placement for a slot this server doesn't know is checked
-- the same way but kept (a newer app build's slot). Backdrop slots have no
-- placement. Other keys are kept as they are.
create or replace function public._pl_room_layout_problem(p_layout jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key    text;
  v_p      jsonb;
  v_kind   text;
  v_fields text[];
  v_f      text;
  v_n      numeric;
  v_slot   public.home_slots;
  v_ver    numeric;
begin
  if p_layout is null or jsonb_typeof(p_layout) <> 'object' then
    return jsonb_build_object('slot', null, 'reason', 'The layout must be an object with "version" and "placements".');
  end if;
  if octet_length(p_layout::text) > 65536 then
    return jsonb_build_object('slot', null, 'reason', 'The layout is larger than 64 KB.');
  end if;
  if jsonb_typeof(p_layout -> 'version') is distinct from 'number' then
    return jsonb_build_object('slot', null, 'reason', '"version" must be a number.');
  end if;
  v_ver := (p_layout ->> 'version')::numeric;
  if v_ver > 1 then
    return jsonb_build_object('version', v_ver);
  end if;
  if v_ver <> 1 then
    return jsonb_build_object('slot', null, 'reason', '"version" must be 1.');
  end if;
  if jsonb_typeof(p_layout -> 'placements') is distinct from 'object' then
    return jsonb_build_object('slot', null, 'reason', '"placements" must be an object of slot id to placement.');
  end if;
  if (select count(*) from jsonb_object_keys(p_layout -> 'placements')) > 200 then
    return jsonb_build_object('slot', null, 'reason', 'The layout places more than 200 slots.');
  end if;

  for v_key, v_p in select k, v from jsonb_each(p_layout -> 'placements') as e (k, v) loop
    if v_key !~ '^[A-Za-z0-9_-]{1,64}$' then
      return jsonb_build_object('slot', left(v_key, 64), 'reason', 'A slot id must be 1 to 64 letters, digits, "_" or "-".');
    end if;
    select * into v_slot from public.home_slots s where s.id = v_key;
    if v_slot.id is not null and v_slot.kind = 'backdrop' then
      return jsonb_build_object('slot', v_key, 'reason', format('Slot "%s" is painted on the backdrop, so it has no placement.', v_key));
    end if;
    if jsonb_typeof(v_p) is distinct from 'object' then
      return jsonb_build_object('slot', v_key, 'reason', 'The placement is missing.');
    end if;
    v_kind := case when jsonb_typeof(v_p -> 'kind') = 'string' then v_p ->> 'kind' end;
    v_fields := case v_kind
      when 'furniture' then array['cx', 'bottom', 'w']
      when 'prop'      then array['u', 'surface', 'scale']
      when 'free'      then array['cx', 'top', 'w']
      when 'wide'      then array['cx', 'top', 'w']
      when 'floor'     then array['u', 'baseY', 'scale']
      when 'avatar'    then array['cx', 'bottom', 'w']
      when 'attached'  then array['dx', 'dy', 'scale']
    end;
    if v_fields is null then
      return jsonb_build_object('slot', v_key, 'reason', format('"%s" is not a placement kind.', coalesce(v_p ->> 'kind', 'null')));
    end if;
    if v_slot.id is not null and v_slot.kind <> v_kind then
      return jsonb_build_object('slot', v_key, 'reason', format('Slot "%s" is a %s, not a %s.', v_key, v_slot.kind, v_kind));
    end if;
    -- The third field is the size; the other two are positions.
    for i in 1 .. 3 loop
      v_f := v_fields[i];
      if jsonb_typeof(v_p -> v_f) is distinct from 'number' then
        return jsonb_build_object('slot', v_key, 'reason', format('"%s" must be a number.', v_f));
      end if;
      v_n := (v_p ->> v_f)::numeric;
      if i = 3 and (v_n <= 0 or v_n > 4) then
        return jsonb_build_object('slot', v_key, 'reason', format('"%s" must be above 0 and at most 4.', v_f));
      elsif i < 3 and (v_n < -1 or v_n > 2) then
        return jsonb_build_object('slot', v_key, 'reason', format('"%s" must be between -1 and 2.', v_f));
      end if;
    end loop;
    if v_kind = 'wide' and coalesce(jsonb_typeof(v_p -> 'ar'), 'null') <> 'null'
       and (jsonb_typeof(v_p -> 'ar') <> 'number' or (v_p ->> 'ar')::numeric <= 0) then
      return jsonb_build_object('slot', v_key, 'reason', '"ar" must be a number above 0.');
    end if;
    if coalesce(jsonb_typeof(v_p -> 'z'), 'null') not in ('null', 'number') then
      return jsonb_build_object('slot', v_key, 'reason', '"z" must be a number.');
    end if;
  end loop;
  return null;
end $$;
revoke execute on function public._pl_room_layout_problem(jsonb) from public, anon, authenticated;

-- A player's slot -> item map.
create or replace function public._pl_home_equipped(p_owner uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(e.slot_id, e.item_id order by e.slot_id), '{}'::jsonb)
    from public.home_equipped e where e.owner_id = p_owner;
$$;
revoke execute on function public._pl_home_equipped(uuid) from public, anon, authenticated;

-- The first slot p_slot sits on (directly or further down) that the owner
-- has left empty, so an item put there would not show; null when none is.
-- The kit's emptyParentSlot: avatar parents count as there (the avatar
-- always is), a parent that is not a slot ends the walk, and the walk stops
-- after 17 steps (a loop in the structure).
create or replace function public._pl_home_empty_parent(p_owner uuid, p_slot text)
returns public.home_slots
language plpgsql
stable
set search_path = ''
as $$
declare
  v_cur    public.home_slots;
  v_parent public.home_slots;
begin
  select * into v_cur from public.home_slots s where s.id = p_slot;
  for depth in 0 .. 16 loop
    exit when v_cur.id is null or v_cur.parent_id is null;
    v_parent := null;
    select * into v_parent from public.home_slots s where s.id = v_cur.parent_id;
    if v_parent.id is null then
      return null;
    end if;
    if v_parent.kind <> 'avatar'
       and not exists (select 1 from public.home_equipped e where e.owner_id = p_owner and e.slot_id = v_parent.id) then
      return v_parent;
    end if;
    v_cur := v_parent;
  end loop;
  return null;
end $$;
revoke execute on function public._pl_home_empty_parent(uuid, text) from public, anon, authenticated;


-- ════ 4. save_room_layout (God mode only) ════════════════════════════════
create or replace function public.save_room_layout(p_layout jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_bad  jsonb;
  v_row  public.room_layout;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if not coalesce(public.is_godmode_user(v_me), false) then
    raise exception using
      message = 'Only the Pickleague admin can move My Place spots. Nothing was changed; your own room is decorated by picking items for each spot.',
      hint    = 'pl:admin.only';
  end if;

  v_bad := public._pl_room_layout_problem(p_layout);
  if v_bad ? 'version' then
    raise exception using
      message = format('The layout wasn''t saved: it is version %s, and this server only checks version 1. Apply the newer My Place migration, then save again.', v_bad ->> 'version'),
      detail  = v_bad::text,
      hint    = 'pl:home.layout_newer';
  elsif v_bad is not null then
    raise exception using
      message = 'The layout wasn''t saved: ' || coalesce((v_bad ->> 'slot') || ': ', '') || (v_bad ->> 'reason')
                || ' Fix that spot in the editor, then save again.',
      detail  = v_bad::text,
      hint    = 'pl:home.layout_bad';
  end if;

  insert into public.room_layout (id, layout, updated_at, updated_by)
  values ('default', p_layout, now(), v_me)
  on conflict (id) do update set layout = excluded.layout, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'updated_at', v_row.updated_at);
end $$;
revoke execute on function public.save_room_layout(jsonb) from public, anon;
grant execute on function public.save_room_layout(jsonb) to authenticated;


-- ════ 5. buy_home_item ═══════════════════════════════════════════════════
create or replace function public.buy_home_item(p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      uuid := auth.uid();
  v_item    public.home_items;
  v_balance integer;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_item_id is null or btrim(p_item_id) = '' then
    raise exception using
      message = 'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;

  select * into v_item from public.home_items where id = p_item_id;
  if v_item.id is null then
    raise exception using
      message = 'That item isn''t sold in My Place any more, so nothing was spent. Pull to refresh and pick another.',
      detail  = jsonb_build_object('item_id', p_item_id)::text,
      hint    = 'pl:home.item_gone';
  end if;

  -- The balance row first: two buys at once queue here, so the owned check
  -- and the price below see each other.
  select coalesce(p.pickles, 0) into v_balance from public.profiles p
   where p.id = v_me and p.deleted_at is null for update;
  if not found then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  -- Already yours: nothing to do, nothing charged (a retried buy is safe).
  if exists (select 1 from public.home_owned_items o where o.owner_id = v_me and o.item_id = v_item.id) then
    return jsonb_build_object('item_id', v_item.id, 'cost', 0, 'balance', v_balance, 'already_owned', true);
  end if;

  if v_item.available_from is not null and now() < v_item.available_from then
    raise exception using
      message = v_item.name || ' isn''t on sale yet, so nothing was spent. Check back when its drop starts.',
      detail  = jsonb_build_object('item', v_item.name, 'available_from', v_item.available_from)::text,
      hint    = 'pl:home.not_yet';
  end if;
  if v_item.available_until is not null and now() >= v_item.available_until then
    raise exception using
      message = v_item.name || ' is no longer sold: its drop has ended, so nothing was spent. Pick another item.',
      detail  = jsonb_build_object('item', v_item.name, 'available_until', v_item.available_until)::text,
      hint    = 'pl:home.ended';
  end if;
  if v_balance < v_item.cost then
    raise exception using
      message = format('%s costs %s pickles and you have %s, so nothing was spent. Earn %s more by playing, then come back.',
                       v_item.name, to_char(v_item.cost, 'FM999,999,999'), to_char(v_balance, 'FM999,999,999'),
                       to_char(v_item.cost - v_balance, 'FM999,999,999')),
      detail  = jsonb_build_object('item', v_item.name, 'cost', v_item.cost, 'balance', v_balance,
                                   'short', v_item.cost - v_balance)::text,
      hint    = 'pl:home.not_enough';
  end if;

  if v_item.cost > 0 then
    perform set_config('pl.pickle_reason', left('My Place: ' || v_item.name, 200), true);
    perform set_config('pl.pickle_meta', jsonb_build_object('item_id', v_item.id, 'item', v_item.name)::text, true);
    update public.profiles set pickles = coalesce(pickles, 0) - v_item.cost where id = v_me
    returning pickles into v_balance;
    perform set_config('pl.pickle_reason', '', true);
    perform set_config('pl.pickle_meta', '', true);
  end if;

  insert into public.home_owned_items (owner_id, item_id, cost_paid, source)
  values (v_me, v_item.id, v_item.cost, 'buy');

  return jsonb_build_object('item_id', v_item.id, 'cost', v_item.cost, 'balance', v_balance, 'already_owned', false);
end $$;
revoke execute on function public.buy_home_item(text) from public, anon;
grant execute on function public.buy_home_item(text) to authenticated;


-- ════ 6. equip_home_item / clear_home_slot ═══════════════════════════════
create or replace function public.equip_home_item(p_slot_id text, p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_slot   public.home_slots;
  v_parent public.home_slots;
  v_item   public.home_items;
  v_from   text;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_slot_id is null or p_item_id is null then
    raise exception using
      message = 'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;

  -- One call per player at a time (a double tap, two devices; see Locks).
  perform 1 from public.profiles p where p.id = v_me and p.deleted_at is null for update;
  if not found then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  select * into v_slot from public.home_slots where id = p_slot_id;
  if v_slot.id is null then
    raise exception using
      message = 'That spot isn''t in My Place on this server yet, so nothing was put in. Update Pickleague, then try again.',
      detail  = jsonb_build_object('slot_id', p_slot_id)::text,
      hint    = 'pl:home.slot_unknown';
  end if;

  select * into v_item from public.home_items where id = p_item_id;
  if v_item.id is null then
    raise exception using
      message = 'That item isn''t in My Place any more, so it can''t be put in. Pull to refresh and pick another.',
      detail  = jsonb_build_object('item_id', p_item_id)::text,
      hint    = 'pl:home.item_gone';
  end if;

  if v_slot.kind = 'avatar' or v_item.slot_group <> v_slot.fits then
    raise exception using
      message = case when v_slot.kind = 'avatar'
                  then 'That spot is where you stand, so decor doesn''t go there. Pick another spot.'
                  else v_item.name || ' doesn''t fit ' || v_slot.label || '. Pick an item from the ' || v_slot.label || ' list.' end,
      detail  = jsonb_build_object('item', v_item.name, 'slot', v_slot.label, 'fits', v_item.slot_group,
                                   'slot_fits', v_slot.fits)::text,
      hint    = 'pl:home.wrong_slot';
  end if;

  if not exists (select 1 from public.home_owned_items o where o.owner_id = v_me and o.item_id = v_item.id) then
    raise exception using
      message = 'You don''t own ' || v_item.name || ' yet, so it can''t be put in. Buy it in My Place first.',
      detail  = jsonb_build_object('item', v_item.name)::text,
      hint    = 'pl:home.not_owned';
  end if;

  -- The parent rule: an item on an empty spot wouldn't show (the kit hides
  -- it). The whole chain, like the kit's emptyParentSlot.
  v_parent := public._pl_home_empty_parent(v_me, v_slot.id);
  if v_parent.id is not null then
    raise exception using
      message = v_item.name || ' sits on the ' || v_parent.label || ' spot, which is empty, so it wouldn''t show. Put something in '
                || v_parent.label || ' first, then come back.',
      detail  = jsonb_build_object('slot', v_slot.label, 'parent', v_parent.label)::text,
      hint    = 'pl:home.parent_empty';
  end if;

  -- One slot per item: equipping it here moves it from another slot.
  delete from public.home_equipped e
   where e.owner_id = v_me and e.item_id = v_item.id and e.slot_id <> v_slot.id
  returning e.slot_id into v_from;

  insert into public.home_equipped (owner_id, slot_id, item_id, updated_at)
  values (v_me, v_slot.id, v_item.id, now())
  on conflict (owner_id, slot_id) do update set item_id = excluded.item_id, updated_at = excluded.updated_at;

  return jsonb_build_object('slot_id', v_slot.id, 'item_id', v_item.id, 'moved_from', v_from,
                            'equipped', public._pl_home_equipped(v_me));
end $$;
revoke execute on function public.equip_home_item(text, text) from public, anon;
grant execute on function public.equip_home_item(text, text) to authenticated;

create or replace function public.clear_home_slot(p_slot_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_n  integer;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_slot_id is null then
    raise exception using
      message = 'That didn''t go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;
  -- One call per player at a time, like equip_home_item.
  perform 1 from public.profiles p where p.id = v_me and p.deleted_at is null for update;
  if not found then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  -- Any slot id, known or not: a row a newer build made can still be emptied.
  delete from public.home_equipped e where e.owner_id = v_me and e.slot_id = p_slot_id;
  get diagnostics v_n = row_count;
  return jsonb_build_object('slot_id', p_slot_id, 'cleared', v_n > 0, 'equipped', public._pl_home_equipped(v_me));
end $$;
revoke execute on function public.clear_home_slot(text) from public, anon;
grant execute on function public.clear_home_slot(text) to authenticated;


-- ════ 7. set_my_place_visibility ═════════════════════════════════════════
create or replace function public.set_my_place_visibility(p_visibility text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  if p_visibility is null or p_visibility not in ('friends', 'only_me') then
    raise exception using
      message = 'That didn''t go through: pick who sees My Place, Friends or Only me. If you did, update Pickleague, then try again.',
      hint    = 'pl:request.bad';
  end if;
  insert into public.home_settings (owner_id, visibility, updated_at) values (v_me, p_visibility, now())
  on conflict (owner_id) do update set visibility = excluded.visibility, updated_at = excluded.updated_at;
  return jsonb_build_object('visibility', p_visibility);
end $$;
revoke execute on function public.set_my_place_visibility(text) from public, anon;
grant execute on function public.set_my_place_visibility(text) to authenticated;


-- ════ 8. claim_my_place_starter ══════════════════════════════════════════
create or replace function public.claim_my_place_starter()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_at    timestamptz;
  v_items text[];
  r       record;
  v_slot  public.home_slots;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;
  -- One call per player at a time, like equip_home_item.
  perform 1 from public.profiles p where p.id = v_me and p.deleted_at is null for update;
  if not found then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  insert into public.home_starter_claims (owner_id) values (v_me)
  on conflict (owner_id) do nothing
  returning claimed_at into v_at;
  if v_at is null then
    select c.claimed_at into v_at from public.home_starter_claims c where c.owner_id = v_me;
    return jsonb_build_object('claimed', false, 'claimed_at', v_at, 'items', '[]'::jsonb,
                              'equipped', public._pl_home_equipped(v_me));
  end if;

  select coalesce(array_agg(i.id order by i.sort, i.id), '{}') into v_items
    from public.home_items i where i.is_starter;

  insert into public.home_owned_items (owner_id, item_id, cost_paid, source)
  select v_me, x, 0, 'starter' from unnest(v_items) as x
  on conflict (owner_id, item_id) do nothing;

  -- Each into the first empty slot it fits (parents first, by sort), unless
  -- it is in a slot already or a spot under it is empty (the whole chain).
  for r in select i.id, i.slot_group from public.home_items i where i.id = any (v_items) order by i.sort, i.id loop
    continue when exists (select 1 from public.home_equipped e where e.owner_id = v_me and e.item_id = r.id);
    v_slot := null;
    select s.* into v_slot
      from public.home_slots s
     where s.fits = r.slot_group and s.kind <> 'avatar'
       and not exists (select 1 from public.home_equipped e where e.owner_id = v_me and e.slot_id = s.id)
       and (public._pl_home_empty_parent(v_me, s.id)).id is null
     order by s.sort, s.id
     limit 1;
    if v_slot.id is not null then
      insert into public.home_equipped (owner_id, slot_id, item_id) values (v_me, v_slot.id, r.id)
      on conflict do nothing;
    end if;
  end loop;

  return jsonb_build_object('claimed', true, 'claimed_at', v_at, 'items', to_jsonb(v_items),
                            'equipped', public._pl_home_equipped(v_me));
end $$;
revoke execute on function public.claim_my_place_starter() from public, anon;
grant execute on function public.claim_my_place_starter() to authenticated;


-- ════ 9. get_home ════════════════════════════════════════════════════════
create or replace function public.get_home(p_owner uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_owner uuid := coalesce(p_owner, auth.uid());
  v_vis   text;
  v_name  text;
  v_eq    jsonb;
  v_bal   integer;
begin
  if v_me is null then
    raise exception using message = 'You''re signed out. Sign in to Pickleague and try again.', hint = 'pl:auth.signed_out';
  end if;

  select coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'This player'), p.pickles
    into v_name, v_bal
    from public.profiles p where p.id = v_owner and p.deleted_at is null;
  if not found then
    raise exception using
      message = case when v_owner = v_me then 'You''re signed out. Sign in to Pickleague and try again.'
                     else 'That account isn''t in Pickleague any more, so there''s no My Place to visit. Go back and pick someone else.' end,
      hint    = case when v_owner = v_me then 'pl:auth.signed_out' else 'pl:player.gone' end;
  end if;

  select s.visibility into v_vis from public.home_settings s where s.owner_id = v_owner;
  v_vis := coalesce(v_vis, 'friends');
  v_eq  := public._pl_home_equipped(v_owner);

  if v_owner = v_me then
    return jsonb_build_object(
      'owner_id', v_owner, 'is_me', true, 'visibility', v_vis, 'equipped', v_eq,
      'item_ids', coalesce((select jsonb_agg(distinct e.item_id) from public.home_equipped e where e.owner_id = v_owner), '[]'::jsonb),
      'owned', coalesce((select jsonb_agg(o.item_id order by o.acquired_at, o.item_id) from public.home_owned_items o
                          where o.owner_id = v_owner), '[]'::jsonb),
      'starter_claimed', exists (select 1 from public.home_starter_claims c where c.owner_id = v_owner),
      'balance', coalesce(v_bal, 0));
  end if;

  if public._pl_blocked_pair(v_me, v_owner) then
    raise exception using
      message = 'This My Place isn''t available. Go back and visit someone else''s.',
      hint    = 'pl:home.unavailable';
  end if;
  if public._pl_presence_viewer_is_guest(v_me) then
    raise exception using
      message = 'Visiting other players'' places needs a full Pickleague account. Finish signing up, then come back.',
      hint    = 'pl:home.guest';
  end if;
  if v_vis = 'only_me' then
    raise exception using
      message = v_name || ' keeps My Place to themselves right now, so it can''t be visited. Visit a friend''s place instead.',
      detail  = jsonb_build_object('name', v_name)::text,
      hint    = 'pl:home.private';
  end if;
  if not public.are_friends(v_me, v_owner) then
    raise exception using
      message = v_name || ' shares My Place with friends only. Send them a friend request; once they accept, you can visit.',
      detail  = jsonb_build_object('name', v_name)::text,
      hint    = 'pl:home.friends_only';
  end if;

  return jsonb_build_object(
    'owner_id', v_owner, 'is_me', false, 'visibility', v_vis, 'equipped', v_eq,
    'item_ids', coalesce((select jsonb_agg(distinct e.item_id) from public.home_equipped e where e.owner_id = v_owner), '[]'::jsonb));
end $$;
revoke execute on function public.get_home(uuid) from public, anon;
grant execute on function public.get_home(uuid) to authenticated;


-- ════ 10. Account deletion ═══════════════════════════════════════════════
create or replace function public._pl_my_place_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.home_equipped       where owner_id = new.id;
  delete from public.home_owned_items    where owner_id = new.id;
  delete from public.home_settings       where owner_id = new.id;
  delete from public.home_starter_claims where owner_id = new.id;
  return null;
end $$;
revoke execute on function public._pl_my_place_purge() from public, anon, authenticated;

create or replace trigger trg_profiles_my_place_purge
  after update on public.profiles
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public._pl_my_place_purge();

notify pgrst, 'reload schema';
