// PLUPR over time for one player, from the match rows Match History already
// loads. Each completed match stores the rating its player1 and player2 had
// after it (player1_rating_after / player2_rating_after). A doubles partner
// (partner1 / partner2) has no stored rating, so those matches add no point.
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
  'player1_rating_after' | 'player2_rating_after'>;

/** The player's PLUPR after each completed match they played as player 1 or 2, oldest first. */
export function ratingSeries(matches: readonly RatingRow[], uid: string | null | undefined): RatingPoint[] {
  if (!uid) return [];
  const out: RatingPoint[] = [];
  for (const m of matches) {
    if (m.status !== 'completed') continue;
    const rating = m.player1_id === uid ? m.player1_rating_after
      : m.player2_id === uid ? m.player2_rating_after
      : null;
    if (rating == null || !Number.isFinite(Number(rating))) continue;
    out.push({ matchId: m.id, at: m.played_at, rating: Number(rating) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.matchId.localeCompare(b.matchId));
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
 * the middle instead of a jagged one.
 */
export function chartScale(points: readonly RatingPoint[], width: number, height: number): ChartScale {
  if (points.length === 0) return { min: 0, max: 0, xy: [] };
  const vals = points.map((p) => p.rating);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(0.05, (hi - lo) * 0.1);
  const min = lo - pad;
  const max = hi + pad;
  const span = max - min;
  const n = points.length;
  const xy = points.map((p, i) => ({
    x: n === 1 ? width / 2 : (i / (n - 1)) * width,
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
