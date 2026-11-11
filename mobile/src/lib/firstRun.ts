// First run (PKL-020 change 3, Brian's pick A without "How do you play"):
// Welcome, Your courts, Alerts, one per screen, then Home. Shown once per
// account on this device, to a new account (its first 7 days) that is not a
// guest. The rules are pure here; the screen is screens/FirstRunScreen.tsx and
// the courts come from suggested_courts (docs/recommendations/suggested-courts.md).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { inFirstWeek } from './homeFirstWeek';

const KEY_PREFIX = 'pickleague:firstRun:v1:';

export function firstRunKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export type FirstRunGate = {
  createdAt: string | null | undefined;
  nowMs: number;
  isGuest: boolean;
  /** The device already showed it to this account. */
  seen: boolean;
};

/** Show the first run: a new (first-week) account, not a guest, not shown on this device yet. */
export function shouldShowFirstRun(g: FirstRunGate): boolean {
  return !g.seen && !g.isGuest && inFirstWeek(g.createdAt, g.nowMs);
}

export async function firstRunSeen(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(firstRunKey(userId))) != null;
  } catch {
    // Storage unreadable: don't risk showing it on every launch.
    return true;
  }
}

/** Marked when it opens, so a closed app never brings it back on every launch. */
export async function markFirstRunSeen(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(firstRunKey(userId), new Date().toISOString());
  } catch {
    // Best effort.
  }
}

/** One court row from suggested_courts. */
export type SuggestedCourt = {
  venue_id: string;
  name: string;
  city: string | null;
  distance_m: number | null;
  court_count: number | null;
  players_30d: number;
  checkins_30d: number;
  leagues: number;
  sessions: number;
  matches_30d: number;
  favorites: number;
  recommended: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a court is suggested, strongest first, at most 2 reasons:
 * "9 players this month, 2 leagues". Empty when nothing but distance and size.
 */
export function courtReasons(c: SuggestedCourt): string[] {
  const out: string[] = [];
  if (c.players_30d > 0) out.push(`${plural(c.players_30d, 'player')} this month`);
  if (c.leagues > 0) out.push(plural(c.leagues, 'league'));
  if (c.sessions > 0) out.push(`${plural(c.sessions, 'session')} a week`);
  if (c.matches_30d > 0 && out.length < 2) out.push(`${plural(c.matches_30d, 'match', 'matches')} this month`);
  if (c.favorites > 0 && out.length < 2) out.push(`starred by ${plural(c.favorites, 'player')}`);
  return out.slice(0, 2);
}

/** "0.8 mi" / "12 mi", or null without a distance. */
export function milesLabel(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(m)) return null;
  const mi = m / 1609.344;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/** The row's second line: "Alameda, 0.8 mi, 6 courts". */
export function courtMetaLine(c: SuggestedCourt): string {
  return [c.city, milesLabel(c.distance_m), c.court_count ? plural(c.court_count, 'court') : null]
    .filter(Boolean)
    .join(', ');
}

/** Normalizes the RPC's jsonb rows (numbers may arrive as strings or null). */
export function normalizeSuggestedCourts(raw: unknown): SuggestedCourt[] {
  const rows = (raw as { nearby?: unknown } | null)?.nearby;
  if (!Array.isArray(rows)) return [];
  const n = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as any).venue_id === 'string')
    .map(r => ({
      venue_id: r.venue_id as string,
      name: String(r.name ?? 'Court'),
      city: (r.city as string | null) ?? null,
      distance_m: r.distance_m == null ? null : Number(r.distance_m),
      court_count: r.court_count == null ? null : Number(r.court_count),
      players_30d: n(r.players_30d),
      checkins_30d: n(r.checkins_30d),
      leagues: n(r.leagues),
      sessions: n(r.sessions),
      matches_30d: n(r.matches_30d),
      favorites: n(r.favorites),
      recommended: r.recommended === true,
    }));
}
