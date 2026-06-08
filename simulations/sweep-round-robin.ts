/**
 * Round Robin (singles) verification sweep — Unit 1.
 *
 * Exhaustively exercises generateRoundRobin and seedPlayers from
 * mobile/src/lib/tournament.ts across a wide range of participant counts and
 * asserts the structural invariants of a single round-robin (one match per
 * pairing, played exactly once):
 *
 *   • match count       = N(N-1)/2
 *   • round count       = N-1  (even N)  /  N  (odd N)
 *                         — odd N is padded with an internal 'BYE' so one
 *                           player sits out each round; N rounds is the
 *                           mathematical minimum (cannot be N-1).
 *   • coverage          = every player meets every other player exactly once
 *                         (no missing pairings, no duplicate pairings)
 *   • no double-booking = no player appears twice within a single round
 *   • BYE never leaks    = the literal 'BYE' placeholder is filtered out of
 *                          every emitted match (odd N pads internally)
 *   • matchOrder         = sequential 0,1,2,… within each round
 *
 * Also checks seedPlayers: elo mode sorts by rating descending (missing rating
 * defaults to 3.25); random mode preserves the exact set of ids.
 *
 * Run: cd simulations && npx tsx sweep-round-robin.ts
 */
import {
  generateRoundRobin,
  seedPlayers,
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

// Singles pairing key: unordered, so P1-vs-P2 and P2-vs-P1 collide.
function pairKey(m: MatchPairing): string {
  return [m.team1[0] as string, m.team2[0] as string].sort().join(' vs ');
}

function prettyMatch(m: MatchPairing): string {
  return `${m.team1[0]} vs ${m.team2[0]}`;
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

// ── Round Robin invariant sweep ──────────────────────────────────
function testRoundRobin(n: number) {
  header(`Round Robin (singles) · ${n} players`);
  const ids = players(n);
  const ms = generateRoundRobin(ids);
  console.log(`    Total matches: ${ms.length}`);
  drawByRound(ms);

  // 1) match count = N(N-1)/2
  const expectedMatches = (n * (n - 1)) / 2;
  assertEq(`match count`, ms.length, expectedMatches);

  // 2) round count. Even N → N-1; odd N → N (padded BYE makes one sit-out per
  //    round, so N rounds is the unavoidable minimum). Rounds are labelled
  //    1..roundCount with no gaps.
  const isEven = n % 2 === 0;
  const expectedRounds = isEven ? n - 1 : n;
  const roundLabels = [...new Set(ms.map(m => m.round))].sort((a, b) => a - b);
  assertEq(`distinct round count`, roundLabels.length, expectedRounds);
  assertEq(`rounds are 1..${expectedRounds} with no gaps`,
    roundLabels, Array.from({ length: expectedRounds }, (_, i) => i + 1));

  // 3) coverage: every unordered pair appears exactly once → no missing, no dup.
  const pairTally = new Map<string, number>();
  for (const m of ms) {
    const k = pairKey(m);
    pairTally.set(k, (pairTally.get(k) ?? 0) + 1);
  }
  assertEq(`distinct pairings`, pairTally.size, expectedMatches);
  const duped = [...pairTally.entries()].filter(([, c]) => c > 1);
  assertTrue(`no duplicate pairing`, duped.length === 0,
    `duplicates: ${duped.map(([k]) => k).join(', ')}`);

  // Build the full expected set of pairings and confirm none are missing.
  const expectedSet = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      expectedSet.add([ids[i], ids[j]].sort().join(' vs '));
    }
  }
  const missing = [...expectedSet].filter(k => !pairTally.has(k));
  assertTrue(`every player meets every other player exactly once`,
    missing.length === 0, `missing: ${missing.join(', ')}`);

  // 4) every player plays exactly N-1 matches.
  const playCount: Record<string, number> = {};
  for (const m of ms) {
    playCount[m.team1[0] as string] = (playCount[m.team1[0] as string] ?? 0) + 1;
    playCount[m.team2[0] as string] = (playCount[m.team2[0] as string] ?? 0) + 1;
  }
  const everyoneSeen = Object.keys(playCount).length === n;
  const everyonePlaysNMinus1 = ids.every(p => playCount[p] === n - 1);
  assertTrue(`every player plays exactly ${n - 1} matches`,
    everyoneSeen && everyonePlaysNMinus1, `counts: ${JSON.stringify(playCount)}`);

  // 5) no player double-booked within a round.
  let doubleBookedRound = '';
  const byRound = new Map<number, string[]>();
  for (const m of ms) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round)!.push(m.team1[0] as string, m.team2[0] as string);
  }
  for (const [r, ps] of byRound) {
    if (new Set(ps).size !== ps.length) { doubleBookedRound = `round ${r}: ${ps.join(',')}`; break; }
  }
  assertTrue(`no player double-booked within a round`,
    doubleBookedRound === '', doubleBookedRound);

  // 6) 'BYE' never leaks into an emitted match (odd N pads internally).
  const byeLeak = ms.some(m =>
    m.team1[0] === 'BYE' || m.team2[0] === 'BYE' ||
    m.team1[1] === 'BYE' || m.team2[1] === 'BYE');
  assertTrue(`'BYE' never appears in any emitted match`, !byeLeak);

  // Also: every emitted token is a real input id.
  const idSet = new Set(ids);
  const allReal = ms.every(m => idSet.has(m.team1[0] as string) && idSet.has(m.team2[0] as string));
  assertTrue(`every emitted player id is a real input id`, allReal);

  // 7) matchOrder is sequential 0,1,2,… within each round.
  let orderOk = true;
  let orderDetail = '';
  const ordersByRound = new Map<number, number[]>();
  for (const m of ms) {
    if (!ordersByRound.has(m.round)) ordersByRound.set(m.round, []);
    ordersByRound.get(m.round)!.push(m.matchOrder);
  }
  for (const [r, orders] of ordersByRound) {
    const expected = Array.from({ length: orders.length }, (_, i) => i);
    if (JSON.stringify(orders) !== JSON.stringify(expected)) {
      orderOk = false;
      orderDetail = `round ${r}: got [${orders.join(',')}] expected [${expected.join(',')}]`;
      break;
    }
  }
  assertTrue(`matchOrder sequential (0,1,2,…) within each round`, orderOk, orderDetail);

  // 8) singles match shape: each team has exactly one player, no partner slot.
  const shapeOk = ms.every(m =>
    m.team1.length === 1 && m.team2.length === 1 &&
    m.team1[0] !== m.team2[0]);
  assertTrue(`singles match shape (1 player per side, distinct)`, shapeOk);
}

