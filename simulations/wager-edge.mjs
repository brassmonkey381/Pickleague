/**
 * wager-edge — discover the TRUE odds of Pickleague wager markets and find
 * positive-expected-value (exploitable) bets.
 *
 * Method: the app already commits to an Elo win model for match odds
 *   p(team1 beats team2) = 1 / (1 + 10^((r2 - r1) * 0.5))
 * Internal consistency then DEMANDS the rank markets price a player's chance
 * of finishing #1 at their true bracket-win probability. We compute that true
 * probability by Monte-Carlo-simulating the actual bracket many times with the
 * app's own per-match formula, and compare it to what calculate_wager_odds
 * actually quotes.
 *
 *   quoted_prob(rank)  = (1/sqrt(N)) * 0.5^(rank-1)     [ignores rating!]
 *   quoted_odds        = 0.95 / quoted_prob             [5% house edge]
 *   payout             = stake * quoted_odds
 *   EV per unit staked = p_true * quoted_odds - 1
 * A bet is exploitable when p_true > quoted_prob / 0.95.
 *
 * Run: node simulations/wager-edge.mjs
 */

const HOUSE_EDGE = 0.05;
const TRIALS = 200_000;

// A realistic 8-player field from the seeded Toolbox League: two dominant
// players (~7.0) and a cluster around ~4.0 — exactly the kind of field where a
// rating-blind market misprices the favorites.
const FIELD8 = [
  { name: 'P8 (6.995)', r: 6.995 },
  { name: 'P7 (6.890)', r: 6.890 },
  { name: 'P10 (5.485)', r: 5.485 },
  { name: 'P12 (4.829)', r: 4.829 },
  { name: 'P3 (4.138)', r: 4.138 },
  { name: 'P1 (4.008)', r: 4.008 },
  { name: 'P5 (3.998)', r: 3.998 },
  { name: 'P6 (3.524)', r: 3.524 },
];

// per-match win prob for A over B — the app's exact formula
const pWin = (rA, rB) => 1 / (1 + Math.pow(10, (rB - rA) * 0.5));

function simSingleElim(players) {
  // seed 1..N already ordered strongest-first; standard 1vN bracket
  let alive = players.map((p, i) => ({ ...p, seed: i }));
  // pad to power of two with byes (null)
  let size = 1; while (size < alive.length) size *= 2;
  const bracket = [];
  for (let i = 0; i < size / 2; i++) {
    bracket.push([alive[i] ?? null, alive[size - 1 - i] ?? null]);
  }
  let round = bracket.map(([a, b]) => matchWinner(a, b));
  while (round.length > 1) {
    const next = [];
    for (let i = 0; i < round.length; i += 2) next.push(matchWinner(round[i], round[i + 1]));
    round = next;
  }
  return round[0];
}
function matchWinner(a, b) {
  if (!a) return b; if (!b) return a;
  return Math.random() < pWin(a.r, b.r) ? a : b;
}

function simRoundRobin(players) {
  const wins = players.map(() => 0);
  for (let i = 0; i < players.length; i++)
    for (let j = i + 1; j < players.length; j++)
      if (Math.random() < pWin(players[i].r, players[j].r)) wins[i]++; else wins[j]++;
  // rank 1 = most wins, ties broken by rating (mirrors the standings comparator)
  let best = 0;
  for (let i = 1; i < players.length; i++) {
    if (wins[i] > wins[best] || (wins[i] === wins[best] && players[i].r > players[best].r)) best = i;
  }
  return players[best];
}

function trueWinProbsCorrect(players, simFn) {
  const counts = new Map(players.map(p => [p.name, 0]));
  for (let t = 0; t < TRIALS; t++) {
    const w = simFn(players);
    counts.set(w.name, counts.get(w.name) + 1);
  }
  const out = new Map();
  for (const [k, v] of counts) out.set(k, v / TRIALS);
  return out;
}

function analyze(label, players, simFn) {
  const N = players.length;
  const quotedProb = 1 / Math.sqrt(N);              // rank=1, every player
  const quotedOdds = (1 - HOUSE_EDGE) / quotedProb;
  const trueP = trueWinProbsCorrect(players, simFn);
  console.log(`\n=== ${label} — N=${N}, quoted prob(#1)=${quotedProb.toFixed(4)} for EVERYONE, odds=${quotedOdds.toFixed(3)}x ===`);
  console.log('  A fair market would need true-prob to sum to 1.00; this market\'s quoted probs sum to ' +
    (quotedProb * N).toFixed(2) + ' (√N).');
  console.log('  player           true P(#1)   fair odds   quoted odds   EV/unit   verdict');
  let sumTrue = 0, bestEV = -1, bestName = '';
  for (const p of players) {
    const pt = trueP.get(p.name);
    sumTrue += pt;
    const fairOdds = pt > 0 ? 1 / pt : Infinity;
    const ev = pt * quotedOdds - 1;
    if (ev > bestEV) { bestEV = ev; bestName = p.name; }
    const verdict = ev > 0.001 ? `+EV  BET  (edge ${(ev * 100).toFixed(0)}%)` : ev < -0.001 ? 'house wins' : 'fair';
    console.log(`  ${p.name.padEnd(14)}  ${pt.toFixed(4)}      ${(isFinite(fairOdds) ? fairOdds.toFixed(2) : '∞').padStart(6)}x     ${quotedOdds.toFixed(3)}x       ${(ev >= 0 ? '+' : '') + ev.toFixed(3)}   ${verdict}`);
  }
  console.log(`  (true probs sum to ${sumTrue.toFixed(3)} ✓)`);
  console.log(`  >>> best bet: ${bestName} at +${(bestEV * 100).toFixed(0)}% expected return per pickle staked.`);
  return { bestName, bestEV, quotedOdds };
}

console.log('PICKLEAGUE WAGER EDGE ANALYSIS');
console.log('==============================');
console.log('Model: the app\'s own Elo formula p = 1/(1+10^((rB-rA)*0.5)).');
console.log(`Monte Carlo: ${TRIALS.toLocaleString()} bracket simulations per format.`);

analyze('tournament_rank · SINGLE ELIM', FIELD8, simSingleElim);
analyze('tournament_rank · ROUND ROBIN', FIELD8, simRoundRobin);

// N-sensitivity of the break-even favorite: how strong must the favorite be
// for a rank-1 bet to turn +EV, as the field grows?
console.log('\n=== break-even favorite strength by field size ===');
console.log('  N    quoted prob   break-even true P   (= uniform 1/N x this multiple)');
for (const N of [2, 4, 6, 8, 12, 16, 24, 32]) {
  const q = 1 / Math.sqrt(N);
  const be = q / (1 - HOUSE_EDGE);
  console.log(`  ${String(N).padStart(2)}    ${q.toFixed(4)}        ${be.toFixed(4)}             ${(be * N).toFixed(2)}x`);
}
console.log('\nInterpretation: any player whose true chance of #1 exceeds the break-even');
console.log('column is a profitable bet. Because the market quotes the SAME price for');
console.log('every competitor, every real favorite is systematically underpriced and');
console.log('every underdog is systematically overpriced.');
