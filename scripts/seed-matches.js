// Seed ~60 matches across 12 play days for testing match history,
// league history, and calendar analytics. Brian Stockman is featured heavily.

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const LEAGUE = '4bf3f42a-8c7c-42b7-b61d-1e83db55cd88'; // Hub 4.5-5.0 Rec League

const B  = '252a36e1-5d89-4ad2-8a3e-b786579f019a'; // Brian Stockman (featured)
const AS = 'ce5192a2-8b10-40f8-8083-c7ee7aa7cd8a'; // Ashley Nguyen
const CA = '8d902b05-e7c7-4547-b4d0-9bfd5271e13a'; // Carlos Mendez
const DE = 'bd506b6e-0b85-422e-b18a-ab1214e3b1cd'; // Derek Thompson
const JO = 'a5dd8870-5c4f-4e3a-89d0-930ec94cd331'; // Jordan Williams
const KE = '26a641dd-13b3-4530-a876-246663e8ef2e'; // Kevin Okafor
const LA = '6380d220-dbc3-4243-8f71-8390274afb85'; // Lauren Summers
const MA = '1952ae44-20e7-4752-b926-04aad95bbf8a'; // Marcus Rivera
const ME = 'eb6bbd6d-ef84-4a77-8b27-70fc358f7331'; // Megan Foster
const PR = '64a9bb93-0267-4174-a8b3-4b6320511f23'; // Priya Patel
const RA = '40cb0f53-ca88-4d71-9e78-99a08d64f77c'; // Rachel Kim
const SA = 'a84662e0-05a4-4d11-88d7-cfc2b028bd12'; // Sarah Chen
const TY = '62971d61-374f-4029-89e3-e3f8b16599b1'; // Tyler Brooks

// S(p1, p2, s1, s2, date, time) = singles match
// D(p1, pa1, p2, pa2, s1, s2, date, time) = doubles match
// Winner is always team with higher score (s1 > s2 means team1/p1 wins)

