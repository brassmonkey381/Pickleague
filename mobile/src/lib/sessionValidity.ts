// Which play sessions count, app side (pure, so vitest covers it).
//
// docs/play-sessions-presence.md, "Phase 1.5: validity rules": a session
// counts for rewards and streaks when it lasted 5+ minutes AND a match or
// drill was recorded for it (a match linked to it, or recorded during it or
// within 2 h after it ends; a drill completed in that window). The server
// judges (play_sessions.valid, supabase/migration_validity_rules.sql); the
// app decides what to say when a session ends and how to word the server's
// answer (my_session_validity). Presence never depends on any of this: an
// invalid session still shows the player at the court.
import type { PlayKind } from '../data/playSessions';

/** A session shorter than this never counts. */
export const MIN_SESSION_MS = 5 * 60_000;
/** After End, a match or drill recorded within this long still counts for the session. */
export const RECORD_WINDOW_MS = 2 * 3_600_000;

/** A session the player just ended, as the island knew it. */
export type EndedPlay = {
  id: string;
  kind: PlayKind;
  sourceId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  /** A match was already recorded from this session (the island's Enter score). */
  recorded: boolean;
};

/** What ending a session shows. */
export type EndDecision =
  /** A toast only. */
  | { show: 'note'; tone: 'info' | 'success'; message: string }
  /** "Record a match or drill?" */
  | { show: 'record'; lengthLabel: string; offerDrill: boolean; windowEndsAtMs: number };

/** "42 min", "1 h", "1 h 5 min". Under a minute reads "1 min". */
export function sessionLengthLabel(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function endDecision(s: EndedPlay): EndDecision {
  const length = s.endedAtMs - s.startedAtMs;
  if (length < MIN_SESSION_MS) {
    return { show: 'note', tone: 'info', message: "Session ended. Sessions under 5 minutes don't count." };
  }
  if (s.recorded) {
    return { show: 'note', tone: 'success', message: 'Session ended. It counts: you recorded a match.' };
  }
  return {
    show: 'record',
    lengthLabel: sessionLengthLabel(length),
    offerDrill: s.kind === 'drill',
    windowEndsAtMs: s.endedAtMs + RECORD_WINDOW_MS,
  };
}

/** The note after "Not now" on the end sheet. `timeLabel` formats in the device zone ("7:40 PM"). */
export function notNowNote(windowEndsAtMs: number, timeLabel: (d: Date) => string): string {
  return `Saved. This session counts once you record a match or drill within 2 hours (by ${timeLabel(new Date(windowEndsAtMs))}).`;
}

/** my_session_validity's answer (null: not mine, or not on the server yet). */
export type SessionValidity = {
  valid: boolean;
  reason: 'open' | 'too_short' | 'no_match_or_drill' | 'linked_match' | 'match_in_window' | 'drill_in_window';
  needs: 'minutes' | 'match_or_drill' | null;
  window_ends_at: string | null;
  rewards_pending_confirmation?: boolean;
};

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
  if (v.valid) return 'This play session counts now.';
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
