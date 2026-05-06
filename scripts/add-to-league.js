// Adds all seeded dummy players to a league.
// If no league exists yet, creates one first.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SEED_EMAILS = [
  'marcusrivera@pickleague.test',
  'sarahchen@pickleague.test',
  'derekthompson@pickleague.test',
  'priyapatel@pickleague.test',
  'jordanwilliams@pickleague.test',
  'ashleynguyen@pickleague.test',
  'tylerbrooks@pickleague.test',
  'meganfoster@pickleague.test',
  'carlosmendez@pickleague.test',
  'rachelkim@pickleague.test',
  'kevinokafor@pickleague.test',
  'laurensummers@pickleague.test',
];

async function run() {
  // 1. Find or create a league
  let { data: leagues } = await supabase.from('leagues').select('*').eq('is_active', true).order('created_at');
  let league;

  if (leagues && leagues.length > 0) {
    league = leagues[0];
    console.log(`Using existing league: "${league.name}" (${league.id})\n`);
  } else {
    // Need a creator — use first seeded player
    const { data: firstUser } = await supabase
      .from('profiles')
      .select('id')
      .limit(1)
      .single();

    const { data: newLeague, error } = await supabase
      .from('leagues')
      .insert({ name: 'Pickleague Season 1', description: 'Main pickleball league', created_by: firstUser.id })
      .select()
      .single();

    if (error) { console.error('Failed to create league:', error.message); process.exit(1); }
    league = newLeague;
    console.log(`Created new league: "${league.name}" (${league.id})\n`);
  }

  // 2. Look up auth user IDs for each seed email, then find their profile
  let added = 0, skipped = 0;

  for (const email of SEED_EMAILS) {
    // Get auth user by email
    const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
    const authUser = users?.find(u => u.email === email);
    if (!authUser) { console.log(`  ⚠  No auth user found for ${email}`); skipped++; continue; }

    // Upsert into league_members
    const { error } = await supabase
      .from('league_members')
      .upsert({ league_id: league.id, user_id: authUser.id }, { onConflict: 'league_id,user_id' });

    // Get display name from profiles
    const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', authUser.id).single();
    const name = profile?.full_name ?? email;

    if (error) {
      console.log(`  ✗  ${name} — ${error.message}`);
    } else {
      console.log(`  ✓  ${name}`);
      added++;
    }
  }

  console.log(`\nDone — ${added} players added to "${league.name}", ${skipped} skipped.`);
}

run().catch(console.error);
