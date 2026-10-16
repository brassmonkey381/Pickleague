// Which play sessions count, app side (pure, so vitest covers it).
//
// docs/play-sessions-presence.md, "Phase 1.5: validity rules": a session
// counts for rewards and streaks when it lasted 5+ minutes AND a match or
// drill was recorded for it (a match linked to it, or recorded during it or
// within 2 h after it ends; a drill held during it and completed in that
// window). The server judges (play_sessions.valid,
// supabase/migration_validity_rules.sql); the app decides what to say when a
// session ends and how to word the server's answer (my_session_validity).
// Presence never depends on any of this: an invalid session still shows the
// player at the court.
import type { PlayKind } from '../data/playSessions';

/** A session shorter than this never counts. */
export const MIN_SESSION_MS = 5 * 60_000;
/** After End, a match or drill recorded within this long still counts for the session. */
export const RECORD_WINDOW_MS = 2 * 3_600_000;
/** End waits at most this long for the server's word before asking for a match or drill. */
export const END_CHECK_MS = 2_000;

/** What this device already knows makes a session count (lib/playSession notes it). */
export type RecordedForSession = 'match' | 'drill' | null;

/** A session the player just ended, as the island knew it. */
export type EndedPlay = {
  id: string;
  kind: PlayKind;
  sourceId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  /**
   * 'match': I recorded a match I played in while it ran. 'drill': the server
   * said it counts right after I reviewed a drill. null: nothing known here
   * (End then asks the server).
   */
  recorded: RecordedForSession;
};

/** What ending a session shows. */
export type EndDecision =
  /** A toast only. */
  | { show: 'note'; tone: 'info' | 'success'; message: string }
  /**
   * "Record a match or drill?". `unsure`: the server couldn't say whether
   * something already counts (offline, slow, or its Start not there yet), so
   * the copy must not claim nothing was recorded.
   */
  | { show: 'record'; lengthLabel: string; offerDrill: boolean; windowEndsAtMs: number; unsure?: boolean };

const TOO_SHORT_NOTE = "Session ended. Sessions under 5 minutes don't count.";
const PENDING_HEDGE = " If the other team doesn't confirm within the hour, it stops counting.";

