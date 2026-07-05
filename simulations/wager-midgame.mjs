/**
 * wager-midgame — validate PROGRESS-AWARE quoting: place a tournament partway
 * through and check the live RPC odds against the true probability of the
 * REMAINING event.
 *
 * Check A (single elim): after round 1, every eliminated player must be quoted
 *   at the floor (can't win), and survivors repriced up. Also: betting a
 *   completed match must be rejected.
 * Check B (round robin): after ~60% of games, compare RPC odds to a Monte
 *   Carlo of the remaining games (respecting results so far). No eligible
 *   player should be grossly +EV.
 *
 * Run: node simulations/wager-midgame.mjs   (needs SUPABASE_* env)
 */
import { createClient } from '@supabase/supabase-js';
import { generateSingleElim, generateRoundRobin } from '../mobile/src/lib/tournament.ts';

const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const pWin = (a, b) => 1 / (1 + Math.pow(10, (b - a) * 0.5));

const cache = new Map();
async function signIn(n) {
  if (cache.has(n)) return cache.get(n);
  const client = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: `sim_player_${n}@pickleague.test`, password: 'pickle123' });
  if (error) throw new Error(error.message);
  const a = { n, id: data.user.id, client }; cache.set(n, a); return a;
}
const oddsFor = async (tid, uid, rank = 1) => {
  const { data } = await admin.rpc('calculate_wager_odds', { p_subject_type: 'tournament_rank', p_subject_id: tid, p_predicate: { user_id: uid, rank } });
  const r = Array.isArray(data) ? data[0] : data;
  return { prob: Number(r.probability), odds: Number(r.odds) };
};

async function makeTournament(host, actors, ids, fmt) {
  const { data: t } = await host.client.from('tournaments').insert({
    name: `[SIM] midgame ${fmt} ${Date.now()}`, created_by: host.id, format: fmt, match_type: 'singles',
    registration_mode: 'request', team_creation: 'fixed', status: 'registration', seeding: 'random', pool_count: 1, pickle_ante: 0, payout_structure: [100],
  }).select('id').single();
  await host.client.from('tournament_registrations').insert({ tournament_id: t.id, user_id: host.id, status: 'approved', role: 'admin' });
  for (const a of actors) { if (a.id === host.id) continue;
    await a.client.from('tournament_registrations').insert({ tournament_id: t.id, user_id: a.id });
    const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', t.id).eq('user_id', a.id).single();
    await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg.id);
  }
  let seed = 0; for (const id of ids) await host.client.from('tournament_registrations').update({ seed: ++seed }).eq('tournament_id', t.id).eq('user_id', id);
  return t.id;
}

