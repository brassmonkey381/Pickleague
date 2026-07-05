// Calibrate the Plackett-Luce sharpening exponent beta per format: find the
// beta that best matches PL rank-1 probabilities to true Monte-Carlo bracket
// probabilities, minimizing the worst residual EV, across several field shapes.
const TRIALS = 120_000;
const pWin = (a, b) => 1 / (1 + Math.pow(10, (b - a) * 0.5));

const FIELDS = {
  'lopsided-8': [6.995, 6.890, 5.485, 4.829, 4.138, 4.008, 3.998, 3.524],
  'one-star-8': [6.5, 4.2, 4.1, 4.0, 3.9, 3.8, 3.7, 3.5],
  'tight-8':    [4.6, 4.5, 4.4, 4.3, 4.2, 4.1, 4.0, 3.9],
  'lopsided-4': [6.995, 4.1, 4.0, 3.9],
  'tight-6':    [4.5, 4.4, 4.3, 4.2, 4.1, 4.0],
  'mixed-12':   [6.9, 6.0, 5.5, 5.0, 4.8, 4.6, 4.4, 4.2, 4.0, 3.8, 3.6, 3.4],
};

function simSingleElim(rs) {
  let alive = rs.map((r, i) => ({ r, i }));
  let size = 1; while (size < alive.length) size *= 2;
  let round = [];
  for (let i = 0; i < size / 2; i++) round.push(mw(alive[i], alive[size - 1 - i]));
  while (round.length > 1) { const nx = []; for (let i = 0; i < round.length; i += 2) nx.push(mw(round[i], round[i + 1])); round = nx; }
  return round[0].i;
}
const mw = (a, b) => !a ? b : !b ? a : (Math.random() < pWin(a.r, b.r) ? a : b);
function simRR(rs) {
  const w = rs.map(() => 0);
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) (Math.random() < pWin(rs[i], rs[j])) ? w[i]++ : w[j]++;
  let best = 0; for (let i = 1; i < rs.length; i++) if (w[i] > w[best] || (w[i] === w[best] && rs[i] > rs[best])) best = i;
  return best;
}
function trueP1(rs, sim) {
  const c = rs.map(() => 0);
  for (let t = 0; t < TRIALS; t++) c[sim(rs)]++;
  return c.map(x => x / TRIALS);
}
function plP1(rs, beta) {
  const w = rs.map(r => Math.pow(10, 0.5 * beta * r));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / s);
}
// worst-case EV over the field at a given beta (favours the exploiter's best bet)
function worstEV(trueP, rs, beta) {
  const q = plP1(rs, beta);
  let worst = -1;
  for (let i = 0; i < rs.length; i++) {
    const prob = Math.min(0.95, Math.max(0.02, q[i]));
    const odds = 0.95 / prob;
    const ev = trueP[i] * odds - 1;
    if (ev > worst) worst = ev;
  }
  return worst;
}

for (const [fmt, sim] of [['SINGLE ELIM', simSingleElim], ['ROUND ROBIN', simRR]]) {
  console.log(`\n=== ${fmt}: worst +EV bet remaining, by sharpening beta ===`);
  const trueByField = Object.fromEntries(Object.entries(FIELDS).map(([n, rs]) => [n, trueP1(rs, sim)]));
  const betas = [1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.5];
  console.log('  field'.padEnd(14) + betas.map(b => `b=${b}`.padStart(7)).join(''));
  const totals = betas.map(() => -1);
  for (const [name, rs] of Object.entries(FIELDS)) {
    const row = betas.map(b => worstEV(trueByField[name], rs, b));
    row.forEach((v, i) => { if (v > totals[i]) totals[i] = v; });
    console.log('  ' + name.padEnd(12) + row.map(v => `${(v * 100 >= 0 ? '+' : '') + (v * 100).toFixed(0)}%`.padStart(7)).join(''));
  }
  console.log('  ' + 'WORST'.padEnd(12) + totals.map(v => `${(v * 100 >= 0 ? '+' : '') + (v * 100).toFixed(0)}%`.padStart(7)).join(''));
  const best = betas[totals.indexOf(Math.min(...totals))];
  console.log(`  >>> beta minimizing the worst exploit: ${best}`);
}
