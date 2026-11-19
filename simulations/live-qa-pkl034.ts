/**
 * PKL-034 live tournament QA: 7 QA bots + Brian (on his phone) play an 8-player singles round robin,
 * then a Final (1st v 2nd) and a Third Place Match (3rd v 4th), on PRODUCTION Supabase.
 *
 *   npx tsx live-qa-pkl034.ts setup   [--rehearsal]        create bots + private tournament, invite Brian
 *   npx tsx live-qa-pkl034.ts run     [--rehearsal] [--fast] [--interval 60]
 *   npx tsx live-qa-pkl034.ts status  [--rehearsal]
 *   npx tsx live-qa-pkl034.ts cleanup [--rehearsal] [--restore-brian]
 *   npx tsx live-qa-pkl034.ts plan                         offline: schedule + scoring + standings self-test, no network
 *
 * Bots: "QA Bot n", sim_pkl034_<n>@pickleague.test (rehearsal: sim_pkl034r_<n>@...). .test never delivers mail, and
 * the accounts are created with the admin API with email_confirm=true, so no email is sent at all.
 * Bots act through their OWN sessions (anon key + password): real RLS, the same writes the app makes.
 * The service key is used only to create/delete the bot accounts, to read state, and for the cleanup RPC.
 *
 * Control while `run` is going: write one word into state/pkl-034/control.txt
 *   run | pause | stop | fast | slow      (or Ctrl+C; `run` resumes from the database state)
 * Every action goes to state/pkl-034/<live|rehearsal>-log.txt; ids go to state/pkl-034/<live|rehearsal>.json.
 *
 * Secrets: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY from env, else read silently from
 * tools/toolbox/toolbox.secrets.json. Nothing secret is ever printed.
 *
 * --doubles (PKL-043): a 10-player rotating_partners DOUBLES tournament instead (9 bots + Brian; rehearsal 10 bots),
 * playoff_format left at its 'none' default (the app's Create screen sends none for this format), draw FIXED:
 * QA Bot N = seed N, Brian = seed 10. Bots sim_pkl043[r]_<n>@pickleague.test; everything else goes to state/pkl-043/
 * (control.txt, <mode>.json, <mode>-log.txt). Doubles score plans: [{ matchOrder, a: [ref, ref], b: [ref, ref],
 * score: [team1, team2] }], matched by match_order (the lineup is checked against the draw).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedPlayers, generateRoundRobin, generateRotatingPartners, rotatingPartnersRounds, FORMAT_META, type MatchPairing } from '../mobile/src/lib/tournament';
import { buildStandingsComparator } from '../mobile/src/lib/tournamentTiebreakers';

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const CMD = argv[0] ?? 'help';
const has = (n: string) => argv.includes(n);
const val = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const REHEARSAL = has('--rehearsal');
const MODE = REHEARSAL ? 'rehearsal' : 'live';
const BRIAN = val('--brian', '252a36e1-5d89-4ad2-8a3e-b786579f019a'); // Brian Stockman (godmode.ts)
const DOUBLES = has('--doubles');
const TAG = DOUBLES ? 'pkl043' : 'pkl034';
const ITEM = DOUBLES ? 'PKL-043' : 'PKL-034';
const N_PLAYERS = DOUBLES ? 10 : 8;
const N_BOTS = REHEARSAL ? N_PLAYERS : N_PLAYERS - 1;
const T_NAME = DOUBLES ? (REHEARSAL ? '[SIM] PKL-043 doubles QA rehearsal' : '[SIM] PKL-043 doubles QA')
  : REHEARSAL ? '[SIM] PKL-034 rehearsal' : '[SIM] PKL-034 live QA';
const L_NAME = DOUBLES ? (REHEARSAL ? '[SIM] PKL-043 rehearsal league' : '[SIM] PKL-043 QA league')
  : REHEARSAL ? '[SIM] PKL-034 rehearsal league' : '[SIM] PKL-034 QA league';
const EMAIL = (n: number) => `sim_${TAG}${REHEARSAL ? 'r' : ''}_${n}@pickleague.test`;
/** Rounds the app asks the rotating generator for (useTournamentDetail.ts: rotatingPartnersRounds, PKL-044). */
const rotatingRounds = (n: number) => rotatingPartnersRounds(n);
let intervalMs = Number(val('--interval', '60')) * 1000;
// Hooks (PKL-034 oracle work):
//  --score-plan <file.json>  scripted scores instead of random ones. An array of
//      { "a": <ref>, "b": <ref>, "score": [aPoints, bPoints], "stage"?: "group"|"finals"|"third_place_match" }
//      ref = "bot:N" (QA Bot N) | "you" (Brian) | "seed:N" (registration seed after lock-in).
//      A bot match with a plan entry uses it; any other bot match gets a random score. For a match with Brian in it
//      the planned score is printed so he can enter exactly that on his phone.
//  --assert <module.mjs>     its default export is awaited after every observed change (a score from a bot or from
//      Brian, lock-in, playoff generation, completion) with a snapshot
//      { event, tournament, rounds, matches, registrations, players: {id:name}, brian }. Return / resolve to
//      { ok: boolean, details?: string } (or throw). Not ok = the run logs ORACLE MISMATCH and stops (exit 1).
const SCORE_PLAN = val('--score-plan', '');
const ASSERT_MOD = val('--assert', '');
let fast = has('--fast');
const FAST_MS = 2500;

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const STATE_DIR = path.join(repo, 'state', DOUBLES ? 'pkl-043' : 'pkl-034');
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, `${MODE}.json`);
const LOG_FILE = path.join(STATE_DIR, `${MODE}-log.txt`);
const CONTROL = path.join(STATE_DIR, 'control.txt');

// ── logging ───────────────────────────────────────────────────────────────────
const stamp = () => new Date().toLocaleTimeString('en-US', { hour12: false });
function log(s: string) {
  const line = `[${stamp()}] ${s}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}
let failures = 0;
function check(desc: string, ok: boolean, details?: string) {
  if (!ok) failures++;
  log(`${ok ? 'CHECK PASS' : 'CHECK FAIL'}  ${desc}${!ok && details ? ' :: ' + details : ''}`);
}
/** A check whose failure is a known, already-logged app bug: logged, never counted (Brian decides the rule). */
function knownBug(bug: string, desc: string, ok: boolean, details?: string) {
  log(`${ok ? 'CHECK PASS' : `KNOWN BUG ${bug} (expected, not counted)`}  ${desc}${!ok && details ? ' :: ' + details : ''}`);
}
const die = (s: string): never => { log('FAILED: ' + s); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── pure helpers (also covered by `plan`) ─────────────────────────────────────
/** A random valid single-game pickleball score: 11-0..11-9, or 12-10 (win by 2). Winner first. */
export function randomScore(rand = Math.random): [number, number] {
  const r = rand();
  if (r < 0.12) return [12, 10];
  return [11, Math.floor(rand() * 10)]; // 0..9
}
/** The app's rule (lib/matchRecording.scoreProblem): 11+ with a 2-point lead, at most 50. */
export const validScore = (a: number, b: number) => Math.max(a, b) >= 11 && Math.abs(a - b) >= 2 && Math.max(a, b) <= 50;

type M = {
  id: string; round_id: string; match_order: number; status: string; winner_team: string | null; match_type?: string;
  team1_player1: string | null; team2_player1: string | null; team1_score: number | null; team2_score: number | null;
  team1_player2?: string | null; team2_player2?: string | null;
  court?: string | null; called_at?: string | null;
};
/** PKL-039: the doubles QA tournament reserves two courts unless --no-courts (then players pick any court, as before). */
const COURTS: string[] | null = has('--doubles') && !has('--no-courts') ? ['1', '2'] : null;
/** The four (or two, in singles) players of a match, nulls dropped. */
const four = (m: M) => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].filter((x): x is string => !!x);
const sameSet = (a: (string | null)[], b: (string | null)[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/** The app's rotating_partners draw for players in seed order, as the rows doLockIn writes (match_order = flat index). */
export function rotatingRows(seeded: string[]) {
  const pairings = generateRotatingPartners(seeded, rotatingRounds(seeded.length));
  return { pairings, rows: pairings.map((m, i) => ({
    match_order: i, match_type: 'doubles', play_round: m.round,   // PKL-049: lock-in saves the round
    team1_player1: m.team1[0] !== 'BYE' ? m.team1[0] : null,
    team1_player2: m.team1[1] && m.team1[1] !== 'BYE' ? m.team1[1] : null,
    team2_player1: m.team2[0] !== 'BYE' ? m.team2[0] : null,
    team2_player2: m.team2[1] && m.team2[1] !== 'BYE' ? m.team2[1] : null,
  })) };
}

type DPlanRow = { matchOrder: number; stage?: string; a: string[]; b: string[]; score: [number, number] };
/** A doubles plan row's score for this match as [team1, team2]; throws if the plan's lineup is not this match's. */
export function plannedDoubles(plan: DPlanRow[], m: M, resolve: (ref: string) => string | null): [number, number] | null {
  const p = plan.find((x) => x.matchOrder === m.match_order && (x.stage ?? 'group') === 'group');
  if (!p) return null;
  const a = p.a.map(resolve), b = p.b.map(resolve);
  const t1 = [m.team1_player1 ?? null, m.team1_player2 ?? null], t2 = [m.team2_player1 ?? null, m.team2_player2 ?? null];
  if (sameSet(a, t1) && sameSet(b, t2)) return [p.score[0], p.score[1]];
  if (sameSet(a, t2) && sameSet(b, t1)) return [p.score[1], p.score[0]];
  throw new Error(`score plan match_order ${m.match_order} is ${p.a.join('+')} v ${p.b.join('+')}, which is not the lineup of that match in the draw`);
}
type Entry = { key: string; wins: number; losses: number; pf: number; pa: number; seed?: number };
/** Client standings (the app's comparator): wins, then 2-way H2H, then point diff, then seed. */
export function standings(matches: M[], players: string[], seedOf: Map<string, number>): Entry[] {
  const e = new Map<string, Entry>(players.map((p) => [p, { key: p, wins: 0, losses: 0, pf: 0, pa: 0, seed: seedOf.get(p) ?? 999 }]));
  for (const m of matches) {
    if (m.status !== 'completed' || !m.winner_team || !m.team1_player1 || !m.team2_player1) continue;
    const a = e.get(m.team1_player1), b = e.get(m.team2_player1);
    if (!a || !b) continue;
    a.pf += m.team1_score ?? 0; a.pa += m.team2_score ?? 0;
    b.pf += m.team2_score ?? 0; b.pa += m.team1_score ?? 0;
    if (m.winner_team === 'team1') { a.wins++; b.losses++; } else { b.wins++; a.losses++; }
  }
  const list = [...e.values()];
  list.sort(buildStandingsComparator(list, matches.filter((m) => m.status === 'completed') as any));
  return list;
}

// ── offline self-test: no network ─────────────────────────────────────────────
function planDoubles() {
  // fixed draw: seed N = player N; the "you" ref = seed 10 (live) / bot:10 (rehearsal), bot:N = seed N
  const ids = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
  const { pairings, rows } = rotatingRows(ids);
  const nR = rotatingRounds(10);
  const okCount = rows.length === 20 && nR === 10;
  const okFour = rows.every((r) => new Set(four(r as M)).size === 4);
  const byRound = new Map<number, (string | undefined)[]>(); for (const p of pairings) byRound.set(p.round ?? 0, [...(byRound.get(p.round ?? 0) ?? []), ...p.team1, ...p.team2]);
  const okRound = [...byRound.values()].every((xs) => new Set(xs).size === xs.length);
  const partners = new Set<string>(); let okPartners = true;
  for (const p of pairings) for (const t of [p.team1, p.team2]) { const k = [...t].sort().join('|'); if (partners.has(k)) okPartners = false; partners.add(k); }
  const played = new Map<string, number>(); for (const r of rows) for (const x of four(r as M)) played.set(x, (played.get(x) ?? 0) + 1);
  const okPlayed = ids.every((x) => played.get(x) === 8);
  console.log(`rotating partners for 10: ${nR} rounds, ${rows.length} matches; 4 distinct each: ${okFour}; nobody twice in a round: ${okRound}; no partnership repeats: ${okPartners}; everyone plays 8 (PKL-044): ${okPlayed}`);
  console.log('draw: ' + rows.map((r) => `#${r.match_order} ${r.team1_player1}+${r.team1_player2} v ${r.team2_player1}+${r.team2_player2}`).join(' | '));
  let okPlans = true;
  for (const f of ['sim-plan-D-base.json', 'sim-plan-D-ties.json', 'sim-plan-D-base-rehearsal.json', 'sim-plan-D-ties-rehearsal.json']) {
    const file = path.join(repo, 'state', 'pkl-034', f);
    if (!fs.existsSync(file)) { console.log(`plan ${f}: not found (skipped)`); continue; }
    const pl: DPlanRow[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    const resolve = (ref: string) => ref === 'you' ? 's10' : /^(seed|bot):\d+$/.test(ref) ? `s${ref.split(':')[1]}` : null;
    let ok = pl.length === rows.length, wins = 0;
    try {
      for (const r of rows) { const s = plannedDoubles(pl, r as M, resolve); if (!s || !validScore(s[0], s[1])) ok = false; else wins++; }
    } catch (e: any) { ok = false; console.log(`  ${e.message}`); }
    console.log(`plan ${f}: ${pl.length} rows, ${wins}/${rows.length} matched to the draw with valid scores: ${ok}`);
    okPlans &&= ok;
  }
  let okScores = true; for (let i = 0; i < 20000; i++) { const [w, l] = randomScore(); if (!validScore(w, l)) { okScores = false; break; } }
  console.log(`20000 random scores valid: ${okScores}`);
  process.exit(okCount && okFour && okRound && okPartners && okPlayed && okPlans && okScores ? 0 : 1);
}

function plan() {
  if (DOUBLES) return planDoubles();
  const ids = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const seeded = seedPlayers(ids, {}, 'random');
  const pairings = generateRoundRobin(seeded);
  const real = pairings.filter((p) => p.team1[0] !== 'BYE' && p.team2[0] !== 'BYE');
  console.log(`round robin for 8: ${pairings.length} rows, ${real.length} real matches`);
  const pairsSeen = new Set(real.map((p) => [p.team1[0], p.team2[0]].sort().join('-')));
  const okPairs = real.length === 28 && pairsSeen.size === 28;
  const perPlayer = new Map<string, number>(); for (const p of real) for (const x of [p.team1[0], p.team2[0]]) perPlayer.set(x, (perPlayer.get(x) ?? 0) + 1);
  const okEach = [...perPlayer.values()].every((n) => n === 7);
  let okScores = true; for (let i = 0; i < 20000; i++) { const [w, l] = randomScore(); if (!validScore(w, l)) { okScores = false; break; } }
  // standings on a random full season
  const ms: M[] = real.map((p, i) => { const [w, l] = randomScore(); const t1 = Math.random() < 0.5;
    return { id: 'm' + i, round_id: 'r', match_order: i, status: 'completed', winner_team: t1 ? 'team1' : 'team2', team1_player1: p.team1[0], team2_player1: p.team2[0],
      team1_score: t1 ? w : l, team2_score: t1 ? l : w }; });
  const st = standings(ms, ids, new Map(seeded.map((p, i) => [p, i + 1])));
  const okWins = st.reduce((s, x) => s + x.wins, 0) === 28;
  console.log('standings:', st.map((x) => `${x.key} ${x.wins}-${x.losses} ${x.pf - x.pa >= 0 ? '+' : ''}${x.pf - x.pa}`).join(' | '));
  console.log(`all 28 pairs once: ${okPairs}; 7 matches each: ${okEach}; 20000 random scores valid: ${okScores}; wins sum 28: ${okWins}`);
  process.exit(okPairs && okEach && okScores && okWins ? 0 : 1);
}

// ── clients ───────────────────────────────────────────────────────────────────
function env() {
  let URL = process.env.SUPABASE_URL, ANON = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !ANON || !SERVICE) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'toolbox', 'toolbox.secrets.json'), 'utf8'));
      URL ||= s.SUPABASE_URL; ANON ||= s.SUPABASE_ANON_KEY; SERVICE ||= s.SUPABASE_SERVICE_ROLE_KEY;
    } catch { /* fall through */ }
  }
  if (!URL || !ANON || !SERVICE) die('missing Supabase URL / anon key / service key (env or tools/toolbox/toolbox.secrets.json)');
  return { URL: URL!, ANON: ANON!, SERVICE: SERVICE! };
}
const E = CMD === 'plan' || CMD === 'help' ? null : env();
const admin = E ? createClient(E.URL, E.SERVICE, { auth: { autoRefreshToken: false, persistSession: false } }) : (null as unknown as SupabaseClient);

