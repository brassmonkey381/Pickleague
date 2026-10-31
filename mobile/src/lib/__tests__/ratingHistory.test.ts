import { describe, it, expect } from 'vitest';
import { chartScale, nearestIndex, ratingSeries } from '../ratingHistory';

const row = (id: string, at: string, p1: string, p2: string, r1: number | null, r2: number | null, status: 'completed' | 'pending' | 'scheduled' = 'completed') => ({
  id, status, played_at: at, player1_id: p1, player2_id: p2, player1_rating_after: r1, player2_rating_after: r2,
});

describe('ratingSeries', () => {
  it('takes my rating after each completed match, oldest first', () => {
    const s = ratingSeries([
      row('b', '2026-10-02T10:00:00Z', 'x', 'me', 3.4, 3.31),
      row('a', '2026-10-01T10:00:00Z', 'me', 'x', 3.3, 3.5),
    ], 'me');
    expect(s.map((p) => [p.matchId, p.rating])).toEqual([['a', 3.3], ['b', 3.31]]);
  });

  it('skips unconfirmed matches, matches without a stored rating, and partner-only matches', () => {
    const s = ratingSeries([
      row('p', '2026-10-01T10:00:00Z', 'me', 'x', 3.3, 3.5, 'pending'),
      row('n', '2026-10-02T10:00:00Z', 'me', 'x', null, 3.5),
      row('o', '2026-10-03T10:00:00Z', 'y', 'x', 3.3, 3.5),
      row('k', '2026-10-04T10:00:00Z', 'me', 'x', 3.4, 3.5),
    ], 'me');
    expect(s.map((p) => p.matchId)).toEqual(['k']);
  });

  it('reads numeric strings (Postgres numeric) and is empty without a player', () => {
    expect(ratingSeries([row('a', '2026-10-01T10:00:00Z', 'me', 'x', '3.25' as unknown as number, 3)], 'me')[0].rating).toBe(3.25);
    expect(ratingSeries([row('a', '2026-10-01T10:00:00Z', 'me', 'x', 3, 3)], null)).toEqual([]);
  });
});

describe('chartScale', () => {
  const pts = [3.0, 3.5, 3.25].map((rating, i) => ({ matchId: String(i), at: String(i), rating }));

  it('spans the width and keeps every point inside the height', () => {
    const { xy, min, max } = chartScale(pts, 300, 100);
    expect(xy[0].x).toBe(0);
    expect(xy[2].x).toBe(300);
    expect(min).toBeLessThan(3.0);
    expect(max).toBeGreaterThan(3.5);
    for (const p of xy) { expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(100); }
    expect(xy[1].y).toBeLessThan(xy[0].y); // higher rating draws higher
  });

  it('draws a flat run as a level line in the middle', () => {
    const flat = [3.2, 3.2].map((rating, i) => ({ matchId: String(i), at: String(i), rating }));
    const { xy } = chartScale(flat, 100, 80);
    expect(xy[0].y).toBeCloseTo(40);
    expect(xy[1].y).toBeCloseTo(40);
  });
});

describe('nearestIndex', () => {
  it('finds the point closest to a tap', () => {
    expect(nearestIndex([{ x: 0 }, { x: 50 }, { x: 100 }], 70)).toBe(1);
    expect(nearestIndex([{ x: 0 }, { x: 50 }, { x: 100 }], 90)).toBe(2);
  });
});
