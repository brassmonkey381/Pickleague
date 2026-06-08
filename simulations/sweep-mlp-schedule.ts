/**
 * MLP schedule (team round-robin) + MLP team validation simulations (Unit 6).
 *
 * Exercises generateMLPSchedule and validateMlpTeams in
 * mobile/src/lib/tournament.ts. generateMLPSchedule treats each [p1,p2] pair as
 * a team token (id = String(index)), runs a team round-robin, then maps the
 * tokens back via teams[parseInt(m.team1[0])].
 *
 * Prime suspect (odd T): the inner generateRoundRobin pads with the literal
 * 'BYE' for odd team counts. If a 'BYE' token ever reached the token→team
 * back-map, parseInt('BYE') → NaN → teams[NaN] would be `undefined`. This sweep
 * asserts that never happens (generateRoundRobin filters BYE matches before
 * returning, so the back-map is always safe).
 *
 * Run: cd simulations && npx tsx sweep-mlp-schedule.ts
 */
import {
  generateMLPSchedule,
  validateMlpTeams,
  type MatchPairing,
  type MlpTeamShape,
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
    bad(`${label}: expected a throw, but none was raised`);
  } catch {
    ok(label);
  }
}

// ── Helpers ──────────────────────────────────────────────────────
// Build T MLP teams as 2-player tokens: [['T1A','T1B'],['T2A','T2B'],…].
// (generateMLPSchedule operates on a pair token per team; the 4-player
//  roster is enforced upstream by validateMlpTeams, tested separately.)
function teams(n: number): [string, string][] {
  return Array.from({ length: n }, (_, i) => [`T${i + 1}A`, `T${i + 1}B`]);
}

function teamKey(t: [string, string?]): string {
  return [...t].filter(Boolean).sort().join('+');
}

function matchKey(m: MatchPairing): string {
  return [teamKey(m.team1), teamKey(m.team2)].sort().join(' vs ');
}

function prettyMatch(m: MatchPairing): string {
  return `${m.team1.filter(Boolean).join('&')} vs ${m.team2.filter(Boolean).join('&')}`;
}

function drawByRound(matches: MatchPairing[]): void {
  const byRound = new Map<number, MatchPairing[]>();
  for (const m of matches) {
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round)!.push(m);
  }
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    console.log(`    Round ${round}: ` + byRound.get(round)!.map(prettyMatch).join(', '));
  }
}

