// Pickle history (supabase/migration_pickle_ledger.sql, kit 1.73 points kit):
// the only path to list_pickle_ledger, list_pickle_ledger_range and
// my_pickle_today, and the row -> PointsLedgerEntry mapping the kit's viewer
// (components/home/PicklesViewer) and calendar (screens/PicklesCalendarScreen)
// draw.
//
// Kinds (the server's kind -> the kit's):
//   earn -> earned (pay for playing; the play streak is one of these)
//   bonus -> bonus (gold: welcome, referrals, login reward, gifts)
//   spend -> spent
//   start, refund, adjust, reversal -> neutral: listed, drawn muted, and left
//     out of every total. A reversal (a deleted match taking back its pickles)
//     is neither a spend the player chose nor a gain, and my_pickle_today
//     counts spent_today as kind 'spend' only: drawing it as spent would make
//     the calendar's "-150 spent" disagree with the server's own day totals,
//     and its mirror (a refund) is neutral too.
// An unknown kind (a newer server) falls back to the sign, the kit's rule.
//
// Days: the kit buckets entries by the device's local day; the server's
// local_day (the player's stored zone) is kept on the row but the kit has no
// day-key input. The two agree whenever the device is in the stored zone.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import type {
  PointsEntryKind,
  PointsLedgerEntry,
  PointsPageRequest,
} from '@just-messin-around/expo-foundation/gamification/pointsLedger';
import { supabase } from '../lib/supabase';
import { isServerRefusal, refusalMessage } from '../lib/refusals';

const BOUND = { timeoutMs: 9_000 };

/** The server's page size cap (list_pickle_ledger clamps p_limit to 1..100). */
export const PICKLE_LEDGER_MAX_PAGE = 100;
/** list_pickle_ledger_range refuses a range longer than this (pl:request.bad). */
export const PICKLE_LEDGER_RANGE_MAX_DAYS = 62;
/** The calendar's months, through the kit's query cache ('me:' keys go with the account). */
export const PICKLE_CALENDAR_CACHE_KEY = 'me:pickleLedger:v1';

export type PickleLedgerKind = 'earn' | 'bonus' | 'spend' | 'refund' | 'reversal' | 'start' | 'adjust';

/** One row of list_pickle_ledger / list_pickle_ledger_range. */
export type PickleLedgerRow = {
  id: number | string;
  delta: number;
  balance_after: number | null;
  reason: string | null;
  kind: PickleLedgerKind | string | null;
  category: string | null;
  is_bonus: boolean | null;
  created_at: string;
  local_day: string | null;
  meta: Record<string, unknown> | null;
};

/** my_pickle_today(): today in the player's zone. */
export type PickleToday = {
  tz: string;
  day: string;
  /** The play streak's daily most (200). */
  cap: number;
  played_today: boolean;
  streak_days: number;
  /** Today's play streak grant (0 until a match today). */
  streak_today: number;
  /** What the next play day brings: today's if not played yet, else tomorrow's. */
  next_streak: number;
  earned_today: number;
  bonus_today: number;
  spent_today: number;
  net_today: number;
};

const KIND: Record<string, PointsEntryKind> = {
  earn: 'earned',
  bonus: 'bonus',
  spend: 'spent',
  start: 'neutral',
  refund: 'neutral',
  adjust: 'neutral',
  reversal: 'neutral',
};

/** The kit kind for a server kind; undefined (the kit's sign rule) for one this build doesn't know. */
export function pickleKindOf(kind: string | null | undefined): PointsEntryKind | undefined {
  return kind ? KIND[kind] : undefined;
}

/** The label when a row has no reason (the server always writes one; old or odd rows). */
export function pickleFallbackLabel(delta: number): string {
  return delta < 0 ? 'Pickles spent' : 'Pickles added';
}

export function toPickleEntry(r: PickleLedgerRow): PointsLedgerEntry {
  const delta = Number(r.delta) || 0;
  const kind = pickleKindOf(r.kind);
  const label = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : pickleFallbackLabel(delta);
  return {
    id: String(r.id),
    amount: delta,
    label,
    // The server's string as is: the next page's p_before goes back to it with its microseconds.
    at: r.created_at,
    // Gold only on a gain the server calls bonus; never on a neutral row.
    bonus: kind === 'neutral' ? false : r.is_bonus === true,
    ...(kind ? { kind } : {}),
  };
}

export function toPickleEntries(rows: unknown): PointsLedgerEntry[] {
  return Array.isArray(rows) ? (rows as PickleLedgerRow[]).map(toPickleEntry) : [];
}

