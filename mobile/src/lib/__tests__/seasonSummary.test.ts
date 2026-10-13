import { describe, it, expect } from 'vitest';
import {
  addDaysIso,
  computeSeasonStandings,
  daysBetween,
  livePeriodNumber,
  nextUnlockedPeriod,
  periodEndDate,
  periodStartDate,
  periodWindow,
  seasonHeadline,
  seasonWeek,
  standingsTargetSeasonId,
  summarizeSeason,
  type SeasonInput,
  type StandingsMatch,
  type StandingsMember,
} from '../seasonSummary';

// 12 weeks from Mon Aug 31 2026, a lock every 2 weeks -> 6 periods.
const SEASON: SeasonInput = {
  name: 'Fall',
  start_date: '2026-08-31',
  end_date: '2026-11-23',
  total_weeks: 12,
  lock_frequency_weeks: 2,
  total_periods: 6,
  status: 'active',
  baseline_plupr: 3.5,
};

const fmt = (iso: string) => `<${iso}>`;
const none = new Set<number>();

const members: StandingsMember[] = [
  { user_id: 'a', profile: { full_name: 'Alice' } },
  { user_id: 'b', profile: { full_name: 'Bob' } },
  { user_id: 'c', profile: { full_name: 'Cara' } },
  { user_id: 'd', profile: { full_name: 'Dev' } },
  { user_id: 'me', profile: { full_name: 'Me' } },
];

function singles(p1: string, p2: string, winner: 'team1' | 'team2', at: string, d1 = 0.1, d2 = -0.1): StandingsMatch {
  return {
    player1_id: p1, partner1_id: null, player2_id: p2, partner2_id: null,
    winner_team: winner, played_at: at, game_scores: null,
    player1_rating_before: 3.5, player1_rating_after: 3.5 + d1,
    player2_rating_before: 3.5, player2_rating_after: 3.5 + d2,
  };
}

describe('date helpers', () => {
  it('adds days across a DST change without slipping a day', () => {
    expect(addDaysIso('2026-10-31', 7)).toBe('2026-11-07');
    expect(daysBetween('2026-10-31', '2026-11-07')).toBe(7);
    expect(daysBetween('2026-11-07', '2026-10-31')).toBe(-7);
  });

  it('period dates match SeasonStandings (lock = start + n x cadence, next period starts the day after)', () => {
    expect(periodEndDate(SEASON, 1)).toBe('2026-09-14');
    expect(periodStartDate(SEASON, 1)).toBe('2026-08-31');
    expect(periodStartDate(SEASON, 2)).toBe('2026-09-15');
    expect(periodEndDate(SEASON, 6)).toBe('2026-11-23');
  });

  it('season week is 1-based, clamped, and null before the start', () => {
    expect(seasonWeek(SEASON, '2026-08-30')).toBeNull();
    expect(seasonWeek(SEASON, '2026-08-31')).toBe(1);
    expect(seasonWeek(SEASON, '2026-09-06')).toBe(1);
    expect(seasonWeek(SEASON, '2026-09-07')).toBe(2);
    expect(seasonWeek(SEASON, '2026-10-13')).toBe(7);
    expect(seasonWeek(SEASON, '2027-02-01')).toBe(12);
  });
});

describe('live period', () => {
  it('is the first unlocked period whose lock date has not passed', () => {
    expect(livePeriodNumber(SEASON, none, '2026-09-01')).toBe(1);
    expect(livePeriodNumber(SEASON, new Set([1, 2]), '2026-10-13')).toBe(4); // P3 ended Oct 12
  });

  it('falls back to the LAST period when every unlocked one is overdue (SeasonStandings\' default tab), and null once all are locked', () => {
    expect(livePeriodNumber(SEASON, new Set([1, 2, 3, 4, 5]), '2026-12-01')).toBe(6);
    // P3 and P4 unlocked and both overdue: the screen opens on P6, not P3.
    expect(livePeriodNumber(SEASON, new Set([1, 2]), '2026-12-01')).toBe(6);
    expect(livePeriodNumber(SEASON, new Set([1, 2, 3, 4, 5, 6]), '2026-12-01')).toBeNull();
  });

  it('the next lock is the lowest unlocked period', () => {
    expect(nextUnlockedPeriod(SEASON, new Set([1, 3]))).toBe(2);
    expect(nextUnlockedPeriod(SEASON, new Set([1, 2, 3, 4, 5, 6]))).toBeNull();
  });

  it("windows the live period to today, like SeasonStandings' live tab", () => {
    expect(periodWindow(SEASON, 4, '2026-10-13')).toEqual({ start: '2026-10-13', end: '2026-10-13T23:59:59' });
    expect(periodWindow(SEASON, 1, '2026-10-13')).toEqual({ start: '2026-08-31', end: '2026-09-14T23:59:59' });
  });
});