type State = {
  mode: string; created_at: string; tournament_id?: string; tournament_name: string; league_id?: string;
  brian_badges_before?: string[];
  bots: { n: number; id: string; email: string; name: string }[];
  password: string; brian?: string; brian_before?: Record<string, unknown>;
};
const readState = (): State | null => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };
const writeState = (s: State) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// A bot's own session, signed in once and refreshed before it expires (Auth rate-limits /token).
const sessions = new Map<string, { client: SupabaseClient; at: number }>();
async function asBot(st: State, id: string): Promise<SupabaseClient> {
  const s = sessions.get(id);
  if (s && Date.now() - s.at < 40 * 60_000) return s.client;
  const bot = st.bots.find((b) => b.id === id); if (!bot) die('not a bot: ' + id);
  const client = createClient(E!.URL, E!.ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await client.auth.signInWithPassword({ email: bot!.email, password: st.password });
    if (!error && data.user) { sessions.set(id, { client, at: Date.now() }); return client; }
    if (!/rate limit/i.test(error?.message ?? '')) die(`sign in ${bot!.name}: ${error?.message}`);
    log(`auth rate limit signing in ${bot!.name}; waiting ${15 * (attempt + 1)}s`);
    await sleep(15_000 * (attempt + 1));
  }
  return die(`sign in ${bot!.name}: rate limited`);
}

async function names(st: State): Promise<Map<string, string>> {
  const m = new Map(st.bots.map((b) => [b.id, b.name]));
  if (st.brian) {
    const { data } = await admin.from('profiles').select('full_name, username').eq('id', st.brian).maybeSingle();
    m.set(st.brian, `${data?.full_name || data?.username || 'Brian'} (YOU)`);
  }
  return m;
}

// Brian's numbers that a tournament can move; snapshotted at setup so cleanup can compare (and restore on request).
const BRIAN_COLS = ['rating', 'singles_rating', 'doubles_rating', 'pickles', 'total_matches_played', 'wins', 'losses'];
async function brianSnapshot(id: string) {
  const { data, error } = await admin.from('profiles').select('*').eq('id', id).single();
  if (error || !data) die('read Brian profile: ' + error?.message);
  return Object.fromEntries(BRIAN_COLS.filter((c) => c in data!).map((c) => [c, (data as any)[c]]));
}

// ── setup ─────────────────────────────────────────────────────────────────────
async function setup() {
  log(`=== setup (${MODE}) ===`);
  const prior = readState();
  if (prior?.tournament_id) {
    const { data } = await admin.from('tournaments').select('id').eq('id', prior.tournament_id).maybeSingle();
    if (data) die(`a ${MODE} tournament already exists (${prior.tournament_id}); run cleanup first`);
  }
  const { data: dup } = await admin.from('tournaments').select('id').eq('name', T_NAME);
  if (dup?.length) die(`"${T_NAME}" already exists (${dup.map((d) => d.id).join(', ')}); run cleanup first`);

  if (!REHEARSAL) {
    const { data: b } = await admin.from('profiles').select('id, full_name, username').eq('id', BRIAN).maybeSingle();
    if (!b) die('Brian profile not found: ' + BRIAN);
    log(`player ${N_PLAYERS}: ${b!.full_name || b!.username} (${BRIAN})`);
  }
  const st: State = { mode: MODE, created_at: new Date().toISOString(), tournament_name: T_NAME, bots: [],
    password: crypto.randomBytes(18).toString('base64url'), brian: REHEARSAL ? undefined : BRIAN };
  writeState(st); // password saved before any account exists, so cleanup can always find them

  // 1. bot accounts
  for (let n = 1; n <= N_BOTS; n++) {
    const email = EMAIL(n), name = `QA Bot ${n}`;
    const { data, error } = await admin.auth.admin.createUser({
      email, password: st.password, email_confirm: true,
      user_metadata: { full_name: name, username: `qabot${n}${REHEARSAL ? 'r' : ''}` },
    });
    if (error) die(`create ${email}: ${error.message} (run cleanup, then setup again)`);
    const id = data.user!.id;
    st.bots.push({ n, id, email, name }); writeState(st);
    const { error: pe } = await admin.from('profiles').update({ full_name: name, gender: 'male' }).eq('id', id);
    if (pe) log(`  note: profile update ${name}: ${pe.message}`);
    log(`bot ${name}  ${id}  ${email}`);
  }
  const host = st.bots[0];
  // Starting a league costs 5000 pickles and a tournament 2500 (migration_create_costs.sql); new accounts have none.
  // Fund the host for exactly those two fees so the app's real fee path runs. The balance, and the create_fees rows
  // (on delete cascade), go away when cleanup deletes the bot.
  const { error: fe } = await admin.from('profiles').update({ pickles: 7500 }).eq('id', host.id);
  if (fe) die('fund host: ' + fe.message);
  log(`host ${host.name} funded with 7500 pickles (league 5000 + tournament 2500 create fees)`);
  const hc = await asBot(st, host.id);

  // 2. a CLOSED league to hold it. A standalone tournament is visible to every user (Tournaments list, Home's open
  //    list), invite_only or not; a closed league's tournament is visible only to its members, the host, registrants
  //    and godmode. Members: the bots and Brian (added with the service key; removed with the league at cleanup).
  const { data: lg, error: le } = await hc.from('leagues')
    .insert({ name: L_NAME, description: `QA test league for ${ITEM}. Not a real league.`, created_by: host.id, is_open: false }).select('id').single();
  if (le) die('create league: ' + le.message);
  st.league_id = lg!.id; writeState(st);
  const { error: me } = await hc.from('league_members').insert({ league_id: lg!.id, user_id: host.id, role: 'admin' });
  if (me) die('host league membership: ' + me.message);
  const members = [...st.bots.slice(1).map((b) => b.id), ...(REHEARSAL ? [] : [BRIAN])];
  const { error: me2 } = await admin.from('league_members').insert(members.map((u) => ({ league_id: lg!.id, user_id: u, role: 'member' })));
  if (me2) die('league members: ' + me2.message);
  log(`closed league "${L_NAME}"  ${lg!.id}  (${members.length + 1} members)`);

  // 3. tournament, as the app's CreateTournament writes it
  const start = new Date(Date.now() + 15 * 60_000);
  const payload = DOUBLES ? {
    // rotating_partners: the Create screen sends partner_rotation (default every_match) and team_creation (default
    // fixed), and NO playoff_format / playoff_third_place (it only sends those for round_robin / pool_play), so the
    // column default 'none' applies, which is also the only value that lets the tournament auto-close.
    league_id: lg!.id, name: T_NAME,
    description: `QA test (${ITEM}). Private, invite only. ${N_BOTS} QA bots post scores automatically; this is not a real event.`,
    created_by: host.id, format: 'rotating_partners', match_type: 'doubles', seeding: 'random', pool_count: 1,
    // PKL-044: no partner_rotation any more. PKL-039: courts (null = no courts reserved).
    partner_rotation: null, courts: COURTS, team_creation: 'fixed', registration_mode: 'invite_only', registration_closes_at: null,
    min_players: N_PLAYERS, max_players: N_PLAYERS, start_time: start.toISOString(), expected_length_hours: 2,
    location_name: 'QA test (online)', location_lat: null, location_lng: null,
    pickle_ante: 0, payout_structure: [60, 25, 15], status: 'registration',
  } : {
    league_id: lg!.id, name: T_NAME,
    description: 'QA test (PKL-034). Private, invite only. 7 QA bots post scores automatically; this is not a real event.',
    created_by: host.id, format: 'round_robin', match_type: 'singles', seeding: 'random', pool_count: 1,
    partner_rotation: null, team_creation: 'fixed', registration_mode: 'invite_only', registration_closes_at: null,
    min_players: 8, max_players: 8, start_time: start.toISOString(), expected_length_hours: 1.5,
    location_name: 'QA test (online)', location_lat: null, location_lng: null,
    pickle_ante: 0, payout_structure: [60, 25, 15], status: 'registration',
    playoff_format: 'top_2', playoff_third_place: false, // top_2 with 4+ entrants also creates the Third Place Match
  };
  // Nulls are dropped: an explicit null overrides a NOT NULL column's default (payout_structure failed that way).
  const { data: t, error: te } = await hc.from('tournaments')
    .insert(Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null))).select('id').single();
  if (te) die('create tournament: ' + te.message);
  st.tournament_id = t!.id; writeState(st);
  log(`tournament "${T_NAME}"  ${t!.id}  (host ${host.name})`);
  const { error: re } = await hc.from('tournament_registrations').insert({ tournament_id: t!.id, user_id: host.id, status: 'approved', role: 'admin' });
  if (re) die('host registration: ' + re.message);

  // 4. invite the other bots (they accept) and Brian (he accepts on his phone)
  for (const b of st.bots.slice(1)) {
    const { error: ie } = await hc.rpc('tournament_invite_player', { p_tournament_id: t!.id, p_user_id: b.id });
    if (ie) die(`invite ${b.name}: ${ie.message}`);
    const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', t!.id).eq('user_id', b.id).single();
    const bc = await asBot(st, b.id);
    const { error: ae } = await bc.rpc('tournament_respond_to_invite', { p_registration_id: reg!.id, p_accept: true });
    if (ae) die(`${b.name} accept: ${ae.message}`);
    log(`  ${b.name} invited + accepted`);
  }
  if (!REHEARSAL) {
    st.brian_before = await brianSnapshot(BRIAN);
    const { data: pb } = await admin.from('player_badges').select('id').eq('user_id', BRIAN);
    st.brian_badges_before = (pb ?? []).map((r: any) => String(r.id));
    writeState(st);
    log(`Brian before: ${JSON.stringify(st.brian_before)}; ${st.brian_badges_before.length} badges`);
    const { error: ie } = await hc.rpc('tournament_invite_player', { p_tournament_id: t!.id, p_user_id: BRIAN });
    if (ie) die('invite Brian: ' + ie.message);
    log('Brian invited: accept the invite on your phone (Notifications or the tournament page), then the run starts.');
  }
  log(`setup done. ids in ${STATE_FILE}`);
}

