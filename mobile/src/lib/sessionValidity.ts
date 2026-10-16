// Which play sessions count, app side (pure, so vitest covers it).
//
// docs/play-sessions-presence.md, "Phase 1.5: validity rules": a session
// counts for rewards and streaks when it lasted 5+ minutes AND a match or
// drill was recorded for it (a match linked to it, or recorded during it or
// within 2 h after it ends; a drill held during it and completed in that
// window). The server judges (play_sessions.valid,
// supabase/migration_validity_rules.sql); the app decides what to say when a
// session ends and how to word the server's answer (my_session_validity).
// Rule 11: when something doesn't count, say why and what to do. The server
// adds the why (supabase/migration_refusal_messages.sql: started_at /
// ended_at, match_pending / confirm_by, why); times are worded in the
// device's zone. Presence never depends on any of this: an invalid session
// still shows the player at the court.
import type { PlayKind } from '../data/playSessions';
import { whenLabel } from './refusals';

/** A session shorter than this never counts. */
export const MIN_SESSION_MS = 5 * 60_000;
/** After End, a match or drill recorded within this long still counts for the session. */
export const RECORD_WINDOW_MS = 2 * 3_600_000;
/** End waits at most this long for the server's word before asking for a match or drill. */
export const END_CHECK_MS = 2_000;

/**
 * What this device already knows makes a session count (lib/playSession
 * notes it). 'match_pending': a match waiting for the other team (every
 * non-godmode match is, for up to an hour); 'match_confirmed': stored
 * confirmed. 'match' is from a build before 2026-10-16 and reads as pending.
 */
export type RecordedForSession = 'match' | 'match_pending' | 'match_confirmed' | 'drill' | null;

/** Why the island's session turned out to be over on the server. */
export type LostPlayReason = 'auto_ended' | 'ended_elsewhere' | 'never_saved';

