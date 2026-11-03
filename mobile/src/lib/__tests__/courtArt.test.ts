import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { COURT_ART, courtArtFor, isEquippableSpec } from '../courtArt';
import { NAME_STYLES } from '../nameStyles';

// The Court Pass items live in four places: SERVER's cycles seeds (the source
// of truth for payloads, slot groups and aspects), the art catalogs + SVGs
// (art/court-pass/<cycle>/, one folder a month), lib/courtArt's COURT_ART
// fallback, and lib/nameStyles for the name styles. This fails when any two
// differ (docs/court-pass.md, Art). A missing file fails, naming it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(import.meta.url);
const ART = path.join(root, 'art/court-pass');
// Every month with art, and SERVER's seed for it (one file a month, or one
// file seeding several months that starts with it).
const CYCLES = ['2026-11', '2026-12'];
const SEEDS: Record<string, string> = {
  '2026-11': path.join(root, 'supabase/migration_court_pass_cycles_2026_11.sql'),
  '2026-12': path.join(root, 'supabase/migration_court_pass_cycles_2026_12_2027_01.sql'),
};
const { seedRowsFromFile } = require(path.join(root, 'art/court-pass/seedSql.cjs')) as {
  seedRowsFromFile: (file: string, table: string) => Record<string, unknown>[];
};