// ── run ───────────────────────────────────────────────────────────────────────
function control(): string {
  try { return fs.readFileSync(CONTROL, 'utf8').trim().toLowerCase() || 'run'; } catch { return 'run'; }
}

/** The fixed doubles draw: QA Bot 1..N in bot order, then Brian last (seed 10). */
const fixedSeedOrder = (st: State) => [...[...st.bots].sort((a, b) => a.n - b.n).map((b) => b.id), ...(st.brian ? [st.brian] : [])];

/**
 * useTournamentDetail.doLockIn for rotating_partners: one 'winners' round "Rotating Partners Schedule", the
 * generateRotatingPartners(seeded, rotatingPartnersRounds(N)) rows with match_type 'doubles' (batches of 20), status active,
 * seeds 1..N in draw order, one lock-in notification per approved member. The only difference: the app shuffles
 * (seeding 'random' -> seedPlayers) and this uses the fixed order Bot N = seed N, Brian = seed 10 so the score plans hold.
 */
async function lockInDoubles(st: State, players: string[]) {
  const hc = await asBot(st, st.bots[0].id);
  const tId = st.tournament_id!;
  const seeded = fixedSeedOrder(st);
  if (!sameSet(seeded, players)) die(`approved players are not the ${N_PLAYERS} expected (bots${st.brian ? ' + Brian' : ''}); not locking in`);
  const { pairings, rows: base } = rotatingRows(seeded);
  const { data: round, error: rErr } = await hc.from('tournament_rounds')
    .insert({ tournament_id: tId, round_number: 1, label: FORMAT_META.rotating_partners.label + ' Schedule', round_type: 'winners' }).select('id').single();
  if (rErr) die('create round: ' + rErr.message);
  const rows = base.map((r) => ({ tournament_id: tId, round_id: round!.id, ...r }));
  for (let i = 0; i < rows.length; i += 20) {
    const { error } = await hc.from('tournament_matches').insert(rows.slice(i, i + 20));
    if (error) die('insert matches: ' + error.message);
  }
  const { error: sErr } = await hc.from('tournaments').update({ status: 'active' }).eq('id', tId);
  if (sErr) die('set active: ' + sErr.message);
  for (let i = 0; i < seeded.length; i++) {
    const { error } = await hc.from('tournament_registrations').update({ seed: i + 1 }).eq('tournament_id', tId).eq('user_id', seeded[i]);
    if (error) die('seed: ' + error.message);
  }
  for (const uid of players) {
    const { error } = await hc.from('notifications').insert({
      user_id: uid, title: `🏆 Bracket Set — ${T_NAME}`,
      body: `The draw has been finalized! ${pairings.length} matches scheduled. Open the tournament to see your matches.`,
      type: 'tournament', entity_id: tId, entity_type: 'tournament',
    });
    if (error) log(`  note: lock-in notification to ${uid.slice(0, 8)}: ${error.message}`);
  }
  log(`LOCK IN (doubles): ${rows.length} rotating-partners matches in ${rotatingRounds(seeded.length)} rounds, fixed seeds ${seeded.map((p, i) => `${i + 1}=${p.slice(0, 8)}`).join(' ')}, tournament active, ${players.length} members notified`);
}

async function lockIn(st: State, players: string[]) {
  if (DOUBLES) return lockInDoubles(st, players);
  const hc = await asBot(st, st.bots[0].id);
  const tId = st.tournament_id!;
  const { data: profs } = await admin.from('profiles').select('id, rating').in('id', players);
  const ratings = Object.fromEntries((profs ?? []).map((p: any) => [p.id, Number(p.rating)]));
  const seeded = seedPlayers(players, ratings, 'random');
  const pairings: MatchPairing[] = generateRoundRobin(seeded);
  const { data: round, error: rErr } = await hc.from('tournament_rounds')
    .insert({ tournament_id: tId, round_number: 1, label: FORMAT_META.round_robin.label + ' Schedule', round_type: 'winners' }).select('id').single();
  if (rErr) die('create round: ' + rErr.message);
  const rows = pairings.map((m, i) => ({
    tournament_id: tId, round_id: round!.id, match_order: i, match_type: 'singles',
    team1_player1: m.team1[0] !== 'BYE' ? m.team1[0] : null, team1_player2: null,
    team2_player1: m.team2[0] !== 'BYE' ? m.team2[0] : null, team2_player2: null,
  }));
  for (let i = 0; i < rows.length; i += 20) {
    const { error } = await hc.from('tournament_matches').insert(rows.slice(i, i + 20));
    if (error) die('insert matches: ' + error.message);
  }
  const { error: sErr } = await hc.from('tournaments').update({ status: 'active' }).eq('id', tId);
  if (sErr) die('set active: ' + sErr.message);
  for (let i = 0; i < seeded.length; i++) {
    const { error } = await hc.from('tournament_registrations').update({ seed: i + 1 }).eq('tournament_id', tId).eq('user_id', seeded[i]);
    if (error) die('seed: ' + error.message);
  }
  // the app's lock-in announcement, one row per member (useTournamentDetail.doLockIn step 4)
  for (const uid of players) {
    const { error } = await hc.from('notifications').insert({
      user_id: uid, title: `🏆 Bracket Set — ${T_NAME}`,
      body: `The draw has been finalized! ${pairings.length} matches scheduled. Open the tournament to see your matches.`,
      type: 'tournament', entity_id: tId, entity_type: 'tournament',
    });
    if (error) log(`  note: lock-in notification to ${uid.slice(0, 8)}: ${error.message}`);
  }
  log(`LOCK IN: ${rows.length} round-robin matches, seeds ${seeded.map((p, i) => `${i + 1}=${p.slice(0, 8)}`).join(' ')}, tournament active, ${players.length} members notified`);
}

