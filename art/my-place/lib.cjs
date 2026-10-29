// Shared by preview-config.cjs and build.mjs: the catalog, the slot list
// (mirrors home_slots in supabase/migration_my_place.sql), the default layout,
// and each item's art run through the kit's tools/room-art/import.mjs
// (sanitize + normalize to a viewBox 100 wide), so the previews and the seed
// SQL use the exact strings the server will hand the app.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
const KIT = process.env.KIT_DIR || path.resolve(HERE, '..', '..', '..', 'expo-foundation');
const IMPORT = path.join(KIT, 'tools', 'room-art', 'import.mjs');

function catalog() {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'catalog.json'), 'utf8'));
}

/** The server's slot structure (home_slots), in its sort order. */
const SERVER_SLOTS = [
  { id: 'wallpaper', label: 'Wallpaper', kind: 'backdrop', fits: 'wallpaper', parent: null, sort: 10 },
  { id: 'floor', label: 'Floor', kind: 'backdrop', fits: 'floor', parent: null, sort: 20 },
  { id: 'rug', label: 'Rug', kind: 'wide', fits: 'rug', parent: null, sort: 30 },
  { id: 'window', label: 'Window', kind: 'free', fits: 'window', parent: null, sort: 40 },
  { id: 'wall_art', label: 'Wall art', kind: 'free', fits: 'wall_art', parent: null, sort: 50 },
  { id: 'paddle_rack', label: 'Paddle rack', kind: 'free', fits: 'paddle_rack', parent: null, sort: 60 },
  { id: 'ceiling', label: 'Ceiling', kind: 'free', fits: 'ceiling', parent: null, sort: 70 },
  { id: 'shelf', label: 'Shelf', kind: 'furniture', fits: 'shelf', parent: null, sort: 80 },
  { id: 'shelf_item', label: 'Shelf top', kind: 'prop', fits: 'shelf_item', parent: 'shelf', sort: 90 },
  { id: 'couch', label: 'Couch', kind: 'furniture', fits: 'couch', parent: null, sort: 100 },
  { id: 'couch_pillow', label: 'Couch pillow', kind: 'prop', fits: 'couch_pillow', parent: 'couch', sort: 110 },
  { id: 'accent', label: 'Corner', kind: 'floor', fits: 'accent', parent: null, sort: 120 },
  { id: 'accent2', label: 'Second corner', kind: 'floor', fits: 'accent', parent: null, sort: 130 },
  { id: 'avatar', label: 'You', kind: 'avatar', fits: 'avatar', parent: null, sort: 900 },
];

/** The admin layout to seed: catalog defaultLayout without its note. */
function defaultLayout(cat = catalog()) {
  return { version: cat.defaultLayout.version, placements: cat.defaultLayout.placements };
}

/** The kit SlotDef[] for the room: server structure + catalog aspects + layout placements as defaults. */
function slotDefs(cat = catalog()) {
  const pl = cat.defaultLayout.placements;
  return SERVER_SLOTS.map((s) => {
    const def = { id: s.id, label: s.label, kind: s.kind, fits: s.fits };
    if (s.parent) def.parent = s.parent;
    const aspect = (cat.slots[s.fits] || cat.slots[s.id] || {}).aspect;
    if (aspect) def.aspect = aspect;
    if (s.kind === 'avatar') def.drawOrder = 1000;
    if (s.kind !== 'backdrop') {
      const p = pl[s.id];
      if (!p) throw new Error(`catalog defaultLayout has no placement for slot "${s.id}".`);
      def.default = p;
      if (typeof p.z === 'number') def.drawOrder = p.z;
    }
    return def;
  });
}

const cache = new Map();
/** { svg, aspect } for an item, via import.mjs (sanitized, viewBox 100 wide). Throws with import.mjs's reason. */
function importArt(item) {
  if (cache.has(item.id)) return cache.get(item.id);
  const file = path.join(HERE, 'svg', `${item.id}.svg`);
  if (!fs.existsSync(file)) throw new Error(`no art file for ${item.id} at ${file}.`);
  let out;
  try {
    out = execFileSync(process.execPath, [IMPORT, '--svg', file, '--id', item.id, '--fits', item.fits, '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`import.mjs refused ${item.id}: ${String(e.stderr || e.message).trim()}`);
  }
  const row = JSON.parse(out);
  const r = { svg: row.art_svg, aspect: row.art_aspect };
  cache.set(item.id, r);
  return r;
}

module.exports = { HERE, KIT, catalog, SERVER_SLOTS, slotDefs, defaultLayout, importArt };
