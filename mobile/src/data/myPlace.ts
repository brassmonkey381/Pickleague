// My Place, server side (docs/my-place.md, supabase/migration_my_place.sql):
// typed wrappers for the RPCs and cached reads of the catalog, the admin
// layout, the slot structure and the item art.
//
//   get_home(p_owner)           mine (owned, balance, starter) or a visit
//   buy_home_item / equip_home_item / clear_home_slot
//   set_my_place_visibility     friends | only_me
//   claim_my_place_starter      the free starter set, once (a repeat is fine)
//   save_room_layout            God mode only
//
// Refusals come back as P0001 with HINT pl:<code> (lib/refusals.ts words
// them); these wrappers never catch them. Every write's answer goes straight
// into the cached home, so the room re-renders from one write.
//
// Art: home_item_art is read only for the ids being drawn (the room, the open
// sheet), kept in memory under ART_KEY, and sanitized on the device by the
// kit's art resolver (createArtResolver) when drawn.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import {
  cachedFetch,
  invalidateQueries,
  peekQuery,
  setQueryData,
  subscribeQueryKey,
  useCachedQuery,
} from '@just-messin-around/expo-foundation/cache';
import { migrateLayout, type RoomLayout } from '@just-messin-around/expo-foundation/room/layout';
import { supabase } from '../lib/supabase';
import {
  equippedFrom,
  homeFromRpc,
  itemFromRow,
  type EquippedMap,
  type HomeItemRow,
  type MyPlaceHome,
  type MyPlaceItem,
  type MyPlaceVisibility,
} from '../lib/myPlace';
import { MY_PLACE_SLOTS } from '../lib/myPlaceSlots';

export const MY_PLACE_KEY = 'myplace';
export const MY_HOME_KEY = 'me:myPlace';
const CATALOG_KEY = 'myplace:catalog';
const LAYOUT_KEY = 'myplace:layout';
const ART_KEY = 'myplace:art';
const visitKey = (ownerId: string) => `myplace:visit:${ownerId}`;
const ownerKey = (ownerId: string) => `myplace:owner:${ownerId}`;

const BOUND = { timeoutMs: 9_000 };
const PERSIST_MS = 7 * 24 * 60 * 60 * 1000;
/** The catalog and the layout change only when an admin edits them. */
const STATIC_TTL_MS = 10 * 60_000;
const HOME_TTL_MS = 60_000;
/** A visit is re-read often: a block or a privacy change must apply soon. */
const VISIT_TTL_MS = 20_000;

// ── reads ───────────────────────────────────────────────────────────────────

export type MyPlaceCatalog = {
  items: MyPlaceItem[];
  byId: Record<string, MyPlaceItem>;
  /** home_slots ids, to hide a slot this server doesn't know yet. */
  serverSlotIds: string[];
};

export async function fetchMyPlaceCatalog(): Promise<MyPlaceCatalog> {
  const [rows, slots] = await Promise.all([
    sbCall(
      () =>
        supabase
          .from('home_items')
          .select('id, name, slot_group, cost, rarity, season, available_from, available_until, art_key, art_aspect, icon, sort, is_starter')
          .order('sort', { ascending: true }),
      BOUND,
    ),
    sbCall(() => supabase.from('home_slots').select('id').order('sort', { ascending: true }), BOUND),
  ]);
  const items = ((rows ?? []) as HomeItemRow[]).map(itemFromRow);
  return {
    items,
    byId: Object.fromEntries(items.map((i) => [i.id, i])),
    serverSlotIds: ((slots ?? []) as { id: string }[]).map((s) => s.id),
  };
}

export function useMyPlaceCatalog(enabled = true) {
  return useCachedQuery<MyPlaceCatalog>(CATALOG_KEY, fetchMyPlaceCatalog, {
    ttlMs: STATIC_TTL_MS,
    persistMs: PERSIST_MS,
    enabled,
  });
}

/** The admin layout as saved (raw jsonb; null when there's no row). */
export async function fetchRoomLayoutRaw(): Promise<unknown> {
  const rows = await sbCall(() => supabase.from('room_layout').select('layout').eq('id', 'default').limit(1), BOUND);
  return ((rows ?? []) as { layout: unknown }[])[0]?.layout ?? null;
}