async function run() {
  const st = readState(); if (!st?.tournament_id) return die(`no ${MODE} setup found; run setup first`);
  const tId = st.tournament_id;
  if (has('--interval') === false && fast) intervalMs = FAST_MS;
  log(`=== run (${MODE}) ${fast ? 'FAST' : `every ${intervalMs / 1000}s`} ; control file ${CONTROL} ===`);
  fs.writeFileSync(CONTROL, 'run');
  const nm = await names(st);
  const N = (id: string | null) => (id ? nm.get(id) ?? id.slice(0, 8) : 'BYE');
  const isBot = (id: string | null) => !!id && st.bots.some((b) => b.id === id);
  let lastWaitMsg = '', playoffAsked = false, completeAsked = false, playoffChecked = false, formatChecked = false;
  /** "A & B" for a doubles side, "A" for singles. */
  const side = (a: string | null | undefined, b: string | null | undefined) => (b ? `${N(a ?? null)} & ${N(b)}` : N(a ?? null));
  let rrOrder: string[] = [];
  let finalSeen = 0;

  // hooks
  type PlanRow = { a: string; b: string; score: [number, number]; stage?: string };
  const plan: PlanRow[] = SCORE_PLAN ? JSON.parse(fs.readFileSync(path.resolve(SCORE_PLAN), 'utf8')) : [];
  if (SCORE_PLAN) log(`score plan: ${plan.length} entries from ${SCORE_PLAN}`);
  const assertFn: ((snap: any) => any) | null = ASSERT_MOD
    ? (await import(new URL('file:///' + path.resolve(ASSERT_MOD).replace(/\\/g, '/')).href)).default : null;
  if (ASSERT_MOD) log(`oracle assertions: ${ASSERT_MOD}`);
  const resolveRef = (ref: string, seedOf: Map<string, number>): string | null => {
    if (ref === 'you') return st.brian ?? null;
    const [k, n] = ref.split(':');
    if (k === 'bot') return st.bots.find((b) => b.n === Number(n))?.id ?? null;
    if (k === 'seed') return [...seedOf.entries()].find(([, s]) => s === Number(n))?.[0] ?? null;
    return null;
  };
  /** The planned score for this match as [team1, team2], or null. */
  const planned = (m: M, stage: string, seedOf: Map<string, number>): [number, number] | null => {
    if (DOUBLES) {
      if (stage !== 'group') return null;
      try { return plannedDoubles(plan as unknown as DPlanRow[], m, (ref) => resolveRef(ref, seedOf)); }
      catch (e: any) { return die(e.message); }
    }
    for (const p of plan) {
      if ((p.stage ?? 'group') !== stage) continue;
      const a = resolveRef(p.a, seedOf), b = resolveRef(p.b, seedOf);
      if (a === m.team1_player1 && b === m.team2_player1) return [p.score[0], p.score[1]];
      if (b === m.team1_player1 && a === m.team2_player1) return [p.score[1], p.score[0]];
    }
    return null;
  };
  let lastSig = '';
  const observe = async (event: string, snap: any) => {
    if (!assertFn) return;
    let res: any;
    try { res = await assertFn({ event, ...snap, players: Object.fromEntries(nm), brian: st.brian ?? null }); }
    catch (e: any) { res = { ok: false, details: 'assert threw: ' + (e?.message ?? e) }; }
    if (res && res.ok === false) {
      failures++;
      log(`ORACLE MISMATCH after ${event}: ${res.details ?? '(no details)'}`);
      log('STOPPED on the mismatch. The tournament is left as it is for inspection; `run` resumes it.');
      process.exit(1);
    }
    log(`oracle ok after ${event}${res?.details ? ': ' + res.details : ''}`);
  };

  // Live: echo each new alert Brian gets, so he can match it with the push on his phone.
  let noteSince = st.created_at;
  const phoneEcho = async () => {
    if (!st.brian) return;
    const { data } = await admin.from('notifications').select('title, body, created_at').eq('user_id', st.brian)
      .gt('created_at', noteSince).order('created_at');
    for (const n of (data ?? []) as any[]) { log(`PHONE: new alert, a push should arrive now: ${n.title} | ${n.body ?? ''}`); noteSince = n.created_at; }
  };

  for (let tick = 0; ; tick++) {
    try { await phoneEcho(); } catch { /* best effort */ }
    const c = control();
    if (c === 'stop') { log('STOP (control file). Run again to resume.'); break; }
    if (c === 'fast' && !fast) { fast = true; log('control: fast'); }
    if (c === 'slow' && fast) { fast = false; log('control: normal speed'); }
    if (c === 'pause') { if (lastWaitMsg !== 'pause') log('PAUSED (write "run" into control.txt to resume)'); lastWaitMsg = 'pause'; await sleep(3000); continue; }

    const { data: t } = await admin.from('tournaments').select(DOUBLES ? 'status, playoff_format, format, match_type' : 'status, playoff_format').eq('id', tId).single() as { data: any };
    if (!t) return die('tournament is gone');
    const { data: regs } = await admin.from('tournament_registrations').select('user_id, status, seed, role').eq('tournament_id', tId);
    const approved = (regs ?? []).filter((r: any) => r.status === 'approved').map((r: any) => r.user_id as string);
    const { data: rounds } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId).order('round_number');
    const { data: ms0 } = await admin.from('tournament_matches')
      .select('id, round_id, match_order, status, winner_team, match_type, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score, court, called_at').eq('tournament_id', tId).order('match_order');
    const ms = (ms0 ?? []) as M[];
    const roundOf = new Map((rounds ?? []).map((r: any) => [r.id, r]));
    const stageOf = (m: M) => { const rt = roundOf.get(m.round_id)?.round_type; return rt === 'finals' || rt === 'third_place_match' ? rt : 'group'; };
    // anything changed since the last look (a bot's write, Brian's write, a trigger, lock-in, playoff, completion)?
    const sig = `${t.status}|${(rounds ?? []).length}|` + ms.filter((m) => m.status === 'completed').map((m) => m.id).join(',');
    if (sig !== lastSig && ms.length) {
      const prev = lastSig; lastSig = sig;
      const event = t.status === 'completed' ? 'completion' : prev.split('|')[1] !== String((rounds ?? []).length) ? 'rounds changed' : 'score';
      // final ranks ride along once the tournament is completed (the oracle checks them)
      const ranks = t.status === 'completed'
        ? (await admin.from('tournament_final_ranks').select('*').eq('tournament_id', tId)).data ?? [] : null;
      // doubles: the only tiebreak after W and L is global PLUPR (profiles.rating), which every match moves
      const ratings = DOUBLES ? Object.fromEntries(((await admin.from('profiles').select('id, rating')
        .in('id', approved)).data ?? []).map((p: any) => [p.id, Number(p.rating)])) : undefined;
      await observe(event, { tournament: t, rounds, matches: ms, registrations: regs, ranks, ...(DOUBLES ? { ratings } : {}) });
    }

    if (t.status === 'completed') { await finish(st, nm, completeAsked); break; }

    if (ms.length === 0) {
      if (DOUBLES && !formatChecked) {
        formatChecked = true;
        check('doubles tournament is rotating_partners / doubles / playoff_format none',
          t.format === 'rotating_partners' && t.match_type === 'doubles' && t.playoff_format === 'none',
          `format ${t.format}, match_type ${t.match_type}, playoff_format ${t.playoff_format}`);
      }
      if (approved.length < N_PLAYERS) {
        const msg = `waiting: ${approved.length}/${N_PLAYERS} approved` + (st.brian && !approved.includes(st.brian) ? ' (Brian has not accepted the invite yet)' : '');
        if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg; await sleep(5000); continue;
      }
      await lockIn(st, approved); await sleep(fast ? FAST_MS : 5000); continue;
    }

    const playoffTypes = ['finals', 'third_place_match'];
    const groupIds = new Set((rounds ?? []).filter((r: any) => !playoffTypes.includes(r.round_type)).map((r: any) => r.id));
    const real = ms.filter((m) => m.team1_player1 && m.team2_player1);
    const pending = real.filter((m) => m.status !== 'completed');
    const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));

    // 0. playoff checks, once, as soon as the playoff rounds exist and BEFORE anyone scores them
    //    (rehearsal 1 scored the Final first and so never ran these)
    if (!playoffChecked && (rounds ?? []).some((r: any) => playoffTypes.includes(r.round_type))) {
      playoffChecked = true;
      const groupMatches = ms.filter((m) => groupIds.has(m.round_id));
      const table = standings(groupMatches, approved, seedOf).map((e) => e.key);
      rrOrder = table;
      const fin = real.filter((m) => roundOf.get(m.round_id)?.round_type === 'finals');
      const third = real.filter((m) => roundOf.get(m.round_id)?.round_type === 'third_place_match');
      const pair = (m?: M) => (m ? [m.team1_player1, m.team2_player1].sort().join('|') : '');
      check('playoff has exactly one Final and one Third Place Match', fin.length === 1 && third.length === 1, `final ${fin.length}, third ${third.length}`);
      check('Final = round-robin 1st v 2nd', pair(fin[0]) === [table[0], table[1]].sort().join('|'),
        `final ${N(fin[0]?.team1_player1 ?? null)} v ${N(fin[0]?.team2_player1 ?? null)}; standings 1-2 ${N(table[0])}, ${N(table[1])}`);
      check('Third Place Match = round-robin 3rd v 4th', pair(third[0]) === [table[2], table[3]].sort().join('|'),
        `3PM ${N(third[0]?.team1_player1 ?? null)} v ${N(third[0]?.team2_player1 ?? null)}; standings 3-4 ${N(table[2])}, ${N(table[3])}`);
      check('no playoff match is already scored when the checks run', !fin.concat(third).some((m) => m.status === 'completed'));
    }

    // 1. a bot match to score
    // doubles: only a match whose FOUR players are bots is scored by a bot; any match with Brian waits for him
    // PKL-039: with courts, a bot scores only a match the server has called to a court
    const botMatch = DOUBLES ? pending.find((m) => four(m).length === 4 && four(m).every(isBot) && (!COURTS || !!m.called_at))
      : pending.find((m) => isBot(m.team1_player1) && isBot(m.team2_player1));
    if (botMatch) {
      const reporter = DOUBLES ? four(botMatch)[Math.floor(Math.random() * 4)]
        : Math.random() < 0.5 ? botMatch.team1_player1! : botMatch.team2_player1!;
      const [w, l] = randomScore(); const coin = Math.random() < 0.5;
      const p = planned(botMatch, stageOf(botMatch), seedOf);
      const s1 = p ? p[0] : coin ? w : l, s2 = p ? p[1] : coin ? l : w;
      const t1 = s1 > s2;
      if (p && !validScore(s1, s2)) die(`score plan has an invalid score ${s1}-${s2} for ${side(botMatch.team1_player1, botMatch.team1_player2)} v ${side(botMatch.team2_player1, botMatch.team2_player2)}`);
      const bc = await asBot(st, reporter);
      // exactly what MatchEntryScreen writes for a single-game tournament match (singles or doubles: the bots have a
      // gender, so no per-match override is picked and all four override columns are null)
      const { data: upd, error } = await bc.from('tournament_matches').update({
        team1_score: s1, team2_score: s2, game_scores: null, winner_team: t1 ? 'team1' : 'team2', status: 'completed',
        team1_player1_gender_override: null, team1_player2_gender_override: null,
        team2_player1_gender_override: null, team2_player2_gender_override: null,
      }).eq('id', botMatch.id).select('id');
      const label = roundOf.get(botMatch.round_id)?.label ?? '?';
      if (error || !upd?.length) log(`SCORE ERROR ${label} #${botMatch.match_order}: ${error?.message ?? 'no row updated (RLS?)'}`);
      else log(`SCORE ${label} #${botMatch.match_order}: ${side(botMatch.team1_player1, botMatch.team1_player2)} ${s1}-${s2} ${side(botMatch.team2_player1, botMatch.team2_player2)}  (entered by ${N(reporter)})  [${real.length - pending.length + 1}/${real.length} done]`);
      lastWaitMsg = '';
      await sleep(fast ? FAST_MS : intervalMs);
      continue;
    }

    // 2. only Brian's matches are left in this stage
    if (pending.length && DOUBLES) {
      const me = st.brian;
      const brianPending = pending.filter((m) => !!me && four(m).includes(me));
      if (!brianPending.length) {
        const msg = `waiting: ${pending.length} match(es) left, none called to a court and none of yours (check the queue)`;
        if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg; await sleep(5000); continue;
      }
      const yours = brianPending.map((m) => {
        const where = !COURTS ? '' : m.called_at ? `  ON COURT ${m.court} NOW` : '  (waiting for a court; not callable yet)';
        const p = planned(m, stageOf(m), seedOf);
        const mine = me && (m.team1_player1 === me || m.team1_player2 === me) ? 1 : 2;
        const partner = mine === 1 ? (m.team1_player1 === me ? m.team1_player2 : m.team1_player1) : (m.team2_player1 === me ? m.team2_player2 : m.team2_player1);
        const opp = mine === 1 ? side(m.team2_player1, m.team2_player2) : side(m.team1_player1, m.team1_player2);
        return `#${m.match_order}: you + partner ${N(partner ?? null)} v ${opp}${where}` +
          (p ? `  -> ENTER team ${side(m.team1_player1, m.team1_player2)} ${p[0]}, team ${side(m.team2_player1, m.team2_player2)} ${p[1]} (score plan)` : ''); }).join(' ; ');
      const msg = `WAITING FOR YOU (enter on your phone): ${yours}`;
      if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg;
      await sleep(5000); continue;
    }
    if (pending.length) {
      const yours = pending.map((m) => { const p = planned(m, stageOf(m), seedOf);
        return `${roundOf.get(m.round_id)?.label ?? '?'} #${m.match_order}: ${N(m.team1_player1)} v ${N(m.team2_player1)}` +
          (p ? `  -> ENTER ${N(m.team1_player1)} ${p[0]}, ${N(m.team2_player1)} ${p[1]} (score plan)` : ''); }).join(' ; ');
      const msg = `WAITING FOR YOU (enter on your phone): ${yours}`;
      if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg;
      await sleep(5000); continue;
    }

    // 3. group play done: the host generates the playoff (the app's admin button)
    const playoffRounds = (rounds ?? []).filter((r: any) => playoffTypes.includes(r.round_type));
    if (playoffRounds.length === 0 && !DOUBLES) {
      const groupMatches = ms.filter((m) => groupIds.has(m.round_id));
      const table = standings(groupMatches, approved, seedOf);
      if (!playoffAsked) check('tournament is still active after the last round-robin match (no early auto-close)', t.status === 'active', `status ${t.status}`);
      log('ROUND ROBIN DONE. Standings (app comparator):\n' + table.map((e, i) =>
        `    ${i + 1}. ${N(e.key).padEnd(22)} ${e.wins}-${e.losses}  pts ${e.pf}-${e.pa} (${e.pf - e.pa >= 0 ? '+' : ''}${e.pf - e.pa})  seed ${e.seed}`).join('\n'));
      if (playoffAsked) { await sleep(5000); continue; }
      // give a server trigger the chance to do it first
      await sleep(fast ? 3000 : 15000);
      const { data: again } = await admin.from('tournament_rounds').select('id').eq('tournament_id', tId).in('round_type', playoffTypes);
      if (again?.length) { log('playoff rounds appeared on their own (server trigger)'); continue; }
      const hc = await asBot(st, st.bots[0].id);
      const { error } = await hc.rpc('generate_playoff_bracket', { p_tournament_id: tId });
      playoffAsked = true;
      if (error) log('PLAYOFF ERROR generate_playoff_bracket: ' + error.message);
      else log(`PLAYOFF generated by host ${st.bots[0].name} (the app's "Generate playoff" button)`);
      continue;
    }

    // 5. everything scored, still active: let a trigger complete it, else the host completes it (admin button)
    if (!completeAsked) {
      finalSeen++;
      if (finalSeen < (fast ? 2 : 4)) { log('all matches done; waiting for the tournament to complete itself'); await sleep(fast ? 3000 : 15000); continue; }
      completeAsked = true;
      if (DOUBLES) check('tournament auto-completed after the last match (rotating_partners, playoff none)', false, `status ${t.status} after all ${real.length} matches`);
      log('tournament did NOT complete on its own after the last match; host calls admin_complete_tournament (the app\'s "Complete tournament" button)');
      const hc = await asBot(st, st.bots[0].id);
      const { error } = await hc.rpc('admin_complete_tournament', { p_tournament_id: tId });
      if (error) log('COMPLETE ERROR: ' + error.message);
      continue;
    }
    await sleep(5000);
  }
  log(`=== run ended; ${failures} check failure(s) ===`);
  process.exitCode = failures ? 1 : 0;
}

