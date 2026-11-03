#!/usr/bin/env node
// Regenerates supabase/migration_seasonal_market_2026_11_12.sql from every
// drop folder here (art/seasonal-market/<yyyy-mm>/catalog.json + svg/):
//
//   node art/seasonal-market/build.mjs        (from the repo root, or anywhere)
//
// The seasonal market is My Place decor SOLD for pickles in a dated window
// (home_items.season / available_from / available_until), separate from the
// Court Pass (whose items are track_only and never sold). Every SVG goes
// through the kit's tools/room-art/import.mjs (sanitize + normalize to a
// viewBox 100 wide; KIT_DIR overrides where the kit is, default
// ../expo-foundation next to this repo), as art/court-pass/build.mjs does, and
// its aspect is checked against the catalog. The file is refused if anything
// is off. Review the diff, then apply it with the apply script (state/sm-apply.ps1).
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('./lib.cjs');
const myPlace = require('../my-place/lib.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const fail = (m) => {
  console.error(`FAILED: ${m}`);
  process.exit(1);
};

const DROPS = lib.drops();
if (!DROPS.length) fail('no drop folders (art/seasonal-market/<yyyy-mm>/catalog.json).');
// migration_seasonal_market_2026_11_12.sql: the first drop's year and month,
// then each later drop's month (and its year when the year changes).
const OUT_NAME = `migration_seasonal_market_${DROPS.map((d, i) => {
  const [y, m] = d.split('-');
  return i > 0 && DROPS[i - 1].startsWith(y) ? m : `${y}_${m}`;
}).join('_')}.sql`;
const OUT = join(ROOT, 'supabase', OUT_NAME);
console.log(`Drops ${DROPS.join(', ')} -> supabase/${OUT_NAME}`);

console.log('Step 1: check the catalogs');
const evergreen = new Set(myPlace.catalog().items.map((i) => i.id));
const seen = new Set();
const drops = DROPS.map((drop) => {
  const cat = lib.catalog(drop);
  const bad = lib.problems(drop, cat);
  if (bad.length) fail(`${drop}/catalog.json:\n  - ${bad.join('\n  - ')}`);
  for (const it of cat.items) {
    if (seen.has(it.id)) fail(`${it.id} is in two drops.`);
    if (evergreen.has(it.id)) fail(`${it.id} is also an evergreen My Place item (art/my-place/catalog.json).`);
    seen.add(it.id);
  }
  const files = readdirSync(join(HERE, drop, 'svg')).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
  const extra = files.filter((f) => !cat.items.some((i) => i.id === f));
  if (extra.length) fail(`${drop}/svg has art with no item in the catalog: ${extra.join(', ')}.`);
  console.log(`  ${drop} ${cat.title}: ${cat.items.length} items`);
  return { drop, cat };
});

console.log('Step 2: import every SVG with import.mjs');
let chars = 0;
for (const d of drops) {
  d.rows = d.cat.items.map((it) => {
    if (!existsSync(join(HERE, d.drop, 'svg', `${it.id}.svg`))) fail(`no art file for ${it.id} at ${d.drop}/svg/${it.id}.svg.`);
    let art;
    try {
      art = lib.importArt(d.drop, it);
    } catch (e) {
      fail(e.message);
    }
    if (art.svg.includes('$svg$')) fail(`${it.id}: the art contains "$svg$", which would end the SQL quote.`);
    if (Math.abs(art.aspect - it.aspect) > 0.01) fail(`${it.id}: art aspect ${art.aspect} is not the catalog's ${it.aspect}.`);
    chars += art.svg.length;
    return { it, svg: art.svg, aspect: art.aspect };
  });
}
console.log(`  ${drops.reduce((n, d) => n + d.rows.length, 0)} imported, ${chars.toLocaleString()} characters of art`);

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const at = (w) => (w == null ? 'null' : `${q(w.local)}::timestamp at time zone ${q(w.time_zone)}`);
const human = (w) => (w == null ? 'when this file is applied' : `${w.local} ${w.time_zone}`);
const all = drops.flatMap((d) => d.rows.map((r) => ({ ...r, d })));
const idList = all.map(({ it }) => q(it.id)).join(', ');
const groups = [...new Set(all.map(({ it }) => it.slot_group))].sort();
const pad = (s, n) => String(s).padEnd(n);
const table = drops
  .map((d) =>
    `--   ${d.cat.title} (season '${d.cat.season}'): on sale ${human(d.cat.available_from)} until ${human(d.cat.available_until)}\n` +
    d.rows.map(({ it }) => `--     ${pad(it.id, 30)} ${pad(it.slot_group, 12)} ${pad(it.rarity, 7)} ${String(it.cost).padStart(5)}  ${it.name}`).join('\n'),
  )
  .join('\n');

