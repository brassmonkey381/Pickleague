# My Place: server contract

My Place is a decoratable room: Doggle's Pet Home on the kit's `/room` module (expo-foundation 1.78.0+). This page
is the contract the phase 4 screens build against. Server: `supabase/migration_my_place.sql`. Tests:
`supabase/tests/my_place_personas.sql`.

## The rules (Brian, 2026-10-27)

- A room is a fixed set of anchored **slots**. One owned item per slot. Players only pick which item fills a slot.
  They never move, resize or arrange anything. There is no player arrangement mode, ever.
- Where each slot is drawn is **one admin layout** for every room. Only the God mode account saves it
  (`save_room_layout`), from the kit's `RoomLayoutEditor`.
- Visible to signed-in players, blocks applied both ways. Each owner picks **Friends** (default) or **Only me**.
- Decor is sold inside My Place, in pickles. It is not a Shop tab and does not use `shop_items`.

## Phases

| Phase | What | Status |
| --- | --- | --- |
| 1 | Kit `/room` module | expo-foundation 1.78.0 |
| 2 | This server | `migration_my_place.sql` (not applied yet) |
| 3 | About 30 real items with art (Brian reviews PNGs) | next |
| 4 | Screens | after phase 3 |

## Apply

1. Needs `migration_pickle_ledger.sql` live (this file adds a `pickle_ledger_sources` row).
2. `node supabase/tests/build-my-place-test.mjs <out.sql>`, then from the linked checkout
   `supabase db query --linked -f <out.sql> -o csv`. Every row must read `ok = true`. It runs in a rolled-back
   transaction.
3. `supabase db query --linked -f supabase/migration_my_place.sql`. Re-runnable.

## Tables

All have RLS on. Clients get `select` only; every write goes through the RPCs below.

| Table | Rows | Who reads |
| --- | --- | --- |
| `room_layout` | `id` (`'default'`), `layout` jsonb, `updated_at`, `updated_by` | every signed-in player |
| `home_slots` | `id`, `label`, `kind`, `fits`, `parent_id`, `sort`: the server's copy of the slot structure | every signed-in player |
| `home_items` | `id`, `name`, `slot_group`, `cost`, `rarity`, `season`, `available_from`, `available_until`, `art_key`, `art_aspect`, `icon`, `sort`, `is_starter` | every signed-in player |
| `home_item_art` | `item_id`, `art_svg` | every signed-in player |
| `home_owned_items` | `owner_id`, `item_id`, `acquired_at`, `cost_paid`, `source` (`buy`, `starter`, `grant`) | the owner |
| `home_equipped` | `owner_id`, `slot_id`, `item_id` (one item per slot, one slot per item) | the owner |
| `home_settings` | `owner_id`, `visibility` (`friends`, `only_me`; no row = `friends`) | the owner |
| `home_starter_claims` | `owner_id`, `claimed_at` | the owner |

Anon reads nothing. Deleting an account (the tombstone `_purge_account` writes) removes that player's owned items,
equipped map, settings and starter claim.

### Layout shape

```json
{ "version": 1, "placements": { "shelf": { "kind": "furniture", "cx": 0.3, "bottom": 0.8, "w": 0.25, "z": 4, "flip": true } } }
```