/** Doubles completion checks: auto-close, ranks 1..10 dense, and the oracle's expected ranks (ties: any order). */
async function finishDoubles(st: State, nm: Map<string, string>, completeAsked: boolean) {
  const tId = st.tournament_id!;
  const N = (id: string) => nm.get(id) ?? id.slice(0, 8);
  const { data: ranks } = await admin.from('tournament_final_ranks').select('*').eq('tournament_id', tId).order('final_rank');
  const { data: rounds } = await admin.from('tournament_rounds').select('id, round_type').eq('tournament_id', tId);
  const { data: full } = await admin.from('tournament_matches')
    .select('id, round_id, match_order, status, winner_team, game_scores, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score').eq('tournament_id', tId);
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed, status').eq('tournament_id', tId);
  const players = (regs ?? []).filter((r: any) => r.status === 'approved').sort((a: any, b: any) => (a.seed ?? 999) - (b.seed ?? 999)).map((r: any) => r.user_id as string);
  const { data: profs } = await admin.from('profiles').select('id, rating').in('id', players);
  const ratings = Object.fromEntries((profs ?? []).map((p: any) => [p.id, Number(p.rating)]));
  log('COMPLETED. Final ranks:\n' + (ranks ?? []).map((r: any) => `    ${r.final_rank}. ${N(r.user_id).padEnd(22)} ${r.wins ?? '?'}-${r.losses ?? '?'}  PLUPR ${ratings[r.user_id] ?? '?'}`).join('\n'));
  check('tournament auto-completed after the last match (no admin "Complete tournament")', !completeAsked);
  const rk = (ranks ?? []).map((r: any) => r.final_rank).sort((a: number, b: number) => a - b);
  check(`${N_PLAYERS} final ranks stored, 1..${N_PLAYERS} with no gaps`, rk.length === N_PLAYERS && rk.every((r: number, i: number) => r === i + 1), `got ${rk.join(',')}`);
  check('no playoff rounds on a rotating tournament', !(rounds ?? []).some((r: any) => ['finals', 'third_place_match'].includes(r.round_type)));
  const oracleFile = path.join(repo, 'state', 'pkl-034', 'oracle.mjs');
  if (!fs.existsSync(oracleFile)) { log(`oracle.mjs not found (${oracleFile}); final-rank order not checked`); }
  else {
    const o = await import(new URL('file:///' + oracleFile.replace(/\\/g, '/')).href);
    const typeOf = new Map((rounds ?? []).map((r: any) => [r.id, r.round_type]));
    const results = ((full ?? []) as any[]).filter((m) => m.status === 'completed').map((m) => o.doublesResultFromRow(m, typeOf.get(m.round_id)));
    const expected = o.finalRanksDoubles(players, results, { ratings });
    const problems: string[] = o.compareFinalRanks(expected, ranks ?? []);
    const named = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => N(id));
    check('final ranks = per-player standings (wins, fewer losses, head-to-head, point diff, PLUPR; ties in any order)', problems.length === 0, named(problems.join('; ')));
    if (expected.tieGroups?.length) log('ties the code leaves to chance: ' + expected.tieGroups.map((g: any) => `ranks ${g.ranks[0]}-${g.ranks[1]}: ${g.players.map(N).join(', ')}`).join(' ; '));
  }
  if (st.brian) {
    const { data: notes } = await admin.from('notifications').select('type, title, created_at').eq('user_id', st.brian)
      .gte('created_at', st.created_at).order('created_at');
    log(`Brian's notification rows since setup (${notes?.length ?? 0}):\n` + (notes ?? []).map((n: any) =>
      `    ${new Date(n.created_at).toLocaleTimeString('en-US', { hour12: false })}  ${n.type.padEnd(24)} ${n.title}`).join('\n'));
  }
  try { await auditDoubles(st, tId, players); }
  catch (e: any) { check('PKL-043 audit ran', false, 'audit threw: ' + (e?.message ?? e)); }
}

/**
 * PKL-043 audit of what a player is told and paid, from the database, after the tournament completes.
 *   A. in-app alerts: one "your first match" each; per score the 3 others get "you won/lost a-b, Entered by X";
 *      the next match named in "Up next" is the right one; one final-placement alert each, with its pay
 *   B. push: every alert row has a push_outbox row; Brian's are sent (waits up to 2 min for the queue)
 *   C. league W-L = the match results; league PLUPR moves +-delta per match, overall by the weight
 *   D. Court Pass XP: every paid tournament match pays pickles and earns floor(pay x 0.5) XP
 *   E. courts (PKL-039): every match called before it was scored, no court or player double-booked, and each
 *      later call sent "You're on Court N" to its 4 players
 *   F. byes (PKL-049): one "Bye this round" per run of byes after round 1, naming the next match
 * Texts: migration_tournament_play_notices.sql + migration_tournament_courts_byes.sql (_pl_tm_*).
 */
