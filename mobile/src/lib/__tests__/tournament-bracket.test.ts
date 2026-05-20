import { describe, it, expect } from 'vitest';
import {
  seedPlayers,
  seedTeams,
  validateDoublesTeams,
  validateMlpTeams,
  validatePools,
  assignPools,
  generateRoundRobin,
  generatePoolPlay,
  generateSingleElim,
  generateRotatingPartners,
  generateMLPSchedule,
  generateDoubleElim,
  generateDoublesRoundRobin,
  generateDoublesSingleElim,
  generateDoublesDoubleElim,
  generateDoublesPoolPlay,
  FORMAT_META,
  type MatchPairing,
} from '../tournament';

// ── Helpers ───────────────────────────────────────────────────

function pairKey(m: MatchPairing): string {
  const a = m.team1.filter(Boolean).join('+');
  const b = m.team2.filter(Boolean).join('+');
  return [a, b].sort().join('|');
}

function players(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `s${i + 1}`);
}

function teams(n: number): [string, string][] {
  return Array.from({ length: n }, (_, i) => [`t${i + 1}a`, `t${i + 1}b`] as [string, string]);
}

// ── seedPlayers ───────────────────────────────────────────────

describe('seedPlayers', () => {
  it('sorts by PLUPR descending in elo mode', () => {
    const ratings = { s1: 3.0, s2: 5.0, s3: 4.0 };
    expect(seedPlayers(['s1', 's2', 's3'], ratings, 'elo')).toEqual(['s2', 's3', 's1']);
  });

  it('falls back to 3.25 for missing ratings', () => {
    const ratings = { s2: 5.0 };
    expect(seedPlayers(['s1', 's2', 's3'], ratings, 'elo')[0]).toBe('s2');
  });

  it('random mode preserves all elements', () => {
    const result = seedPlayers(['s1', 's2', 's3'], {}, 'random');
    expect(result).toHaveLength(3);
    expect(new Set(result)).toEqual(new Set(['s1', 's2', 's3']));
  });
});

// ── seedTeams ─────────────────────────────────────────────────

describe('seedTeams', () => {
  it('sorts teams by combined PLUPR average descending', () => {
    const ratings = { a1: 5.0, a2: 5.0, b1: 3.0, b2: 3.0, c1: 4.0, c2: 4.0 };
    const t: [string, string][] = [
      ['b1', 'b2'],
      ['a1', 'a2'],
      ['c1', 'c2'],
    ];
    expect(seedTeams(t, ratings, 'elo')).toEqual([
      ['a1', 'a2'],
      ['c1', 'c2'],
      ['b1', 'b2'],
    ]);
  });
});

// ── validateDoublesTeams ──────────────────────────────────────

describe('validateDoublesTeams', () => {
  it('returns null for valid teams', () => {
    expect(validateDoublesTeams([['a', 'b'], ['c', 'd']])).toBeNull();
  });

  it('flags an incomplete team', () => {
    const err = validateDoublesTeams([['a', ''], ['c', 'd']]);
    expect(err?.code).toBe('INCOMPLETE_DOUBLES_TEAM');
  });

  it('flags a team with the same player twice', () => {
    const err = validateDoublesTeams([['a', 'a'], ['c', 'd']]);
    expect(err?.code).toBe('DUPLICATE_PARTNER');
  });

  it('flags a player on multiple teams', () => {
    const err = validateDoublesTeams([['a', 'b'], ['a', 'd']]);
    expect(err?.code).toBe('PLAYER_ON_MULTIPLE_TEAMS');
  });
});

// ── validateMlpTeams ──────────────────────────────────────────

describe('validateMlpTeams', () => {
  const fullTeam = (id: string) => ({
    id,
    name: `Team ${id}`,
    male_1_id: `${id}_m1`,
    male_2_id: `${id}_m2`,
    female_1_id: `${id}_f1`,
    female_2_id: `${id}_f2`,
  });

  it('returns null for valid teams', () => {
    expect(validateMlpTeams([fullTeam('A'), fullTeam('B')])).toBeNull();
  });

  it('flags when fewer than 2 teams', () => {
    const err = validateMlpTeams([fullTeam('A')]);
    expect(err?.code).toBe('NOT_ENOUGH_MLP_TEAMS');
  });

  it('flags an incomplete team', () => {
    const t = { ...fullTeam('A'), female_2_id: null };
    const err = validateMlpTeams([t, fullTeam('B')]);
    expect(err?.code).toBe('INCOMPLETE_MLP_TEAM');
  });

  it('flags a duplicate within a team', () => {
    const t = { ...fullTeam('A'), male_2_id: 'A_m1' };
    const err = validateMlpTeams([t, fullTeam('B')]);
    expect(err?.code).toBe('DUPLICATE_PLAYER_IN_MLP_TEAM');
  });

  it('flags a player on multiple teams', () => {
    const a = fullTeam('A');
    const b = { ...fullTeam('B'), male_1_id: a.male_1_id };
    const err = validateMlpTeams([a, b]);
    expect(err?.code).toBe('PLAYER_ON_MULTIPLE_MLP_TEAMS');
  });
});

