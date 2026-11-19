// PLUPR over time for one player, from the match rows Match History already
// loads. Each completed match stores the rating its player1 and player2 had
// after it (player1_rating_after / player2_rating_after). A tournament row
// (PKL-035) carries plupr_ratings with every player's move, partners included
// (PKL-051: the chart used to skip the tournament matches a viewer played as a
// partner). A league doubles match stores no rating for partner1 / partner2,
// so those add no point; unratedCount says how many, so the chart can say why.
import type { Match } from '../types';

export type RatingPoint = {
  matchId: string;
  /** played_at, ISO. */
  at: string;
  /** PLUPR after the match. */
  rating: number;
};

type RatingRow = Pick<Match,
  'id' | 'status' | 'played_at' | 'player1_id' | 'player2_id' |
  'player1_rating_after' | 'player2_rating_after'> & {
  partner1_id?: string | null;
  partner2_id?: string | null;
  /** Tournament rows: every player's PLUPR around the match. */
  plupr_ratings?: Record<string, { after?: number | string | null } | undefined> | null;
};

/** The player's PLUPR after one completed match, or null when none is stored for them. */
function ratingAfter(m: RatingRow, uid: string): number | null {
  const raw = m.plupr_ratings
    ? m.plupr_ratings[uid]?.after
    : m.player1_id === uid ? m.player1_rating_after
    : m.player2_id === uid ? m.player2_rating_after
    : null;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const playedIn = (m: RatingRow, uid: string) =>
  m.player1_id === uid || m.player2_id === uid || m.partner1_id === uid || m.partner2_id === uid;

/** The player's PLUPR after each completed match with a stored rating for them, oldest first. */
export function ratingSeries(matches: readonly RatingRow[], uid: string | null | undefined): RatingPoint[] {
  if (!uid) return [];
  const out: RatingPoint[] = [];
  for (const m of matches) {
    if (m.status !== 'completed') continue;
    const rating = ratingAfter(m, uid);
    if (rating == null) continue;
    out.push({ matchId: m.id, at: m.played_at, rating });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.matchId.localeCompare(b.matchId));
}

/** Completed matches the player played with no stored rating for them (league doubles as a partner, or older rows). */
export function unratedCount(matches: readonly RatingRow[], uid: string | null | undefined): number {
  if (!uid) return 0;
  return matches.filter((m) => m.status === 'completed' && playedIn(m, uid) && ratingAfter(m, uid) == null).length;
}

export type ChartScale = {
  /** Bottom and top of the y range, padded so the line never touches the edges. */
  min: number;
  max: number;
  /** x (0..width) and y (0..height, 0 at the top) for each point. */
  xy: { x: number; y: number }[];
};

/**
 * Lay the series out in a width x height box. The y range covers the data
 * plus 10% (at least 0.05 each side), so a flat run draws as a level line in
 * the middle instead of a jagged one. With a time range (a "Last 7 days"
 * filter) x is the match's time within it, so the axis spans the whole range;
 * without one the points are evenly spaced.
 */
export function chartScale(points: readonly RatingPoint[], width: number, height: number,
  range?: { start: number; end: number } | null): ChartScale {
  if (points.length === 0) return { min: 0, max: 0, xy: [] };
  const vals = points.map((p) => p.rating);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(0.05, (hi - lo) * 0.1);
  const min = lo - pad;
  const max = hi + pad;
  const span = max - min;
  const n = points.length;
  const tSpan = range ? range.end - range.start : 0;
  const xy = points.map((p, i) => ({
    x: range && tSpan > 0
      ? Math.min(1, Math.max(0, (new Date(p.at).getTime() - range.start) / tSpan)) * width
      : n === 1 ? width / 2 : (i / (n - 1)) * width,
    y: height - ((p.rating - min) / span) * height,
  }));
  return { min, max, xy };
}

/** Index of the point nearest x (for a tap on the chart). */
export function nearestIndex(xy: readonly { x: number }[], x: number): number {
  let best = 0;
  for (let i = 1; i < xy.length; i++) {
    if (Math.abs(xy[i].x - x) < Math.abs(xy[best].x - x)) best = i;
  }
  return best;
}