async function auditDoubles(st: State, tId: string, players: string[]) {
  log('=== PKL-043 audit: alerts, pushes, W-L / PLUPR, Court Pass XP ===');
  const { data: profs } = await admin.from('profiles').select('id, full_name').in('id', players);
  const fullName = new Map((profs ?? []).map((p: any) => [p.id, (p.full_name ?? '').trim() || 'a player']));
  const N = (id: string) => fullName.get(id) ?? id.slice(0, 8);
  const { data: t } = await admin.from('tournaments').select('name, league_id, courts').eq('id', tId).single() as { data: any };
  const tName = t.name as string;
  const courtsOn = ((t.courts ?? []) as string[]).some((c) => c.trim() !== '');
  const { data: ms0 } = await admin.from('tournament_matches')
    .select('id, match_order, status, winner_team, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score, completed_at, play_round, court, called_at, plupr_delta, plupr_global_weight, plupr_category, plupr_ratings, plupr_applied_at')
    .eq('tournament_id', tId).order('match_order');
  const ms = ((ms0 ?? []) as any[]).filter((m) => m.status === 'completed');
  const byOrder = [...ms].sort((a, b) => a.match_order - b.match_order);
  const byDone = [...ms].sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
  const mineOf = (p: string) => byOrder.filter((m) => four(m).includes(p));
  const onT1 = (m: any, p: string) => p === m.team1_player1 || p === m.team1_player2;
  const sideTxt = (a: string | null, b: string | null, viewer: string) =>
    [a, b].filter((x): x is string => !!x).sort((x, y) => Number(y === viewer) - Number(x === viewer))
      .map((u) => (u === viewer ? 'You' : N(u))).join(' & ');
  const line = (m: any, v: string) => onT1(m, v) || !(v === m.team2_player1 || v === m.team2_player2)
    ? `${sideTxt(m.team1_player1, m.team1_player2, v)} vs ${sideTxt(m.team2_player1, m.team2_player2, v)}`
    : `${sideTxt(m.team2_player1, m.team2_player2, v)} vs ${sideTxt(m.team1_player1, m.team1_player2, v)}`;
  // PKL-039 / PKL-049: the texts name the round, the byes before it and the court, as they stood at time T.
  const ts = (s: string | null) => (s ? Date.parse(s) : NaN);
  const openAt = (x: any, T: number) => !(ts(x.completed_at) <= T);
  const calledAt = (x: any, T: number) => !!x.called_at && ts(x.called_at) <= T;
  const lastRound = Math.max(0, ...ms.map((m) => m.play_round ?? 0));
  const byesOf = (p: string) => {
    const played = new Set(mineOf(p).map((m) => m.play_round));
    return Array.from({ length: lastRound }, (_, i) => i + 1).filter((r) => !played.has(r));
  };
  const rText = (rs: number[]) => (rs.length === 1 ? `round ${rs[0]}` : `rounds ${rs.slice(0, -1).join(', ')} and ${rs[rs.length - 1]}`);
  const byesBefore = (p: string, x: any) => {
    const r = x.play_round; if (r == null) return [] as number[];
    const prev = Math.max(0, ...mineOf(p).map((m) => m.play_round).filter((y: number) => y < r));
    return byesOf(p).filter((b) => b > prev && b < r);
  };
  const cLabel = (c: string) => (/^[0-9]+$/.test(c.trim()) ? `Court ${c.trim()}` : c.trim());
  const courtTxt = (x: any, T: number) => (!courtsOn ? '' : calledAt(x, T) ? ` You're on ${cLabel(x.court)} now.` : ' We\'ll push you when a court is free.');
  /** The player's next match at time T: one called to a court first, else the earliest open. */
  const nextAt = (p: string, T: number) => {
    const list = mineOf(p); const open = list.filter((x) => openAt(x, T));
    const x = open.find((y) => calledAt(y, T)) ?? open[0];
    return x ? { x, k: list.indexOf(x) + 1, n: list.length } : null;
  };
  const upNextAt = (p: string, T: number) => {
    const nx = nextAt(p, T); if (!nx) return null;
    const bb = byesBefore(p, nx.x);
    const rt = nx.x.play_round == null ? '' : ` (round ${nx.x.play_round}${bb.length ? `, after your ${bb.length > 1 ? 'byes' : 'bye'} in ${rText(bb)}` : ''})`;
    return `Up next${rt}: ${line(nx.x, p)} (your match ${nx.k} of ${nx.n}).${courtTxt(nx.x, T)}`;
  };
  /** The "Up next" text a player should get once match m is in, or null when they have nothing open. */
  const upNext = (m: any, p: string) => upNextAt(p, ts(m.completed_at));

  const { data: notes0 } = await admin.from('notifications').select('id, user_id, title, body, push_data, created_at')
    .eq('entity_id', tId).eq('type', 'tournament').gte('created_at', st.created_at).order('created_at');
  const notes = (notes0 ?? []) as any[];
  const kindOf = (n: any) => n.push_data?.kind ?? '';
  const { data: pay0 } = await admin.from('tournament_match_bonus_grants').select('match_id, user_id, paid').in('match_id', ms.map((m) => m.id));
  const payOf = new Map((pay0 ?? []).map((g: any) => [`${g.match_id}|${g.user_id}`, Number(g.paid)]));
  const payTxt = (n: number | undefined) => (n && n > 0 ? `+${n} 🥒 for the match.` : null);
  const bad: string[] = [];

  // A1. "your first match", once each
  for (const p of players) {
    const first = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_ready');
    const T = first[0] ? ts(first[0].created_at) : 0;
    const nx = nextAt(p, T);
    if (!nx) { bad.push(`${N(p)}: no matches`); continue; }
    const bb = byesBefore(p, nx.x);
    const title = calledAt(nx.x, T) ? `🏓 ${tName} is on: you're on ${cLabel(nx.x.court)}` : `🏓 ${tName} is on: your first match`;
    const want = `${bb.length ? `Bye in ${rText(bb)}: you sit out first. ` : ''}${line(nx.x, p)} (your match ${nx.k} of ${nx.n}${nx.x.play_round != null ? `, round ${nx.x.play_round}` : ''}).`
      + `${courtTxt(nx.x, T)} Open the tournament to play.`;
    if (first.length !== 1 || first[0].title !== title || first[0].body !== want)
      bad.push(`${N(p)}: first-match alert x${first.length}${first[0] ? ` "${first[0].title} | ${first[0].body}"` : ''}, want "${title} | ${want}"`);
  }
  check('A1 every player gets one first-match alert: the right match, round, court, and "Bye in round 1" when they sit out first',
    bad.length === 0, bad.slice(0, 4).join(' ; '));

  // A2 + A3. score alerts and "Up next"
  const bad2: string[] = [], bad3: string[] = [];
  let reporterUnknown = 0;
  for (const m of ms) {
    const ns = notes.filter((n) => kindOf(n) === 'tm_score' && n.title.includes(tName) && four(m).includes(n.user_id)
      && (n.body ?? '').startsWith(line(m, n.user_id) + ', '));
    const entered = ns.map((n) => /Entered by (.+?)\./.exec(n.body ?? '')?.[1]).filter(Boolean);
    const reporterName = entered[0];
    const reporter = four(m).find((p) => N(p) === reporterName) ?? null;
    if (!reporter) reporterUnknown++;
    for (const p of four(m)) {
      const won = onT1(m, p) === (m.winner_team === 'team1');
      const a = onT1(m, p) ? m.team1_score : m.team2_score, b = onT1(m, p) ? m.team2_score : m.team1_score;
      const next = upNext(m, p), pay = payTxt(payOf.get(`${m.id}|${p}`));
      const tag = `#${m.match_order} ${N(p)}`;
      if (p === reporter) {
        const mine = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_score'
          && (n.title === `🏓 Up next in ${tName}` || n.title === `✅ Score saved in ${tName}`)
          && Math.abs(Date.parse(n.created_at) - Date.parse(m.completed_at)) < 1500);
        const want = [pay, next].filter(Boolean).join(' ');
        if (!want) continue;
        if (!mine.some((n) => n.body === want)) bad2.push(`${tag} (entered it): want "${want}"`);
        continue;
      }
      const title = won ? `✅ ${tName}: you won ${a}-${b}` : `📝 ${tName}: you lost ${a}-${b}`;
      const hit = ns.filter((n) => n.user_id === p);
      if (hit.length !== 1) { bad2.push(`${tag}: ${hit.length} score alerts`); continue; }
      if (hit[0].title !== title) bad2.push(`${tag}: title "${hit[0].title}", want "${title}"`);
      const want = [`${line(m, p)}, ${a}-${b}.`, reporterName ? `Entered by ${reporterName}.` : null, pay, next].filter(Boolean).join(' ');
      if (hit[0].body !== want) (next && !(hit[0].body ?? '').includes(next) ? bad3 : bad2).push(`${tag}: "${hit[0].body}" want "${want}"`);
    }
  }
  check('A2 each score: the 3 others get "you won/lost a-b, Entered by", match pay; the one who entered it gets pay + Up next',
    bad2.length === 0 && reporterUnknown === 0, `${reporterUnknown ? `${reporterUnknown} match(es) with no "Entered by"; ` : ''}${bad2.slice(0, 4).join(' ; ')}`);
  check('A3 "Up next" names each player\'s next open match (partner, opponents, "match k of 8")', bad3.length === 0, bad3.slice(0, 4).join(' ; '));

  // A4. final placement
  const { data: ranks } = await admin.from('tournament_final_ranks').select('user_id, final_rank').eq('tournament_id', tId);
  const { data: pp } = await admin.from('tournament_placement_grants').select('user_id, paid').eq('tournament_id', tId);
  const placePay = new Map((pp ?? []).map((g: any) => [g.user_id, Number(g.paid)]));
  const ord = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  const bad4: string[] = [];
  for (const r of (ranks ?? []) as any[]) {
    const k = r.final_rank as number, p = r.user_id as string;
    const title = k === 1 ? `🥇 You won ${tName}!` : k === 2 ? `🥈 2nd place in ${tName}` : k === 3 ? `🥉 3rd place in ${tName}` : `🏁 ${tName}: you finished ${ord(k)}`;
    const pay = placePay.get(p);
    const body = [`Final placement: ${ord(k)} of ${(ranks ?? []).length}.`, pay && pay > 0 ? `+${pay} 🥒 placement pay.` : null, 'Open the tournament for the final table.'].filter(Boolean).join(' ');
    const hit = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_finished');
    if (hit.length !== 1 || hit[0].title !== title || hit[0].body !== body) bad4.push(`${N(p)}: x${hit.length} "${hit[0]?.title ?? ''} | ${hit[0]?.body ?? ''}" want "${title} | ${body}"`);
  }
  check('A4 one final-placement alert each, with the right place and placement pay', bad4.length === 0 && (ranks ?? []).length === players.length, bad4.slice(0, 3).join(' ; '));
  const extra = notes.filter((n) => !['tm_ready', 'tm_score', 'tm_finished', 'tm_court', 'tm_bye'].includes(kindOf(n)));
  if (extra.length) log(`info: ${extra.length} other tournament alert(s): ${[...new Set(extra.map((n) => kindOf(n) || n.title))].join(', ')}`);

  // B. push queue
  const ids = notes.map((n) => n.id);
  const outbox = async () => {
    const rows: any[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await admin.from('push_outbox').select('notification_id, recipient_id, status, error').in('notification_id', ids.slice(i, i + 100));
      rows.push(...(data ?? []));
    }
    return rows;
  };
  let ob = await outbox();
  for (let w = 0; st.brian && w < 24 && ob.some((o) => o.recipient_id === st.brian && ['pending', 'sending'].includes(o.status)); w++) { await sleep(5000); ob = await outbox(); }
  const missing = ids.length - ob.length;
  check(`B1 every alert (${ids.length}) has a push queued`, missing === 0, `${missing} alert(s) with no push_outbox row`);
  if (st.brian) {
    const mine = ob.filter((o) => o.recipient_id === st.brian);
    const notSent = mine.filter((o) => o.status !== 'sent');
    check(`B2 all ${mine.length} of your pushes were sent`, mine.length > 0 && notSent.length === 0,
      notSent.slice(0, 3).map((o) => `${o.status}${o.error ? ': ' + o.error : ''}`).join(' ; '));
    log('B3 (by eye) your phone should show the same pushes as your in-app alerts list.');
  }
  const bs = ob.filter((o) => o.recipient_id !== st.brian).reduce((acc: any, o) => { acc[o.status] = (acc[o.status] ?? 0) + 1; return acc; }, {});
  log(`info: bot push rows by status (bots have no phone): ${JSON.stringify(bs)}`);

  // C. W-L and PLUPR
  const badC: string[] = [];
  const last = new Map<string, number>();
  const wl = new Map(players.map((p) => [p, { w: 0, l: 0 }]));
  for (const m of byDone) {
    const r = m.plupr_ratings ?? {}, d = Number(m.plupr_delta), wgt = Number(m.plupr_global_weight ?? 0.5);
    if (!m.plupr_applied_at) { badC.push(`#${m.match_order}: no PLUPR applied (category ${m.plupr_category})`); continue; }
    for (const p of four(m)) {
      const e = r[p]; const sgn = onT1(m, p) ? 1 : -1; const won = onT1(m, p) === (m.winner_team === 'team1');
      wl.get(p)![won ? 'w' : 'l']++;
      if (!e) { badC.push(`#${m.match_order} ${N(p)}: no PLUPR entry`); continue; }
      if (e.won !== won) badC.push(`#${m.match_order} ${N(p)}: recorded won=${e.won}, result ${won}`);
      const ld = Number(e.lafter) - Number(e.lbefore), gd = Number(e.after) - Number(e.before);
      if (Math.abs(ld - sgn * d) > 0.0015 && Number(e.lafter) > 2.0005) badC.push(`#${m.match_order} ${N(p)}: league PLUPR moved ${ld.toFixed(3)}, want ${(sgn * d).toFixed(3)}`);
      if (Math.abs(gd - sgn * d * wgt) > 0.0015 && Number(e.after) > 2.0005) badC.push(`#${m.match_order} ${N(p)}: overall PLUPR moved ${gd.toFixed(3)}, want ${(sgn * d * wgt).toFixed(3)}`);
      if (last.has(p) && Math.abs(last.get(p)! - Number(e.lbefore)) > 0.0015) badC.push(`#${m.match_order} ${N(p)}: league PLUPR started at ${e.lbefore}, previous match ended ${last.get(p)}`);
      last.set(p, Number(e.lafter));
    }
  }
  check('C1 each match moves league PLUPR +-delta (team 1 +, team 2 -) and overall PLUPR by the weight, in a chain', badC.length === 0, badC.slice(0, 4).join(' ; '));
  if (t.league_id) {
    const { data: lpr } = await admin.from('league_player_ratings').select('user_id, wins, losses, rating').eq('league_id', t.league_id).in('user_id', players);
    const got = new Map((lpr ?? []).map((x: any) => [x.user_id, x]));
    const badW = players.filter((p) => { const g = got.get(p), w = wl.get(p)!; return !g || g.wins !== w.w || g.losses !== w.l; })
      .map((p) => `${N(p)} ${got.get(p)?.wins ?? '-'}-${got.get(p)?.losses ?? '-'}, results ${wl.get(p)!.w}-${wl.get(p)!.l}`);
    check('C2 league W-L = match results (PKL-048)', badW.length === 0, badW.slice(0, 4).join(' ; '));
    const badR = players.filter((p) => last.has(p) && Math.abs(Number(got.get(p)?.rating) - last.get(p)!) > 0.0015).map((p) => `${N(p)} ${got.get(p)?.rating} vs ${last.get(p)}`);
    check('C3 league PLUPR in the table = after the last match', badR.length === 0, badR.slice(0, 4).join(' ; '));
  } else log('C2/C3 skipped: the tournament has no league');

  // D. Court Pass XP from match pay
  const { data: cyc } = await admin.from('reward_track_cycles').select('id, starts_at, ends_at');
  const now = new Date().toISOString();
  const live = (cyc ?? []).filter((c: any) => (!c.starts_at || c.starts_at <= now) && (!c.ends_at || c.ends_at > now));
  const paid = (pay0 ?? []).filter((g: any) => Number(g.paid) > 0);
  const { data: led } = await admin.from('pickle_ledger').select('id, profile_id, delta, created_at')
    .eq('source', '_grant_tournament_match_bonus').in('profile_id', players).gte('created_at', st.created_at);
  const badD: string[] = [];
  for (const p of players) {
    const want = paid.filter((g: any) => g.user_id === p).map((g: any) => Number(g.paid)).sort((a, b) => a - b).join(',');
    const have = (led ?? []).filter((l: any) => l.profile_id === p).map((l: any) => Number(l.delta)).sort((a, b) => a - b).join(',');
    if (want !== have) badD.push(`${N(p)}: match pay [${want}], ledger [${have}]`);
  }
  check('D1 every paid tournament match is in the pickles ledger', badD.length === 0, badD.slice(0, 3).join(' ; '));
  if (!live.length) check('D2 Court Pass XP from match pay', false, 'no Court Pass cycle is running now');
  else {
    const refs = (led ?? []).map((l: any) => String(l.id));
    const { data: xe } = refs.length ? await admin.from('reward_track_xp_events').select('profile_id, source_ref, xp, pickles').eq('source', 'ledger').in('source_ref', refs) : { data: [] as any[] };
    const xpOf = new Map((xe ?? []).map((x: any) => [x.source_ref, x]));
    // Test accounts never earn Court Pass XP (by design: _pl_track_add_xp skips them). Every @pickleague.test
    // account is marked one at sign-up (trg_profiles_test_account_2_mark), so the bots earn none; real players
    // (Brian in the live run) must earn floor(pay x 0.5).
    const { data: tp } = await admin.from('profiles').select('id, is_test_account').in('id', players);
    const isTest = new Set((tp ?? []).filter((p: any) => p.is_test_account).map((p: any) => p.id));
    const realLed = (led ?? []).filter((l: any) => !isTest.has(l.profile_id));
    const testLed = (led ?? []).filter((l: any) => isTest.has(l.profile_id));
    const badT = testLed.filter((l: any) => Number(xpOf.get(String(l.id))?.xp ?? 0) > 0).map((l: any) => `${N(l.profile_id)} +${l.delta}: ${xpOf.get(String(l.id)).xp} XP`);
    check(`D2a test accounts earn no Court Pass XP (${testLed.length} payments, ${isTest.size} test players)`, badT.length === 0, badT.slice(0, 3).join(' ; '));
    const badX = realLed.filter((l: any) => { const x = xpOf.get(String(l.id)); return !x || (x.xp !== Math.floor(Number(l.delta) * 0.5) && x.xp !== 0); })
      .map((l: any) => `${N(l.profile_id)} +${l.delta} pickles: ${xpOf.get(String(l.id)) ? `${xpOf.get(String(l.id)).xp} XP` : 'no XP row'}`);
    const capped = (xe ?? []).filter((x: any) => x.xp === 0 && Number(x.pickles) > 1).length;
    if (!realLed.length) log('D2 skipped: every player is a test account (no XP by design); the live run checks Brian');
    else check(`D2 each real player's match pay earns Court Pass XP = floor(pay x 0.5) (${realLed.length} payments)`, badX.length === 0, (badX.length ? `${badX.length} missing: ` : '') + badX.slice(0, 3).join(' ; '));
    // Diagnosis: the ledger trigger swallows any XP error as a server warning the client never sees. Replay each
    // missing real-player earn straight through _pl_track_add_xp (no error handler) so a real error shows here.
    // Idempotent. "added N" (N > 0) = the first try failed transiently and the player now has the XP owed;
    // "added 0" = _pl_track_add_xp skipped it on purpose (test/guest/deleted account, no cycle, or already counted).
    const missing = realLed.filter((l: any) => !xpOf.get(String(l.id)));
    if (missing.length && CMD === 'audit') log(`audit is read-only: ${missing.length} missing XP earn(s) not replayed`);
    else if (missing.length) {
      const { data: full } = await admin.from('pickle_ledger').select('id, created_at, is_bonus, reason').in('id', missing.map((l: any) => l.id));
      const fOf = new Map((full ?? []).map((f: any) => [String(f.id), f]));
      for (const l of missing) {
        const f: any = fOf.get(String(l.id)) ?? {};
        const { data: added, error } = await admin.rpc('_pl_track_add_xp', {
          p_profile: l.profile_id, p_at: l.created_at, p_source: 'ledger', p_source_ref: String(l.id),
          p_xp: Math.floor(Number(l.delta) * 0.5), p_pickles: Number(l.delta),
        });
        log(`D2 diag: ${N(l.profile_id)} ledger ${l.id} +${l.delta} at ${l.created_at} gold=${f.is_bonus} "${f.reason ?? ''}" -> replay ${error ? `ERROR ${error.code ?? ''} ${error.message}` : Number(added) > 0 ? `added ${added} XP (the first try failed transiently)` : 'added 0 XP (skipped on purpose: test/guest account, no cycle, or already counted)'}`);
      }
    }
    if (capped) log(`info: ${capped} payment(s) earned 0 XP (Court Pass daily cap)`);
  }

  // E. courts (PKL-039)
  if (!courtsOn) log('E skipped: no courts reserved (players pick any court, as before)');
  else {
    const badE: string[] = [];
    const notCalled = ms.filter((m) => !m.called_at);
    if (notCalled.length) badE.push(`${notCalled.length} match(es) scored without being called: #${notCalled.map((m) => m.match_order).join(', #')}`);
    const called = ms.filter((m) => m.called_at);
    for (const m of called) if (ts(m.called_at) > ts(m.completed_at)) badE.push(`#${m.match_order} completed before it was called`);
    for (let i = 0; i < called.length; i++) for (let j = i + 1; j < called.length; j++) {
      const a = called[i], b = called[j];
      const overlap = ts(a.called_at) < ts(b.completed_at) && ts(b.called_at) < ts(a.completed_at);
      if (!overlap) continue;
      if (a.court === b.court) badE.push(`#${a.match_order} and #${b.match_order} on ${cLabel(a.court)} at once`);
      const both = four(a).filter((p) => four(b).includes(p));
      if (both.length) badE.push(`${both.map(N).join(' & ')} on two courts at once (#${a.match_order}, #${b.match_order})`);
    }
    check('E1 every match was called to a court before it was scored; no court or player double-booked', badE.length === 0, badE.slice(0, 4).join(' ; '));

    // Lock-in calls quietly (the first-match alert says the court); later calls send "You're on Court N".
    const firstCall = Math.min(...called.map((m) => ts(m.called_at)));
    const badE2: string[] = [];
    for (const m of called.filter((x) => ts(x.called_at) - firstCall > 1000)) {
      for (const p of four(m)) {
        const hit = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_court' && (n.body ?? '').startsWith(line(m, p) + '.'));
        const want = `${line(m, p)}. Head to ${cLabel(m.court)} now.`;
        if (hit.length !== 1 || hit[0].title !== `🏓 You're on ${cLabel(m.court)} in ${tName}` || hit[0].body !== want)
          badE2.push(`#${m.match_order} ${N(p)}: x${hit.length}${hit[0] ? ` "${hit[0].title} | ${hit[0].body}"` : ''}`);
      }
    }
    check('E2 each later call sends its 4 players "You\'re on Court N" naming the match', badE2.length === 0, badE2.slice(0, 4).join(' ; '));
  }

  // F. bye alerts (PKL-049): one "Bye this round" per run of byes after round 1, naming the next match.
  // PKL-043 (live run 75390a): the court queue can play a round before the round ahead of it finishes.
  // The alert goes out when round r-1 finishes, and only if round r still has a match to play then;
  // a round already over gets no alert (stale).
  const doneAt = new Map<number, number>();
  for (const m of ms) if (m.play_round != null) doneAt.set(m.play_round, Math.max(doneAt.get(m.play_round) ?? 0, ts(m.completed_at)));
  const stillOn = (r: number) => (doneAt.get(r) ?? 0) > (doneAt.get(r - 1) ?? Infinity);
  const badF: string[] = [];
  for (const p of players) {
    const byes = byesOf(p);
    const runs: number[][] = [];
    for (const b of byes) { const last = runs[runs.length - 1]; if (last && last[last.length - 1] === b - 1) last.push(b); else runs.push([b]); }
    const want = runs.filter((r) => r[0] >= 2 && stillOn(r[0]));
    const got = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_bye');
    if (got.length !== want.length) { badF.push(`${N(p)}: ${got.length} bye alert(s), want ${want.length} (byes ${byes.join(',') || 'none'})`); continue; }
    for (const run of want) {
      const n = got.find((g) => (g.body ?? '').startsWith(`You sit out ${rText(run)}. `));
      if (!n) { badF.push(`${N(p)}: no alert for ${rText(run)}`); continue; }
      if (ts(n.created_at) > (doneAt.get(run[0]) ?? Infinity)) badF.push(`${N(p)}: alert for ${rText(run)} came after round ${run[0]} was over`);
      const body = `You sit out ${rText(run)}. ${upNextAt(p, ts(n.created_at)) ?? 'Your matches are done; the final table comes when the last round is scored.'}`;
      if (n.title !== `🪑 Bye this round in ${tName}` || n.body !== body) badF.push(`${N(p)}: "${n.title} | ${n.body}" want "${body}"`);
    }
  }
  check('F1 "Bye this round" alert for each bye after round 1 that is still to play, naming the next match (round, court)', badF.length === 0, badF.slice(0, 4).join(' ; '));
  if (st.brian) log(`info: you sat out ${byesOf(st.brian).length ? rText(byesOf(st.brian)) : 'no rounds'}.`);
}

