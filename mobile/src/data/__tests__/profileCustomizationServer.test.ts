import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { AVATARS, BASE_TAG_SLOTS, PLAY_TAGS, TAG_SLOT_UNLOCKS } from '../profileCustomization';

// The profiles column guard (supabase/migration_cosmetic_equip_owned.sql)
// refuses an unlockable avatar or badge play tag the player hasn't earned,
// and more tags than their slots. It keeps its own copy of these lists; this
// fails when the app's and the server's differ.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sql = fs.readFileSync(path.join(root, 'supabase/migration_cosmetic_equip_owned.sql'), 'utf8');
const guard = sql.slice(sql.indexOf('function public._pl_profiles_column_guard()'));

describe('the server guard mirrors profileCustomization.ts', () => {
  it('unlockable avatars: same ids and badges', () => {
    const m = guard.match(/from \(values (\(\d+, '[^']+'\)(?:, \(\d+, '[^']+'\))*)\) as u\(avatar_id, badge\)/);
    expect(m).not.toBeNull();
    const server = [...m![1].matchAll(/\((\d+), '([^']+)'\)/g)].map(x => [Number(x[1]), x[2]]);
    const app = AVATARS.filter(a => a.unlock).map(a => [a.id, a.unlock!.badge]);
    expect(server).toEqual(app);
  });

  it('badge play tags: same slugs and badges', () => {
    const m = guard.match(/from \(values([\s\S]*?)\) as u\(slug, badge\)/);
    expect(m).not.toBeNull();
    const server = [...m![1].matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map(x => [x[1], x[2]]);
    const app = PLAY_TAGS.filter(t => t.unlock).map(t => [t.slug, t.unlock!.badge]);
    expect(server).toEqual(app);
  });

  it('tag slots: same base and slot badges', () => {
    const m = guard.match(/v_tag_slots := (\d+) \+ cardinality\(array\(select x from unnest\(array\[([^\]]+)\]\)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(BASE_TAG_SLOTS);
    expect([...m![2].matchAll(/'([^']+)'/g)].map(x => x[1])).toEqual(TAG_SLOT_UNLOCKS.map(u => u.badge));
  });
});