const MATCHES = [
  // ── Apr 2 ─────────────────────────────────────────────────
  { type:'singles', p1:B,  p2:MA, s1:11, s2:7,  date:'2026-04-02', time:'18:00' },
  { type:'singles', p1:B,  p2:DE, s1:11, s2:5,  date:'2026-04-02', time:'18:30' },
  { type:'singles', p1:TY, p2:B,  s1:11, s2:7,  date:'2026-04-02', time:'19:00' },
  { type:'singles', p1:SA, p2:AS, s1:11, s2:9,  date:'2026-04-02', time:'18:00' },
  { type:'singles', p1:CA, p2:JO, s1:11, s2:6,  date:'2026-04-02', time:'19:30' },

  // ── Apr 5 ─────────────────────────────────────────────────
  { type:'doubles', p1:B,  pa1:MA, p2:DE, pa2:TY, s1:11, s2:8,  date:'2026-04-05', time:'14:00' },
  { type:'doubles', p1:B,  pa1:SA, p2:CA, pa2:JO, s1:11, s2:6,  date:'2026-04-05', time:'14:30' },
  { type:'singles', p1:PR, p2:RA, s1:11, s2:7,  date:'2026-04-05', time:'15:00' },
  { type:'singles', p1:KE, p2:ME, s1:11, s2:9,  date:'2026-04-05', time:'15:30' },

  // ── Apr 8 ─────────────────────────────────────────────────
  { type:'singles', p1:B,  p2:SA, s1:11, s2:4,  date:'2026-04-08', time:'18:00' },
  { type:'singles', p1:KE, p2:B,  s1:11, s2:9,  date:'2026-04-08', time:'18:30' },
  { type:'singles', p1:MA, p2:TY, s1:11, s2:8,  date:'2026-04-08', time:'19:00' },
  { type:'singles', p1:AS, p2:LA, s1:11, s2:6,  date:'2026-04-08', time:'18:00' },
  { type:'singles', p1:DE, p2:JO, s1:11, s2:9,  date:'2026-04-08', time:'19:30' },

  // ── Apr 12 ────────────────────────────────────────────────
  { type:'doubles', p1:B,  pa1:KE, p2:MA, pa2:TY, s1:11, s2:7,  date:'2026-04-12', time:'13:00' },
  { type:'singles', p1:B,  p2:PR, s1:11, s2:5,  date:'2026-04-12', time:'13:30' },
  { type:'doubles', p1:SA, pa1:AS, p2:RA, pa2:LA, s1:11, s2:8,  date:'2026-04-12', time:'14:00' },
  { type:'singles', p1:DE, p2:CA, s1:11, s2:9,  date:'2026-04-12', time:'14:30' },
  { type:'singles', p1:ME, p2:JO, s1:11, s2:7,  date:'2026-04-12', time:'15:00' },

  // ── Apr 15 ────────────────────────────────────────────────
  { type:'singles', p1:MA, p2:B,  s1:11, s2:5,  date:'2026-04-15', time:'18:00' },
  { type:'singles', p1:B,  p2:DE, s1:11, s2:8,  date:'2026-04-15', time:'18:30' },
  { type:'singles', p1:TY, p2:B,  s1:11, s2:8,  date:'2026-04-15', time:'19:00' },
  { type:'singles', p1:SA, p2:PR, s1:11, s2:9,  date:'2026-04-15', time:'18:00' },
  { type:'singles', p1:KE, p2:CA, s1:11, s2:6,  date:'2026-04-15', time:'19:30' },

  // ── Apr 19 ────────────────────────────────────────────────
  { type:'doubles', p1:B,  pa1:MA, p2:DE, pa2:CA, s1:11, s2:5,  date:'2026-04-19', time:'13:00' },
  { type:'doubles', p1:B,  pa1:SA, p2:TY, pa2:AS, s1:11, s2:7,  date:'2026-04-19', time:'13:30' },
  { type:'singles', p1:B,  p2:KE, s1:11, s2:8,  date:'2026-04-19', time:'14:30' },
  { type:'singles', p1:JO, p2:RA, s1:11, s2:7,  date:'2026-04-19', time:'14:00' },
  { type:'singles', p1:PR, p2:ME, s1:11, s2:6,  date:'2026-04-19', time:'15:00' },
  { type:'singles', p1:LA, p2:CA, s1:11, s2:9,  date:'2026-04-19', time:'15:30' },

  // ── Apr 22 ────────────────────────────────────────────────
  { type:'singles', p1:B,  p2:SA, s1:11, s2:6,  date:'2026-04-22', time:'18:00' },
  { type:'singles', p1:B,  p2:JO, s1:11, s2:9,  date:'2026-04-22', time:'18:30' },
  { type:'doubles', p1:MA, pa1:PR, p2:B, pa2:KE, s1:11, s2:9,  date:'2026-04-22', time:'19:00' },
  { type:'singles', p1:DE, p2:TY, s1:11, s2:7,  date:'2026-04-22', time:'18:00' },
  { type:'singles', p1:AS, p2:RA, s1:11, s2:5,  date:'2026-04-22', time:'19:30' },

  // ── Apr 26 ────────────────────────────────────────────────
  { type:'doubles', p1:B,  pa1:MA, p2:SA, pa2:AS, s1:11, s2:8,  date:'2026-04-26', time:'13:00' },
  { type:'singles', p1:DE, p2:B,  s1:11, s2:7,  date:'2026-04-26', time:'14:00' },
  { type:'singles', p1:KE, p2:JO, s1:11, s2:9,  date:'2026-04-26', time:'13:30' },
  { type:'singles', p1:TY, p2:CA, s1:11, s2:6,  date:'2026-04-26', time:'14:30' },
  { type:'doubles', p1:PR, pa1:RA, p2:ME, pa2:LA, s1:11, s2:7,  date:'2026-04-26', time:'15:00' },

  // ── Apr 29 ────────────────────────────────────────────────
  { type:'singles', p1:B,  p2:CA, s1:11, s2:5,  date:'2026-04-29', time:'18:00' },
  { type:'singles', p1:B,  p2:ME, s1:11, s2:7,  date:'2026-04-29', time:'18:30' },
  { type:'doubles', p1:MA, pa1:TY, p2:DE, pa2:KE, s1:11, s2:9,  date:'2026-04-29', time:'19:00' },
  { type:'singles', p1:SA, p2:JO, s1:11, s2:8,  date:'2026-04-29', time:'18:00' },
  { type:'singles', p1:PR, p2:AS, s1:11, s2:9,  date:'2026-04-29', time:'19:30' },

  // ── May 1 ─────────────────────────────────────────────────
  { type:'doubles', p1:B,  pa1:TY, p2:MA, pa2:KE, s1:11, s2:6,  date:'2026-05-01', time:'18:00' },
  { type:'singles', p1:SA, p2:B,  s1:11, s2:9,  date:'2026-05-01', time:'19:00' },
  { type:'singles', p1:DE, p2:JO, s1:11, s2:7,  date:'2026-05-01', time:'18:00' },
  { type:'singles', p1:CA, p2:RA, s1:11, s2:5,  date:'2026-05-01', time:'19:30' },
  { type:'doubles', p1:AS, pa1:LA, p2:PR, pa2:ME, s1:11, s2:8,  date:'2026-05-01', time:'18:30' },

  // ── May 3 ─────────────────────────────────────────────────
  { type:'singles', p1:B,  p2:MA, s1:11, s2:9,  date:'2026-05-03', time:'13:00' },
  { type:'doubles', p1:B,  pa1:DE, p2:TY, pa2:CA, s1:11, s2:7,  date:'2026-05-03', time:'13:30' },
  { type:'singles', p1:JO, p2:B,  s1:11, s2:7,  date:'2026-05-03', time:'14:30' },
  { type:'doubles', p1:SA, pa1:KE, p2:AS, pa2:PR, s1:11, s2:5,  date:'2026-05-03', time:'14:00' },
  { type:'singles', p1:RA, p2:ME, s1:11, s2:6,  date:'2026-05-03', time:'15:00' },
  { type:'singles', p1:CA, p2:LA, s1:11, s2:9,  date:'2026-05-03', time:'15:30' },

  // ── May 5 (today) ─────────────────────────────────────────
  { type:'singles', p1:B,  p2:TY, s1:11, s2:4,  date:'2026-05-05', time:'18:00' },
  { type:'doubles', p1:B,  pa1:MA, p2:SA, pa2:KE, s1:11, s2:9,  date:'2026-05-05', time:'18:30' },
  { type:'singles', p1:DE, p2:JO, s1:11, s2:8,  date:'2026-05-05', time:'18:00' },
  { type:'singles', p1:AS, p2:RA, s1:11, s2:7,  date:'2026-05-05', time:'19:00' },
];