async function finish(st: State, nm: Map<string, string>, completeAsked = false) {
  if (DOUBLES) return finishDoubles(st, nm, completeAsked);
  const tId = st.tournament_id!;
  const N = (id: string) => nm.get(id) ?? id.slice(0, 8);
  const { data: ranks } = await admin.from('tournament_final_ranks').select('user_id, final_rank').eq('tournament_id', tId).order('final_rank');
  const { data: rounds } = await admin.from('tournament_rounds').select('id, round_type').eq('tournament_id', tId);
  const { data: ms } = await admin.from('tournament_matches').select('round_id, winner_team, team1_player1, team2_player1, status').eq('tournament_id', tId);
  const typeOf = new Map((rounds ?? []).map((r: any) => [r.id, r.round_type]));
  const win = (type: string) => { const m = (ms ?? []).find((x: any) => typeOf.get(x.round_id) === type && x.status === 'completed');
    return m ? (m.winner_team === 'team1' ? [m.team1_player1, m.team2_player1] : [m.team2_player1, m.team1_player1]) : null; };
  log('COMPLETED. Final ranks:\n' + (ranks ?? []).map((r: any) => `    ${r.final_rank}. ${N(r.user_id)}`).join('\n'));
  const f = win('finals'), p3 = win('third_place_match');
  const rankOf = new Map((ranks ?? []).map((r: any) => [r.user_id, r.final_rank]));
  if (f) check('champion = Final winner (rank 1), runner-up = Final loser (rank 2)', rankOf.get(f[0]) === 1 && rankOf.get(f[1]) === 2,
    `${N(f[0])} rank ${rankOf.get(f[0])}, ${N(f[1])} rank ${rankOf.get(f[1])}`);
  if (p3) knownBug('B1', '3rd = Third Place winner, 4th = its loser', rankOf.get(p3[0]) === 3 && rankOf.get(p3[1]) === 4,
    `${N(p3[0])} rank ${rankOf.get(p3[0])}, ${N(p3[1])} rank ${rankOf.get(p3[1])}`);
  check('8 final ranks stored', (ranks ?? []).length === 8, `got ${(ranks ?? []).length}`);
  {
    const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed, status').eq('tournament_id', tId);
    const { data: full } = await admin.from('tournament_matches')
      .select('id, round_id, match_order, status, winner_team, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score').eq('tournament_id', tId);
    const group = ((full ?? []) as M[]).filter((m) => !['finals', 'third_place_match'].includes(typeOf.get(m.round_id)));
    const players = (regs ?? []).filter((r: any) => r.status === 'approved').map((r: any) => r.user_id as string);
    const table = standings(group, players, new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999])));
    const want = table.slice(4).map((e) => e.key), got = [5, 6, 7, 8].map((k) => (ranks ?? []).find((r: any) => r.final_rank === k)?.user_id);
    knownBug('B1', 'ranks 5-8 = round-robin standings 5-8 (app comparator)', want.every((id, i) => id === got[i]),
      `standings ${want.map(N).join(', ')}; stored ${got.map((g) => (g ? N(g) : '-')).join(', ')}`);
  }
  if (st.brian) {
    const { data: notes } = await admin.from('notifications').select('type, title, created_at').eq('user_id', st.brian)
      .gte('created_at', st.created_at).order('created_at');
    log(`Brian's notification rows since setup (${notes?.length ?? 0}):\n` + (notes ?? []).map((n: any) =>
      `    ${new Date(n.created_at).toLocaleTimeString('en-US', { hour12: false })}  ${n.type.padEnd(24)} ${n.title}`).join('\n'));
  }
}

