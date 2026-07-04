#!/usr/bin/env node
// Pickleague toolbox — Seed Fake Players
//
// Creates N sim accounts, each with a target DUPR, then simulates a match
// history whose outcomes follow the DUPR gaps so PLUPR converges organically
// through the real DB triggers. Optional --calibrate snaps global + league
// PLUPR exactly to the target afterward.
//
// Conventions (simulations/README.md): emails sim_player_<n>@pickleague.test,
// usernames sim_player_<n>, league name starts with [SIM]. --delete is
// idempotent and reverses rating side-effects via the match-delete trigger.
//
//   node scripts/seed-fake-players.mjs --count 12 --dupr-min 3 --dupr-max 5.5 \
//        --league "[SIM] Toolbox League" --matches 60 --doubles-pct 30 \
//        --days 30 --calibrate --dry-run
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (the toolbox injects saved keys).

import { createClient } from '@supabase/supabase-js';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const COUNT       = Number(val('--count', 12));
const DUPR_MIN    = Number(val('--dupr-min', 3.0));
const DUPR_MAX    = Number(val('--dupr-max', 5.5));
const LEAGUE_NAME = String(val('--league', '[SIM] Toolbox League'));
const N_MATCHES   = Number(val('--matches', 60));
const DOUBLES_PCT = Number(val('--doubles-pct', 30));
const DAYS        = Number(val('--days', 30));
const CALIBRATE   = flag('--calibrate');
const DELETE      = flag('--delete');
const DRY         = flag('--dry-run');

