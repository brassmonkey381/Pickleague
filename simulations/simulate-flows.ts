/**
 * Pickleague toolbox — Simulate Flows
 *
 * Drives real user flows by SIGNING IN AS sim players (anon key + password) and
 * calling the same tables/RPCs the app does, so RLS policies and RPC grants are
 * exercised for real — not bypassed with the service-role key.
 *
 * Scenarios:
 *   league     — create a league (open|invite_only) → members join (direct, or
 *                request + admin approval + invite-code redemption).
 *   tournament — create a tournament (format / match-type / team-creation /
 *                registration-mode) → invites+accepts or requests+approvals →
 *                doubles pairing → (optional) generate round 1 + play to done.
 *   cleanup    — tear down every [SIM]-prefixed league & tournament.
 *
 * Reuses the pure bracket generators from mobile/src/lib/tournament.ts (same as
 * the other sims). Sign-in uses SUPABASE_ANON_KEY; account lookup/reset and the
 * service-only bits use SUPABASE_SERVICE_ROLE_KEY.
 *
 *   cd simulations && npx tsx simulate-flows.ts --scenario tournament \
 *     --users 8 --format round_robin --match-type singles --registration-mode request --play
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  seedPlayers, generateRoundRobin, generateSingleElim, generateDoubleElim,
  generatePoolPlay, generateRotatingPartners,
  generateDoublesRoundRobin, generateDoublesSingleElim, generateDoublesDoubleElim,
  generateDoublesPoolPlay, type MatchPairing,
} from '../mobile/src/lib/tournament';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(n);
const val = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const SCENARIO   = val('--scenario', 'tournament');
const N_USERS    = Number(val('--users', '8'));
const FORMAT     = val('--format', 'round_robin');
const MATCH_TYPE = val('--match-type', 'singles');
const TEAM_CREATE = val('--team-creation', 'fixed');
const REG_MODE   = val('--registration-mode', 'request');
const LEAGUE_MODE = val('--league-mode', 'open');
const PLAY       = has('--play');
const DRY        = has('--dry-run');
const PASSWORD   = 'pickle123';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) { console.error('Need SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }
const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const log = (s: string) => console.log(s);
const step = (s: string) => console.log(`\n▸ ${s}`);
const die = (s: string) => { console.error('\n✗ ' + s); process.exit(1); };

// A signed-in client acting AS one sim player (its own JWT → RLS applies).
// Sim players are identified by AUTH EMAIL (sim_player_<n>@pickleague.test) —
// profile usernames get sanitized by the signup trigger (underscores stripped),
// so the email is the stable key. `signIn` takes the full email.
//
// Sessions are CACHED: each user signs in exactly once per run. Supabase Auth
// rate-limits the /token endpoint (sign-ins + refreshes) to ~30 per 5 min per
// IP by default, and a single flow re-uses the same actors many times — without
// the cache an 8-user run trips "Request rate limit reached" mid-flow.
type Actor = { id: string; username: string; client: SupabaseClient };
const actorCache = new Map<string, Actor>();
async function signIn(email: string): Promise<Actor> {
  const cached = actorCache.get(email);
  if (cached) return cached;
  const client = createClient(URL!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.user) throw new Error(`sign in ${email}: ${error?.message}`);
  const actor = { id: data.user.id, username: email.split('@')[0], client };
  actorCache.set(email, actor);
  return actor;
}

const SIM_EMAIL = /^sim_player_(\d+)@pickleague\.test$/;
async function pickSimPlayers(n: number): Promise<string[]> {
  const emails: string[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error('list sim players: ' + error.message);
    emails.push(...data.users.map((u: any) => u.email as string).filter((e: string) => SIM_EMAIL.test(e ?? '')));
    if (data.users.length < 1000) break;
  }
  emails.sort((a, b) => Number(a.match(SIM_EMAIL)![1]) - Number(b.match(SIM_EMAIL)![1]));
  if (emails.length < n) die(`Only ${emails.length} sim players exist; need ${n}. Run "Seed Fake Players" first.`);
  return emails.slice(0, n);
}

// ── cleanup ─────────────────────────────────────────────────────────────────
async function cleanup() {
  step('Cleanup: tearing down [SIM]-prefixed leagues & tournaments');
  const { data: tourneys } = await admin.from('tournaments').select('id, name').like('name', '[SIM]%');
  const { data: leagues } = await admin.from('leagues').select('id, name').like('name', '[SIM]%');
  log(`Found ${tourneys?.length ?? 0} [SIM] tournaments, ${leagues?.length ?? 0} [SIM] leagues.`);
  if (DRY) return log('--dry-run: nothing deleted.');
  for (const t of tourneys ?? []) {
    const { error } = await admin.rpc('godmode_delete_tournament', { p_tournament_id: t.id })
      .then(r => r, () => admin.from('tournaments').delete().eq('id', t.id));
    log(error ? `  ⚠ ${t.name}: ${error.message}` : `  ✓ deleted tournament ${t.name}`);
  }
  for (const l of leagues ?? []) {
    const { error } = await admin.rpc('godmode_delete_league', { p_league_id: l.id })
      .then(r => r, () => admin.from('leagues').delete().eq('id', l.id));
    log(error ? `  ⚠ ${l.name}: ${error.message}` : `  ✓ deleted league ${l.name}`);
  }
}

// ── league scenario ─────────────────────────────────────────────────────────
async function leagueScenario() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const leagueName = `[SIM] ${LEAGUE_MODE} league ${stamp}`;
  step(`League scenario: "${leagueName}" (${LEAGUE_MODE}), ${N_USERS} players`);
  if (DRY) return log('--dry-run: would create league, then ' + (LEAGUE_MODE === 'open' ? 'direct joins.' : 'join requests + invite-code redemptions.'));
  const names = await pickSimPlayers(N_USERS);

  const admin0 = await signIn(names[0]);
  const { data: league, error } = await admin0.client.from('leagues')
    .insert({ name: leagueName, description: 'Toolbox flow sim', created_by: admin0.id, is_open: LEAGUE_MODE === 'open' })
    .select('id').single();
  if (error) die('create league (as user): ' + error.message);
  log(`  ✓ ${names[0]} created league`);
  // creator membership
  await admin0.client.from('league_members').insert({ league_id: league!.id, user_id: admin0.id, role: 'admin' });

  if (LEAGUE_MODE === 'open') {
    for (const u of names.slice(1)) {
      const a = await signIn(u);
      const { error: e } = await a.client.from('league_members').insert({ league_id: league!.id, user_id: a.id, role: 'member' });
      log(e ? `  ⚠ ${u} join: ${e.message}` : `  ✓ ${u} joined (direct)`);
    }
  } else {
    // invite-only: admin mints a code, each member redeems it (SECURITY DEFINER RPC)
    const { data: code, error: ce } = await admin0.client.rpc('create_invite_code', {
      p_scope_type: 'league', p_scope_id: league!.id, p_max_uses: N_USERS, p_expires_days: 7, p_pickle_subsidy: 0,
    });
    if (ce) die('create_invite_code: ' + ce.message);
    const token = (Array.isArray(code) ? code[0] : code)?.token ?? (code as any)?.token;
    log(`  ✓ invite code ${token}`);
    for (const u of names.slice(1)) {
      const a = await signIn(u);
      const { data: r, error: e } = await a.client.rpc('redeem_invite_code', { p_token: token });
      const row = Array.isArray(r) ? r[0] : r;
      log(e || !row?.success ? `  ⚠ ${u} redeem: ${e?.message ?? row?.message}` : `  ✓ ${u} joined via code`);
    }
  }
  const { count } = await admin.from('league_members').select('*', { count: 'exact', head: true }).eq('league_id', league!.id);
  log(`\n✓ league has ${count} members`);
}

// ── tournament scenario ─────────────────────────────────────────────────────
// Per-player draws: singles formats + rotating partners (which builds its own
// full foursomes each round).
function generatePairings(format: string, playerIds: string[]): MatchPairing[] {
  const seeded = seedPlayers(playerIds, {}, 'random');   // random seeding: ratings unused
  switch (format) {
    case 'round_robin':        return generateRoundRobin(seeded);
    case 'single_elimination': return generateSingleElim(seeded);
    case 'double_elimination': return generateDoubleElim(seeded);
    case 'pool_play':          return generatePoolPlay(seeded, Math.max(2, Math.floor(seeded.length / 4))).matches;
    case 'rotating_partners':  return generateRotatingPartners(seeded, Math.max(1, seeded.length - 1));
    default: throw new Error('unsupported format ' + format);
  }
}

// Team draws for doubles (non-rotating): every entrant is a COMPLETE pair of 2
// — mirrors the app's requirement that all players are paired before the draw.
function generateTeamPairings(format: string, teams: [string, string][]): MatchPairing[] {
  const seeded = [...teams].sort(() => Math.random() - 0.5);
  switch (format) {
    case 'round_robin':        return generateDoublesRoundRobin(seeded);
    case 'single_elimination': return generateDoublesSingleElim(seeded);
    case 'double_elimination': return generateDoublesDoubleElim(seeded);
    case 'pool_play':          return generateDoublesPoolPlay(seeded, Math.max(2, Math.floor(seeded.length / 2))).matches;
    default: throw new Error('unsupported doubles format ' + format);
  }
}

async function tournamentScenario() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const tName = `[SIM] ${FORMAT} ${MATCH_TYPE} ${stamp}`;
  step(`Tournament scenario: "${tName}"`);
  log(`  format=${FORMAT} match-type=${MATCH_TYPE} team-creation=${TEAM_CREATE} registration=${REG_MODE} play=${PLAY}`);
  if (DRY) return log('--dry-run: would create tournament, invite/approve, pair, generate + play.');

  const names = await pickSimPlayers(N_USERS);
  const host = await signIn(names[0]);
  // 1. create tournament (as host) + host approved-admin registration
  const { data: t, error: te } = await host.client.from('tournaments').insert({
    name: tName, created_by: host.id, format: FORMAT, match_type: MATCH_TYPE,
    registration_mode: REG_MODE, team_creation: TEAM_CREATE, status: 'registration',
    seeding: 'random', pool_count: 2,
  }).select('id').single();
  if (te) die('create tournament: ' + te.message);
  await host.client.from('tournament_registrations').insert({ tournament_id: t!.id, user_id: host.id, status: 'approved', role: 'admin' });
  log(`  ✓ ${names[0]} created tournament + is admin`);

  // 2. registration: invite+accept, or self-request+approve
  const others = names.slice(1);
  if (REG_MODE === 'invite_only') {
    for (const u of others) {
      const a = await signIn(u);
      const { data: inv, error: ie } = await host.client.rpc('tournament_invite_player', { p_tournament_id: t!.id, p_user_id: a.id });
      if (ie) { log(`  ⚠ invite ${u}: ${ie.message}`); continue; }
      const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', t!.id).eq('user_id', a.id).single();
      const { error: re } = await a.client.rpc('tournament_respond_to_invite', { p_registration_id: reg!.id, p_accept: true });
      log(re ? `  ⚠ ${u} accept: ${re.message}` : `  ✓ ${u} invited + accepted`);
    }
  } else {
    for (const u of others) {
      const a = await signIn(u);
      const { error: re } = await a.client.from('tournament_registrations').insert({ tournament_id: t!.id, user_id: a.id });
      if (re) { log(`  ⚠ ${u} request: ${re.message}`); continue; }
      const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', t!.id).eq('user_id', a.id).single();
      const { error: ae } = await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg!.id);
      log(ae ? `  ⚠ ${u} approve: ${ae.message}` : `  ✓ ${u} requested + approved`);
    }
  }

  // 3. approved players (in registration order)
  const { data: approved } = await admin.from('tournament_registrations')
    .select('user_id').eq('tournament_id', t!.id).eq('status', 'approved').order('registered_at');
  const playerIds: string[] = (approved ?? []).map((r: any) => r.user_id);
  log(`\n  ${playerIds.length} approved players`);

  // 4. doubles pairing (fixed → pair RPCs; random → auto-paired at generation).
  //    Model: a captain creates a doubles_pair, invites the partner, partner
  //    accepts. All three are SECURITY DEFINER RPCs, called as the acting user.
  if (MATCH_TYPE === 'doubles' && TEAM_CREATE === 'fixed') {
    step('Pairing doubles teams (create_doubles_pair → pair_invite → accept)');
    const idToName = new Map<string, string>();
    for (const u of names) { const a = await signIn(u); idToName.set(a.id, u); }
    for (let i = 0; i + 1 < playerIds.length; i += 2) {
      const [capId, partId] = [playerIds[i], playerIds[i + 1]];
      const capName = idToName.get(capId), partName = idToName.get(partId);
      if (!capName || !partName) continue;
      const captain = await signIn(capName);
      const { data: pairId, error: ce } = await captain.client.rpc('create_doubles_pair',
        { p_tournament_id: t!.id, p_name: `${capName.split('@')[0]} & ${partName.split('@')[0]}` });
      if (ce) { log(`  ⚠ create pair ${capName}: ${ce.message}`); continue; }
      const { data: reqId, error: ie } = await captain.client.rpc('pair_invite',
        { p_pair_id: pairId, p_user_id: partId, p_message: null });
      if (ie) { log(`  ⚠ invite ${partName}: ${ie.message}`); continue; }
      const partner = await signIn(partName);
      const { error: re } = await partner.client.rpc('pair_respond_to_join', { p_request_id: reqId, p_accept: true });
      log(re ? `  ⚠ ${partName} accept: ${re.message}` : `  ✓ paired ${capName} + ${partName}`);
    }
  }

  // 5. generate round 1 (mirrors the app's lock-in: rounds + tournament_matches, status→active)
  if (playerIds.length >= 2) {
    step('Generating round 1');
    let pairings: MatchPairing[];
    const isTeamDoubles = MATCH_TYPE === 'doubles' && FORMAT !== 'rotating_partners';
    if (isTeamDoubles) {
      // Doubles draws are generated from COMPLETE pairs only — same requirement
      // the app enforces. random team-creation persists pairs via the same RPC
      // the app's "Generate Random Pairs" button calls.
      if (TEAM_CREATE === 'random') {
        const { data: nPairs, error: gre } = await host.client.rpc('generate_random_pairs',
          { p_tournament_id: t!.id, p_mode: 'random' });
        if (gre) return die('generate_random_pairs: ' + gre.message);
        log(`  ✓ auto-paired ${nPairs} random pair(s)`);
      }
      const { data: pairRows } = await admin.from('doubles_pairs')
        .select('partner_1_id, partner_2_id').eq('tournament_id', t!.id);
      const teams = (pairRows ?? [])
        .filter((p: any) => p.partner_1_id && p.partner_2_id)
        .map((p: any) => [p.partner_1_id, p.partner_2_id] as [string, string]);
      const covered = new Set(teams.flat());
      const unpaired = playerIds.filter(id => !covered.has(id));
      if (unpaired.length) return die(`${unpaired.length} approved player(s) not in a pair of 2 — doubles draws require full pairing (unpaired ids: ${unpaired.join(', ')})`);
      if (teams.length < 2) return die('need at least 2 complete doubles pairs');
      log(`  ✓ ${teams.length} complete teams of 2`);
      try { pairings = generateTeamPairings(FORMAT, teams); }
      catch (e: any) { return die('doubles bracket generation: ' + e.message); }
    } else {
      try { pairings = generatePairings(FORMAT, playerIds); }
      catch (e: any) { return die('bracket generation: ' + e.message); }
    }
    const { data: round, error: rErr } = await host.client.from('tournament_rounds')
      .insert({ tournament_id: t!.id, round_number: 1, label: `${FORMAT} Schedule`, round_type: FORMAT === 'pool_play' ? 'pool' : 'winners' })
      .select('id').single();
    if (rErr) die('create round: ' + rErr.message);
    const isDoubles = MATCH_TYPE === 'doubles' || FORMAT === 'rotating_partners';
    const rows = pairings.map((m, i) => ({
      tournament_id: t!.id, round_id: round!.id, match_order: i, match_type: isDoubles ? 'doubles' : 'singles',
      team1_player1: m.team1[0] !== 'BYE' ? m.team1[0] : null,
      team1_player2: m.team1[1] && m.team1[1] !== 'BYE' ? m.team1[1] : null,
      team2_player1: m.team2[0] !== 'BYE' ? m.team2[0] : null,
      team2_player2: m.team2[1] && m.team2[1] !== 'BYE' ? m.team2[1] : null,
    }));
    const { error: mErr } = await host.client.from('tournament_matches').insert(rows);
    if (mErr) die('insert matches: ' + mErr.message);
    await host.client.from('tournaments').update({ status: 'active' }).eq('id', t!.id);
    log(`  ✓ ${rows.length} matches created, tournament active`);

    // 6. play: enter scores for every non-BYE match
    if (PLAY) {
      step('Playing matches (entering scores)');
      const { data: matches } = await admin.from('tournament_matches').select('*').eq('round_id', round!.id).order('match_order');
      let played = 0;
      for (const m of matches ?? []) {
        if (!m.team1_player1 || !m.team2_player1) continue; // BYE
        const t1Wins = Math.random() < 0.5;
        const { error: ue } = await host.client.from('tournament_matches').update({
          team1_score: t1Wins ? 11 : Math.floor(Math.random() * 9) + 1,
          team2_score: t1Wins ? Math.floor(Math.random() * 9) + 1 : 11,
          winner_team: t1Wins ? 'team1' : 'team2',
          status: 'completed',
        }).eq('id', m.id);
        if (!ue) played++;
      }
      log(`  ✓ played ${played} matches`);
    }
  }

  log(`\n✓ tournament "${tName}" ready` + (PLAY ? ' and played' : ''));
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  if (SCENARIO === 'cleanup') await cleanup();
  else if (SCENARIO === 'league') await leagueScenario();
  else if (SCENARIO === 'tournament') await tournamentScenario();
  else die('unknown scenario ' + SCENARIO);
})().catch((e) => die(e.message));
