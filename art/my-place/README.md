# My Place art

The decor catalog for My Place: 31 items across 13 item slots (the avatar slot has no items; the app draws the
player). The server side is `supabase/migration_my_place.sql`; the contract is `docs/my-place.md`.

| Path | What it is |
|---|---|
| `catalog.json` | Source of truth: every item (id, name, fits, cost, rarity, is_starter, aspect, icon, sort, brief), the slots, and `defaultLayout` (the room's anchors). |
| `svg/<id>.svg` | One SVG per item, file name = item id. |
| `lib.cjs` | Shared helpers: slot list (mirrors `home_slots`), default layout, art via the kit's `import.mjs`. |
| `preview-config.cjs` | Config for the kit's `tools/room-art/preview.mjs`: rooms Starter, Cozy, Champion, Mixed. |
| `build.mjs` | Writes `supabase/migration_my_place_items.sql`. |
| `preview/*.png` | The last renders (see below). |

Both scripts expect the kit at `../expo-foundation` next to this repo. Set `KIT_DIR` to point elsewhere.
Previews need Chrome or Edge (set `CHROME` to its path if it is not found).

## Re-render the previews

Run from the repo root. Each command takes about 5 seconds.

```powershell
$P = "..\expo-foundation\tools\room-art\preview.mjs"
node $P --config art/my-place/preview-config.cjs --out art/my-place/preview/rooms.png
node $P --config art/my-place/preview-config.cjs --boxes --out art/my-place/preview/rooms-boxes.png
foreach ($r in 'starter','cozy','champion','mixed') { $env:ROOM = $r; node $P --config art/my-place/preview-config.cjs --out "art/my-place/preview/room-$r.png" }; Remove-Item Env:ROOM
node $P (Get-ChildItem art/my-place/svg/*.svg | ForEach-Object { '--art'; $_.FullName }) --out art/my-place/preview/all-items.png
```

- `rooms.png`: all four rooms. `room-<name>.png`: one room, larger.
- `rooms-boxes.png`: every slot box outlined, as the admin editor shows them. Wallpaper / floor tiles are left out
  here; the backdrop is the flat fallback from the item's `backdrop_opts`.
- `all-items.png`: every SVG at 160, 80 and 40 px on a checkerboard. It also lists any SVG the sanitizer refuses.

The wallpaper / floor tiles in the room renders come from preview-only `bd_*` slots in `preview-config.cjs`
(a wall tile is a quarter of the scene wide, and a floor tile is the same width at aspect 2). They are not real
slots. The app paints backdrops through `RoomScene`'s `renderBackdrop`.

To move an anchor, edit `defaultLayout.placements` in `catalog.json`, re-render, and look at `rooms.png` and
`rooms-boxes.png`. A couch pillow must sit on the seat, a shelf item on the shelf top, and the avatar on open
floor.

## Regenerate the seed SQL

```powershell
node art/my-place/build.mjs
node supabase/tests/build-my-place-items-test.mjs $env:TEMP\mpi_test.sql
```

`build.mjs` refuses to write the file in these cases:

- an item breaks a rule: bad id, unknown slot group, a starter with a price, an SVG with no item
- the kit's `validateSlots` / `validateLayout` rejects the slots or layout
- `import.mjs` refuses an SVG
- an SVG's aspect differs from the catalog's

The test file applies the seed twice inside `begin` / `rollback` and returns `(test, ok, detail)` rows, with a
SUMMARY row first. From the linked checkout:

```powershell
supabase db query --linked -f $env:TEMP\mpi_test.sql -o csv
supabase db query --linked -f supabase/migration_my_place_items.sql
```

The seed is idempotent:

- It retires the `ph_*` placeholders (it never deletes them).
- It upserts items and art. On a re-run, retire dates stay as they are, and a retired item never becomes a
  starter again.
- It writes the default layout only while `room_layout` has no placements, so a layout the admin saved is kept.
