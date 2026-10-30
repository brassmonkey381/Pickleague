// Adding a match or a drill to a play session after it ended (2026-10-30;
// supabase/migration_session_drills.sql). Pure, so vitest covers it.
//
// The user: "i received an in app banner to record a match or drill for my
// sesssion, but was only offered a match score entering. i actually did
// drilling! And then when i look for it in my play history, i cant edit it to
// add a match score or drill session."
//
//   * End's sheet always offers a drill: "Review drill" for a session started
//     from a scheduled drill (its review), else "Log a drill" (a drill of my
//     own, logged and reviewed in one step: log_session_drill).
//   * Play history offers "Add a match" and "Add a drill" on a session that
//     ended in the last 7 days and lasted 5+ minutes: the server keeps a
//     match's link to it and takes a logged drill for that long.
import type { PlayKind } from '../data/playSessions';
import { MIN_SESSION_MS } from './sessionValidity';

/** How long after a session ends a match or drill can still be added to it. */
export const LATE_ADD_DAYS = 7;
export const LATE_ADD_MS = LATE_ADD_DAYS * 86_400_000;

/** log_session_drill's answer when this session has its drill already. */
export const ALREADY_LOGGED_MESSAGE = 'You already logged a drill for this session.';

export function isAlreadyLoggedMessage(message: string | null | undefined): boolean {
  return (message ?? '').trim() === ALREADY_LOGGED_MESSAGE;
}

/** End's drill button: review the scheduled drill the session was started from, else log one. */
export function endSheetDrillAction(ended: { kind: PlayKind; sourceId?: string | null }): 'review' | 'log' {
  return ended.kind === 'drill' && ended.sourceId ? 'review' : 'log';
}

export const END_SHEET_DRILL_TITLE: Record<'review' | 'log', string> = {
  review: 'Review drill',
  log: 'Log a drill',
};

/** What a Play history row offers to add. */
export type HistoryAdds = { match: boolean; drill: boolean };

/**
 * "Add a match" / "Add a drill" on a Play history row: only within 7 days of
 * its end and on a session long enough to count. A drill session already has
 * its drill (started from one, or logged), and a session a reviewed drill
 * counts for has one too.
 */
export function historyAdds(
  r: { kind: PlayKind; startedAt: string; endedAt: string; validReason: string | null },
  nowMs: number,
): HistoryAdds {
  const start = Date.parse(r.startedAt);
  const end = Date.parse(r.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { match: false, drill: false };
  const open = nowMs - end <= LATE_ADD_MS && end - start >= MIN_SESSION_MS;
  if (!open) return { match: false, drill: false };
  return { match: true, drill: r.kind !== 'drill' && r.validReason !== 'drill_in_window' };
}

/** The draft key for a drill logged for a play session (lib/drillReviewDraft). */
export function loggedDrillDraftId(playSessionId: string): string {
  return `log:${playSessionId}`;
}

/** After Log a drill: whether the session counts now (my_session_validity). */
export function loggedDrillNote(v: { valid?: boolean; reason?: string | null } | null | undefined): string | null {
  if (!v) return null;
  if (v.valid) return 'Your play session counts now.';
  return null;
}

/** A drill logged for a play session (log_session_drill): mine alone, player1 = player2. */
export function isLoggedDrill(d: { player1_id?: string | null; player2_id?: string | null }): boolean {
  return !!d.player1_id && d.player1_id === d.player2_id;
}
