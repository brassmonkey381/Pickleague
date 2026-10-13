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
import { buildStandingsComparator, teamKey } from '../tournamentTiebreakers';

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
 * (migration_unify_tournament_rankings.sql / migration_fix_champion_rank_collision.sql)
 * for round robin and pool play, where there is no finals round and so no
 * champion / grand-final-loser pin. Written from the SQL, not from
 * tournamentTiebreakers.ts, so agreement between the two is a real check:
 *   pre:    row_number() over (wins desc, point_diff desc, seed asc)
 *   ties_2: wins buckets of exactly 2 → head-to-head over all completed matches
 *   rank:   row_number() over (wins desc, h2h_score desc, point_diff desc, seed asc)
 * Both partners carry the team's rank; approved entrants with no completed
 * match trail by seed.
 */
function sqlTeamPathRanks(
  matches: StandingsMatch[],
  seeds: Record<string, number>,
  approved: string[] = [],
): FinalRankRow[] {
  type Agg = { lo: string; hi: string; wins: number; losses: number; pd: number; seed: number };
  const lohi = (p1: string, p2: string | null): [string, string] => {
    const b = p2 ?? p1;
    return p1 < b ? [p1, b] : [b, p1];
  };
  const done = matches.filter(x => x.status === 'completed' && (x.winner_team === 'team1' || x.winner_team === 'team2'));
  const agg = new Map<string, Agg>();
  const add = (p1: string | null, p2: string | null, pf: number, pa: number, w: number, l: number) => {
    if (!p1) return;
    const [lo, hi] = lohi(p1, p2);
    const k = `${lo}|${hi}`;
    const a = agg.get(k) ?? { lo, hi, wins: 0, losses: 0, pd: 0, seed: Math.min(seeds[lo] ?? 999, seeds[hi] ?? 999) };
    a.wins += w; a.losses += l; a.pd += pf - pa;
    agg.set(k, a);
  };
  for (const x of done) {
    const t1won = x.winner_team === 'team1' ? 1 : 0;
    add(x.team1_player1, x.team1_player2, x.team1_score ?? 0, x.team2_score ?? 0, t1won, 1 - t1won);
    add(x.team2_player1, x.team2_player2, x.team2_score ?? 0, x.team1_score ?? 0, 1 - t1won, t1won);
  }
  const teams = [...agg.values()];
  const pre = [...teams].sort((a, b) => b.wins - a.wins || b.pd - a.pd || a.seed - b.seed);
  const h2hScore = new Map<Agg, number>();
  const byWins = new Map<number, Agg[]>();
  for (const t of pre) byWins.set(t.wins, [...(byWins.get(t.wins) ?? []), t]);
  for (const group of byWins.values()) {
    if (group.length !== 2) continue;
    const [e1, e2] = group;
    let w1 = 0; let w2 = 0;
    for (const x of done) {
      const a = lohi(x.team1_player1!, x.team1_player2);
      const b = lohi(x.team2_player1!, x.team2_player2);
      const is = (s: [string, string], t: Agg) => s[0] === t.lo && s[1] === t.hi;
      if ((is(a, e1) && is(b, e2) && x.winner_team === 'team1') || (is(b, e1) && is(a, e2) && x.winner_team === 'team2')) w1++;
      if ((is(a, e2) && is(b, e1) && x.winner_team === 'team1') || (is(b, e2) && is(a, e1) && x.winner_team === 'team2')) w2++;
    }
    if (w1 !== w2) {
      h2hScore.set(e1, w1 > w2 ? 1 : -1);
      h2hScore.set(e2, w2 > w1 ? 1 : -1);
    }
  }
  const ranked = [...pre].sort((a, b) =>
    b.wins - a.wins
    || (h2hScore.get(b) ?? 0) - (h2hScore.get(a) ?? 0)
    || b.pd - a.pd
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
    // 5-player round robin with two exact 2-way ties on wins: b and c on 2,
    // d and e on 1. In each pair the head-to-head winner has the WORSE point
    // diff (c +15 vs b -15, d -8 vs e -16), so H2H has to come first.
    name: 'exact 2-way ties go to head-to-head before point diff',
    matches: [
      m(['a'], ['b'], 'team1', 11, 5), m(['a'], ['c'], 'team1', 11, 5),
      m(['a'], ['d'], 'team1', 11, 5), m(['a'], ['e'], 'team1', 11, 5),
      m(['b'], ['c'], 'team1', 11, 10), m(['d'], ['b'], 'team1', 11, 0), m(['b'], ['e'], 'team1', 11, 10),
      m(['c'], ['d'], 'team1', 11, 0), m(['c'], ['e'], 'team1', 11, 0),
      m(['d'], ['e'], 'team2', 9, 11),
    ],
    seeds: { a: 1, b: 2, c: 3, d: 4, e: 5 },
    expected: ['a', 'b', 'c', 'e', 'd'],
  },
  {
    // a, b and c all 2-1: head-to-head is skipped for a 3-way tie and point
    // diff decides (c +21, b +1, a -7).
    name: '3-way tie on wins skips head-to-head',
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
    name: 'everything tied falls to registration seed',
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
    // merge into one entrant, and point diff (not H2H) separates the three.
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
      const viaComparator = [...table].sort(buildStandingsComparator(table, f.matches));
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

  it('matches the pre-extraction inline TournamentDetail tally row for row', () => {
    // The Live Standings block as it was inlined in TournamentDetailScreen
    // before P5a, copied verbatim (minus JSX). The pool table was the same
    // code over one pool's matches.
    function legacyStandings(savedMatches: any[], myUserId: string | null, profileNames: Record<string, string>) {
      type Stat = {
        key: string; name: string; isMe: boolean;
        wins: number; losses: number; pf: number; pa: number;
      };
      const teamKeyL = (p1: string, p2: string | null) =>
        p2 ? [p1, p2].sort().join('|') : p1;
      const teamName = (p1: string | null, p2: string | null): string => {
        if (!p1) return '?';
        const n1 = profileNames[p1] ?? '?';
        const n2 = p2 ? (profileNames[p2] ?? '?') : null;
        return n2 ? `${n1} & ${n2}` : n1;
      };
      const stats = new Map<string, Stat>();
      const ensure = (p1: string | null, p2: string | null): Stat | null => {
        if (!p1) return null;
        const key = teamKeyL(p1, p2);
        if (!stats.has(key)) {
          stats.set(key, {
            key, name: teamName(p1, p2),
            isMe: p1 === myUserId || (!!p2 && p2 === myUserId),
            wins: 0, losses: 0, pf: 0, pa: 0,
          });
        }
        return stats.get(key)!;
      };
      for (const m of savedMatches) {
        const t1 = ensure(m.team1_player1, m.team1_player2);
        const t2 = ensure(m.team2_player1, m.team2_player2);
        if (!t1 || !t2) continue;
        if (m.status === 'completed' && m.winner_team) {
          t1.pf += m.team1_score ?? 0; t1.pa += m.team2_score ?? 0;
          t2.pf += m.team2_score ?? 0; t2.pa += m.team1_score ?? 0;
          if (m.winner_team === 'team1') { t1.wins++; t2.losses++; }
          else                            { t2.wins++; t1.losses++; }
        }
      }
      const entries = Array.from(stats.values());
      const tbMatches = savedMatches.map((m: any) => ({
        team1_player1: m.team1_player1,
        team1_player2: m.team1_player2,
        team2_player1: m.team2_player1,
        team2_player2: m.team2_player2,
        winner_team: m.winner_team,
        status: m.status,
      }));
      return entries.sort(buildStandingsComparator(entries, tbMatches));
    }

    for (const f of FIXTURES) {
      const ids = new Set(f.matches.flatMap(x => [x.team1_player1, x.team1_player2, x.team2_player1, x.team2_player2]));
      const profileNames: Record<string, string> = {};
      for (const id of ids) if (id) profileNames[id] = id.toUpperCase();
      const me = f.matches[0].team2_player1;
      const fromLib = computeTeamStandings(f.matches, {
        nameOf: (p1, p2) => {
          const n1 = profileNames[p1] ?? '?';
          const n2 = p2 ? (profileNames[p2] ?? '?') : null;
          return n2 ? `${n1} & ${n2}` : n1;
        },
        isMe: (p1, p2) => p1 === me || (!!p2 && p2 === me),
      });
      expect(fromLib).toEqual(legacyStandings(f.matches, me, profileNames));
    }
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
  const opts = (ratings: Record<string, number> = {}) => ({
    entrants: ['a', 'b', 'c', 'd', 'e'],
    nameOf: (id: string) => id.toUpperCase(),
    isMe: (id: string) => id === 'c',
    ratingOf: (id: string) => ratings[id],
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
  it('order: wins desc, losses asc, rating desc, then entrant order', () => {
    const rows = computePlayerStandings([
      pm(['a', 'b'], ['c', 'd'], 'team1'),
      pm(['a', 'c'], ['b', 'e'], 'team2'),
    ], opts({ b: 3.1, a: 4.0, e: 3.9 }));
    // b 2-0; e 1-0 beats a 1-1 on fewer losses (a's 4.0 rating never gets
    // a say); d 0-1 beats c 0-2.
    expect(rows.map(r => r.key)).toEqual(['b', 'e', 'a', 'd', 'c']);
  });
  it('pending matches do not count', () => {
    const rows = computePlayerStandings([{ ...pm(['a', 'b'], ['c', 'd'], 'team1'), status: 'pending' }], opts());
    expect(rows.every(r => r.wins === 0 && r.losses === 0)).toBe(true);
    expect(rows.map(r => r.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Equal records: PLUPR decides.
    const rated = computePlayerStandings([], opts({ d: 5.0, b: 4.2 }));
    expect(rated.map(r => r.key)).toEqual(['d', 'b', 'a', 'c', 'e']);
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