/** The admin layout, read through the kit's migrateLayout (a bad one shows the defaults, never an empty room). */
export function useRoomLayout(enabled = true): { layout: RoomLayout | null; newerVersion: number | null; loading: boolean; error: unknown; refresh: () => Promise<void> } {
  const q = useCachedQuery<unknown>(LAYOUT_KEY, fetchRoomLayoutRaw, { ttlMs: STATIC_TTL_MS, persistMs: PERSIST_MS, enabled });
  const migrated = useMemo(() => (q.data === undefined ? null : migrateLayout(q.data, MY_PLACE_SLOTS)), [q.data]);
  return {
    layout: migrated?.layout ?? null,
    newerVersion: migrated?.newerVersion ?? null,
    loading: q.loading,
    error: q.error,
    refresh: q.refresh,
  };
}

export async function getHome(ownerId?: string | null): Promise<MyPlaceHome> {
  return homeFromRpc(await sbCall(() => supabase.rpc('get_home', { p_owner: ownerId ?? null }), BOUND));
}

/** My own place (owned items, balance, starter state). */
export function useMyHome(enabled = true) {
  return useCachedQuery<MyPlaceHome>(MY_HOME_KEY, () => getHome(null), {
    ttlMs: HOME_TTL_MS,
    persistMs: PERSIST_MS,
    enabled,
  });
}

/** Someone else's place. Not kept on disk: a block or Only me must apply on the next open. */
export function useVisitHome(ownerId: string | null, enabled = true) {
  return useCachedQuery<MyPlaceHome>(visitKey(ownerId ?? '-'), () => getHome(ownerId), {
    ttlMs: VISIT_TTL_MS,
    enabled: enabled && !!ownerId,
  });
}

export type PlaceOwner = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
};

export async function fetchPlaceOwner(ownerId: string): Promise<PlaceOwner | null> {
  const rows = await sbCall(
    () =>
      supabase
        .from('profiles')
        .select('id, full_name, avatar_url, avatar_id, avatar_emoji, avatar_bg_color')
        .eq('id', ownerId)
        .limit(1),
    BOUND,
  );
  return ((rows ?? []) as PlaceOwner[])[0] ?? null;
}

/** Whose room it is: name and avatar, for the avatar slot and the heading. */
export function usePlaceOwner(ownerId: string | null) {
  return useCachedQuery<PlaceOwner | null>(ownerKey(ownerId ?? '-'), () => fetchPlaceOwner(ownerId as string), {
    ttlMs: HOME_TTL_MS,
    persistMs: PERSIST_MS,
    enabled: !!ownerId,
  });
}

// ── art ─────────────────────────────────────────────────────────────────────

type ArtMap = Record<string, string | null>;
const NO_ART: ArtMap = Object.freeze({}) as ArtMap;
const artInflight = new Set<string>();

/** Read home_item_art for any of `ids` not read yet (null = the item has no art row). */
export async function loadItemArt(itemIds: readonly string[]): Promise<void> {
  const have = peekQuery<ArtMap>(ART_KEY) ?? NO_ART;
  const missing = [...new Set(itemIds)].filter((id) => id && !(id in have) && !artInflight.has(id));
  if (missing.length === 0) return;
  missing.forEach((id) => artInflight.add(id));
  try {
    const rows = await sbCall(() => supabase.from('home_item_art').select('item_id, art_svg').in('item_id', missing), BOUND);
    const next: ArtMap = { ...(peekQuery<ArtMap>(ART_KEY) ?? NO_ART) };
    for (const id of missing) next[id] = null;
    for (const r of (rows ?? []) as { item_id: string; art_svg: string | null }[]) next[r.item_id] = r.art_svg ?? null;
    setQueryData(ART_KEY, next);
  } finally {
    missing.forEach((id) => artInflight.delete(id));
  }
}

/** item id -> server SVG (unsanitized; the resolver sanitizes), loading what's missing. */
export function useItemArt(itemIds: readonly string[]): ArtMap {
  const art = useSyncExternalStore(
    (cb) => subscribeQueryKey(ART_KEY, cb),
    () => peekQuery<ArtMap>(ART_KEY) ?? NO_ART,
    () => peekQuery<ArtMap>(ART_KEY) ?? NO_ART,
  );
  const want = useMemo(() => [...new Set(itemIds)].sort().join(','), [itemIds]);
  useEffect(() => {
    if (!want) return;
    // A failed read leaves the ids unread: the placeholder shows, and the next open retries.
    void loadItemArt(want.split(',')).catch(() => {});
  }, [want]);
  return art;
}

// ── writes ──────────────────────────────────────────────────────────────────

function patchMyHome(patch: (h: MyPlaceHome) => MyPlaceHome): void {
  const cur = peekQuery<MyPlaceHome>(MY_HOME_KEY);
  if (cur) setQueryData(MY_HOME_KEY, patch(cur));
  else invalidateQueries(MY_HOME_KEY);
}

