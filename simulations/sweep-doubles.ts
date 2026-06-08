/**
 * Doubles fixed-pair generator simulations (Unit 5).
 *
 * Exercises the doubles generators in mobile/src/lib/tournament.ts that wrap
 * the singles generators by treating each fixed pair as a single token
 * `__T{i}`, then mapping the token back to the real 2-player pair.
 *
 * Sweeps team counts T ∈ {2,3,4,5,7,8,10,11} (and pool counts {2,3}) and
 * asserts structural invariants — most importantly that the `__T` token never
 * leaks into an emitted team (the back-mapping `slice(3)` must be correct,
 * especially for T ≥ 10 where tokens are `__T10`, `__T11`).
 *
 * Run: cd simulations && npx tsx sweep-doubles.ts
 */
import {
  generateDoublesRoundRobin,
  generateDoublesSingleElim,
  generateDoublesDoubleElim,
  generateDoublesPoolPlay,
  seedTeams,
  validateDoublesTeams,
  type MatchPairing,
} from '../mobile/src/lib/tournament';

// ── Reporting ────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function header(s: string) {
  console.log('\n\x1b[1m\x1b[36m═══ ' + s + ' ═══\x1b[0m');
}
function ok(s: string)  { passCount++; console.log('  \x1b[32m✓\x1b[0m ' + s); }
function bad(s: string) { failCount++; failures.push(s); console.log('  \x1b[31m✗ ' + s + '\x1b[0m'); }

function assertEq<T>(label: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(`${label} = ${a}`);
  else bad(`${label}: expected ${e}, got ${a}`);
}

function assertTrue(label: string, cond: boolean, detail?: string) {
  if (cond) ok(label);
  else bad(`${label}${detail ? ': ' + detail : ''}`);
}

// ── Helpers ──────────────────────────────────────────────────────
// Build T fixed pairs: [['T1A','T1B'],['T2A','T2B'],…].
function pairs(n: number): [string, string][] {
  return Array.from({ length: n }, (_, i) => [`T${i + 1}A`, `T${i + 1}B`]);
}

// A canonical key for a real team (order-independent).
function teamKey(t: [string, string?]): string {
  return [...t].filter(Boolean).sort().join('+');
}

function matchKey(m: MatchPairing): string {
  return [teamKey(m.team1), teamKey(m.team2)].sort().join(' vs ');
}

function prettyMatch(m: MatchPairing): string {
  const t1 = m.team1.filter(Boolean).join(' & ');
  const t2 = m.team2.filter(Boolean).join(' & ');
  return `${t1} vs ${t2}`;
}

function drawByRound(matches: MatchPairing[]): void {
  const byRound = new Map<number, MatchPairing[]>();
  for (const m of matches) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round)!.push(m);
  }
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const rms = byRound.get(round)!;
    console.log(`    Round ${round}: ` + rms.map(prettyMatch).join(', '));
  }
}

// Shared invariants that every doubles draw must satisfy.
// realPairsKeys: the set of valid real-team keys to draw from.
function assertWellFormedDoubles(
  ctx: string,
  matches: MatchPairing[],
  realPairsKeys: Set<string>,
) {
  // 1. The `__T` token (and the substring `__T`) is NEVER present anywhere.
  let tokenLeak = false;
  let leakDetail = '';
  for (const m of matches) {
    for (const p of [...m.team1, ...m.team2]) {
      if (typeof p === 'string' && p.includes('__T')) {
        tokenLeak = true;
        leakDetail = `found token "${p}" in match ${prettyMatch(m)}`;
        break;
      }
    }
    if (tokenLeak) break;
  }
  assertTrue(`${ctx}: no "__T" token leaks into any emitted team`, !tokenLeak, leakDetail);

  // 2. Every emitted team is a real 2-player pair drawn from the input pairs.
  let allReal = true;
  let realDetail = '';
  for (const m of matches) {
    for (const t of [m.team1, m.team2]) {
      const filled = t.filter(Boolean);
      if (filled.length !== 2) {
        allReal = false; realDetail = `team ${JSON.stringify(t)} is not a 2-player pair`; break;
      }
      if (!realPairsKeys.has(teamKey(t))) {
        allReal = false; realDetail = `team ${JSON.stringify(t)} is not one of the input pairs`; break;
      }
    }
    if (!allReal) break;
  }
  assertTrue(`${ctx}: every emitted team is a real input pair (2 players)`, allReal, realDetail);

  // 3. Within any single match, no player appears on both teams.
  let intraOk = true;
  let intraDetail = '';
  for (const m of matches) {
    const ids = [...m.team1, ...m.team2].filter(Boolean) as string[];
    if (new Set(ids).size !== ids.length) {
      intraOk = false; intraDetail = `match ${prettyMatch(m)} reuses a player`; break;
    }
  }
  assertTrue(`${ctx}: no player on both teams within a match`, intraOk, intraDetail);

  // 4. Across a round, no player is double-booked.
  const roundIds = new Map<number, string[]>();
  for (const m of matches) {
    if (!roundIds.has(m.round)) roundIds.set(m.round, []);
    roundIds.get(m.round)!.push(...([...m.team1, ...m.team2].filter(Boolean) as string[]));
  }
  let roundOk = true;
  let roundDetail = '';
  for (const [r, ids] of roundIds) {
    if (new Set(ids).size !== ids.length) {
      roundOk = false; roundDetail = `round ${r} double-books a player`; break;
    }
  }
  assertTrue(`${ctx}: no player double-booked across a round`, roundOk, roundDetail);
}