/** "42 min", "1 h", "1 h 5 min". Under a minute reads "1 min". */
export function sessionLengthLabel(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** What End shows from what this device knows (endDecisionWithServer adds the server's word). */
export function endDecision(s: EndedPlay): EndDecision {
  const length = s.endedAtMs - s.startedAtMs;
  if (length < MIN_SESSION_MS) return { show: 'note', tone: 'info', message: TOO_SHORT_NOTE };
  if (s.recorded === 'match') {
    return { show: 'note', tone: 'success', message: 'Session ended. It counts: you recorded a match.' };
  }
  if (s.recorded === 'drill') {
    return { show: 'note', tone: 'success', message: 'Session ended. It counts: you recorded a match or drill.' };
  }
  return {
    show: 'record',
    lengthLabel: sessionLengthLabel(length),
    // The server counts a review of any drill of mine held during the session,
    // not only the one it was started from, so every drill session offers it.
    offerDrill: s.kind === 'drill',
    windowEndsAtMs: s.endedAtMs + RECORD_WINDOW_MS,
  };
}

/** my_session_validity's answer (null: not mine, or not on the server yet). */
export type SessionValidity = {
  valid: boolean;
  reason: 'open' | 'too_short' | 'no_match_or_drill' | 'linked_match' | 'match_in_window' | 'drill_in_window';
  needs: 'minutes' | 'match_or_drill' | null;
  window_ends_at: string | null;
  rewards_pending_confirmation?: boolean;
  /** A location-confirmed check-in at the session's court overlapped it. */
  at_court?: boolean;
};

/** The server's word at End: its answer, null (session not on the server), or 'unknown' (timed out / failed). */
export type ServerAnswer = SessionValidity | null | 'unknown';

/**
 * End, with the server's word. The server may already count the session: a
 * match a partner or opponent recorded, one I entered without the link, a
 * drill I reviewed, or anything from before an app restart. Asking for a
 * match then would invite a duplicate, so:
 *   - it counts (ended and valid, or still open on the server, its End on the
 *     way, with nothing more needed): a success toast;
 *   - too short by the server's clock: the too-short toast;
 *   - it needs a match or drill: the sheet, as sure as before;
 *   - no answer (offline, slow, not on the server yet): the sheet, hedged.
 * A local decision that is already a toast stands.
 */
export function endDecisionWithServer(local: EndDecision, v: ServerAnswer): EndDecision {
  if (local.show === 'note') return local;
  if (v === null || v === 'unknown') return { ...local, unsure: true };
  if (v.valid || (v.reason === 'open' && v.needs === null)) {
    const what =
      v.reason === 'drill_in_window'
        ? 'Session ended. It counts: you reviewed a drill.'
        : v.reason === 'open'
          ? 'Session ended. It counts: a match or drill you played is recorded.'
          : 'Session ended. It counts: a match you played in is recorded.';
    return {
      show: 'note',
      tone: 'success',
      message: v.valid && v.rewards_pending_confirmation ? what + PENDING_HEDGE : what,
    };
  }
  if (v.reason === 'too_short' || v.needs === 'minutes') return { show: 'note', tone: 'info', message: TOO_SHORT_NOTE };
  return local;
}

/** The end sheet's line. Hedged when the server couldn't say whether something already counts. */
export function endSheetBody(ask: Extract<EndDecision, { show: 'record' }>): string {
  return ask.unsure
    ? `Session ended after ${ask.lengthLabel}. If you haven't recorded what you played yet, record it within 2 hours and this session counts.`
    : `Session ended after ${ask.lengthLabel}. It counts once you record what you played, within 2 hours.`;
}

/** The note after "Not now" on the end sheet. `timeLabel` formats in the device zone ("7:40 PM"). */
export function notNowNote(windowEndsAtMs: number, timeLabel: (d: Date) => string, unsure = false): string {
  const by = timeLabel(new Date(windowEndsAtMs));
  return unsure
    ? `Saved. If nothing's recorded yet, this session counts once you record a match or drill by ${by}.`
    : `Saved. This session counts once you record a match or drill within 2 hours (by ${by}).`;
}

/**
 * Whether a match just inserted makes my running (or linked) session count,
 * so End needn't ask again. The server counts it only when I played in it.
 * When the insert carried the link and the server read it back as dropped
 * (my session isn't stored yet, was refused, or ended over 2 h ago), don't
 * claim it: End asks the server instead. `linkedBack` undefined: nothing read
 * back (no link sent, or a server without the column).
 */
export function shouldNoteRecorded(p: {
  iPlayed: boolean;
  sessionId: string;
  sentLink: boolean;
  linkedBack?: string | null;
}): boolean {
  if (!p.iPlayed) return false;
  if (p.sentLink && p.linkedBack !== undefined && p.linkedBack !== p.sessionId) return false;
  return true;
}

/**
 * One line for the player about a session the server judged, or null when
 * there is nothing to say (no answer, or the session is still running).
 */
export function validityNote(
  v: SessionValidity | null | undefined,
  nowMs: number,
  timeLabel: (d: Date) => string,
): string | null {
  if (!v || v.reason === 'open') return null;
  if (v.valid) {
    // Recorded is enough to count, but an unconfirmed match is deleted after
    // an hour (expire_pending_matches), and the session stops counting.
    return v.rewards_pending_confirmation ? 'This play session counts now.' + PENDING_HEDGE : 'This play session counts now.';
  }
  if (v.needs === 'minutes' || v.reason === 'too_short') return "Sessions under 5 minutes don't count.";
  const ends = v.window_ends_at ? Date.parse(v.window_ends_at) : NaN;
  if (Number.isFinite(ends) && ends > nowMs) {
    return `This session counts once you record a match or drill by ${timeLabel(new Date(ends))}.`;
  }
  return "This session didn't count: no match or drill was recorded within 2 hours of its end.";
}

/**
 * PostgREST's refusal of a column it doesn't know (PGRST204), e.g. a match
 * insert carrying play_session_id before migration_validity_rules.sql is
 * applied. Nothing was written, so the insert can safely go again without it.
 */
export function isMissingColumnError(e: unknown, column: string): boolean {
  const o = e as { code?: unknown; message?: unknown } | null;
  return !!o && o.code === 'PGRST204' && typeof o.message === 'string' && o.message.includes(column);
}
