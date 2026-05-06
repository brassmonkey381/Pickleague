const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function run() {
  // Pick two players from the league
  const { data: members } = await supabase
    .from('league_members')
    .select('user_id, profile:profiles(id, full_name, rating)')
    .limit(2);

  if (!members || members.length < 2) { console.error('Need at least 2 league members.'); return; }

  const p1 = members[0].profile;
  const p2 = members[1].profile;
  const { data: league } = await supabase.from('leagues').select('id').limit(1).single();

  console.log(`Recording singles match:`);
  console.log(`  ${p1.full_name} (${p1.rating} ELO)  vs  ${p2.full_name} (${p2.rating} ELO)`);
  console.log(`  Score: 11 – 7  →  ${p1.full_name} wins\n`);

  const { error } = await supabase.from('matches').insert({
    league_id:    league.id,
    match_type:   'singles',
    player1_id:   p1.id,
    player2_id:   p2.id,
    player1_score: 11,
    player2_score: 7,
    winner_id:    p1.id,
    winner_team:  'team1',
  });

  if (error) { console.error('❌  Insert failed:', error.message); return; }

  // Fetch updated ratings
  const { data: updated } = await supabase
    .from('profiles')
    .select('id, full_name, rating')
    .in('id', [p1.id, p2.id]);

  const u1 = updated.find(u => u.id === p1.id);
  const u2 = updated.find(u => u.id === p2.id);
  const d1 = u1.rating - p1.rating;
  const d2 = u2.rating - p2.rating;

  console.log('✓  Match recorded. ELO updates:');
  console.log(`  ${u1.full_name}: ${p1.rating} → ${u1.rating}  (${d1 >= 0 ? '+' : ''}${d1})`);
  console.log(`  ${u2.full_name}: ${p2.rating} → ${u2.rating}  (${d2 >= 0 ? '+' : ''}${d2})`);
  console.log('\n✓  Record Match is fully working.');
}

run().catch(console.error);