const PASSWORD = 'Pickle123!';
const EMAIL_RE = 'sim_player_%@pickleague.test';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}
if (!LEAGUE_NAME.startsWith('[SIM]')) {
  console.error('Refusing: --league must start with "[SIM]" (sim-data convention).');
  process.exit(1);
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── name pools ──────────────────────────────────────────────────────────────
const FIRST_M = ['Alex','Ben','Chris','Diego','Ethan','Felix','Gabe','Hank','Ivan','Jake','Kyle','Liam','Mike','Noah','Omar','Paul','Quinn','Ray','Sam','Tom'];
const FIRST_F = ['Amy','Bella','Cara','Dana','Elle','Faye','Gina','Holly','Iris','Jade','Kate','Lena','Mia','Nora','Opal','Page','Rosa','Sky','Tess','Uma'];
const LAST    = ['Alvarez','Baker','Costa','Dawson','Ellis','Ferris','Gomez','Hayes','Ito','Jensen','Kwan','Lopez','Marsh','Novak','Ortiz','Perry','Reyes','Silva','Turner','Vance'];

// ── helpers ─────────────────────────────────────────────────────────────────
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// Win probability from DUPR gap: odds 10^(gap/1.0) → 0.5 gap ≈ 76%, 1.0 ≈ 91%.
const winProb = (dA, dB) => 1 / (1 + Math.pow(10, (dB - dA) / 1.0));
// Loser score: closer DUPRs → closer game.
function loserScore(pWin) {
  const closeness = 1 - Math.abs(pWin - 0.5) * 2;              // 0 = mismatch, 1 = even
  return Math.max(0, Math.min(9, Math.round(rnd(2, 6) + closeness * rnd(2, 5))));
}
function randomPlayedAt() {
  const d = new Date(Date.now() - rnd(0, DAYS * 86400_000));
  d.setMinutes([0, 30][Math.floor(Math.random() * 2)], 0, 0);
  return d.toISOString();
}

async function findSimProfiles() {
  const { data, error } = await db.from('profiles')
    .select('id, username, full_name, rating')
    .like('username', 'sim\\_player\\_%');
  if (error) throw new Error('list sim profiles: ' + error.message);
  return data ?? [];
}

// ── delete mode ─────────────────────────────────────────────────────────────
async function cleanup() {
  const sims = await findSimProfiles();
  console.log(`Found ${sims.length} sim players.`);
  const ids = sims.map((s) => s.id);

  // 1. matches involving any sim player (delete trigger reverses rating effects)
  const matchIds = new Set();
  for (const col of ['player1_id', 'player2_id', 'partner1_id', 'partner2_id']) {
    for (let i = 0; i < ids.length; i += 50) {
      const { data, error } = await db.from('matches').select('id').in(col, ids.slice(i, i + 50));
      if (error) throw new Error('list matches: ' + error.message);
      for (const m of data ?? []) matchIds.add(m.id);
    }
  }
  // 2. [SIM] leagues
  const { data: simLeagues } = await db.from('leagues').select('id, name').like('name', '[SIM]%');

  console.log(`Would delete: ${matchIds.size} matches, ${simLeagues?.length ?? 0} [SIM] leagues, ${sims.length} accounts.`);
  if (DRY) { console.log('\n--dry-run: nothing deleted.'); return; }

  const allMatchIds = [...matchIds];
  for (let i = 0; i < allMatchIds.length; i += 50) {
    const { error } = await db.from('matches').delete().in('id', allMatchIds.slice(i, i + 50));
    if (error) throw new Error('delete matches: ' + error.message);
  }
  console.log(`✓ deleted ${allMatchIds.length} matches (rating effects reversed by trigger)`);

  for (const l of simLeagues ?? []) {
    const { error } = await db.rpc('godmode_delete_league', { p_league_id: l.id }).then(r => r,
      () => db.from('leagues').delete().eq('id', l.id));
    if (error) console.warn(`  ⚠ league "${l.name}": ${error.message}`);
    else console.log(`✓ deleted league "${l.name}"`);
  }

  let deleted = 0;
  for (const s of sims) {
    const { error } = await db.auth.admin.deleteUser(s.id);
    if (error) console.warn(`  ⚠ ${s.username}: ${error.message}`);
    else deleted++;
  }
  console.log(`✓ deleted ${deleted}/${sims.length} sim accounts`);
}

// ── create mode ─────────────────────────────────────────────────────────────
async function seed() {
  // Plan the roster: alternate genders (enables mixed-doubles categorization),
  // target DUPR uniform in [min,max], sorted for a readable report. In dry-run
  // we tolerate an unreachable DB so the preview works without live keys.
  let existing = [];
  try { existing = await findSimProfiles(); }
  catch (e) { if (!DRY) throw e; console.log(`(dry-run: could not read existing sims — ${e.message}; assuming none)`); }
  const startIdx = existing.length + 1;
  const roster = Array.from({ length: COUNT }, (_, i) => {
    const n = startIdx + i;
    const gender = n % 2 === 1 ? 'male' : 'female';
    const first = gender === 'male' ? pick(FIRST_M) : pick(FIRST_F);
    return {
      n, gender,
      username: `sim_player_${n}`,
      email: `sim_player_${n}@pickleague.test`,
      fullName: `${first} ${pick(LAST)}`,
      dupr: Math.round(rnd(DUPR_MIN, DUPR_MAX) * 20) / 20,   // 0.05 steps
    };
  });

  console.log(`Roster (${COUNT} new sim players, ${existing.length} already exist):`);
  for (const r of roster) console.log(`  ${r.username}  ${r.fullName.padEnd(16)} ${r.gender.padEnd(6)} target DUPR ${r.dupr.toFixed(2)}`);
  console.log(`League: "${LEAGUE_NAME}" · ${N_MATCHES} matches (${DOUBLES_PCT}% doubles) over last ${DAYS} days · calibrate=${CALIBRATE}`);
  if (DRY) { console.log('\n--dry-run: nothing written.'); return; }

  // 1. accounts
  for (const r of roster) {
    const { data, error } = await db.auth.admin.createUser({
      email: r.email, password: PASSWORD, email_confirm: true,
      user_metadata: { full_name: r.fullName, username: r.username, gender: r.gender },
    });
    if (error) {
      if (/already been registered/i.test(error.message)) {
        const { data: p } = await db.from('profiles').select('id').eq('username', r.username).single();
        r.id = p?.id;
        console.log(`  ⚠ ${r.username} exists — reusing`);
      } else throw new Error(`createUser ${r.username}: ${error.message}`);
    } else r.id = data.user.id;
    // gender is NOT NULL on profiles and the auth trigger may not set it.
    await db.from('profiles').update({ gender: r.gender }).eq('id', r.id);
  }
  console.log(`✓ ${roster.length} accounts ready (password: ${PASSWORD})`);

  // 2. league + memberships (creator = first sim player, open league)
  let { data: league } = await db.from('leagues').select('id').eq('name', LEAGUE_NAME).maybeSingle();
  if (!league) {
    const { data, error } = await db.from('leagues')
      .insert({ name: LEAGUE_NAME, description: 'Toolbox simulation league', created_by: roster[0].id, is_open: true })
      .select('id').single();
    if (error) throw new Error('create league: ' + error.message);
    league = data;
    console.log(`✓ created league "${LEAGUE_NAME}"`);
  }
  const players = [...existing.map(e => ({ id: e.id, username: e.username, dupr: null })), ...roster];
  for (const [i, r] of players.entries()) {
    const { error } = await db.from('league_members')
      .upsert({ league_id: league.id, user_id: r.id, role: i === 0 ? 'admin' : 'member' }, { onConflict: 'league_id,user_id', ignoreDuplicates: true });
    if (error && !/duplicate/i.test(error.message)) console.warn(`  ⚠ membership ${r.username}: ${error.message}`);
  }
  console.log(`✓ ${players.length} league memberships`);

  // 3. simulated match history — outcomes follow the DUPR gaps; the real DB
  //    triggers update global + league PLUPR on every insert.
  const pool = roster; // only players with a known target participate
  if (pool.length >= 2) {
    let singles = 0, doubles = 0;
    for (let i = 0; i < N_MATCHES; i++) {
      const isDoubles = pool.length >= 4 && Math.random() * 100 < DOUBLES_PCT;
      const picks = [...pool].sort(() => Math.random() - 0.5).slice(0, isDoubles ? 4 : 2);
      const [a, b, c, d] = picks;
      const dupr1 = isDoubles ? (a.dupr + b.dupr) / 2 : a.dupr;
      const dupr2 = isDoubles ? (c.dupr + d.dupr) / 2 : b.dupr;
      const p = winProb(dupr1, dupr2);
      const team1Wins = Math.random() < p;
      const ls = loserScore(team1Wins ? p : 1 - p);
      const payload = {
        league_id: league.id,
        match_type: isDoubles ? 'doubles' : 'singles',
        player1_id: a.id, partner1_id: isDoubles ? b.id : null,
        player2_id: isDoubles ? c.id : b.id, partner2_id: isDoubles ? d.id : null,
        player1_score: team1Wins ? 11 : ls,
        player2_score: team1Wins ? ls : 11,
        winner_id: team1Wins ? a.id : (isDoubles ? c.id : b.id),
        winner_team: team1Wins ? 'team1' : 'team2',
        played_at: randomPlayedAt(),
      };
      const { error } = await db.from('matches').insert(payload);
      if (error) throw new Error(`match ${i + 1}: ${error.message}`);
      isDoubles ? doubles++ : singles++;
      if ((i + 1) % 10 === 0) console.log(`  … ${i + 1}/${N_MATCHES} matches`);
    }
    console.log(`✓ ${singles} singles + ${doubles} doubles simulated`);
  }

  // 4. optional exact calibration
  if (CALIBRATE) {
    for (const r of roster) {
      await db.from('profiles')
        .update({ rating: r.dupr, singles_rating: r.dupr, doubles_rating: r.dupr, mixed_doubles_rating: r.dupr })
        .eq('id', r.id);
      await db.from('league_player_ratings')
        .update({ rating: r.dupr, singles_rating: r.dupr, doubles_rating: r.dupr, mixed_doubles_rating: r.dupr })
        .eq('league_id', league.id).eq('user_id', r.id);
    }
    console.log('✓ calibrated: global + league PLUPR set to each target DUPR');
  }

  // 5. report
  const { data: final } = await db.from('profiles')
    .select('username, rating, total_matches_played')
    .in('id', roster.map(r => r.id)).order('rating', { ascending: false });
  console.log('\nFinal roster (target → PLUPR after simulation):');
  for (const f of final ?? []) {
    const r = roster.find(x => x.username === f.username);
    console.log(`  ${f.username.padEnd(16)} target ${r?.dupr?.toFixed(2)}  →  PLUPR ${Number(f.rating).toFixed(2)}  (${f.total_matches_played} matches)`);
  }
}

(DELETE ? cleanup() : seed()).catch((e) => { console.error('\n✗ ' + e.message); process.exit(1); });
