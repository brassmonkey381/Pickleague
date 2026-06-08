/**
 * Pool Play (singles) sweep — Unit 3.
 *
 * Exhaustively verifies the singles pool-play generators from
 * mobile/src/lib/tournament.ts across a wide range of (N players, poolCount)
 * combinations, asserts structural invariants, and exercises the error +
 * validation paths.
 *
 * Owned functions under test: generatePoolPlay, assignPools, validatePools.
 *
 * Run: cd simulations && npx tsx sweep-pool-play.ts
 */
import {
  generatePoolPlay,
  assignPools,
  validatePools,
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

function assertThrows(label: string, fn: () => unknown) {
  try {
    fn();
    bad(`${label}: expected to throw, but it returned normally`);
  } catch {
    ok(`${label} threw as expected`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function players(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `P${i + 1}`);
}

const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * Reference snake-draft, derived independently from the documented rule:
 *   seed 1→A, 2→B, …, poolCount→last, then reverse, wrapping back to A.
 * Returns string[][] of pools holding the 1-based seed labels (`P1`, …).
 */
function expectedSnakePools(n: number, poolCount: number): string[][] {
  const pools: string[][] = Array.from({ length: poolCount }, () => []);
  for (let i = 0; i < n; i++) {
    const cycle = i % (poolCount * 2);
    const idx = cycle < poolCount ? cycle : poolCount * 2 - 1 - cycle;
    pools[idx].push(`P${i + 1}`);
  }
  return pools;
}

function expectedMatchCount(pools: { length: number }[]): number {
  return pools.reduce((s, p) => s + (p.length * (p.length - 1)) / 2, 0);
}

function prettyMatch(m: MatchPairing): string {
  const t1 = m.team1.filter(Boolean).join(' & ');
  const t2 = m.team2.filter(Boolean).join(' & ');
  return `${t1} vs ${t2}`;
}

// ── Pool Play sweep case ─────────────────────────────────────────
function testPoolPlay(n: number, poolCount: number) {
  header(`Pool Play · ${n} players in ${poolCount} pools`);
  const ids = players(n);
  const { pools, matches } = generatePoolPlay(ids, poolCount);
  console.log(`    Pool sizes: ${pools.map(p => p.length).join(', ')}`);
  pools.forEach((pool, i) => console.log(`    Pool ${letter(i)}: ${pool.join(', ')}`));
  console.log(`    Total matches: ${matches.length}`);

  // 1. Pool count matches request.
  assertEq(`pool count`, pools.length, poolCount);

  // 2. Sizes balanced: max − min ≤ 1.
  const sizes = pools.map(p => p.length);
  const balanced = Math.max(...sizes) - Math.min(...sizes) <= 1;
  assertTrue(`pool sizes balanced (Δ ≤ 1)`, balanced, `sizes: ${sizes.join(',')}`);

  // 3. Snake-draft order matches the independently-computed reference.
  const expectedPools = expectedSnakePools(n, poolCount);
  assertEq(`snake-draft pool layout`, pools, expectedPools);

  // 4. Snake property: seed 1 (P1) is always in pool A.
  assertTrue(`seed 1 lands in pool A`, pools[0][0] === 'P1');

  // 5. Every player ends up in exactly one pool; total = N; all unique.
  const allPooled = pools.flat();
  assertEq(`pooled player count`, allPooled.length, n);
  assertEq(`pooled players unique`, new Set(allPooled).size, n);
  // JSON.stringify(Set) === "{}", so compare sorted arrays for a real check.
  assertEq(`pooled set == input set`, [...allPooled].sort(), [...ids].sort());

  // 6. Total match count = Σ over pools of size*(size−1)/2.
  assertEq(`total match count`, matches.length, expectedMatchCount(pools));

  // 7. Every match label is `Pool X · Round r` with the correct zero-based poolIndex.
  const labelRe = /^Pool ([A-Z]) · Round (\d+)$/;
  let labelsOk = true;
  let labelDetail = '';
  for (const m of matches) {
    const lm = m.label ? labelRe.exec(m.label) : null;
    if (!lm) {
      labelsOk = false;
      labelDetail = `bad label: ${JSON.stringify(m.label)}`;
      break;
    }
    const expectedLetter = lm[1];
    const expectedRound = Number(lm[2]);
    if (m.poolIndex === undefined || letter(m.poolIndex) !== expectedLetter) {
      labelsOk = false;
      labelDetail = `label ${m.label} but poolIndex=${m.poolIndex}`;
      break;
    }
    if (m.round !== expectedRound) {
      labelsOk = false;
      labelDetail = `label ${m.label} but round=${m.round}`;
      break;
    }
  }
  assertTrue(`every match labeled "Pool X · Round r" w/ matching poolIndex`, labelsOk, labelDetail);

  // 8. Each match's players actually belong to the pool named in its poolIndex.
  let membershipOk = true;
  let membershipDetail = '';
  for (const m of matches) {
    const pool = new Set(pools[m.poolIndex!]);
    const ps = [...m.team1, ...m.team2].filter(Boolean) as string[];
    if (!ps.every(p => pool.has(p))) {
      membershipOk = false;
      membershipDetail = `${prettyMatch(m)} not all in pool ${letter(m.poolIndex!)}`;
      break;
    }
  }
  assertTrue(`each match's players belong to its pool`, membershipOk, membershipDetail);

  // 9. No 'BYE' ever leaks into a returned match.
  const noBye = matches.every(m =>
    ![...m.team1, ...m.team2].some(p => p === 'BYE'));
  assertTrue(`no 'BYE' leaks into returned matches`, noBye);

  // 10. Singles shape: each side has exactly one player.
  const singlesShape = matches.every(m =>
    m.team1.filter(Boolean).length === 1 && m.team2.filter(Boolean).length === 1);
  assertTrue(`every match is singles (1v1)`, singlesShape);

  // 11. Within each pool the matches form a full round-robin (every distinct
  //     intra-pool pairing appears exactly once).
  let rrOk = true;
  let rrDetail = '';
  pools.forEach((pool, pi) => {
    const poolMatches = matches.filter(m => m.poolIndex === pi);
    const seen = new Set<string>();
    for (const m of poolMatches) {
      const key = [m.team1[0], m.team2[0]].sort().join(' vs ');
      if (seen.has(key)) { rrOk = false; rrDetail = `dup pairing in pool ${letter(pi)}: ${key}`; }
      seen.add(key);
    }
    const expected = (pool.length * (pool.length - 1)) / 2;
    if (seen.size !== expected) {
      rrOk = false;
      rrDetail = `pool ${letter(pi)} has ${seen.size} unique pairings, expected ${expected}`;
    }
  });
  assertTrue(`each pool is a complete round-robin (unique pairings)`, rrOk, rrDetail);

  // 12. validatePools passes for a correctly-generated draw.
  assertEq(`validatePools accepts the generated draw`,
    validatePools(pools, poolCount, matches), null);
}

// ── assignPools direct invariants ────────────────────────────────
function testAssignPoolsDirect() {
  header(`assignPools · documented snake (8 players / 4 pools)`);
  const pools = assignPools(['1', '2', '3', '4', '5', '6', '7', '8'], 4);
  pools.forEach((p, i) => console.log(`    Pool ${letter(i)}: ${p.join(', ')}`));
  assertEq(`pool A`, pools[0], ['1', '8']);
  assertEq(`pool B`, pools[1], ['2', '7']);
  assertEq(`pool C`, pools[2], ['3', '6']);
  assertEq(`pool D`, pools[3], ['4', '5']);
}

// ── Error cases ──────────────────────────────────────────────────
function testErrorCases() {
  header(`assignPools · error paths`);
  assertThrows(`poolCount = 0 throws`, () => assignPools(players(8), 0));
  assertThrows(`poolCount < 0 throws`, () => assignPools(players(8), -2));
  // N < poolCount * 2 → not enough players to give each pool 2.
  assertThrows(`N (3) < poolCount*2 (4) throws`, () => assignPools(players(3), 2));
  assertThrows(`N (5) < poolCount*2 (6) throws`, () => assignPools(players(5), 3));
  assertThrows(`N (7) < poolCount*2 (8) throws`, () => assignPools(players(7), 4));
  // Exactly at the boundary must NOT throw.
  assertTrue(`N == poolCount*2 (4 players / 2 pools) does not throw`,
    (() => { try { assignPools(players(4), 2); return true; } catch { return false; } })());

  header(`generatePoolPlay · error paths propagate`);
  assertThrows(`generatePoolPlay poolCount=0 throws`, () => generatePoolPlay(players(8), 0));
  assertThrows(`generatePoolPlay underfull throws`, () => generatePoolPlay(players(3), 2));
}

// ── validatePools failure paths ──────────────────────────────────
function testValidatePoolsFailures() {
  header(`validatePools · failure codes`);

  // WRONG_POOL_COUNT: pools.length !== expectedCount.
  {
    const { pools, matches } = generatePoolPlay(players(8), 2);
    const err = validatePools(pools, 3, matches);
    assertEq(`WRONG_POOL_COUNT code`, err?.code, 'WRONG_POOL_COUNT');
  }

  // POOL_UNDERFULL: a pool with < 2 entrants.
  {
    const pools = [['P1', 'P2'], ['P3']]; // pool B underfull
    const matches: MatchPairing[] = [
      { round: 1, matchOrder: 0, team1: ['P1'], team2: ['P2'], label: 'Pool A · Round 1', poolIndex: 0 },
    ];
    const err = validatePools(pools, 2, matches);
    assertEq(`POOL_UNDERFULL code`, err?.code, 'POOL_UNDERFULL');
  }

  // POOL_HAS_NO_MATCHES: a valid-size pool with no scheduled matches.
  {
    const pools = [['P1', 'P2'], ['P3', 'P4']];
    const matches: MatchPairing[] = [
      // Only pool A has a match; pool B has none.
      { round: 1, matchOrder: 0, team1: ['P1'], team2: ['P2'], label: 'Pool A · Round 1', poolIndex: 0 },
    ];
    const err = validatePools(pools, 2, matches);
    assertEq(`POOL_HAS_NO_MATCHES code`, err?.code, 'POOL_HAS_NO_MATCHES');
  }
}

// ── Run everything ───────────────────────────────────────────────
console.log('\n\x1b[1mPickleague Pool Play (singles) sweep — Unit 3\x1b[0m');
console.log('Pure data — no Supabase round-trip.\n');

testAssignPoolsDirect();

// Required sweep combinations.
testPoolPlay(8, 2);
testPoolPlay(12, 3);
testPoolPlay(16, 4);
testPoolPlay(9, 3);
testPoolPlay(10, 3);
testPoolPlay(7, 2);
testPoolPlay(6, 3);
testPoolPlay(15, 4);

// Minimum case: 2P players, P pools, for P ∈ {2, 3, 4}.
testPoolPlay(4, 2);
testPoolPlay(6, 3);
testPoolPlay(8, 4);

// Extra coverage: a broad fan-out to stress balance + snake wrap.
for (const poolCount of [2, 3, 4, 5, 6]) {
  for (let n = poolCount * 2; n <= poolCount * 2 + 11; n++) {
    testPoolPlay(n, poolCount);
  }
}

testErrorCases();
testValidatePoolsFailures();

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
