// Why a Start at a court didn't check me in there, as a pure rule (no React
// Native, no Supabase), so vitest covers every branch. lib/playSession calls it
// after a Start lands (live or replayed from the offline queue) and the
// session's own check-in isn't the one I'm checked in with; lib/refusals words
// the reason (untrackedStartNote).
//
// The server judges a Start's fix at the TAP (supabase/migration_checkin_tap_time
// .sql, decided 2026-10-16): taken within 2 minutes of the tap, and the tap
// under 12 hours old. A replay inside that checks me in from the tap, and is
// stored already over when that is past (synced_late: it still counts as at
// the court for the session, but nobody saw me there).
import { FIX_MAX_AGE_MS, fixAgeMs, isPreciseFix, isValidFix, syncedAfterItEnded, type DeviceFix } from './courtCheckinRules';
import type { UntrackedStartReason } from './refusals';
import type { VenueCheckin } from '../data/venueCheckins';

/** The server checks a Start in only within this long of its tap. */
export const START_CHECKIN_MAX_MS = 12 * 3600_000;

export type UntrackedStartInput = {
  /** What the Start sent. */
  payload: { venueId: string | null; at: string; fix?: DeviceFix | null; viaCheckin?: true };
  /** What came back (the server only returns the session row). */
  row: { venue_id: string | null } | null | undefined;
  /** My check-in now, from the device's cache or the server. */
  cur: { venueId: string; private?: boolean } | null;
  /** The session's own check-in (same id as the session), when the server has one. */
  sessionCheckin?: Pick<VenueCheckin, 'expires_at' | 'created_at' | 'location_confirmed'> | null;
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
