// My Place, the pure half (docs/my-place.md): server rows to the kit's room
// shapes, what the decor sheet lists and what each item's button does, and
// how a refused visit reads. React-free (vitest: lib/__tests__/myPlace.test.ts).
//
// The rule (Brian, 2026-10-27): players only pick which owned item fills a
// slot. Nothing here moves, resizes or arranges anything; where a slot is
// drawn is the God mode layout (room_layout) or the slot's default.
import {
  emptyParentSlot,
  indexSlots,
  type SlotDef,
} from '@just-messin-around/expo-foundation/room/layout';
import {
  isItemOnSale,
  itemFitsSlot,
  roomItemState,
  type RoomItem,
  type RoomItemState,
  type RoomRarity,
} from '@just-messin-around/expo-foundation/room/shop';
import { refusalCode, type RefusalCode } from './refusals';

// ── server shapes ───────────────────────────────────────────────────────────

/** A home_items row (the columns the app reads). */
export type HomeItemRow = {
  id: string;
  name: string;
  slot_group: string;
  cost: number;
  rarity: string | null;
  season: string | null;
  available_from: string | null;
  available_until: string | null;
  art_key: string | null;
  art_aspect: number | string | null;
  icon: string | null;
  sort: number | null;
  is_starter: boolean | null;
};

/** A decor item: the kit's RoomItem plus the catalog's order. */
export type MyPlaceItem = RoomItem & { sort: number; isStarter: boolean };

/** slotId -> item id, as get_home / equip / clear return it. */
export type EquippedMap = Record<string, string>;

/** get_home(): yours has the owner-only fields. */
export type MyPlaceHome = {
  ownerId: string;
  isMe: boolean;
  visibility: MyPlaceVisibility;
  equipped: EquippedMap;
  itemIds: string[];
  /** Mine only. */
  owned: string[];
  starterClaimed: boolean;
  /** Mine only; null for someone else's place. */
  balance: number | null;
};

export type MyPlaceVisibility = 'friends' | 'only_me';

const RARITIES: ReadonlySet<string> = new Set(['common', 'rare', 'legendary']);

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

/** A home_items row as the kit's item (slot_group -> fits, art_key -> art, art_aspect -> aspect, dates). */
export function itemFromRow(r: HomeItemRow): MyPlaceItem {
  const aspect = num(r.art_aspect, NaN);
  return {
    id: r.id,
    name: r.name,
    fits: r.slot_group,
    cost: Math.max(0, num(r.cost, 0)),
    art: r.art_key ?? null,
    svg: null,
    aspect: aspect > 0 ? aspect : null,
    rarity: r.rarity && RARITIES.has(r.rarity) ? (r.rarity as RoomRarity) : 'common',
    icon: r.icon ?? null,
    availableFrom: r.available_from ?? null,
    availableUntil: r.available_until ?? null,
    season: r.season ?? null,
    sort: num(r.sort, 0),
    isStarter: r.is_starter === true,
  };
}

/** An object of slot -> item id strings (anything else dropped). */
export function equippedFrom(v: unknown): EquippedMap {
  const out: EquippedMap = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, id] of Object.entries(v as Record<string, unknown>)) {
    if (typeof id === 'string' && id) out[k] = id;
  }
  return out;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** get_home()'s jsonb, read defensively (a field left out reads as its default). */
export function homeFromRpc(raw: unknown): MyPlaceHome {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bal = o.balance;
  return {
    ownerId: typeof o.owner_id === 'string' ? o.owner_id : '',
    isMe: o.is_me === true,
    visibility: o.visibility === 'only_me' ? 'only_me' : 'friends',
    equipped: equippedFrom(o.equipped),
    itemIds: ids(o.item_ids),
    owned: ids(o.owned),
    starterClaimed: o.starter_claimed === true,
    balance: typeof bal === 'number' && Number.isFinite(bal) ? bal : null,
  };
}

// ── the decor sheet ─────────────────────────────────────────────────────────

