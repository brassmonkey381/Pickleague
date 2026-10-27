import { describe, it, expect, vi, beforeEach } from 'vitest';

// Equipping goes through the server (equip_shop_item / unequip_cosmetic); a
// server without them yet (PGRST202) gets the old direct profiles write.
const h = vi.hoisted(() => ({
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  updates: [] as { cols: Record<string, unknown>; id: unknown }[],
  rpcReply: null as unknown,
  rpcError: null as unknown,
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args });
      return h.rpcError ? Promise.reject(h.rpcError) : Promise.resolve(h.rpcReply);
    },
    from: (table: string) => ({
      update: (cols: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          expect(table).toBe('profiles');
          h.updates.push({ cols, id });
          return Promise.resolve(null);
        },
      }),
    }),
  },
}));
vi.mock('@just-messin-around/expo-foundation/supabase', () => ({
  sbCall: (fn: () => Promise<unknown>) => fn(),
  classifySbError: (e: { code?: string } | null) => (e?.code === 'PGRST202' ? 'missingFunction' : 'unknown'),
  currentUserId: () => Promise.resolve('me'),
}));

import { cosmeticColumns, equipShopItem, parseEquipped, unequipCosmetic } from '../cosmetics';

const avatar = { id: 'i1', category: 'avatar' as const, slug: 'avatar-fox', payload: { emoji: '🦊', bgColor: '#ff8800' } };
const flair = { id: 'i2', category: 'flair' as const, slug: 'flair-name-gold', payload: { kind: 'name_color', value: '#d4af37' } };
const listStyle = { id: 'i3', category: 'list_name_style' as const, slug: 'list-neon', payload: {} };
const profileStyle = { id: 'i4', category: 'profile_name_style' as const, slug: 'hero-fire', payload: {} };
const badge = { id: 'i5', category: 'cosmetic_badge' as const, slug: 'badge-x', payload: {} };

const REPLY = {
  avatar_emoji: '🦊', avatar_bg_color: '#ff8800', name_color: null, list_name_style_id: null, profile_name_style_id: 'hero-fire',
};

beforeEach(() => {
  h.rpcs.length = 0;
  h.updates.length = 0;
  h.rpcReply = REPLY;
  h.rpcError = null;
});

describe('cosmeticColumns: the server mapping, category -> columns', () => {
  it('maps each equippable category', () => {
    expect(cosmeticColumns(avatar)).toEqual({ avatar_emoji: '🦊', avatar_bg_color: '#ff8800' });
    expect(cosmeticColumns(flair)).toEqual({ name_color: '#d4af37' });
    expect(cosmeticColumns(listStyle)).toEqual({ list_name_style_id: 'list-neon' });
    expect(cosmeticColumns(profileStyle)).toEqual({ profile_name_style_id: 'hero-fire' });
  });
  it('nothing for items nobody equips', () => {
    expect(cosmeticColumns(badge)).toBeNull();
    expect(cosmeticColumns({ ...flair, payload: { kind: 'sparkle' } })).toBeNull();
  });
});

describe('equipShopItem', () => {
  it('calls equip_shop_item with the item id, never writes profiles', async () => {
    const cols = await equipShopItem(avatar);
    expect(h.rpcs).toEqual([{ fn: 'equip_shop_item', args: { p_item_id: 'i1' } }]);
    expect(h.updates).toEqual([]);
    expect(cols).toEqual(REPLY);
  });

  it('a refusal is thrown as is (explainRefusal words it)', async () => {
    const refusal = { code: 'P0001', message: "You don't own Fox yet", hint: 'pl:shop.not_owned' };
    h.rpcError = refusal;
    await expect(equipShopItem(avatar)).rejects.toBe(refusal);
    expect(h.updates).toEqual([]);
  });

  it('a server without the RPC (PGRST202) gets the old direct write', async () => {
    h.rpcError = { code: 'PGRST202', message: 'Could not find the function public.equip_shop_item' };
    const cols = await equipShopItem(flair);
    expect(h.updates).toEqual([{ cols: { name_color: '#d4af37' }, id: 'me' }]);
    expect(cols).toEqual({ name_color: '#d4af37' });
  });
});

describe('unequipCosmetic', () => {
  it('calls unequip_cosmetic with the category', async () => {
    await unequipCosmetic('avatar');
    expect(h.rpcs).toEqual([{ fn: 'unequip_cosmetic', args: { p_category: 'avatar' } }]);
    expect(h.updates).toEqual([]);
  });
  it('falls back to clearing the columns on an older server', async () => {
    h.rpcError = { code: 'PGRST202', message: 'Could not find the function public.unequip_cosmetic' };
    expect(await unequipCosmetic('avatar')).toEqual({ avatar_emoji: null, avatar_bg_color: null });
    expect(h.updates).toEqual([{ cols: { avatar_emoji: null, avatar_bg_color: null }, id: 'me' }]);
  });
});

describe('parseEquipped', () => {
  it('reads the five columns, anything else as null', () => {
    expect(parseEquipped({ avatar_emoji: 'x', name_color: 5, extra: 'y' })).toEqual({
      avatar_emoji: 'x', avatar_bg_color: null, name_color: null, list_name_style_id: null, profile_name_style_id: null,
    });
    expect(parseEquipped(null).avatar_emoji).toBeNull();
  });
});