type CatalogItem = {
  id: string;
  table: 'shop_items' | 'home_items';
  category?: string;
  slot_group?: string;
  aspect: number | null;
  icon: string;
  payload?: Record<string, unknown>;
};
function catalog(cycle: string): CatalogItem[] {
  const file = path.join(ART, cycle, 'catalog.json');
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: ART writes it.`);
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { items: CatalogItem[] }).items;
}
/** The month an item key belongs to: cp2611... is 2026-11. */
const cycleOf = (key: string) => `20${key.slice(2, 4)}-${key.slice(4, 6)}`;

describe('COURT_ART', () => {
  it('resolves every key to real art', () => {
    for (const [key, row] of Object.entries(COURT_ART)) {
      expect(row.id, key).toBe(key);
      const spec = courtArtFor({ kind: row.kind, itemKey: key });
      expect(spec.kind, key).not.toBe('unknown');
    }
  });

  it('every month with a catalog folder is checked here', () => {
    const folders = fs.readdirSync(ART).filter((f) => /^\d{4}-\d{2}$/.test(f) && fs.existsSync(path.join(ART, f, 'catalog.json')));
    expect(folders.sort()).toEqual(CYCLES);
    expect(new Set(Object.keys(COURT_ART).map(cycleOf))).toEqual(new Set(CYCLES));
  });

  it('holds exactly the art catalogs, with the same slot groups, aspects, categories, icons and payloads', () => {
    const items = CYCLES.flatMap((c) => catalog(c));
    expect(items.length).toBe(12 * CYCLES.length);
    expect(Object.keys(COURT_ART).sort()).toEqual(items.map((i) => i.id).sort());
    for (const it of items) {
      const row = COURT_ART[it.id];
      expect(row.kind, it.id).toBe(it.table === 'shop_items' ? 'shop_item' : 'home_item');
      expect(row.icon, it.id).toBe(it.icon);
      if (it.table === 'home_items') {
        expect(row.slotGroup, it.id).toBe(it.slot_group);
        expect(row.aspect, it.id).toBe(it.aspect);
      } else {
        expect(row.category, it.id).toBe(it.category);
        expect(row.slug, it.id).toBe(it.id);
        expect(row.payload, it.id).toEqual(it.payload);
      }
    }
  });

  it("has an SVG for every decor item, in its month's folder, and no SVG without an item", () => {
    for (const row of Object.values(COURT_ART)) {
      if (row.kind !== 'home_item') continue;
      const file = path.join(ART, cycleOf(row.id), 'svg', `${row.id}.svg`);
      expect(fs.existsSync(file), `${file} is missing`).toBe(true);
    }
    for (const cycle of CYCLES) {
      const svgs = fs.readdirSync(path.join(ART, cycle, 'svg')).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
      expect(svgs.length, cycle).toBe(8);
      for (const id of svgs) {
        expect(COURT_ART[id]?.kind, `${cycle}/svg/${id}.svg has no home item in COURT_ART`).toBe('home_item');
        expect(cycleOf(id), id).toBe(cycle);
      }
    }
  });

  it("matches SERVER's cycles seeds: avatar and name-style payloads, decor slot groups and aspects", () => {
    for (const row of Object.values(COURT_ART)) {
      const SEED = SEEDS[cycleOf(row.id)];
      expect(SEED, `no seed file listed for ${row.id}`).toBeTruthy();
      const shop = new Map(seedRowsFromFile(SEED, 'shop_items').map((r) => [r.slug, r]));
      const home = new Map(seedRowsFromFile(SEED, 'home_items').map((r) => [r.id, r]));
      if (row.kind === 'shop_item') {
        const s = shop.get(row.id);
        expect(s, `${row.id} is not seeded into shop_items in ${SEED}`).toBeTruthy();
        expect(s!.payload, row.id).toEqual(row.payload);
        if (s!.category !== undefined) expect(s!.category, row.id).toBe(row.category);
      } else {
        const h = home.get(row.id);
        expect(h, `${row.id} is not seeded into home_items in ${SEED}`).toBeTruthy();
        expect(h!.slot_group, row.id).toBe(row.slotGroup);
        if (typeof h!.art_aspect === 'number') expect(Math.abs((h!.art_aspect as number) - (row.aspect ?? 0))).toBeLessThan(0.01);
      }
    }
  });

  it('every name-style slug is in NAME_STYLES with the same recipe', () => {
    const styles = Object.values(COURT_ART).filter((r) => r.category === 'list_name_style' || r.category === 'profile_name_style');
    expect(styles.length).toBe(2 * CYCLES.length);
    for (const r of styles) {
      expect(NAME_STYLES[r.slug!], r.slug!).toBeTruthy();
      expect(NAME_STYLES[r.slug!]).toEqual(r.payload);
    }
  });
});

describe('courtArtFor', () => {
  it('draws pickles with a non-negative amount', () => {
    expect(courtArtFor({ kind: 'pickles', amount: 40 })).toEqual({ kind: 'pickles', amount: 40 });
    expect(courtArtFor({ kind: 'pickles', amount: null })).toEqual({ kind: 'pickles', amount: 0 });
  });

  it("uses the server's item first, with its shop_items.id for equipping", () => {
    const spec = courtArtFor({
      kind: 'shop_item',
      itemKey: 'cp2612-avatar-snowman',
      item: { id: 'uuid-1', category: 'avatar', slug: 'cp2612-avatar-snowman', icon: '⛄', payload: { emoji: '⛄', bgColor: '#123456' } },
    });
    expect(spec).toEqual({ kind: 'avatar', shopItemId: 'uuid-1', slug: 'cp2612-avatar-snowman', emoji: '⛄', bgColor: '#123456' });
    expect(isEquippableSpec(spec)).toBe(true);
  });

  it('falls back to COURT_ART without an item, with no shop id', () => {
    expect(courtArtFor({ kind: 'shop_item', itemKey: 'cp2612-profile-snowfall' })).toEqual({
      kind: 'name_style', shopItemId: null, slug: 'cp2612-profile-snowfall', mode: 'profile',
    });
    expect(courtArtFor({ kind: 'shop_item', itemKey: 'cp2612-list-frost' })).toMatchObject({ kind: 'name_style', mode: 'list' });
    // November: Golden Harvest is the existing sparkle effect on a burnt-orange base.
    expect(courtArtFor({ kind: 'shop_item', itemKey: 'cp2611-profile-golden-harvest' })).toEqual({
      kind: 'name_style', shopItemId: null, slug: 'cp2611-profile-golden-harvest', mode: 'profile',
    });
    expect(NAME_STYLES['cp2611-profile-golden-harvest']).toEqual({ kind: 'animated', effect: 'sparkle', base: '#c2571a' });
    expect(courtArtFor({ kind: 'shop_item', itemKey: 'cp2611-avatar-turkey' })).toMatchObject({ kind: 'avatar', emoji: '🦃', bgColor: '#fbe3c4' });
    expect(courtArtFor({ kind: 'home_item', itemKey: 'cp2611_pumpkin_stack' })).toEqual({
      kind: 'decor', itemId: 'cp2611_pumpkin_stack', fits: 'accent', aspect: 0.75,
    });
  });

  it('draws decor from the server row (slot_group mapped to slotGroup) or the fallback', () => {
    expect(courtArtFor({ kind: 'home_item', itemKey: 'cp2612_snow_globe', item: { id: 'cp2612_snow_globe', slotGroup: 'shelf_item', aspect: 1.003 } }))
      .toEqual({ kind: 'decor', itemId: 'cp2612_snow_globe', fits: 'shelf_item', aspect: 1.003 });
    const spec = courtArtFor({ kind: 'home_item', itemKey: 'cp2612_rug_snowflake' });
    expect(spec).toEqual({ kind: 'decor', itemId: 'cp2612_rug_snowflake', fits: 'rug', aspect: 3 });
    expect(isEquippableSpec(spec)).toBe(false);
  });

  it('is unknown for an unknown key or kind', () => {
    expect(courtArtFor({ kind: 'shop_item', itemKey: 'nope' })).toEqual({ kind: 'unknown' });
    expect(courtArtFor({ kind: 'home_item', itemKey: 'nope' })).toEqual({ kind: 'unknown' });
    expect(courtArtFor({ kind: 'points', amount: 5 })).toEqual({ kind: 'unknown' });
    expect(courtArtFor({ kind: 'shop_item', item: { id: 'x', category: 'flair', slug: 'x' } })).toEqual({ kind: 'unknown' });
    expect(isEquippableSpec({ kind: 'pickles', amount: 1 })).toBe(false);
  });
});
