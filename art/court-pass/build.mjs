#!/usr/bin/env node
// Regenerates supabase/migration_court_pass_art_<cycle>.sql from
// art/court-pass/<cycle>/catalog.json + svg/ (docs/court-pass.md, Art), for
// one cycle (the month, 'YYYY-MM'):
//
//   node art/court-pass/build.mjs 2026-11     (from the repo root, or anywhere)
//   node art/court-pass/build.mjs 2026-12
//
// Every decor SVG goes through the kit's tools/room-art/import.mjs (sanitize +
// normalize to a viewBox 100 wide; KIT_DIR overrides where the kit is, default
// ../expo-foundation next to this repo), the same way art/my-place/build.mjs
// does. Its aspect is checked against the catalog, and against SERVER's seed
// for the cycle (supabase/migration_court_pass_cycles_<yyyy>_<mm>[_...].sql:
// 2026_11 for November, 2026_12_2027_01 for December): the ids, slot groups,
// aspects and shop payloads must match. The file is refused if anything is
// off. Review the diff, then apply it yourself (after the cycles file: the art
// rows reference home_items).
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const myPlace = require('../my-place/lib.cjs');
const { seedRowsFromFile } = require('./seedSql.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const IMPORT = join(myPlace.KIT, 'tools', 'room-art', 'import.mjs');

const fail = (m) => {
  console.error(`FAILED: ${m}`);
  process.exit(1);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The cycle: the month folder next to this file ('2026-11').
const cycles = readdirSync(HERE).filter((f) => /^\d{4}-\d{2}$/.test(f) && existsSync(join(HERE, f, 'catalog.json')));
const CYCLE = process.argv[2];
if (!CYCLE) fail(`name the cycle to build, for example: node art/court-pass/build.mjs ${cycles[cycles.length - 1] ?? '2026-12'} (cycles here: ${cycles.join(', ') || 'none'}).`);
if (!cycles.includes(CYCLE)) fail(`no art/court-pass/${CYCLE}/catalog.json. Cycles here: ${cycles.join(', ') || 'none'}.`);
const DIR = join(HERE, CYCLE);
const MONTH = new Date(`${CYCLE}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const UNDER = CYCLE.replace('-', '_');
// SERVER's seed for this cycle: migration_court_pass_cycles_2026_11.sql, or a
// file that seeds several months starting with this one (2026_12_2027_01).
const seeds = readdirSync(join(ROOT, 'supabase')).filter((f) =>
  f.startsWith(`migration_court_pass_cycles_${UNDER}`) && /^migration_court_pass_cycles(_\d{4}_\d{2})+\.sql$/.test(f),
);
if (seeds.length !== 1) {
  fail(`expected one supabase/migration_court_pass_cycles_${UNDER}[_...].sql (SERVER's seed for ${CYCLE}), found ${seeds.length ? seeds.join(', ') : 'none'}.`);
}
const SEED_NAME = seeds[0];
const SEED = join(ROOT, 'supabase', SEED_NAME);
const OUT_NAME = `migration_court_pass_art_${UNDER}.sql`;
const OUT = join(ROOT, 'supabase', OUT_NAME);
console.log(`Cycle ${CYCLE} (${MONTH}): ${SEED_NAME} -> ${OUT_NAME}`);

console.log('Step 1: check the catalog');
const cat = require(join(DIR, 'catalog.json'));
const fitsKnown = new Set(myPlace.SERVER_SLOTS.map((s) => s.fits).filter((f) => f !== 'avatar'));
const ids = new Set();
for (const it of cat.items) {
  if (ids.has(it.id)) fail(`item "${it.id}" is listed twice.`);
  ids.add(it.id);
  if (!['free', 'premium'].includes(it.lane)) fail(`${it.id}: lane "${it.lane}" must be free or premium.`);
  if (!['common', 'rare', 'legendary'].includes(it.rarity)) fail(`${it.id}: rarity "${it.rarity}".`);
  if (typeof it.brief !== 'string' || it.brief.split(/(?<=\.)\s+/).length < 3) fail(`${it.id}: the brief needs three sentences.`);
  if (it.table === 'home_items') {
    if (!/^cp\d{4}_[a-z0-9_]+$/.test(it.id)) fail(`home item id "${it.id}" must look like cp2612_name (a-z, 0-9, _).`);
    if (!fitsKnown.has(it.slot_group)) fail(`${it.id}: slot_group "${it.slot_group}" is no decor slot group in home_slots.`);
    if (!(it.aspect > 0)) fail(`${it.id}: a home item needs its aspect.`);
  } else if (it.table === 'shop_items') {
    if (!/^cp\d{4}-[a-z0-9-]+$/.test(it.id)) fail(`shop item slug "${it.id}" must look like cp2612-category-name.`);
    if (!['avatar', 'list_name_style', 'profile_name_style'].includes(it.category)) fail(`${it.id}: category "${it.category}".`);
    if (!it.payload) fail(`${it.id}: a shop item needs its payload.`);
  } else fail(`${it.id}: table "${it.table}" must be home_items or shop_items.`);
}
const decor = cat.items.filter((i) => i.table === 'home_items');
const files = readdirSync(join(DIR, 'svg')).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
const extra = files.filter((f) => !decor.some((d) => d.id === f));
if (extra.length) fail(`svg/ has art with no home item in the catalog: ${extra.join(', ')}.`);
console.log(`  ${cat.items.length} items, ${decor.length} decor`);

console.log('Step 2: import every SVG with import.mjs');
const rows = decor.map((it) => {
  const file = join(DIR, 'svg', `${it.id}.svg`);
  if (!existsSync(file)) fail(`no art file for ${it.id} at ${file}.`);
  let out;
  try {
    out = execFileSync(process.execPath, [IMPORT, '--svg', file, '--id', it.id, '--fits', it.slot_group, '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    fail(`import.mjs refused ${it.id}: ${String(e.stderr || e.message).trim()}`);
  }
  const row = JSON.parse(out);
  if (row.art_svg.includes('$svg$')) fail(`${it.id}: the art contains "$svg$", which would end the SQL quote.`);
  if (Math.abs(row.art_aspect - it.aspect) > 0.01) fail(`${it.id}: art aspect ${row.art_aspect} is not the catalog's ${it.aspect}.`);
  return { it, svg: row.art_svg, aspect: row.art_aspect };
});
console.log(`  ${rows.length} imported, ${rows.reduce((n, r) => n + r.svg.length, 0).toLocaleString()} characters of art`);

console.log("Step 3: check against SERVER's cycles seed");
{
  const home = new Map(seedRowsFromFile(SEED, 'home_items').map((r) => [r.id, r]));
  const shop = new Map(seedRowsFromFile(SEED, 'shop_items').map((r) => [r.slug, r]));
  const seeded = [...home.keys()].filter((k) => String(k).startsWith(`cp${CYCLE.replace('-', '').slice(2)}`));
  for (const k of seeded) if (!ids.has(k)) fail(`the seed has home item ${k}, which the art catalog does not.`);
  for (const { it, aspect } of rows) {
    const s = home.get(it.id);
    if (!s) fail(`${it.id} is not seeded into home_items in ${SEED}.`);
    if (s.slot_group !== it.slot_group) fail(`${it.id}: the seed's slot_group "${s.slot_group}" is not the catalog's "${it.slot_group}".`);
    if ('art_aspect' in s && typeof s.art_aspect === 'number' && Math.abs(s.art_aspect - aspect) > 0.01)
      fail(`${it.id}: the seed's art_aspect ${s.art_aspect} is not the art's ${aspect}.`);
  }
  for (const it of cat.items.filter((i) => i.table === 'shop_items')) {
    const s = shop.get(it.id);
    if (!s) fail(`${it.id} is not seeded into shop_items in ${SEED}.`);
    if (s.category !== undefined && s.category !== it.category) fail(`${it.id}: the seed's category "${s.category}" is not the catalog's "${it.category}".`);
    if (!same(s.payload, it.payload)) fail(`${it.id}: the seed's payload ${JSON.stringify(s.payload)} is not the catalog's ${JSON.stringify(it.payload)}.`);
  }
  console.log(`  ${rows.length} home items and ${cat.items.length - rows.length} shop items match the seed`);
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const idList = rows.map(({ it }) => q(it.id)).join(', ');
const artValues = rows.map(({ it, svg }) => `  (${q(it.id)}, $svg$${svg}$svg$)`).join(',\n');
const aspectValues = rows.map(({ it, aspect }) => `  (${q(it.id)}, ${aspect})`).join(',\n');

const sql = `-- ============================================================
-- Court Pass, ${MONTH}: the art for the ${rows.length} decor items.
--
-- GENERATED by art/court-pass/build.mjs from art/court-pass/${CYCLE}/catalog.json
-- and art/court-pass/${CYCLE}/svg/*.svg (each run through expo-foundation's
-- tools/room-art/import.mjs: sanitized, normalized to a viewBox 100 wide).
-- Do not edit by hand: change the catalog or the art, then re-run the build.
--
-- 1. Refuses unless all ${rows.length} items are in home_items (seeded by
--    ${SEED_NAME}, which runs first).
-- 2. Upserts their art into home_item_art (updated_at moves only when the
--    SVG changed), as migration_my_place_items.sql section 3 does.
-- 3. Sets home_items.art_aspect to the imported aspect, for these ids only
--    (only when it differs).
--
-- Idempotent; no top-level transaction. Row locks on home_items and
-- home_item_art only. Apply after ${SEED_NAME}:
--   supabase db query --linked -f supabase/${OUT_NAME}
-- Checked by supabase/tests/build-court-pass-test.mjs (it splices this file
-- after the cycles file when it exists).
-- ============================================================

-- ── 1. The items must exist ──────────────────────────────────────────────
do $$
declare
  v_missing text;
begin
  select string_agg(w.id, ', ' order by w.id) into v_missing
    from unnest(array[${idList}]) as w(id)
   where not exists (select 1 from public.home_items h where h.id = w.id);
  if v_missing is not null then
    raise exception 'Court Pass art can''t be added yet: home_items has no row for %. Apply supabase/${SEED_NAME} first, then re-run this file.', v_missing;
  end if;
end
$$;

-- ── 2. The art ───────────────────────────────────────────────────────────
insert into public.home_item_art (item_id, art_svg) values
${artValues}
on conflict (item_id) do update
  set art_svg = excluded.art_svg, updated_at = now()
  where public.home_item_art.art_svg is distinct from excluded.art_svg;

-- ── 3. The aspects ───────────────────────────────────────────────────────
update public.home_items h
   set art_aspect = v.aspect
  from (values
${aspectValues}
  ) as v(id, aspect)
 where h.id = v.id
   and h.art_aspect is distinct from v.aspect;

notify pgrst, 'reload schema';
`;

console.log('Step 4: write the SQL');
writeFileSync(OUT, sql);
console.log(`wrote ${OUT} (${sql.length.toLocaleString()} characters)`);
