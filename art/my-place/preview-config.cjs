// Room preview config for the kit's tools/room-art/preview.mjs:
//
//   node <kit>/tools/room-art/preview.mjs --config art/my-place/preview-config.cjs --out art/my-place/preview/rooms.png
//   ROOM=Starter node <kit>/tools/room-art/preview.mjs --config ... --out .../room-starter.png   one room only
//   ... --boxes                                     outline every slot box (tiles hidden, flat backdrop)
//
// Exports slots (home_slots + catalog aspects, catalog defaultLayout as each
// slot's default), layout (catalog defaultLayout), bundled (every item's art
// by id, as import.mjs normalizes it: the string the server ships), and the
// rooms Starter / Cozy / Champion / Mixed.
//
// Backdrops: preview.mjs only paints a flat buildBackdrop, but My Place tiles
// its wallpaper / floor items (a wall tile a quarter of the scene wide, floor
// tiles the same width at aspect 2). So outside --boxes this config adds
// preview-only "bd_*" free slots that lay the room's tiles over the wall and
// floor bands, plus an overlay with the kit's baseboard seam, floor shadow and
// vignette. They are not real slots (not in home_slots, not in the layout).
const { catalog, slotDefs, defaultLayout, importArt } = require('./lib.cjs');

const cat = catalog();
const RATIO = cat.scene.ratio_h_over_w; // 0.72
const FLOOR = cat.scene.floor_line; // 0.62
const BOXES = process.argv.includes('--boxes');
const byId = Object.fromEntries(cat.items.map((i) => [i.id, i]));

const bundled = {};
for (const it of cat.items) bundled[it.id] = importArt(it).svg;

function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(pct < 0 ? c * (1 + pct) : c + (255 - c) * pct)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// ── preview-only backdrop tiles ─────────────────────────────────────────────
const TILE_W = 0.25; // of the scene width
const tileSlots = [];
const COLS = Math.ceil(1 / TILE_W);
const wallRows = Math.ceil((FLOOR * RATIO) / TILE_W);
const floorRows = Math.ceil(((1 - FLOOR) * RATIO) / (TILE_W / 2));
for (let r = 0; r < wallRows; r++)
  for (let c = 0; c < COLS; c++)
    tileSlots.push({ id: `bd_wall_${r}_${c}`, label: '', kind: 'free', fits: 'bd_wall', aspect: 1, drawOrder: -100,
      default: { kind: 'free', cx: TILE_W * (c + 0.5), top: (r * TILE_W) / RATIO, w: TILE_W } });
for (let r = 0; r < floorRows; r++)
  for (let c = 0; c < COLS; c++)
    tileSlots.push({ id: `bd_floor_${r}_${c}`, label: '', kind: 'free', fits: 'bd_floor', aspect: 2, drawOrder: -90,
      default: { kind: 'free', cx: TILE_W * (c + 0.5), top: FLOOR + (r * TILE_W) / 2 / RATIO, w: TILE_W } });
tileSlots.push({ id: 'bd_overlay', label: '', kind: 'free', fits: 'bd_overlay', aspect: 1 / RATIO, drawOrder: -80,
  default: { kind: 'free', cx: 0.5, top: 0, w: 1 } });

function overlaySvg(key, wallBottom) {
  const H = 100 * RATIO;
  const ft = H * FLOOR;
  const fh = H - ft;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${H}" preserveAspectRatio="none"><defs>` +
    `<linearGradient id="fs_${key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.2"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>` +
    `<radialGradient id="vg_${key}" cx="0.5" cy="0.42" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.14"/></radialGradient></defs>` +
    `<rect x="0" y="${ft - H * 0.012}" width="100" height="${H * 0.012}" fill="${shade(wallBottom, -0.18)}" opacity="0.5"/>` +
    `<rect x="0" y="${ft}" width="100" height="${fh * 0.28}" fill="url(#fs_${key})"/>` +
    `<rect x="0" y="0" width="100" height="${H}" fill="url(#vg_${key})"/></svg>`
  );
}