/**
 * A failed read as the viewer should word it. A server refusal (HINT
 * 'pl:<code>') already says why and what to do, so it passes as is (the kit
 * shows its message). A known refusal in an older wording gets the app's copy.
 * Anything else (no signal, a missing function, a 5xx) passes untouched for
 * the kit's own classification.
 */
export function pickleLedgerError(e: unknown): unknown {
  if (isServerRefusal(e)) return e;
  const copy = refusalMessage(e);
  return copy ? new Error(copy) : e;
}

async function call(build: Parameters<typeof sbCall<unknown>>[0]): Promise<unknown> {
  try {
    return await sbCall(build, BOUND);
  } catch (e) {
    throw pickleLedgerError(e);
  }
}

/**
 * One page of the feed, newest first, by keyset: p_before / p_before_id are
 * the oldest loaded row's created_at (the server's own string) and id, so a
 * page that ends inside a group of same-transaction rows doesn't skip the rest.
 */
export async function listPickleLedgerPage({ limit, before, beforeId }: PointsPageRequest): Promise<PointsLedgerEntry[]> {
  const id = beforeId == null || beforeId === '' ? null : Number(beforeId);
  const rows = await call(() =>
    supabase.rpc('list_pickle_ledger', {
      p_limit: Math.max(1, Math.min(PICKLE_LEDGER_MAX_PAGE, Math.floor(limit))),
      p_before: before ?? null,
      p_before_id: id != null && Number.isFinite(id) ? id : null,
    }),
  );
  return toPickleEntries(rows);
}

const DAY_MS = 86_400_000;

/**
 * [from, to) split into spans the server accepts (at most 62 days each). The
 * kit asks for one month, so this is one span in practice; a longer ask is
 * split rather than refused.
 */
export function pickleRangeChunks(fromISO: string, toISO: string, maxDays = PICKLE_LEDGER_RANGE_MAX_DAYS): [string, string][] {
  const from = Date.parse(fromISO);
  const to = Date.parse(toISO);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const span = maxDays * DAY_MS;
  if (to - from <= span) return [[fromISO, toISO]];
  const out: [string, string][] = [];
  for (let a = from; a < to; a += span) {
    const b = Math.min(a + span, to);
    out.push([a === from ? fromISO : new Date(a).toISOString(), b === to ? toISO : new Date(b).toISOString()]);
  }
  return out;
}

/** The calendar's month: every row with from <= created_at < to, newest first. */
export async function listPickleLedgerRange(fromISO: string, toISO: string): Promise<PointsLedgerEntry[]> {
  const chunks = pickleRangeChunks(fromISO, toISO);
  // Newest span first, so the joined list stays newest first.
  const pages = await Promise.all(
    chunks.reverse().map(([p_from, p_to]) => call(() => supabase.rpc('list_pickle_ledger_range', { p_from, p_to }))),
  );
  return pages.flatMap(toPickleEntries);
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** my_pickle_today()'s object, every field defaulted (null for a non-object answer). */
export function parsePickleToday(raw: unknown): PickleToday | null {
  const o = Array.isArray(raw) ? raw[0] : raw;
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  return {
    tz: typeof r.tz === 'string' ? r.tz : '',
    day: typeof r.day === 'string' ? r.day : '',
    cap: num(r.cap, 200),
    played_today: r.played_today === true,
    streak_days: num(r.streak_days),
    streak_today: num(r.streak_today),
    next_streak: num(r.next_streak),
    earned_today: num(r.earned_today),
    bonus_today: num(r.bonus_today),
    spent_today: num(r.spent_today),
    net_today: num(r.net_today),
  };
}

export async function loadPickleToday(): Promise<PickleToday | null> {
  return parsePickleToday(await call(() => supabase.rpc('my_pickle_today')));
}

/**
 * The cap meter's caption: the play streak pays once a day (50 x streak day,
 * at most 200), so "N left to earn today" would be untrue after today's grant.
 */
/** The line shown in place of the play-streak meter when my_pickle_today fails (reason from pointsErrorReason). */
export function playStreakLoadError(reason: string): string {
  return `Couldn't load today's play streak. ${reason} Your pickles and their history are fine.`;
}

export function playStreakCaption(today: PickleToday | null): string | null {
  if (!today) return null;
  const next = today.next_streak.toLocaleString();
  if (today.played_today) {
    const days = today.streak_days;
    return `Day ${days.toLocaleString()} of your play streak is in. Play tomorrow for ${next} more. Other pickles don't count toward it.`;
  }
  return today.streak_days > 0
    ? `Play a match today to keep your ${today.streak_days.toLocaleString()}-day streak and earn ${next}.`
    : `Play a match today to start a play streak and earn ${next}.`;
}
