import { describe, it, expect } from 'vitest';
import {
  teamKey,
  entrantKey,
  entrantKeyOfTeamKey,
  buildStandingsComparator,
  compareStandings,
  levelGroups,
} from '../tournamentTiebreakers';

describe('teamKey', () => {
  it('is identity for singles', () => {
    expect(teamKey('alice', null)).toBe('alice');
  });
  it('sorts the doubles pair', () => {
    expect(teamKey('bob', 'alice')).toBe(teamKey('alice', 'bob'));
  });
});

describe('entrantKey (shared with the server)', () => {
  it('is lo:hi for a pair, in either order', () => {
    expect(entrantKey('bbb', 'aaa')).toBe('aaa:bbb');
    expect(entrantKey('aaa', 'bbb')).toBe('aaa:bbb');
  });
  it('is id:id for a single player', () => {
    expect(entrantKey('aaa')).toBe('aaa:aaa');
    expect(entrantKey('aaa', null)).toBe('aaa:aaa');
  });
  it('orders canonical uuids like Postgres (lowercase hex)', () => {
    const lo = '0a1b2c3d-0000-4000-8000-000000000000';
    const hi = 'f0e1d2c3-0000-4000-8000-000000000000';
    expect(entrantKey(hi, lo)).toBe(`${lo}:${hi}`);
  });
  it('converts a teamKey', () => {
    expect(entrantKeyOfTeamKey(teamKey('b', 'a'))).toBe('a:b');
    expect(entrantKeyOfTeamKey('a')).toBe('a:a');
  });
});

describe('the ranking chain (PKL-052)', () => {
  const sortKeys = <T extends { key: string }>(rows: T[]) =>
    [...rows].sort(buildStandingsComparator() as any).map(r => (r as any).key);

  it('wins, then fewer losses, then point diff', () => {
    const rows = [
      { key: 'a', wins: 2, losses: 2, pf: 50, pa: 20 },
      { key: 'b', wins: 2, losses: 1, pf: 20, pa: 30 },
      { key: 'c', wins: 3, losses: 3, pf: 10, pa: 40 },
      { key: 'd', wins: 2, losses: 2, pf: 40, pa: 20 },
    ];
    expect(sortKeys(rows)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('a 2-way tie goes to point diff, even when the other team won the meeting', () => {
    // b beat a head-to-head; under PKL-052 that counts for nothing: a's +10
    // beats b's +4.
    const rows = [
      { key: 'b', wins: 2, losses: 1, pf: 25, pa: 21 },
      { key: 'a', wins: 2, losses: 1, pf: 30, pa: 20 },
      { key: 'c', wins: 1, losses: 2, pf: 10, pa: 20 },
    ];
    expect(sortKeys(rows)).toEqual(['a', 'b', 'c']);
  });

  it('then the admin tie order, then seed', () => {
    const level = { wins: 1, losses: 1, pf: 10, pa: 10 };
    expect(compareStandings({ ...level, tieRank: 2, seed: 1 }, { ...level, tieRank: 1, seed: 9 })).toBeGreaterThan(0);
    expect(compareStandings({ ...level, seed: 1 }, { ...level, seed: 2 })).toBeLessThan(0);
    // A set tie order beats none.
    expect(compareStandings({ ...level, seed: 1 }, { ...level, tieRank: 5, seed: 9 })).toBeGreaterThan(0);
  });

  it('ignores rating entirely (no such input)', () => {
    const level = { wins: 1, losses: 1, pf: 10, pa: 10 };
    const hi = { ...level, key: 'hi', rating: 5.0, seed: 2 };
    const lo = { ...level, key: 'lo', rating: 2.0, seed: 1 };
    expect(sortKeys([hi, lo])).toEqual(['lo', 'hi']);
  });
});

describe('levelGroups', () => {
  const three = (ranks: (number | undefined)[]) => [
    { key: 'x', wins: 3, losses: 0, pf: 33, pa: 10 },
    { key: 'a', wins: 1, losses: 2, pf: 20, pa: 25, tieRank: ranks[0], seed: 1 },
    { key: 'b', wins: 1, losses: 2, pf: 20, pa: 25, tieRank: ranks[1], seed: 2 },
    { key: 'c', wins: 1, losses: 2, pf: 20, pa: 25, tieRank: ranks[2], seed: 3 },
  ];

  it('finds a 3-way group W-L and point diff cannot split, waiting with no admin order', () => {
    const rows = three([undefined, undefined, undefined]).sort(compareStandings);
    expect(rows.map(r => r.key)).toEqual(['x', 'a', 'b', 'c']);
    const g = levelGroups(rows);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ start: 1, waiting: true });
    expect(g[0].members.map(m => m.key)).toEqual(['a', 'b', 'c']);
  });
  it('a full, distinct admin order: not waiting', () => {
    const g = levelGroups(three([3, 1, 2]).sort(compareStandings));
    expect(g[0].waiting).toBe(false);
    expect(g[0].members.map(m => m.key)).toEqual(['b', 'c', 'a']);
  });
  it('a partial or duplicated admin order is still waiting', () => {
    expect(levelGroups(three([1, 2, undefined]))[0].waiting).toBe(true);
    expect(levelGroups(three([1, 1, 2]))[0].waiting).toBe(true);
  });
  it('scope keeps separately ranked groups apart', () => {
    const rows = [
      { key: 'p', wins: 1, losses: 1, pf: 0, pa: 0, pool: 'A' },
      { key: 'q', wins: 1, losses: 1, pf: 0, pa: 0, pool: 'B' },
    ];
    expect(levelGroups(rows)).toHaveLength(1);
    expect(levelGroups(rows, r => r.pool)).toHaveLength(0);
  });
});
