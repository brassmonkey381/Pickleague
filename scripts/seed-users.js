// Pickleague — Dummy Account Seed Script
//
// Creates 12 test players in your Supabase project.
// All accounts use password:  Pickle123!
//
// Setup:
//   1. npm install @supabase/supabase-js   (from this folder or repo root)
//   2. Set the two env vars below (or paste values directly for local dev)
//   3. node scripts/seed-users.js
//
// Get SERVICE_ROLE_KEY from: Supabase Dashboard → Project Settings → API → service_role key
// (Never commit this key to source control)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://YOUR_PROJECT_ID.supabase.co';
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || 'YOUR_SERVICE_ROLE_KEY';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PLAYERS = [
  { firstName: 'Marcus',  lastName: 'Rivera' },
  { firstName: 'Sarah',   lastName: 'Chen' },
  { firstName: 'Derek',   lastName: 'Thompson' },
  { firstName: 'Priya',   lastName: 'Patel' },
  { firstName: 'Jordan',  lastName: 'Williams' },
  { firstName: 'Ashley',  lastName: 'Nguyen' },
  { firstName: 'Tyler',   lastName: 'Brooks' },
  { firstName: 'Megan',   lastName: 'Foster' },
  { firstName: 'Carlos',  lastName: 'Mendez' },
  { firstName: 'Rachel',  lastName: 'Kim' },
  { firstName: 'Kevin',   lastName: 'Okafor' },
  { firstName: 'Lauren',  lastName: 'Summers' },
];

const PASSWORD = 'Pickle123!';

async function seed() {
  console.log(`Seeding ${PLAYERS.length} players into ${SUPABASE_URL}\n`);
  let created = 0, skipped = 0;

  for (const p of PLAYERS) {
    const fullName = `${p.firstName} ${p.lastName}`;
    const username = `${p.firstName.toLowerCase()}${p.lastName.toLowerCase()}`;
    const email    = `${username}@pickleague.test`;

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,          // skip email confirmation for test accounts
      user_metadata: { full_name: fullName, username },
    });

    if (error) {
      if (error.message.includes('already been registered')) {
        console.log(`  ⚠  ${fullName} — already exists, skipped`);
        skipped++;
      } else {
        console.error(`  ✗  ${fullName} — ${error.message}`);
      }
    } else {
      console.log(`  ✓  ${fullName}  (${email})`);
      created++;
    }
  }

  console.log(`\nDone — ${created} created, ${skipped} skipped.`);
  console.log(`Password for all accounts: ${PASSWORD}`);
}

seed().catch(console.error);
