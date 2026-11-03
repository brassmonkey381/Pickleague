// Pure half of data/rewardTrack: the get_reward_track jsonb
// (supabase/migration_court_pass_xp.sql) mapped onto the kit's reward-track
// types, ported from Doggle's lib/rewardTrackRows. Import-free (types only),
// so vitest runs it without the kit installed (lib/__tests__/rewardTrackRows.test.ts).
//
// Pickleague's additions to Doggle's shape (docs/court-pass.md):
//   - each reward carries its `item` (the shop_items / home_items row the art
//     and the equip button need), mapped to lib/courtArt's CourtArtItem;
//   - me.can_earn / me.not_earning: guests and test accounts earn 0, and the
//     screen says why;
//   - `paid`: what this read's settle step paid (pickles and the tiers), which
//     may include a tier reached in an earlier cycle.
import type {
  TrackGrant,
  TrackLane,
  TrackReward,
  TrackTier,
  TrackWindow,
} from '@just-messin-around/expo-foundation/gamification/rewardTrack';
import type { CourtArtItem } from './courtArt';

export type RewardTrackCycle = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  /** v1 only ever 'coming_soon' or 'off'; premium is never on sale yet. */
  premiumState: 'coming_soon' | 'off';
};

/** A kit reward plus the item behind it (null for pickles, or a server without the row). */
export type CourtTrackReward = TrackReward & { item: CourtArtItem | null };

/** Why this player earns no pickleballs (null: they earn). */
export type TrackNotEarning = 'guest' | 'test_account' | null;

/** What the read's settle step paid: the pickles, and each tier it paid. */
export type TrackPaid = {
  pickles: number;
  grants: { cycleId: string; tier: number; kind: string; title: string }[];
};

export type RewardTrackData = {
  /** The running Court Pass, or null between passes. */
  cycle: RewardTrackCycle | null;
  /** The kit's window for the running pass (null when there is none). */
  window: TrackWindow | null;
  /** When the next pass opens (null when none is seeded). */
  nextStartsAt: string | null;
  tiers: TrackTier[];
  rewards: CourtTrackReward[];
  grants: TrackGrant[];
  me: {
    xp: number;
    tier: number;
    todayXp: number;
    /** The pass's daily cap; null = no cap (every seeded pass, Brian 2026-11-03). */
    dailyCap: number | null;
    canEarn: boolean;
    notEarning: TrackNotEarning;
  };
  paid: TrackPaid;
};

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const lane = (v: unknown): TrackLane | null => (v === 'free' || v === 'premium' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const rows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => !!obj(r)) : [];

/** A reward's item (shop_items: category, slug, payload; home_items: slot_group, art_aspect). */
function mapItem(v: unknown): CourtArtItem | null {
  const o = obj(v);
  const id = o ? str(o.id) : null;
  if (!o || !id) return null;
  return {
    id,
    category: str(o.category),
    slug: str(o.slug),
    slotGroup: str(o.slot_group),
    aspect: typeof o.art_aspect === 'number' && Number.isFinite(o.art_aspect) && o.art_aspect > 0 ? o.art_aspect : null,
    icon: str(o.icon),
    payload: obj(o.payload),
  };
}

function mapNotEarning(v: unknown): TrackNotEarning {
  return v === 'guest' || v === 'test_account' ? v : null;
}

function mapPaid(v: unknown): TrackPaid {
  const o = obj(v) ?? {};
  const grants: TrackPaid['grants'] = [];
  for (const g of rows(o.grants)) {
    const cycleId = str(g.cycle_id);
    const tier = num(g.tier, NaN);
    if (!cycleId || !Number.isFinite(tier)) continue;
    grants.push({ cycleId, tier, kind: str(g.kind) ?? 'pickles', title: str(g.title) ?? '' });
  }
  return { pickles: Math.max(0, Math.floor(num(o.pickles))), grants };
}

/** The RPC's jsonb onto the app/kit shapes. Defensive: a junk row is dropped, not a crash. */
export function mapRewardTrack(raw: unknown): RewardTrackData {
  const o = obj(raw) ?? {};
  const c = obj(o.cycle);
  const cycle: RewardTrackCycle | null =
    c && str(c.id) && str(c.starts_at) && str(c.ends_at)
      ? {
          id: str(c.id)!,
          title: str(c.title) ?? 'Court Pass',
          startsAt: str(c.starts_at)!,
          endsAt: str(c.ends_at)!,
          // Anything but 'off' shows as coming soon: v1 never sells premium.
          premiumState: c.premium_state === 'off' ? 'off' : 'coming_soon',
        }
      : null;
  const me = obj(o.me) ?? {};

  const tiers: TrackTier[] = rows(o.tiers)
    .map((r) => ({ tier: num(r.tier, NaN), xpRequired: num(r.xp_required, NaN) }))
    .filter((t) => Number.isFinite(t.tier) && Number.isFinite(t.xpRequired));

  const rewards: CourtTrackReward[] = [];
  for (const r of rows(o.rewards)) {
    const l = lane(r.lane);
    const tier = num(r.tier, NaN);
    if (!l || !Number.isFinite(tier)) continue;
    rewards.push({
      tier,
      lane: l,
      kind: str(r.kind) ?? 'pickles',
      amount: typeof r.amount === 'number' ? r.amount : null,
      itemKey: str(r.item_key),
      title: str(r.title) ?? '',
      rarity: str(r.rarity),
      item: mapItem(r.item),
    });
  }

  const grants: TrackGrant[] = [];
  for (const g of rows(o.grants)) {
    const l = lane(g.lane);
    const tier = num(g.tier, NaN);
    const grantedAt = str(g.granted_at);
    if (!l || !Number.isFinite(tier) || !grantedAt) continue;
    grants.push({ tier, lane: l, grantedAt, seenAt: str(g.seen_at) });
  }

  const notEarning = mapNotEarning(me.not_earning);
  return {
    cycle,
    window: cycle ? { startsAt: cycle.startsAt, endsAt: cycle.endsAt, premiumState: cycle.premiumState } : null,
    nextStartsAt: str(o.next_starts_at),
    tiers,
    rewards,
    grants,
    me: {
      xp: num(me.xp),
      tier: num(me.tier),
      todayXp: num(me.today_xp),
      // null (or missing): no daily cap. Only a positive number is a cap.
      dailyCap: typeof me.daily_cap === 'number' && Number.isFinite(me.daily_cap) && me.daily_cap > 0 ? me.daily_cap : null,
      // The reason wins: a body saying can_earn true with a reason still can't earn.
      canEarn: notEarning == null && me.can_earn !== false,
      notEarning,
    },
    paid: mapPaid(o.paid),
  };
}

/** Grants the user has not been shown yet (free lane only: premium is never granted in v1). */
export function unseenGrants(d: Pick<RewardTrackData, 'grants'>): TrackGrant[] {
  return d.grants.filter((g) => g.lane === 'free' && !g.seenAt);
}
