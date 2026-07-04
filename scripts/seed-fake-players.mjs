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
const LOCATION    = String(val('--location', 'Bladium Sports & Fitness Club'));
const CALIBRATE   = flag('--calibrate');
const DELETE      = flag('--delete');
const DRY         = flag('--dry-run');

const PASSWORD = 'pickle123';
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

// ── profile customization pools (mirror mobile/src/data + lib catalogs) ────
// Free avatars from data/profileCustomization.ts (id, emoji, bgColor).
const AVATARS = [
  [1,'🐻','#c8a97e'],[2,'🐼','#e0e0e0'],[3,'🐸','#a5d6a7'],[4,'🦊','#ffb74d'],
  [5,'🐱','#f8bbd0'],[6,'🐶','#ffe082'],[7,'🐯','#ffa726'],[8,'🦁','#ffcc80'],
  [9,'🐺','#b0bec5'],[10,'🐧','#81d4fa'],[11,'🦄','#e1bee7'],[12,'🦅','#90caf9'],
  [13,'🦋','#b3e5fc'],[14,'🐲','#c8e6c9'],[15,'🤖','#cfd8dc'],[16,'👾','#ce93d8'],[17,'🦝','#b0bec5'],
];
// Free play-style + personality tags.
const TAGS = ['dink-master','power-banger','net-rusher','baseline-camper','spin-doctor','touch-player',
  'counterpuncher','kitchen-wizard','drop-shot-artist','all-court','the-attacker','serve-and-volley',
  'poacher','patient-player','the-grinder','speed-demon','defensive-wall','shake-and-bake',
  'third-shot-legend','the-strategist','wind-reader','fast-twitch','aggressive-baseline','the-lobber',
  'dink-or-die','never-dinks','lucky-lobber','banana-roll','atp-enthusiast','snack-bringer',
  'trash-talker','the-encourager','left-handed-terror','tennis-convert','ping-pong-pro',
  'volleyball-convert','weekend-warrior','teaching-pro','beginner-vibes'];
const TAGLINES = [
  'Dink responsibly.','Here for the kitchen gossip.','Zero to eleven real quick.',
  'Body bags are a love language.','My third shot is a prayer.','Lob me once, shame on you.',
  'Retired from tennis, not from winning.','Sweat, dink, repeat.','Powered by pickle juice.',
  'The ATP was intentional.','I only poach on weekends.','Stacking since before it was cool.',
  'Certified rec-game menace.','Will trade snacks for lessons.','Kitchen violations: allegedly.',
  'Slow feet, fast hands.','Erne apologist.','Running it back since 2024.',
];
const NAME_COLORS = ['#e0245e','#1d4ed8','#059669','#7c3aed','#06b6d4','#f97316','#d4af37','#ec4899'];
const LIST_STYLES = ['list-solid-ruby','list-solid-sapphire','list-solid-emerald','list-solid-royal-purple',
  'list-solid-cyber','list-solid-sunset-orange','list-grad-sunset','list-grad-ocean','list-grad-forest',
  'list-grad-lavender','list-grad-volcano','list-grad-monochrome','list-glow-neon-pink','list-glow-cyber-blue',
  'list-glow-toxic-green','list-glow-inferno','list-metal-gold-leaf','list-metal-silver-shine',
  'list-metal-bronze','list-metal-holographic-foil'];
const HERO_STYLES = ['hero-anim-pulse','hero-anim-rainbow','hero-anim-sparkle','hero-anim-typewriter','hero-anim-holographic'];
const FRAMES = ['frame-gold-wreath','frame-sparkle-ring','frame-cherry-blossom','frame-fire-ring','frame-lightning','frame-star'];
const SHOT_PREFS = ['dinks-cross','dinks-straight','third-shot-drop','third-shot-drive','volleys-kitchen',
  'volleys-transit','resets','returns-deep','serves','lobs-offense','lobs-defense','erne-atp','stacking',
  'footwork','fitness','shadow','live-balls'];
const PARTNER_PREFS = ['similar-level','higher-level','lower-level','casual','intense','one-off','regular',
  'feedback','drills-only','mix'];

// ── helpers ─────────────────────────────────────────────────────────────────
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const sample = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
// Weekly availability: boolean[336] (7 days × 48 half-hour slots, Mon-first).
// Realistic pattern: some weekday-evening blocks + some weekend daytime blocks.
function makeAvailability() {
  const av = new Array(7 * 48).fill(false);
  const block = (day, from, to) => { for (let s = from; s < to; s++) av[day * 48 + s] = true; };
  for (let d = 0; d < 5; d++) if (chance(0.5)) block(d, 34 + Math.floor(rnd(0, 3)), 40 + Math.floor(rnd(0, 4))); // ~5–8pm weekdays
  for (const d of [5, 6]) {
    if (chance(0.7)) block(d, 16 + Math.floor(rnd(0, 3)), 22 + Math.floor(rnd(0, 5)));  // weekend morning
    if (chance(0.4)) block(d, 28, 34 + Math.floor(rnd(0, 4)));                          // weekend afternoon
  }
  return av;
}
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

