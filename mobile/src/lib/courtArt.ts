// Which picture a Court Pass reward draws, and whether it can be put on. Pure
// (types only); components/courtPass/CourtRewardArt draws the result.
//
// get_reward_track returns each item reward's `item` (the shop_items or
// home_items row it grants: docs/court-pass.md, the JSON shape). That row is
// the source of truth. COURT_ART is the month's items as drawn in
// art/court-pass/<cycle>/catalog.json, a fallback for when `item` is missing,
// so the screen still draws a known item. A fallback shop item has no
// shop_items.id, so its spec's shopItemId is null and it can't be equipped
// from here until the server row arrives.
//
// Equipping uses the existing RPCs: an avatar or name style through
// equipShopItem (data/cosmetics); decor is placed from My Place.

/** A reward as the art needs it (a kit TrackReward with the server's `item`). */
export type CourtArtInput = {
  kind: string;
  amount?: number | null;
  itemKey?: string | null;
  item?: CourtArtItem | null;
};

/** The granted row: shop_items (id is its uuid; category, slug, payload) or home_items (id, slotGroup, aspect). */
export type CourtArtItem = {
  id: string;
  category?: string | null;
  slug?: string | null;
  slotGroup?: string | null;
  aspect?: number | null;
  icon?: string | null;
  payload?: Record<string, unknown> | null;
};

export type CourtArtSpec =
  | { kind: 'pickles'; amount: number }
  | { kind: 'avatar'; shopItemId: string | null; slug: string; emoji: string; bgColor: string }
  | { kind: 'name_style'; shopItemId: string | null; slug: string; mode: 'list' | 'profile' }
  | { kind: 'decor'; itemId: string; fits: string; aspect: number | null }
  | { kind: 'unknown' };

/**
 * Every month's items: 2026-11 (November, the harvest set) and 2026-12
 * (December, the winter set), from art/court-pass/<cycle>/catalog.json.
 * Payloads equal the cycles SQL (courtArt.test.ts pins both).
 */