async function run() {
  console.log(`Seeding ${MATCHES.length} matches into Hub 4.5-5.0 Rec League...\n`);

  let ok = 0, fail = 0;

  for (const m of MATCHES) {
    const playedAt = new Date(`${m.date}T${m.time}:00`).toISOString();
    const s1 = m.s1, s2 = m.s2;
    const team1Wins = s1 > s2;

    const payload = {
      league_id:     LEAGUE,
      match_type:    m.type,
      player1_id:    m.p1,
      partner1_id:   m.pa1 ?? null,
      player2_id:    m.p2,
      partner2_id:   m.pa2 ?? null,
      player1_score: s1,
      player2_score: s2,
      winner_id:     team1Wins ? m.p1 : m.p2,
      winner_team:   team1Wins ? 'team1' : 'team2',
      played_at:     playedAt,
    };

    const { error } = await supabase.from('matches').insert(payload);

    const label = m.type === 'singles'
      ? `[${m.date}] Singles  ${s1}-${s2}`
      : `[${m.date}] Doubles  ${s1}-${s2}`;

    if (error) {
      console.error(`  ✗  ${label} — ${error.message}`);
      fail++;
    } else {
      ok++;
      process.stdout.write('  ✓  ' + label + '\n');
    }
  }

  console.log(`\n${ok} matches inserted, ${fail} failed.`);

  // Print Brian's record
  const { data: brianMatches } = await supabase
    .from('matches')
    .select('winner_id, player1_id, player2_id, partner1_id, partner2_id')
    .eq('league_id', LEAGUE)
    .or(`player1_id.eq.${B},player2_id.eq.${B},partner1_id.eq.${B},partner2_id.eq.${B}`);

  const wins   = brianMatches.filter(m => m.winner_id === B || (m.partner1_id === B && m.winner_id === m.player1_id)).length;
  const losses = brianMatches.length - wins;
  console.log(`\nBrian's record: ${wins}W – ${losses}L (${Math.round(wins/brianMatches.length*100)}% win rate)`);

  // Print updated ratings for top players
  const { data: ratings } = await supabase
    .from('profiles')
    .select('full_name, rating')
    .order('rating', { ascending: false })
    .limit(6);
  console.log('\nTop 6 ELO ratings after seeding:');
  ratings.forEach((p, i) => console.log(`  ${i+1}. ${p.full_name}: ${p.rating}`));

  // Summary by play day
  const { data: allMatches } = await supabase
    .from('matches')
    .select('played_at')
    .eq('league_id', LEAGUE);
  const days = {};
  allMatches.forEach(m => {
    const d = m.played_at.slice(0,10);
    days[d] = (days[d] || 0) + 1;
  });
  console.log(`\nMatches per play day (${Object.keys(days).length} distinct days):`);
  Object.entries(days).sort().forEach(([d, n]) => console.log(`  ${d}: ${n} match${n>1?'es':''}`));
}

run().catch(console.error);
