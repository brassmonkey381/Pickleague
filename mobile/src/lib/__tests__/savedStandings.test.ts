import { describe, it, expect } from 'vitest';
import {
  leagueSuggestions, liveMatchWindow, pickLeagueSeasons, rankedPeriod, savedLeagueStanding,
  savedStandingA11y, savedStandingLine, standingsSeasonFor, tournamentFinishLine, tournamentFinishes,
  type SavedSeason, type SavedStanding, type SavedStandingInput,
} from '../savedStandings';
import type { StandingsMatch } from '../seasonSummary';

// Two-week periods from Mon Sep 7 2026: P1 Sep 7-21, P2 Sep 22-Oct 5,
// P3 Oct 6-19, P4 Oct 20-Nov 2 (periodEndDate = start + 14n days).
const season = (over: Partial<SavedSeason> = {}): SavedSeason => ({
  id: 's1', league_id: 'L', name: 'Fall 2026',
  start_date: '2026-09-07', end_date: '2026-11-02',
  total_weeks: 8, lock_frequency_weeks: 2, total_periods: 4,
  status: 'active', baseline_plupr: 3.5, created_at: '2026-09-01T00:00:00Z',
  ...over,
});

const match = (p1: string, p2: string, winner: 'team1' | 'team2', playedAt: string, d = 0.1): StandingsMatch => ({
  player1_id: p1, partner1_id: null, player2_id: p2, partner2_id: null, winner_team: winner,
  played_at: playedAt, game_scores: null,
  player1_rating_before: 3.5, player1_rating_after: winner === 'team1' ? 3.5 + d : 3.5 - d,
  player2_rating_before: 3.5, player2_rating_after: winner === 'team2' ? 3.5 + d : 3.5 - d,
});

const input = (over: Partial<SavedStandingInput> = {}): SavedStandingInput => ({
  leagueId: 'L', current: season(), completed: null,
  memberIds: ['me', 'a', 'b', 'c'], snaps: [], finals: [], matches: [],
  myUserId: 'me', today: '2026-10-22',
  ...over,
});

describe('pickLeagueSeasons', () => {
  it('takes the newest-created active/upcoming season and the newest-ended completed one, per league', () => {
    const picked = pickLeagueSeasons([
      season({ id: 'old', created_at: '2026-01-01' }),
      season({ id: 'new', status: 'upcoming', created_at: '2026-10-01' }),
      season({ id: 'c1', status: 'completed', end_date: '2026-03-01' }),
      season({ id: 'c2', status: 'completed', end_date: '2026-06-01' }),
      season({ id: 'x', league_id: 'M', status: 'completed', end_date: '2025-01-01' }),
    ]);
    expect(picked.get('L')?.current?.id).toBe('new');
    expect(picked.get('L')?.completed?.id).toBe('c2');
    expect(picked.get('M')).toEqual({ current: null, completed: expect.objectContaining({ id: 'x' }) });
  });
});

describe('rankedPeriod', () => {
  it('is the live period on a mid-period day', () => {
    expect(rankedPeriod(season(), new Set([1, 2, 3]), '2026-10-22')).toBe(4);
  });
  it('falls back to the last locked period when the live one starts tomorrow', () => {
    // P3 locked on its lock day (Oct 19); P4 starts Oct 20.
    expect(rankedPeriod(season(), new Set([1, 2, 3]), '2026-10-19')).toBe(3);
  });
});

describe('savedLeagueStanding', () => {
  it('live: my rank among the members over the live period window', () => {
    const s = savedLeagueStanding(input({
      snaps: [1, 2, 3].map((p) => ({ season_id: 's1', period_number: p, user_id: 'me', rank_at_snapshot: 2 })),
      matches: [
        match('a', 'me', 'team1', '2026-10-21T18:00:00', 0.3),
        match('me', 'b', 'team1', '2026-10-21T19:00:00', 0.1),
        // Before the P4 window: ignored.
        match('c', 'me', 'team1', '2026-10-10T18:00:00', 0.5),
      ],
    }));
    expect(s.kind).toBe('live');
    expect(s.period).toBe(4);
    expect(s.seasonId).toBe('s1');
    expect(s.rankedCount).toBe(4);
    // a +0.3; me -0.3 +0.1 = -0.2; c 0; b -0.1  => a, c, b, me
    expect(s.myRank).toBe(4);
  });

  it('locked: my snapshot rank in the period that just locked', () => {
    const snaps = ['me', 'a', 'b'].map((u, i) => ({ season_id: 's1', period_number: 3, user_id: u, rank_at_snapshot: i + 1 }))
      .concat([{ season_id: 's1', period_number: 1, user_id: 'me', rank_at_snapshot: 3 },
        { season_id: 's1', period_number: 2, user_id: 'me', rank_at_snapshot: 3 }]);
    const s = savedLeagueStanding(input({ today: '2026-10-19', snaps }));
    expect(s).toMatchObject({ kind: 'locked', period: 3, myRank: 1, rankedCount: 3 });
  });

  it('noMatches when nothing was played in the live window', () => {
    const s = savedLeagueStanding(input({ matches: [match('me', 'a', 'team1', '2026-09-08T12:00:00')] }));
    // Unlocked overdue periods are skipped, as SeasonStandings' default tab does.
    expect(s).toMatchObject({ kind: 'noMatches', period: 4, myRank: null });
  });

  it('upcoming before the start date', () => {
    const s = savedLeagueStanding(input({ today: '2026-09-01' }));
    expect(s).toMatchObject({ kind: 'upcoming', startsOn: '2026-09-07', seasonId: 's1' });
  });

  it('final: my stored final rank in the latest completed season', () => {
    const done = season({ id: 'c1', status: 'completed', name: 'Spring 2026' });
    const s = savedLeagueStanding(input({
      current: null, completed: done,
      finals: [
        { season_id: 'c1', user_id: 'a', final_rank: 1 },
        { season_id: 'c1', user_id: 'me', final_rank: 2 },
        { season_id: 'other', user_id: 'me', final_rank: 9 },
      ],
    }));
    expect(s).toMatchObject({ kind: 'final', seasonId: 'c1', myRank: 2, rankedCount: 2 });
  });

  it('none: no season ever, so the row opens the league', () => {
    const s = savedLeagueStanding(input({ current: null }));
    expect(s).toMatchObject({ kind: 'none', seasonId: null });
  });

  it("not a member: no rank of mine, but the season still opens", () => {
    const s = savedLeagueStanding(input({
      myUserId: 'stranger',
      matches: [match('a', 'b', 'team1', '2026-10-21T18:00:00')],
    }));
    expect(s).toMatchObject({ kind: 'live', myRank: null, rankedCount: 4, seasonId: 's1' });
  });
});

