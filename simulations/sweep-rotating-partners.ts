/**
 * Rotating-partners generator sweep (Unit 4).
 *
 * Exhaustively exercises generateRotatingPartners across the matrix
 *   N ∈ {3,4,5,6,7,8,9,12,16} × numRounds ∈ {1, 3, N-1}
 * and asserts the structural invariants the rest of the app relies on:
 *   - returns empty for N < 4
 *   - exactly floor(N/4) matches per round; total = floor(N/4) * numRounds
 *   - every match is 2v2 with 4 DISTINCT real players
 *   - the literal 'BYE' never leaks (BYE-padded sit-out slots are dropped)
 *   - matchOrder is sequential (0..k-1) within each round
 *   - no player appears twice in the same round
 * It also reports the WHIST property (do partnerships rotate, or repeat?)
 * and sit-out fairness as analysis output.
 *
 * Modeled on brackets.ts. Run: cd simulations && npx tsx sweep-rotating-partners.ts
 */
import {
  generateRotatingPartners,
  type MatchPairing,
} from '../mobile/src/lib/tournament';

// ── Reporting (same shape as brackets.ts) ────────────────────────
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

// ── Per-player partner / play tracking (for the WHIST + fairness report) ──
type PlayerStats = { partners: string[]; playCount: number };
function statsByPlayer(ms: MatchPairing[], all: string[]): Record<string, PlayerStats> {
  const out: Record<string, PlayerStats> = {};
  for (const p of all) out[p] = { partners: [], playCount: 0 };
  const ordered = [...ms].sort((a, b) => a.round - b.round || a.matchOrder - b.matchOrder);
  for (const m of ordered) {
    // team1 = [a, b]; team2 = [c, d]
    const [a, b] = m.team1 as string[];
    const [c, d] = m.team2 as string[];
    out[a].partners.push(b); out[a].playCount++;
    out[b].partners.push(a); out[b].playCount++;
    out[c].partners.push(d); out[c].playCount++;
    out[d].partners.push(c); out[d].playCount++;
  }
  return out;
}

