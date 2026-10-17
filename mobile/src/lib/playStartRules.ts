// Why a Start at a court didn't check me in there, as a pure rule (no React
// Native, no Supabase), so vitest covers every branch. lib/playSession calls it
// after a Start lands (live or replayed from the offline queue) and the
// session's own check-in isn't the one I'm checked in with; lib/refusals words
// the reason (untrackedStartNote).
//
// The server judges a Start's fix at the TAP (supabase/migration_checkin_tap_time
// .sql, decided 2026-10-16): taken within 2 minutes of the tap, and the tap
// under 12 hours old. A replay inside that checks me in from the tap, and is
// stored already over when that is past, or closed at the End when the End
// reached Pickleague first (synced_late: it still counts as at the court for
// the session, but nobody saw me there).
import {
  FIX_MAX_AGE_MS,
  fixAgeMs,
  isPreciseFix,
  isValidFix,
  syncedAfterItEnded,
  type CheckinTimes,
  type DeviceFix,
} from './courtCheckinRules';
import type { UntrackedStartReason } from './refusals';

/** The server checks a Start in only within this long of its tap. */
export const START_CHECKIN_MAX_MS = 12 * 3600_000;

/** My check-in now, from the device's cache or the server. */
type CurrentLike = { id?: string; venueId: string; private?: boolean };

export type UntrackedStartInput = {
  /** What the Start sent. */
  payload: { venueId: string | null; at: string; fix?: DeviceFix | null; viaCheckin?: true };
  /** What came back (the server only returns the session row). */
  row: { venue_id: string | null } | null | undefined;
  /** My check-in now, from the device's cache or the server. */
  cur: CurrentLike | null;
  /** The session's own check-in (same id as the session), when the server has one. */
  sessionCheckin?: CheckinTimes | null;
  nowMs: number;
};

/** The reason, most specific first. */
export function untrackedReason(p: UntrackedStartInput): UntrackedStartReason {
  const { payload, row, cur } = p;
  if (row && payload.venueId && !row.venue_id) return 'court_gone';
  const fix = payload.fix;
  if (!fix || !isValidFix(fix)) {
    // No fix because the sheet relied on my check-in there: it had ended, or
    // it was a private one nobody sees.
    if (payload.viaCheckin) {
      const there = !!cur && [row?.venue_id, payload.venueId].some((v) => !!v && cur.venueId === v);
      return there && cur?.private ? 'checkin_private' : 'checkin_gone';
    }
    return 'no_fix';
  }
  if (!isPreciseFix(fix)) return 'imprecise';
  // The server stored the session's check-in, but it was over by the time
  // the Start synced: its own times say so (no clock offset can fake it).
  if (syncedAfterItEnded(p.sessionCheckin)) return 'synced_late';
  // Sent more than 12 hours after the tap (both on this device's clock).
  const tapMs = Date.parse(payload.at);
  if (Number.isFinite(tapMs) && p.nowMs - tapMs > START_CHECKIN_MAX_MS) return 'too_old';
  // Late, and nothing stored: the location didn't confirm the court at the
  // tap (an older server also refused any fix over 2 minutes old by then).
  if (fixAgeMs(fix, p.nowMs) > FIX_MAX_AGE_MS) return 'unconfirmed_late';
  return 'not_at_court';
}

/**
 * Is `cur` the check-in a session at `venueIds` gave me (its own, or the one
 * it adopted)? A private check-in (saved without a fix by an older build) is
 * never adopted and shows me to nobody, so it doesn't count.
 */
export function checkedInBySession(
  cur: CurrentLike | null,
  sessionId: string,
  venueIds: (string | null | undefined)[],
): boolean {
  return !!cur && !cur.private && (cur.id === sessionId || venueIds.some((v) => !!v && cur.venueId === v));
}

/**
 * The session's own check-in shows the Start checked me in: stored,
 * confirmed, and not only after it had ended. Needed once the session is
 * over on this device: the current check-in then hides a session check-in
 * whose End is still on its way.
 */
export function sessionCheckinCounts(ci: CheckinTimes | null | undefined): boolean {
  return !!ci && ci.location_confirmed !== false && !syncedAfterItEnded(ci);
}

/**
 * After a Start at a court lands: whether to say why it didn't check me in,
 * and where. Null: it did (my current check-in is the session's, or one it
 * adopted; or its own check-in counts). On the island only for a live Start
 * the island still shows; a replay from the offline queue, or a session
 * already over on this device, gets a card (rule 11: never silent).
 */
export function untrackedStartNotice(
  p: UntrackedStartInput & { sessionId: string; showing: boolean; queued: boolean },
): { onIsland: boolean; reason: UntrackedStartReason } | null {
  if (checkedInBySession(p.cur, p.sessionId, [p.row?.venue_id, p.payload.venueId])) return null;
  if (sessionCheckinCounts(p.sessionCheckin)) return null;
  return { onIsland: p.showing && !p.queued, reason: untrackedReason(p) };
}