// ── assignPools ───────────────────────────────────────────────

describe('assignPools (snake-draft)', () => {
  it('distributes 12 players into 3 pools per the doc-canonical pattern', () => {
    // Documented in docs/tournament-formats/seeding-and-tiebreakers.md and
    // bracket-verification.md: A=[s1,s6,s7,s12], B=[s2,s5,s8,s11], C=[s3,s4,s9,s10].
    const pools = assignPools(players(12), 3);
    expect(pools[0]).toEqual(['s1', 's6', 's7', 's12']);
    expect(pools[1]).toEqual(['s2', 's5', 's8', 's11']);
    expect(pools[2]).toEqual(['s3', 's4', 's9', 's10']);
  });

  it('distributes 8 players into 2 pools by snake order', () => {
    const pools = assignPools(players(8), 2);
    expect(pools[0]).toEqual(['s1', 's4', 's5', 's8']);
    expect(pools[1]).toEqual(['s2', 's3', 's6', 's7']);
  });

  it('distributes 16 players into 4 pools by snake order', () => {
    const pools = assignPools(players(16), 4);
    expect(pools[0]).toEqual(['s1', 's8', 's9', 's16']);
    expect(pools[1]).toEqual(['s2', 's7', 's10', 's15']);
    expect(pools[2]).toEqual(['s3', 's6', 's11', 's14']);
    expect(pools[3]).toEqual(['s4', 's5', 's12', 's13']);
  });

  it('throws for poolCount < 1', () => {
    expect(() => assignPools(players(4), 0)).toThrow();
  });

  it('throws when too few players for the requested pool count', () => {
    expect(() => assignPools(players(3), 2)).toThrow();
  });
});

// ── generateRoundRobin ────────────────────────────────────────