/** A session the player just ended, as the island knew it. */
export type EndedPlay = {
  id: string;
  kind: PlayKind;
  sourceId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  /**
   * A match I played in was recorded while it ran (pending or confirmed), or
   * the server said it counts right after I reviewed a drill. null: nothing
   * known here (End then asks the server).
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
   * the copy must not claim nothing was recorded. `why`: something the player
   * recorded went elsewhere (the server's word, in a sentence).
   */
  | {
      show: 'record';
      lengthLabel: string;
      lengthMs: number;
      offerDrill: boolean;
      windowEndsAtMs: number;
      unsure?: boolean;
      why?: string;
    };

/** Decision 3 (2026-10-16), verbatim: the End toast while the match is pending. */
export const PENDING_END_NOTE = 'Session ended. It counts once the other team confirms (within the hour).';
const CONFIRMED_END_NOTE = 'Session ended. It counts: you recorded a match.';
const DRILL_END_NOTE = 'Session ended. It counts: you reviewed a drill held during it.';

/** "42 min", "1 h", "1 h 5 min". Under a minute reads "1 min". */
export function sessionLengthLabel(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const isMatch = (r: RecordedForSession) => r === 'match' || r === 'match_pending' || r === 'match_confirmed';

function tooShortNote(lengthMs: number, recorded: RecordedForSession): string {
  const base = `Session ended after ${sessionLengthLabel(lengthMs)}. Sessions under 5 minutes don't count.`;
  return isMatch(recorded) ? `${base} Your match is still recorded.` : base;
}

/** What End shows from what this device knows (endDecisionWithServer adds the server's word). */
export function endDecision(s: EndedPlay): EndDecision {
  const length = s.endedAtMs - s.startedAtMs;
  if (length < MIN_SESSION_MS) return { show: 'note', tone: 'info', message: tooShortNote(length, s.recorded) };
  if (s.recorded === 'match_confirmed') return { show: 'note', tone: 'success', message: CONFIRMED_END_NOTE };
  // Pending until the other team confirms; it stops counting if nobody does.
  if (isMatch(s.recorded)) return { show: 'note', tone: 'success', message: PENDING_END_NOTE };
  if (s.recorded === 'drill') return { show: 'note', tone: 'success', message: DRILL_END_NOTE };
  return {
    show: 'record',
    lengthLabel: sessionLengthLabel(length),
    lengthMs: length,
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
  // Added by migration_refusal_messages.sql (absent from an older server):
  /** The stored start and end (a Start the no-overlap rule moved shows here). */
  started_at?: string;
  ended_at?: string | null;
  /** It counts only through a match still waiting for the other team (open sessions too). */
  match_pending?: boolean;
  /** The earliest confirm deadline of those matches. */
  confirm_by?: string;
  /** Nothing counts yet, but the player recorded something that went elsewhere. */
  why?: 'match_counted_elsewhere' | 'drill_not_during_session';
  match_at?: string;
  counted_for_started_at?: string;
  drill_starts_at?: string;
};

/** The server's word at End: its answer, null (session not on the server), or 'unknown' (timed out / failed). */
export type ServerAnswer = SessionValidity | null | 'unknown';

type Fmt = { timeLabel?: (d: Date) => string; nowMs?: number };
const fmt = (o: Fmt) => (d: Date) => (o.timeLabel ? o.timeLabel(d) : whenLabel(d, o.nowMs));
const dateOf = (s: string | null | undefined): Date | null => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
};

/** It counts through a match the other team hasn't confirmed yet. */
function isPending(v: SessionValidity): boolean {
  return (v.valid && !!v.rewards_pending_confirmation) || !!v.match_pending;
}

/** The server's stored length, when it said (null: an older server). */
function serverLengthMs(v: SessionValidity): number | null {
  const s = dateOf(v.started_at);
  const e = dateOf(v.ended_at);
  return s && e ? e.getTime() - s.getTime() : null;
}

/** Why something the player recorded doesn't count for this session, in a sentence (null: nothing to say). */
export function whyNotCounted(v: SessionValidity, o: Fmt = {}): string | null {
  const at = fmt(o);
  if (v.why === 'match_counted_elsewhere') {
    const m = dateOf(v.match_at);
    const other = dateOf(v.counted_for_started_at);
    return `The match recorded${m ? ` at ${at(m)}` : ''} counts for your ${other ? `session from ${at(other)}` : 'other session'}, and a match counts for one session only.`;
  }
  if (v.why === 'drill_not_during_session') {
    const d = dateOf(v.drill_starts_at);
    return d
      ? `Your drill review doesn't count for it: that drill was scheduled for ${at(d)}, not during this session.`
      : "Your drill review doesn't count for it: that drill wasn't held during this session.";
  }
  return null;
}

/**
 * End, with the server's word. The server may already count the session: a
 * match a partner or opponent recorded, one I entered without the link, a
 * drill I reviewed, or anything from before an app restart. Asking for a
 * match then would invite a duplicate, so:
 *   - it counts (ended and valid, or still open on the server, its End on the
 *     way, with nothing more needed): a success toast, pending while the
 *     other team hasn't confirmed (decision 3);
 *   - too short by the server's clock: the too-short toast, and when the
 *     server moved its start (it overlapped an earlier one), that reason;
 *   - it needs a match or drill: the sheet, with why something recorded
 *     didn't count when the server says;
 *   - no answer (offline, slow, not on the server yet): the sheet, hedged.
 * A local decision that is already a toast stands.
 */
export function endDecisionWithServer(local: EndDecision, v: ServerAnswer, o: Fmt = {}): EndDecision {
  if (local.show === 'note') return local;
  if (v === null || v === 'unknown') return { ...local, unsure: true };
  if (v.valid || (v.reason === 'open' && v.needs === null)) {
    const message = isPending(v)
      ? PENDING_END_NOTE
      : v.reason === 'drill_in_window'
        ? DRILL_END_NOTE
        : v.reason === 'open'
          ? 'Session ended. It counts: a match or drill you played is recorded.'
          : 'Session ended. It counts: a match you played in is recorded.';
    return { show: 'note', tone: 'success', message };
  }
  if (v.reason === 'too_short' || v.needs === 'minutes') {
    // This device timed 5+ minutes (a shorter one never gets here), so the
    // server moved its start: it overlapped an earlier session of mine.
    const server = serverLengthMs(v);
    const counted = server != null && server < MIN_SESSION_MS ? `only ${sessionLengthLabel(server)}` : 'under 5 minutes';
    return {
      show: 'note',
      tone: 'info',
      message: `Session ended. Pickleague counted ${counted} of it because it overlapped your previous session. Sessions under 5 minutes don't count.`,
    };
  }
  const why = whyNotCounted(v, o);
  return why ? { ...local, why } : local;
}

/** The end sheet's line: why it doesn't count yet, and by when to fix that (device zone). */
export function endSheetBody(ask: Extract<EndDecision, { show: 'record' }>, o: Fmt = {}): string {
  const by = fmt(o)(new Date(ask.windowEndsAtMs));
  const head = `Session ended after ${ask.lengthLabel}.`;
  if (ask.unsure) {
    return `${head} If you haven't recorded what you played yet, record a match or drill by ${by} and this session counts.`;
  }
  if (ask.why) return `${head} ${ask.why} Record another match or drill by ${by} to make this one count.`;
  return `${head} It doesn't count yet: no match or drill is recorded for it. Record one by ${by}.`;
}

/** The note after "Not now" on the end sheet. `timeLabel` formats in the device zone ("7:40 PM"). */
export function notNowNote(windowEndsAtMs: number, timeLabel: (d: Date) => string, unsure = false): string {
  const by = timeLabel(new Date(windowEndsAtMs));
  return unsure
    ? `Saved. If nothing's recorded yet, it counts once you record a match or drill by ${by}.`
    : `Saved. It counts if you record a match or drill by ${by}.`;
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

/** "by 6:40 PM" from confirm_by, else "within the hour". */
function confirmBy(v: SessionValidity, o: Fmt): string {
  const d = dateOf(v.confirm_by);
  return d ? `by ${fmt(o)(d)}` : 'within the hour';
}

/**
 * One line for the player about a session the server judged (after a match
 * is recorded for it), or null when there is nothing to say (no answer).
 */
export function validityNote(
  v: SessionValidity | null | undefined,
  nowMs: number,
  timeLabel: (d: Date) => string,
): string | null {
  if (!v) return null;
  const o: Fmt = { timeLabel, nowMs };
  if (v.reason === 'open') {
    if (v.needs === 'minutes') return 'Your match is recorded. It counts for your play session once the session has run 5 minutes.';
    if (v.needs === null) {
      return isPending(v)
        ? `Your play session counts once the other team confirms this match, ${confirmBy(v, o)}.`
        : 'Your play session counts now.';
    }
    return null;
  }
  if (v.valid) {
    // Recorded is enough to count, but an unconfirmed match is deleted after
    // an hour (expire_pending_matches), and the session stops counting.
    return isPending(v)
      ? `This play session counts once the other team confirms this match, ${confirmBy(v, o)}.`
      : 'This play session counts now.';
  }
  if (v.needs === 'minutes' || v.reason === 'too_short') {
    const len = serverLengthMs(v);
    return len != null
      ? `Sessions under 5 minutes don't count. This one lasted ${sessionLengthLabel(len)}.`
      : "Sessions under 5 minutes don't count.";
  }
  const ends = v.window_ends_at ? Date.parse(v.window_ends_at) : NaN;
  if (Number.isFinite(ends) && ends > nowMs) {
    const why = whyNotCounted(v, o);
    const ask = `This session counts once you record a match or drill by ${timeLabel(new Date(ends))}.`;
    return why ? `${why} ${ask}` : ask;
  }
  return "This session didn't count: no match or drill was recorded within 2 hours of its end.";
}

/** After a drill review: whether my running or just-ended session counts now, or why the drill doesn't. */
export function drillReviewNote(v: SessionValidity | null | undefined, o: Fmt & { running?: boolean } = {}): string | null {
  if (!v) return null;
  if (v.valid || (v.reason === 'open' && v.needs === null)) {
    return v.reason === 'drill_in_window' || v.reason === 'open'
      ? 'Your play session counts now: you reviewed a drill held during it.'
      : null; // it already counted through a match: nothing new to say
  }
  if (v.why === 'drill_not_during_session') {
    const d = dateOf(v.drill_starts_at);
    return d
      ? `This drill doesn't count for your play session: it was scheduled for ${fmt(o)(d)}, not during the session.`
      : "This drill doesn't count for your play session: it wasn't held during the session.";
  }
  if (v.needs === 'minutes') return o.running ? null : "Your play session was under 5 minutes, so it doesn't count.";
  return null;
}

/** Why the island's session is gone, and what to do (PlayIsland says it once). */
export function lostPlayNote(
  p: { reason: LostPlayReason; startedAtMs: number; endedAtMs: number | null },
  o: Fmt = {},
): string {
  const at = fmt(o);
  const now = o.nowMs ?? Date.now();
  const start = at(new Date(p.startedAtMs));
  switch (p.reason) {
    case 'auto_ended': {
      const end = p.endedAtMs ?? p.startedAtMs + 6 * 3_600_000;
      const by = end + RECORD_WINDOW_MS;
      return by > now
        ? `Your play session ended on its own after 6 hours, at ${at(new Date(end))}. If you played, record a match or drill by ${at(new Date(by))} so it counts.`
        : `Your play session from ${start} ended on its own after 6 hours, at ${at(new Date(end))}.`;
    }
    case 'ended_elsewhere':
      return `Your play session from ${start} ended${p.endedAtMs ? ` at ${at(new Date(p.endedAtMs))}` : ''}, on another device or when you started a new one.`;
    case 'never_saved':
      return `Your play session from ${start} never reached Pickleague, so it isn't saved and won't count. Start a new one when you play.`;
  }
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
