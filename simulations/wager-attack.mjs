/**
 * wager-attack — beat the wager system for real, end to end.
 *
 * Repeatedly bets a fixed stake on the tournament FAVOURITE to finish #1,
 * through the actual place_wager RPC (real quoted odds) and the actual
 * settlement trigger — across many real tournaments whose matches are decided
 * by the app's own Elo model. Tallies realized profit to prove the rank market
 * overpays favourites in practice, not just in theory.
 *
 * Field: one dominant player (~7.0) vs three ~4.0s in a 4-player round robin.
 * Break-even true-prob for N=4 is 0.526; the favourite's true P(#1) is ~0.85,
 * quoted at 1/sqrt(4)=0.50 -> 1.9x odds -> ~+61% EV per bet.
 *
 * Run: node simulations/wager-attack.mjs   (needs SUPABASE_* env)
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) { console.error('need SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const K = 16;           // tournaments to run
const STAKE = 100;      // pickles per bet
// Field is passed as args: FIELD players then --bettor N. Favourite is chosen
// DYNAMICALLY as the highest-rated player in the field (what a real exploiter
// does). Default = a lopsided field led by P7 (~6.9).
const args = process.argv.slice(2).map(Number).filter(n => !Number.isNaN(n));
const FIELD = args.length >= 2 ? args : [7, 1, 4, 5];
const BETTOR = 2;       // a non-participant places all the bets (clean P&L)

const cache = new Map();
async function signIn(n) {
  if (cache.has(n)) return cache.get(n);
  const email = `sim_player_${n}@pickleague.test`;
  const client = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: 'pickle123' });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  const a = { n, id: data.user.id, client };
  cache.set(n, a);
  return a;
}

const pWin = (rA, rB) => 1 / (1 + Math.pow(10, (rB - rA) * 0.5));

(async () => {
  // resolve the field's ids + live ratings
  const actors = {};
  for (const n of [...new Set([...FIELD, BETTOR])]) actors[n] = await signIn(n);
  const ids = FIELD.map(n => actors[n].id);
  const { data: profs } = await admin.from('profiles').select('id, rating').in('id', ids);
  const ratingOf = new Map(profs.map(p => [p.id, Number(p.rating)]));
  // the exploiter bets the strongest player in the field
  const favId = ids.slice().sort((a, b) => ratingOf.get(b) - ratingOf.get(a))[0];
  const FAV = FIELD.find(n => actors[n].id === favId);
  const bettor = actors[BETTOR];

  // make sure the bettor can cover every stake
  await admin.from('profiles').update({ pickles: 100000 }).eq('id', bettor.id);
  const startBal = Number((await admin.from('profiles').select('pickles').eq('id', bettor.id).single()).data.pickles);

  console.log(`WAGER ATTACK — betting ${STAKE}🥒 on the favourite (P${FAV}, rating ${ratingOf.get(favId).toFixed(2)}) to finish #1`);
  console.log(`field: ${FIELD.map(n => `P${n}(${ratingOf.get(actors[n].id).toFixed(1)})`).join(', ')} · ${K} round-robin tournaments\n`);

  let staked = 0, returned = 0, wins = 0, favFirst = 0, quotedOddsSeen = null;
  const host = actors[FIELD[0] === FAV ? FIELD[1] : FIELD[0]] ?? actors[1];

  for (let k = 0; k < K; k++) {
    const stamp = `${Date.now()}-${k}`;
    // 1. create tournament + approve the field
    const { data: t, error: te } = await host.client.from('tournaments').insert({
      name: `[SIM] wager-attack ${stamp}`, created_by: host.id, format: 'round_robin', match_type: 'singles',
      registration_mode: 'request', team_creation: 'fixed', status: 'registration', seeding: 'random', pool_count: 1,
      pickle_ante: 0, payout_structure: [100],
    }).select('id').single();
    if (te) throw new Error('create: ' + te.message);
    await host.client.from('tournament_registrations').insert({ tournament_id: t.id, user_id: host.id, status: 'approved', role: 'admin' });
    for (const n of FIELD) {
      if (actors[n].id === host.id) continue;
      await actors[n].client.from('tournament_registrations').insert({ tournament_id: t.id, user_id: actors[n].id });
      const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', t.id).eq('user_id', actors[n].id).single();
      await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg.id);
    }

    // 2. place the wager through the REAL odds engine, while the market is open
    const { data: w } = await bettor.client.rpc('place_wager', {
      p_subject_type: 'tournament_rank', p_subject_id: t.id,
      p_predicate: { user_id: favId, rank: 1 }, p_stake: STAKE,
    });
    const wr = Array.isArray(w) ? w[0] : w;
    if (!wr?.success) throw new Error('place_wager: ' + (wr?.message ?? 'failed'));
    quotedOddsSeen = wr.odds;
    staked += STAKE;

    // 3. generate the round robin, score each match by the app's Elo model
    const { data: round } = await host.client.from('tournament_rounds')
      .insert({ tournament_id: t.id, round_number: 1, label: 'Round Robin Schedule', round_type: 'winners' }).select('id').single();
    const rows = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++)
      rows.push({ tournament_id: t.id, round_id: round.id, match_order: rows.length, match_type: 'singles',
                  team1_player1: ids[i], team2_player1: ids[j] });
    await host.client.from('tournament_matches').insert(rows);
    await host.client.from('tournaments').update({ status: 'active' }).eq('id', t.id);
    let seed = 0;
    for (const id of ids) await host.client.from('tournament_registrations').update({ seed: ++seed }).eq('tournament_id', t.id).eq('user_id', id);

    const { data: tms } = await admin.from('tournament_matches').select('id, team1_player1, team2_player1').eq('tournament_id', t.id);
    for (const m of tms) {
      const a = ratingOf.get(m.team1_player1), b = ratingOf.get(m.team2_player1);
      const t1 = Math.random() < pWin(a, b);
      await host.client.from('tournament_matches').update({
        team1_score: t1 ? 11 : 3 + Math.floor(Math.random() * 6),
        team2_score: t1 ? 3 + Math.floor(Math.random() * 6) : 11,
        winner_team: t1 ? 'team1' : 'team2', status: 'completed',
      }).eq('id', m.id);
    }
    await host.client.rpc('admin_complete_tournament', { p_tournament_id: t.id });

    // 4. read who actually finished #1 and how the wager settled
    const { data: rank1 } = await admin.from('tournament_final_ranks').select('user_id').eq('tournament_id', t.id).eq('final_rank', 1).maybeSingle();
    if (rank1?.user_id === favId) favFirst++;
    const { data: settled } = await admin.from('wagers').select('status, potential_payout, stake').eq('id', wr.wager_id).single();
    if (settled.status === 'won') { returned += settled.potential_payout; wins++; }
    process.stdout.write(rank1?.user_id === favId ? (settled.status === 'won' ? '✓' : '?') : '·');

    // tidy each tournament so we don't leave a pile behind
    await admin.rpc('godmode_delete_tournament', { p_tournament_id: t.id });
  }

  const endBal = Number((await admin.from('profiles').select('pickles').eq('id', bettor.id).single()).data.pickles);
  const net = endBal - startBal;
  console.log(`\n\nquoted odds seen: ${quotedOddsSeen}x  (fair for a 50/50 event; favourite is ~85% to win)`);
  console.log(`favourite finished #1 in ${favFirst}/${K} tournaments (true win rate ${(favFirst / K * 100).toFixed(0)}%)`);
  console.log(`bets won: ${wins}/${K}`);
  console.log(`staked:   ${staked}🥒`);
  console.log(`returned: ${returned}🥒`);
  console.log(`NET (real balance delta): ${net >= 0 ? '+' : ''}${net}🥒   =  ${net >= 0 ? '+' : ''}${(net / staked * 100).toFixed(1)}% on turnover`);
  console.log(net > 0
    ? `\n>>> BEAT THE HOUSE: a rating-blind rank market let a favourite-only strategy print a ${(net / staked * 100).toFixed(0)}% profit.`
    : `\n(variance ran against us this batch — the per-bet EV is still positive; rerun to confirm)`);
})();