// ── rooms ───────────────────────────────────────────────────────────────────
const ALL = [
  {
    name: 'Starter',
    equipped: Object.fromEntries(cat.items.filter((i) => i.is_starter).map((i) => [i.fits, i.id])),
  },
  {
    name: 'Cozy',
    equipped: {
      wallpaper: 'wall_net_print', floor: 'floor_court_blue', rug: 'rug_ball', window: 'window_classic',
      wall_art: 'art_tournament_poster', paddle_rack: 'rack_peg', ceiling: 'ceiling_string_lights',
      shelf: 'shelf_oak', shelf_item: 'item_ball_jar', couch: 'couch_comfy', couch_pillow: 'pillow_ball',
      accent: 'accent_monstera', accent2: 'accent_floor_lamp',
    },
  },
  {
    name: 'Champion',
    equipped: {
      wallpaper: 'wall_night_court', floor: 'floor_herringbone', rug: 'rug_court_lines', window: 'window_court_view',
      wall_art: 'art_signed_paddle', paddle_rack: 'rack_champion', ceiling: 'ceiling_ball_chandelier',
      shelf: 'shelf_trophy_case', shelf_item: 'item_champion_trophy', couch: 'couch_velvet_green',
      couch_pillow: 'pillow_paddle', accent2: 'accent_ball_machine',
    },
  },
  {
    name: 'Mixed',
    equipped: {
      wallpaper: 'wall_cream', floor: 'floor_herringbone', rug: 'rug_ball', window: 'window_court_view',
      wall_art: 'art_court_blueprint', paddle_rack: 'rack_peg', ceiling: 'ceiling_string_lights',
      shelf: 'shelf_trophy_case', shelf_item: 'item_succulent', couch: 'couch_velvet_green',
      couch_pillow: 'pillow_ball', accent: 'accent_ball_hopper', accent2: 'accent_monstera',
    },
  },
];

// Starter / Cozy / Champion rarity rules, checked so the rooms stay honest.
for (const [room, ok] of [
  ['Starter', (i) => i.is_starter],
  ['Cozy', (i) => i.rarity === 'common'],
  ['Champion', (i) => i.rarity !== 'common'],
]) {
  for (const id of Object.values(ALL.find((r) => r.name === room).equipped)) {
    if (!byId[id]) throw new Error(`${room}: no catalog item ${id}.`);
    if (!ok(byId[id])) throw new Error(`${room}: ${id} (${byId[id].rarity}) does not belong in this room.`);
  }
}

function roomFor(r) {
  const equipped = {};
  for (const [slot, id] of Object.entries(r.equipped)) {
    const it = byId[id];
    if (!it) throw new Error(`${r.name}: no catalog item ${id}.`);
    equipped[slot] = { id, art: id, aspect: importArt(it).aspect };
  }
  if (!BOXES) {
    const key = r.name.toLowerCase();
    const wall = byId[r.equipped.wallpaper];
    bundled[`bd_overlay_${key}`] = overlaySvg(key, wall.backdrop_opts.wallBottom);
    for (const s of tileSlots) {
      if (s.fits === 'bd_wall' && r.equipped.wallpaper) equipped[s.id] = { id: r.equipped.wallpaper, art: r.equipped.wallpaper, aspect: 1 };
      if (s.fits === 'bd_floor' && r.equipped.floor) equipped[s.id] = { id: r.equipped.floor, art: r.equipped.floor, aspect: 2 };
    }
    equipped.bd_overlay = { id: `bd_overlay_${key}`, art: `bd_overlay_${key}`, aspect: 1 / RATIO };
  }
  return { name: r.name, equipped };
}

const only = process.env.ROOM;
const picked = only ? ALL.filter((r) => r.name.toLowerCase() === only.toLowerCase()) : ALL;
if (!picked.length) throw new Error(`ROOM=${only}: no such room (${ALL.map((r) => r.name).join(', ')}).`);
const rooms = picked.map(roomFor);

// With --boxes there are no tiles: a flat backdrop from the first room's items.
const first = byId[picked[0].equipped.wallpaper];
const firstFloor = byId[picked[0].equipped.floor];
const backdrop = BOXES ? { ...first.backdrop_opts, ...firstFloor.backdrop_opts, floorLine: FLOOR } : null;

// A plain player (the app draws the real avatar): 80 x 100, aspect 0.8.
const avatar =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 100">' +
  '<ellipse cx="40" cy="97" rx="22" ry="3" fill="#000" opacity="0.15"/>' +
  '<rect x="29" y="62" width="9" height="34" rx="4" fill="#3a3a3a"/><rect x="42" y="62" width="9" height="34" rx="4" fill="#3a3a3a"/>' +
  '<rect x="24" y="34" width="32" height="34" rx="10" fill="#2e7d32"/>' +
  '<circle cx="40" cy="20" r="13" fill="#e8b98f"/><path d="M27 18a13 13 0 0 1 26 0z" fill="#1b5e20"/>' +
  '<rect x="54" y="38" width="7" height="22" rx="3.5" fill="#e8b98f"/>' +
  '<rect x="55" y="56" width="5" height="10" rx="2" fill="#8a6f55"/><ellipse cx="57.5" cy="74" rx="9" ry="11" fill="#e0533f"/></svg>';

module.exports = {
  slots: [...(BOXES ? [] : tileSlots), ...slotDefs(cat)],
  layout: defaultLayout(cat),
  bundled,
  rooms,
  backdrop,
  ratio: RATIO,
  avatar,
};