// ── The sweep ────────────────────────────────────────────────────
function testRotatingPartners(n: number, rounds: number) {
  header(`Rotating Partners · ${n} players × ${rounds} rounds`);
  const all = players(n);
  const ms = generateRotatingPartners(all, rounds);
  console.log(`    Total matches: ${ms.length}`);
  drawByRound(ms);

  // ── Invariant: empty for n < 4 ──
  if (n < 4) {
    assertEq(`returns empty for n < 4`, ms.length, 0);
    return;
  }

  const perRound = Math.floor(n / 4);

  // ── Invariant: floor(n/4) matches every round; total = perRound * rounds ──
  assertEq(`total match count`, ms.length, perRound * rounds);
  let countOk = true;
  let countDetail = '';
  for (let r = 1; r <= rounds; r++) {
    const c = ms.filter(m => m.round === r).length;
    if (c !== perRound) { countOk = false; countDetail = `round ${r} has ${c}, expected ${perRound}`; break; }
  }
  assertTrue(`every round has exactly ${perRound} match(es)`, countOk, countDetail);

  // ── Invariant: rounds are exactly 1..rounds (no gaps, no extras) ──
  const roundSet = new Set(ms.map(m => m.round));
  const expectedRounds = perRound > 0 ? rounds : 0;
  assertEq(`distinct round count`, roundSet.size, expectedRounds);

  // ── Invariant: every match is 2v2 with 4 distinct real players ──
  let wellFormed = true;
  let wfDetail = '';
  for (const m of ms) {
    const slots = [...m.team1, ...m.team2];
    const ps = new Set(slots);
    if (m.team1.length !== 2 || m.team2.length !== 2 || ps.size !== 4) {
      wellFormed = false; wfDetail = `malformed: ${JSON.stringify(m)}`; break;
    }
  }
  assertTrue(`every match is 2v2 with 4 distinct players`, wellFormed, wfDetail);

  // ── Invariant: 'BYE' never leaks ──
  const byeLeak = ms.some(m => [...m.team1, ...m.team2].some(p => p === 'BYE' || p == null));
  assertTrue(`literal 'BYE' (or null) never appears`, !byeLeak);

  // ── Invariant: every emitted player is a real input player ──
  const realSet = new Set(all);
  const allReal = ms.every(m => [...m.team1, ...m.team2].every(p => realSet.has(p as string)));
  assertTrue(`every slot is a real input player`, allReal);

  // ── Invariant: matchOrder sequential 0..perRound-1 within each round ──
  let orderOk = true;
  let orderDetail = '';
  for (let r = 1; r <= rounds; r++) {
    const orders = ms.filter(m => m.round === r).sort((x, y) => x.matchOrder - y.matchOrder).map(m => m.matchOrder);
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] !== i) { orderOk = false; orderDetail = `round ${r}: ${orders.join(',')}`; break; }
    }
    if (!orderOk) break;
  }
  assertTrue(`matchOrder sequential within each round`, orderOk, orderDetail);

  // ── Invariant: no player appears twice in the same round ──
  let noDupPerRound = true;
  let dupDetail = '';
  for (let r = 1; r <= rounds; r++) {
    const slots: string[] = [];
    for (const m of ms.filter(x => x.round === r)) slots.push(...(m.team1 as string[]), ...(m.team2 as string[]));
    if (new Set(slots).size !== slots.length) { noDupPerRound = false; dupDetail = `round ${r}: ${slots.join(',')}`; break; }
  }
  assertTrue(`no player plays twice per round`, noDupPerRound, dupDetail);

  // ── Analysis (not pass/fail): WHIST partner-rotation + sit-out fairness ──
  const stats = statsByPlayer(ms, all);
  let maxSamePartner = 0;
  let anyImmediateRepeat = false;
  for (const p of all) {
    const { partners } = stats[p];
    const counts: Record<string, number> = {};
    for (const q of partners) counts[q] = (counts[q] ?? 0) + 1;
    maxSamePartner = Math.max(maxSamePartner, 0, ...Object.values(counts));
    for (let i = 1; i < partners.length; i++) if (partners[i] === partners[i - 1]) anyImmediateRepeat = true;
  }
  const playCounts = all.map(p => stats[p].playCount);
  const spread = Math.max(...playCounts) - Math.min(...playCounts);
  console.log(
    `    \x1b[2mWHIST: maxTimesSamePartner=${maxSamePartner}, immediateRepeat=${anyImmediateRepeat}; ` +
    `sit-out play-count min=${Math.min(...playCounts)} max=${Math.max(...playCounts)} (spread ${spread})\x1b[0m`
  );

  // For N a multiple of 4 we additionally ASSERT the ideal WHIST property:
  // partnerships never repeat within the first N-1 rounds (proper mixer), and
  // sit-outs are perfectly even (everyone plays every round).
  if (n % 4 === 0 && rounds <= n - 1) {
    assertTrue(`no partnership repeats (mult-of-4, ≤ n-1 rounds)`, maxSamePartner <= 1,
      `maxTimesSamePartner=${maxSamePartner}`);
    assertEq(`sit-out spread is 0 (mult-of-4)`, spread, 0);
  }
  // Across ALL sizes, a partnership must never repeat in *consecutive* rounds.
  assertTrue(`no immediately-repeated partner`, !anyImmediateRepeat);
}

// ── Run the full sweep ───────────────────────────────────────────
console.log('\n\x1b[1mPickleague rotating-partners sweep (Unit 4)\x1b[0m');
console.log('Pure data — no Supabase round-trip.\n');

const NS = [3, 4, 5, 6, 7, 8, 9, 12, 16];
for (const n of NS) {
  const roundsSet = Array.from(new Set([1, 3, Math.max(1, n - 1)])).sort((a, b) => a - b);
  for (const rounds of roundsSet) {
    testRotatingPartners(n, rounds);
  }
}

// Mirror the production call: TournamentDetailScreen passes ceil(N/4)*3 rounds.
header('Production-parity check · numRounds = ceil(N/4)*3');
for (const n of [4, 5, 6, 7, 8, 9, 12, 16]) {
  const rounds = Math.ceil(n / 4) * 3;
  const ms = generateRotatingPartners(players(n), rounds);
  const perRound = Math.floor(n / 4);
  assertEq(`N=${n} → ${rounds} rounds → total matches`, ms.length, perRound * rounds);
}

// ── Summary (identical to brackets.ts) ───────────────────────────
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
