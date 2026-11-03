# Seasonal market art

My Place decor **sold for pickles** in a dated window, one drop a month. It is separate from the Court Pass
(`art/court-pass/`): Court Pass items are `track_only` (earned, never sold); market items are `track_only false`, cost
above 0, never starters. The server side is My Place's existing seasonal columns (`home_items.season`,
`available_from`, `available_until`): `buy_home_item` refuses a drop that hasn't started (`pl:home.not_yet`) or has
ended (`pl:home.ended`), owners keep ended items, and the app's decor sheet hides a not-yet item and shows an ended
one only to its owner.

| Drop | Season | On sale (Pacific midnights) | Items |
|---|---|---|---|
| Harvest Market | `2026-11` | when the migration is applied until Dec 1, 2026 | wallpaper, wall art, ceiling, shelf item, corner, couch (rare) |
| Winter Market | `2026-12` | Dec 1, 2026 to Jan 1, 2027 | wallpaper, rug, ceiling, shelf item, corner, shelf (rare) |

| Path | What it is |
|---|---|
| `<drop>/catalog.json` | Source of truth for a drop: title, season, window (`{ local, time_zone }`), and per item id (`sm<yymm>_name`), name, slot_group, aspect, rarity, cost, icon, sort, a three-sentence brief, and `backdrop_opts` for a wallpaper. |
| `<drop>/svg/<id>.svg` | One SVG per item, viewBox `0 0 100 H` with H = 100 / aspect. |
| `<drop>/draw.mjs` | How that drop's SVGs were drawn. |
| `shapes.mjs` | The shared shapes (pickleballs, paddles, leaves, pumpkins, wheat, apples, snowflakes, pine), the same as the Court Pass draw scripts'. |
| `<drop>/preview-config.cjs` | Config for the kit's `tools/room-art/preview.mjs`: My Place's Mixed room with every item of the drop. |
| `<drop>/preview/*.png` | The last renders: `items.png` (160, 80, 40 px) and `room.png`. |
| `lib.cjs` | The drops, their catalogs, the catalog rules, and import.mjs. Used by everything here and by `mobile/src/data/__tests__/myPlaceSlots.test.ts`. |
| `build.mjs` | `node art/seasonal-market/build.mjs` writes `supabase/migration_seasonal_market_2026_11_12.sql` from every drop. |

The scripts expect the kit at `../expo-foundation` next to this repo (`KIT_DIR` overrides). Previews need Chrome or
Edge (`CHROME` overrides).

## Re-render

Run from the repo root.

```powershell
node art/seasonal-market/2026-11/draw.mjs; node art/seasonal-market/2026-12/draw.mjs
$P = "..\expo-foundation\tools\room-art\preview.mjs"
foreach ($D in "art/seasonal-market/2026-11", "art/seasonal-market/2026-12") {
  node $P (Get-ChildItem $D/svg/*.svg | ForEach-Object { '--art'; $_.FullName }) --out $D/preview/items.png
  node $P --config $D/preview-config.cjs --out $D/preview/room.png
}
node design/seasonal-market/render-preview.mjs
node art/seasonal-market/build.mjs
```

`build.mjs` refuses to write the SQL when a catalog breaks a rule (id, slot group, aspect, rarity, a price of 0, a
brief under three sentences, a wallpaper without colours, a window that isn't `{ local, time_zone }`), an SVG is
missing, extra or refused by import.mjs, an aspect differs from the catalog's, or an id is also an evergreen item.

## Apply

`state/sm-apply.ps1` (a copy lives at `%TEMP%\sm-apply.ps1`) exports committed master, checks My Place and the Court
Pass tables are live, runs `supabase/tests/seasonal_market_check.sql` rolled back (built by
`supabase/tests/build-seasonal-market-test.mjs`), applies the migration, and prints what is live.

## A new drop

1. Add `art/seasonal-market/<yyyy-mm>/` with a catalog, `draw.mjs` and SVGs (avoid that month's Court Pass slot +
   concept pairs), and a `preview-config.cjs` like the others.
2. Re-render and review the PNGs.
3. Add a wallpaper or floor's `backdrop_opts` to `MY_PLACE_BACKDROP_COLORS` in `mobile/src/lib/myPlaceSlots.ts`
   (`myPlaceSlots.test.ts` fails until you do).
4. Run the build. The output file name follows the drops (rename the test builder's `MARKET` and the apply script's
   `$market` to match).