export type BuyResult = { itemId: string; cost: number; balance: number | null; alreadyOwned: boolean };

/** Buy with pickles. Already owned = success, nothing charged. Does not put it in. */
export async function buyHomeItem(itemId: string): Promise<BuyResult> {
  const r = ((await sbCall(() => supabase.rpc('buy_home_item', { p_item_id: itemId }), BOUND)) ?? {}) as Record<string, unknown>;
  const res: BuyResult = {
    itemId: typeof r.item_id === 'string' ? r.item_id : itemId,
    cost: typeof r.cost === 'number' ? r.cost : 0,
    balance: typeof r.balance === 'number' ? r.balance : null,
    alreadyOwned: r.already_owned === true,
  };
  patchMyHome((h) => ({
    ...h,
    owned: h.owned.includes(res.itemId) ? h.owned : [...h.owned, res.itemId],
    balance: res.balance ?? h.balance,
  }));
  return res;
}

export type EquipResult = { slotId: string; itemId: string; movedFrom: string | null; equipped: EquippedMap };

/** Put an owned item in a slot (one already in another slot moves). */
export async function equipHomeItem(slotId: string, itemId: string): Promise<EquipResult> {
  const r = ((await sbCall(() => supabase.rpc('equip_home_item', { p_slot_id: slotId, p_item_id: itemId }), BOUND)) ??
    {}) as Record<string, unknown>;
  const equipped = equippedFrom(r.equipped);
  patchMyHome((h) => ({ ...h, equipped, itemIds: [...new Set(Object.values(equipped))] }));
  return {
    slotId: typeof r.slot_id === 'string' ? r.slot_id : slotId,
    itemId: typeof r.item_id === 'string' ? r.item_id : itemId,
    movedFrom: typeof r.moved_from === 'string' ? r.moved_from : null,
    equipped,
  };
}

/** Empty a slot (an empty one is fine). */
export async function clearHomeSlot(slotId: string): Promise<{ cleared: boolean; equipped: EquippedMap }> {
  const r = ((await sbCall(() => supabase.rpc('clear_home_slot', { p_slot_id: slotId }), BOUND)) ?? {}) as Record<string, unknown>;
  const equipped = equippedFrom(r.equipped);
  patchMyHome((h) => ({ ...h, equipped, itemIds: [...new Set(Object.values(equipped))] }));
  return { cleared: r.cleared === true, equipped };
}

export async function setMyPlaceVisibility(visibility: MyPlaceVisibility): Promise<MyPlaceVisibility> {
  const r = ((await sbCall(() => supabase.rpc('set_my_place_visibility', { p_visibility: visibility }), BOUND)) ??
    {}) as Record<string, unknown>;
  const v: MyPlaceVisibility = r.visibility === 'only_me' ? 'only_me' : 'friends';
  patchMyHome((h) => ({ ...h, visibility: v }));
  return v;
}

export type StarterResult = { claimed: boolean; items: string[]; equipped: EquippedMap };

/** The free starter set, once. A second call is claimed: false (not an error). Re-reads my home after. */
export async function claimMyPlaceStarter(): Promise<StarterResult> {
  const r = ((await sbCall(() => supabase.rpc('claim_my_place_starter'), BOUND)) ?? {}) as Record<string, unknown>;
  const res: StarterResult = {
    claimed: r.claimed === true,
    items: Array.isArray(r.items) ? r.items.filter((x): x is string => typeof x === 'string') : [],
    equipped: equippedFrom(r.equipped),
  };
  patchMyHome((h) => ({
    ...h,
    starterClaimed: true,
    equipped: res.equipped,
    itemIds: [...new Set(Object.values(res.equipped))],
    owned: [...new Set([...h.owned, ...res.items])],
  }));
  // owned is the server's word: read it again in the background.
  void cachedFetch(MY_HOME_KEY, () => getHome(null), { ttlMs: 0, persistMs: PERSIST_MS }).catch(() => {});
  return res;
}

/** God mode only (the server checks too). The saved layout replaces the cached one. */
export async function saveRoomLayout(layout: RoomLayout): Promise<{ updatedAt: string | null }> {
  const r = ((await sbCall(() => supabase.rpc('save_room_layout', { p_layout: layout }), BOUND)) ?? {}) as Record<string, unknown>;
  setQueryData(LAYOUT_KEY, layout);
  return { updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null };
}

/** Pull to refresh: everything My Place reads. */
export function invalidateMyPlace(): void {
  invalidateQueries(MY_PLACE_KEY);
  invalidateQueries(MY_HOME_KEY);
}
