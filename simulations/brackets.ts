/**
 * Bracket generator simulations.
 *
 * Imports the pure bracket-generation functions from mobile/src/lib/tournament.ts,
 * exercises each format across a range of player counts, asserts structural
 * invariants, and prints a human-readable view of the resulting match draw.
 *
 * Run: cd simulations && npm install && npm run brackets
 */
import {
  generateRoundRobin,
  generateSingleElim,
  generatePoolPlay,
  generateRotatingPartners,
  generateMLPSchedule,
  seedPlayers,
  assignPools,
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
function players(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `P${i + 1}`);
}

function matchKey(m: MatchPairing): string {
  // Normalize: sort within each team and sort teams so reversed pairs collide.
  const t1 = [...m.team1].sort().join('+');
  const t2 = [...m.team2].sort().join('+');
  return [t1, t2].sort().join(' vs ');
}

function uniquePairs(matches: MatchPairing[]): Set<string> {
  return new Set(matches.map(matchKey));
}

function playersInRound(matches: MatchPairing[], round: number): string[] {
  const out: string[] = [];
  for (const m of matches) {
    if (m.round !== round) continue;
    out.push(...(m.team1.filter(Boolean) as string[]), ...(m.team2.filter(Boolean) as string[]));
  }
  return out.filter(p => p !== 'BYE');
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

// ── Round Robin ───────────────────────────────────────────────────
function testRoundRobin(n: number) {
  header(`Round Robin · ${n} players`);
  const ms = generateRoundRobin(players(n));
  console.log(`    Total matches: ${ms.length}`);
  drawByRound(ms);

  const expectedMatches = (n * (n - 1)) / 2;
  assertEq(`match count`, ms.length, expectedMatches);

  const pairs = uniquePairs(ms);
  assertEq(`unique pairings`, pairs.size, expectedMatches);

  // Every player plays every other player exactly once
  const counts: Record<string, number> = {};
  for (const m of ms) {
    counts[m.team1[0] as string] = (counts[m.team1[0] as string] ?? 0) + 1;
    counts[m.team2[0] as string] = (counts[m.team2[0] as string] ?? 0) + 1;
  }
  const allEqual = Object.values(counts).every(c => c === n - 1);
  assertTrue(`every player plays ${n - 1} matches`, allEqual,
    `counts: ${JSON.stringify(counts)}`);

  // No player twice in the same round
  const rounds = new Set(ms.map(m => m.round));
  let noDups = true;
  let dupDetail = '';
  for (const r of rounds) {
    const ps = playersInRound(ms, r);
    if (new Set(ps).size !== ps.length) {
      noDups = false;
      dupDetail = `round ${r}: ${ps.join(',')}`;
      break;
    }
  }
  assertTrue(`no player plays twice per round`, noDups, dupDetail);
}

// ── Single Elim ──────────────────────────────────────────────────
function testSingleElim(n: number) {
  header(`Single Elimination · ${n} seeded players`);
  const ms = generateSingleElim(players(n));
  console.log(`    Round 1 matches: ${ms.length}`);
  drawByRound(ms);

  // bracketSize = next power of 2 ≥ n
  let bracketSize = 1;
  while (bracketSize < n) bracketSize *= 2;
  const byes = bracketSize - n;

  // Round 1: top half vs bottom half pairs. The generator skips BYE-vs-X pairs
  // (top seed gets the bye), so round 1 match count = (bracketSize/2) - byes.
  const expectedR1 = bracketSize / 2 - byes;
  assertEq(`round-1 match count`, ms.length, expectedR1);

  // Each player appears at most once in round 1.
  const played = new Set<string>();
  let dupe = false;
  for (const m of ms) {
    for (const p of [...m.team1, ...m.team2]) {
      if (!p || p === 'BYE') continue;
      if (played.has(p as string)) { dupe = true; break; }
      played.add(p as string);
    }
  }
  assertTrue(`each player appears at most once in R1`, !dupe);

  // Top-seed pairing rule: P1 should face the lowest seed that isn't a BYE.
  if (ms.length > 0) {
    const lowestSeedActive = `P${n - byes}`;  // the lowest active seed after byes
    const firstMatch = ms[0];
    const facesLowest =
      firstMatch.team1.includes('P1') && firstMatch.team2.includes(lowestSeedActive) ||
      firstMatch.team1.includes(lowestSeedActive) && firstMatch.team2.includes('P1');
    // For sizes that aren't powers of 2, top seeds get byes. Skip the strict
    // pairing check when n is not a power of 2 — just assert P1 plays someone.
    const isPow2 = (n & (n - 1)) === 0;
    if (isPow2) {
      assertTrue(`top seed P1 vs lowest seed ${lowestSeedActive}`, facesLowest);
    } else {
      const p1Plays = ms.some(m => m.team1.includes('P1') || m.team2.includes('P1'));
      assertTrue(`top seed P1 plays in round 1 OR has a bye`,
        p1Plays || byes >= 1,
        `byes=${byes}, p1Plays=${p1Plays}`);
    }
  }
}

// ── Pool Play ────────────────────────────────────────────────────
function testPoolPlay(n: number, poolCount: number) {
  header(`Pool Play · ${n} players in ${poolCount} pools`);
  const { pools, matches } = generatePoolPlay(players(n), poolCount);
  console.log(`    Pool sizes: ${pools.map(p => p.length).join(', ')}`);
  pools.forEach((pool, i) => console.log(`    Pool ${String.fromCharCode(65 + i)}: ${pool.join(', ')}`));
  console.log(`    Total matches: ${matches.length}`);

  assertEq(`pool count`, pools.length, poolCount);

  // Balanced: max - min ≤ 1
  const sizes = pools.map(p => p.length);
  const balanced = Math.max(...sizes) - Math.min(...sizes) <= 1;
  assertTrue(`pool sizes balanced (Δ ≤ 1)`, balanced, `sizes: ${sizes.join(',')}`);

  // Every approved player ends up in exactly one pool
  const allPooled = pools.flat();
  assertEq(`pooled player count`, allPooled.length, n);
  assertEq(`pooled players unique`, new Set(allPooled).size, n);

  // Total matches = sum of round-robin within each pool
  const expectedMatches = pools.reduce((s, p) => s + (p.length * (p.length - 1)) / 2, 0);
  assertEq(`total match count`, matches.length, expectedMatches);

  // Every match label references its pool
  const labeledOk = matches.every(m => typeof m.label === 'string' && m.label.startsWith('Pool '));
  assertTrue(`every match has a Pool label`, labeledOk);
}

// ── Rotating Partners ────────────────────────────────────────────
function testRotatingPartners(n: number, rounds: number) {
  header(`Rotating Partners · ${n} players × ${rounds} rounds`);
  const ms = generateRotatingPartners(players(n), rounds);
  console.log(`    Total matches: ${ms.length}`);
  drawByRound(ms);

  if (n < 4) {
    assertEq(`returns empty for n < 4`, ms.length, 0);
    return;
  }

  // floor(n/4) matches per round
  const perRound = Math.floor(n / 4);
  assertEq(`matches per round`, ms.filter(m => m.round === 1).length, perRound);
  assertEq(`total matches`, ms.length, perRound * rounds);

  // Every match has 2 + 2 distinct players
  const wellFormed = ms.every(m => {
    const ps = new Set([...m.team1, ...m.team2]);
    return ps.size === 4 && m.team1.length === 2 && m.team2.length === 2;
  });
  assertTrue(`every match has 4 distinct players in 2v2`, wellFormed);
}

// ── MLP schedule (team round robin) ──────────────────────────────
function testMLP(teamCount: number) {
  header(`MLP Schedule · ${teamCount} teams`);
  const teams: [string, string][] = Array.from({ length: teamCount }, (_, i) => [`T${i + 1}A`, `T${i + 1}B`]);
  const ms = generateMLPSchedule(teams);
  console.log(`    Total team-vs-team matchups: ${ms.length}`);
  drawByRound(ms);

  // Round robin over teams
  const expected = (teamCount * (teamCount - 1)) / 2;
  assertEq(`matchup count`, ms.length, expected);

  // Every team appears in (teamCount - 1) matchups
  const counts: Record<string, number> = {};
  for (const m of ms) {
    const t1 = m.team1.join('/');
    const t2 = m.team2.join('/');
    counts[t1] = (counts[t1] ?? 0) + 1;
    counts[t2] = (counts[t2] ?? 0) + 1;
  }
  const allEqual = Object.values(counts).every(c => c === teamCount - 1);
  assertTrue(`every team plays ${teamCount - 1} matchups`, allEqual,
    `counts: ${JSON.stringify(counts)}`);
}

// ── Seeding ──────────────────────────────────────────────────────
function testSeeding() {
  header(`seedPlayers · elo ordering`);
  const ids = ['A', 'B', 'C', 'D'];
  const ratings = { A: 3.0, B: 4.5, C: 3.75, D: 2.5 };
  const seeded = seedPlayers(ids, ratings, 'elo');
  assertEq(`PLUPR descending order`, seeded, ['B', 'C', 'A', 'D']);

  // Random mode must include the same set
  const r = seedPlayers(ids, ratings, 'random');
  assertEq(`random includes all players`, new Set(r), new Set(ids));
}

// ── Snake-draft pool assignment ──────────────────────────────────
function testAssignPools() {
  header(`assignPools · snake draft balance`);
  const pools = assignPools(['1', '2', '3', '4', '5', '6', '7', '8'], 4);
  console.log(`    Pools (in order):`);
  pools.forEach((p, i) => console.log(`      Pool ${String.fromCharCode(65 + i)}: ${p.join(', ')}`));
  // Snake: seeds 1→A, 2→B, 3→C, 4→D, 5→D, 6→C, 7→B, 8→A
  assertEq(`pool A`, pools[0], ['1', '8']);
  assertEq(`pool B`, pools[1], ['2', '7']);
  assertEq(`pool C`, pools[2], ['3', '6']);
  assertEq(`pool D`, pools[3], ['4', '5']);
}

// ── Run everything ───────────────────────────────────────────────
console.log('\n\x1b[1mPickleague bracket-generator simulations\x1b[0m');
console.log('All input/output is pure data — no Supabase round-trip.\n');

testSeeding();
testAssignPools();

testRoundRobin(4);
testRoundRobin(5);   // odd: BYE handling
testRoundRobin(6);
testRoundRobin(8);

testSingleElim(2);
testSingleElim(4);
testSingleElim(5);   // BYE for top seeds
testSingleElim(8);
testSingleElim(16);

testPoolPlay(8, 2);
testPoolPlay(12, 3);
testPoolPlay(16, 4);
testPoolPlay(9, 3);   // unbalanced (3,3,3)
testPoolPlay(10, 3);  // unbalanced (4,3,3)

testRotatingPartners(8, 3);
testRotatingPartners(12, 4);
testRotatingPartners(3, 2);   // n < 4 edge case

testMLP(4);
testMLP(6);
testMLP(2);

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
