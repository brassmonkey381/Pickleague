// Room preview config for the kit's tools/room-art/preview.mjs: November's
// Court Pass decor in a My Place room. Extends art/my-place/preview-config.cjs
// (its slots, layout, wallpaper / floor tiles, overlay and avatar) and adds:
//
//   Harvest          the free-lane decor (cornucopia, pumpkin stack, autumn window)
//                    in the Mixed room, which is what a player can earn
//   Harvest premium  every November decor item, free and premium, for review only
//
//   node <kit>/tools/room-art/preview.mjs --config art/court-pass/2026-11/preview-config.cjs --out ...
//   ROOM=harvest node ... --out art/court-pass/2026-11/preview/room-harvest.png    one room only
//
// The November art is run through import.mjs here too, so the picture uses the
// exact strings the art SQL ships.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// my-place's config filters its own rooms by ROOM, so load it without it.
const only = process.env.ROOM;
delete process.env.ROOM;
const base = require('../../my-place/preview-config.cjs');
const myPlace = require('../../my-place/lib.cjs');
if (only != null) process.env.ROOM = only;

const cat = require('./catalog.json');
const IMPORT = path.join(myPlace.KIT, 'tools', 'room-art', 'import.mjs');
const decor = cat.items.filter((i) => i.table === 'home_items');

const bundled = { ...base.bundled };
const aspects = {};
for (const it of decor) {
  const file = path.join(__dirname, 'svg', `${it.id}.svg`);
  let out;
  try {
    out = execFileSync(process.execPath, [IMPORT, '--svg', file, '--id', it.id, '--fits', it.slot_group, '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`import.mjs refused ${it.id}: ${String(e.stderr || e.message).trim()}`);
  }
  const row = JSON.parse(out);
  bundled[it.id] = row.art_svg;
  aspects[it.id] = row.art_aspect;
}

// The Mixed room from my-place (its tiles and overlay included), with the
// November items swapped into their slots.
const mixed = base.rooms.find((r) => r.name === 'Mixed');
if (!mixed) throw new Error('art/my-place/preview-config.cjs has no Mixed room to build on.');
const item = (id) => ({ id, art: id, aspect: aspects[id] });
const bySlot = (lane) => {
  const out = {};
  for (const it of decor.filter((d) => lane === 'all' || d.lane === lane)) {
    // The pumpkin stack takes the first corner; shelf items stand on the Mixed room's shelf.
    out[it.slot_group] = item(it.id);
  }
  return out;
};

const ALL = [
  { name: 'Harvest', equipped: { ...mixed.equipped, ...bySlot('free') } },
  { name: 'Harvest premium', equipped: { ...mixed.equipped, ...bySlot('all') } },
];
const picked = only ? ALL.filter((r) => r.name.toLowerCase() === only.toLowerCase()) : ALL;
if (!picked.length) throw new Error(`ROOM=${only}: no such room (${ALL.map((r) => r.name).join(', ')}).`);

module.exports = { ...base, bundled, rooms: picked };
