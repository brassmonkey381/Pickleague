// Play and check-in are one thing (the user, 2026-10-24: "go merge play and
// check-in"): every check-in starts the play session timer, and a check-out
// ends it. The rules lib/checkinPlay and the island follow, pure so vitest
// covers them. The server does the same on its own once
// supabase/migration_checkin_starts_session.sql is live; until then the app
// does it (start_play_session with the check-in's id, which the server then
// treats as a replay of the session the check-in started).
//
// PURE: no react-native, no expo.

/** The session the island shows (null: none). */
export type RunningPlay = { id: string; venueId: string | null; startedAtMs: number | null } | null;

/** A check-in, as far as these rules need it. */
export type CheckinFacts = { id: string; venueId: string; source: 'manual' | 'geofence' | 'session' };

/**
 * After a check-in this device made: start the timer with the check-in's own
 * id (so a server that starts the session itself already has it: a replay),
 * adopt the running timer (a "just time it" session gains the court), switch
 * (a session at another court: the server ended it when this check-in closed
 * that court's, or ends it when this Start lands; the island drops it without
 * asking and starts this one), or do nothing (a session already runs at this
 * court, or this is a Start's own check-in).
 */
export function onCheckedIn(p: {
  play: RunningPlay;
  checkin: CheckinFacts;
}): { kind: 'start'; id: string } | { kind: 'adopt' } | { kind: 'switch'; id: string } | null {
  if (p.checkin.source === 'session') return null;
  if (!p.play) return { kind: 'start', id: p.checkin.id };
  if (!p.play.venueId) return { kind: 'adopt' };
  if (p.play.id !== p.checkin.id && p.play.venueId !== p.checkin.venueId) return { kind: 'switch', id: p.checkin.id };
  return null;
}

/** A check-out this device sent: does it end the running session? */
export function checkoutEndsPlay(p: { play: RunningPlay; checkout: { id: string; venueId: string | null } }): boolean {
  if (!p.play) return false;
  if (p.play.id === p.checkout.id) return true;
  return !!p.play.venueId && p.play.venueId === p.checkout.venueId;
}

/**
 * Check out (= End) on the island: the check-in to check out alongside the
 * End, or null. A Start's own check-in (same id) closes with its End on the
 * server already; any other check-in (by hand, on arrival) is checked out too.
 */
export function checkinToCloseWithEnd(p: {
  sessionId: string;
  checkin: { id: string; source: CheckinFacts['source'] } | null;
}): string | null {
  if (!p.checkin) return null;
  if (p.checkin.source === 'session' && p.checkin.id === p.sessionId) return null;
  return p.checkin.id;
}

/** The island's last action: Check out while checked in (it is the End too), else End. */
export function endActionLabel(checkedIn: boolean): 'Check out' | 'End' {
  return checkedIn ? 'Check out' : 'End';
}

/** How long after an arrival a take-back can come (the server's 5 minutes, with room for a slow signal). */
export const TAKE_BACK_WINDOW_MS = 10 * 60_000;

/**
 * An arrival at `venueId` was taken back (left, or Not here, within 5
 * minutes): the server deleted the session it started, so the island drops a
 * session there that began in that window, silently (nothing was played).
 */
export function takeBackClearsPlay(p: { play: RunningPlay; venueId: string; nowMs: number }): boolean {
  if (!p.play || p.play.venueId !== p.venueId || p.play.startedAtMs == null) return false;
  return p.nowMs - p.play.startedAtMs < TAKE_BACK_WINDOW_MS;
}