Fields per kind (the kit's `validatePlacement`): `furniture` / `avatar` `cx, bottom, w`; `free` / `wide`
`cx, top, w` (+ optional `ar` above 0 on `wide`); `prop` `u, surface, scale`; `floor` `u, baseY, scale`;
`attached` `dx, dy, scale`. Positions -1 to 2, the size above 0 and at most 4, `z` a number. `flip` is not checked (the kit reads only `flip: true`).
`backdrop` slots (wallpaper, floor) take no placement. A placement for a slot the server doesn't know is checked
and kept (a newer build's slot); other keys are kept as sent. At most 200 placements, 64 KB. Any `version` above 1 (1.5 too) is `home.layout_newer`, as
the kit's `migrateLayout` reads it.

### Slots

The app's `SlotDef[]` is the source; `home_slots` mirrors its structure so equip can check fit and parents.
Phase 4 adds a vitest that fails when they differ (like `profileCustomizationServer.test.ts`).

| id | label | kind | fits | parent |
| --- | --- | --- | --- | --- |
| `wallpaper` | Wallpaper | backdrop | wallpaper | |
| `floor` | Floor | backdrop | floor | |
| `rug` | Rug | wide | rug | |
| `window` | Window | free | window | |
| `wall_art` | Wall art | free | wall_art | |
| `paddle_rack` | Paddle rack | free | paddle_rack | |
| `ceiling` | Ceiling | free | ceiling | |
| `shelf` | Shelf | furniture | shelf | |
| `shelf_item` | Shelf top | prop | shelf_item | `shelf` |
| `couch` | Couch | furniture | couch | |
| `couch_pillow` | Couch pillow | prop | couch_pillow | `couch` |
| `accent` | Corner | floor | accent | |
| `accent2` | Second corner | floor | accent | |
| `avatar` | You | avatar | avatar | |

### Seed items

15 placeholders, ids `ph_*`, `art_svg` none (the kit draws its dashed placeholder). Starter set (free, once):
`ph_wall_white`, `ph_floor_maple`, `ph_couch_basic`, `ph_plant`. For sale: 900 to 5,000 pickles. Seeded only into an
empty catalog, so a re-run never brings a placeholder back. Phase 3 retires them with `available_until = now()`
and `is_starter = false`, never a delete: `home_owned_items` and `home_equipped` reference items `on delete
restrict`, so deleting an item someone bought is refused instead of wiping their purchase.

## RPCs

All `security definer`, `search_path ''`, executable by `authenticated` only, and in the
`migration_rls_hardening_2026q3.sql` allowlist. Refusals raise SQLSTATE `P0001` with HINT `pl:<code>` and a
message for people (see the table below).

| RPC | Returns |
| --- | --- |
| `get_home(p_owner uuid default null)` | Yours (null or your id): `{owner_id, is_me: true, visibility, equipped: {slot: item}, item_ids, owned, starter_claimed, balance}`. Someone else's: `{owner_id, is_me: false, visibility, equipped, item_ids}`. |
| `buy_home_item(p_item_id text)` | `{item_id, cost, balance, already_owned}`. Already owned = success, nothing charged. Does not equip. |
| `equip_home_item(p_slot_id text, p_item_id text)` | `{slot_id, item_id, moved_from, equipped}`. An item already in another slot moves (`moved_from`). Any slot but the avatar's (attached slots too). The parent rule walks the whole chain, like the kit's `emptyParentSlot`. |
| `clear_home_slot(p_slot_id text)` | `{slot_id, cleared, equipped}`. An empty or unknown slot is fine (`cleared: false`). Items sitting on the cleared slot stay equipped; the kit hides them. |
| `set_my_place_visibility(p_visibility text)` | `{visibility}` (`friends` or `only_me`) |
| `claim_my_place_starter()` | `{claimed, claimed_at, items, equipped}`. A second call is `claimed: false`, not an error. |
| `save_room_layout(p_layout jsonb)` | `{id, updated_at}`. God mode only. |

Buy, equip, clear and the starter claim each lock the player's profile row first, so two calls at once (a double
tap, two devices) run one after the other. A buy takes the price and adds the owned row in one transaction. The pickle
history row reads "My Place: <item>" (kind spend, category shop). Free items write no history row.

## Refusal codes

| Code | When | DETAIL |
| --- | --- | --- |
| `auth.signed_out` | no session | |
| `request.bad` | a missing id; a visibility that isn't `friends` / `only_me` | |
| `admin.only` | `save_room_layout` by anyone but God mode | |
| `home.layout_bad` | the layout's shape | `{slot, reason}` |
| `home.layout_newer` | a layout version above 1 (any number) | `{version}` |
| `home.item_gone` | no such item | `{item_id}` |
| `home.not_yet` | not on sale yet | `{item, available_from}` |
| `home.ended` | its drop has ended (owners keep and can still equip it) | `{item, available_until}` |
| `home.not_enough` | balance below the price | `{item, cost, balance, short}` |
| `home.slot_unknown` | a slot the server doesn't know (update the app) | `{slot_id}` |
| `home.wrong_slot` | the item doesn't fit, or the avatar spot | `{item, slot, fits, slot_fits}` |
| `home.not_owned` | equipping an item you don't own | `{item}` |
| `home.parent_empty` | the slot sits on an empty slot (the first one down the chain) | `{slot, parent}` |
| `player.gone` | `get_home`: the owner deleted their account | |
| `home.unavailable` | `get_home`: a block between you, either way | |
| `home.guest` | `get_home`: a guest pass visiting someone else | |
| `home.private` | `get_home`: the owner set Only me | `{name}` |
| `home.friends_only` | `get_home`: Friends, and you aren't one | `{name}` |

`mobile/src/lib/refusals.ts` shows the server's message for any `pl:` code it doesn't know, so these work as is.
Phase 4 can add app copy for them there.

## Client contract for phase 4

1. On open: `get_home()`. If `starter_claimed` is false, call `claim_my_place_starter()` and use its `equipped`.
2. Read `room_layout` (cache it; it changes only when the admin saves) and run the kit's `migrateLayout`.
3. Read `home_items` (lists) and `home_item_art` only for the ids you draw. Map `slot_group` to `fits`,
   `art_key` to `art`, `art_svg` to `svg`, `art_aspect` to `aspect`, `available_from` / `available_until` to
   `availableFrom` / `availableUntil`.
4. `useRoomShop`: `onBuy` = `buy_home_item`, `onEquip` = `equip_home_item`, `onClear` = `clear_home_slot`. Balance
   from `get_home().balance` (or the app's pickles source).
5. Visiting: `get_home(<their id>)`. On a refusal, show the message and offer the action it names (friend request,
   go back).
6. Settings: `set_my_place_visibility`. Show the current value from `get_home().visibility`.
7. Admin: show `RoomLayoutEditor` only when `is_godmode_user()` says so; `onSave` = `save_room_layout`.

`tools/room-art/import.mjs --format sql` prints one row with `art_svg` and `art_aspect` together. For phase 3,
split it: the item columns into `home_items`, `art_svg` into `home_item_art`.