/** What an item's button does in the open slot. */
export type DecorAction =
  /** In this slot now: take it out. */
  | { type: 'remove' }
  /** Owned: put it here (`from`: the slot it moves out of). */
  | { type: 'equip'; from: string | null }
  /** For sale and affordable (or free). */
  | { type: 'buy' }
  /** For sale, the balance is short (`short`: how many more), or unknown (null). */
  | { type: 'locked'; short: number | null }
  /** Not on sale and not owned. */
  | { type: 'unavailable'; notYet: boolean };

export type DecorRow = {
  item: MyPlaceItem;
  state: RoomItemState;
  action: DecorAction;
};

export type DecorContext = {
  owned: ReadonlySet<string> | readonly string[];
  equipped: Readonly<Record<string, string | null | undefined>>;
  balance: number | null;
  now?: Date;
};

const ownedHas = (owned: DecorContext['owned'], id: string) =>
  Array.isArray(owned) ? (owned as readonly string[]).includes(id) : (owned as ReadonlySet<string>).has(id);

/** The slot (other than `slotId`) an item sits in now, or null. */
export function slotHolding(equipped: DecorContext['equipped'], itemId: string, slotId: string): string | null {
  for (const [s, id] of Object.entries(equipped)) if (id === itemId && s !== slotId) return s;
  return null;
}

export function decorAction(item: MyPlaceItem, slotId: string, ctx: DecorContext): DecorAction {
  const state = roomItemState(item, slotId, ctx);
  switch (state) {
    case 'equipped':
      return { type: 'remove' };
    case 'owned':
      return { type: 'equip', from: slotHolding(ctx.equipped, item.id, slotId) };
    case 'buyable':
      return { type: 'buy' };
    case 'locked':
      return { type: 'locked', short: ctx.balance == null ? null : Math.max(1, item.cost - ctx.balance) };
    case 'unavailable': {
      const from = item.availableFrom ? Date.parse(String(item.availableFrom)) : NaN;
      return { type: 'unavailable', notYet: Number.isFinite(from) && from > (ctx.now ?? new Date()).getTime() };
    }
  }
}

const RANK: Record<RoomItemState, number> = { equipped: 0, owned: 1, buyable: 2, locked: 3, unavailable: 4 };

/**
 * The sheet's list for a slot: everything that fits it, owned first (the one
 * in the slot at the top), then what's for sale by price. An item no longer
 * sold stays listed only for its owner (they keep it); one not on sale yet is
 * left out until it is.
 */
export function decorRows(items: readonly MyPlaceItem[], slot: Pick<SlotDef, 'id' | 'fits'>, ctx: DecorContext): DecorRow[] {
  return items
    .filter((i) => itemFitsSlot(i, slot) && (ownedHas(ctx.owned, i.id) || isItemOnSale(i, ctx.now)))
    .map((item) => ({ item, state: roomItemState(item, slot.id, ctx), action: decorAction(item, slot.id, ctx) }))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.item.cost - b.item.cost || a.item.sort - b.item.sort || a.item.name.localeCompare(b.item.name));
}

/** The first empty slot `slotId` sits on (a pillow with no couch), or null. */
export function blockingParent(slots: readonly SlotDef[], slotId: string, equipped: DecorContext['equipped']): SlotDef | null {
  return emptyParentSlot(slots, slotId, equipped);
}

/** "Couch pillow sits on the Couch spot..." for a slot whose parent is empty. */
export function parentEmptyNote(slot: Pick<SlotDef, 'label'>, parent: Pick<SlotDef, 'label'>): string {
  return `${slot.label} sits on the ${parent.label} spot, which is empty, so anything here wouldn't show. Put something in ${parent.label} first.`;
}

/** Slots the server knows (equip refuses the rest): the app's list, minus slots home_slots doesn't have. */
export function slotsTheServerKnows(slots: readonly SlotDef[], serverSlotIds: readonly string[] | null | undefined): SlotDef[] {
  if (!serverSlotIds || serverSlotIds.length === 0) return [...slots];
  const known = new Set(serverSlotIds);
  return slots.filter((s) => known.has(s.id));
}

