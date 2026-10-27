// Equipping Shop cosmetics (supabase/migration_cosmetic_equip_owned.sql): the
// server checks the player owns the item, so the app equips through
// equip_shop_item / unequip_cosmetic and never writes the five equipped
// columns on profiles itself. A refusal (pl:shop.not_owned, ...) is thrown as
// is; lib/refusalNotices explainRefusal words it.
//
// A server without that file yet (PGRST202: the web build deploys on push,
// the SQL is applied by hand) gets the old direct write, which its guard
// still allows, so equipping never breaks in between.
import { sbCall, classifySbError, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { ShopItem } from '../types';

/** The profiles columns that hold what a player has equipped. */
export type EquippedCosmetics = {
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  name_color: string | null;
  list_name_style_id: string | null;
  profile_name_style_id: string | null;
};

/** The categories a player equips (a flair only when it is a name color). */
export type CosmeticCategory = 'avatar' | 'flair' | 'list_name_style' | 'profile_name_style';

export type EquippableItem = Pick<ShopItem, 'id' | 'category' | 'slug' | 'payload'>;

const KEYS: (keyof EquippedCosmetics)[] = [
  'avatar_emoji', 'avatar_bg_color', 'name_color', 'list_name_style_id', 'profile_name_style_id',
];

/**
 * The columns an item sets when equipped: the server's mapping (category ->
 * columns). Null for an item nobody equips (a decorative badge, a real-world
 * item, a flair that isn't a name color).
 */
export function cosmeticColumns(item: EquippableItem): Partial<EquippedCosmetics> | null {
  const p = item.payload ?? {};
  switch (item.category) {
    case 'avatar':
      return { avatar_emoji: p.emoji ?? null, avatar_bg_color: p.bgColor ?? null };
    case 'flair':
      return p.kind === 'name_color' ? { name_color: p.value ?? null } : null;
    case 'list_name_style':
      return { list_name_style_id: item.slug };
    case 'profile_name_style':
      return { profile_name_style_id: item.slug };
    default:
      return null;
  }
}

/** The columns unequipping a category clears. */
export function clearedColumns(category: CosmeticCategory): Partial<EquippedCosmetics> {
  switch (category) {
    case 'avatar':
      return { avatar_emoji: null, avatar_bg_color: null };
    case 'flair':
      return { name_color: null };
    case 'list_name_style':
      return { list_name_style_id: null };
    case 'profile_name_style':
      return { profile_name_style_id: null };
  }
}

/** The RPC's reply, five columns; anything missing or not a string reads as null. */
export function parseEquipped(data: unknown): EquippedCosmetics {
  const r = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const out = {} as EquippedCosmetics;
  for (const k of KEYS) out[k] = typeof r[k] === 'string' && r[k] ? (r[k] as string) : null;
  return out;
}

async function directWrite(cols: Partial<EquippedCosmetics>): Promise<Partial<EquippedCosmetics>> {
  const uid = await currentUserId(supabase);
  // The kit's signed-out text, which refusalCode reads as auth.signed_out.
  if (!uid) throw new Error('Not signed in.');
  await sbCall(() => supabase.from('profiles').update(cols).eq('id', uid));
  return cols;
}

/**
 * Equip a Shop item I own. Resolves with the equipped columns as the server
 * now has them (all five), or, from a server without the RPC, the ones written.
 */
export async function equipShopItem(item: EquippableItem): Promise<Partial<EquippedCosmetics>> {
  try {
    return parseEquipped(await sbCall(() => supabase.rpc('equip_shop_item', { p_item_id: item.id })));
  } catch (e) {
    const cols = cosmeticColumns(item);
    if (cols && classifySbError(e) === 'missingFunction') return directWrite(cols);
    throw e;
  }
}

/** Back to the default look for a category (cartoon avatar, plain name). */
export async function unequipCosmetic(category: CosmeticCategory): Promise<Partial<EquippedCosmetics>> {
  try {
    return parseEquipped(await sbCall(() => supabase.rpc('unequip_cosmetic', { p_category: category })));
  } catch (e) {
    if (classifySbError(e) === 'missingFunction') return directWrite(clearedColumns(category));
    throw e;
  }
}