// Identify sim players by AUTH EMAIL, not profile username — handle_new_user
// sanitizes usernames ('[^a-z0-9]' stripped), so sim_player_1 becomes
// simplayer1 in profiles. The email is the stable key we control.
const SIM_EMAIL = /^sim_player_(\d+)@pickleague\.test$/;
async function findSimUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error('list users: ' + error.message);
    users.push(...data.users.filter((u) => SIM_EMAIL.test(u.email ?? '')));
    if (data.users.length < 1000) break;
  }
  users.sort((a, b) => Number(a.email.match(SIM_EMAIL)[1]) - Number(b.email.match(SIM_EMAIL)[1]));
  if (!users.length) return [];
  // join profile fields (may be missing if a signup half-failed — keep the row)
  const byId = new Map(users.map((u) => [u.id, { id: u.id, email: u.email, n: Number(u.email.match(SIM_EMAIL)[1]) }]));
  for (let i = 0; i < users.length; i += 100) {
    const ids = users.slice(i, i + 100).map((u) => u.id);
    const { data } = await db.from('profiles').select('id, username, full_name, rating').in('id', ids);
    for (const p of data ?? []) Object.assign(byId.get(p.id), p);
  }
  return [...byId.values()];
}

// ── delete mode ─────────────────────────────────────────────────────────────
async function cleanup() {
  const sims = await findSimUsers();
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
    if (error) console.warn(`  ⚠ ${s.email}: ${error.message}`);
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
  try { existing = await findSimUsers(); }
  catch (e) { if (!DRY) throw e; console.log(`(dry-run: could not read existing sims — ${e.message}; assuming none)`); }
  const startIdx = existing.reduce((mx, s) => Math.max(mx, s.n), 0) + 1;
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
  const totalWeeks = Math.max(1, Math.ceil(DAYS / 7));
  const lockFreqWeeks = Math.max(1, Math.floor(totalWeeks / 5));
  const nPeriods = Math.floor(totalWeeks / lockFreqWeeks);
  console.log(`League: "${LEAGUE_NAME}" · ${N_MATCHES} matches (${DOUBLES_PCT}% doubles) over last ${DAYS} days · calibrate=${CALIBRATE}`);
  console.log(`Location: all matches at "${LOCATION}"`);
  console.log(`Season: ${totalWeeks} weeks, standings locked every ${lockFreqWeeks} week(s) → ${nPeriods} refresh periods (≈ backfill/5)`);
  if (DRY) { console.log('\n--dry-run: nothing written.'); return; }

  // 1. accounts
  for (const r of roster) {
    const { data, error } = await db.auth.admin.createUser({
      email: r.email, password: PASSWORD, email_confirm: true,
      user_metadata: { full_name: r.fullName, username: r.username, gender: r.gender },
    });
    if (error) {
      if (/already been registered/i.test(error.message)) {
        const prior = existing.find((s) => s.email === r.email);
        r.id = prior?.id;
        console.log(`  ⚠ ${r.email} exists — reusing`);
        if (!r.id) { console.warn(`  ⚠ could not resolve id for ${r.email}; skipping`); continue; }
      } else throw new Error(`createUser ${r.username}: ${error.message}`);
    } else r.id = data.user.id;
    // gender is NOT NULL on profiles and the auth trigger may not set it.
    await db.from('profiles').update({ gender: r.gender }).eq('id', r.id);
  }
  console.log(`✓ ${roster.length} accounts ready (password: ${PASSWORD})`);

  // 1b. randomize EVERYTHING a player can customize — avatar, tagline, tags,
  //     name color/styles, frame, availability, drilling prefs, pickles, phone.
  //     Deliberately high variability: every field independently rolled, with
  //     a real chance of staying default so "plain" profiles exist too.
  const { data: paddleModels } = await db.from('paddle_models').select('brand_id, name, thickness_mm').limit(500);
  for (const r of roster) {
    const avatar = pick(AVATARS);
    const drilling = chance(0.6);
    const patch = {
      avatar_id: avatar[0], avatar_emoji: avatar[1], avatar_bg_color: avatar[2],
      tagline: chance(0.8) ? pick(TAGLINES) : null,
      selected_tags: sample(TAGS, Math.floor(rnd(0, 5))),
      availability: makeAvailability(),
      badges_public: chance(0.8),
      name_color: chance(0.4) ? pick(NAME_COLORS) : null,
      list_name_style_id: chance(0.4) ? pick(LIST_STYLES) : null,
      profile_name_style_id: chance(0.3) ? pick(HERO_STYLES) : null,
      profile_frame: chance(0.3) ? pick(FRAMES) : null,
      pickles: Math.floor(rnd(0, 8000)),
      phone: chance(0.3) ? `+1555${String(Math.floor(rnd(1000000, 9999999)))}` : null,
      drilling_enabled: drilling,
      drill_availability: drilling ? makeAvailability() : [],
      drill_shot_prefs: drilling ? sample(SHOT_PREFS, 2 + Math.floor(rnd(0, 4))) : [],
      drill_partner_prefs: drilling ? sample(PARTNER_PREFS, 1 + Math.floor(rnd(0, 3))) : [],
      drill_custom_tags: drilling && chance(0.3) ? ['early bird', 'has a ball machine'] : [],
    };
    const { error: pe } = await db.from('profiles').update(patch).eq('id', r.id);
    if (pe) console.warn(`  ⚠ customize ${r.username}: ${pe.message}`);
    // 1–2 paddles from the real catalog, first one default.
    if (paddleModels?.length && chance(0.85)) {
      const models = sample(paddleModels, chance(0.3) ? 2 : 1);
      for (const [mi, m] of models.entries()) {
        const { error: pdE } = await db.from('player_paddles').upsert(
          { user_id: r.id, brand_id: m.brand_id, model_name: m.name, thickness_mm: m.thickness_mm, is_default: mi === 0 },
          { onConflict: 'user_id,brand_id,model_name', ignoreDuplicates: true });
        if (pdE && !/duplicate/i.test(pdE.message)) console.warn(`  ⚠ paddle ${r.username}: ${pdE.message}`);
      }
    }
  }
  console.log(`✓ profiles randomized (avatars, taglines, tags, styles, frames, availability, drilling, paddles)`);

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
  const players = [
    ...existing.filter(e => !roster.some(r => r.id === e.id)).map(e => ({ id: e.id, username: e.username ?? e.email, dupr: null })),
    ...roster.filter(r => r.id),
  ];
  for (const [i, r] of players.entries()) {
    const { error } = await db.from('league_members')
      .upsert({ league_id: league.id, user_id: r.id, role: i === 0 ? 'admin' : 'member' }, { onConflict: 'league_id,user_id', ignoreDuplicates: true });
    if (error && !/duplicate/i.test(error.message)) console.warn(`  ⚠ membership ${r.username}: ${error.message}`);
  }
  console.log(`✓ ${players.length} league memberships`);

  // 2b. season covering the backfilled window, standings locked every
  //     lockFreqWeeks so the SeasonStandings screen shows real period history.
  const seasonStart = new Date(Date.now() - DAYS * 86400_000);
  const seasonEnd = new Date(seasonStart.getTime() + totalWeeks * 7 * 86400_000);
  const dateStr = (d) => d.toISOString().slice(0, 10);
  let { data: season } = await db.from('league_seasons').select('id, start_date, lock_frequency_weeks')
    .eq('league_id', league.id).eq('status', 'active').maybeSingle();
  if (!season) {
    const { data: s, error: se } = await db.from('league_seasons').insert({
      league_id: league.id, name: `[SIM] Season ${dateStr(seasonStart)}`,
      start_date: dateStr(seasonStart), end_date: dateStr(seasonEnd),
      total_weeks: totalWeeks, lock_frequency_weeks: lockFreqWeeks,
      status: 'active', created_by: roster[0].id,
    }).select('id, start_date, lock_frequency_weeks').single();
    if (se) throw new Error('create season: ' + se.message);
    season = s;
    console.log(`✓ created season "${'[SIM] Season ' + dateStr(seasonStart)}" (${nPeriods} periods)`);
  }

  // 3. simulated match history — outcomes follow the DUPR gaps; the real DB
  //    triggers update global + league PLUPR on every insert. Matches are
  //    inserted CHRONOLOGICALLY with period locks interleaved at each period
  //    boundary, so every snapshot captures the ratings/W-L as of that date.
  const pool = roster; // only players with a known target participate
  if (pool.length >= 2) {
    const sims = [];
    for (let i = 0; i < N_MATCHES; i++) {
      const isDoubles = pool.length >= 4 && Math.random() * 100 < DOUBLES_PCT;
      const picks = [...pool].sort(() => Math.random() - 0.5).slice(0, isDoubles ? 4 : 2);
      const [a, b, c, d] = picks;
      const dupr1 = isDoubles ? (a.dupr + b.dupr) / 2 : a.dupr;
      const dupr2 = isDoubles ? (c.dupr + d.dupr) / 2 : b.dupr;
      const p = winProb(dupr1, dupr2);
      const team1Wins = Math.random() < p;
      const ls = loserScore(team1Wins ? p : 1 - p);
      sims.push({
        league_id: league.id,
        match_type: isDoubles ? 'doubles' : 'singles',
        player1_id: a.id, partner1_id: isDoubles ? b.id : null,
        player2_id: isDoubles ? c.id : b.id, partner2_id: isDoubles ? d.id : null,
        player1_score: team1Wins ? 11 : ls,
        player2_score: team1Wins ? ls : 11,
        winner_id: team1Wins ? a.id : (isDoubles ? c.id : b.id),
        winner_team: team1Wins ? 'team1' : 'team2',
        played_at: randomPlayedAt(),
        location_name: LOCATION,
      });
    }
    sims.sort((x, y) => x.played_at.localeCompare(y.played_at));

    // period boundary n = season start + n * lockFreqWeeks weeks
    const boundary = (n) => new Date(new Date(season.start_date).getTime() + n * (season.lock_frequency_weeks ?? lockFreqWeeks) * 7 * 86400_000);
    let nextPeriod = 1;
    const lockPeriod = async (n) => {
      const snapDate = dateStr(boundary(n));
      const { error } = await db.rpc('_lock_season_period_unchecked',
        { p_season_id: season.id, p_period_number: n, p_snapshot_date: snapDate });
      if (error) console.warn(`  ⚠ lock period ${n}: ${error.message}`);
      else console.log(`  🔒 period ${n} locked @ ${snapDate}`);
    };

    let singles = 0, doubles = 0;
    for (const [i, m] of sims.entries()) {
      while (nextPeriod <= nPeriods && new Date(m.played_at) >= boundary(nextPeriod)) {
        await lockPeriod(nextPeriod); nextPeriod++;
      }
      const { error } = await db.from('matches').insert(m);
      if (error) throw new Error(`match ${i + 1}: ${error.message}`);
      m.match_type === 'doubles' ? doubles++ : singles++;
      if ((i + 1) % 10 === 0) console.log(`  … ${i + 1}/${N_MATCHES} matches`);
    }
    // lock any remaining elapsed periods (boundary already in the past)
    while (nextPeriod <= nPeriods && boundary(nextPeriod) <= new Date()) {
      await lockPeriod(nextPeriod); nextPeriod++;
    }
    console.log(`✓ ${singles} singles + ${doubles} doubles simulated at "${LOCATION}"`);
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
    .select('id, username, rating, total_matches_played')
    .in('id', roster.filter(r => r.id).map(r => r.id)).order('rating', { ascending: false });
  console.log('\nFinal roster (target → PLUPR after simulation):');
  for (const f of final ?? []) {
    const r = roster.find(x => x.id === f.id);
    console.log(`  ${f.username.padEnd(16)} target ${r?.dupr?.toFixed(2)}  →  PLUPR ${Number(f.rating).toFixed(2)}  (${f.total_matches_played} matches)`);
  }

  // 6. proof the matches were tracked in league standings: print each locked
  //    period's snapshot (rank / W-L / rating as of that period boundary).
  const nameOf = new Map(roster.map(r => [r.id, r.username]));
  const { data: snaps } = await db.from('season_snapshots')
    .select('period_number, snapshot_date, user_id, rank_at_snapshot, wins_in_season, losses_in_season, elo_at_snapshot')
    .eq('season_id', season.id)
    .order('period_number').order('rank_at_snapshot');
  if (snaps?.length) {
    console.log('\nSeason standings by refresh period:');
    let cur = null;
    for (const s of snaps) {
      if (s.period_number !== cur) {
        cur = s.period_number;
        console.log(`  — Period ${s.period_number} (locked ${s.snapshot_date}) —`);
      }
      const nm = nameOf.get(s.user_id) ?? s.user_id.slice(0, 8);
      console.log(`    #${String(s.rank_at_snapshot).padEnd(3)} ${String(nm).padEnd(16)} ${s.wins_in_season}W-${s.losses_in_season}L  rating ${Number(s.elo_at_snapshot).toFixed(2)}`);
    }
  } else {
    console.log('\n(no season snapshots — no period boundary fell inside the backfilled window)');
  }
}

(DELETE ? cleanup() : seed()).catch((e) => { console.error('\n✗ ' + e.message); process.exit(1); });
