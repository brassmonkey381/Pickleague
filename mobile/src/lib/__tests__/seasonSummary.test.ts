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
  relativeShortDate,
  seasonDateFacts,
  seasonDatePart,
  seasonStatusLine,
  standingsTargetSeasonId,
  summarizeSeason,
  type SeasonInput,
  type SeasonStatusFacts,
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

const none = new Set<number>();

const members: StandingsMember[] = [
  { user_id: 'a', profile: { full_name: 'Alice' } },
  { user_id: 'b', profile: { full_name: 'Bob' } },
  { user_id: 'c', profile: { full_name: 'Cara' } },
  { user_id: 'd', profile: { full_name: 'Dev' } },
  { user_id: 'me', profile: { full_name: 'Me' } },
];

// Dates render in en-US so the strings are stable on any test machine. `on`
// builds a LOCAL wall-clock moment, as the device would be in its own zone.
const L = 'en-US';
const on = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const OCT13 = on(2026, 10, 13);
/** The status line for a summary over the 5 test members. */
const line = (s: SeasonStatusFacts & { myRank: number | null }, now = OCT13, isAdmin = false) =>
  seasonStatusLine({ summary: s, myRank: s.myRank, rankedCount: members.length, isAdmin, now, locale: L });

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

describe('summarizeSeason + status line', () => {
  const today = '2026-10-13'; // live period 4 (Oct 13 - Oct 26)

  it('builds "You #2 of 5 · Period 4 locks Oct 26" with the top 3', () => {
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
    expect(s).toMatchObject({ phase: 'active', period: 4, nextPeriod: 4, nextLockOn: '2026-10-26', lockDue: false, hasMatches: true, myRank: 2 });
    expect(s.top.map((r) => r.user_id)).toEqual(['a', 'me', 'c']);
    expect(s.me).toBeNull(); // already in the top 3
    expect(line(s)).toBe('You #2 of 5 · Period 4 locks Oct 26');
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
    expect(line(s)).toBe('5 players · Period 4 locks Oct 26');

    const stranger = summarizeSeason({
      season: SEASON, lockedPeriods: [1, 2, 3], members,
      matches: [singles('a', 'b', 'team1', '2026-10-13T17:00:00+00:00')],
      myUserId: 'zz', today,
    });
    expect(stranger.myRank).toBeNull();
    expect(stranger.me).toBeNull();
    expect(stranger.top).toHaveLength(3);
  });

  it('says "Lock due" to admins once the next lock date has passed unlocked', () => {
    const s = summarizeSeason({ season: SEASON, lockedPeriods: [1, 2], members, matches: [], myUserId: 'me', today });
    expect(s.lockDue).toBe(true);
    expect(s).toMatchObject({ nextPeriod: 3, nextLockOn: '2026-10-12' });
    expect(line(s, OCT13, true)).toBe('5 players · Lock due');
  });

  it('never shows members "Lock due": the due period is "locking soon", date-free', () => {
    const s = summarizeSeason({
      season: SEASON, lockedPeriods: [1, 2], members,
      matches: [singles('me', 'a', 'team1', '2026-10-13T17:00:00+00:00', 0.2, -0.2)],
      myUserId: 'me', today,
    });
    expect(s.lockDue).toBe(true);
    expect(line(s, OCT13, false)).toBe('You #1 of 5 · Period 3 locking soon');
    expect(line(s, OCT13, true)).toBe('You #1 of 5 · Lock due');
    // Past the end with P5 and P6 unlocked: the ranked period is overdue too.
    const late = summarizeSeason({ season: SEASON, lockedPeriods: [1, 2, 3, 4], members, matches: [], myUserId: 'me', today: '2026-12-01' });
    expect(late.lockDue).toBe(true);
    expect(line(late, on(2026, 12, 1))).toBe('5 players · Period 5 locking soon');
    // Only the last period left, overdue: it is the season end.
    const end = summarizeSeason({ season: SEASON, lockedPeriods: [1, 2, 3, 4, 5], members, matches: [], myUserId: 'me', today: '2026-12-01' });
    expect(line(end, on(2026, 12, 1))).toBe('5 players · Season ending soon');
    expect(line(end, on(2026, 12, 1), true)).toBe('5 players · Lock due');
    // Every period locked, the season not completed yet.
    const all = summarizeSeason({ season: SEASON, lockedPeriods: [1, 2, 3, 4, 5, 6], members, matches: [], myUserId: 'me', today: '2026-12-01' });
    expect(all).toMatchObject({ nextPeriod: null, lockDue: false });
    expect(line(all, on(2026, 12, 1))).toBe('5 players · Final standings soon');
  });

  it('a lock is due ON its snapshot date (local), the day SeasonStandings enables Lock', () => {
    // Next lock is period 4 on Oct 26; the windows still use the UTC `today`.
    const at = (lockToday: string) => summarizeSeason({
      season: SEASON, lockedPeriods: [1, 2, 3], members, matches: [], myUserId: 'me', today, lockToday,
    });
    expect(at('2026-10-26').lockDue).toBe(true);
    expect(line(at('2026-10-26'), on(2026, 10, 26, 0, 5), true)).toBe('5 players · Lock due');
    expect(line(at('2026-10-26'), on(2026, 10, 26, 0, 5))).toBe('5 players · Period 4 locking soon');
    expect(at('2026-10-25').lockDue).toBe(false);
    expect(line(at('2026-10-25'), on(2026, 10, 25, 23, 59))).toBe('5 players · Period 4 locks tomorrow');
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
    expect(line(s)).toBe('Starts Nov 3');
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

describe('seasonStatusLine', () => {
  // Mid-season of a 12-period season: period 7 locks Tue Oct 20.
  const mid: SeasonStatusFacts = {
    phase: 'active', startsOn: null, nextPeriod: 7, nextLockOn: '2026-10-20', endsOn: '2026-12-01', totalPeriods: 12, lockDue: false,
  };
  const status = (
    summary: SeasonStatusFacts | null,
    myRank: number | null,
    now = OCT13,
    isAdmin = false,
    rankedCount = 14,
  ) => seasonStatusLine({ summary, myRank, rankedCount, isAdmin, now, locale: L });

  it('mid-season: your rank of everyone ranked, then the next lock', () => {
    expect(status(mid, 2)).toBe('You #2 of 14 · Period 7 locks Oct 20');
  });

  it('last period: the next lock IS the season end', () => {
    const last = { ...mid, nextPeriod: 12, nextLockOn: '2026-12-01' };
    expect(status(last, 2)).toBe('You #2 of 14 · Season ends Dec 1');
    expect(status(last, null)).toBe('14 players · Season ends Dec 1');
    // One period earlier is still a lock, not the end.
    expect(status({ ...last, nextPeriod: 11 }, 2)).toBe('You #2 of 14 · Period 11 locks Dec 1');
  });

  it('last lock before end_date (weeks not divisible by the lock): a lock, not the end', () => {
    const last = { ...mid, nextPeriod: 12, nextLockOn: '2026-11-17' };
    expect(status(last, 2)).toBe('You #2 of 14 · Final lock Nov 17');
    expect(status({ ...last, lockDue: true }, 2)).toBe('You #2 of 14 · Final lock soon');
    expect(status({ ...last, lockDue: true }, 2, OCT13, true)).toBe('You #2 of 14 · Lock due');
  });

  it('a member not ranked yet sees how many are', () => {
    expect(status(mid, null)).toBe('14 players · Period 7 locks Oct 20');
    expect(status(mid, null, OCT13, false, 1)).toBe('1 player · Period 7 locks Oct 20');
  });

  it('upcoming: just the start', () => {
    const up: SeasonStatusFacts = { ...mid, phase: 'upcoming', startsOn: '2026-11-03', nextPeriod: null, nextLockOn: null };
    expect(status(up, null)).toBe('Starts Nov 3');
    expect(status(up, null, on(2026, 11, 2))).toBe('Starts tomorrow');
    expect(status({ ...up, startsOn: null }, null)).toBe('Starts soon');
  });

  it('completed: the final standings', () => {
    expect(status(null, 3)).toBe('Final · You #3 of 14');
    expect(status(null, null)).toBe('Final · 14 players');
  });

  it('a due lock: admins keep "Lock due", members get the date-free form', () => {
    const due = { ...mid, lockDue: true };
    expect(status(due, 2, OCT13, true)).toBe('You #2 of 14 · Lock due');
    expect(status(due, 2, OCT13, false)).toBe('You #2 of 14 · Period 7 locking soon');
    // A cached summary whose lock date has since arrived reads as due, never "locks today".
    expect(status(mid, 2, on(2026, 10, 20, 8))).toBe('You #2 of 14 · Period 7 locking soon');
    expect(status(mid, 2, on(2026, 10, 21), true)).toBe('You #2 of 14 · Lock due');
  });

  it('dates: "tomorrow", the weekday within 6 days, else month + day', () => {
    expect(status(mid, 2, on(2026, 10, 19, 23, 59))).toBe('You #2 of 14 · Period 7 locks tomorrow');
    expect(status(mid, 2, on(2026, 10, 14))).toBe('You #2 of 14 · Period 7 locks Tue Oct 20'); // 6 days
    expect(status(mid, 2, on(2026, 10, 13))).toBe('You #2 of 14 · Period 7 locks Oct 20'); // 7 days
    expect(relativeShortDate('2026-10-20', '2026-10-20', L)).toBe('today');
    expect(relativeShortDate('2026-10-01', '2026-10-20', L)).toBe('Oct 1');
  });

  it('counts calendar days across DST changes (US fall back Nov 1, spring forward Mar 14)', () => {
    const lock = (nextLockOn: string) => ({ ...mid, nextLockOn });
    // Oct 29 late evening -> Wed Nov 4 is 6 calendar days, though not 6 x 24h.
    expect(status(lock('2026-11-04'), 2, on(2026, 10, 29, 23, 30))).toBe('You #2 of 14 · Period 7 locks Wed Nov 4');
    expect(status(lock('2026-11-05'), 2, on(2026, 10, 29, 0, 30))).toBe('You #2 of 14 · Period 7 locks Nov 5');
    expect(status(lock('2027-03-14'), 2, on(2027, 3, 13, 0, 30))).toBe('You #2 of 14 · Period 7 locks tomorrow');
    expect(status(lock('2027-03-20'), 2, on(2027, 3, 14, 23, 30))).toBe('You #2 of 14 · Period 7 locks Sat Mar 20');
  });
});

describe('seasonDateFacts (a list row: dates only, no lock reads)', () => {
  const part = (today: string) => {
    const [y, m, d] = today.split('-').map(Number);
    return seasonDatePart(seasonDateFacts(SEASON, today), { now: on(y, m, d), locale: L });
  };

  it('the next lock is the first period whose date has not passed; past it, due', () => {
    expect(seasonDateFacts(SEASON, '2026-10-13')).toMatchObject({ phase: 'active', nextPeriod: 4, nextLockOn: '2026-10-26', lockDue: false });
    expect(part('2026-10-13')).toBe('Period 4 locks Oct 26');
    expect(part('2026-10-26')).toBe('Period 4 locking soon');
    expect(part('2026-11-20')).toBe('Season ends Mon Nov 23');
    expect(part('2026-12-01')).toBe('Season ending soon');
    expect(part('2026-08-20')).toBe('Starts Aug 31');
  });

  it('12 weeks locking every 5 (2 periods): the last lock is Nov 9, the season runs to Nov 23', () => {
    const odd = { start_date: '2026-08-31', end_date: '2026-11-23', lock_frequency_weeks: 5, total_periods: 2 };
    const at = (today: string) => {
      const [y, m, d] = today.split('-').map(Number);
      return seasonDatePart(seasonDateFacts(odd, today), { now: on(y, m, d), locale: L });
    };
    expect(at('2026-10-13')).toBe('Final lock Nov 9');
    expect(at('2026-11-12')).toBe('Final lock soon');
    // Without an end_date the last lock is still read as the end.
    expect(seasonDatePart(seasonDateFacts({ ...odd, end_date: null }, '2026-10-13'), { now: OCT13, locale: L }))
      .toBe('Season ends Nov 9');
  });

  it('compact (a list row): "P4", no weekday, no "tomorrow"', () => {
    const compact = (today: string) => {
      const [y, m, d] = today.split('-').map(Number);
      return seasonDatePart(seasonDateFacts(SEASON, today), { now: on(y, m, d), locale: L, compact: true });
    };
    expect(compact('2026-10-13')).toBe('P4 locks Oct 26');
    expect(compact('2026-10-25')).toBe('P4 locks Oct 26');
    expect(compact('2026-10-26')).toBe('P4 locking soon');
    expect(compact('2026-11-20')).toBe('Ends Nov 23');
    expect(compact('2026-12-01')).toBe('Ending soon');
    expect(compact('2026-08-20')).toBe('Starts Aug 31');
  });
});

describe('standingsTargetSeasonId', () => {
  it('prefers the active/upcoming season, then the latest completed, else null', () => {
    expect(standingsTargetSeasonId({ id: 'live' }, [{ id: 'old' }])).toBe('live');
    expect(standingsTargetSeasonId(null, [{ id: 'newest' }, { id: 'older' }])).toBe('newest');
    expect(standingsTargetSeasonId(undefined, [])).toBeNull();
  });
});
