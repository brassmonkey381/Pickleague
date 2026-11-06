// My Place stays (supabase/migration_place_stays.sql, docs/my-place.md): the
// answers' shapes, read defensively, and the copy. The stay rules and
// clockTime are the kit's (/stays/rules, 1.107).
//
// PURE (type imports and the kit's React-free rules only), so vitest reads it.
import { clockTime, STAY_HOURS } from '@just-messin-around/expo-foundation/stays/rules';

/** Where my avatar is staying right now (get_place_stays.away). */
export type PlaceStayAway = { hostId: string; hostLabel: string; endsAt: string };

/** A friend's avatar staying at this place now (get_place_stays.guests). */
export type PlaceStayGuest = {
  visitorId: string;
  name: string;
  endsAt: string;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  avatar_id: number | null;
};

export type PlaceStays = { away: PlaceStayAway | null; guests: PlaceStayGuest[] };

export const NO_PLACE_STAYS: PlaceStays = Object.freeze({ away: null, guests: [] }) as unknown as PlaceStays;

/** A finished stay, handed over once by claim_place_stay_returns. */
export type PlaceStayReturn = {
  stay_id: string;
  host_id: string;
  host_label: string;
  souvenir: string | null;
  pickles: number;
  pickleballs: number;
  returned_at: string;
  item_id: string | null;
  item_name: string | null;
  item_rarity: 'common' | 'rare' | 'legendary' | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function placeStaysFromRpc(raw: unknown): PlaceStays {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const a = r.away && typeof r.away === 'object' ? (r.away as Record<string, unknown>) : null;
  const away =
    a && str(a.host_id) && str(a.ends_at)
      ? { hostId: str(a.host_id)!, hostLabel: str(a.host_label) ?? "your friend's place", endsAt: str(a.ends_at)! }
      : null;
  const guests: PlaceStayGuest[] = [];
  for (const g of Array.isArray(r.guests) ? r.guests : []) {
    const x = g && typeof g === 'object' ? (g as Record<string, unknown>) : null;
    if (!x || !str(x.visitor_id) || !str(x.ends_at)) continue;
    guests.push({
      visitorId: str(x.visitor_id)!,
      name: str(x.name) ?? 'A friend',
      endsAt: str(x.ends_at)!,
      avatar_url: str(x.avatar_url),
      avatar_emoji: str(x.avatar_emoji),
      avatar_bg_color: str(x.avatar_bg_color),
      avatar_id: typeof x.avatar_id === 'number' ? x.avatar_id : null,
    });
  }
  return { away, guests };
}

export function placeStayReturnsFromRpc(raw: unknown): PlaceStayReturn[] {
  const out: PlaceStayReturn[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const x = row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
    if (!x || !str(x.stay_id)) continue;
    const rarity = x.item_rarity;
    out.push({
      stay_id: str(x.stay_id)!,
      host_id: str(x.host_id) ?? '',
      host_label: str(x.host_label) ?? "your friend's place",
      souvenir: str(x.souvenir),
      pickles: num(x.pickles),
      pickleballs: num(x.pickleballs),
      returned_at: str(x.returned_at) ?? '',
      item_id: str(x.item_id),
      item_name: str(x.item_name),
      item_rarity: rarity === 'common' || rarity === 'rare' || rarity === 'legendary' ? rarity : null,
    });
  }
  return out;
}

// ── copy ────────────────────────────────────────────────────────────────────

/** The button on a friend's place. */
export const STAY_BUTTON = `Stay for ${STAY_HOURS} hours`;
export const COME_HOME_BUTTON = 'Come home early';

/** Under the Stay button, before a stay. */
export const STAY_PITCH =
  `Your avatar hangs out here for ${STAY_HOURS} hours, then comes home with a souvenir and pickles. ` +
  'Sometimes it brings back decor for your place too.';

/** My own place while my avatar is away. */
export function awayLine(away: PlaceStayAway): string {
  return `You're staying at ${away.hostLabel} until ${clockTime(away.endsAt)}.`;
}

/** A friend's place where my avatar is staying. */
export function stayingHereLine(endsAt: string): string {
  return `You're staying here until ${clockTime(endsAt)}. Come back to Home after that for what you brought back.`;
}

/** Someone staying at a place ("Sam is visiting until 7:20 PM"). */
export function guestLine(g: Pick<PlaceStayGuest, 'name' | 'endsAt'>): string {
  return `${g.name} is visiting until ${clockTime(g.endsAt)}.`;
}

/** A friend's place while its owner is away ("Sam's out staying at Lee's place until 3:40 PM."). */
export function ownerAwayLine(ownerFirst: string, away: PlaceStayAway): string {
  return `${ownerFirst || 'They'}'s out staying at ${away.hostLabel} until ${clockTime(away.endsAt)}.`;
}

/** The Come home early confirm. */
export const COME_HOME_CONFIRM = {
  title: 'Come home early?',
  body: 'Your avatar comes home now. A stay cut short brings back no pickles or souvenir.',
  label: 'Come home',
};

/** The return card. */
export function returnTitle(): string {
  return "You're home!";
}
export function returnMessage(r: Pick<PlaceStayReturn, 'souvenir' | 'host_label'>): string {
  return r.souvenir ?? `You had a great time at ${r.host_label}.`;
}
