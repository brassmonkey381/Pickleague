import { describe, it, expect } from 'vitest';
import {
  computePeriodDate, periodStartDate, computeStandings, bonusForRank,
  findLivePeriod, nextLockPeriod, isLockDue, seasonHeaderLine, formatPluprChange,
  computeMedianFinals, periodStartPlupr,
} from '../standingsModel';

const season = {
  start_date: '2026-09-01',
  lock_frequency_weeks: 1,
  total_periods: 12,
  status: 'active' as const,
};
const fmtDay = (iso: string) => iso.slice(5); // "MM-DD": locale-free

describe('period dates', () => {
  it('period N ends N lock-intervals after the start; period N+1 starts the next day', () => {
    expect(computePeriodDate(season, 1)).toBe('2026-09-08');
    expect(periodStartDate(season, 1)).toBe('2026-09-01');
    expect(periodStartDate(season, 2)).toBe('2026-09-09');
  });
});

describe('computeStandings', () => {
  const members = [
    { user_id: 'a', profile: { full_name: 'A' } },
    { user_id: 'b', profile: { full_name: 'B' } },
  ];
  it('counts each game of a multi-game match and sums PLUPR deltas from the baseline', () => {
    const matches = [{
      player1_id: 'a', player2_id: 'b', winner_team: 'team1', played_at: '2026-09-02T10:00:00',
      game_scores: [{ t1: 11, t2: 5 }, { t1: 8, t2: 11 }, { t1: 11, t2: 9 }],
      player1_rating_before: 3.5, player1_rating_after: 3.6,
      player2_rating_before: 3.5, player2_rating_after: 3.4,
    }];
    const rows = computeStandings(members, matches, 3.5);
    expect(rows.map(r => r.user_id)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ wins: 2, losses: 1 });
    expect(rows[0].rating).toBeCloseTo(3.6);
    expect(rows[1]).toMatchObject({ wins: 1, losses: 2 });
  });
  it('never names a missing profile "Unknown"', () => {
    const rows = computeStandings([{ user_id: 'x' }], [], 3.5);
    expect(rows[0].full_name).toBe('');
  });
});

describe('finals', () => {
  it('ranks by median rank and adds the rank bonus to the baseline', () => {
    const p = (n: number, order: string[]) => ({
      periodNumber: n, date: '', locked: true,
      rows: order.map((u, i) => ({ user_id: u, rank_at_snapshot: i + 1 } as any)),
    });
    const finals = computeMedianFinals([p(1, ['a', 'b']), p(2, ['b', 'a']), p(3, ['a', 'b'])], [], 'l', 's', 3.5);
    expect(finals.map(f => f.user_id)).toEqual(['a', 'b']);
    expect(finals[0].new_elo).toBeCloseTo(3.5 + bonusForRank(1));
    expect(bonusForRank(6)).toBe(0);
  });
});

describe('live period + lock', () => {
  it('the live period is the first unlocked one whose window has not ended', () => {
    expect(findLivePeriod(season, new Set(), '2026-09-02')).toBe(1);
    expect(findLivePeriod(season, new Set([1]), '2026-09-02')).toBe(2);
    expect(findLivePeriod(season, new Set(), '2026-09-10')).toBe(2);
    expect(findLivePeriod({ ...season, status: 'completed' }, new Set(), '2026-09-02')).toBeNull();
  });
  it('the next lock follows the highest locked period, and is due on its snapshot date', () => {
    expect(nextLockPeriod(new Set())).toBe(1);
    expect(nextLockPeriod(new Set([1, 2]))).toBe(3);
    expect(isLockDue(season, 1, new Date('2026-09-07T12:00:00'))).toBe(false);
    expect(isLockDue(season, 1, new Date('2026-09-08T12:00:00'))).toBe(true);
    expect(isLockDue(season, 13, new Date('2027-01-01T12:00:00'))).toBe(false);
  });
});

describe('seasonHeaderLine', () => {
  const base = { season, nextPeriod: 1, lockDue: false, todayIso: '2026-09-02', fmtDay };
  it('reads "P1 of 12 · locks <date>" mid-period', () => {
    expect(seasonHeaderLine({ ...base, livePeriod: 1 })).toBe('P1 of 12 · locks 09-08');
  });
  it('says a lock is due instead of a date that has passed', () => {
    expect(seasonHeaderLine({ ...base, livePeriod: 2, nextPeriod: 1, lockDue: true })).toBe('P1 of 12 · lock due');
  });
  it('covers upcoming and completed seasons without TBD', () => {
    expect(seasonHeaderLine({ ...base, livePeriod: null, todayIso: '2026-08-01' })).toBe('Starts 09-01 · 12 periods');
    expect(seasonHeaderLine({ ...base, livePeriod: null, season: { ...season, status: 'completed' } })).toBe('Completed · 12 periods');
  });
});

describe('formatPluprChange', () => {
  it('signs the delta and hides a zero change', () => {
    expect(formatPluprChange(0.123)).toBe('+0.12');
    expect(formatPluprChange(-0.05)).toBe('−0.05');
    expect(formatPluprChange(0.001)).toBe('');
  });
});

describe('periodStartPlupr (the change column)', () => {
  const p1 = {
    periodNumber: 1, date: '', locked: true,
    rows: [{ user_id: 'champ', rank_at_snapshot: 1 } as any, { user_id: 'b', rank_at_snapshot: 2 } as any],
  };
  const live = (rating: number) => {
    const p2 = { periodNumber: 2, locked: false };
    return formatPluprChange(rating - periodStartPlupr({ period: p2, prevPeriod: p1, userId: 'champ', baseline: 3.5 }));
  };
  it("a computed period measures from the flat baseline: P1's #1 with no P2 matches shows no change", () => {
    // computeStandings never adds the carried bonus, so neither may the start.
    const [champ] = computeStandings([{ user_id: 'champ' }], [], 3.5);
    expect(live(champ.rating)).toBe('');
    expect(live(3.6)).toBe('+0.10');
  });
  it('a locked period opens at baseline + the previous lock\'s rank bonus', () => {
    const p2 = { periodNumber: 2, locked: true };
    expect(periodStartPlupr({ period: p2, prevPeriod: p1, userId: 'champ', baseline: 3.5 })).toBeCloseTo(3.7);
    expect(periodStartPlupr({ period: p2, prevPeriod: p1, userId: 'nobody', baseline: 3.5 })).toBe(3.5);
    expect(periodStartPlupr({ period: { periodNumber: 1, locked: true }, prevPeriod: undefined, userId: 'champ', baseline: 3.5 })).toBe(3.5);
  });
});