const itemInserts = drops
  .map((d) =>
    `-- ${d.cat.title}\n` +
    `insert into public.home_items (id, name, slot_group, cost, rarity, season, available_from, available_until, art_key, art_aspect, icon, sort, is_starter, track_only) values\n` +
    d.rows
      .map(({ it, aspect }) =>
        `  (${q(it.id)}, ${q(it.name)}, ${q(it.slot_group)}, ${it.cost}, ${q(it.rarity)}, ${q(d.cat.season)},\n` +
        `   ${at(d.cat.available_from)}, ${at(d.cat.available_until)},\n` +
        `   null, ${aspect}, ${q(it.icon)}, ${it.sort}, false, false)`,
      )
      .join(',\n') +
    `\non conflict (id) do update\n` +
    `  set name       = excluded.name,\n` +
    `      slot_group = excluded.slot_group,\n` +
    `      cost       = excluded.cost,\n` +
    `      rarity     = excluded.rarity,\n` +
    `      art_aspect = excluded.art_aspect,\n` +
    `      icon       = excluded.icon,\n` +
    `      sort       = excluded.sort,\n` +
    `      is_starter = false,\n` +
    `      track_only = false;`,
  )
  .join('\n\n');

const artValues = all.map(({ it, svg }) => `  (${q(it.id)}, $svg$${svg}$svg$)`).join(',\n');

const sql = `-- ============================================================
-- My Place seasonal market: ${drops.map((d) => d.cat.title).join(' and ')}.
--
-- GENERATED by art/seasonal-market/build.mjs from
-- ${drops.map((d) => `art/seasonal-market/${d.drop}/catalog.json + svg/`).join('\n-- ')}
-- (each SVG run through expo-foundation's tools/room-art/import.mjs:
-- sanitized, normalized to a viewBox 100 wide). Do not edit by hand: change
-- a catalog or the art, then re-run the build.
--
-- Brian, 2026-11-03: purchasable seasonal decor, separate from the Court Pass.
-- These are SOLD for pickles (track_only false, cost above 0, never starters);
-- the Court Pass's items stay track_only and are not touched here. Each drop
-- uses My Place's existing seasonal columns: buy_home_item refuses an item
-- before available_from (pl:home.not_yet, "isn't on sale yet ... Check back
-- when its drop starts") and from available_until on (pl:home.ended, "its
-- drop has ended ... Pick another item"); owners keep and can still equip an
-- ended item, and the app's decor sheet lists an ended item only to its
-- owner and a not-yet item to nobody (mobile/src/lib/myPlace.ts decorRows).
-- Windows are Pacific midnights, computed with at time zone, never typed:
--
${table}
--
-- 1. Refuses unless My Place (migration_my_place.sql) and the Court Pass
--    tables (migration_court_pass_tables.sql: home_items.track_only and the
--    buy_home_item that checks it) are live, and every slot group exists.
-- 2. Upserts the items. On a re-run: name, slot_group, cost, rarity,
--    art_aspect, icon and sort follow the catalog; is_starter and track_only
--    are re-asserted false (a market item is always sold, never earned or
--    given); season, available_from and available_until are left alone, as
--    migration_my_place_items.sql does, so a drop the admin ended early stays
--    ended.
-- 3. Upserts their art into home_item_art (updated_at moves only when the
--    SVG changed).
--
-- Idempotent; no top-level transaction. Row locks on home_items and
-- home_item_art only (new rows: nothing anyone else is using). Apply with
-- state/sm-apply.ps1 (a rolled-back test first), or by hand:
--   supabase db query --linked -f supabase/${OUT_NAME}
-- ============================================================

-- ── 1. What this needs ──────────────────────────────────────────────────
do $$
declare
  v_missing text;
begin
  if to_regclass('public.home_items') is null or to_regclass('public.home_item_art') is null
     or to_regclass('public.home_slots') is null
     or to_regprocedure('public.buy_home_item(text)') is null then
    raise exception 'The seasonal market can''t be added yet: My Place isn''t set up on this database. Apply supabase/migration_my_place.sql first, then re-run this file.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'home_items' and column_name = 'track_only') then
    raise exception 'The seasonal market can''t be added yet: home_items has no track_only column, so a market item couldn''t be told apart from a Court Pass reward. Apply supabase/migration_court_pass_tables.sql first, then re-run this file.';
  end if;
  select string_agg(g, ', ' order by g) into v_missing
    from unnest(array[${groups.map(q).join(', ')}]) as g
   where not exists (select 1 from public.home_slots s where s.fits = g);
  if v_missing is not null then
    raise exception 'The seasonal market can''t be added yet: home_slots has no slot for %, so nobody could place those items. Re-run supabase/migration_my_place.sql (it seeds home_slots), then re-run this file.', v_missing;
  end if;
end
$$;

-- ── 2. The items ─────────────────────────────────────────────────────────
${itemInserts}

-- ── 3. The art ───────────────────────────────────────────────────────────
insert into public.home_item_art (item_id, art_svg) values
${artValues}
on conflict (item_id) do update
  set art_svg = excluded.art_svg, updated_at = now()
  where public.home_item_art.art_svg is distinct from excluded.art_svg;

notify pgrst, 'reload schema';
`;

console.log('Step 3: write the SQL');
writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${sql.length.toLocaleString()} characters)`);
