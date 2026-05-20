import { describe, it, expect } from 'vitest';
import {
  teamKey,
  headToHead,
  buildStandingsComparator,
  type TiebreakerMatch,
} from '../tournamentTiebreakers';

function m(
  t1p1: string, t1p2: string | null,
  t2p1: string, t2p2: string | null,
  winner: 'team1' | 'team2',
): TiebreakerMatch {
  return {
    team1_player1: t1p1, team1_player2: t1p2,
    team2_player1: t2p1, team2_player2: t2p2,
    winner_team: winner, status: 'completed',
  };
}

describe('teamKey', () => {
  it('is identity for singles', () => {
    expect(teamKey('alice', null)).toBe('alice');
  });
  it('sorts the doubles pair', () => {
    expect(teamKey('bob', 'alice')).toBe(teamKey('alice', 'bob'));
  });
});

describe('headToHead', () => {
  it('returns -1 when A swept B', () => {
    const matches = [m('alice', null, 'bob', null, 'team1')];
    expect(headToHead(matches, 'alice', 'bob')).toBe(-1);
  });
  it('returns 1 when B swept A', () => {
    const matches = [m('alice', null, 'bob', null, 'team2')];
    expect(headToHead(matches, 'alice', 'bob')).toBe(1);
  });
  it('returns 0 on a split series', () => {
    const matches = [
      m('alice', null, 'bob', null, 'team1'),
      m('bob', null, 'alice', null, 'team1'),
    ];
    expect(headToHead(matches, 'alice', 'bob')).toBe(0);
  });
  it('returns 0 when the two teams have not played', () => {
    const matches = [m('alice', null, 'carol', null, 'team1')];
    expect(headToHead(matches, 'alice', 'bob')).toBe(0);
  });
  it('handles doubles (pair-keyed)', () => {
    const matches = [
      // (alice+bob) beat (carol+dave)
      m('alice', 'bob', 'carol', 'dave', 'team1'),
    ];
    const keyAB = teamKey('alice', 'bob');
    const keyCD = teamKey('carol', 'dave');
    expect(headToHead(matches, keyAB, keyCD)).toBe(-1);
  });
  it('ignores incomplete matches', () => {
    const matches: TiebreakerMatch[] = [
      { team1_player1: 'alice', team1_player2: null,
        team2_player1: 'bob', team2_player2: null,
        winner_team: null, status: 'pending' },
    ];
    expect(headToHead(matches, 'alice', 'bob')).toBe(0);
  });
});

describe('buildStandingsComparator', () => {
  it('falls through to point_diff when 3+ are tied on wins', () => {
    const entries = [
      { key: 'a', wins: 2, pf: 30, pa: 20 }, // diff +10
      { key: 'b', wins: 2, pf: 25, pa: 21 }, // diff +4
      { key: 'c', wins: 2, pf: 20, pa: 25 }, // diff -5
    ];
    // Even if b beat a head-to-head, with 3-way tie H2H is skipped.
    const matches = [m('a', null, 'b', null, 'team2')];
    const sorted = [...entries].sort(buildStandingsComparator(entries, matches));
    expect(sorted.map(e => e.key)).toEqual(['a', 'b', 'c']);
  });
  it('uses H2H to break exactly-2-way wins ties', () => {
    const entries = [
      { key: 'a', wins: 2, pf: 30, pa: 20 }, // diff +10
      { key: 'b', wins: 2, pf: 25, pa: 21 }, // diff +4
      { key: 'c', wins: 1, pf: 10, pa: 20 },
    ];
    // b beat a head-to-head, so b ranks above a despite worse point_diff.
    const matches = [m('a', null, 'b', null, 'team2')];
    const sorted = [...entries].sort(buildStandingsComparator(entries, matches));
    expect(sorted.map(e => e.key)).toEqual(['b', 'a', 'c']);
  });
  it('uses point_diff when H2H is a split series (2-way tie)', () => {
    const entries = [
      { key: 'a', wins: 2, pf: 30, pa: 20 }, // diff +10
      { key: 'b', wins: 2, pf: 25, pa: 21 }, // diff +4
    ];
    const matches = [
      m('a', null, 'b', null, 'team1'),
      m('b', null, 'a', null, 'team1'),
    ];
    const sorted = [...entries].sort(buildStandingsComparator(entries, matches));
    expect(sorted.map(e => e.key)).toEqual(['a', 'b']);
  });
});
