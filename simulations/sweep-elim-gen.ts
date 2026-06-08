/**
 * Sweep: Single & Double Elimination round-1 generators (singles).
 *
 * Unit 2 verification harness. Exercises generateSingleElim and
 * generateDoubleElim across a wide sweep of participant counts and asserts
 * the structural invariants the SQL trigger (Unit 7/8) relies on:
 *
 *   - bracketSize = next power of 2 >= N; byes = bracketSize - N
 *   - round-1 match count = bracketSize/2 - byes
 *   - each player appears at most once in round 1
 *   - the literal 'BYE' token NEVER appears in any emitted match
 *   - power-of-2 N: first match pairs P1 vs lowest active seed (1 vs N)
 *   - non-power-of-2 N: top seeds get byes; P1 either plays or is bye'd
 *   - generateDoubleElim == generateSingleElim R1 but every match
 *     tagged bracket:'winners'
 *   - both throw for N < 2
 *
 * Pure TS — imports nothing external, so it runs without mobile node_modules.
 *
 * Run: cd simulations && npx tsx sweep-elim-gen.ts
 */
import {
  generateSingleElim,
  generateDoubleElim,
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

function prettyMatch(m: MatchPairing): string {
  const t1 = m.team1.filter(Boolean).join(' & ');
  const t2 = m.team2.filter(Boolean).join(' & ');
  const tag = m.bracket ? ` [${m.bracket}]` : '';
  return `${t1} vs ${t2}${tag}`;
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

// Flattened player tokens across all matches (keeps undefined slots visible).
function allTokens(matches: MatchPairing[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const m of matches) out.push(...m.team1, ...m.team2);
  return out;
}

// ── Shared structural assertions for an elim round-1 draw ────────
// `expectBracketTag`: when true (double-elim), every match must carry
// bracket:'winners'; when false (single-elim), bracket must be undefined.
function assertElimR1(
  fnLabel: string,
  n: number,
  ms: MatchPairing[],
  expectBracketTag: boolean,
) {
  // bracketSize = next power of 2 >= n
  let bracketSize = 1;
  while (bracketSize < n) bracketSize *= 2;
  const byes = bracketSize - n;
  const isPow2 = (n & (n - 1)) === 0;

  // round-1 match count = bracketSize/2 - byes
  const expectedR1 = bracketSize / 2 - byes;
  assertEq(`[${fnLabel}] round-1 match count`, ms.length, expectedR1);

  // All matches are round 1, matchOrder is unique & non-negative.
  assertTrue(`[${fnLabel}] all matches are round 1`,
    ms.every(m => m.round === 1),
    `rounds: ${ms.map(m => m.round).join(',')}`);
  const orders = ms.map(m => m.matchOrder);
  assertTrue(`[${fnLabel}] matchOrder values unique`,
    new Set(orders).size === orders.length,
    `orders: ${orders.join(',')}`);

  // Each match is a clean 1v1: exactly one player per side, no undefined slot.
  const wellFormed = ms.every(m =>
    m.team1.length === 1 && m.team2.length === 1 &&
    typeof m.team1[0] === 'string' && typeof m.team2[0] === 'string' &&
    m.team1[0] !== m.team2[0]);
  assertTrue(`[${fnLabel}] every match is a clean 1v1`, wellFormed);

  // The literal 'BYE' token NEVER appears in any emitted match.
  const noBye = !allTokens(ms).some(t => t === 'BYE');
  assertTrue(`[${fnLabel}] no 'BYE' token leaks into matches`, noBye,
    `tokens: ${allTokens(ms).join(',')}`);

  // Each player appears at most once in round 1.
  const tokens = allTokens(ms).filter((t): t is string => typeof t === 'string');
  assertTrue(`[${fnLabel}] each player appears at most once in R1`,
    new Set(tokens).size === tokens.length,
    `tokens: ${tokens.join(',')}`);

  // The players that DO appear in R1 are a subset of the real entrants.
  const entrants = new Set(players(n));
  assertTrue(`[${fnLabel}] all R1 tokens are real entrants`,
    tokens.every(t => entrants.has(t)),
    `tokens: ${tokens.join(',')}`);

  // Number of distinct players appearing in R1 = 2 * matchCount = entrants - byes.
  assertEq(`[${fnLabel}] distinct R1 players`, new Set(tokens).size, n - byes);

  // Seeding rule.
  if (isPow2 && ms.length > 0) {
    // First match pairs P1 vs the lowest active seed (1 vs N).
    const lowest = `P${n}`;
    const first = ms[0];
    const facesLowest =
      (first.team1.includes('P1') && first.team2.includes(lowest)) ||
      (first.team1.includes(lowest) && first.team2.includes('P1'));
    assertTrue(`[${fnLabel}] (pow2) first match P1 vs lowest seed ${lowest}`,
      facesLowest, prettyMatch(first));
  } else {
    // Non-power-of-2: top seeds get byes. P1 either plays OR is among the
    // bye'd seeds. The generator appends byes at the end of the seed list,
    // so the bye'd seeds are exactly P1..P(byes) (the top seeds).
    const p1Plays = tokens.includes('P1');
    const byedSeeds = new Set(Array.from({ length: byes }, (_, i) => `P${i + 1}`));
    assertTrue(`[${fnLabel}] (non-pow2) P1 plays OR is among bye'd top seeds`,
      p1Plays || byedSeeds.has('P1'),
      `p1Plays=${p1Plays}, byes=${byes}`);
    // Stronger: the set of bye'd players is exactly the top `byes` seeds.
    const byedActual = new Set(
      players(n).filter(p => !tokens.includes(p)));
    assertEq(`[${fnLabel}] (non-pow2) bye'd players are the top ${byes} seeds`,
      [...byedActual].sort(), [...byedSeeds].sort());
  }

  // Bracket tag expectations.
  if (expectBracketTag) {
    const allWinners = ms.every(m => m.bracket === 'winners');
    assertTrue(`[${fnLabel}] every match tagged bracket:'winners'`, allWinners,
      `brackets: ${ms.map(m => m.bracket).join(',')}`);
  } else {
    const noTag = ms.every(m => m.bracket === undefined);
    assertTrue(`[${fnLabel}] no bracket tag on single-elim matches`, noTag,
      `brackets: ${ms.map(m => m.bracket).join(',')}`);
  }
}

// ── Per-N sweep ──────────────────────────────────────────────────
function testElim(n: number) {
  header(`Elimination · ${n} seeded players`);

  const single = generateSingleElim(players(n));
  const double = generateDoubleElim(players(n));

  console.log(`    Single-elim R1 matches: ${single.length}`);
  drawByRound(single);
  console.log(`    Double-elim R1 matches: ${double.length}`);
  drawByRound(double);

  assertElimR1('single', n, single, false);
  assertElimR1('double', n, double, true);

  // generateDoubleElim returns the SAME round-1 as generateSingleElim but
  // every match tagged bracket:'winners'. Strip the tag and compare deeply.
  const doubleStripped = double.map(({ bracket, ...rest }) => rest);
  assertEq(`[parity] double-elim R1 == single-elim R1 (tag aside)`,
    doubleStripped, single);
}

// ── Throwing behaviour for N < 2 ────────────────────────────────
function testThrows() {
  header(`Throwing behaviour · N < 2`);
  for (const n of [0, 1]) {
    let threwSingle = false, threwDouble = false;
    try { generateSingleElim(players(n)); } catch { threwSingle = true; }
    try { generateDoubleElim(players(n)); } catch { threwDouble = true; }
    assertTrue(`generateSingleElim throws for N=${n}`, threwSingle);
    assertTrue(`generateDoubleElim throws for N=${n}`, threwDouble);
  }
}

// ── Run everything ───────────────────────────────────────────────
console.log('\n\x1b[1mUnit 2 sweep — single & double elimination round-1 generators\x1b[0m');
console.log('Pure data — no Supabase round-trip; later rounds are out of scope.\n');

testThrows();

const SWEEP = [2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17];
for (const n of SWEEP) testElim(n);

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