describe('liveMatchWindow', () => {
  it('only for a live period that needs computing', () => {
    expect(liveMatchWindow(season(), [], '2026-10-22')).toEqual({ start: '2026-10-20', end: '2026-10-22T23:59:59' });
    expect(liveMatchWindow(season(), [], '2026-09-01')).toBeNull();
    const locked = [1, 2, 3].map((p) => ({ season_id: 's1', period_number: p, user_id: 'me', rank_at_snapshot: 1 }));
    expect(liveMatchWindow(season(), locked, '2026-10-19')).toBeNull();
  });
});

describe('savedStandingLine', () => {
  const base: SavedStanding = {
    leagueId: 'L', kind: 'live', seasonId: 's1', seasonName: 'Fall 2026', period: 7,
    totalPeriods: 12, myRank: 3, rankedCount: 16, startsOn: null,
  };
  it('reads as one short line per kind', () => {
    expect(savedStandingLine(base)).toBe('You #3 of 16 · Fall 2026 · P7');
    expect(savedStandingLine({ ...base, myRank: null })).toBe('16 players · Fall 2026 · P7');
    expect(savedStandingLine({ ...base, kind: 'locked', period: 6 })).toBe('You #3 of 16 · Fall 2026 · P6 locked');
    expect(savedStandingLine({ ...base, kind: 'noMatches', myRank: null })).toBe('Fall 2026 · P7 · no matches yet');
    expect(savedStandingLine({ ...base, kind: 'upcoming', startsOn: '2026-11-03' }, { locale: 'en-US' }))
      .toBe('Fall 2026 starts Nov 3');
    expect(savedStandingLine({ ...base, kind: 'final', period: null, myRank: 2, rankedCount: 14, seasonName: 'Spring' }))
      .toBe('Finished #2 of 14 · Spring');
    expect(savedStandingLine({ ...base, kind: 'final', myRank: null, rankedCount: 0 })).toBe('Fall 2026 · final standings');
    expect(savedStandingLine({ ...base, kind: 'none' })).toBeNull();
  });
  it('drops the period on a one-period season', () => {
    expect(savedStandingLine({ ...base, totalPeriods: 1, period: 1 })).toBe('You #3 of 16 · Fall 2026');
  });
  it('says the rank in words for screen readers', () => {
    expect(savedStandingA11y(base)).toBe('You ranked 3 of 16, Fall 2026, period 7');
  });
});

describe('tournament finishes', () => {
  it('my finish out of the entrants', () => {
    const f = tournamentFinishes([
      { tournament_id: 't1', user_id: 'a', final_rank: 1 },
      { tournament_id: 't1', user_id: 'me', final_rank: 2 },
      { tournament_id: 't1', user_id: 'b', final_rank: 3 },
      { tournament_id: 't2', user_id: 'a', final_rank: 1 },
    ], 'me');
    expect(f.get('t1')).toEqual({ rank: 2, of: 3 });
    expect(f.has('t2')).toBe(false);
    expect(tournamentFinishLine(f.get('t1'))).toBe('Finished #2 of 3');
    expect(tournamentFinishLine(undefined)).toBeNull();
  });
});

describe('leagueSuggestions', () => {
  it('my active, unsaved leagues, in order, capped', () => {
    const mine = [
      { id: 'a', is_active: true }, { id: 'b', is_active: false }, { id: 'c', is_active: null },
      { id: 'd', is_active: true }, { id: 'a', is_active: true },
    ];
    expect(leagueSuggestions(mine, new Set(['d'])).map((l) => l.id)).toEqual(['a', 'c']);
    expect(leagueSuggestions(mine, new Set(), 1).map((l) => l.id)).toEqual(['a']);
  });
});

describe('standingsSeasonFor', () => {
  it("the league's current season, else its latest completed one", () => {
    expect(standingsSeasonFor([season({ id: 'c', status: 'completed' }), season({ id: 'a' })], 'L')).toBe('a');
    expect(standingsSeasonFor([season({ id: 'c', status: 'completed' })], 'L')).toBe('c');
    expect(standingsSeasonFor([], 'L')).toBeNull();
  });
});
