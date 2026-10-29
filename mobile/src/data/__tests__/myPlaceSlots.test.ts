import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { validateSlots } from '@just-messin-around/expo-foundation/room/layout';
import { MY_PLACE_BACKDROP_COLORS, MY_PLACE_SLOTS } from '../../lib/myPlaceSlots';

// My Place keeps its slot structure in three places: the app (lib/myPlaceSlots,
// the source), the server (home_slots, seeded by migration_my_place.sql, which
// equip_home_item checks fit and parents against) and the art tools
// (art/my-place/lib.cjs + catalog.json, which drew the previews and seeded the
// default layout). This fails when any two differ (docs/my-place.md, Slots).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(import.meta.url);
const lib = require(path.join(root, 'art/my-place/lib.cjs')) as {
  SERVER_SLOTS: { id: string; label: string; kind: string; fits: string; parent: string | null; sort: number }[];
  slotDefs: () => unknown[];
  defaultLayout: () => { version: number; placements: Record<string, unknown> };
  catalog: () => { items: { id: string; backdrop_opts?: Record<string, unknown> }[] };
};

function seededSlots() {
  const sql = fs.readFileSync(path.join(root, 'supabase/migration_my_place.sql'), 'utf8');
  const start = sql.indexOf('insert into public.home_slots');
  expect(start).toBeGreaterThan(-1);
  const block = sql.slice(start, sql.indexOf('on conflict', start));
  const rows = [...block.matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(null|'[^']+'),\s*(\d+)\)/g)];
  return rows.map((m) => ({
    id: m[1],
    label: m[2],
    kind: m[3],
    fits: m[4],
    parent: m[5] === 'null' ? null : m[5].slice(1, -1),
    sort: Number(m[6]),
  }));
}

const structure = (s: { id: string; label: string; kind: string; fits?: string; parent?: string | null }) => ({
  id: s.id,
  label: s.label,
  kind: s.kind,
  fits: s.fits ?? s.id,
  parent: s.parent ?? null,
});

describe('My Place slots: app, server and art tools agree', () => {
  it('the app list is a valid kit slot list of 14', () => {
    expect(MY_PLACE_SLOTS).toHaveLength(14);
    expect(validateSlots(MY_PLACE_SLOTS)).toEqual([]);
  });

  it('matches home_slots as seeded by migration_my_place.sql, in its sort order', () => {
    const server = seededSlots();
    expect(server).toHaveLength(14);
    const sorted = [...server].sort((a, b) => a.sort - b.sort);
    expect(sorted.map(structure)).toEqual(MY_PLACE_SLOTS.map(structure));
  });

  it("matches art/my-place/lib.cjs's SERVER_SLOTS", () => {
    expect(lib.SERVER_SLOTS.map(structure)).toEqual(MY_PLACE_SLOTS.map(structure));
    expect(lib.SERVER_SLOTS.map((s) => s.sort)).toEqual(seededSlots().map((s) => s.sort));
  });

  it("equals lib.cjs slotDefs() (aspects, draw order, default placements from catalog.json's defaultLayout)", () => {
    expect(lib.slotDefs()).toEqual(MY_PLACE_SLOTS);
  });

  it('the defaults are the layout migration_my_place_items.sql seeds', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase/migration_my_place_items.sql'), 'utf8');
    const m = sql.match(/insert into public\.room_layout \(id, layout\) values \('default', \$layout\$(.*?)\$layout\$::jsonb\)/s);
    expect(m).not.toBeNull();
    const seeded = JSON.parse(m![1]) as { version: number; placements: Record<string, unknown> };
    expect(seeded).toEqual(lib.defaultLayout());
    const fromApp = Object.fromEntries(MY_PLACE_SLOTS.filter((s) => s.default).map((s) => [s.id, s.default]));
    expect(seeded.placements).toEqual(fromApp);
  });

  it("backdrop colours match catalog.json's backdrop_opts", () => {
    const fromCatalog = Object.fromEntries(
      lib.catalog().items.filter((i) => i.backdrop_opts).map((i) => [i.id, i.backdrop_opts]),
    );
    expect(MY_PLACE_BACKDROP_COLORS).toEqual(fromCatalog);
  });
});