describe('computeSeasonStandings', () => {
  it('ranks by season PLUPR, then W-L, then W, and counts each game of a multi-game match', () => {
    const matches: StandingsMatch[] = [
      singles('a', 'b', 'team1', '2026-09-01T18:00:00+00:00', 0.2, -0.2),
      {
        ...singles('c', 'd', 'team1', '2026-09-02T18:00:00+00:00', 0, 0),
        game_scores: [{ t1: 11, t2: 5 }, { t1: 8, t2: 11 }, { t1: 11, t2: 9 }],
      },
    ];
    const rows = computeSeasonStandings(members, matches, 3.5);
    expect(rows.map((r) => r.user_id)).toEqual(['a', 'c', 'me', 'd', 'b']);
    expect(rows[0]).toMatchObject({ rating: 3.7, wins: 1, losses: 0, rank: 1 });
    expect(rows.find((r) => r.user_id === 'c')).toMatchObject({ wins: 2, losses: 1 });
    expect(rows.find((r) => r.user_id === 'd')).toMatchObject({ wins: 1, losses: 2 });
  });

  it('partners share the nominal player delta and the window is inclusive', () => {
    const m: StandingsMatch = {
      ...singles('a', 'b', 'team2', '2026-09-14T23:59:59', -0.1, 0.3),
      partner1_id: 'c', partner2_id: 'me',
    };
    const rows = computeSeasonStandings(members, [m], 3.5, '2026-08-31', '2026-09-14T23:59:59');
    expect(rows.find((r) => r.user_id === 'me')).toMatchObject({ rating: 3.8, wins: 1 });
    expect(rows.find((r) => r.user_id === 'c')).toMatchObject({ losses: 1 });
    expect(computeSeasonStandings(members, [m], 3.5, '2026-09-15')[0].wins).toBe(0);
  });
});

