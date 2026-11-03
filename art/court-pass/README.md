# Court Pass art

The art for Court Pass, Pickleague's monthly reward track. The spec is `docs/court-pass.md` (Art); the decor is
drawn in My Place's style (`art/my-place/catalog.json` `style`), with a palette added per month: harvest for November
2026 (`2026-11/`, the first pass), winter for December 2026 (`2026-12/`).

| Path | What it is |
|---|---|
| `<cycle>/catalog.json` | Source of truth for a month's items: id, title, tier, lane, table, slot_group or category, aspect, rarity, icon, payload (shop items) and a three-sentence brief. |
| `<cycle>/svg/<id>.svg` | One SVG per decor (`home_items`) item, file name = item id, viewBox `0 0 100 H` with H = 100 / aspect. |
| `<cycle>/draw.mjs` | How that month's SVGs were drawn (shared helpers for pickleballs, paddles, snowflakes or leaves). Optional. |
| `<cycle>/preview-config.cjs` | Config for the kit's `tools/room-art/preview.mjs`: My Place's Mixed room with the month's decor. |
| `<cycle>/preview/*.png` | The last renders (see below). |
| `seedSql.cjs` | Reads the rows SERVER seeds (`supabase/migration_court_pass_cycles_*.sql`). Used by `build.mjs` and `mobile/src/lib/__tests__/courtArt.test.ts`. |
| `build.mjs` | `node art/court-pass/build.mjs <cycle>` writes `supabase/migration_court_pass_art_<yyyy>_<mm>.sql` for that month. |

The app side: `mobile/src/lib/courtArt.ts` (`COURT_ART`, `courtArtFor`), `components/courtPass/CourtRewardArt.tsx`, and
the name styles in `lib/nameStyles.ts` (Snowfall is `SnowfallName` in `components/NameStyleAnimations.tsx`; November's Golden
Harvest reuses `SparkleName`).

The scripts expect the kit at `../expo-foundation` next to this repo. Set `KIT_DIR` to point elsewhere. Previews need
Chrome or Edge (set `CHROME` to its path if it is not found).

## Re-render the previews

Run from the repo root. Each command takes about 5 seconds.

```powershell
$P = "..\expo-foundation\tools\room-art\preview.mjs"; $D = "art/court-pass/2026-12"
node $P (Get-ChildItem $D/svg/*.svg | ForEach-Object { '--art'; $_.FullName }) --out $D/preview/items.png
$env:ROOM = 'winter'; node $P --config $D/preview-config.cjs --out $D/preview/room-winter.png
$env:ROOM = 'winter premium'; node $P --config $D/preview-config.cjs --out $D/preview/room-winter-premium.png; Remove-Item Env:ROOM
node design/court-pass/render-preview.mjs
```

- `items.png`: every decor SVG at 160, 80 and 40 px on a checkerboard. It also lists any SVG the sanitizer refuses.
- `room-winter.png`: the free decor (globe, tree, window) in the Mixed room: what a player can earn.
- `room-winter-premium.png`: all 8 decor items, premium included, for review only.
- `design/court-pass/2026-12-preview.png`: all 12 items on one sheet, avatars and name styles included
  (`node design/court-pass/render-preview.mjs 2026-11` for November's sheet; the same commands with `$D = "art/court-pass/2026-11"`
  and `ROOM = 'harvest'` / `'harvest premium'` render November's rooms).

## Regenerate the art SQL

```powershell
node art/court-pass/build.mjs 2026-11
node art/court-pass/build.mjs 2026-12
```

Each run builds one month: `art/court-pass/<cycle>/` into `supabase/migration_court_pass_art_<yyyy>_<mm>.sql`, checked
against that month's seed (`supabase/migration_court_pass_cycles_<yyyy>_<mm>[_...].sql`).

`build.mjs` refuses to write the file in these cases:

- an item breaks a rule: bad id, unknown slot group or category, a brief under three sentences, an SVG with no item
- `import.mjs` refuses an SVG
- an SVG's aspect differs from the catalog's
- no cycle is named, the cycle has no folder, or there isn't exactly one seed file for it
- the seed differs: an item missing, a slot group, an aspect or a shop payload that is not the catalog's, or a home item
  of that month (`cp2611_`, `cp2612_`) the catalog does not have

The SQL is idempotent. It refuses unless the items are already in `home_items` (apply the cycles file first), upserts
`home_item_art` (`updated_at` moves only when the SVG changed) and sets `home_items.art_aspect` for these ids only.

## A new month

1. Copy a month folder to the new cycle id, and write the catalog (briefs first) to match SERVER's seed.
2. Draw the SVGs, then re-render the previews.
3. Add the items to `COURT_ART` in `mobile/src/lib/courtArt.ts` (and any name style to `lib/nameStyles.ts`).
4. Run `node art/court-pass/build.mjs <cycle>`, add the cycle and its seed to `CYCLES` / `SEEDS` in
   `mobile/src/lib/__tests__/courtArt.test.ts`, run `npx vitest run src/lib/__tests__/courtArt.test.ts` in `mobile/`, and add
   the art file to `supabase/tests/build-court-pass-test.mjs` and the apply script.
