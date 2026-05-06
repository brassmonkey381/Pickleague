// Quick check that the matches table has the expected columns
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function check() {
  // Try inserting a dummy row with all new columns to verify schema
  const { data: profiles } = await supabase.from('profiles').select('id').limit(2);
  if (!profiles || profiles.length < 2) { console.log('Need at least 2 profiles to test — seed first.'); return; }

  const [p1, p2] = profiles;
  const { data: leagues } = await supabase.from('leagues').select('id').limit(1).single();
  if (!leagues) { console.log('No league found.'); return; }

  const { error } = await supabase.from('matches').insert({
    league_id: leagues.id,
    match_type: 'singles',
    player1_id: p1.id,
    player2_id: p2.id,
    player1_score: 11,
    player2_score: 7,
    winner_id: p1.id,
    winner_team: 'team1',
  });

  if (error) {
    console.log('❌  Schema check FAILED:', error.message);
    console.log('\nYou need to run supabase/migration_add_events_and_doubles.sql in the Supabase SQL Editor.');
  } else {
    // Clean up the test row
    await supabase.from('matches')
      .delete()
      .eq('player1_id', p1.id)
      .eq('player2_id', p2.id)
      .eq('player1_score', 11)
      .eq('player2_score', 7);
    console.log('✓  Schema looks good — match_type, winner_team columns exist.');
  }
}

check().catch(console.error);
