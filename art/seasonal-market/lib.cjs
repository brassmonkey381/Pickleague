// Shared by build.mjs, the drops' preview-config.cjs and
// design/seasonal-market/render-preview.mjs: the drop folders, their
// catalogs, the rules an item must follow, and each item's art run through
// the kit's tools/room-art/import.mjs (sanitize + normalize to a viewBox 100
// wide), so the previews and the SQL use the exact strings the server ships.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const myPlace = require('../my-place/lib.cjs');

const HERE = __dirname;
const IMPORT = path.join(myPlace.KIT, 'tools', 'room-art', 'import.mjs');

/** The drop folders ('2026-11', '2026-12'), oldest first. */
function drops() {
  return fs
    .readdirSync(HERE)
    .filter((f) => /^\d{4}-\d{2}$/.test(f) && fs.existsSync(path.join(HERE, f, 'catalog.json')))
    .sort();
}

function catalog(drop) {
  return JSON.parse(fs.readFileSync(path.join(HERE, drop, 'catalog.json'), 'utf8'));
}

/** Every rule a drop's catalog must follow; returns a list of problems (empty = fine). */
function problems(drop, cat = catalog(drop)) {
  const out = [];
  const fits = new Set(myPlace.SERVER_SLOTS.map((s) => s.fits).filter((f) => f !== 'avatar'));
  const stamp = drop.replace('-', '').slice(2); // '2611'
  if (cat.season !== drop) out.push(`season "${cat.season}" must be the folder's "${drop}" (home_items.season is 'YYYY-MM').`);
  if (!cat.title || !String(cat.title).trim()) out.push('the drop needs a title.');
  const until = cat.available_until;
  if (!until || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(until.local || '') || !until.time_zone) {
    out.push('available_until must be { "local": "YYYY-MM-DD HH:MM", "time_zone": "Area/City" }.');
  }
  const from = cat.available_from;
  if (from != null && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(from.local || '') || !from.time_zone)) {
    out.push('available_from must be null or { "local": "YYYY-MM-DD HH:MM", "time_zone": "Area/City" }.');
  }
  if (from && until && from.time_zone === until.time_zone && from.local >= until.local) out.push('available_from must be before available_until.');
  const ids = new Set();
  for (const it of cat.items || []) {
    const at = it.id || '(no id)';
    if (ids.has(it.id)) out.push(`${at} is listed twice.`);
    ids.add(it.id);
    if (!new RegExp(`^sm${stamp}_[a-z0-9_]+$`).test(it.id || '')) out.push(`${at}: id must look like sm${stamp}_name (a-z, 0-9, _).`);
    if (!it.name || !String(it.name).trim()) out.push(`${at}: needs a name.`);
    if (!fits.has(it.slot_group)) out.push(`${at}: slot_group "${it.slot_group}" is no decor slot group in home_slots.`);
    if (!(it.aspect > 0)) out.push(`${at}: needs its aspect.`);
    if (!['common', 'rare', 'legendary'].includes(it.rarity)) out.push(`${at}: rarity "${it.rarity}" must be common, rare or legendary.`);
    if (!Number.isInteger(it.cost) || it.cost <= 0) out.push(`${at}: cost ${it.cost} must be a whole number of pickles above 0 (a market item is sold).`);
    if (!Number.isInteger(it.sort)) out.push(`${at}: needs a whole-number sort.`);
    if (typeof it.brief !== 'string' || it.brief.split(/(?<=\.)\s+/).length < 3) out.push(`${at}: the brief needs three sentences.`);
    if (it.slot_group === 'wallpaper' && !(it.backdrop_opts && it.backdrop_opts.wallTop && it.backdrop_opts.wallBottom)) {
      out.push(`${at}: a wallpaper needs backdrop_opts { wallTop, wallBottom } (mobile/src/lib/myPlaceSlots.ts).`);
    }
    if (it.slot_group === 'floor' && !(it.backdrop_opts && it.backdrop_opts.floorFill)) {
      out.push(`${at}: a floor needs backdrop_opts { floorFill, floorAccent, floorPattern }.`);
    }
  }
  if (!ids.size) out.push('the drop has no items.');
  return out;
}

const cache = new Map();
/** { svg, aspect } for an item of a drop, via import.mjs. Throws with import.mjs's reason. */
function importArt(drop, item) {
  const key = `${drop}/${item.id}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(HERE, drop, 'svg', `${item.id}.svg`);
  if (!fs.existsSync(file)) throw new Error(`no art file for ${item.id} at ${file}.`);
  let out;
  try {
    out = execFileSync(process.execPath, [IMPORT, '--svg', file, '--id', item.id, '--fits', item.slot_group, '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`import.mjs refused ${item.id}: ${String(e.stderr || e.message).trim()}`);
  }
  const row = JSON.parse(out);
  const r = { svg: row.art_svg, aspect: row.art_aspect };
  cache.set(key, r);
  return r;
}

/**
 * The room preview config for the kit's tools/room-art/preview.mjs: My
 * Place's Mixed room (art/my-place/preview-config.cjs: its slots, layout,
 * tiles, overlay and avatar) with every item of the drop in its slot,
 * wallpaper tiles included.
 */
function roomConfig(drop) {
  const only = process.env.ROOM;
  delete process.env.ROOM;
  const base = require('../my-place/preview-config.cjs');
  if (only != null) process.env.ROOM = only;
  const cat = catalog(drop);
  const mixed = base.rooms.find((r) => r.name === 'Mixed');
  if (!mixed) throw new Error('art/my-place/preview-config.cjs has no Mixed room to build on.');
  const bundled = { ...base.bundled };
  const equipped = { ...mixed.equipped };
  for (const it of cat.items) {
    const art = importArt(drop, it);
    bundled[it.id] = art.svg;
    const entry = { id: it.id, art: it.id, aspect: art.aspect };
    if (it.slot_group === 'wallpaper' || it.slot_group === 'floor') {
      const prefix = it.slot_group === 'wallpaper' ? 'bd_wall_' : 'bd_floor_';
      for (const s of Object.keys(equipped)) if (s.startsWith(prefix)) equipped[s] = entry;
    } else {
      equipped[it.slot_group] = entry;
    }
  }
  return { ...base, bundled, rooms: [{ name: cat.title, equipped }] };
}

module.exports = { HERE, KIT: myPlace.KIT, IMPORT, drops, catalog, problems, importArt, roomConfig };
