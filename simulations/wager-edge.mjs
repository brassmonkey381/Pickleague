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

// Plackett-Luce exact P(finish rank r), mirroring the DB _wager_rank_probability.
// weights[i] = 10^(0.5*rating_i). Exact for r=1,2,3.
function plRankProb(weights, target, rank) {
  const n = weights.length;
  const s = weights.reduce((a, b) => a + b, 0);
  const wt = weights[target];
  if (rank <= 1) return wt / s;
  let acc = 0;
  if (rank === 2) {
    for (let j = 0; j < n; j++) if (j !== target && s - weights[j] > 0)
      acc += (weights[j] / s) * (wt / (s - weights[j]));
    return acc;
  }
  for (let j = 0; j < n; j++) {
    if (j === target || s - weights[j] <= 0) continue;
    for (let k = 0; k < n; k++) {
      if (k === target || k === j) continue;
      const d = s - weights[j] - weights[k];
      if (d > 0) acc += (weights[j] / s) * (weights[k] / (s - weights[j])) * (wt / d);
    }
  }
  return acc;
}

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

function analyze(label, players, simFn, beta) {
  const N = players.length;
  const oldProb = 1 / Math.sqrt(N);                 // OLD: rank=1, every player
  const oldOdds = (1 - HOUSE_EDGE) / oldProb;
  const weights = players.map(p => Math.pow(10, 0.5 * beta * p.r));   // NEW: format-aware PL
  const trueP = trueWinProbsCorrect(players, simFn);
  console.log(`\n=== ${label} — N=${N} ===`);
  console.log('  player          true P(#1)  |  OLD odds  OLD EV  |  NEW odds  NEW EV');
  let bestOld = -1, bestOldName = '', bestNew = -1, bestNewName = '';
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const pt = trueP.get(p.name);
    const newProb = plRankProb(weights, i, 1);
    const newOdds = (1 - HOUSE_EDGE) / Math.min(0.95, Math.max(0.02, newProb));
    const evOld = pt * oldOdds - 1;
    const evNew = pt * newOdds - 1;
    if (evOld > bestOld) { bestOld = evOld; bestOldName = p.name; }
    if (evNew > bestNew) { bestNew = evNew; bestNewName = p.name; }
    const tag = evNew > 0.03 ? ' <-- still +EV' : '';
    console.log(`  ${p.name.padEnd(13)}  ${pt.toFixed(4)}     |  ${oldOdds.toFixed(2)}x   ${(evOld >= 0 ? '+' : '') + (evOld * 100).toFixed(0)}%  |  ${newOdds.toFixed(2).padStart(6)}x  ${(evNew >= 0 ? '+' : '') + (evNew * 100).toFixed(0)}%${tag}`);
  }
  console.log(`  best exploit  OLD: ${bestOldName} +${(bestOld * 100).toFixed(0)}%   ->   NEW: ${bestNewName} ${(bestNew >= 0 ? '+' : '') + (bestNew * 100).toFixed(0)}%`);
  return { bestOld, bestNew };
}

console.log('PICKLEAGUE WAGER EDGE ANALYSIS');
console.log('==============================');
console.log('Model: the app\'s own Elo formula p = 1/(1+10^((rB-rA)*0.5)).');
console.log(`Monte Carlo: ${TRIALS.toLocaleString()} bracket simulations per format.`);

analyze('tournament_rank · SINGLE ELIM (beta=1.0)', FIELD8, simSingleElim, 1.0);
analyze('tournament_rank · ROUND ROBIN (beta=1.8)', FIELD8, simRoundRobin, 1.8);

console.log('\nOLD = rating-blind 1/sqrt(N); NEW = Plackett-Luce (10^(0.5*rating)).');
console.log('The NEW column prices favourites near the -5% house edge — the free money is gone.');
