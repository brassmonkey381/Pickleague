import { describe, it, expect } from 'vitest';
import {
  computeTeamStandings,
  orderByFinalRanks,
  settledStandings,
  finalRankOf,
  fetchFinalRanks,
  sortMlpTeamStandings,
  type StandingsMatch,
  type FinalRankRow,
  type TeamStandingsOptions,
} from '../tournamentStandings';
import { buildStandingsComparator, entrantKey, levelGroups, teamKey } from '../tournamentTiebreakers';

// ── Fixture helpers ─────────────────────────────────────────────────────────

type Side = [string, string?];

function m(t1: Side, t2: Side, winner: 'team1' | 'team2' | null, s1 = 0, s2 = 0): StandingsMatch {
  return {
    team1_player1: t1[0], team1_player2: t1[1] ?? null,
    team2_player1: t2[0], team2_player2: t2[1] ?? null,
    winner_team: winner,
    status: winner ? 'completed' : 'pending',
    team1_score: winner ? s1 : null,
    team2_score: winner ? s2 : null,
  };
}

const nameOf = (p1: string, p2: string | null) => (p2 ? `${p1} & ${p2}` : p1);
const live: TeamStandingsOptions = { nameOf, isMe: () => false };
const withSeeds = (seeds: Record<string, number>): TeamStandingsOptions => ({
  ...live,
  // Same rule as the SQL: the team's seed is the best (lowest) member seed.
  seedOf: (p1, p2) => Math.min(seeds[p1] ?? 999, p2 ? (seeds[p2] ?? 999) : 999),
});

const keys = (rows: { key: string }[]) => rows.map(r => r.key);

/**
 * Independent emulation of compute_tournament_final_ranks' fixed-team path
 * under PKL-052, for round robin and pool play (no finals round, so no
 * champion / grand-final-loser pin). Written from the rule, not from
 * tournamentTiebreakers.ts, so agreement between the two is a real check:
 *   rank: row_number() over (wins desc, losses asc, point_diff desc,
 *                            tie_rank asc nulls last, seed asc)
 * Both partners carry the team's rank; approved entrants with no completed
 * match trail by seed.
 */
function sqlTeamPathRanks(
  matches: StandingsMatch[],
  seeds: Record<string, number>,
  approved: string[] = [],
  tieRanks: Record<string, number> = {},
): FinalRankRow[] {
  type Agg = { lo: string; hi: string; wins: number; losses: number; pd: number; seed: number; tr: number };
  const lohi = (p1: string, p2: string | null): [string, string] => {
    const b = p2 ?? p1;
    return p1 < b ? [p1, b] : [b, p1];
  };
  const done = matches.filter(x => x.status === 'completed' && (x.winner_team === 'team1' || x.winner_team === 'team2'));
  const agg = new Map<string, Agg>();
  const add = (p1: string | null, p2: string | null, pf: number, pa: number, w: number, l: number) => {
    if (!p1) return;
    const [lo, hi] = lohi(p1, p2);
    const k = `${lo}:${hi}`;
    const a = agg.get(k) ?? {
      lo, hi, wins: 0, losses: 0, pd: 0,
      seed: Math.min(seeds[lo] ?? 999, seeds[hi] ?? 999),
      tr: tieRanks[k] ?? Number.POSITIVE_INFINITY,
    };
    a.wins += w; a.losses += l; a.pd += pf - pa;
    agg.set(k, a);
  };
  for (const x of done) {
    const t1won = x.winner_team === 'team1' ? 1 : 0;
    add(x.team1_player1, x.team1_player2, x.team1_score ?? 0, x.team2_score ?? 0, t1won, 1 - t1won);
    add(x.team2_player1, x.team2_player2, x.team2_score ?? 0, x.team1_score ?? 0, 1 - t1won, t1won);
  }
  const ranked = [...agg.values()].sort((a, b) =>
    b.wins - a.wins
    || a.losses - b.losses
    || b.pd - a.pd
    || (a.tr === b.tr ? 0 : a.tr < b.tr ? -1 : 1)
    || a.seed - b.seed);
  const rows: FinalRankRow[] = [];
  ranked.forEach((t, i) => {
    rows.push({ user_id: t.lo, final_rank: i + 1, wins: t.wins, losses: t.losses });
    if (t.hi !== t.lo) rows.push({ user_id: t.hi, final_rank: i + 1, wins: t.wins, losses: t.losses });
  });
  const ranked_users = new Set(rows.map(r => r.user_id));
  approved
    .filter(u => !ranked_users.has(u))
    .sort((a, b) => (seeds[a] ?? 999) - (seeds[b] ?? 999))
    .forEach((u, i) => rows.push({ user_id: u, final_rank: ranked.length + i + 1, wins: 0, losses: 0 }));
  return rows;
}