describe('generateRoundRobin', () => {
  it('produces N(N-1)/2 unique pairings for N=8', () => {
    const matches = generateRoundRobin(players(8));
    expect(matches).toHaveLength(28);
    const pairs = new Set(matches.map(pairKey));
    expect(pairs.size).toBe(28);
  });

  it('runs N-1 rounds for N=8', () => {
    const matches = generateRoundRobin(players(8));
    const rounds = new Set(matches.map(m => m.round));
    expect(rounds.size).toBe(7);
    expect([...rounds].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('every player plays every other exactly once (N=6)', () => {
    const matches = generateRoundRobin(players(6));
    expect(matches).toHaveLength(15); // 6*5/2
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        const found = matches.find(m => {
          const set = new Set([m.team1[0], m.team2[0]]);
          return set.has(`s${i + 1}`) && set.has(`s${j + 1}`);
        });
        expect(found, `s${i + 1} vs s${j + 1} should exist`).toBeDefined();
      }
    }
  });

  it('handles odd N by padding with BYE and skipping BYE matches', () => {
    const matches = generateRoundRobin(players(5));
    // 5 players → 5 rounds, each round has 1 player on BYE, so 2 matches × 5 = 10
    expect(matches).toHaveLength(10);
    // Every player should appear in 4 matches (plays every other once)
    for (let i = 0; i < 5; i++) {
      const me = `s${i + 1}`;
      const myMatches = matches.filter(m => m.team1[0] === me || m.team2[0] === me);
      expect(myMatches).toHaveLength(4);
    }
    // No match should reference 'BYE'
    expect(matches.every(m => m.team1[0] !== 'BYE' && m.team2[0] !== 'BYE')).toBe(true);
  });

  it('matchOrder is sequential within a round', () => {
    const matches = generateRoundRobin(players(8));
    const r1 = matches.filter(m => m.round === 1).map(m => m.matchOrder);
    expect(r1).toEqual([0, 1, 2, 3]);
  });

  it('throws on N < 2', () => {
    expect(() => generateRoundRobin([])).toThrow();
    expect(() => generateRoundRobin(['only'])).toThrow();
  });
});

// ── generatePoolPlay ──────────────────────────────────────────

describe('generatePoolPlay', () => {
  it('runs RR within each of 3 pools for 12 players', () => {
    const { pools, matches } = generatePoolPlay(players(12), 3);
    expect(pools).toHaveLength(3);
    expect(pools.every(p => p.length === 4)).toBe(true);

    // 4-player RR = 6 matches per pool × 3 pools = 18 total
    expect(matches).toHaveLength(18);

    // Each pool tagged with poolIndex and labeled "Pool X · Round N"
    const poolACount = matches.filter(m => m.poolIndex === 0).length;
    const poolBCount = matches.filter(m => m.poolIndex === 1).length;
    const poolCCount = matches.filter(m => m.poolIndex === 2).length;
    expect(poolACount).toBe(6);
    expect(poolBCount).toBe(6);
    expect(poolCCount).toBe(6);

    expect(matches.find(m => m.poolIndex === 0)?.label).toMatch(/^Pool A · Round \d+$/);
    expect(matches.find(m => m.poolIndex === 1)?.label).toMatch(/^Pool B · Round \d+$/);
    expect(matches.find(m => m.poolIndex === 2)?.label).toMatch(/^Pool C · Round \d+$/);
  });

  it('cross-pool matches do not exist (every match is within one pool)', () => {
    const { pools, matches } = generatePoolPlay(players(12), 3);
    for (const m of matches) {
      const pool = pools[m.poolIndex!];
      expect(pool.includes(m.team1[0])).toBe(true);
      expect(pool.includes(m.team2[0])).toBe(true);
    }
  });

  it('handles 16 players into 4 pools', () => {
    const { pools, matches } = generatePoolPlay(players(16), 4);
    expect(pools).toHaveLength(4);
    expect(pools.every(p => p.length === 4)).toBe(true);
    expect(matches).toHaveLength(24); // 6 matches × 4 pools
  });
});

// ── generateSingleElim ────────────────────────────────────────

describe('generateSingleElim', () => {
  it('pairs top seed vs bottom seed in round 1 for N=8', () => {
    const r1 = generateSingleElim(players(8));
    expect(r1).toHaveLength(4);
    // s1 vs s8, s2 vs s7, s3 vs s6, s4 vs s5
    const pairs = r1.map(m => [m.team1[0], m.team2[0]].sort().join('-'));
    expect(pairs.sort()).toEqual(['s1-s8', 's2-s7', 's3-s6', 's4-s5']);
  });

  it('pairs 1v4 and 2v3 for N=4', () => {
    const r1 = generateSingleElim(players(4));
    expect(r1).toHaveLength(2);
    const pairs = r1.map(m => [m.team1[0], m.team2[0]].sort().join('-'));
    expect(pairs.sort()).toEqual(['s1-s4', 's2-s3']);
  });

  it('pairs 1v16 .. 8v9 for N=16', () => {
    const r1 = generateSingleElim(players(16));
    expect(r1).toHaveLength(8);
    // Compare as numeric pairs so we don't trip over "s10" < "s2" lex order.
    const numericPairs = r1.map(m => {
      const a = parseInt((m.team1[0] as string).slice(1), 10);
      const b = parseInt((m.team2[0] as string).slice(1), 10);
      return a < b ? `${a}v${b}` : `${b}v${a}`;
    });
    expect(new Set(numericPairs)).toEqual(
      new Set(['1v16', '2v15', '3v14', '4v13', '5v12', '6v11', '7v10', '8v9']),
    );
  });

  it('pads non-power-of-2 N with BYEs (top seeds advance automatically)', () => {
    // N=5 → padded to 8 with 3 BYEs. Round 1 should produce only the matches
    // where neither side is a BYE. s1, s2, s3 all face BYE and get a free
    // round-1 win; only s4 vs s5 is an actual match.
    const r1 = generateSingleElim(players(5));
    expect(r1).toHaveLength(1);
    const pair = [r1[0].team1[0], r1[0].team2[0]].sort().join('-');
    expect(pair).toBe('s4-s5');
  });

  it('all round-1 matches have round=1 and sequential matchOrder', () => {
    const r1 = generateSingleElim(players(8));
    expect(r1.every(m => m.round === 1)).toBe(true);
    const orders = r1.map(m => m.matchOrder).sort((a, b) => a - b);
    expect(orders).toEqual([0, 1, 2, 3]);
  });

  it('throws on N < 2', () => {
    expect(() => generateSingleElim([])).toThrow();
    expect(() => generateSingleElim(['only'])).toThrow();
  });
});

// ── generateDoubleElim ────────────────────────────────────────

describe('generateDoubleElim', () => {
  it('returns the same round-1 pairings as single-elim, tagged bracket=winners', () => {
    const seeds = players(8);
    const se = generateSingleElim(seeds);
    const de = generateDoubleElim(seeds);

    expect(de).toHaveLength(se.length);
    expect(de.every(m => m.bracket === 'winners')).toBe(true);

    const sePairs = se.map(m => [m.team1[0], m.team2[0]].sort().join('-')).sort();
    const dePairs = de.map(m => [m.team1[0], m.team2[0]].sort().join('-')).sort();
    expect(dePairs).toEqual(sePairs);
  });
});

// ── generateRotatingPartners ──────────────────────────────────

describe('generateRotatingPartners', () => {
  it('returns empty for N < 4', () => {
    expect(generateRotatingPartners(players(2), 3)).toEqual([]);
    expect(generateRotatingPartners(players(3), 3)).toEqual([]);
  });

  it('produces (N/4) * rounds matches when N is a multiple of 4', () => {
    const matches = generateRotatingPartners(players(8), 3);
    expect(matches).toHaveLength(6); // 8/4 * 3
    expect(matches.every(m => m.team1.length === 2 && m.team2.length === 2)).toBe(true);
  });

  it('every match has 4 distinct players', () => {
    const matches = generateRotatingPartners(players(8), 5);
    for (const m of matches) {
      const ids = new Set([...m.team1, ...m.team2]);
      expect(ids.size).toBe(4);
      expect(ids.has('BYE')).toBe(false);
    }
  });

  it('rotation produces different partner pairs across rounds (N=8)', () => {
    const matches = generateRotatingPartners(players(8), 7);
    // Collect (player, partner) pairs from team1 and team2 across all matches
    const partnerOf: Record<string, Set<string>> = {};
    for (const m of matches) {
      const [a, b] = m.team1 as [string, string];
      const [c, d] = m.team2 as [string, string];
      (partnerOf[a] ??= new Set()).add(b);
      (partnerOf[b] ??= new Set()).add(a);
      (partnerOf[c] ??= new Set()).add(d);
      (partnerOf[d] ??= new Set()).add(c);
    }
    // With rotation, the fixed player (s1) should pair with at least 3 different
    // partners over 7 rounds (the rotation visits multiple positions).
    expect(partnerOf['s1'].size).toBeGreaterThanOrEqual(3);
  });
});

// ── generateMLPSchedule ───────────────────────────────────────

describe('generateMLPSchedule', () => {
  it('runs round-robin between N teams', () => {
    const t = teams(4); // 4 teams → 6 team-meetings
    const matches = generateMLPSchedule(t);
    expect(matches).toHaveLength(6);
    // Each pairing is two team-tuples (length 2)
    expect(matches.every(m => m.team1.length === 2 && m.team2.length === 2)).toBe(true);
  });

  it('every pair of teams plays exactly once (N=4)', () => {
    const t = teams(4);
    const matches = generateMLPSchedule(t);
    const seenPairs = new Set<string>();
    for (const m of matches) {
      const a = (m.team1 as [string, string]).join('+');
      const b = (m.team2 as [string, string]).join('+');
      const key = [a, b].sort().join('|');
      expect(seenPairs.has(key)).toBe(false);
      seenPairs.add(key);
    }
    expect(seenPairs.size).toBe(6);
  });

  it('throws on fewer than 2 teams', () => {
    expect(() => generateMLPSchedule([])).toThrow();
    expect(() => generateMLPSchedule([['a', 'b']])).toThrow();
  });
});

// ── generateDoublesRoundRobin ─────────────────────────────────

describe('generateDoublesRoundRobin', () => {
  it('runs RR between fixed pairs', () => {
    const t = teams(4);
    const matches = generateDoublesRoundRobin(t);
    expect(matches).toHaveLength(6); // 4*3/2
    expect(matches.every(m => m.team1.length === 2 && m.team2.length === 2)).toBe(true);
  });

  it('does not leak the internal __T tokens into team tuples', () => {
    const t = teams(4);
    const matches = generateDoublesRoundRobin(t);
    for (const m of matches) {
      for (const id of [...m.team1, ...m.team2]) {
        expect(id).not.toMatch(/^__T/);
      }
    }
  });
});

// ── generateDoublesSingleElim ─────────────────────────────────

describe('generateDoublesSingleElim', () => {
  it('produces 2 round-1 matches for 4 teams', () => {
    const t = teams(4);
    const r1 = generateDoublesSingleElim(t);
    expect(r1).toHaveLength(2);
  });

  it('seeds team[0] vs team[3], team[1] vs team[2] for 4 teams', () => {
    const t = teams(4); // t1*, t2*, t3*, t4*
    const r1 = generateDoublesSingleElim(t);
    const pairs = r1.map(m =>
      [(m.team1 as [string, string]).join('+'), (m.team2 as [string, string]).join('+')]
        .sort()
        .join('|'),
    );
    expect(pairs.sort()).toEqual([
      ['t1a+t1b', 't4a+t4b'].sort().join('|'),
      ['t2a+t2b', 't3a+t3b'].sort().join('|'),
    ].sort());
  });
});

// ── generateDoublesDoubleElim ─────────────────────────────────

describe('generateDoublesDoubleElim', () => {
  it('returns the same round-1 as doubles single-elim, tagged bracket=winners', () => {
    const t = teams(4);
    const se = generateDoublesSingleElim(t);
    const de = generateDoublesDoubleElim(t);
    expect(de).toHaveLength(se.length);
    expect(de.every(m => m.bracket === 'winners')).toBe(true);
  });
});

// ── generateDoublesPoolPlay ───────────────────────────────────

describe('generateDoublesPoolPlay', () => {
  it('snake-drafts 8 teams into 2 pools and runs RR within each', () => {
    const t = teams(8);
    const { pools, matches } = generateDoublesPoolPlay(t, 2);
    expect(pools).toHaveLength(2);
    expect(pools.every(p => p.length === 4)).toBe(true);
    expect(matches).toHaveLength(12); // 4*3/2 = 6 per pool × 2 pools

    // Snake-draft order for 8 teams, 2 pools: A=[t1,t4,t5,t8], B=[t2,t3,t6,t7]
    expect(pools[0].map(p => p[0])).toEqual(['t1a', 't4a', 't5a', 't8a']);
    expect(pools[1].map(p => p[0])).toEqual(['t2a', 't3a', 't6a', 't7a']);
  });

  it('every match stays within its pool', () => {
    const t = teams(8);
    const { pools, matches } = generateDoublesPoolPlay(t, 2);
    for (const m of matches) {
      const pool = pools[m.poolIndex!];
      const poolFirsts = new Set(pool.map(p => p[0]));
      expect(poolFirsts.has((m.team1 as [string, string])[0])).toBe(true);
      expect(poolFirsts.has((m.team2 as [string, string])[0])).toBe(true);
    }
  });
});

// ── validatePools ─────────────────────────────────────────────

describe('validatePools', () => {
  it('returns null for valid pools', () => {
    const { pools, matches } = generatePoolPlay(players(8), 2);
    expect(validatePools(pools, 2, matches)).toBeNull();
  });

  it('flags a wrong pool count', () => {
    const { pools, matches } = generatePoolPlay(players(8), 2);
    const err = validatePools(pools, 3, matches);
    expect(err?.code).toBe('WRONG_POOL_COUNT');
  });

  it('flags an underfull pool', () => {
    const pools = [['s1', 's2'], ['s3']];
    const matches: MatchPairing[] = [
      { round: 1, matchOrder: 0, team1: ['s1'], team2: ['s2'], label: 'Pool A · Round 1' },
    ];
    const err = validatePools(pools, 2, matches);
    expect(err?.code).toBe('POOL_UNDERFULL');
  });

  it('flags a pool with no matches', () => {
    const pools = [['s1', 's2'], ['s3', 's4']];
    const matches: MatchPairing[] = [
      { round: 1, matchOrder: 0, team1: ['s1'], team2: ['s2'], label: 'Pool A · Round 1' },
    ];
    const err = validatePools(pools, 2, matches);
    expect(err?.code).toBe('POOL_HAS_NO_MATCHES');
  });
});

// ── FORMAT_META ───────────────────────────────────────────────

describe('FORMAT_META', () => {
  it('has an entry for every TournamentFormat', () => {
    const expected = [
      'round_robin', 'single_elimination', 'double_elimination',
      'pool_play', 'mlp', 'mlp_random', 'rotating_partners',
    ];
    expect(Object.keys(FORMAT_META).sort()).toEqual(expected.sort());
  });

  it('every entry has label, icon, description', () => {
    for (const meta of Object.values(FORMAT_META)) {
      expect(meta.label).toBeTruthy();
      expect(meta.icon).toBeTruthy();
      expect(meta.description).toBeTruthy();
    }
  });
});
