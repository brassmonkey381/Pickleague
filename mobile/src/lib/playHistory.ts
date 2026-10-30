// Play history (Me › Play history, PKL-011): how each ended session reads.
// Pure; the rows come from data/playSessions (list_my_play_sessions).
//   title  "Lakeside · Open play" (no court: the kind alone)
//   when   "Today · 6:10 PM–8:05 PM · 1h 55m", "Yesterday · …", "Oct 27 · …"
//   status "Counts", "Counts once confirmed", "Didn't count" (with why), and
//          "2 matches"
import { calendarDayDiff, shortTime } from './agenda';
import { playedFor } from './playStartRules';
import type { PlayKind } from '../data/playSessions';

/** One ended session of mine in the history (list_my_play_sessions). */
export type PlayHistoryRow = {
  id: string;
  kind: PlayKind;
  venueId: string | null;
  venueName: string | null;
  startedAt: string;
  endedAt: string;
  valid: boolean;
  /** 'linked_match' | 'too_short' | ...; null when it was never judged. */
  validReason: string | null;
  atCourt: boolean;
  rewardsPending: boolean;
  matchCount: number;
};

/** A history page from the server, newest first. */
export const PLAY_HISTORY_PAGE = 30;

/** Rows as the RPC sends them, fields missing or null taken as nothing said. */
export function parsePlayHistory(data: unknown): PlayHistoryRow[] {
  if (!Array.isArray(data)) return [];
  const out: PlayHistoryRow[] = [];
  for (const r of data as Record<string, unknown>[]) {
    if (!r || typeof r.session_id !== 'string' || typeof r.started_at !== 'string' || typeof r.ended_at !== 'string') continue;
    out.push({
      id: r.session_id,
      kind: (typeof r.kind === 'string' ? r.kind : 'open_play') as PlayKind,
      venueId: typeof r.venue_id === 'string' ? r.venue_id : null,
      venueName: typeof r.venue_name === 'string' ? r.venue_name : null,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      valid: r.valid === true,
      validReason: typeof r.valid_reason === 'string' ? r.valid_reason : null,
      atCourt: r.at_court === true,
      rewardsPending: r.rewards_pending === true,
      matchCount: typeof r.match_count === 'number' ? r.match_count : 0,
    });
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const PLAY_KIND_LABEL: Record<PlayKind, string> = {
  open_play: 'Open play',
  drill: 'Drill',
  match: 'Match',
  event: 'League event',
  tournament: 'Tournament',
};

/** "Lakeside · Open play", or "Open play" without a court. */
export function playHistoryTitle(r: Pick<PlayHistoryRow, 'kind' | 'venueName'>): string {
  const kind = PLAY_KIND_LABEL[r.kind] ?? 'Play';
  return r.venueName ? `${r.venueName} · ${kind}` : kind;
}

/** "Today", "Yesterday", "Oct 27" (an earlier year: "Oct 27, 2025"). */
export function playHistoryDay(d: Date, now: Date): string {
  const diff = calendarDayDiff(d, now);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day}, ${d.getFullYear()}`;
}

/** "Today · 6:10 PM–8:05 PM · 1h 55m". */
export function playHistoryWhen(r: Pick<PlayHistoryRow, 'startedAt' | 'endedAt'>, nowMs: number): string {
  const start = new Date(r.startedAt);
  const end = new Date(r.endedAt);
  return `${playHistoryDay(start, new Date(nowMs))} · ${shortTime(start)}–${shortTime(end)} · ${playedFor(end.getTime() - start.getTime())}`;
}

export type PlayHistoryStatus = { label: string; tone: 'success' | 'warning' | 'neutral'; note: string | null };

/** Whether it counts, as the server stored it (play_sessions.valid: 5+ minutes and a match or drill). */
export function playHistoryStatus(
  r: Pick<PlayHistoryRow, 'valid' | 'validReason' | 'rewardsPending'>,
): PlayHistoryStatus {
  if (r.valid && r.rewardsPending) {
    return { label: 'Counts once confirmed', tone: 'warning', note: 'The other team still has to confirm the match.' };
  }
  if (r.valid) return { label: 'Counts', tone: 'success', note: null };
  switch (r.validReason) {
    case 'too_short':
      return { label: "Didn't count", tone: 'neutral', note: 'It lasted under 5 minutes.' };
    case 'no_match_or_drill':
      return { label: "Didn't count", tone: 'neutral', note: 'No match or drill was recorded for it.' };
    default:
      return { label: "Didn't count", tone: 'neutral', note: null };
  }
}

/** "1 match", "2 matches"; '' for none. */
export function matchCountLabel(n: number): string {
  if (!n || n < 0) return '';
  return n === 1 ? '1 match' : `${n} matches`;
}

/** The next page's cursor: the oldest row's start, or null when the page wasn't full (no more). */
export function nextHistoryCursor(page: readonly Pick<PlayHistoryRow, 'startedAt'>[], pageSize: number): string | null {
  return page.length >= pageSize ? page[page.length - 1].startedAt : null;
}

/** Pages joined, a row seen twice (a retried page) kept once, newest first. */
export function mergeHistory(a: readonly PlayHistoryRow[], b: readonly PlayHistoryRow[]): PlayHistoryRow[] {
  const seen = new Set<string>();
  const out: PlayHistoryRow[] = [];
  for (const r of [...a, ...b]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((x, y) => y.startedAt.localeCompare(x.startedAt));
}