// ── status ────────────────────────────────────────────────────────────────────
/** Re-run the PKL-043 audit on the finished tournament in the state file. Read-only (no XP replay). */
async function audit() {
  const st = readState(); if (!st?.tournament_id) return die(`no ${MODE} setup found`);
  if (!DOUBLES) return die('audit needs --doubles');
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed, status').eq('tournament_id', st.tournament_id);
  const players = (regs ?? []).filter((r: any) => r.status === 'approved').sort((a: any, b: any) => (a.seed ?? 999) - (b.seed ?? 999)).map((r: any) => r.user_id as string);
  log(`=== audit (${MODE}) ${st.tournament_id} ===`);
  await auditDoubles(st, st.tournament_id, players);
}

async function status() {
  const st = readState(); if (!st?.tournament_id) return die(`no ${MODE} setup found`);
  const nm = await names(st);
  const { data: t } = await admin.from('tournaments').select('name, status').eq('id', st.tournament_id).maybeSingle();
  const { data: ms } = await admin.from('tournament_matches').select('status, match_order, team1_player1, team1_player2, team2_player1, team2_player2').eq('tournament_id', st.tournament_id);
  const done = (ms ?? []).filter((m: any) => m.status === 'completed').length;
  console.log(`${t?.name ?? '(gone)'}  ${t?.status ?? ''}  matches ${done}/${ms?.length ?? 0} done`);
  for (const m of (ms ?? []).filter((m: any) => m.status !== 'completed' && st.brian && four(m).includes(st.brian)))
    console.log(DOUBLES ? `  yours: #${m.match_order} ${nm.get(m.team1_player1)} & ${nm.get(m.team1_player2)} v ${nm.get(m.team2_player1)} & ${nm.get(m.team2_player2)}`
      : `  yours: ${nm.get(m.team1_player1)} v ${nm.get(m.team2_player1)}`);
}

// ── cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  log(`=== cleanup (${MODE}) ===`);
  const st = readState();
  // Find everything by state file AND by name/email pattern, so a half-finished setup is also caught.
  const tIds = new Set<string>();
  if (st?.tournament_id) tIds.add(st.tournament_id);
  const { data: byName } = await admin.from('tournaments').select('id').eq('name', T_NAME);
  for (const t of byName ?? []) tIds.add(t.id);
  const bots = new Map<string, string>();
  for (const b of st?.bots ?? []) bots.set(b.id, b.email);
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) die('list users: ' + error.message);
    for (const u of data.users) if (u.email && new RegExp(`^sim_${TAG}${REHEARSAL ? 'r' : ''}_\\d+@pickleague\\.test$`).test(u.email)) bots.set(u.id, u.email);
    if (data.users.length < 1000) break;
  }
  if (st?.brian) {
    const now = await brianSnapshot(st.brian);
    log(`Brian before: ${JSON.stringify(st.brian_before)}`);
    log(`Brian now:    ${JSON.stringify(now)}`);
  }
  for (const tId of tIds) {
    const { data: rs } = await admin.from('tournament_rounds').select('id, label').eq('tournament_id', tId);
    const { data: ms } = await admin.from('tournament_matches').select('id').eq('tournament_id', tId);
    const { data: regs } = await admin.from('tournament_registrations').select('id, user_id').eq('tournament_id', tId);
    log(`tournament ${tId}`);
    log(`  rounds (${rs?.length ?? 0}): ${(rs ?? []).map((r: any) => r.id).join(' ')}`);
    log(`  matches (${ms?.length ?? 0}): ${(ms ?? []).map((m: any) => m.id).join(' ')}`);
    log(`  registrations (${regs?.length ?? 0}): ${(regs ?? []).map((r: any) => r.id).join(' ')}`);
    const { data: champ } = await admin.from('tournament_champion_badges').delete().eq('tournament_id', tId).select('*');
    if (champ?.length) log(`  champion badges deleted (${champ.length}): ${champ.map((c: any) => c.id ?? JSON.stringify(c)).join(' ')}`);
    const { error } = await admin.rpc('godmode_delete_tournament', { p_tournament_id: tId });
    if (error) die(`godmode_delete_tournament ${tId}: ${error.message}`);
    const { count: nLeft } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('entity_id', tId);
    if (nLeft) {
      const { data: gone, error: ne } = await admin.from('notifications').delete().eq('entity_id', tId).select('id');
      log(`  notifications about it deleted (${gone?.length ?? 0}): ${(gone ?? []).map((n: any) => n.id).join(' ')}${ne ? ' :: ' + ne.message : ''}`);
    }
    const { data: still } = await admin.from('tournaments').select('id').eq('id', tId).maybeSingle();
    check(`tournament ${tId} deleted`, !still);
  }
  const lIds = new Set<string>();
  if (st?.league_id) lIds.add(st.league_id);
  const { data: lByName } = await admin.from('leagues').select('id').eq('name', L_NAME);
  for (const l of lByName ?? []) lIds.add(l.id);
  for (const lId of lIds) {
    const { data: mem } = await admin.from('league_members').select('user_id').eq('league_id', lId);
    log(`league ${lId}  members (${mem?.length ?? 0}): ${(mem ?? []).map((m: any) => m.user_id).join(' ')}`);
    const { error } = await admin.rpc('godmode_delete_league', { p_league_id: lId });
    if (error) { const { error: e2 } = await admin.from('leagues').delete().eq('id', lId); if (e2) log(`  league delete: ${error.message} / ${e2.message}`); }
    const { data: still } = await admin.from('leagues').select('id').eq('id', lId).maybeSingle();
    check(`league ${lId} deleted`, !still);
  }
  for (const [id, email] of bots) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) log(`  bot ${id} ${email}: ${error.message}`);
    const { data: prof } = await admin.from('profiles').select('id').eq('id', id).maybeSingle();
    if (prof) { const { error: pe } = await admin.from('profiles').delete().eq('id', id); if (pe) log(`  profile ${id}: ${pe.message}`); }
    const { data: left } = await admin.from('profiles').select('id').eq('id', id).maybeSingle();
    check(`bot ${email} (${id}) deleted`, !error && !left, error?.message);
  }
  if (st?.brian && st.brian_before) {
    const now = await brianSnapshot(st.brian);
    const moved = Object.keys(st.brian_before).filter((k) => String((now as any)[k]) !== String((st.brian_before as any)[k]));
    log(moved.length ? `Brian's profile differs from before the QA in: ${moved.map((k) => `${k} ${(st.brian_before as any)[k]} -> ${(now as any)[k]}`).join(', ')}` : "Brian's profile is back to exactly where it was before the QA");
    if (moved.length && has('--restore-brian')) {
      const patch = Object.fromEntries(moved.map((k) => [k, (st.brian_before as any)[k]]));
      const { error } = await admin.from('profiles').update(patch).eq('id', st.brian);
      check(`restore Brian's ${moved.join(', ')}`, !error, error?.message);
    }
    const { data: pb } = await admin.from('player_badges').select('*').eq('user_id', st.brian);
    const before = new Set(st.brian_badges_before ?? []);
    const added = (pb ?? []).filter((r: any) => !before.has(String(r.id)));
    if (added.length) {
      log(`badges Brian gained during the QA (${added.length}): ${added.map((r: any) => `${r.id} ${r.badge_id ?? r.badge ?? ''}`).join(', ')}`);
      if (has('--restore-brian')) {
        const { error } = await admin.from('player_badges').delete().in('id', added.map((r: any) => r.id));
        check(`remove ${added.length} QA badge(s) from Brian`, !error, error?.message);
      }
    } else log('Brian gained no badges during the QA');
  }
  if (!failures) { try { fs.renameSync(STATE_FILE, STATE_FILE.replace(/\.json$/, `.cleaned-${Date.now()}.json`)); } catch { /* none */ } }
  log(`=== cleanup done; ${failures} problem(s) ===`);
  process.exitCode = failures ? 1 : 0;
}

// ── main ──────────────────────────────────────────────────────────────────────
process.on('SIGINT', () => { log('Ctrl+C: stopped. Run again to resume from the database state.'); process.exit(130); });
const main: Record<string, () => unknown> = { setup, run, status, audit, cleanup, plan };
if (!main[CMD]) { console.log('usage: npx tsx live-qa-pkl034.ts setup|run|status|cleanup|plan [--doubles] [--rehearsal] [--fast] [--interval 60] [--restore-brian]'); process.exit(2); }
Promise.resolve(main[CMD]()).catch((e) => die(String(e?.stack ?? e)));