// ── Minimum-players guard ────────────────────────────────────────
function testGuards() {
  header(`generateRoundRobin · input guards`);
  let threwOn1 = false;
  try { generateRoundRobin(['only']); } catch { threwOn1 = true; }
  assertTrue(`throws for fewer than 2 players`, threwOn1);

  let threwOn0 = false;
  try { generateRoundRobin([]); } catch { threwOn0 = true; }
  assertTrue(`throws for 0 players`, threwOn0);
}

// ── seedPlayers ──────────────────────────────────────────────────
function testSeeding() {
  header(`seedPlayers · elo descending order`);
  // A has no rating → defaults to 3.25, slotting between D(4.0) and C(2.0).
  const ids = ['A', 'B', 'C', 'D'];
  const ratings = { B: 5.0, C: 2.0, D: 4.0 };
  const seeded = seedPlayers(ids, ratings, 'elo');
  assertEq(`elo order (missing A → 3.25)`, seeded, ['B', 'D', 'A', 'C']);

  header(`seedPlayers · explicit-rating descending`);
  const ids2 = ['A', 'B', 'C', 'D'];
  const ratings2 = { A: 3.0, B: 4.5, C: 3.75, D: 2.5 };
  assertEq(`elo order (all rated)`, seedPlayers(ids2, ratings2, 'elo'), ['B', 'C', 'A', 'D']);

  header(`seedPlayers · all missing default to 3.25`);
  // Every id missing → all default to 3.25; sort is a no-op (stable), so the
  // input order is preserved.
  const idsAllMissing = ['Z', 'Y', 'X', 'W'];
  assertEq(`all-missing preserves order (all = 3.25)`,
    seedPlayers(idsAllMissing, {}, 'elo'), idsAllMissing);

  header(`seedPlayers · random preserves the exact set of ids`);
  // Run several times so a chance reshuffle can't mask a dropped/added id.
  let setHolds = true;
  let detail = '';
  const expectedSorted = [...ids].sort().join(',');
  for (let t = 0; t < 50; t++) {
    const r = seedPlayers(ids, ratings, 'random');
    if (r.length !== ids.length || [...r].sort().join(',') !== expectedSorted) {
      setHolds = false;
      detail = JSON.stringify(r);
      break;
    }
  }
  assertTrue(`random keeps exactly the same set across 50 shuffles`, setHolds, detail);

  // Random must not mutate the caller's input array.
  const original = ['A', 'B', 'C', 'D'];
  const snapshot = [...original];
  seedPlayers(original, ratings, 'random');
  assertEq(`random does not mutate input`, original, snapshot);

  // Elo must not mutate the caller's input array.
  const original2 = ['A', 'B', 'C', 'D'];
  const snapshot2 = [...original2];
  seedPlayers(original2, ratings, 'elo');
  assertEq(`elo does not mutate input`, original2, snapshot2);
}

// ── Run everything ───────────────────────────────────────────────
console.log('\n\x1b[1mPickleague — Round Robin (singles) verification sweep\x1b[0m');
console.log('Unit 1: generateRoundRobin + seedPlayers. Pure data, no Supabase.\n');

testGuards();
testSeeding();

for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17]) {
  testRoundRobin(n);
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
