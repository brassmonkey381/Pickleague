// Seed three "shady" alt accounts — Sean Lee, Sang Lee, Ess Lee.
// Same person, three usernames, egotistical taglines, ~1W–20L records.
// Run after scripts/seed-users.js + scripts/seed-matches.js (which create
// the league and the 12 demo opponents this script plays them against).

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const LEAGUE = '4bf3f42a-8c7c-42b7-b61d-1e83db55cd88'; // Hub 4.5-5.0 Rec League
const PASSWORD = 'Pickle123!';

// Demo player UUIDs (matches scripts/seed-matches.js)
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

const OPPONENTS = [MA, SA, DE, PR, JO, AS, TY, ME, CA, RA, KE, LA];

// Three alts of the same shady character — distinct flavor each, all bragging.
const SHADY = [
  {
    firstName: 'Sean', lastName: 'Lee',
    avatar_id: 7,
    tagline: '1500-rated tournament player. Trust me bro.',
    selected_tags: ['tournament tested', 'sandbagged here', 'former college tennis', 'natural talent'],
  },
  {
    firstName: 'Sang', lastName: 'Lee',
    avatar_id: 12,
    tagline: "Mind > rating. System can't measure clutch.",
    selected_tags: ['mental warrior', 'clutch under pressure', 'winning mindset', 'undefeated when locked in'],
  },
  {
    firstName: 'Ess', lastName: 'Lee',
    avatar_id: 4,
    tagline: 'Top 1% talent. Algorithm is rigged. lol',
    selected_tags: ['elite shot maker', 'should be 4.5+', 'rigged ELO', 'hidden ability'],
  },
];

// 21 matches per shady (14 singles losses + 6 doubles losses + 1 lucky singles win).
// Mostly close losses to fuel the "system is rigged" cope; a few blowouts for realism.
const SINGLES_LOSS_SCORES = [
  [9,11],[8,11],[7,11],[10,12],[5,11],[9,11],[3,11],
  [8,11],[6,11],[9,11],[2,11],[8,11],[10,12],[4,11],
];
const DOUBLES_LOSS_SCORES = [
  [9,11],[7,11],[8,11],[10,12],[6,11],[5,11],
];
const SINGLES_DATES = [
  '2026-04-09','2026-04-12','2026-04-14','2026-04-16','2026-04-19',
  '2026-04-21','2026-04-23','2026-04-26','2026-04-28','2026-04-30',
  '2026-05-01','2026-05-03','2026-05-05','2026-05-07',
];
const DOUBLES_DATES = [
  '2026-04-11','2026-04-18','2026-04-25','2026-04-29','2026-05-02','2026-05-06',
];
const TIMES = ['18:00','18:30','19:00','19:30','13:00','13:30','14:00','14:30','15:00','15:30'];

function generateMatches(shadyId, idx) {
  const opp = (i) => OPPONENTS[(i + idx) % OPPONENTS.length];
  const matches = [];

  // 14 singles losses
  for (let i = 0; i < 14; i++) {
    const [sShady, sOpp] = SINGLES_LOSS_SCORES[i];
    matches.push({
      type: 'singles',
      p1: shadyId, p2: opp(i),
      pa1: null,   pa2: null,
      s1: sShady,  s2: sOpp,
      date: SINGLES_DATES[i],
      time: TIMES[i % TIMES.length],
    });
  }

  // 6 doubles losses
  for (let i = 0; i < 6; i++) {
    const [sShady, sOpp] = DOUBLES_LOSS_SCORES[i];
    matches.push({
      type: 'doubles',
      p1:  shadyId,
      pa1: opp(i + 6),
      p2:  opp(i + 8),
      pa2: opp(i + 10),
      s1:  sShady, s2: sOpp,
      date: DOUBLES_DATES[i],
      time: TIMES[(i + 4) % TIMES.length],
    });
  }

  // 1 squeaker singles win — vs the lowest-ranked demo player so it's believable
  matches.push({
    type: 'singles',
    p1: shadyId, p2: opp(20),
    pa1: null,   pa2: null,
    s1: 11,      s2: 9,
    date: '2026-05-04',
    time: '17:00',
  });

  return matches;
}

async function ensureAuthUser(p) {
  const username = `${p.firstName.toLowerCase()}${p.lastName.toLowerCase()}`;
  const email    = `${username}@pickleague.test`;
  const fullName = `${p.firstName} ${p.lastName}`;

  // Try to create. If it already exists, look it up.
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName, username },
  });

  if (data?.user) {
    console.log(`  ✓  created auth user — ${fullName}  (${email})`);
    return data.user.id;
  }

  if (error && error.message.includes('already been registered')) {
    const { data: { users } } = await supabase.auth.admin.listUsers();
    const existing = users.find(u => u.email === email);
    if (existing) {
      console.log(`  ⚠  ${fullName} already exists — reusing  (${email})`);
      return existing.id;
    }
  }

  throw new Error(`Failed to create/find ${fullName}: ${error?.message ?? 'unknown'}`);
}

async function run() {
  console.log(`Seeding 3 shady Lee alts into league ${LEAGUE}\n`);

  for (let i = 0; i < SHADY.length; i++) {
    const p = SHADY[i];
    const fullName = `${p.firstName} ${p.lastName}`;
    const username = `${p.firstName.toLowerCase()}${p.lastName.toLowerCase()}`;

    console.log(`── ${fullName} ───────────────────────────────`);

    const userId = await ensureAuthUser(p);

    // Update profile (the on_auth_user_created trigger has already inserted a row)
    const { error: profileErr } = await supabase
      .from('profiles')
      .update({
        full_name:     fullName,
        username,
        avatar_id:     p.avatar_id,
        tagline:       p.tagline,
        selected_tags: p.selected_tags,
      })
      .eq('id', userId);
    if (profileErr) console.error(`  ✗  profile update — ${profileErr.message}`);
    else            console.log(`  ✓  profile customized`);

    // Add to league
    const { error: memberErr } = await supabase
      .from('league_members')
      .upsert({ league_id: LEAGUE, user_id: userId }, { onConflict: 'league_id,user_id' });
    if (memberErr) console.error(`  ✗  league add — ${memberErr.message}`);
    else           console.log(`  ✓  added to league`);

    // Insert 21 matches
    const matches = generateMatches(userId, i);
    let ok = 0, fail = 0;
    for (const m of matches) {
      const playedAt = new Date(`${m.date}T${m.time}:00`).toISOString();
      const team1Wins = m.s1 > m.s2;
      const { error } = await supabase.from('matches').insert({
        league_id:     LEAGUE,
        match_type:    m.type,
        player1_id:    m.p1,
        partner1_id:   m.pa1,
        player2_id:    m.p2,
        partner2_id:   m.pa2,
        player1_score: m.s1,
        player2_score: m.s2,
        winner_id:     team1Wins ? m.p1 : m.p2,
        winner_team:   team1Wins ? 'team1' : 'team2',
        played_at:     playedAt,
      });
      if (error) { fail++; console.error(`    ✗  ${m.date} ${m.type} ${m.s1}-${m.s2} — ${error.message}`); }
      else       { ok++; }
    }
    console.log(`  ✓  ${ok} matches inserted (${fail} failed)`);

    // Show resulting record + rating
    const { data: profile } = await supabase
      .from('profiles')
      .select('rating')
      .eq('id', userId)
      .single();
    console.log(`  → final ELO: ${profile?.rating}  (claims 1500 in tagline 😄)\n`);
  }

  console.log('Done.');
}

run().catch((e) => { console.error(e); process.exit(1); });
