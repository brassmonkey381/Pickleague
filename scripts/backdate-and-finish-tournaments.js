// Backdate every open tournament by 30 days, simulate all unfinished matches,
// then mark the tournament 'completed' (Ended).
//
// "Open" here = status in ('registration', 'active').
//
// Score model: pickleball to 11, win by 2.
// - Weighted toward competitive scores (7-9 for the loser) with occasional blowouts.
// - Winner is chosen 50/50.
//
// Run:
//   set -a && . mobile/.env && set +a && node scripts/backdate-and-finish-tournaments.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SHIFT_DAYS = 30;
const SHIFT_MS   = SHIFT_DAYS * 24 * 60 * 60 * 1000;

// Pickleball score generator: returns [winnerScore, loserScore].
// 11 with win-by-2, so winner can be 11 or 12+ (but most matches end at 11).
function rollScore() {
  const r = Math.random();
  // 70% close (loser 7–9), 20% medium (loser 4–6), 10% blowout (loser 0–3)
  let loser;
  if (r < 0.70)      loser = 7 + Math.floor(Math.random() * 3);   // 7,8,9
  else if (r < 0.90) loser = 4 + Math.floor(Math.random() * 3);   // 4,5,6
  else               loser = Math.floor(Math.random() * 4);       // 0,1,2,3

  // 15% chance the game went deuce → winner 12-10
  if (loser === 9 && Math.random() < 0.15) return [12, 10];
  return [11, loser];
}

function shiftIso(iso) {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() - SHIFT_MS).toISOString();
}

async function processTournament(t) {
  console.log(`── ${t.name}  (${t.format}, ${t.status}) ───────────────`);

  // 1. Backdate tournament start_time
  if (t.start_time) {
    const newStart = shiftIso(t.start_time);
    const { error } = await supabase.from('tournaments').update({ start_time: newStart }).eq('id', t.id);
    if (error) console.error(`  ✗  start_time backdate — ${error.message}`);
    else       console.log(`  ✓  start_time: ${t.start_time.slice(0,10)} → ${newStart.slice(0,10)}`);
  }

  // 2. Fetch all matches for this tournament
  const { data: matches, error: mErr } = await supabase
    .from('tournament_matches')
    .select('*')
    .eq('tournament_id', t.id);
  if (mErr) { console.error(`  ✗  fetch matches — ${mErr.message}`); return; }

  console.log(`  ·  ${matches.length} matches found`);

  // 3. Backdate scheduled_at + simulate scores for any not yet completed
  let simulated = 0, alreadyDone = 0, skippedNoPlayers = 0, failed = 0;
  for (const m of matches) {
    const update = {};

    if (m.scheduled_at) update.scheduled_at = shiftIso(m.scheduled_at);

    if (m.status === 'completed') {
      alreadyDone++;
    } else {
      // Need both teams to have at least one player to simulate
      const team1Has = m.team1_player1 || m.team1_player2;
      const team2Has = m.team2_player1 || m.team2_player2;
      if (!team1Has || !team2Has) {
        skippedNoPlayers++;
        // Still mark complete-ish? No — leave pending if unscored. Just backdate.
      } else {
        const [winS, loseS] = rollScore();
        const team1Wins = Math.random() < 0.5;
        update.team1_score  = team1Wins ? winS  : loseS;
        update.team2_score  = team1Wins ? loseS : winS;
        update.winner_team  = team1Wins ? 'team1' : 'team2';
        update.status       = 'completed';
        simulated++;
      }
    }

    if (Object.keys(update).length === 0) continue;
    const { error } = await supabase.from('tournament_matches').update(update).eq('id', m.id);
    if (error) { failed++; console.error(`    ✗  match ${m.id.slice(0,8)} — ${error.message}`); }
  }

  console.log(`  ✓  simulated ${simulated}, already done ${alreadyDone}, skipped ${skippedNoPlayers}, failed ${failed}`);

  // 4. Mark tournament completed
  const { error: sErr } = await supabase.from('tournaments').update({ status: 'completed' }).eq('id', t.id);
  if (sErr) console.error(`  ✗  status → completed — ${sErr.message}`);
  else      console.log(`  ✓  status → completed`);
}

async function run() {
  console.log(`Backdating + finishing all open tournaments  (shift: -${SHIFT_DAYS} days)\n`);

  const { data: tournaments, error } = await supabase
    .from('tournaments')
    .select('*')
    .in('status', ['registration', 'active'])
    .order('created_at');

  if (error) { console.error('Fetch tournaments failed:', error.message); process.exit(1); }
  if (!tournaments || tournaments.length === 0) {
    console.log('No open tournaments. Nothing to do.');
    return;
  }

  console.log(`Found ${tournaments.length} open tournament(s)\n`);

  for (const t of tournaments) {
    await processTournament(t);
    console.log('');
  }

  console.log('Done.');
}

run().catch((e) => { console.error(e); process.exit(1); });