// ── generateMLPSchedule (team round robin) ───────────────────────
function testMLPSchedule(T: number) {
  header(`MLP Schedule · ${T} teams`);
  const ts = teams(T);
  const ms = generateMLPSchedule(ts);
  console.log(`    Total team-vs-team matchups: ${ms.length}`);
  drawByRound(ms);

  const realKeys = new Set(ts.map(teamKey));

  // Round robin over teams: T(T-1)/2 matchups, each unique.
  const expected = (T * (T - 1)) / 2;
  assertEq(`T=${T}: matchup count`, ms.length, expected);
  assertEq(`T=${T}: unique matchups`, new Set(ms.map(matchKey)).size, expected);

  // No 'BYE' token leaks, and no team is undefined / malformed (the odd-T
  // back-map safety check). Each emitted team must be a real input pair.
  let leakOrUndef = false;
  let detail = '';
  for (const m of ms) {
    for (const t of [m.team1, m.team2]) {
      const filled = (t as (string | undefined)[]).filter(Boolean);
      if (t === undefined || filled.length !== 2) {
        leakOrUndef = true; detail = `malformed/undefined team in ${prettyMatch(m)}`; break;
      }
      for (const p of t) {
        if (p === 'BYE' || p === undefined) {
          leakOrUndef = true; detail = `'BYE'/undefined player in ${prettyMatch(m)}`; break;
        }
      }
      if (!realKeys.has(teamKey(t))) {
        leakOrUndef = true; detail = `team ${JSON.stringify(t)} is not an input team`; break;
      }
      if (leakOrUndef) break;
    }
    if (leakOrUndef) break;
  }
  assertTrue(`T=${T}: no 'BYE'/undefined leak; every team is a real input pair`, !leakOrUndef, detail);

  // Every team plays exactly T-1 matchups (and exactly T teams appear).
  const counts = new Map<string, number>();
  for (const m of ms) {
    for (const t of [m.team1, m.team2]) {
      const k = teamKey(t);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const allEqual = counts.size === T && [...counts.values()].every(c => c === T - 1);
  assertTrue(`T=${T}: every team plays ${T - 1} matchups (${T} teams appear)`, allEqual,
    `counts: ${JSON.stringify([...counts])}`);

  // No team double-booked within a round.
  const roundKeys = new Map<number, string[]>();
  for (const m of ms) {
    if (!roundKeys.has(m.round)) roundKeys.set(m.round, []);
    roundKeys.get(m.round)!.push(teamKey(m.team1), teamKey(m.team2));
  }
  let roundOk = true; let rDetail = '';
  for (const [r, ks] of roundKeys) {
    if (new Set(ks).size !== ks.length) { roundOk = false; rDetail = `round ${r} repeats a team`; break; }
  }
  assertTrue(`T=${T}: no team double-booked within a round`, roundOk, rDetail);
}

// ── validateMlpTeams ─────────────────────────────────────────────
function mlpTeam(id: string, m1: string, m2: string, f1: string, f2: string): MlpTeamShape {
  return { id, name: id, male_1_id: m1, male_2_id: m2, female_1_id: f1, female_2_id: f2 };
}

function testValidateMlpTeams() {
  header(`validateMlpTeams · error flags`);

  // Fully valid set of 2 complete, disjoint teams → null.
  const valid = [
    mlpTeam('A', 'a1', 'a2', 'a3', 'a4'),
    mlpTeam('B', 'b1', 'b2', 'b3', 'b4'),
  ];
  assertEq(`valid set → null`, validateMlpTeams(valid), null);

  // Fewer than 2 teams → NOT_ENOUGH_MLP_TEAMS.
  assertEq(`<2 teams → NOT_ENOUGH_MLP_TEAMS`,
    validateMlpTeams([mlpTeam('A', 'a1', 'a2', 'a3', 'a4')])?.code,
    'NOT_ENOUGH_MLP_TEAMS');

  // A null slot → INCOMPLETE_MLP_TEAM.
  const incomplete = [
    { id: 'A', name: 'A', male_1_id: 'a1', male_2_id: null, female_1_id: 'a3', female_2_id: 'a4' },
    mlpTeam('B', 'b1', 'b2', 'b3', 'b4'),
  ];
  assertEq(`null slot → INCOMPLETE_MLP_TEAM`, validateMlpTeams(incomplete)?.code, 'INCOMPLETE_MLP_TEAM');

  // Same player twice within a team → DUPLICATE_PLAYER_IN_MLP_TEAM.
  const dupWithin = [
    mlpTeam('A', 'a1', 'a1', 'a3', 'a4'),
    mlpTeam('B', 'b1', 'b2', 'b3', 'b4'),
  ];
  assertEq(`dup within team → DUPLICATE_PLAYER_IN_MLP_TEAM`,
    validateMlpTeams(dupWithin)?.code, 'DUPLICATE_PLAYER_IN_MLP_TEAM');

  // Player on two teams → PLAYER_ON_MULTIPLE_MLP_TEAMS.
  const dupAcross = [
    mlpTeam('A', 'a1', 'a2', 'a3', 'a4'),
    mlpTeam('B', 'a1', 'b2', 'b3', 'b4'),
  ];
  assertEq(`player on two teams → PLAYER_ON_MULTIPLE_MLP_TEAMS`,
    validateMlpTeams(dupAcross)?.code, 'PLAYER_ON_MULTIPLE_MLP_TEAMS');
}

// ── Run everything ───────────────────────────────────────────────
console.log('\n\x1b[1mPickleague MLP schedule + validation simulations (Unit 6)\x1b[0m');
console.log('All input/output is pure data — no Supabase round-trip.\n');

testValidateMlpTeams();

const TEAM_COUNTS = [2, 3, 4, 5, 6, 7, 8];
for (const T of TEAM_COUNTS) testMLPSchedule(T);

header(`generateMLPSchedule · input guards`);
assertThrows(`throws for T=1`, () => generateMLPSchedule(teams(1)));
assertThrows(`throws for T=0`, () => generateMLPSchedule(teams(0)));

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
