// Simulate the Summer Slam Doubles semi-finals and grand final.
// Reuses the pool-standings logic from the bracket UI.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TOURNAMENT_NAME = 'Summer Slam Doubles';

// Pickleball scoring — to 11, win-by-2.
// For playoffs: lean closer (these are good teams).
function rollPlayoffScore() {
  const r = Math.random();
  let loser;
  if (r < 0.55)      loser = 8 + Math.floor(Math.random() * 2);   // 8-9
  else if (r < 0.85) loser = 5 + Math.floor(Math.random() * 3);   // 5-7
  else               loser = 2 + Math.floor(Math.random() * 3);   // 2-4
  if (loser === 9 && Math.random() < 0.25) return [12, 10];
  return [11, loser];
}

function teamKey(p1, p2) { return p1 + '|' + (p2 ?? ''); }

async function main() {
  const { data: t, error: tErr } = await supabase
    .from('tournaments')
    .select('id, name, start_time, status')
    .eq('name', TOURNAMENT_NAME)
    .single();
  if (tErr || !t) throw new Error(`Tournament "${TOURNAMENT_NAME}" not found: ${tErr?.message}`);
  console.log(`Tournament: ${t.name}  (status: ${t.status})`);

  const { data: rounds } = await supabase
    .from('tournament_rounds')
    .select('*')
    .eq('tournament_id', t.id)
    .order('round_number');
  const poolA = rounds.find(r => r.label.includes('Pool A'));
  const poolB = rounds.find(r => r.label.includes('Pool B'));
  const semiR = rounds.find(r => r.round_type === 'semifinals');
  const finalR = rounds.find(r => r.round_type === 'finals');
  if (!poolA || !poolB || !semiR || !finalR) throw new Error('Missing round(s)');

  const { data: matches } = await supabase
    .from('tournament_matches')
    .select('*')
    .eq('tournament_id', t.id);

  // Build profile name lookup for nicer logging
  const profIds = new Set();
  matches.forEach(m => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2]
    .forEach(p => p && profIds.add(p)));
  const { data: profs } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', [...profIds]);
  const nameOf = id => profs.find(p => p.id === id)?.full_name ?? '?';
  const teamLabel = (p1, p2) => `${nameOf(p1)} & ${nameOf(p2)}`;

  // Compute pool standings
  function poolStandings(roundId) {
    const stats = new Map();
    const ensure = (p1, p2) => {
      if (!p1) return null;
      const key = teamKey(p1, p2);
      if (!stats.has(key)) stats.set(key, { key, p1, p2, wins: 0, losses: 0, pf: 0, pa: 0 });
      return stats.get(key);
    };
    for (const m of matches.filter(m => m.round_id === roundId)) {
      const t1 = ensure(m.team1_player1, m.team1_player2);
      const t2 = ensure(m.team2_player1, m.team2_player2);
      if (!t1 || !t2 || m.status !== 'completed' || !m.winner_team) continue;
      t1.pf += m.team1_score ?? 0; t1.pa += m.team2_score ?? 0;
      t2.pf += m.team2_score ?? 0; t2.pa += m.team1_score ?? 0;
      if (m.winner_team === 'team1') { t1.wins++; t2.losses++; }
      else                            { t2.wins++; t1.losses++; }
    }
    return Array.from(stats.values()).sort((a, b) => {
      if (a.wins !== b.wins) return b.wins - a.wins;
      return (b.pf - b.pa) - (a.pf - a.pa);
    });
  }

  const standA = poolStandings(poolA.id);
  const standB = poolStandings(poolB.id);
  const a1 = standA[0], a2 = standA[1], b1 = standB[0], b2 = standB[1];

  console.log('\nPool A standings:');
  standA.forEach((s, i) => console.log(`  ${i + 1}. ${teamLabel(s.p1, s.p2)}  (${s.wins}-${s.losses}, PD ${s.pf - s.pa >= 0 ? '+' : ''}${s.pf - s.pa})`));
  console.log('\nPool B standings:');
  standB.forEach((s, i) => console.log(`  ${i + 1}. ${teamLabel(s.p1, s.p2)}  (${s.wins}-${s.losses}, PD ${s.pf - s.pa >= 0 ? '+' : ''}${s.pf - s.pa})`));

  // Find playoff placeholder matches, sorted by match_order
  const semiMatches = matches
    .filter(m => m.round_id === semiR.id)
    .sort((a, b) => (a.match_order ?? 0) - (b.match_order ?? 0));
  const finalMatch = matches.find(m => m.round_id === finalR.id);
  if (semiMatches.length < 2) throw new Error('Expected 2 semi-final placeholder matches');
  if (!finalMatch) throw new Error('Expected 1 final placeholder match');

  // ── Bracket pairings ──
  // Semi 1: A1 vs B2  |  Semi 2: B1 vs A2  |  Final: winners of S1 vs S2
  const baseTime = new Date(t.start_time ?? Date.now());
  const semi1Time = new Date(baseTime.getTime() + 24 * 60 * 60 * 1000);  // +1 day
  const semi2Time = new Date(semi1Time.getTime() + 60 * 60 * 1000);      // +1 hr
  const finalTime = new Date(semi1Time.getTime() + 24 * 60 * 60 * 1000); // +1 day

  function rollMatch(seedA, seedB, scheduledAt) {
    // Higher pool seed (1st place) wins ~65% of the time
    const seedAIs1st = !!seedA;
    const seedBIs1st = !!seedB;
    let aWinsRoll = Math.random();
    // No skill differential adjustment needed since both came from pools — keep 50/50
    const aWins = aWinsRoll < 0.5;
    const [winS, loseS] = rollPlayoffScore();
    return {
      team1_player1: seedA.p1, team1_player2: seedA.p2,
      team2_player1: seedB.p1, team2_player2: seedB.p2,
      team1_score: aWins ? winS : loseS,
      team2_score: aWins ? loseS : winS,
      winner_team: aWins ? 'team1' : 'team2',
      status: 'completed',
      scheduled_at: scheduledAt.toISOString(),
    };
  }

  // ── Semi-Final 1: A1 vs B2 ──
  const semi1Update = rollMatch(a1, b2, semi1Time);
  const semi1 = semiMatches[0];
  console.log(`\n── Semi-Final 1 ──`);
  console.log(`  ${teamLabel(a1.p1, a1.p2)}  ${semi1Update.team1_score}-${semi1Update.team2_score}  ${teamLabel(b2.p1, b2.p2)}`);
  console.log(`  → Winner: ${semi1Update.winner_team === 'team1' ? teamLabel(a1.p1, a1.p2) : teamLabel(b2.p1, b2.p2)}`);
  await applyUpdate(semi1.id, semi1Update);

  // ── Semi-Final 2: B1 vs A2 ──
  const semi2Update = rollMatch(b1, a2, semi2Time);
  const semi2 = semiMatches[1];
  console.log(`\n── Semi-Final 2 ──`);
  console.log(`  ${teamLabel(b1.p1, b1.p2)}  ${semi2Update.team1_score}-${semi2Update.team2_score}  ${teamLabel(a2.p1, a2.p2)}`);
  console.log(`  → Winner: ${semi2Update.winner_team === 'team1' ? teamLabel(b1.p1, b1.p2) : teamLabel(a2.p1, a2.p2)}`);
  await applyUpdate(semi2.id, semi2Update);

  // ── Grand Final: winner of S1 vs winner of S2 ──
  const winner1 = semi1Update.winner_team === 'team1' ? a1 : b2;
  const winner2 = semi2Update.winner_team === 'team1' ? b1 : a2;
  const finalUpdate = rollMatch(winner1, winner2, finalTime);
  console.log(`\n── 🏆 Grand Final ──`);
  console.log(`  ${teamLabel(winner1.p1, winner1.p2)}  ${finalUpdate.team1_score}-${finalUpdate.team2_score}  ${teamLabel(winner2.p1, winner2.p2)}`);
  const champion = finalUpdate.winner_team === 'team1' ? winner1 : winner2;
  console.log(`  → 🏆 Champion: ${teamLabel(champion.p1, champion.p2)}`);
  await applyUpdate(finalMatch.id, finalUpdate);

  console.log('\nDone.');
}

async function applyUpdate(id, update) {
  const { error } = await supabase.from('tournament_matches').update(update).eq('id', id);
  if (error) throw new Error(`Update ${id.slice(0, 8)}: ${error.message}`);
}

main().catch(e => { console.error(e); process.exit(1); });