export const COURT_ART: Record<string, CourtArtItem & { kind: 'shop_item' | 'home_item' }> = {
  // ── 2026-11 (November Court Pass), from art/court-pass/2026-11/catalog.json ──
  // Free lane
  'cp2611-avatar-turkey': {
    kind: 'shop_item', id: 'cp2611-avatar-turkey', category: 'avatar', slug: 'cp2611-avatar-turkey', icon: '🦃',
    payload: { emoji: '🦃', bgColor: '#fbe3c4' },
  },
  cp2611_cornucopia: { kind: 'home_item', id: 'cp2611_cornucopia', slotGroup: 'shelf_item', aspect: 1, icon: '🌽' },
  cp2611_pumpkin_stack: { kind: 'home_item', id: 'cp2611_pumpkin_stack', slotGroup: 'accent', aspect: 0.75, icon: '🍂' },
  cp2611_window_autumn: { kind: 'home_item', id: 'cp2611_window_autumn', slotGroup: 'window', aspect: 0.9, icon: '🪟' },
  'cp2611-list-harvest': {
    kind: 'shop_item', id: 'cp2611-list-harvest', category: 'list_name_style', slug: 'cp2611-list-harvest', icon: '🧡',
    payload: { kind: 'gradient', stops: ['#b5451b', '#e8a33d'], direction: 'horizontal' },
  },
  'cp2611-profile-golden-harvest': {
    kind: 'shop_item', id: 'cp2611-profile-golden-harvest', category: 'profile_name_style', slug: 'cp2611-profile-golden-harvest', icon: '✨',
    payload: { kind: 'animated', effect: 'sparkle', base: '#c2571a' },
  },
  // Premium lane (display only)
  cp2611_poster_gratitude: { kind: 'home_item', id: 'cp2611_poster_gratitude', slotGroup: 'wall_art', aspect: 0.8, icon: '🖼️' },
  'cp2611-avatar-pie': {
    kind: 'shop_item', id: 'cp2611-avatar-pie', category: 'avatar', slug: 'cp2611-avatar-pie', icon: '🥧',
    payload: { emoji: '🥧', bgColor: '#f6e1c3' },
  },
  cp2611_leaf_garland: { kind: 'home_item', id: 'cp2611_leaf_garland', slotGroup: 'ceiling', aspect: 4, icon: '🍁' },
  cp2611_pillow_plaid: { kind: 'home_item', id: 'cp2611_pillow_plaid', slotGroup: 'couch_pillow', aspect: 1.2, icon: '🛋️' },
  cp2611_rug_harvest: { kind: 'home_item', id: 'cp2611_rug_harvest', slotGroup: 'rug', aspect: 3, icon: '🧺' },
  cp2611_rack_harvest_hall: { kind: 'home_item', id: 'cp2611_rack_harvest_hall', slotGroup: 'paddle_rack', aspect: 1.25, icon: '🌾' },
  // ── 2026-12 (December Court Pass), from art/court-pass/2026-12/catalog.json ──
  // Free lane
  'cp2612-avatar-snowman': {
    kind: 'shop_item', id: 'cp2612-avatar-snowman', category: 'avatar', slug: 'cp2612-avatar-snowman', icon: '⛄',
    payload: { emoji: '⛄', bgColor: '#dceefb' },
  },
  cp2612_snow_globe: { kind: 'home_item', id: 'cp2612_snow_globe', slotGroup: 'shelf_item', aspect: 1, icon: '❄️' },
  cp2612_ornament_tree: { kind: 'home_item', id: 'cp2612_ornament_tree', slotGroup: 'accent', aspect: 0.75, icon: '🎄' },
  cp2612_window_snow: { kind: 'home_item', id: 'cp2612_window_snow', slotGroup: 'window', aspect: 0.9, icon: '🌨️' },
  'cp2612-list-frost': {
    kind: 'shop_item', id: 'cp2612-list-frost', category: 'list_name_style', slug: 'cp2612-list-frost', icon: '🧊',
    payload: { kind: 'gradient', stops: ['#2f7fc1', '#7cc7ff'], direction: 'horizontal' },
  },
  'cp2612-profile-snowfall': {
    kind: 'shop_item', id: 'cp2612-profile-snowfall', category: 'profile_name_style', slug: 'cp2612-profile-snowfall', icon: '🌨️',
    payload: { kind: 'animated', effect: 'snowfall', base: '#2f7fc1' },
  },
  // Premium lane (display only)
  cp2612_poster_first_frost: { kind: 'home_item', id: 'cp2612_poster_first_frost', slotGroup: 'wall_art', aspect: 0.8, icon: '🖼️' },
  'cp2612-avatar-reindeer': {
    kind: 'shop_item', id: 'cp2612-avatar-reindeer', category: 'avatar', slug: 'cp2612-avatar-reindeer', icon: '🦌',
    payload: { emoji: '🦌', bgColor: '#f1e3d3' },
  },
  cp2612_icicle_lights: { kind: 'home_item', id: 'cp2612_icicle_lights', slotGroup: 'ceiling', aspect: 4, icon: '✨' },
  cp2612_pillow_knit: { kind: 'home_item', id: 'cp2612_pillow_knit', slotGroup: 'couch_pillow', aspect: 1.2, icon: '🧶' },
  cp2612_rug_snowflake: { kind: 'home_item', id: 'cp2612_rug_snowflake', slotGroup: 'rug', aspect: 3, icon: '❄️' },
  cp2612_rack_ice_palace: { kind: 'home_item', id: 'cp2612_rack_ice_palace', slotGroup: 'paddle_rack', aspect: 1.25, icon: '🧊' },
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The art (and equip target) for one reward. */
export function courtArtFor(reward: CourtArtInput): CourtArtSpec {
  if (reward.kind === 'pickles') return { kind: 'pickles', amount: Math.max(0, reward.amount ?? 0) };
  const key = reward.itemKey ?? null;
  const fallback = key ? COURT_ART[key] : undefined;

  if (reward.kind === 'shop_item') {
    const fromServer = reward.item ?? null;
    const row = fromServer ?? (fallback?.kind === 'shop_item' ? fallback : null);
    if (!row) return { kind: 'unknown' };
    const slug = str(row.slug) ?? key;
    if (!slug) return { kind: 'unknown' };
    // Only a server row carries the real shop_items.id that equipping needs.
    const shopItemId = fromServer ? str(fromServer.id) : null;
    const category = row.category ?? fallback?.category ?? null;
    if (category === 'avatar') {
      const payload = row.payload ?? fallback?.payload ?? null;
      const emoji = str(payload?.emoji) ?? str(row.icon);
      if (!emoji) return { kind: 'unknown' };
      return { kind: 'avatar', shopItemId, slug, emoji, bgColor: str(payload?.bgColor) ?? '#dceefb' };
    }
    if (category === 'list_name_style') return { kind: 'name_style', shopItemId, slug, mode: 'list' };
    if (category === 'profile_name_style') return { kind: 'name_style', shopItemId, slug, mode: 'profile' };
    return { kind: 'unknown' };
  }

  if (reward.kind === 'home_item') {
    const row = reward.item ?? (fallback?.kind === 'home_item' ? fallback : null);
    const itemId = str(row?.id) ?? key;
    const fits = str(row?.slotGroup) ?? fallback?.slotGroup ?? null;
    if (!itemId || !fits) return { kind: 'unknown' };
    const aspect = row?.aspect ?? fallback?.aspect ?? null;
    return { kind: 'decor', itemId, fits, aspect: typeof aspect === 'number' && aspect > 0 ? aspect : null };
  }

  return { kind: 'unknown' };
}

/** Whether the item can be put on from the Court Pass (an avatar or a name style); decor is placed in My Place. */
export function isEquippableSpec(spec: CourtArtSpec): spec is Extract<CourtArtSpec, { kind: 'avatar' | 'name_style' }> {
  return spec.kind === 'avatar' || spec.kind === 'name_style';
}