(async () => {
  // pick 8 players with the widest rating spread available
  const emails = Array.from({ length: 16 }, (_, i) => i + 1);
  const all = [];
  for (const n of emails) all.push(await signIn(n));
  const { data: profs } = await admin.from('profiles').select('id, rating').in('id', all.map(a => a.id));
  const ratingOf = new Map(profs.map(p => [p.id, Number(p.rating)]));
  all.sort((a, b) => ratingOf.get(b.id) - ratingOf.get(a.id));
  const field = all.slice(0, 8);                 // top 8 by rating (some spread)
  const ids = field.map(a => a.id);
  const host = field[0];

  // ── Check A: single elim, play round 1 ────────────────────────────────
  console.log('CHECK A — single elimination, after round 1\n');
  const tA = await makeTournament(host, field, ids, 'single_elimination');
  const { data: roundA } = await host.client.from('tournament_rounds')
    .insert({ tournament_id: tA, round_number: 1, label: 'R1', round_type: 'winners' }).select('id').single();
  const pairs = generateSingleElim(ids);
  const rows = pairs.map((m, i) => ({ tournament_id: tA, round_id: roundA.id, match_order: i, match_type: 'singles',
    team1_player1: m.team1[0] === 'BYE' ? null : m.team1[0], team2_player1: m.team2[0] === 'BYE' ? null : m.team2[0] }));
  await host.client.from('tournament_matches').insert(rows);
  await host.client.from('tournaments').update({ status: 'active' }).eq('id', tA);
  // score round 1 by Elo
  const { data: r1 } = await admin.from('tournament_matches').select('id, team1_player1, team2_player1, status').eq('tournament_id', tA);
  const eliminated = new Set(), survived = new Set();
  let aCompleted = null;
  for (const m of r1) {
    if (!m.team1_player1 || !m.team2_player1) { if (m.team1_player1) survived.add(m.team1_player1); continue; }
    const t1 = Math.random() < pWin(ratingOf.get(m.team1_player1), ratingOf.get(m.team2_player1));
    await host.client.from('tournament_matches').update({ team1_score: t1 ? 11 : 6, team2_score: t1 ? 6 : 11, winner_team: t1 ? 'team1' : 'team2', status: 'completed' }).eq('id', m.id);
    survived.add(t1 ? m.team1_player1 : m.team2_player1);
    eliminated.add(t1 ? m.team2_player1 : m.team1_player1);
    aCompleted = m.id;
  }
  let elimMax = 0, survMin = 1;
  for (const id of eliminated) { const o = await oddsFor(tA, id); elimMax = Math.max(elimMax, o.prob); }
  for (const id of survived)   { const o = await oddsFor(tA, id); survMin = Math.min(survMin, o.prob); }
  console.log(`  eliminated players: quoted prob(#1) max = ${elimMax.toFixed(3)}  (want ~0.02 floor)`);
  console.log(`  survivors:          quoted prob(#1) min = ${survMin.toFixed(3)}  (want > eliminated)`);
  console.log(`  ${elimMax <= 0.03 && survMin > elimMax ? 'PASS' : 'FAIL'} — eliminated players are floored, survivors repriced up`);
  // completed-match betting guard
  const bettor = all.find(a => !ids.includes(a.id)) ?? all[8];
  const { data: cm } = await bettor.client.rpc('place_wager', { p_subject_type: 'tournament_match', p_subject_id: aCompleted, p_predicate: { winner_team: 'team1' }, p_stake: 10 });
  const cmr = Array.isArray(cm) ? cm[0] : cm;
  console.log(`  ${(!cmr.success && /closed/i.test(cmr.message)) ? 'PASS' : 'FAIL'} — betting a decided match is rejected ("${cmr.message}")`);
  await admin.rpc('godmode_delete_tournament', { p_tournament_id: tA });

  // ── Check B: round robin, play ~60% then compare to remaining MC ───────
  console.log('\nCHECK B — round robin, ~60% played, quoted vs true-of-remaining\n');
  const rr = field.slice(0, 6); const rrIds = rr.map(a => a.id);
  const tB = await makeTournament(host, rr, rrIds, 'round_robin');
  const { data: roundB } = await host.client.from('tournament_rounds')
    .insert({ tournament_id: tB, round_number: 1, label: 'RR', round_type: 'winners' }).select('id').single();
  const rrPairs = generateRoundRobin(rrIds);
  const brows = rrPairs.map((m, i) => ({ tournament_id: tB, round_id: roundB.id, match_order: i, match_type: 'singles', team1_player1: m.team1[0], team2_player1: m.team2[0] }));
  await host.client.from('tournament_matches').insert(brows);
  await host.client.from('tournaments').update({ status: 'active' }).eq('id', tB);
  const { data: bm } = await admin.from('tournament_matches').select('id, team1_player1, team2_player1').eq('tournament_id', tB).order('match_order');
  const playCount = Math.floor(bm.length * 0.6);
  const wins = new Map(rrIds.map(id => [id, 0]));
  const remaining = [];
  for (let i = 0; i < bm.length; i++) {
    const m = bm[i];
    if (i < playCount) {
      const t1 = Math.random() < pWin(ratingOf.get(m.team1_player1), ratingOf.get(m.team2_player1));
      const w = t1 ? m.team1_player1 : m.team2_player1;
      wins.set(w, wins.get(w) + 1);
      await host.client.from('tournament_matches').update({ team1_score: t1 ? 11 : 6, team2_score: t1 ? 6 : 11, winner_team: t1 ? 'team1' : 'team2', status: 'completed' }).eq('id', m.id);
    } else remaining.push([m.team1_player1, m.team2_player1]);
  }
  // true P(#1) via MC of the remaining games
  const TRIALS = 60_000;
  const firstCount = new Map(rrIds.map(id => [id, 0]));
  for (let t = 0; t < TRIALS; t++) {
    const w = new Map(wins);
    for (const [a, b] of remaining) { const x = Math.random() < pWin(ratingOf.get(a), ratingOf.get(b)) ? a : b; w.set(x, w.get(x) + 1); }
    let best = rrIds[0];
    for (const id of rrIds) if (w.get(id) > w.get(best) || (w.get(id) === w.get(best) && ratingOf.get(id) > ratingOf.get(best))) best = id;
    firstCount.set(best, firstCount.get(best) + 1);
  }
  console.log('  player   rating  wins-so-far  true P(#1)  quoted odds  EV');
  let worst = -1;
  for (const a of rr) {
    const trueP = firstCount.get(a.id) / TRIALS;
    const o = await oddsFor(tB, a.id);
    const ev = trueP * o.odds - 1;
    worst = Math.max(worst, ev);
    console.log(`  P${String(a.n).padEnd(2)}     ${ratingOf.get(a.id).toFixed(2)}     ${String(wins.get(a.id)).padStart(2)}          ${trueP.toFixed(3)}       ${o.odds.toFixed(2)}x     ${(ev >= 0 ? '+' : '') + (ev * 100).toFixed(0)}%`);
  }
  console.log(`  worst residual EV over the live field: ${(worst >= 0 ? '+' : '') + (worst * 100).toFixed(0)}%`);
  await admin.rpc('godmode_delete_tournament', { p_tournament_id: tB });
})();