/** Entrant keys in settled order, from the SQL emulation's per-user rows. */
function sqlOrder(rows: FinalRankRow[], pairs: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const r of [...rows].sort((a, b) => a.final_rank - b.final_rank)) {
    const partner = pairs[r.user_id];
    const k = partner ? teamKey(r.user_id, partner) : r.user_id;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

// ── Representative fixtures ─────────────────────────────────────────────────

type Fixture = {
  name: string;
  matches: StandingsMatch[];
  seeds: Record<string, number>;
  pairs?: Record<string, string>;
  expected: string[];
};

const FIXTURES: Fixture[] = [
  {
    name: 'singles round robin, clear win order',
    matches: [
      m(['a'], ['b'], 'team1', 11, 5), m(['a'], ['c'], 'team1', 11, 7), m(['a'], ['d'], 'team1', 11, 2),
      m(['b'], ['c'], 'team1', 11, 9), m(['b'], ['d'], 'team1', 11, 3), m(['c'], ['d'], 'team1', 11, 8),
    ],
    seeds: { a: 4, b: 3, c: 2, d: 1 },
    expected: ['a', 'b', 'c', 'd'],
  },
  {
    // 5-player round robin with two 2-way ties: b and c on 2-2, d and e on
    // 1-3. In each pair the head-to-head winner has the WORSE point diff
    // (b beat c but c is +15 vs b -15; e beat d but d is -8 vs e -16).
    // PKL-052: point diff decides, head-to-head counts for nothing.
    name: '2-way ties go to point diff, never head-to-head',
    matches: [
      m(['a'], ['b'], 'team1', 11, 5), m(['a'], ['c'], 'team1', 11, 5),
      m(['a'], ['d'], 'team1', 11, 5), m(['a'], ['e'], 'team1', 11, 5),
      m(['b'], ['c'], 'team1', 11, 10), m(['d'], ['b'], 'team1', 11, 0), m(['b'], ['e'], 'team1', 11, 10),
      m(['c'], ['d'], 'team1', 11, 0), m(['c'], ['e'], 'team1', 11, 0),
      m(['d'], ['e'], 'team2', 9, 11),
    ],
    seeds: { a: 1, b: 2, c: 3, d: 4, e: 5 },
    expected: ['a', 'c', 'b', 'd', 'e'],
  },
  {
    // a, b and c all 2-1: point diff decides (c +21, b +1, a -7).
    name: '3-way tie on W-L falls to point diff',
    matches: [
      m(['a'], ['b'], 'team1', 11, 9), m(['c'], ['a'], 'team1', 11, 0), m(['a'], ['d'], 'team1', 11, 9),
      m(['b'], ['c'], 'team1', 11, 10), m(['b'], ['d'], 'team1', 11, 9), m(['c'], ['d'], 'team1', 11, 0),
    ],
    seeds: { a: 1, b: 2, c: 3, d: 4 },
    expected: ['c', 'b', 'a', 'd'],
  },
  {
    // a -6, b +4, c +2.
    name: '3-way cycle falls to point diff',
    matches: [
      m(['a'], ['b'], 'team1', 11, 9), m(['b'], ['c'], 'team1', 11, 5), m(['c'], ['a'], 'team1', 11, 3),
    ],
    seeds: { a: 1, b: 2, c: 3 },
    expected: ['b', 'c', 'a'],
  },
  {
    // Level on W-L and point diff with no admin order: waiting, by seed.
    name: 'everything level falls to registration seed',
    matches: [
      m(['a'], ['b'], 'team1', 11, 9), m(['b'], ['c'], 'team1', 11, 9), m(['c'], ['a'], 'team1', 11, 9),
    ],
    seeds: { a: 3, b: 1, c: 2 },
    expected: ['b', 'c', 'a'],
  },
  {
    // Partners appear in either order and on either side; keys must merge.
    name: 'doubles round robin with partners listed in either order',
    matches: [
      m(['p1', 'p2'], ['p3', 'p4'], 'team1', 11, 6),
      m(['p6', 'p5'], ['p2', 'p1'], 'team2', 4, 11),
      m(['p4', 'p3'], ['p5', 'p6'], 'team1', 11, 9),
    ],
    seeds: { p1: 5, p2: 6, p3: 1, p4: 2, p5: 3, p6: 4 },
    pairs: { p1: 'p2', p2: 'p1', p3: 'p4', p4: 'p3', p5: 'p6', p6: 'p5' },
    expected: [teamKey('p1', 'p2'), teamKey('p3', 'p4'), teamKey('p5', 'p6')],
  },
  {
    // Doubles with a 3-way tie on wins: partners listed in either order still
    // merge into one entrant, and point diff separates the three.
    name: 'doubles 3-way tie on wins falls to point diff',
    matches: [
      m(['a1', 'a2'], ['b1', 'b2'], 'team1', 11, 10),
      m(['b2', 'b1'], ['c1', 'c2'], 'team1', 11, 0),
      m(['c2', 'c1'], ['a2', 'a1'], 'team1', 11, 9),
      m(['d1', 'd2'], ['c1', 'c2'], 'team1', 11, 9),
      m(['d1', 'd2'], ['a1', 'a2'], 'team1', 11, 9),
      m(['b1', 'b2'], ['d2', 'd1'], 'team2', 9, 11),
    ],
    seeds: { a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6, d1: 7, d2: 8 },
    pairs: { a1: 'a2', a2: 'a1', b1: 'b2', b2: 'b1', c1: 'c2', c2: 'c1', d1: 'd2', d2: 'd1' },
    // d 3-0; a 1-2 (b), b 1-2 (c), c 1-2 (a) is a 3-way tie, decided on diff:
    // a +1-2-2 = -3, b -1+11-2 = +8, c -11+2-2 = -11.
    expected: [teamKey('d1', 'd2'), teamKey('b1', 'b2'), teamKey('a1', 'a2'), teamKey('c1', 'c2')],
  },
  {
    name: 'pool table with no ties',
    matches: [
      m(['a'], ['b'], 'team1', 11, 1), m(['a'], ['c'], 'team1', 11, 1), m(['a'], ['d'], 'team1', 11, 1),
      m(['b'], ['c'], 'team1', 11, 10), m(['c'], ['d'], 'team1', 11, 0), m(['d'], ['b'], 'team2', 9, 11),
    ],
    seeds: { a: 1, b: 2, c: 3, d: 4 },
    expected: ['a', 'b', 'c', 'd'],
  },
];

describe('computeTeamStandings order', () => {
  for (const f of FIXTURES) {
    it(`equals the tournamentTiebreakers comparator: ${f.name}`, () => {
      const table = computeTeamStandings(f.matches, withSeeds(f.seeds));
      // Re-sort the helper's own entries with the comparator directly: the
      // helper must not reorder anything beyond what the comparator does.
      const viaComparator = [...table].sort(buildStandingsComparator());
      expect(keys(table)).toEqual(keys(viaComparator));
    });

    it(`equals the server's team-path ranks: ${f.name}`, () => {
      const table = computeTeamStandings(f.matches, withSeeds(f.seeds));
      const server = sqlOrder(sqlTeamPathRanks(f.matches, f.seeds), f.pairs);
      expect(keys(table)).toEqual(server);
      if (f.expected.length > 0) expect(keys(table)).toEqual(f.expected);
    });
  }

  it('settled ranks reproduce the live order when the server agrees', () => {
    for (const f of FIXTURES) {
      const liveTable = computeTeamStandings(f.matches, live);
      const ranks = sqlTeamPathRanks(f.matches, f.seeds);
      const settled = settledStandings(liveTable, { status: 'completed', finalRanks: ranks });
      expect(keys(settled)).toEqual(keys(computeTeamStandings(f.matches, withSeeds(f.seeds))));
    }
  });

  it('3-way tie W-L and point diff cannot break: all three waiting, ordered by seed', () => {
    // a, b, c each 1-1 at +0 (a cycle of 11-9 wins); d lost twice.
    const matches = [
      m(['a'], ['b'], 'team1', 11, 9), m(['b'], ['c'], 'team1', 11, 9), m(['c'], ['a'], 'team1', 11, 9),
      m(['a'], ['d'], 'team1', 11, 9), m(['b'], ['d'], 'team1', 11, 9), m(['c'], ['d'], 'team1', 11, 9),
    ];
    // That makes a, b, c 2-1 at +2 each.
    const table = computeTeamStandings(matches, withSeeds({ a: 3, b: 1, c: 2, d: 4 }));
    expect(keys(table)).toEqual(['b', 'c', 'a', 'd']);
    const groups = levelGroups(table);
    expect(groups).toHaveLength(1);
    expect(groups[0].waiting).toBe(true);
    expect(keys(groups[0].members)).toEqual(['b', 'c', 'a']);
    expect(keys(table)).toEqual(sqlOrder(sqlTeamPathRanks(matches, { a: 3, b: 1, c: 2, d: 4 })));
  });

  it('the same tie with admin tie orders: ordered by them, not waiting', () => {
    const matches = [
      m(['a'], ['b'], 'team1', 11, 9), m(['b'], ['c'], 'team1', 11, 9), m(['c'], ['a'], 'team1', 11, 9),
      m(['a'], ['d'], 'team1', 11, 9), m(['b'], ['d'], 'team1', 11, 9), m(['c'], ['d'], 'team1', 11, 9),
    ];
    const seeds = { a: 3, b: 1, c: 2, d: 4 };
    const tieRanks = { [entrantKey('a')]: 1, [entrantKey('c')]: 2, [entrantKey('b')]: 3 };
    const table = computeTeamStandings(matches, { ...withSeeds(seeds), tieRanks });
    expect(keys(table)).toEqual(['a', 'c', 'b', 'd']);
    expect(table[0]).toMatchObject({ tieKey: 'a:a', tieRank: 1 });
    expect(levelGroups(table)[0].waiting).toBe(false);
    expect(keys(table)).toEqual(sqlOrder(sqlTeamPathRanks(matches, seeds, [], tieRanks)));
  });

  it('doubles tie keys are the server lo:hi pair key', () => {
    const table = computeTeamStandings([m(['z', 'y'], ['b', 'a'], 'team1', 11, 3)], live);
    expect(table.map(t => t.tieKey)).toEqual(['y:z', 'a:b']);
  });

  it('keeps first-appearance order for full ties when no seed is given (screen parity)', () => {
    const matches = [
      m(['c'], ['a'], 'team1', 11, 9), m(['a'], ['b'], 'team1', 11, 9), m(['b'], ['c'], 'team1', 11, 9),
    ];
    // Every entrant 1-1 with +0: the comparator returns 0 and sort is stable.
    expect(keys(computeTeamStandings(matches, live))).toEqual(['c', 'a', 'b']);
  });

  it('tallies W-L and points from completed matches only, listing scheduled entrants at 0-0', () => {
    const table = computeTeamStandings([
      m(['a'], ['b'], 'team1', 11, 4),
      m(['c'], ['d'], null),
    ], live);
    expect(table.map(t => [t.key, t.wins, t.losses, t.pf, t.pa])).toEqual([
      ['a', 1, 0, 11, 4],
      ['c', 0, 0, 0, 0],
      ['d', 0, 0, 0, 0],
      ['b', 0, 1, 4, 11],
    ]);
  });

  it('skips a bye row (no opponent) without creating a phantom entrant', () => {
    const bye: StandingsMatch = {
      team1_player1: 'a', team1_player2: null, team2_player1: null, team2_player2: null,
      winner_team: null, status: 'completed', team1_score: null, team2_score: null,
    };
    const table = computeTeamStandings([bye, m(['a'], ['b'], 'team1', 11, 3)], live);
    expect(keys(table)).toEqual(['a', 'b']);
    expect(table[0].wins).toBe(1);
  });

  it('names entrants and marks the viewer through the caller callbacks', () => {
    const table = computeTeamStandings([m(['x', 'y'], ['z', 'w'], 'team2', 3, 11)], {
      nameOf,
      isMe: (p1, p2) => p1 === 'w' || p2 === 'w',
    });
    expect(table.map(t => [t.name, t.isMe])).toEqual([['z & w', true], ['x & y', false]]);
  });

  it("keeps the pool table's verbatim isMe semantics (null viewer matches a null partner)", () => {
    const myUserId: string | null = null;
    const table = computeTeamStandings([m(['a'], ['b'], 'team1', 11, 3)], {
      nameOf,
      isMe: (p1, p2) => p1 === myUserId || p2 === myUserId,
    });
    expect(table.every(t => t.isMe)).toBe(true);
  });
});

describe('settled ranks (tournament_final_ranks)', () => {
  const table = [
    { key: 'a' }, { key: 'b' }, { key: teamKey('c', 'd') }, { key: 'e' },
  ];

  it('orders by the stored rank, partners sharing one', () => {
    const ranks: FinalRankRow[] = [
      { user_id: 'c', final_rank: 1, wins: 3, losses: 0 },
      { user_id: 'd', final_rank: 1, wins: 3, losses: 0 },
      { user_id: 'b', final_rank: 2, wins: 2, losses: 1 },
      { user_id: 'a', final_rank: 3, wins: 1, losses: 2 },
    ];
    expect(keys(orderByFinalRanks(table, ranks))).toEqual([teamKey('c', 'd'), 'b', 'a', 'e']);
  });

  it('lets the server pin override the live derivation (e.g. a grand-final winner)', () => {
    // Live order says a, b; the server pinned b as champion.
    const ranks: FinalRankRow[] = [
      { user_id: 'b', final_rank: 1, wins: 2, losses: 1 },
      { user_id: 'a', final_rank: 2, wins: 3, losses: 1 },
    ];
    expect(keys(settledStandings([{ key: 'a' }, { key: 'b' }], { status: 'completed', finalRanks: ranks })))
      .toEqual(['b', 'a']);
  });

  it('only applies to completed tournaments with ranks present', () => {
    const ranks: FinalRankRow[] = [{ user_id: 'e', final_rank: 1, wins: 0, losses: 0 }];
    expect(settledStandings(table, { status: 'active', finalRanks: ranks })).toBe(table);
    expect(settledStandings(table, { status: 'completed', finalRanks: [] })).toBe(table);
    expect(settledStandings(table, { status: 'completed', finalRanks: null })).toBe(table);
  });

  it('keeps unranked entrants after ranked ones, in their existing order', () => {
    const ranks: FinalRankRow[] = [{ user_id: 'e', final_rank: 1, wins: 0, losses: 0 }];
    expect(keys(orderByFinalRanks(table, ranks))).toEqual(['e', 'a', 'b', teamKey('c', 'd')]);
  });

  it('places trailing leftovers (approved, never played) after every team', () => {
    const matches = [m(['a'], ['b'], 'team1', 11, 3)];
    const ranks = sqlTeamPathRanks(matches, { a: 2, b: 1, z: 3 }, ['a', 'b', 'z']);
    expect(ranks.find(r => r.user_id === 'z')?.final_rank).toBe(3);
    expect(keys(orderByFinalRanks([{ key: 'z' }, { key: 'b' }, { key: 'a' }], ranks))).toEqual(['a', 'b', 'z']);
  });

  it('finalRankOf reads the viewer finish', () => {
    const ranks: FinalRankRow[] = [{ user_id: 'a', final_rank: 2, wins: 1, losses: 1 }];
    expect(finalRankOf(ranks, 'a')).toBe(2);
    expect(finalRankOf(ranks, 'b')).toBeNull();
    expect(finalRankOf(ranks, null)).toBeNull();
  });

  it('fetchFinalRanks reads tournament_final_ranks best-first and degrades to []', async () => {
    const calls: unknown[][] = [];
    const fake = (result: { data: unknown; error: unknown }) => ({
      from(table: string) {
        calls.push(['from', table]);
        const q = {
          select(cols: string) { calls.push(['select', cols]); return q; },
          eq(col: string, v: string) { calls.push(['eq', col, v]); return q; },
          order(col: string, o: unknown) { calls.push(['order', col, o]); return Promise.resolve(result); },
        };
        return q;
      },
    }) as any;

    const rows = [{ user_id: 'a', final_rank: 1, wins: 2, losses: 0 }];
    expect(await fetchFinalRanks(fake({ data: rows, error: null }), 't1')).toEqual(rows);
    expect(calls).toEqual([
      ['from', 'tournament_final_ranks'],
      ['select', 'user_id, final_rank, wins, losses'],
      ['eq', 'tournament_id', 't1'],
      ['order', 'final_rank', { ascending: true }],
    ]);
    expect(await fetchFinalRanks(fake({ data: null, error: { message: 'offline' } }), 't1')).toEqual([]);
  });
});

describe('sortMlpTeamStandings', () => {
  it('orders by sub-matches won, then fewer lost, then seed, without mutating', () => {
    const rows = [
      { team_id: 'x', sub_matches_won: 5, sub_matches_lost: 3, seed: 2 },
      { team_id: 'y', sub_matches_won: 6, sub_matches_lost: 2, seed: 4 },
      { team_id: 'z', sub_matches_won: 5, sub_matches_lost: 2, seed: null },
      { team_id: 'w', sub_matches_won: 5, sub_matches_lost: 2, seed: 1 },
    ];
    const before = rows.map(r => r.team_id);
    expect(sortMlpTeamStandings(rows).map(r => r.team_id)).toEqual(['y', 'w', 'z', 'x']);
    expect(rows.map(r => r.team_id)).toEqual(before);
  });
});

// ── P5b additions: per-player table, pinned row, podium ─────────────────────

import { computePlayerStandings, pinMyRow, podiumFromFinalRanks, type PlayerStandingsMatch } from '../tournamentStandings';

describe('computePlayerStandings (mirror of the SQL per-user path)', () => {
  const pm = (t1: [string, string], t2: [string, string], winner: 'team1' | 'team2', games?: { t1: number; t2: number }[]): PlayerStandingsMatch => ({
    team1_player1: t1[0], team1_player2: t1[1], team2_player1: t2[0], team2_player2: t2[1],
    winner_team: winner, status: 'completed', game_scores: games ?? null,
  });
  const opts = () => ({
    entrants: ['a', 'b', 'c', 'd', 'e'],
    nameOf: (id: string) => id.toUpperCase(),
    isMe: (id: string) => id === 'c',
  });

  it('a match is one win or one loss for each player on its side', () => {
    const rows = computePlayerStandings([pm(['a', 'b'], ['c', 'd'], 'team1')], opts());
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    expect([by.a.wins, by.a.losses, by.c.wins, by.c.losses]).toEqual([1, 0, 0, 1]);
    expect(by.e).toMatchObject({ wins: 0, losses: 0 });
    expect(by.c.isMe).toBe(true);
  });
  it('best-of matches count games, as the SQL does', () => {
    const rows = computePlayerStandings([pm(['a', 'b'], ['c', 'd'], 'team1', [{ t1: 11, t2: 5 }, { t1: 8, t2: 11 }, { t1: 11, t2: 9 }])], opts());
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    expect([by.a.wins, by.a.losses, by.d.wins, by.d.losses]).toEqual([2, 1, 1, 2]);
  });
  it('order: wins desc, losses asc, then entrant order', () => {
    const rows = computePlayerStandings([
      pm(['a', 'b'], ['c', 'd'], 'team1'),
      pm(['a', 'c'], ['b', 'e'], 'team2'),
    ], opts());
    // b 2-0; e 1-0 beats a 1-1 on fewer losses; d 0-1 beats c 0-2.
    expect(rows.map(r => r.key)).toEqual(['b', 'e', 'a', 'd', 'c']);
  });
  it('pending matches do not count', () => {
    const rows = computePlayerStandings([{ ...pm(['a', 'b'], ['c', 'd'], 'team1'), status: 'pending' }], opts());
    expect(rows.every(r => r.wins === 0 && r.losses === 0)).toBe(true);
    expect(rows.map(r => r.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('points for and against per player, for the ± column', () => {
    const rows = computePlayerStandings([{ ...pm(['a', 'b'], ['c', 'd'], 'team1'), team1_score: 11, team2_score: 6 }], opts());
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    expect([by.a.pf, by.a.pa, by.d.pf, by.d.pa]).toEqual([11, 6, 6, 11]);
    expect(by.a.tieKey).toBe('a:a');
  });
  it('players level on W-L: PLUPR never decides; point diff, then the admin, then seed', () => {
    // a and b both 1-1. Any rating the caller has is not an input at all
    // (a stray ratingOf is ignored): b's higher PLUPR does not lift b.
    const ms = [
      { ...pm(['a', 'c'], ['b', 'd'], 'team1'), team1_score: 11, team2_score: 9 },
      { ...pm(['b', 'c'], ['a', 'd'], 'team1'), team1_score: 11, team2_score: 9 },
    ];
    const ratings: Record<string, number> = { a: 2.5, b: 5.0 };
    const base = { ...opts(), ratingOf: (id: string) => ratings[id], seedOf: (id: string) => ({ a: 1, b: 2 } as any)[id] } as any;
    const level = computePlayerStandings(ms, base);
    expect(level.slice(0, 2).map(r => r.key)).toEqual(['c', 'a']);
    const ab = level.filter(r => r.key === 'a' || r.key === 'b');
    expect(ab.map(r => r.key)).toEqual(['a', 'b']);
    expect(levelGroups(level).some(g => g.waiting && g.members.some(m => m.key === 'b'))).toBe(true);
    // The admin puts b first.
    const ordered = computePlayerStandings(ms, { ...base, tieRanks: { 'b:b': 1, 'a:a': 2, 'd:d': 3 } });
    const ab2 = ordered.filter(r => r.key === 'a' || r.key === 'b');
    expect(ab2.map(r => r.key)).toEqual(['b', 'a']);
  });
});

describe('pinMyRow', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ key: `p${i + 1}`, isMe: i === 9 }));
  it('top N plus the viewer pinned below the cut, with the hidden count', () => {
    const v = pinMyRow(rows, 8);
    expect(v.top.map(x => x.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(v.pinned).toMatchObject({ position: 10, row: { key: 'p10' } });
    expect(v.hidden).toBe(3);
  });
  it('no pin when the viewer is already in the top N', () => {
    const v = pinMyRow(rows, 10);
    expect(v.pinned).toBeNull();
    expect(v.hidden).toBe(2);
  });
});

describe('podiumFromFinalRanks', () => {
  it('groups shared ranks (doubles partners) and stops after N places', () => {
    const ranks: FinalRankRow[] = [
      { user_id: 'c', final_rank: 2, wins: 2, losses: 1 },
      { user_id: 'a', final_rank: 1, wins: 3, losses: 0 },
      { user_id: 'b', final_rank: 1, wins: 3, losses: 0 },
      { user_id: 'd', final_rank: 2, wins: 2, losses: 1 },
      { user_id: 'e', final_rank: 3, wins: 1, losses: 2 },
      { user_id: 'f', final_rank: 4, wins: 0, losses: 3 },
    ];
    expect(podiumFromFinalRanks(ranks)).toEqual([
      { rank: 1, userIds: ['a', 'b'] },
      { rank: 2, userIds: ['c', 'd'] },
      { rank: 3, userIds: ['e'] },
    ]);
    expect(podiumFromFinalRanks([])).toEqual([]);
  });
});