/** slotId -> item, for RoomScene (ids the catalog doesn't have are dropped, never drawn as junk). */
export function sceneItems(
  equipped: Readonly<Record<string, string | null | undefined>>,
  byId: Readonly<Record<string, MyPlaceItem>>,
): Record<string, MyPlaceItem | null> {
  const out: Record<string, MyPlaceItem | null> = {};
  for (const [slot, id] of Object.entries(equipped)) out[slot] = id ? byId[id] ?? null : null;
  return out;
}

/** How many decor slots hold something (the avatar never counts). */
export function filledCount(equipped: Readonly<Record<string, string | null | undefined>>, slots: readonly SlotDef[]): number {
  const idx = indexSlots(slots);
  return Object.entries(equipped).filter(([s, id]) => !!id && idx.byId[s] && idx.byId[s].kind !== 'avatar').length;
}

// ── visiting ────────────────────────────────────────────────────────────────

/** Why a visit shows a state instead of the room. */
export type VisitBlock = 'private' | 'friends_only' | 'unavailable' | 'gone' | 'guest' | 'signed_out';

const VISIT_BLOCKS: Partial<Record<RefusalCode, VisitBlock>> = {
  'home.private': 'private',
  'home.friends_only': 'friends_only',
  'home.unavailable': 'unavailable',
  'player.gone': 'gone',
  'home.guest': 'guest',
  'auth.signed_out': 'signed_out',
};

/** The friendly state for a refused get_home, or null for any other error (a retry). */
export function visitBlock(e: unknown): VisitBlock | null {
  const code = refusalCode(e);
  return code ? VISIT_BLOCKS[code] ?? null : null;
}

/** The state's heading (the body is the refusal copy). */
export function visitBlockTitle(b: VisitBlock, name: string | null | undefined): string {
  const who = name?.trim() || 'This player';
  switch (b) {
    case 'private':
      return `${who}'s place is private`;
    case 'friends_only':
      return `${who}'s place is for friends`;
    case 'unavailable':
    case 'gone':
      return 'This place is unavailable';
    case 'guest':
      return 'Finish signing up to visit';
    case 'signed_out':
      return 'Sign in to visit';
  }
}

// ── the avatar ──────────────────────────────────────────────────────────────

export type AvatarLook = { photoUrl: string | null; emoji: string; bgColor: string };

/**
 * How the app draws a player (Profile's order): their photo, else the equipped
 * premium avatar (emoji + colour), else their cartoon avatar.
 */
export function avatarLook(
  p: { avatar_url?: string | null; avatar_emoji?: string | null; avatar_bg_color?: string | null; avatar_id?: number | null } | null | undefined,
  cartoons: readonly { id: number; emoji: string; bgColor: string }[],
): AvatarLook {
  const cartoon = cartoons.find((a) => a.id === (p?.avatar_id ?? 1)) ?? cartoons[0];
  const premium = p?.avatar_emoji && p?.avatar_bg_color ? { emoji: p.avatar_emoji, bgColor: p.avatar_bg_color } : null;
  return {
    photoUrl: p?.avatar_url || null,
    emoji: premium?.emoji ?? cartoon?.emoji ?? '🙂',
    bgColor: premium?.bgColor ?? cartoon?.bgColor ?? '#c8e6c9',
  };
}

/** "Brian" from "Brian Stockman" (the server's own first-name rule). */
export function firstName(fullName: string | null | undefined): string {
  return fullName?.trim().split(/\s+/)[0] ?? '';
}

// ── backdrop tiles ──────────────────────────────────────────────────────────

/** Where repeated tiles go in a band: tile size and the counts that cover it. */
export function tileGrid(bandWidth: number, bandHeight: number, tileWidth: number, aspect: number | null | undefined) {
  const w = Math.max(1, tileWidth);
  const h = w / (aspect && aspect > 0 ? aspect : 1);
  return { w, h, cols: Math.max(1, Math.ceil(bandWidth / w)), rows: Math.max(1, Math.ceil(bandHeight / h)) };
}
