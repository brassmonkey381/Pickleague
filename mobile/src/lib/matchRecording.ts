// What recording a match says (pure, so vitest covers it): a score the server
// would refuse, said before it is sent; what happens next once it is stored
// (who still has to confirm, by when, or it's removed); and why a match
// recorded from a play session doesn't count for it (rule 11: every refusal
// and every "doesn't count" says why and what to do).
//
// The server stores every non-godmode match pending, with only the recorder's
// own team confirmed (a recorder who didn't play confirms neither team), due
// within the hour; supabase/migration_validity_rules.sql's insert guard. The
// 1-hour cron removes a match nobody confirmed (and tells its players why).
import { whenLabel } from './refusals';
import { RECORD_WINDOW_MS, type SessionValidity } from './sessionValidity';
import { LATE_ADD_MS } from './sessionAdds';

/**
 * matches_score_sanity_check (and tournament_matches'): the higher score is
 * 11..50 with a 2-point lead. MatchEntry stores the game score for one game
 * and the point totals for several. Null when the server will take it.
 */
export function scoreProblem(games: number, s1: number, s2: number): string | null {
  const hi = Math.max(s1, s2);
  if (hi >= 11 && Math.abs(s1 - s2) >= 2 && hi <= 50) return null;
  if (games <= 1) {
    return hi > 50
      ? "A game score can't be over 50 points. Check the score, then record it."
      : 'A game needs a winner with at least 11 points and a 2-point lead (like 11-9). Check the score, then record it.';
  }
  return hi > 50
    ? "Pickleague adds the games' points together, and one side can't have more than 50 in total. Record fewer games, or just the deciding ones."
    : "Pickleague adds the games' points together, and the winner needs at least 11 points and a 2-point lead in total. Check the scores, then record it.";
}

/** The result line once the match is stored, from what the server stored. */
export function matchRecordedNote(p: {
  /** Stored confirmed (godmode). */
  confirmed: boolean;
  /** The recorder is one of the players (their team is confirmed). */
  iPlayed: boolean;
  /** The server's confirm_deadline (null: an hour from now). */
  deadline: Date | null;
  timeLabel?: (d: Date) => string;
  nowMs?: number;
}): string {
  if (p.confirmed) return 'Match recorded and confirmed. Ratings updated.';
  const at = (d: Date) => (p.timeLabel ? p.timeLabel(d) : whenLabel(d, p.nowMs));
  const by = p.deadline ? at(p.deadline) : null;
  return p.iPlayed
    ? `Match recorded. Ratings and pickles update once the other team confirms. They have ${by ? `until ${by}` : 'an hour'}, or the match is removed.`
    : `Match recorded. Both teams need to confirm ${by ? `by ${by}` : 'within an hour'}, or the match is removed. Ratings and pickles update after that.`;
}

/** The toast when the recorder isn't one of the players: why it can't count for their session, and what would. */
export const NOT_A_PLAYER_NOTE =
  "This match doesn't count for your play session: you're not one of its players. Record a match you played in to make it count.";

/**
 * The server dropped the link to my play session (it never refuses the
 * match): why, from what the app can tell. Null when the link held, or when
 * the app can't tell (no answer: say nothing rather than guess).
 *   - the session ended more than 2 hours ago: too late to say it was played then;
 *   - the session isn't on the server: its Start is still queued (it counts
 *     once that lands, through the window), or it never got there.
 */
export function linkDroppedNote(p: {
  sentLink: boolean;
  linkedBack: string | null | undefined;
  sessionId: string;
  /** my_session_validity for that session: null = not on the server, 'unknown' = no answer. */
  validity: SessionValidity | null | 'unknown';
  /** Its Start is still waiting in the offline queue. */
  startQueued: boolean;
  nowMs: number;
}): string | null {
  if (!p.sentLink || p.linkedBack === undefined || p.linkedBack === p.sessionId) return null;
  if (p.validity === 'unknown') return null;
  if (p.validity === null) {
    return p.startQueued
      ? "Match recorded. Your play session was saved with no signal and hasn't reached Pickleague yet. The match counts for it once it does."
      : "Match recorded, but your play session never reached Pickleague, so the match can't count for it.";
  }
  // window_ends_at is the end + 2 h; the server keeps a link for 7 days after the end.
  const ends = p.validity.window_ends_at ? Date.parse(p.validity.window_ends_at) : NaN;
  if (Number.isFinite(ends) && ends - RECORD_WINDOW_MS + LATE_ADD_MS <= p.nowMs) {
    return "Match recorded, but it doesn't count for your play session: it was recorded more than 7 days after the session ended.";
  }
  return null;
}