describe('summarizeSeason + headline', () => {
  const today = '2026-10-13'; // week 7, live period 4 (Oct 13 - Oct 26)

  it('builds "Fall · Wk 7 of 12 · You #2 · locks <date>" with the top 3', () => {
    const s = summarizeSeason({
      season: SEASON,
      lockedPeriods: [1, 2, 3],
      members,
      matches: [
        singles('a', 'me', 'team1', '2026-10-13T17:00:00+00:00', 0.3, -0.05),
        singles('me', 'b', 'team1', '2026-10-13T18:00:00+00:00', 0.1, -0.2),
        singles('c', 'd', 'team1', '2026-09-01T18:00:00+00:00', 0.9, -0.9), // outside the window
      ],
      myUserId: 'me',
      today,
    });
    expect(s).toMatchObject({ phase: 'active', week: 7, period: 4, nextLockOn: '2026-10-26', lockDue: false, hasMatches: true, myRank: 2 });
    expect(s.top.map((r) => r.user_id)).toEqual(['a', 'me', 'c']);
    expect(s.me).toBeNull(); // already in the top 3
    expect(seasonHeadline(s, fmt)).toBe('Fall · Wk 7 of 12 · You #2 · locks <2026-10-26>');
  });

  it('adds your row under the top 3 when you rank lower', () => {
    const s = summarizeSeason({
      season: SEASON,
      lockedPeriods: [1, 2, 3],
      members,
      matches: [
        singles('a', 'me', 'team1', '2026-10-13T17:00:00+00:00', 0.3, -0.3),
        singles('b', 'c', 'team1', '2026-10-13T18:00:00+00:00', 0.2, -0.1),
      ],
      myUserId: 'me',
      today,
    });
    expect(s.top.map((r) => r.user_id)).toEqual(['a', 'b', 'd']);
    expect(s.me).toMatchObject({ user_id: 'me', rank: 5 });
  });

  it('shows no ranks before the first match of the period, and no "You" for a non-member', () => {
    const s = summarizeSeason({ season: SEASON, lockedPeriods: [1, 2, 3], members, matches: [], myUserId: 'me', today });
    expect(s).toMatchObject({ hasMatches: false, myRank: null, top: [], me: null });
    expect(seasonHeadline(s, fmt)).toBe('Fall · Wk 7 of 12 · locks <2026-10-26>');

    const stranger = summarizeSeason({
      season: SEASON, lockedPeriods: [1, 2, 3], members,
      matches: [singles('a', 'b', 'team1', '2026-10-13T17:00:00+00:00')],
      myUserId: 'zz', today,
    });
    expect(stranger.myRank).toBeNull();
    expect(stranger.me).toBeNull();
    expect(stranger.top).toHaveLength(3);
  });

  it('says "Lock due" once the next lock date has passed unlocked', () => {
    const s = summarizeSeason({ season: SEASON, lockedPeriods: [1, 2], members, matches: [], myUserId: 'me', today });
    expect(s.lockDue).toBe(true);
    expect(s.nextLockOn).toBe('2026-10-12');
    expect(seasonHeadline(s, fmt)).toBe('Fall · Wk 7 of 12 · Lock due');
  });

  it('a lock is due ON its snapshot date (local), the day SeasonStandings enables Lock', () => {
    // Next lock is period 4 on Oct 26; the windows still use the UTC `today`.
    const at = (lockToday: string) => summarizeSeason({
      season: SEASON, lockedPeriods: [1, 2, 3], members, matches: [], myUserId: 'me', today, lockToday,
    });
    expect(at('2026-10-26').lockDue).toBe(true);
    expect(seasonHeadline(at('2026-10-26'), fmt)).toBe('Fall · Wk 7 of 12 · Lock due');
    expect(at('2026-10-25').lockDue).toBe(false);
    expect(seasonHeadline(at('2026-10-25'), fmt)).toBe('Fall · Wk 7 of 12 · locks <2026-10-26>');
    // Without lockToday the UTC `today` decides, still inclusive.
    const onDay = summarizeSeason({ season: SEASON, lockedPeriods: [1, 2, 3], members, matches: [], myUserId: 'me', today: '2026-10-26' });
    expect(onDay.lockDue).toBe(true);
  });

  it('ranks the last period when every unlocked period is overdue, like the tab it opens', () => {
    // 4-period season past its end, P3 and P4 never locked.
    const short: SeasonInput = { ...SEASON, total_weeks: 8, end_date: '2026-10-26', total_periods: 4 };
    const s = summarizeSeason({
      season: short,
      lockedPeriods: [1, 2],
      members,
      matches: [
        singles('a', 'b', 'team1', '2026-10-01T17:00:00+00:00', 0.4, -0.4), // P3 (Sep 29 - Oct 12)
        singles('me', 'c', 'team1', '2026-10-20T17:00:00+00:00', 0.2, -0.2), // P4 (Oct 13 - Oct 26)
      ],
      myUserId: 'me',
      today: '2026-11-10',
    });
    expect(s.period).toBe(4);
    expect(s.myRank).toBe(1);
    expect(s.top[0].user_id).toBe('me');
  });

  it('an upcoming season (by date, even if its status says active) shows its start', () => {
    const s = summarizeSeason({
      season: { ...SEASON, start_date: '2026-11-03' }, lockedPeriods: [], members, matches: [], myUserId: 'me', today,
    });
    expect(s.phase).toBe('upcoming');
    expect(seasonHeadline(s, fmt)).toBe('Fall · Starts <2026-11-03>');
  });

  it('defaults the baseline when the season row has none', () => {
    const s = summarizeSeason({
      season: { ...SEASON, baseline_plupr: null }, lockedPeriods: [1, 2, 3], members,
      matches: [singles('a', 'b', 'team1', '2026-10-13T17:00:00+00:00', 0.25, -0.25)],
      myUserId: 'a', today,
    });
    expect(s.top[0]).toMatchObject({ user_id: 'a', rating: 3.75 });
  });
});

describe('standingsTargetSeasonId', () => {
  it('prefers the active/upcoming season, then the latest completed, else null', () => {
    expect(standingsTargetSeasonId({ id: 'live' }, [{ id: 'old' }])).toBe('live');
    expect(standingsTargetSeasonId(null, [{ id: 'newest' }, { id: 'older' }])).toBe('newest');
    expect(standingsTargetSeasonId(undefined, [])).toBeNull();
  });
});