// ── Round Robin (doubles) ────────────────────────────────────────
function testDoublesRoundRobin(T: number) {
  header(`Doubles Round Robin · ${T} teams`);
  const ps = pairs(T);
  const ms = generateDoublesRoundRobin(ps);
  console.log(`    Total matchups: ${ms.length}`);
  drawByRound(ms);

  const realKeys = new Set(ps.map(p => teamKey(p)));
  assertWellFormedDoubles(`RR T=${T}`, ms, realKeys);

  // team-level T(T-1)/2 matchups
  const expected = (T * (T - 1)) / 2;
  assertEq(`RR T=${T}: matchup count`, ms.length, expected);

  // unique matchups
  const unique = new Set(ms.map(matchKey));
  assertEq(`RR T=${T}: unique matchups`, unique.size, expected);

  // every team plays T-1 matchups
  const counts = new Map<string, number>();
  for (const m of ms) {
    for (const t of [m.team1, m.team2]) {
      const k = teamKey(t);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const allEqual = [...counts.values()].every(c => c === T - 1) && counts.size === T;
  assertTrue(`RR T=${T}: every team plays ${T - 1} matchups`, allEqual,
    `counts: ${JSON.stringify([...counts])}`);
}

// ── Single Elim (doubles) ────────────────────────────────────────
function testDoublesSingleElim(T: number) {
  header(`Doubles Single Elimination · ${T} seeded teams`);
  const ps = pairs(T);
  const ms = generateDoublesSingleElim(ps);
  console.log(`    Round 1 matchups: ${ms.length}`);
  drawByRound(ms);

  const realKeys = new Set(ps.map(p => teamKey(p)));
  assertWellFormedDoubles(`SE T=${T}`, ms, realKeys);

  // bracketSize = next power of 2 ≥ T; round-1 count = bracketSize/2 - byes.
  let bracketSize = 1;
  while (bracketSize < T) bracketSize *= 2;
  const byes = bracketSize - T;
  const expectedR1 = bracketSize / 2 - byes;
  assertEq(`SE T=${T}: round-1 matchup count`, ms.length, expectedR1);

  // Round-1 pairing rule: team i (0-based) vs team (bracketSize-1-i), dropping
  // any pairing that touches a bye slot. So the surviving pairings are the
  // top `expectedR1` seeds vs the symmetric bottom seeds (1vT, 2v(T-1), …).
  const padded: ([string, string] | 'BYE')[] = [...ps];
  while (padded.length < bracketSize) padded.push('BYE');
  const expectedPairs: string[] = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    const a = padded[i];
    const b = padded[bracketSize - 1 - i];
    if (a !== 'BYE' && b !== 'BYE') {
      expectedPairs.push([teamKey(a), teamKey(b)].sort().join(' vs '));
    }
  }
  const actualPairs = ms.map(matchKey).sort();
  assertEq(`SE T=${T}: round-1 pairings match 1vT,2v(T-1),…`,
    actualPairs, [...expectedPairs].sort());

  // Each team appears at most once in round 1.
  const seen = new Set<string>();
  let dupe = false;
  for (const m of ms) {
    for (const t of [m.team1, m.team2]) {
      const k = teamKey(t);
      if (seen.has(k)) { dupe = true; break; }
      seen.add(k);
    }
  }
  assertTrue(`SE T=${T}: each team appears at most once in R1`, !dupe);
}

// ── Double Elim (doubles) ────────────────────────────────────────
function testDoublesDoubleElim(T: number) {
  header(`Doubles Double Elimination · ${T} seeded teams`);
  const ps = pairs(T);
  const de = generateDoublesDoubleElim(ps);
  const se = generateDoublesSingleElim(ps);
  console.log(`    Round 1 matchups: ${de.length}`);
  drawByRound(de);

  const realKeys = new Set(ps.map(p => teamKey(p)));
  assertWellFormedDoubles(`DE T=${T}`, de, realKeys);

  // Identical to doubles single-elim round 1 but every match tagged winners.
  const deStripped = de.map(({ bracket, ...rest }) => rest);
  assertEq(`DE T=${T}: round 1 identical to single-elim (ignoring bracket tag)`,
    deStripped, se);
  const allWinners = de.every(m => m.bracket === 'winners');
  assertTrue(`DE T=${T}: every match tagged bracket:'winners'`, allWinners);
}

// ── Pool Play (doubles) ──────────────────────────────────────────
function testDoublesPoolPlay(T: number, poolCount: number) {
  header(`Doubles Pool Play · ${T} teams in ${poolCount} pools`);
  const ps = pairs(T);
  const { pools, matches } = generateDoublesPoolPlay(ps, poolCount);
  console.log(`    Pool sizes: ${pools.map(p => p.length).join(', ')}`);
  pools.forEach((pool, i) =>
    console.log(`    Pool ${String.fromCharCode(65 + i)}: ${pool.map(t => t.join('&')).join(', ')}`));
  console.log(`    Total matches: ${matches.length}`);

  const realKeys = new Set(ps.map(p => teamKey(p)));
  assertWellFormedDoubles(`PP T=${T},pools=${poolCount}`, matches, realKeys);

  assertEq(`PP T=${T},pools=${poolCount}: pool count`, pools.length, poolCount);

  // Snake-draft assignment: 1→A, 2→B, …, poolCount→last, then reverse.
  const expectedPools: [string, string][][] =
    Array.from({ length: poolCount }, () => []);
  ps.forEach((team, i) => {
    const snakePos = i % (poolCount * 2);
    const poolIdx  = snakePos < poolCount ? snakePos : poolCount * 2 - 1 - snakePos;
    expectedPools[Math.min(poolIdx, poolCount - 1)].push(team);
  });
  assertEq(`PP T=${T},pools=${poolCount}: snake-draft pool assignment`,
    pools.map(p => p.map(teamKey)),
    expectedPools.map(p => p.map(teamKey)));

  // Balanced: max - min ≤ 1
  const sizes = pools.map(p => p.length);
  assertTrue(`PP T=${T},pools=${poolCount}: pool sizes balanced (Δ ≤ 1)`,
    Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes: ${sizes.join(',')}`);

  // Every team ends up in exactly one pool, no dupes, all accounted for.
  const pooledKeys = pools.flat().map(teamKey);
  assertEq(`PP T=${T},pools=${poolCount}: pooled team count`, pooledKeys.length, T);
  assertEq(`PP T=${T},pools=${poolCount}: pooled teams unique`, new Set(pooledKeys).size, T);
  // Compare as sorted arrays — JSON.stringify(Set) is always "{}", which would
  // make this assertion vacuous.
  assertEq(`PP T=${T},pools=${poolCount}: pooled teams == input teams`,
    [...new Set(pooledKeys)].sort(), [...realKeys].sort());

  // Total matches = sum of round-robin within each pool.
  const expectedMatches = pools.reduce((s, p) => s + (p.length * (p.length - 1)) / 2, 0);
  assertEq(`PP T=${T},pools=${poolCount}: total match count`, matches.length, expectedMatches);

  // Labels "Pool X · Round r" and correct poolIndex.
  let labelOk = true;
  let labelDetail = '';
  for (const m of matches) {
    const pi = m.poolIndex;
    if (pi === undefined || pi < 0 || pi >= poolCount) {
      labelOk = false; labelDetail = `bad poolIndex ${pi}`; break;
    }
    const expectedLabel = `Pool ${String.fromCharCode(65 + pi)} · Round ${m.round}`;
    if (m.label !== expectedLabel) {
      labelOk = false; labelDetail = `label "${m.label}" != "${expectedLabel}"`; break;
    }
  }
  assertTrue(`PP T=${T},pools=${poolCount}: every match labeled "Pool X · Round r" w/ correct poolIndex`,
    labelOk, labelDetail);

  // Each pool's matches only contain that pool's teams.
  let poolContainmentOk = true;
  let containDetail = '';
  for (let pi = 0; pi < poolCount; pi++) {
    const poolTeamKeys = new Set(pools[pi].map(teamKey));
    const poolMatches = matches.filter(m => m.poolIndex === pi);
    for (const m of poolMatches) {
      if (!poolTeamKeys.has(teamKey(m.team1)) || !poolTeamKeys.has(teamKey(m.team2))) {
        poolContainmentOk = false;
        containDetail = `pool ${pi} match ${prettyMatch(m)} contains a foreign team`;
        break;
      }
    }
    if (!poolContainmentOk) break;
  }
  assertTrue(`PP T=${T},pools=${poolCount}: each pool's matches contain only that pool's teams`,
    poolContainmentOk, containDetail);
}

// ── seedTeams ────────────────────────────────────────────────────
function testSeedTeams() {
  header(`seedTeams · elo (avg PLUPR) ordering`);
  // Partner averages: AB=(3.0+4.0)/2=3.5, CD=(5.0+2.0)/2=3.5,
  //                    EF=(4.8+4.8)/2=4.8, GH=(2.0+2.2)/2=2.1
  const teams: [string, string][] = [['A', 'B'], ['C', 'D'], ['E', 'F'], ['G', 'H']];
  const ratings: Record<string, number> = {
    A: 3.0, B: 4.0, C: 5.0, D: 2.0, E: 4.8, F: 4.8, G: 2.0, H: 2.2,
  };
  const seeded = seedTeams(teams, ratings, 'elo');
  // Expected descending by average: EF(4.8) > {AB,CD tie 3.5} > GH(2.1).
  // AB and CD tie; sort is stable so original relative order (AB before CD) holds.
  assertEq(`seedTeams elo: avg-PLUPR descending`, seeded,
    [['E', 'F'], ['A', 'B'], ['C', 'D'], ['G', 'H']]);

  // Missing ratings default to 3.25 per partner.
  const teams2: [string, string][] = [['X', 'Y'], ['Z', 'W']];
  const ratings2: Record<string, number> = { X: 5.0, Y: 5.0 }; // ZW defaults to 3.25
  const seeded2 = seedTeams(teams2, ratings2, 'elo');
  assertEq(`seedTeams elo: missing ratings default to 3.25`, seeded2,
    [['X', 'Y'], ['Z', 'W']]);

  // Random preserves the set (same teams, possibly reordered).
  const r = seedTeams(teams, ratings, 'random');
  // Compare as sorted arrays — JSON.stringify(Set) is always "{}", which would
  // make this (the sole guard that random mode neither drops nor duplicates a
  // team) pass vacuously.
  const sortedKeys = (ts: [string, string][]) => [...new Set(ts.map(teamKey))].sort();
  assertEq(`seedTeams random: preserves the set of teams`, sortedKeys(r), sortedKeys(teams));
  assertEq(`seedTeams random: preserves team count`, r.length, teams.length);
}

// ── validateDoublesTeams ─────────────────────────────────────────
function testValidateDoublesTeams() {
  header(`validateDoublesTeams · error flags`);

  // Valid set → null.
  assertEq(`valid teams → null`,
    validateDoublesTeams([['A', 'B'], ['C', 'D']]), null);

  // Incomplete team (missing partner).
  const incomplete = validateDoublesTeams([['A', 'B'], ['C', '']] as [string, string][]);
  assertEq(`incomplete team → INCOMPLETE_DOUBLES_TEAM`,
    incomplete?.code, 'INCOMPLETE_DOUBLES_TEAM');

  // Duplicate partner (same player twice on one team).
  const dupPartner = validateDoublesTeams([['A', 'A'], ['C', 'D']]);
  assertEq(`same player twice → DUPLICATE_PARTNER`,
    dupPartner?.code, 'DUPLICATE_PARTNER');

  // Player on multiple teams.
  const multi = validateDoublesTeams([['A', 'B'], ['A', 'D']]);
  assertEq(`player on two teams → PLAYER_ON_MULTIPLE_TEAMS`,
    multi?.code, 'PLAYER_ON_MULTIPLE_TEAMS');
}

// ── Run everything ───────────────────────────────────────────────
console.log('\n\x1b[1mPickleague doubles fixed-pair generator simulations (Unit 5)\x1b[0m');
console.log('All input/output is pure data — no Supabase round-trip.\n');

const TEAM_COUNTS = [2, 3, 4, 5, 7, 8, 10, 11];

testSeedTeams();
testValidateDoublesTeams();

for (const T of TEAM_COUNTS) testDoublesRoundRobin(T);
for (const T of TEAM_COUNTS) testDoublesSingleElim(T);
for (const T of TEAM_COUNTS) testDoublesDoubleElim(T);

// Pool play needs at least poolCount*2 teams per pool-count.
for (const T of TEAM_COUNTS) {
  for (const poolCount of [2, 3]) {
    if (T >= poolCount * 2) testDoublesPoolPlay(T, poolCount);
  }
}

// ── Summary ──────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`\x1b[1m${passCount + failCount} assertions · `
  + `\x1b[32m${passCount} passed\x1b[0m\x1b[1m`
  + (failCount ? `, \x1b[31m${failCount} failed\x1b[0m` : '')
  + '\x1b[0m');

if (failCount > 0) {
  console.log('\n\x1b[31mFailures:\x1b[0m');
  failures.forEach(f => console.log('  • ' + f));
  process.exit(1);
}
