/**
 * PKL-034 live tournament QA: 7 QA bots + Brian (on his phone) play an 8-player singles round robin,
 * then a Final (1st v 2nd) and a Third Place Match (3rd v 4th), on PRODUCTION Supabase.
 *
 *   npx tsx live-qa-pkl034.ts setup   [--rehearsal]        create bots + private tournament, invite Brian
 *   npx tsx live-qa-pkl034.ts run     [--rehearsal] [--fast] [--interval 60]
 *   npx tsx live-qa-pkl034.ts status  [--rehearsal]
 *   npx tsx live-qa-pkl034.ts replay  [--rehearsal]        PKL-054: save the replay page now (cleanup also saves one first)
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
import { seedPlayers, seedTeams, generateMLPSchedule, generateDoublesSingleElim, generateDoubleElim, generateRoundRobin, generateRotatingPartners, rotatingPartnersRounds, generateDoublesPoolPlay, validatePools, FORMAT_META, type MatchPairing } from '../mobile/src/lib/tournament';
import * as PO from './qa/pools-oracle';
import { buildStandingsComparator } from '../mobile/src/lib/tournamentTiebreakers';
import { collectReplay } from './replay/collect';
import { saveReplay } from './replay/render';

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const CMD = argv[0] ?? 'help';
const has = (n: string) => argv.includes(n);
const val = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const REHEARSAL = has('--rehearsal');
const MODE = REHEARSAL ? 'rehearsal' : 'live';
const BRIAN = val('--brian', '252a36e1-5d89-4ad2-8a3e-b786579f019a'); // Brian Stockman (godmode.ts)
// PKL-050: --pools = doubles POOL PLAY with fixed pairs, then a playoff (R1 and its bots-only variants).
//   --pool-count 2  --playoff top_2_per_pool  --players 16  --ante 50  --courts 2  --variant <name>
//   --tie-order team:4,team:8,team:1   who the host puts first when it orders a waiting tie (rehearsal / "host")
const POOLS = has('--pools');
// PKL-060 R7: rotating partners doubles, odd count (9: one bye per round), courts, an ante pot that Brian (co-admin)
// pays out, then `cancel-check`: a second tournament with antes is cancelled and every pickle must come back.
const R7 = has('--r7');
// PKL-060 R4: single elimination doubles, 8 random pairs (16 players), PLUPR seeding, join by request with a deadline,
// max 16 (two extra "latecomer" bots check the waitlist and the deadline), Courts 1+2.
const R4 = has('--r4');
// PKL-060 R5 (bots only): singles round robin, 7 players (a bye each round), 3 courts, top 4 + third place, ante 50,
// everyone joins with an invite code, a bracket release time, one cancelled match, a settings edit mid-run (Court 3
// taken away), two wagers on the winner (server level: WAGERS_ENABLED is off in the app).
const R5 = has('--r5');
/** R5's playoff: top_4 (default) or top_8 (the bots-only variant, 9+ players: --variant top8 --playoff top_8 --players 10). */
const R5_PO = val('--playoff', 'top_4');
// PKL-060 R3: double elimination singles, 8 players (the app needs a power of 2 for double elim), random seeding,
// no courts, invite only. Nobody is out before a second loss; the Grand Final decides it.
const R3 = has('--r3');
// PKL-060 R2 (bots only for now): MLP with random teams (mlp_random), snake draft by PLUPR, round robin + top 4 playoff,
// dreambreakers. 20 bots (10 men, 10 women) = 5 teams. With 5 teams the round robin follows a fixed plan in which the
// 4th and 5th teams tie on sub-match W-L and the 5th has the better point diff (a PKL-052 probe). --semis dreambreaker
// (default: both semifinals go 2-2 and a dreambreaker decides) | decided (3-1, the dreambreaker is cancelled).
const R2 = has('--r2');
const R2_SEMIS = val('--semis', 'dreambreaker');
const POOL_COUNT = Number(val('--pool-count', '2'));
const PLAYOFF = val('--playoff', 'top_2_per_pool');
const ANTE = POOLS || R7 || R5 ? Number(val('--ante', '50')) : 0;
const VARIANT = val('--variant', '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const DOUBLES = has('--doubles') || POOLS || R7 || R4;
const TAG = POOLS ? 'pkl050' : R7 ? 'pkl060r7' : R4 ? 'pkl060r4' : R5 ? 'pkl060r5' : R3 ? 'pkl060r3' : R2 ? 'pkl060r2' : DOUBLES ? 'pkl043' : 'pkl034';
const ITEM = POOLS ? 'PKL-050' : R7 || R4 || R5 || R3 || R2 ? 'PKL-060' : DOUBLES ? 'PKL-043' : 'PKL-034';
const N_PLAYERS = POOLS ? Number(val('--players', '16')) : R7 ? Number(val('--players', '9')) : R4 ? 16 : R5 ? Number(val('--players', '7')) : R2 ? Number(val('--players', '20')) : DOUBLES ? 10 : 8;
const N_BOTS = REHEARSAL ? N_PLAYERS : N_PLAYERS - 1;
/** R4: two more bots that only try to join late (one when the field is full: waitlisted; one after the deadline: refused). */
const LATE_BOTS = R4 ? 2 : 0;
const T_NAME = POOLS ? `[SIM] PKL-050 pool play QA${VARIANT ? ' ' + VARIANT : ''}${REHEARSAL ? ' rehearsal' : ''}`
  : R7 ? `[SIM] PKL-060 R7 rotating partners QA${REHEARSAL ? ' rehearsal' : ''}`
  : R4 ? `[SIM] PKL-060 R4 single elim doubles QA${REHEARSAL ? ' rehearsal' : ''}`
  : R5 ? `[SIM] PKL-060 R5 round robin singles QA${VARIANT ? ' ' + VARIANT : ''}${REHEARSAL ? ' rehearsal' : ''}`
  : R3 ? `[SIM] PKL-060 R3 double elim singles QA${REHEARSAL ? ' rehearsal' : ''}`
  : R2 ? `[SIM] PKL-060 R2 MLP random teams QA${VARIANT ? ' ' + VARIANT : ''}${REHEARSAL ? ' rehearsal' : ''}`
  : DOUBLES ? (REHEARSAL ? '[SIM] PKL-043 doubles QA rehearsal' : '[SIM] PKL-043 doubles QA')
  : REHEARSAL ? '[SIM] PKL-034 rehearsal' : '[SIM] PKL-034 live QA';
const L_NAME = POOLS ? `[SIM] PKL-050 QA league${VARIANT ? ' ' + VARIANT : ''}${REHEARSAL ? ' rehearsal' : ''}`
  : R7 ? `[SIM] PKL-060 R7 QA league${REHEARSAL ? ' rehearsal' : ''}`
  : R4 ? `[SIM] PKL-060 R4 QA league${REHEARSAL ? ' rehearsal' : ''}`
  : R5 ? `[SIM] PKL-060 R5 QA league${VARIANT ? ' ' + VARIANT : ''}${REHEARSAL ? ' rehearsal' : ''}`
  : R3 ? `[SIM] PKL-060 R3 QA league${REHEARSAL ? ' rehearsal' : ''}`
  : R2 ? `[SIM] PKL-060 R2 QA league${VARIANT ? ' ' + VARIANT : ''}${REHEARSAL ? ' rehearsal' : ''}`
  : DOUBLES ? (REHEARSAL ? '[SIM] PKL-043 rehearsal league' : '[SIM] PKL-043 QA league')
  : REHEARSAL ? '[SIM] PKL-034 rehearsal league' : '[SIM] PKL-034 QA league';
const BOT_TAG = `${TAG}${REHEARSAL ? 'r' : ''}${VARIANT}`;
const EMAIL = (n: number) => `sim_${BOT_TAG}_${n}@pickleague.test`;
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
const STATE_DIR = path.join(repo, 'state', POOLS ? 'pkl-050' : R7 ? 'pkl-060-r7' : R4 ? 'pkl-060-r4' : R5 ? 'pkl-060-r5' : R3 ? 'pkl-060-r3' : R2 ? 'pkl-060-r2' : DOUBLES ? 'pkl-043' : 'pkl-034');
/** R7: the second tournament, created only to be cancelled (cancel-check). */
const T2_NAME = `${T_NAME} (cancel check)`;
const RUN = `${MODE}${VARIANT ? '-' + VARIANT : ''}`; // file stem: live, rehearsal, rehearsal-p3, ...
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, `${RUN}.json`);
const LOG_FILE = path.join(STATE_DIR, `${RUN}-log.txt`);
const CONTROL = path.join(STATE_DIR, 'control.txt');

// ── logging ───────────────────────────────────────────────────────────────────
const stamp = () => new Date().toLocaleTimeString('en-US', { hour12: false });
function log(s: string) {
  const line = `[${stamp()}] ${s}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}
let failures = 0;
/** PKL-054: every check also goes to <mode>-checks.json, so the replay pins it to the moment it covers:
 *  the match it names (pinned to when that match was scored), else when it ran. */
const CHECKS_FILE = path.join(STATE_DIR, `${RUN}-checks.json`);
type CheckRow = { at: string; ok: boolean; desc: string; detail?: string; known?: string; match_id?: string | null };
const checkRows: CheckRow[] = (() => { try { return JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf8')); } catch { return []; } })();
function keepCheck(row: CheckRow) {
  checkRows.push(row);
  try { fs.writeFileSync(CHECKS_FILE, JSON.stringify(checkRows, null, 1)); } catch { /* the log still has it */ }
}
function check(desc: string, ok: boolean, details?: string, matchId?: string | null) {
  if (!ok) failures++;
  log(`${ok ? 'CHECK PASS' : 'CHECK FAIL'}  ${desc}${!ok && details ? ' :: ' + details : ''}`);
  keepCheck({ at: new Date().toISOString(), ok, desc, detail: ok ? undefined : details, match_id: matchId ?? null });
}
/** A check whose failure is a known, already-logged app bug: logged, never counted (Brian decides the rule). */
function knownBug(bug: string, desc: string, ok: boolean, details?: string, matchId?: string | null) {
  log(`${ok ? 'CHECK PASS' : `KNOWN BUG ${bug} (expected, not counted)`}  ${desc}${!ok && details ? ' :: ' + details : ''}`);
  keepCheck({ at: new Date().toISOString(), ok, desc, detail: ok ? undefined : details, known: ok ? undefined : bug, match_id: matchId ?? null });
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
const COURTS: string[] | null = (DOUBLES || R5) && !has('--no-courts')
  ? Array.from({ length: Number(val('--courts', R5 ? '3' : '2')) }, (_, i) => String(i + 1)) : null;
/** The four (or two, in singles) players of a match, nulls dropped. */
const four = (m: M) => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].filter((x): x is string => !!x);
const sameSet = (a: (string | null | undefined)[], b: (string | null | undefined)[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

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

/** PKL-050 offline: R1's draw + plan through the pool oracle (tie block, admin order, seeds, bracket, final ranks, pot). */
function planPools() {
  const ids = Array.from({ length: 16 }, (_, i) => `00000000-0000-0000-0000-0000000000${String(i + 10)}`); // sortable fake uuids
  const T = Array.from({ length: 8 }, (_, i) => [ids[2 * i], ids[2 * i + 1]] as [string, string]);
  const { pools, matches } = generateDoublesPoolPlay(T, 2);
  const tNo = (t: string[]) => T.findIndex((x) => sameSet(x, t)) + 1;
  const okPools = pools.map((p) => p.map(tNo).join(',')).join(' | ') === '1,4,5,8 | 2,3,6,7';
  console.log(`pools: ${pools.map((p, i) => `${'AB'[i]}=${p.map(tNo).join(',')}`).join(' ')} (want A=1,4,5,8 B=2,3,6,7): ${okPools}`);
  const planFile = path.join(repo, 'state', 'pkl-050', 'r1-plan.json');
  const pl: { a: string; b: string; score: [number, number]; by?: string }[] = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const rounds: PO.PR[] = [{ id: 'rA', label: 'Pool A', round_type: 'pool', round_number: 1 }, { id: 'rB', label: 'Pool B', round_type: 'pool', round_number: 2 }];
  let okPlan = true;
  const ms: PO.PM[] = matches.map((m, i) => {
    const p = pl.find((x) => { const a = T[Number(x.a.split(':')[1]) - 1], b = T[Number(x.b.split(':')[1]) - 1];
      return (sameSet(a, [...m.team1]) && sameSet(b, [...m.team2])) || (sameSet(a, [...m.team2]) && sameSet(b, [...m.team1])); });
    if (!p || !validScore(p.score[0], p.score[1])) okPlan = false;
    const flip = p ? !sameSet(T[Number(p.a.split(':')[1]) - 1], [...m.team1]) : false;
    const s1 = p ? (flip ? p.score[1] : p.score[0]) : 0, s2 = p ? (flip ? p.score[0] : p.score[1]) : 0;
    return { id: `m${i}`, round_id: m.poolIndex ? 'rB' : 'rA', match_order: i, status: 'completed', winner_team: s1 > s2 ? 'team1' : 'team2',
      team1_player1: m.team1[0], team1_player2: m.team1[1], team2_player1: m.team2[0], team2_player2: m.team2[1], team1_score: s1, team2_score: s2 };
  });
  const brianOpp = pl.filter((x) => x.by === 'opp' && [x.a, x.b].includes('team:8')).length;
  console.log(`plan: ${pl.length} rows, every pool match planned with a valid score: ${okPlan && ms.length === 12}; your matches entered by the opponent: ${brianOpp}`);
  const seedOf = new Map(ids.map((u, i) => [u, i + 1]));
  const noTie = () => null;
  const tables0 = PO.poolTables(ms, rounds, seedOf, noTie);
  console.log(tables0.map((t) => `Pool ${t.letter}: ` + t.rows.map((r) => `T${tNo(PO.membersOf(r.key))} ${r.wins}-${r.losses} ${r.diff >= 0 ? '+' : ''}${r.diff}`).join(', ')).join('\n'));
  const block = PO.tieBlock(tables0, 2);
  const okBlock = !!block && block.letter === 'A' && block.position === 1 && block.keys.map((k) => tNo(PO.membersOf(k))).sort().join(',') === '1,4,8';
  console.log(`tie block: ${block ? `Pool ${block.letter} at ${block.position}: teams ${block.keys.map((k) => tNo(PO.membersOf(k))).join(',')}` : 'none'} (want Pool A at 1: 1,4,8): ${okBlock}`);
  // the admin puts team 8 first, then 4, then 1
  const order = [T[7], T[3], T[0]].map((t) => PO.keyOf(t[0], t[1]));
  const tie = (k: string) => { const i = order.indexOf(k); return i >= 0 ? i + 1 : null; };
  const tables = PO.poolTables(ms, rounds, seedOf, tie);
  const okUnblocked = PO.tieBlock(tables, 2) === null;
  const seeds = PO.perPoolSeeds(tables, 2).map((k) => tNo(PO.membersOf(k)));
  const shape = PO.perPoolPairings(2, 2)!;
  const draw = shape.pairs.map(([a, b]) => `T${seeds[a - 1]} v T${seeds[b - 1]}`).join(', ');
  const okSeeds = seeds.join(',') === '8,2,4,3' && shape.roundType === 'semifinals' && draw === 'T8 v T3, T2 v T4';
  console.log(`after the tie order 8 > 4 > 1: unblocked ${okUnblocked}; seeds ${seeds.join(',')}; ${shape.roundType}: ${draw} (want 8,2,4,3; T8 v T3, T2 v T4): ${okSeeds}`);
  // playoff: T8 beats T3, T4 beats T2; final T8 beats T4; third T2 beats T3
  const rp: PO.PR[] = [...rounds, { id: 'rS', label: 'Semifinals', round_type: 'semifinals', round_number: 1000 },
    { id: 'rF', label: 'Finals', round_type: 'finals', round_number: 1001 }, { id: 'r3', label: 'Third Place Match', round_type: 'third_place_match', round_number: 1001 }];
  const pm = (id: string, r: string, a: string[], b: string[], w: 'team1' | 'team2'): PO.PM => ({ id, round_id: r, match_order: 0, status: 'completed', winner_team: w,
    team1_player1: a[0], team1_player2: a[1], team2_player1: b[0], team2_player2: b[1], team1_score: w === 'team1' ? 11 : 6, team2_score: w === 'team1' ? 6 : 11 });
  const all = [...ms, pm('s1', 'rS', T[7], T[2], 'team1'), { ...pm('s2', 'rS', T[1], T[3], 'team2'), match_order: 1 },
    pm('f', 'rF', T[7], T[3], 'team1'), pm('t', 'r3', T[1], T[2], 'team1')];
  const fr = PO.finalRanks(all, rp, seedOf, tie, ids);
  const teamRanks = T.map((t) => fr.ranks.get(t[0])).join(',');
  const okRanks = teamRanks === '5,3,4,2,7,6,8,1' && T.every((t) => fr.ranks.get(t[0]) === fr.ranks.get(t[1]));
  console.log(`final ranks by team 1..8: ${teamRanks} (want 5,3,4,2,7,6,8,1; partners share): ${okRanks}`);
  const shares = PO.potShares(16 * 50, [60, 25, 15], fr.ranks);
  const okPot = shares.get(T[7][0]) === 240 && shares.get(T[3][0]) === 100 && shares.get(T[1][0]) === 60 && [...shares.values()].reduce((a, b) => a + b, 0) === 800;
  console.log(`pot 800: 1st ${shares.get(T[7][0])} each, 2nd ${shares.get(T[3][0])} each, 3rd ${shares.get(T[1][0])} each (want 240/100/60, total 800): ${okPot}`);
  const v = [[3, 2], [4, 2], [2, 1], [3, 1], [6, 1], [4, 1]].map(([p, n]) => `${p} pools top_${n}_per_pool: ${PO.perPoolPairings(p, n)?.roundType ?? 'unsupported'}`);
  console.log('variants: ' + v.join(' ; '));
  process.exit(okPools && okPlan && okBlock && okUnblocked && okSeeds && okRanks && okPot ? 0 : 1);
}

function plan() {
  if (R2) return planR2();
  if (POOLS) return planPools();
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
  cancel_tournament_id?: string; cancel_before?: Record<string, number>;
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
  if (R2 && (N_PLAYERS % 4 || N_PLAYERS < 8)) die(`R2 needs a multiple of 4 players, at least 8 (got ${N_PLAYERS})`);
  const prior = readState();
  if (prior?.tournament_id) {
    const { data } = await admin.from('tournaments').select('id').eq('id', prior.tournament_id).maybeSingle();
    if (data) die(`a ${MODE} tournament already exists (${prior.tournament_id}); run cleanup first`);
  }
  // A new tournament starts a new checks file (the replay must not show an earlier run's checks).
  checkRows.length = 0;
  try { fs.writeFileSync(CHECKS_FILE, '[]'); } catch { /* none */ }
  const { data: dup } = await admin.from('tournaments').select('id').eq('name', T_NAME);
  if (dup?.length) die(`"${T_NAME}" already exists (${dup.map((d) => d.id).join(', ')}); run cleanup first`);

  if (!REHEARSAL) {
    const { data: b } = await admin.from('profiles').select('id, full_name, username').eq('id', BRIAN).maybeSingle();
    if (!b) die('Brian profile not found: ' + BRIAN);
    log(`player ${N_PLAYERS}: ${b!.full_name || b!.username} (${BRIAN})`);
    if (ANTE) {
      const { data: bp } = await admin.from('profiles').select('pickles').eq('id', BRIAN).single();
      if (Number(bp?.pickles ?? 0) < ANTE) die(`Brian has ${bp?.pickles ?? 0} pickles; accepting the invite charges the ${ANTE} ante`);
      log(`Brian pays the ${ANTE}-pickle ante when he accepts (balance ${bp?.pickles}); prizes pay the top 3 teams`);
    }
  }
  const st: State = { mode: MODE, created_at: new Date().toISOString(), tournament_name: T_NAME, bots: [],
    password: crypto.randomBytes(18).toString('base64url'), brian: REHEARSAL ? undefined : BRIAN };
  writeState(st); // password saved before any account exists, so cleanup can always find them

  // 1. bot accounts
  for (let n = 1; n <= N_BOTS + LATE_BOTS; n++) {
    const email = EMAIL(n), name = `QA Bot ${n}`;
    const { data, error } = await admin.auth.admin.createUser({
      email, password: st.password, email_confirm: true,
      user_metadata: { full_name: name, username: POOLS || R7 || R4 || R5 || R3 || R2 ? `qa${BOT_TAG}${n}` : `qabot${n}${REHEARSAL ? 'r' : ''}` },
    });
    if (error) die(`create ${email}: ${error.message} (run cleanup, then setup again)`);
    const id = data.user!.id;
    st.bots.push({ n, id, email, name }); writeState(st);
    // R2 (MLP): odd bots are men, even bots women, each with its own PLUPR so the snake draft has one right answer.
    // Live R2: Brian (a man) is the last player, so the last bot is a woman to keep 10 men and 10 women.
    const r2Male = n % 2 === 1 && !(!REHEARSAL && n === N_BOTS);
    const prof: Record<string, unknown> = R2 ? { full_name: name, gender: r2Male ? 'male' : 'female', rating: r2Rating(n, N_BOTS) } : { full_name: name, gender: 'male' };
    const { error: pe } = await admin.from('profiles').update(prof).eq('id', id);
    if (pe) log(`  note: profile update ${name}: ${pe.message}`);
    log(`bot ${name}  ${id}  ${email}${R2 ? `  ${prof.gender}, PLUPR ${prof.rating}` : ''}`);
  }
  const host = st.bots[0];
  // Starting a league costs 5000 pickles and a tournament 2500 (migration_create_costs.sql); new accounts have none.
  // Fund the host for exactly those two fees so the app's real fee path runs. The balance, and the create_fees rows
  // (on delete cascade), go away when cleanup deletes the bot.
  const { error: fe } = await admin.from('profiles').update({ pickles: 7500 + ANTE }).eq('id', host.id);
  if (fe) die('fund host: ' + fe.message);
  log(`host ${host.name} funded with ${7500 + ANTE} pickles (league 5000 + tournament 2500 create fees${ANTE ? ` + ${ANTE} ante` : ''})`);
  if (ANTE) {
    // PKL-050: every player pays the ante when approved (_charge_tournament_ante); bots start with none.
    const { error: ae } = await admin.from('profiles').update({ pickles: ANTE }).in('id', st.bots.slice(1).map((b) => b.id));
    if (ae) die('fund bots for the ante: ' + ae.message);
    log(`bots 2..${st.bots.length} funded with ${ANTE} pickles each (the ante)`);
  }
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
  const payload = R2 ? {
    // CreateTournamentScreen for MLP + Random teams + Round robin + Playoff top 4: format mlp_random, match_type
    // doubles, team_creation random, mlp_play_format round_robin_playoff, mlp_playoff_teams 4, mlp_pool_count 2
    // (it sends 2 when the format is not pool play), and no playoff_format (only sent for non-MLP formats).
    league_id: lg!.id, name: T_NAME,
    description: `QA test (${ITEM}). Private, invite only. ${N_BOTS} QA bots post scores automatically; this is not a real event.`,
    created_by: host.id, format: 'mlp_random', match_type: 'doubles', seeding: 'elo', pool_count: 1,
    partner_rotation: null, team_creation: 'random', registration_mode: 'invite_only', registration_closes_at: null,
    min_players: N_PLAYERS, max_players: N_PLAYERS, start_time: start.toISOString(), expected_length_hours: 3,
    location_name: 'QA test (online)', location_lat: null, location_lng: null,
    pickle_ante: 0, payout_structure: [60, 25, 15], status: 'registration',
    mlp_play_format: 'round_robin_playoff', mlp_pool_count: 2, mlp_playoff_teams: 4, courts: null,
  } : R3 ? {
    league_id: lg!.id, name: T_NAME,
    description: `QA test (${ITEM}). Private, invite only. ${N_BOTS} QA bots post scores automatically; this is not a real event.`,
    created_by: host.id, format: 'double_elimination', match_type: 'singles', seeding: 'random', pool_count: 1,
    partner_rotation: null, team_creation: 'fixed', registration_mode: 'invite_only', registration_closes_at: null,
    min_players: N_PLAYERS, max_players: N_PLAYERS, start_time: start.toISOString(), expected_length_hours: 2,
    location_name: 'QA test (online)', location_lat: null, location_lng: null,
    pickle_ante: 0, payout_structure: [60, 25, 15], status: 'registration',
  } : R5 ? {
    league_id: lg!.id, name: T_NAME,
    description: `QA test (${ITEM}). Private test event joined by invite code; QA bots post scores automatically.`,
    created_by: host.id, format: 'round_robin', match_type: 'singles', seeding: 'elo', pool_count: 1,
    partner_rotation: null, courts: COURTS, team_creation: 'fixed', registration_mode: 'invite_only', registration_closes_at: null,
    min_players: N_PLAYERS, max_players: N_PLAYERS, start_time: start.toISOString(), expected_length_hours: 2,
    location_name: 'QA test (online)', location_lat: null, location_lng: null,
    pickle_ante: ANTE, payout_structure: [60, 25, 15], status: 'registration',
    playoff_format: R5_PO, playoff_third_place: true,
  } : R4 ? {
    // R4: single elimination doubles, random pairs, PLUPR seeding, join by request until a deadline, exactly 16.
    league_id: lg!.id, name: T_NAME,
    description: `QA test (${ITEM}). Private test event: ask to join; QA bots post scores automatically. Not a real event.`,
    created_by: host.id, format: 'single_elimination', match_type: 'doubles', seeding: 'elo', pool_count: 1,
    partner_rotation: null, courts: COURTS, team_creation: 'random', registration_mode: 'request',
    registration_closes_at: new Date(Date.now() + 45 * 60_000).toISOString(),
    min_players: N_PLAYERS, max_players: N_PLAYERS, start_time: start.toISOString(), expected_length_hours: 2,
    location_name: 'QA test (online)', location_lat: null, location_lng: null,
    pickle_ante: 0, payout_structure: [60, 25, 15], status: 'registration',
  } : POOLS ? {
    // PKL-050 R1: the Create screen for pool play doubles sends pool_count, team_creation (fixed pairs) and the
    // playoff settings (it sends playoff_format / playoff_third_place for round_robin and pool_play).
    league_id: lg!.id, name: T_NAME,
    description: `QA test (${ITEM}). Private, invite only. ${N_BOTS} QA bots post scores automatically; this is not a real event.`,
    created_by: host.id, format: 'pool_play', match_type: 'doubles', seeding: 'random', pool_count: POOL_COUNT,
    partner_rotation: null, courts: COURTS, team_creation: 'fixed', registration_mode: 'invite_only', registration_closes_at: null,
    min_players: N_PLAYERS, max_players: N_PLAYERS, start_time: start.toISOString(), expected_length_hours: 2,
    location_name: 'QA test (online)', location_lat: null, location_lng: null,
    pickle_ante: ANTE, payout_structure: [60, 25, 15], status: 'registration',
    playoff_format: PLAYOFF, playoff_third_place: true,
  } : DOUBLES ? {
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
    pickle_ante: ANTE, payout_structure: [60, 25, 15], status: 'registration',
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

  // 4. R5: the host sets a bracket release time and makes an invite code; every bot joins with it (approved, ante paid).
  if (R5) {
    const rel = new Date(Date.now() + 2 * 60_000).toISOString();
    const { error: re2 } = await hc.from('tournaments').update({ bracket_release_time: rel }).eq('id', t!.id);
    log(re2 ? `RELEASE TIME ERROR: ${re2.message}` : `host set the bracket release time to ${rel}`);
    const { data: code, error: ce } = await hc.rpc('create_invite_code', { p_scope_type: 'tournament', p_scope_id: t!.id, p_max_uses: 10, p_expires_days: 7, p_pickle_subsidy: 0 });
    if (ce) die('create invite code: ' + ce.message);
    const token = (Array.isArray(code) ? code[0] : code)?.token;
    log(`host made invite code ${token}`);
    // QA Bots 2 and 3 place 10-pickle wagers later: fund them on top of the ante they pay on joining.
    for (const b of st.bots.slice(1, 3)) await admin.from('profiles').update({ pickles: ANTE + 10 }).eq('id', b.id);
    for (const b of st.bots.slice(1)) {
      const { data: rr, error: ue } = await (await asBot(st, b.id)).rpc('redeem_invite_code', { p_token: token });
      const row = Array.isArray(rr) ? rr[0] : rr;
      if (ue || !row?.success) die(`${b.name} redeem: ${ue?.message ?? row?.message}`);
      log(`  ${b.name} joined with the code (${row.message})`);
    }
    log(`setup done. ids in ${STATE_FILE}`);
    return;
  }
  // 4. R4: the bots ask to join and the host approves them (the app's request + Approve). Brian asks on his phone.
  if (R4) {
    for (const b of st.bots.slice(1, N_BOTS)) {
      const bc = await asBot(st, b.id);
      const { data: reg, error: qe } = await bc.from('tournament_registrations').insert({ tournament_id: t!.id, user_id: b.id }).select('id, status').single();
      if (qe) die(`${b.name} request: ${qe.message}`);
      const { error: ae } = await hc.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg!.id);
      if (ae) die(`approve ${b.name}: ${ae.message}`);
      log(`  ${b.name} asked to join (${reg!.status}) + host approved`);
    }
    if (!REHEARSAL) {
      st.brian_before = await brianSnapshot(BRIAN);
      const { data: pb } = await admin.from('player_badges').select('id').eq('user_id', BRIAN);
      st.brian_badges_before = (pb ?? []).map((r: any) => String(r.id));
      writeState(st);
      log('Brian: open the tournament from the "New tournament" alert and tap Join (it sends a request; the host approves it).');
    }
    log(`setup done. ids in ${STATE_FILE}`);
    return;
  }
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

/** PKL-050: the admin tie order, by entrant key ("lo:hi"). */
async function tieRanks(tId: string): Promise<(k: string) => number | null> {
  const { data } = await admin.from('tournament_tie_orders').select('entrant_key, tie_rank').eq('tournament_id', tId);
  const m = new Map((data ?? []).map((r: any) => [String(r.entrant_key).toLowerCase(), Number(r.tie_rank)]));
  return (k: string) => m.get(k) ?? null;
}
const PER_POOL = PLAYOFF === 'top_1_per_pool' ? 1 : 2;
const TIE_ORDER = val('--tie-order', '').split(',').map((s) => s.trim()).filter(Boolean);

/** PKL-050: team k (1-based) = seeds 2k-1 and 2k of the fixed order: QA Bot 1+2, 3+4, ..., and QA Bot 15 + Brian. */
const teamsOf = (st: State) => { const o = fixedSeedOrder(st); return Array.from({ length: o.length / 2 }, (_, i) => [o[2 * i], o[2 * i + 1]] as [string, string]); };

/**
 * PKL-050: pairs through the app's own RPCs (DoublesPairSection): each team's first player creates "QA Pair k"
 * (create_doubles_pair) and invites the second (pair_invite); a bot partner accepts (pair_respond_to_join), Brian
 * accepts on his phone. Also makes Brian a tournament co-admin, as TournamentMembersScreen does. True when all set.
 */
/** The host makes Brian a tournament co-admin, as TournamentMembersScreen does (Players -> Make co-admin). */
async function ensureCoAdmin(st: State, regs: any[]) {
  if (!st.brian) return;
  const mine = regs.find((r) => r.user_id === st.brian);
  if (mine?.status !== 'approved' || mine.role === 'co-admin') return;
  const hc = await asBot(st, st.bots[0].id);
  const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', st.tournament_id!).eq('user_id', st.brian).single();
  const { error } = await hc.from('tournament_registrations').update({ role: 'co-admin' }).eq('id', reg!.id);
  log(error ? `CO-ADMIN ERROR: ${error.message}` : `host ${st.bots[0].name} made you a co-admin of the tournament (Players -> Make co-admin)`);
}
async function ensurePools(st: State, regs: any[]): Promise<boolean> {
  const tId = st.tournament_id!;
  await ensureCoAdmin(st, regs);
  const { data: pairs0 } = await admin.from('doubles_pairs').select('id, name, captain_id, partner_1_id, partner_2_id').eq('tournament_id', tId);
  const pairs = (pairs0 ?? []) as any[];
  let ready = true;
  for (const [k, [a, b]] of teamsOf(st).entries()) {
    let pair = pairs.find((p) => p.captain_id === a);
    if (!pair) {
      const ac = await asBot(st, a);
      const { data: id, error } = await ac.rpc('create_doubles_pair', { p_tournament_id: tId, p_name: `QA Pair ${k + 1}` });
      if (error) die(`create QA Pair ${k + 1}: ${error.message}`);
      pair = { id, name: `QA Pair ${k + 1}`, captain_id: a, partner_1_id: a, partner_2_id: null };
      log(`PAIR QA Pair ${k + 1} created by ${st.bots.find((x) => x.id === a)?.name}`);
    }
    if ([pair.partner_1_id, pair.partner_2_id].includes(b)) continue;
    ready = false;
    const { data: req } = await admin.from('doubles_pair_join_requests').select('id, status')
      .eq('pair_id', pair.id).eq('user_id', b).eq('direction', 'invite').maybeSingle();
    if (!req || req.status !== 'pending') {
      const ac = await asBot(st, a);
      const { error } = await ac.rpc('pair_invite', { p_pair_id: pair.id, p_user_id: b, p_message: null });
      if (error) die(`invite to QA Pair ${k + 1}: ${error.message}`);
      log(`PAIR invite: QA Pair ${k + 1} invited ${b === st.brian ? 'YOU' : st.bots.find((x) => x.id === b)?.name}`);
      continue;
    }
    if (b === st.brian) continue; // he accepts on his phone
    const bc = await asBot(st, b);
    const { error } = await bc.rpc('pair_respond_to_join', { p_request_id: req.id, p_accept: true });
    if (error) die(`accept QA Pair ${k + 1}: ${error.message}`);
    log(`PAIR QA Pair ${k + 1}: ${st.bots.find((x) => x.id === b)?.name} accepted`);
  }
  return ready;
}

/**
 * useTournamentDetail.doLockIn for pool_play with fixed doubles pairs: teams from doubles_pairs as
 * [partner_1, partner_2], generateDoublesPoolPlay(seededTeams, pool_count), one 'pool' round per pool ("Pool A",
 * round_number = pool index + 1), match_order = flat index, play_round = the pool's round, seeds = teams flattened.
 * The only difference: the app shuffles teams (seeding 'random'); this keeps team k = seed k so the plan holds.
 */
async function lockInPools(st: State, players: string[]) {
  const hc = await asBot(st, st.bots[0].id);
  const tId = st.tournament_id!;
  const want = teamsOf(st);
  if (!sameSet(want.flat(), players)) die(`approved players are not the ${N_PLAYERS} expected; not locking in`);
  const { data: pairs } = await admin.from('doubles_pairs').select('partner_1_id, partner_2_id').eq('tournament_id', tId);
  const seededTeams = want.map(([a, b]) => {
    const p = (pairs ?? []).find((x: any) => sameSet([x.partner_1_id, x.partner_2_id], [a, b]));
    if (!p) return die(`no full pair for ${a.slice(0, 8)} + ${b.slice(0, 8)}`);
    return [p.partner_1_id, p.partner_2_id] as [string, string];
  });
  const { pools, matches } = generateDoublesPoolPlay(seededTeams, POOL_COUNT);
  const poolErr = validatePools(pools, POOL_COUNT, matches);
  if (poolErr) die('pool setup invalid: ' + poolErr.message);
  const roundIds: string[] = [];
  for (let pi = 0; pi < pools.length; pi++) {
    const { data: r, error } = await hc.from('tournament_rounds')
      .insert({ tournament_id: tId, round_number: pi + 1, label: `Pool ${String.fromCharCode(65 + pi)}`, round_type: 'pool' }).select('id').single();
    if (error) die('create pool round: ' + error.message);
    roundIds.push(r!.id);
  }
  const rows = matches.map((m, i) => ({
    tournament_id: tId, round_id: roundIds[m.poolIndex ?? 0], match_order: i, match_type: 'doubles', play_round: m.round ?? null,
    team1_player1: m.team1[0], team1_player2: m.team1[1] ?? null, team2_player1: m.team2[0], team2_player2: m.team2[1] ?? null,
  }));
  for (let i = 0; i < rows.length; i += 20) {
    const { error } = await hc.from('tournament_matches').insert(rows.slice(i, i + 20));
    if (error) die('insert matches: ' + error.message);
  }
  const { error: sErr } = await hc.from('tournaments').update({ status: 'active' }).eq('id', tId);
  if (sErr) die('set active: ' + sErr.message);
  const seedOrder = seededTeams.flat();
  for (let i = 0; i < seedOrder.length; i++) {
    const { error } = await hc.from('tournament_registrations').update({ seed: i + 1 }).eq('tournament_id', tId).eq('user_id', seedOrder[i]);
    if (error) die('seed: ' + error.message);
  }
  for (const uid of players) {
    const { error } = await hc.from('notifications').insert({
      user_id: uid, title: `🏆 Bracket Set — ${T_NAME}`,
      body: `The draw has been finalized! ${matches.length} matches scheduled. Open the tournament to see your matches.`,
      type: 'tournament', entity_id: tId, entity_type: 'tournament',
    });
    if (error) log(`  note: lock-in notification to ${uid.slice(0, 8)}: ${error.message}`);
  }
  const teamNo = (t: [string, string]) => want.findIndex((w) => sameSet(w, t)) + 1;
  log(`LOCK IN (pool play): ${rows.length} matches in ${pools.length} pools: ` +
    pools.map((p, i) => `Pool ${String.fromCharCode(65 + i)} = teams ${p.map(teamNo).join(', ')}`).join(' ; ') + `; tournament active, ${players.length} members notified`);
}

/**
 * R4, once the field is full: (1) a late bot asks to join: the field is full, so it is waitlisted (_waitlist_if_full);
 * (2) the deadline passes (the host moves it to a minute ago) and the second late bot is refused by the insert policy;
 * (3) the host taps "Generate Random Pairs" (generate_random_pairs, mode random). Each step once.
 */
async function r4LateAndPairs(st: State) {
  const tId = st.tournament_id!; const hc = await asBot(st, st.bots[0].id);
  const [late1, late2] = st.bots.slice(N_BOTS, N_BOTS + 2);
  const { data: r1 } = await admin.from('tournament_registrations').select('status').eq('tournament_id', tId).eq('user_id', late1.id).maybeSingle();
  if (!r1) {
    const { data, error } = await (await asBot(st, late1.id)).from('tournament_registrations').insert({ tournament_id: tId, user_id: late1.id }).select('status').single();
    check('R4: a request when the field is full (16 of 16) is waitlisted', !error && data?.status === 'waitlisted', error?.message ?? `status ${data?.status}`);
  }
  const { data: t } = await admin.from('tournaments').select('registration_closes_at').eq('id', tId).single() as { data: any };
  if (!t.registration_closes_at || Date.parse(t.registration_closes_at) > Date.now()) {
    const { error: de } = await hc.from('tournaments').update({ registration_closes_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', tId);
    if (de) log('deadline move: ' + de.message);
    const { error } = await (await asBot(st, late2.id)).from('tournament_registrations').insert({ tournament_id: tId, user_id: late2.id });
    check('R4: a request after the deadline is refused', !!error, 'the insert went through');
  }
  const { data: pairs } = await admin.from('doubles_pairs').select('id').eq('tournament_id', tId);
  if (!(pairs ?? []).length) {
    const { data, error } = await hc.rpc('generate_random_pairs', { p_tournament_id: tId, p_mode: 'random' });
    log(error ? `PAIRS ERROR: ${error.message}` : `host tapped "Generate Random Pairs": ${data} pairs`);
  }
}

/**
 * R4 lock-in, as useTournamentDetail.doLockIn for single elimination doubles: the pairs from doubles_pairs, seeded by
 * PLUPR (seedTeams 'elo': the pair's average rating, unrated 3.25), generateDoublesSingleElim (round 1 only: 1v8, 2v7,
 * 3v6, 4v5), one 'winners' round "Single Elimination Schedule", seeds = the seeded teams flattened.
 */
async function lockInElim(st: State, players: string[]) {
  const hc = await asBot(st, st.bots[0].id); const tId = st.tournament_id!;
  const { data: pairs } = await admin.from('doubles_pairs').select('partner_1_id, partner_2_id').eq('tournament_id', tId);
  const teams = ((pairs ?? []) as any[]).filter((p) => p.partner_1_id && p.partner_2_id).map((p) => [p.partner_1_id, p.partner_2_id] as [string, string]);
  if (teams.length !== N_PLAYERS / 2) die(`expected ${N_PLAYERS / 2} pairs, found ${teams.length}`);
  const { data: profs } = await admin.from('profiles').select('id, rating').in('id', players);
  const ratings = Object.fromEntries((profs ?? []).map((p: any) => [p.id, Number(p.rating)]));
  const seeded = seedTeams(teams, ratings, 'elo');
  const pairings = generateDoublesSingleElim(seeded);
  const { data: round, error: rErr } = await hc.from('tournament_rounds')
    .insert({ tournament_id: tId, round_number: 1, label: FORMAT_META.single_elimination.label + ' Schedule', round_type: 'winners' }).select('id').single();
  if (rErr) die('create round: ' + rErr.message);
  const rows = pairings.map((m, i) => ({ tournament_id: tId, round_id: round!.id, match_order: i, match_type: 'doubles', play_round: null,
    team1_player1: m.team1[0], team1_player2: m.team1[1] ?? null, team2_player1: m.team2[0], team2_player2: m.team2[1] ?? null }));
  const { error: mErr } = await hc.from('tournament_matches').insert(rows);
  if (mErr) die('insert matches: ' + mErr.message);
  const { error: sErr } = await hc.from('tournaments').update({ status: 'active' }).eq('id', tId);
  if (sErr) die('set active: ' + sErr.message);
  const order = seeded.flat();
  for (let i = 0; i < order.length; i++) await hc.from('tournament_registrations').update({ seed: i + 1 }).eq('tournament_id', tId).eq('user_id', order[i]);
  for (const uid of players) {
    await hc.from('notifications').insert({ user_id: uid, title: `🏆 Bracket Set — ${T_NAME}`,
      body: `The draw has been finalized! ${rows.length} matches scheduled. Open the tournament to see your matches.`,
      type: 'tournament', entity_id: tId, entity_type: 'tournament' });
  }
  const avg = (t: [string, string]) => ((ratings[t[0]] ?? 3.25) + (ratings[t[1]] ?? 3.25)) / 2;
  const sorted = seeded.every((t, i) => i === 0 || avg(seeded[i - 1]) >= avg(t));
  const shape = rows.length === 4 && [[0, 7], [3, 4], [1, 6], [2, 5]].every(([a, b], i) =>
    sameSet([rows[i].team1_player1, rows[i].team1_player2], seeded[a]) && sameSet([rows[i].team2_player1, rows[i].team2_player2], seeded[b]));
  check('R4 draw: pairs seeded by average PLUPR, round 1 in bracket order 1v8, 4v5, 2v7, 3v6 (PKL-068)', sorted && shape,
    seeded.map((t, i) => `${i + 1}: ${avg(t).toFixed(2)}`).join(' '));
  log(`LOCK IN (single elim doubles): 4 quarterfinals, seeds ${seeded.map((t, i) => `${i + 1}=${t.map((u) => st.bots.find((b) => b.id === u)?.name ?? 'Brian').join('+')}`).join(' ; ')}`);
}

/**
 * R3 completion: the bracket shape (winners rounds, losers rounds, a Grand Final), round 1 in bracket order by seed,
 * nobody out before a second loss, the champion = the Grand Final winner, and the final ranks by the elimination rule
 * (champion, runner-up, then wins, fewer losses, point diff, admin tie order, seed). Then the PKL-043 audit.
 */
async function finishR3(st: State, nm: Map<string, string>, completeAsked: boolean) {
  const tId = st.tournament_id!; const N = (id: string) => nm.get(id) ?? id.slice(0, 8);
  const { data: rounds } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId).order('round_number');
  const { data: ms0 } = await admin.from('tournament_matches').select('*').eq('tournament_id', tId);
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed, status').eq('tournament_id', tId);
  const { data: ranks } = await admin.from('tournament_final_ranks').select('user_id, final_rank, wins, losses').eq('tournament_id', tId).order('final_rank');
  const ms = ((ms0 ?? []) as any[]).filter((m) => m.status === 'completed' && m.winner_team);
  const rs = (rounds ?? []) as any[];
  const typeOf = new Map(rs.map((r) => [r.id, r.round_type]));
  const players = (regs ?? []).filter((r: any) => r.status === 'approved').map((r: any) => r.user_id as string);
  const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
  log('ROUNDS: ' + rs.map((r) => `${r.label} (${r.round_type})`).join(' -> '));
  log('COMPLETED. Final ranks:\n' + (ranks ?? []).map((r: any) => `    ${r.final_rank}. ${N(r.user_id).padEnd(14)} ${r.wins}-${r.losses}`).join('\n'));
  check('tournament auto-completed after the Grand Final', !completeAsked);
  const types = new Set(rs.map((r) => r.round_type));
  check('R3 bracket has winners rounds, losers rounds and a Grand Final', types.has('winners') && types.has('losers') && types.has('grand_final'), [...types].join(', '));
  const r1Round = rs.filter((r) => r.round_type === 'winners').sort((a, b) => a.round_number - b.round_number)[0];
  const r1 = ((ms0 ?? []) as any[]).filter((m) => m.round_id === r1Round?.id).sort((a, b) => a.match_order - b.match_order)
    .map((m) => [seedOf.get(m.team1_player1), seedOf.get(m.team2_player1)].sort((a, b) => a - b).join('v'));
  check('R3 round 1 in bracket order by seed: 1v8, 4v5, 2v7, 3v6 (PKL-068)', r1.join(' ') === '1v8 4v5 2v7 3v6', r1.join(' '));
  const won = (m: any) => (m.winner_team === 'team1' ? m.team1_player1 : m.team2_player1);
  const lost = (m: any) => (m.winner_team === 'team1' ? m.team2_player1 : m.team1_player1);
  const losses = new Map<string, number>(); for (const m of ms) losses.set(lost(m), (losses.get(lost(m)) ?? 0) + 1);
  const gf = ms.filter((m) => typeOf.get(m.round_id) === 'grand_final').sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
  const champ = gf ? won(gf) : null, runner = gf ? lost(gf) : null;
  const early = players.filter((u) => u !== champ && u !== runner && (losses.get(u) ?? 0) !== 2).map((u) => `${N(u)} ${losses.get(u) ?? 0}`);
  check('R3: nobody is out before a second loss (every player but the finalists has exactly 2 losses)', early.length === 0, early.join(' ; '));
  check('R3: the champion lost at most once, the runner-up at most twice', !!champ && (losses.get(champ!) ?? 0) <= 1 && (losses.get(runner!) ?? 0) <= 2,
    `${N(champ ?? '')} ${losses.get(champ ?? '') ?? 0} ; ${N(runner ?? '')} ${losses.get(runner ?? '') ?? 0}`);
  // ranks: the elimination rule (compute_tournament_final_ranks)
  const tie = await tieRanks(tId);
  type T = { u: string; w: number; l: number; d: number };
  const t = new Map<string, T>();
  for (const m of ms) for (const [u, mine, their, w] of [[m.team1_player1, m.team1_score, m.team2_score, m.winner_team === 'team1'], [m.team2_player1, m.team2_score, m.team1_score, m.winner_team === 'team2']] as [string, number, number, boolean][]) {
    const r = t.get(u) ?? { u, w: 0, l: 0, d: 0 }; t.set(u, r); if (w) r.w++; else r.l++; r.d += (mine ?? 0) - (their ?? 0);
  }
  const order = [...t.values()].sort((a, b) => Number(b.u === champ) - Number(a.u === champ) || Number(b.u === runner) - Number(a.u === runner)
    || b.w - a.w || a.l - b.l || b.d - a.d || (tie(PO.keyOf(a.u)) ?? 2147483647) - (tie(PO.keyOf(b.u)) ?? 2147483647) || (seedOf.get(a.u) ?? 999) - (seedOf.get(b.u) ?? 999) || (a.u < b.u ? -1 : 1));
  const want = new Map(order.map((r, i) => [r.u, i + 1]));
  const got = new Map((ranks ?? []).map((r: any) => [r.user_id, r.final_rank]));
  const bad = players.filter((u) => got.get(u) !== want.get(u)).map((u) => `${N(u)} ${got.get(u) ?? '-'}, want ${want.get(u)}`);
  check('R3 final ranks: champion 1, runner-up 2, then wins, fewer losses, ±, admin tie order, seed', bad.length === 0 && (ranks ?? []).length === players.length, bad.slice(0, 4).join(' ; '));
  try { await auditDoubles(st, tId, players); }
  catch (e: any) { check('PKL-043 audit ran', false, 'audit threw: ' + (e?.message ?? e)); }
}

/** R5 state across loop passes. */
const r5 = { cancelled: null as string | null, wagers: false, edited: null as string | null, semis: false, finals: false, reinstated: false, qf: false };
/**
 * R5, during the run: (1) right after lock-in the host cancels one round-robin match that is not on a court;
 * (2) QA Bots 2 and 3 each put 10 on a different player to win (place_wager, tournament_rank 1); (3) after a third of
 * the round robin is scored, the host edits the settings and takes Court 3 away; (4) the semifinals are RR 1v4 and 2v3
 * (PKL-052 group order); (5) the Final is the semifinal winners and the Third Place Match their losers.
 */
async function r5Extras(st: State, real: any[], rounds: any[]) {
  const tId = st.tournament_id!; const hc = await asBot(st, st.bots[0].id);
  const typeOf = new Map(rounds.map((r) => [r.id, r.round_type]));
  const group = real.filter((m) => !['semifinals', 'finals', 'third_place_match'].includes(typeOf.get(m.round_id)));
  if (!r5.cancelled && group.length) {
    const m = group.filter((x) => x.status !== 'completed' && !x.called_at).sort((a, b) => b.match_order - a.match_order)[0];
    if (m) {
      const { error } = await hc.from('tournament_matches').update({ status: 'cancelled' }).eq('id', m.id);
      r5.cancelled = m.id;
      log(error ? `CANCEL MATCH ERROR: ${error.message}` : `host cancelled round-robin match #${m.match_order}`);
      check('R5: the host can cancel a round-robin match that is not on a court', !error, error?.message);
    }
  }
  if (!r5.wagers && group.length) {
    r5.wagers = true;
    for (const [bot, pick] of [[st.bots[1], st.bots[0]], [st.bots[2], st.bots[3]]] as const) {
      const { data, error } = await (await asBot(st, bot.id)).rpc('place_wager', { p_subject_type: 'tournament_rank', p_subject_id: tId,
        p_predicate: { user_id: pick.id, rank: 1 }, p_stake: 10 });
      const row = Array.isArray(data) ? data[0] : data;
      log(error || !row?.success ? `WAGER ERROR (${bot.name}): ${error?.message ?? row?.message}` : `${bot.name} put 10 on ${pick.name} to win (pays ${row.potential_payout})`);
    }
  }
  const done = group.filter((m) => m.status === 'completed').length;
  if (!r5.edited && done >= Math.ceil(group.length / 3)) {
    r5.edited = new Date().toISOString();
    const { error } = await hc.from('tournaments').update({ courts: ['1', '2'] }).eq('id', tId);
    log(error ? `SETTINGS EDIT ERROR: ${error.message}` : 'host edited the settings mid-run: courts 1, 2, 3 -> 1, 2');
    check('R5: the host can edit the courts while the tournament runs', !error, error?.message);
  }
  const qfs = real.filter((m) => typeOf.get(m.round_id) === 'quarterfinals');
  if (R5_PO === 'top_8' && !r5.qf && qfs.length) {
    r5.qf = true;
    const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed').eq('tournament_id', tId);
    const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
    const order = PO.groupOrder(real as PO.PM[], rounds as PO.PR[], seedOf, await tieRanks(tId)).map((r) => r.lo);
    const want = [[0, 7], [1, 6], [2, 5], [3, 4]].map(([a, b]) => [order[a], order[b]].sort().join('|')).sort();
    const got = qfs.map((m) => [m.team1_player1, m.team2_player1].sort().join('|')).sort();
    check('R5 top 8: quarterfinals = round-robin 1v8, 2v7, 3v6, 4v5', JSON.stringify(want) === JSON.stringify(got), `got ${got.length} QFs`);
  }
  const semis = real.filter((m) => typeOf.get(m.round_id) === 'semifinals');
  if (R5_PO === 'top_8' && !r5.semis && semis.length && qfs.every((m) => m.status === 'completed')) {
    r5.semis = true;
    const w = (m: any) => (m.winner_team === 'team1' ? m.team1_player1 : m.team2_player1);
    const qfWinners = new Set(qfs.map(w));
    check('R5 top 8: the semifinalists are the four quarterfinal winners', semis.flatMap((m) => [m.team1_player1, m.team2_player1]).every((u) => qfWinners.has(u)) && semis.length === 2);
  }
  if (R5_PO !== 'top_8' && !r5.semis && semis.length) {
    r5.semis = true;
    const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed').eq('tournament_id', tId);
    const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
    const order = PO.groupOrder(real as PO.PM[], rounds as PO.PR[], seedOf, await tieRanks(tId)).map((r) => r.lo);
    const want = [[order[0], order[3]], [order[1], order[2]]].map((p) => p.slice().sort().join('|')).sort();
    const got = semis.map((m) => [m.team1_player1, m.team2_player1].sort().join('|')).sort();
    check('R5 semifinals = round-robin 1v4 and 2v3 (W-L, ±, admin tie order)', JSON.stringify(want) === JSON.stringify(got), `got ${got.join(' ; ')}`);
  }
  const fin = real.filter((m) => typeOf.get(m.round_id) === 'finals'), third = real.filter((m) => typeOf.get(m.round_id) === 'third_place_match');
  if (!r5.finals && fin.length && third.length && semis.every((m) => m.status === 'completed')) {
    r5.finals = true;
    const w = (m: any) => (m.winner_team === 'team1' ? m.team1_player1 : m.team2_player1), l = (m: any) => (m.winner_team === 'team1' ? m.team2_player1 : m.team1_player1);
    check('R5 Final = the semifinal winners, Third Place Match = the semifinal losers',
      [fin[0].team1_player1, fin[0].team2_player1].sort().join('|') === semis.map(w).sort().join('|')
        && [third[0].team1_player1, third[0].team2_player1].sort().join('|') === semis.map(l).sort().join('|'));
  }
}

/** R5 completion: ranks (PKL-052 rule with the playoff on top), the pot and payout, wagers settled, the cancelled match
 *  left out, no match called to Court 3 after the edit, the release time and the edit in the event log, then the audit. */
async function finishR5(st: State, nm: Map<string, string>, completeAsked: boolean) {
  const tId = st.tournament_id!; const N = (id: string) => nm.get(id) ?? id.slice(0, 8);
  const { data: ranks } = await admin.from('tournament_final_ranks').select('user_id, final_rank, wins, losses').eq('tournament_id', tId).order('final_rank');
  const { data: rounds } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId);
  const { data: ms } = await admin.from('tournament_matches').select('*').eq('tournament_id', tId);
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed, status').eq('tournament_id', tId);
  const players = (regs ?? []).filter((r: any) => r.status === 'approved').map((r: any) => r.user_id as string);
  const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
  log('COMPLETED. Final ranks:\n' + (ranks ?? []).map((r: any) => `    ${r.final_rank}. ${N(r.user_id).padEnd(14)} ${r.wins}-${r.losses}`).join('\n'));
  check('tournament auto-completed after the Final and Third Place Match', !completeAsked);
  const want = PO.finalRanks((ms ?? []) as PO.PM[], (rounds ?? []) as PO.PR[], seedOf, await tieRanks(tId), players).ranks;
  const got = new Map((ranks ?? []).map((r: any) => [r.user_id, r.final_rank]));
  const bad = players.filter((u) => got.get(u) !== want.get(u)).map((u) => `${N(u)} ${got.get(u) ?? '-'}, want ${want.get(u)}`);
  check('R5 final ranks: Final 1-2, Third Place 3-4, then the round robin (W-L, ±, admin tie order)', bad.length === 0 && (ranks ?? []).length === players.length, bad.slice(0, 4).join(' ; '));
  const cm = (ms ?? []).find((m: any) => m.id === r5.cancelled) as any;
  if (!r5.reinstated) check('R5: the cancelled match stayed cancelled, unscored, and the tournament still finished', !r5.cancelled || (cm?.status === 'cancelled' && cm?.winner_team == null),
    r5.cancelled ? `status ${cm?.status}, winner ${cm?.winner_team}` : 'nothing was cancelled');
  if (r5.edited) {
    const late = (ms ?? []).filter((m: any) => m.court === '3' && m.called_at && Date.parse(m.called_at) > Date.parse(r5.edited!) + 2000);
    check('R5: after Court 3 was taken away no match was called to it', late.length === 0, late.map((m: any) => '#' + m.match_order).join(', '));
  }
  // wagers: each won exactly when its pick finished 1st, and the winner was paid
  const { data: wg } = await admin.from('wagers').select('user_id, status, stake, potential_payout, predicate').eq('subject_id', tId).eq('subject_type', 'tournament_rank');
  const badW = (wg ?? []).filter((w: any) => (w.status === 'won') !== (got.get(w.predicate?.user_id) === 1)).map((w: any) => `${N(w.user_id)} on ${N(w.predicate?.user_id)}: ${w.status}`);
  check('R5 wagers: 2 placed, each settled won exactly when its pick finished 1st', (wg ?? []).length === 2 && badW.length === 0 && (wg ?? []).every((w: any) => w.status !== 'open'),
    `${(wg ?? []).length} wagers; ${badW.join(' ; ')}`);
  // the event log has the release time and the courts edit
  const { data: ev } = await admin.from('tournament_events').select('kind, data').eq('tournament_id', tId);
  const kinds = (ev ?? []).map((e: any) => `${e.kind}:${JSON.stringify(e.data ?? {})}`);
  check('R5 event log has the bracket release time and the mid-run courts edit', kinds.some((k) => /release/i.test(k)) && kinds.some((k) => /courts/i.test(k)),
    `${(ev ?? []).length} events`);
  await finishPot(st, N, players, want);
  try { await auditDoubles(st, tId, players); }
  catch (e: any) { check('PKL-043 audit ran', false, 'audit threw: ' + (e?.message ?? e)); }
}

// ── PKL-060 R2: MLP, random teams ─────────────────────────────────────────────
/** Bot n's PLUPR for R2: distinct values (7 is coprime with the player count when it is a multiple of 4 and 20, 16, ...). */
export function r2Rating(n: number, total: number) { return Number((2.5 + ((n * 7) % total) * 0.1).toFixed(2)); }

type MT = { id: string; name: string; seed: number | null; status: string; created_at?: string; captain_id?: string | null;
  male_1_id: string | null; male_2_id: string | null; female_1_id: string | null; female_2_id: string | null; dreambreaker_player_id: string | null };
type XM = M & { is_dreambreaker?: boolean | null; completed_at?: string | null; created_at?: string | null };
type XR = { id: string; label: string | null; round_type: string; round_number: number };
const mlpMembers = (t: MT) => [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].filter((x): x is string => !!x);
/** A small stable hash (resume-safe "random" choices). */
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** One team meeting (a tournament_round): its 4 sub-matches, the dreambreaker, and where it stands. */
export function r2Meeting(round: XR, ms: XM[], teams: MT[]) {
  const rm = ms.filter((m) => m.round_id === round.id).sort((a, b) => a.match_order - b.match_order);
  const subs = rm.filter((m) => !m.is_dreambreaker), db = rm.find((m) => !!m.is_dreambreaker) ?? null;
  const teamOf = (u: string | null | undefined) => (u ? teams.find((t) => mlpMembers(t).includes(u)) ?? null : null);
  const A = teamOf(subs[0]?.team1_player1), B = teamOf(subs[0]?.team2_player1);
  const won = (m: XM, w: string) => m.status === 'completed' && m.winner_team === w;
  const subA = subs.filter((m) => won(m, 'team1')).length, subB = subs.filter((m) => won(m, 'team2')).length;
  const aw = rm.filter((m) => won(m, 'team1')).length, bw = rm.filter((m) => won(m, 'team2')).length;
  const pts = (side: 1 | 2) => rm.filter((m) => m.status === 'completed').reduce((s, m) => s + ((side === 1 ? m.team1_score : m.team2_score) ?? 0), 0);
  const subsDone = subs.length > 0 && subs.every((m) => m.status === 'completed');
  const total = rm.length, completed = rm.filter((m) => m.status === 'completed').length;
  // _maybe_auto_close_mlp_tournament's "decided": more than half the rows won, or every row completed
  const decided = aw > Math.floor(total / 2) || bw > Math.floor(total / 2) || completed >= total
    || (subsDone && (!db || db.status === 'cancelled' || db.status === 'completed'));
  // _mlp_round_winner: sub-match wins (dreambreaker included), then points, then team seed
  const aBetter = aw !== bw ? aw > bw : pts(1) !== pts(2) ? pts(1) > pts(2) : (A?.seed ?? 999) <= (B?.seed ?? 999);
  return { round, rm, subs, db, A, B, subA, subB, aw, bw, subsDone, decided, winner: aBetter ? A : B, loser: aBetter ? B : A };
}

/**
 * R2's plan for 5 teams, by team seed (lo-hi: sub-match wins of the lower seed, then of the higher; db = who wins the
 * dreambreaker when it is 2-2). Seeds 4 and 5 finish level on sub-match W-L (6-11) and seed 5 has the better point diff
 * (it wins big and loses close, seed 4 the opposite): PKL-052 puts seed 5 into the top 4, a seed tiebreak puts seed 4.
 */
const R2_PLAN: Record<string, { a: number; b: number; db?: 'a' | 'b' }> = {
  '1-2': { a: 3, b: 1 }, '1-3': { a: 3, b: 1 }, '1-4': { a: 3, b: 1 }, '1-5': { a: 4, b: 0 },
  '2-3': { a: 2, b: 2, db: 'a' }, '2-4': { a: 3, b: 1 }, '2-5': { a: 3, b: 1 },
  '3-4': { a: 3, b: 1 }, '3-5': { a: 1, b: 3 }, '4-5': { a: 2, b: 2, db: 'a' },
};
/** The target for a meeting as sub-match wins of its team1 side (A) and team2 side (B), and the dreambreaker winner. */
export function r2Target(round: XR, aSeed: number, bSeed: number, nTeams: number, semis: string) {
  const r = h32(round.id);
  if (round.round_type === 'winners') {
    const p = nTeams === 5 ? R2_PLAN[`${Math.min(aSeed, bSeed)}-${Math.max(aSeed, bSeed)}`] : null;
    if (p) { const flip = aSeed > bSeed; return { a: flip ? p.b : p.a, b: flip ? p.a : p.b, db: (p.db === 'a') !== flip ? 'A' : 'B' } as const; }
    const a = [4, 3, 3, 2, 2, 1, 1, 0][r % 8]; return { a, b: 4 - a, db: r & 256 ? 'A' : 'B' } as const;
  }
  if (round.round_type === 'semifinals' && semis === 'dreambreaker') return { a: 2, b: 2, db: r & 1 ? 'A' : 'B' } as const;
  const aWins = !!(r & 1); return { a: aWins ? 3 : 1, b: aWins ? 1 : 3, db: aWins ? 'A' : 'B' } as const;
}
/** Winner-first score. In the 5-team plan seed 5 wins 11-0 and loses 10-12, seed 4 wins 12-10 and loses 0-11 (their
 *  own meeting is 11-9 every time); everything else is a random valid score. */
export function r2Score(wSeed: number, lSeed: number, plan5: boolean, rand = Math.random): [number, number] {
  if (plan5) {
    const pair = new Set([wSeed, lSeed]);
    if (pair.has(4) && pair.has(5)) return [11, 9];
    if (wSeed === 5) return [11, 0];
    if (lSeed === 5) return [12, 10];
    if (wSeed === 4) return [12, 10];
    if (lSeed === 4) return [11, 0];
  }
  return randomScore(rand);
}
/** PKL-086: a winner-first rally score to 21, win by 2 (21-0..21-19, now and then 22-20..24-22). */
export function r2Rally21(seed: number): [number, number] {
  const k = seed % 25;
  return k < 20 ? [21, k] : [22 + (k - 20) % 3, 20 + (k - 20) % 3];
}
/** Per team over the given matches: sub-match W, L (dreambreakers included, as mlp_team_standings) and point diff. */
export function r2Tally(ms: XM[], teams: MT[]) {
  const rows = new Map(teams.map((t) => [t.id, { team: t, wins: 0, losses: 0, diff: 0, mw: 0, ml: 0 }]));
  // PKL-084: a matchup (one round) is one W or L for the team once none of its games is open; more games won takes it.
  const byRound = new Map<string, XM[]>(); for (const m of ms) { if (!m.round_id) continue; if (!byRound.has(m.round_id)) byRound.set(m.round_id, []); byRound.get(m.round_id)!.push(m); }
  for (const list of byRound.values()) {
    if (list.some((m) => m.status !== 'completed' && m.status !== 'cancelled')) continue;
    const first = [...list].sort((a, b) => (a.match_order ?? 0) - (b.match_order ?? 0))[0];
    const A = teams.find((t) => mlpMembers(t).includes(first?.team1_player1 ?? '')), B = teams.find((t) => mlpMembers(t).includes(first?.team2_player1 ?? ''));
    const aw = list.filter((m) => m.status === 'completed' && m.winner_team === 'team1').length, bw = list.filter((m) => m.status === 'completed' && m.winner_team === 'team2').length;
    if (!A || !B || aw === bw) continue;
    const ra = rows.get(A.id)!, rb = rows.get(B.id)!;
    if (aw > bw) { ra.mw++; rb.ml++; } else { rb.mw++; ra.ml++; }
  }
  for (const m of ms) {
    if (m.status !== 'completed' || !m.winner_team) continue;
    const a = teams.find((t) => mlpMembers(t).includes(m.team1_player1 ?? '')), b = teams.find((t) => mlpMembers(t).includes(m.team2_player1 ?? ''));
    const s1 = m.team1_score ?? 0, s2 = m.team2_score ?? 0;
    const ra = a && rows.get(a.id), rb = b && rows.get(b.id);
    if (ra) { ra.diff += s1 - s2; if (m.winner_team === 'team1') ra.wins++; else ra.losses++; }
    if (rb) { rb.diff += s2 - s1; if (m.winner_team === 'team2') rb.wins++; else rb.losses++; }
  }
  return [...rows.values()];
}
type TRow = ReturnType<typeof r2Tally>[number];
/** The server's playoff order (_generate_mlp_playoff_unchecked, PKL-077 live 2026-11-23): W desc, L asc, point diff desc, seed. */
export const r2ServerOrder = (rows: TRow[]) => [...rows].sort((a, b) => b.mw - a.mw || a.ml - b.ml || b.diff - a.diff || b.wins - a.wins || a.losses - b.losses || (a.team.seed ?? 999) - (b.team.seed ?? 999));
/** PKL-052: W desc, L asc, point diff desc, then the admin's tie order (none for MLP teams yet), then seed. */
export const r2RuleOrder = r2ServerOrder; // PKL-084: matchups W-L, point diff, games W-L, seed (never head-to-head)

/** Offline: the 5-team plan through the oracle (no network). */
function planR2() {
  const teams: MT[] = Array.from({ length: 5 }, (_, i) => ({ id: `T${i + 1}`, name: `Team ${i + 1}`, seed: i + 1, status: 'locked',
    male_1_id: `m${i}a`, male_2_id: `m${i}b`, female_1_id: `f${i}a`, female_2_id: `f${i}b`, dreambreaker_player_id: `m${i}a` }));
  const ms: XM[] = []; let k = 0, dbs = 0, cancelled = 0, okMeet = true;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
    const A = teams[i], B = teams[j], round: XR = { id: `r${i}${j}`, label: `${A.name} vs ${B.name}`, round_type: 'winners', round_number: ++k };
    const tg = r2Target(round, A.seed!, B.seed!, 5, 'dreambreaker');
    const lineups = [[A.male_1_id, A.male_2_id, B.male_1_id, B.male_2_id], [A.female_1_id, A.female_2_id, B.female_1_id, B.female_2_id],
      [A.male_1_id, A.female_1_id, B.male_1_id, B.female_1_id], [A.male_2_id, A.female_2_id, B.male_2_id, B.female_2_id]];
    let aw = 0;
    lineups.forEach((l, s) => {
      const need = tg.a - aw, left = 4 - s, aWin = need >= left ? true : need <= 0 ? false : h32(`${round.id}${s}`) % left < need;
      if (aWin) aw++;
      const [w, lo] = r2Score(aWin ? A.seed! : B.seed!, aWin ? B.seed! : A.seed!, true);
      ms.push({ id: `${round.id}s${s}`, round_id: round.id, match_order: ms.length, status: 'completed', winner_team: aWin ? 'team1' : 'team2',
        team1_player1: l[0], team1_player2: l[1], team2_player1: l[2], team2_player2: l[3], team1_score: aWin ? w : lo, team2_score: aWin ? lo : w });
    });
    if (aw !== tg.a) okMeet = false;
    if (aw === 2) { dbs++; const aWin = tg.db === 'A'; const [w, lo] = r2Score(aWin ? A.seed! : B.seed!, aWin ? B.seed! : A.seed!, true);
      ms.push({ id: `${round.id}db`, round_id: round.id, match_order: ms.length, status: 'completed', winner_team: aWin ? 'team1' : 'team2', is_dreambreaker: true,
        team1_player1: A.dreambreaker_player_id, team2_player1: B.dreambreaker_player_id, team1_score: aWin ? w : lo, team2_score: aWin ? lo : w }); }
    else cancelled++;
  }
  const rows = r2Tally(ms, teams);
  const fmt = (o: TRow[]) => o.map((r) => `${r.team.name} ${r.mw}-${r.ml} (games ${r.wins}-${r.losses}) ${r.diff >= 0 ? '+' : ''}${r.diff}`).join(', ');
  const sv = r2ServerOrder(rows), rl = r2RuleOrder(rows);
  console.log(`R2 plan: 10 meetings, ${ms.length} sub-matches, ${dbs} dreambreakers played, ${cancelled} cancelled; meetings hit their targets: ${okMeet}`);
  console.log('server order (W, L, ±, seed): ' + fmt(sv));
  console.log('PKL-052 order (W, L, ±):    ' + fmt(rl));
  const t4 = rows.find((r) => r.team.seed === 4)!, t5 = rows.find((r) => r.team.seed === 5)!;
  const okTie = t4.wins === t5.wins && t4.losses === t5.losses && t5.diff > t4.diff;
  // PKL-077 live: the server now breaks the W-L tie on point diff too, so both orders put seed 5 4th.
  const okProbe = sv.every((r, i) => i === 0 || sv[i - 1].mw >= r.mw); // PKL-084: matchups first
  console.log(`seeds 4 and 5 level on W-L with seed 5 ahead on ±: ${okTie}; the order goes by matchups won first (PKL-084): ${okProbe}`);
  let okScores = true; for (let i = 0; i < 2000; i++) for (const [a, b] of [[1, 5], [5, 1], [4, 2], [2, 4], [4, 5], [1, 2]]) { const [w, l] = r2Score(a, b, true); if (!validScore(w, l)) okScores = false; }
  for (let i = 0; i < 500; i++) { const [w, l] = r2Rally21(h32('x' + i)); const hi = Math.max(w, l), d = Math.abs(w - l); if (!(hi >= 21 && d >= 2 && (hi === 21 || d === 2))) okScores = false; }
  console.log(`R2 scores valid: ${okScores}; ratings distinct for 20: ${new Set(Array.from({ length: 20 }, (_, i) => r2Rating(i + 1, 20))).size === 20}`);
  process.exit(okMeet && okTie && okProbe && okScores && dbs === 2 ? 0 : 1);
}

/** R2 state across loop passes. */
const r2 = { ratings: null as Map<string, number> | null, genders: null as Map<string, string> | null, teamsChecked: false, scheduleChecked: false,
  drawChecked: false, finalChecked: false, idle: 0, playoffForced: false, completeAsked: false, stalled: false, youMsg: '' };

/**
 * R2 before the schedule exists, as the organizer does it in the app's Teams section (MlpTeamSection):
 * (1) "Snake-Draft (balanced)" = generate_random_mlp_teams(p_mode 'snake'); (2) a Dreambreaker player per team
 * (mlp_set_dreambreaker; the server only adds the dreambreaker row when both teams have one); (3) "Generate Bracket" =
 * generate_mlp_bracket, which writes every meeting and sets the tournament active. One step per call.
 */
async function r2Draw(st: State, approved: string[]) {
  const tId = st.tournament_id!; const hc = await asBot(st, st.bots[0].id);
  const { data: t0 } = await admin.from('mlp_teams').select('*').eq('tournament_id', tId);
  const teams = (t0 ?? []) as MT[];
  if (!teams.length) {
    const { data: profs } = await admin.from('profiles').select('id, rating, gender').in('id', approved);
    r2.ratings = new Map((profs ?? []).map((p: any) => [p.id, Number(p.rating)]));
    r2.genders = new Map((profs ?? []).map((p: any) => [p.id, String(p.gender)]));
    const { data, error } = await hc.rpc('generate_random_mlp_teams', { p_tournament_id: tId, p_mode: 'snake' });
    log(error ? `TEAMS ERROR generate_random_mlp_teams: ${error.message}` : `host ${st.bots[0].name} tapped "Snake-Draft (balanced)": ${data} teams`);
    if (error) die('could not form MLP teams');
    return;
  }
  if (!r2.teamsChecked) { r2.teamsChecked = true; await r2CheckTeams(st, teams, approved); }
  const noDb = teams.filter((t) => !t.dreambreaker_player_id);
  if (noDb.length) {
    for (const t of noDb) {
      const mem = mlpMembers(t); const pick = mem[h32(t.id) % mem.length];
      const { error } = await hc.rpc('mlp_set_dreambreaker', { p_team_id: t.id, p_user_id: pick });
      log(error ? `DREAMBREAKER ERROR ${t.name}: ${error.message}` : `host set ${t.name}'s Dreambreaker player: ${st.bots.find((b) => b.id === pick)?.name}`);
    }
    return;
  }
  const { data, error } = await hc.rpc('generate_mlp_bracket', { p_tournament_id: tId });
  log(error ? `BRACKET ERROR generate_mlp_bracket: ${error.message}` : `host tapped "Generate Bracket" (generate_mlp_bracket): ${data} sub-matches`);
  if (error) die('could not generate the MLP bracket');
}

/** Teams from the snake draft: 4 per team in the right slots, everyone once, locked, and the snake pattern by PLUPR. */
async function r2CheckTeams(st: State, teams: MT[], approved: string[]) {
  const nm = (u: string | null) => (u ? st.bots.find((b) => b.id === u)?.name ?? u.slice(0, 8) : '-');
  const g = r2.genders ?? new Map(((await admin.from('profiles').select('id, gender').in('id', approved)).data ?? []).map((p: any) => [p.id, String(p.gender)]));
  const rt = r2.ratings ?? new Map(((await admin.from('profiles').select('id, rating').in('id', approved)).data ?? []).map((p: any) => [p.id, Number(p.rating)]));
  const n = approved.length / 4;
  log('TEAMS (snake draft):\n' + teams.map((t) => `    ${t.name.padEnd(22)} M ${nm(t.male_1_id)} (${rt.get(t.male_1_id!)}), ${nm(t.male_2_id)} (${rt.get(t.male_2_id!)})`
    + `  W ${nm(t.female_1_id)} (${rt.get(t.female_1_id!)}), ${nm(t.female_2_id)} (${rt.get(t.female_2_id!)})  ${t.status}`).join('\n'));
  const bad: string[] = [];
  if (teams.length !== n) bad.push(`${teams.length} teams, want ${n}`);
  const all = teams.flatMap(mlpMembers);
  if (!sameSet(all, approved)) bad.push(`${all.length} slotted players / ${new Set(all).size} distinct, ${approved.length} approved`);
  for (const t of teams) {
    if (mlpMembers(t).length !== 4) bad.push(`${t.name}: ${mlpMembers(t).length} players`);
    if (t.status !== 'locked') bad.push(`${t.name}: status ${t.status}`);
    for (const u of [t.male_1_id, t.male_2_id]) if (g.get(u!) !== 'male') bad.push(`${t.name}: ${nm(u)} in a men's slot is ${g.get(u!)}`);
    for (const u of [t.female_1_id, t.female_2_id]) if (g.get(u!) !== 'female') bad.push(`${t.name}: ${nm(u)} in a women's slot is ${g.get(u!)}`);
  }
  check(`R2 teams: the app's random-team RPC made ${n} locked teams of 4 (2 men's slots, 2 women's slots), everyone on exactly one team`, bad.length === 0, bad.slice(0, 4).join(' ; '));
  // snake: by PLUPR desc, team i = man i + man 2n+1-i, woman i + woman 2n+1-i
  const by = (sex: string) => approved.filter((u) => g.get(u) === sex).sort((a, b) => (rt.get(b) ?? 0) - (rt.get(a) ?? 0));
  const M = by('male'), F = by('female'), badS: string[] = [];
  for (const t of teams) {
    const i = M.indexOf(t.male_1_id!);
    const want = [M[i], M[2 * n - 1 - i], F[i], F[2 * n - 1 - i]];
    if (i < 0 || i >= n || ![t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].every((u, k) => u === want[k]))
      badS.push(`${t.name}: ${[t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].map(nm).join(', ')}; want ${want.map((u) => nm(u ?? null)).join(', ')}`);
  }
  check('R2 snake draft by PLUPR: team i = the i-th and (2n+1-i)-th best man and the i-th and (2n+1-i)-th best woman', badS.length === 0, badS.slice(0, 3).join(' ; '));
}

/** Once the schedule exists: team seeds (PLUPR order), every team meets every other team once, each meeting's lineups. */
async function r2CheckSchedule(st: State, teams: MT[], rounds: XR[], ms: XM[]) {
  const nm = (u: string | null | undefined) => (u ? st.bots.find((b) => b.id === u)?.name ?? u.slice(0, 8) : '-');
  const rt = r2.ratings ?? new Map();
  // seeds: generate_mlp_bracket numbers the locked teams by created_at; the draft wrote them in snake order
  const bestMan = (t: MT) => rt.get(t.male_1_id!) ?? 0;
  const draftOrder = [...teams].sort((a, b) => bestMan(b) - bestMan(a));
  const seeds = draftOrder.map((t) => t.seed);
  const sameTime = new Set(teams.map((t) => t.created_at)).size === 1;
  log(`TEAM SEEDS (generate_mlp_bracket, by created_at${sameTime ? '; every team has the same created_at' : ''}): ` + [...teams].sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99)).map((t) => `${t.seed}=${t.name}`).join(' '));
  check('R2 team seeds follow PLUPR: the draft\'s team 1 (best man and woman) is seed 1, team 2 seed 2, ...', seeds.every((s, i) => s === i + 1),
    `draft order has seeds ${seeds.join(',')}${sameTime ? ' (all teams share one created_at, so the seed order is arbitrary)' : ''}`);
  const rr = rounds.filter((r) => r.round_type === 'winners');
  const n = teams.length, bad: string[] = [];
  if (rr.length !== (n * (n - 1)) / 2) bad.push(`${rr.length} meetings, want ${(n * (n - 1)) / 2}`);
  const seen = new Map<string, number>();
  for (const r of rr) {
    const mt = r2Meeting(r, ms, teams);
    if (!mt.A || !mt.B || mt.A.id === mt.B.id) { bad.push(`${r.label}: teams not found`); continue; }
    const k = [mt.A.id, mt.B.id].sort().join('|'); seen.set(k, (seen.get(k) ?? 0) + 1);
    const A = mt.A, B = mt.B;
    const want = [[A.male_1_id, A.male_2_id, B.male_1_id, B.male_2_id], [A.female_1_id, A.female_2_id, B.female_1_id, B.female_2_id],
      [A.male_1_id, A.female_1_id, B.male_1_id, B.female_1_id], [A.male_2_id, A.female_2_id, B.male_2_id, B.female_2_id]];
    const got = mt.subs.map((m) => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2]);
    if (mt.subs.length !== 4 || want.some((w, i) => JSON.stringify(w) !== JSON.stringify(got[i])) || mt.subs.some((m) => m.match_type !== 'doubles'))
      bad.push(`${r.label}: sub-matches are not Men's, Women's, Mixed 1, Mixed 2`);
    // PKL-086: each side lists its 4 in order of play: the captain's Dreambreaker pick first, then the roster.
    const dbOrder = (t: MT) => { const ro = [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].filter((x): x is string => !!x);
      return t.dreambreaker_player_id && ro.includes(t.dreambreaker_player_id) ? [t.dreambreaker_player_id, ...ro.filter((x) => x !== t.dreambreaker_player_id)] : ro; };
    const db: any = mt.db;
    if (!db || db.match_type !== 'singles' || db.status !== 'pending' || JSON.stringify(db.db_order_team1) !== JSON.stringify(dbOrder(A))
        || JSON.stringify(db.db_order_team2) !== JSON.stringify(dbOrder(B)) || db.team1_player1 !== dbOrder(A)[0] || db.team2_player1 !== dbOrder(B)[0])
      bad.push(`${r.label}: dreambreaker ${db ? `${(db.db_order_team1 ?? [db.team1_player1]).map(nm).join('>')} v ${(db.db_order_team2 ?? [db.team2_player1]).map(nm).join('>')} (${db.match_type}, ${db.status})` : 'missing'}`);
    if (r.label !== `${A.name} vs ${B.name}`) bad.push(`label "${r.label}"`);
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const k = [teams[i].id, teams[j].id].sort().join('|');
    if (seen.get(k) !== 1) bad.push(`${teams[i].name} v ${teams[j].name}: ${seen.get(k) ?? 0} meetings`);
  }
  check(`R2 schedule: every team meets every other team once (${(n * (n - 1)) / 2} meetings); each is Men's, Women's, Mixed 1, Mixed 2 + a singles dreambreaker between the two Dreambreaker players`,
    bad.length === 0, bad.slice(0, 4).join(' ; '));
  // PKL-076 (fixed 2026-11-24): the Manage checklist's Generate (useTournamentDetail.generateBracket) calls
  // generate_mlp_bracket like the Teams section, and Lock in refuses MLP, so the app can no longer write men-only rows.
  // This run's schedule came from generate_mlp_bracket (checked above); here, the app source takes that path too.
  const src = fs.readFileSync(path.join(repo, 'mobile', 'src', 'components', 'tournament', 'useTournamentDetail.ts'), 'utf8');
  const mlpBranch = src.slice(Math.max(0, src.indexOf('const { data: mlpRows')));
  check('R2 Manage checklist path builds the same MLP schedule (generate_mlp_bracket, not the men-only local rows; Lock in refuses MLP) (PKL-076)',
    mlpBranch.slice(0, 3000).includes("rpc('generate_mlp_bracket'") && !src.includes('generateMLPSchedule(') && src.includes('MLP schedules are built by Generate'),
    'useTournamentDetail.generateBracket / doLockIn still take the local path');
}

/** Every meeting: a dreambreaker is played exactly when the 4 sub-matches split 2-2 and is cancelled once a team has 3. */
function r2CheckMeetings(label: string, rounds: XR[], ms: XM[], teams: MT[]) {
  const bad: string[] = []; let played = 0, cancelled = 0;
  for (const r of rounds) {
    const mt = r2Meeting(r, ms, teams);
    if (!mt.db) { bad.push(`${r.label}: no dreambreaker row`); continue; }
    if (mt.subA >= 3 || mt.subB >= 3) { if (mt.db.status !== 'cancelled') bad.push(`${r.label}: ${mt.subA}-${mt.subB}, dreambreaker ${mt.db.status}`); else cancelled++; }
    else if (mt.subsDone && mt.subA === 2) { if (mt.db.status !== 'completed') bad.push(`${r.label}: 2-2, dreambreaker ${mt.db.status}`); else played++; }
    if (mt.db.status === 'completed' && !(mt.subsDone && mt.subA === 2)) bad.push(`${r.label}: dreambreaker played at ${mt.subA}-${mt.subB}`);
  }
  check(`${label}: a dreambreaker is played exactly when a meeting splits 2-2 and cancelled once a team has 3 (${played} played, ${cancelled} cancelled)`,
    bad.length === 0, bad.slice(0, 4).join(' ; '));
}

/**
 * One pass of the R2 loop once the schedule exists. Returns 'scored' | 'wait' | 'stop'.
 * Bots score sub-matches in match order (meeting by meeting) to the plan; a dreambreaker only once its meeting is 2-2.
 */
async function r2Tick(st: State, nm: Map<string, string>): Promise<'scored' | 'wait' | 'stop'> {
  const tId = st.tournament_id!; const N = (u: string | null | undefined) => (u ? nm.get(u) ?? u.slice(0, 8) : '-');
  const { data: rs0 } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId).order('round_number');
  const { data: ms0 } = await admin.from('tournament_matches').select('*').eq('tournament_id', tId).order('match_order');
  const { data: tm0 } = await admin.from('mlp_teams').select('*').eq('tournament_id', tId);
  const rounds = (rs0 ?? []) as XR[], ms = (ms0 ?? []) as XM[], teams = (tm0 ?? []) as MT[];
  const tn = (t: MT | null | undefined) => (t ? `${t.name} (seed ${t.seed})` : '?');
  if (!r2.scheduleChecked) { r2.scheduleChecked = true; await r2CheckSchedule(st, teams, rounds, ms); }
  const rr = rounds.filter((r) => r.round_type === 'winners');
  const semis = rounds.filter((r) => r.round_type === 'semifinals'), fin = rounds.filter((r) => r.round_type === 'finals');
  const playoff = rounds.filter((r) => ['quarterfinals', 'semifinals', 'finals', 'third_place_match'].includes(r.round_type));
  const rrMs = ms.filter((m) => rr.some((r) => r.id === m.round_id));

  // the playoff draw, once, as soon as it exists and before anyone scores it
  if (playoff.length && !r2.drawChecked) {
    r2.drawChecked = true;
    r2CheckMeetings('R2 round robin', rr, ms, teams);
    const rows = r2Tally(rrMs, teams);
    const rowsAll = r2Tally(ms, teams); // what mlp_team_standings counts (every completed game, playoff ones too)
    const { data: srv } = await (await asBot(st, st.bots[0].id)).rpc('mlp_team_standings', { p_tournament_id: tId });
    const sRows = (srv ?? []) as any[];
    log('ROUND ROBIN DONE. Team standings (sub-matches W-L, ±, seed):\n' + r2RuleOrder(rows).map((r, i) =>
      `    ${i + 1}. ${r.team.name.padEnd(22)} ${r.wins}-${r.losses}  ${r.diff >= 0 ? '+' : ''}${r.diff}  seed ${r.team.seed}`).join('\n'));
    const badSt = rowsAll.filter((r) => { const s = sRows.find((x) => x.team_id === r.team.id); return !s || s.sub_matches_won !== r.wins || s.sub_matches_lost !== r.losses || (s.point_diff !== undefined && s.point_diff !== r.diff); })
      .map((r) => { const s = sRows.find((x) => x.team_id === r.team.id); return `${r.team.name} server ${s?.sub_matches_won ?? '-'}-${s?.sub_matches_lost ?? '-'}, results ${r.wins}-${r.losses}`; });
    check('R2 team standings (mlp_team_standings) = the sub-match results, dreambreakers included', badSt.length === 0 && sRows.length === teams.length, badSt.slice(0, 3).join(' ; '));
    const first = playoff.filter((r) => r.round_type === 'semifinals');
    const got = first.map((r) => { const mt = r2Meeting(r, ms, teams); return [mt.A?.id, mt.B?.id].sort().join('|'); }).sort();
    const pairs = (o: TRow[]) => [[o[0], o[3]], [o[1], o[2]]].map((p) => p.map((x) => x?.team.id).sort().join('|')).sort();
    const sv = r2ServerOrder(rows), rl = r2RuleOrder(rows);
    const txt = (o: TRow[]) => `${o[0]?.team.name} v ${o[3]?.team.name}, ${o[1]?.team.name} v ${o[2]?.team.name}`;
    const gotTxt = first.map((r) => r.label).join(' ; ');
    check('R2 playoff: semifinals are created on their own after the round robin (top 4, 1v4 and 2v3)', first.length === 2 && !r2.playoffForced, `${first.length} semifinal meetings${r2.playoffForced ? ' (the host had to press Generate playoff)' : ''}`);
    check('R2 playoff draw = the server\'s own standings order (sub-match W, L, point diff, seed): 1v4, 2v3', JSON.stringify(got) === JSON.stringify(pairs(sv)), `got ${gotTxt}; want ${txt(sv)}`);
    check('R2 playoff draw by the PKL-052 rule (W-L, then point diff, then the admin tie order; never head-to-head): 1v4, 2v3',
      JSON.stringify(got) === JSON.stringify(pairs(rl)), `got ${gotTxt}; PKL-052 wants ${txt(rl)} (${rl.slice(2, 5).map((r) => `${r.team.name} ${r.wins}-${r.losses} ${r.diff >= 0 ? '+' : ''}${r.diff}`).join(', ')})`);
    const early = ms.filter((m) => playoff.some((r) => r.id === m.round_id) && m.status === 'completed');
    if (st.brian) { if (early.length) log(`info: ${early.length} playoff game(s) were already scored when the draw was checked (a player can score one right away); the draw comes from the round robin only`); }
    else check('no playoff sub-match is already scored when the checks run', early.length === 0);
  }
  if (fin.length && !r2.finalChecked && semis.length && semis.every((r) => r2Meeting(r, ms, teams).decided)) {
    r2.finalChecked = true;
    r2CheckMeetings('R2 semifinals', semis, ms, teams);
    const winners = semis.map((r) => r2Meeting(r, ms, teams).winner?.id).sort().join('|');
    const fm = r2Meeting(fin[0], ms, teams);
    check('R2 Final = the two semifinal winners (sub-match wins, dreambreaker included)', fin.length === 1 && [fm.A?.id, fm.B?.id].sort().join('|') === winners,
      `final ${fin.map((r) => r.label).join(' ; ')}; semifinal winners ${semis.map((r) => tn(r2Meeting(r, ms, teams).winner)).join(', ')}`);
  }

  // the next sub-match to score: meetings in round order, sub-matches in match order. Live: a sub-match Brian plays in
  // is his to enter on the phone; the bots skip it and score the others.
  const me = st.brian ?? null;
  const mine = (x: XM) => !!me && four(x).includes(me);
  let waitingOnYou: string[] = [];
  for (const r of [...rr, ...[...playoff].sort((a, b) => a.round_number - b.round_number)]) {
    const mt = r2Meeting(r, ms, teams);
    if (!mt.A || !mt.B) continue;
    if (fin.some((f) => f.id === r.id) && mt.decided) continue; // the Final is over once a team has 3
    const tg = r2Target(r, mt.A.seed ?? 99, mt.B.seed ?? 99, teams.length, R2_SEMIS);
    const myPending = mt.subs.filter((x) => x.status === 'pending' && mine(x));
    if (myPending.length) waitingOnYou.push(`${r.label} · ${myPending.map((x) => ["Men's", "Women's", 'Mixed 1', 'Mixed 2'][mt.subs.indexOf(x)]).join(', ')}`);
    let m = mt.subs.find((x) => x.status === 'pending' && !mine(x)) ?? null;
    let aWin: boolean;
    if (m) {
      const left = mt.subs.filter((x) => x.status === 'pending').length, need = tg.a - mt.subA;
      aWin = need >= left ? true : need <= 0 ? false : h32(m.id) % left < need;
    } else if (mt.db && mt.db.status === 'pending' && mt.subsDone && mt.subA === 2 && mt.subB === 2) {
      if (mine(mt.db)) { waitingOnYou.push(`${r.label} · Dreambreaker`); continue; }
      m = mt.db; aWin = tg.db === 'A';
    }
    else continue;
    const W = aWin ? mt.A : mt.B, L = aWin ? mt.B : mt.A;
    // PKL-086: a rotating Dreambreaker is one rally game to 21, win by 2 (the server refuses anything else)
    const [w, l] = m.is_dreambreaker && (m as any).db_order_team1 ? r2Rally21(h32(m.id + 'db'))
      : r2Score(W.seed ?? 99, L.seed ?? 99, teams.length === 5 && r.round_type === 'winners');
    const s1 = aWin ? w : l, s2 = aWin ? l : w;
    const reporter = four(m)[h32(m.id + 'r') % four(m).length];
    const bc = await asBot(st, reporter);
    // what MatchEntryScreen writes for a single-game tournament match (the bots have a gender: no overrides)
    const { data: upd, error } = await bc.from('tournament_matches').update({
      team1_score: s1, team2_score: s2, game_scores: null, winner_team: aWin ? 'team1' : 'team2', status: 'completed',
      team1_player1_gender_override: null, team1_player2_gender_override: null,
      team2_player1_gender_override: null, team2_player2_gender_override: null,
    }).eq('id', m.id).select('id');
    const kind = m.is_dreambreaker ? 'Dreambreaker' : ["Men's", "Women's", 'Mixed 1', 'Mixed 2'][mt.subs.indexOf(m)] ?? 'sub-match';
    const side = (a: string | null | undefined, b: string | null | undefined) => (b ? `${N(a)} & ${N(b)}` : N(a));
    if (error || !upd?.length) { log(`SCORE ERROR ${r.label} ${kind}: ${error?.message ?? 'no row updated (RLS?)'}`); return 'stop'; }
    log(`SCORE ${r.label} · ${kind}: ${side(m.team1_player1, m.team1_player2)} ${s1}-${s2} ${side(m.team2_player1, m.team2_player2)}  (entered by ${N(reporter)})`
      + `  [meeting ${mt.subA + (aWin && !m.is_dreambreaker ? 1 : 0)}-${mt.subB + (!aWin && !m.is_dreambreaker ? 1 : 0)}${m.is_dreambreaker ? `, dreambreaker to ${W.name}` : ''}]`);
    r2.idle = 0;
    return 'scored';
  }

  // nothing for the bots to score
  if (waitingOnYou.length) {
    if (r2.youMsg !== waitingOnYou.join('|')) { r2.youMsg = waitingOnYou.join('|'); log(`YOUR TURN: enter ${waitingOnYou.join(' ; ')} on your phone (MatchEntry from the tournament page)`); }
    r2.idle = 0;
    return 'wait';
  }
  // nothing to score: what should have happened on its own?
  r2.idle++;
  const G = fast ? 5 : 8;
  if (r2.idle < G) return 'wait';
  const lingering = rr.concat(playoff).map((r) => r2Meeting(r, ms, teams)).filter((mt) => mt.db?.status === 'pending' && (mt.subA >= 3 || mt.subB >= 3));
  if (lingering.length) {
    check('R2: a dreambreaker is cancelled once a team has 3 sub-match wins', false, lingering.map((mt) => `${mt.round.label} ${mt.subA}-${mt.subB}, dreambreaker still pending`).join(' ; '));
    return 'stop';
  }
  if (!playoff.length) {
    if (r2.playoffForced) { log('STUCK: the playoff did not appear even after Generate playoff'); return 'stop'; }
    const hc = await asBot(st, st.bots[0].id);
    const { data, error } = await hc.rpc('generate_mlp_playoff', { p_tournament_id: tId });
    r2.playoffForced = true; r2.idle = 0;
    log(`the playoff did not appear on its own after the last round-robin match; host pressed "Generate playoff" (MlpPlayoffPreview): ${error ? 'ERROR ' + error.message : data + ' sub-matches'}`);
    return 'wait';
  }
  if (semis.length && !fin.length && semis.every((r) => r2Meeting(r, ms, teams).decided)) {
    r2.stalled = true;
    const ev = semis.map((r) => { const mt = r2Meeting(r, ms, teams); return `${r.label}: ${mt.subA}-${mt.subB}, dreambreaker ${mt.db?.status ?? 'none'}, winner ${mt.winner?.name}`; });
    check('R2 Final is created once both semifinals are decided (_advance_mlp_playoff_round)', false,
      `no Final after ${G} idle passes; ${ev.join(' ; ')}. The trigger counts every semifinal row with status <> 'completed' as pending, so a cancelled dreambreaker blocks it`);
    log('STOPPED: the Final never came, there is no app button for it, and nothing is left to score. Cleanup removes the tournament.');
    return 'stop';
  }
  if (fin.length && r2Meeting(fin[0], ms, teams).decided && !r2.completeAsked) {
    r2.completeAsked = true; r2.idle = 0;
    check('R2 tournament auto-completed once the Final was decided (_maybe_auto_close_mlp_tournament)', false, 'still active');
    const { error } = await (await asBot(st, st.bots[0].id)).rpc('admin_complete_tournament', { p_tournament_id: tId });
    log(error ? `COMPLETE ERROR: ${error.message}` : 'host pressed "Complete tournament" (admin_complete_tournament)');
    return 'wait';
  }
  if (r2.idle > G * 3) {
    log('STUCK: nothing to score and nothing changing: ' + rounds.map((r) => { const mt = r2Meeting(r, ms, teams); return `${r.label} ${mt.subA}-${mt.subB} db ${mt.db?.status ?? '-'}`; }).join(' ; '));
    check('R2 run reached the end', false, 'stuck with nothing to score');
    return 'stop';
  }
  return 'wait';
}

/** R2 completion: auto-close, the champion, every meeting's dreambreaker, the final ranks, then the PKL-043 audit. */
async function finishR2(st: State, nm: Map<string, string>) {
  const tId = st.tournament_id!; const N = (id: string) => nm.get(id) ?? id.slice(0, 8);
  const { data: rs0 } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId).order('round_number');
  const { data: ms0 } = await admin.from('tournament_matches').select('*').eq('tournament_id', tId);
  const { data: tm0 } = await admin.from('mlp_teams').select('*').eq('tournament_id', tId);
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed, status').eq('tournament_id', tId);
  const { data: ranks } = await admin.from('tournament_final_ranks').select('user_id, final_rank, wins, losses').eq('tournament_id', tId).order('final_rank');
  const rounds = (rs0 ?? []) as XR[], ms = (ms0 ?? []) as XM[], teams = (tm0 ?? []) as MT[];
  const players = (regs ?? []).filter((r: any) => r.status === 'approved').map((r: any) => r.user_id as string);
  const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
  const teamOf = (u: string) => teams.find((t) => mlpMembers(t).includes(u));
  log('COMPLETED. Final ranks:\n' + (ranks ?? []).map((r: any) => `    ${String(r.final_rank).padStart(2)}. ${N(r.user_id).padEnd(12)} ${teamOf(r.user_id)?.name.padEnd(22) ?? ''} ${r.wins}-${r.losses}`).join('\n'));
  check('R2 tournament auto-completed after the Final (no "Complete tournament")', !r2.completeAsked);
  const fin = rounds.filter((r) => r.round_type === 'finals');
  const fm = fin[0] ? r2Meeting(fin[0], ms, teams) : null;
  if (!r2.finalChecked) r2CheckMeetings('R2 semifinals', rounds.filter((r) => r.round_type === 'semifinals'), ms, teams);
  const pendingFinal = fm ? fm.subs.filter((m) => m.status === 'pending').length : 0;
  log(`CHAMPION: ${fm?.winner?.name ?? '?'} (${fm ? `${fm.aw}-${fm.bw} in the Final` : 'no Final'}): ${fm?.winner ? mlpMembers(fm.winner).map(N).join(', ') : ''}`
    + (pendingFinal ? `; ${pendingFinal} Final sub-match(es) left unplayed (the tournament closed at 3 wins)` : ''));
  check('R2 champion = the Final winner by sub-match wins', !!fm && !!fm.winner && (fm.aw >= 3 || fm.bw >= 3), fm ? `${fm.aw}-${fm.bw}` : 'no Final');
  // PKL-078 (live 2026-11-23, Brian: "Whole team shares the place"): places are by team. Final winner 1, Final loser 2,
  // the semifinal losers 3 and 4 by the team standings, then the rest by the team standings (W, L, point diff, seed).
  const got = new Map((ranks ?? []).map((r: any) => [r.user_id, r.final_rank]));
  void seedOf;
  const semisR = rounds.filter((r) => r.round_type === 'semifinals');
  const semiLosers = semisR.map((r) => r2Meeting(r, ms, teams).loser).filter((t): t is MT => !!t);
  const rrRounds = rounds.filter((r) => r.round_type === 'winners');
  const order = r2ServerOrder(r2Tally(ms.filter((m) => rrRounds.some((r) => r.id === m.round_id)), teams)).map((x) => x.team);
  const want = new Map<string, number>();
  const teamOrder = [fm?.winner, fm?.loser, ...order.filter((t) => semiLosers.some((x) => x.id === t.id)),
    ...order.filter((t) => t.id !== fm?.winner?.id && t.id !== fm?.loser?.id && !semiLosers.some((x) => x.id === t.id))].filter((t): t is MT => !!t);
  teamOrder.forEach((t, i) => mlpMembers(t).forEach((u) => want.set(u, i + 1)));
  const badR = players.filter((u) => got.get(u) !== want.get(u)).map((u) => `${N(u)} (${teamOf(u)?.name}) ${got.get(u) ?? '-'}, want ${want.get(u)}`);
  check(`R2 final places by team (PKL-078): every player takes the team's place; Final winners 1, runners-up 2, semifinal losers 3-4, then the rest`,
    badR.length === 0 && (ranks ?? []).length === players.length, badR.slice(0, 4).join(' ; '));
  try { await auditDoubles(st, tId, players); }
  catch (e: any) { check('PKL-043 audit ran', false, 'audit threw: ' + (e?.message ?? e)); }
}

async function lockIn(st: State, players: string[]) {
  if (R4) return lockInElim(st, players);
  if (POOLS) return lockInPools(st, players);
  if (DOUBLES) return lockInDoubles(st, players);
  const hc = await asBot(st, st.bots[0].id);
  const tId = st.tournament_id!;
  const { data: profs } = await admin.from('profiles').select('id, rating').in('id', players);
  const ratings = Object.fromEntries((profs ?? []).map((p: any) => [p.id, Number(p.rating)]));
  const seeded = seedPlayers(players, ratings, R5 ? 'elo' : 'random');
  const pairings: MatchPairing[] = R3 ? generateDoubleElim(seeded) : generateRoundRobin(seeded);
  const { data: round, error: rErr } = await hc.from('tournament_rounds')
    .insert({ tournament_id: tId, round_number: 1, label: FORMAT_META[R3 ? 'double_elimination' : 'round_robin'].label + ' Schedule', round_type: 'winners' }).select('id').single();
  if (rErr) die('create round: ' + rErr.message);
  const rows = pairings.map((m, i) => ({
    tournament_id: tId, round_id: round!.id, match_order: i, match_type: 'singles', play_round: R3 ? null : m.round ?? null,
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
  // PKL-050 pool play
  let poolsDone = false, tieChecked = false, finalsChecked = false;
  let tieSeen: { letter: string; position: number; keys: string[] } | null = null;
  /** "QA Pair 3 (QA Bot 5 & QA Bot 6)" for an entrant key. */
  const teamLabel = (k: string | null) => {
    if (!k) return 'BYE';
    const i = POOLS ? teamsOf(st).findIndex((t) => PO.keyOf(t[0], t[1]) === k) : -1;
    return `${i >= 0 ? `QA Pair ${i + 1} ` : ''}(${PO.membersOf(k).map((u) => N(u)).join(' & ')})`;
  };

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
  // PKL-050 pool plans: [{ a: "team:1", b: "team:8", score: [a, b], by?: "opp" }], matched by lineup (any order).
  // by "opp": in a match with Brian, a bot on the OTHER side enters it once the match has been on court a minute.
  type PoolPlanRow = { a: string; b: string; score: [number, number]; by?: string };
  const poolPlan = (m: M): { score: [number, number]; by?: string } | null => {
    if (!POOLS) return null;
    const T = teamsOf(st);
    const team = (ref: string) => { const n = Number(ref.split(':')[1]); return T[n - 1] ?? die(`plan ref ${ref}: no such team`); };
    const t1 = [m.team1_player1, m.team1_player2 ?? null], t2 = [m.team2_player1, m.team2_player2 ?? null];
    for (const p of plan as unknown as PoolPlanRow[]) {
      const a = team(p.a), b = team(p.b);
      if (sameSet(a, t1) && sameSet(b, t2)) return { score: [p.score[0], p.score[1]], by: p.by };
      if (sameSet(a, t2) && sameSet(b, t1)) return { score: [p.score[1], p.score[0]], by: p.by };
    }
    return null;
  };
  const planned = (m: M, stage: string, seedOf: Map<string, number>): [number, number] | null => {
    if (POOLS) return stage === 'group' ? poolPlan(m)?.score ?? null : null;
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

    const { data: t } = await admin.from('tournaments').select(POOLS ? 'status, playoff_format, format, match_type, pool_count, playoff_third_place, pickle_ante, prize_pool'
      : DOUBLES ? 'status, playoff_format, format, match_type, pickle_ante, prize_pool' : 'status, playoff_format').eq('id', tId).single() as { data: any };
    if (!t) return die('tournament is gone');
    const { data: regs } = await admin.from('tournament_registrations').select('user_id, status, seed, role').eq('tournament_id', tId);
    const approved = (regs ?? []).filter((r: any) => r.status === 'approved').map((r: any) => r.user_id as string);
    const { data: rounds } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId).order('round_number');
    const { data: ms0 } = await admin.from('tournament_matches')
      .select('id, round_id, match_order, status, winner_team, match_type, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score, court, called_at').eq('tournament_id', tId).order('match_order');
    const ms = (ms0 ?? []) as M[];
    const roundOf = new Map((rounds ?? []).map((r: any) => [r.id, r]));
    const stageOf = (m: M) => { const rt = roundOf.get(m.round_id)?.round_type;
      return rt === 'finals' || rt === 'third_place_match' || rt === 'semifinals' || rt === 'quarterfinals' ? rt : 'group'; };
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
      if (POOLS && !formatChecked) {
        formatChecked = true;
        check(`tournament is pool_play / doubles / ${POOL_COUNT} pools / ${PLAYOFF} + third place / ante ${ANTE}`,
          t.format === 'pool_play' && t.match_type === 'doubles' && t.playoff_format === PLAYOFF && t.pool_count === POOL_COUNT
            && t.playoff_third_place === true && t.pickle_ante === ANTE,
          `format ${t.format}, match_type ${t.match_type}, pools ${t.pool_count}, playoff ${t.playoff_format}, third ${t.playoff_third_place}, ante ${t.pickle_ante}`);
      }
      if (R3 && !formatChecked) {
        formatChecked = true;
        const { data: tt } = await admin.from('tournaments').select('format, match_type, seeding, courts').eq('id', tId).single() as { data: any };
        check('R3 tournament is double_elimination / singles / random seeding / no courts',
          tt.format === 'double_elimination' && tt.match_type === 'singles' && tt.seeding === 'random' && !(tt.courts ?? []).some((c: string) => c?.trim()), JSON.stringify(tt));
      }
      if (R5 && !formatChecked) {
        formatChecked = true;
        const { data: tt } = await admin.from('tournaments').select('format, match_type, playoff_format, playoff_third_place, pickle_ante, courts, bracket_release_time').eq('id', tId).single() as { data: any };
        check(`R5 tournament is round_robin / singles / ${R5_PO} + third place / ante 50 / 3 courts / release time set`,
          tt.format === 'round_robin' && tt.match_type === 'singles' && tt.playoff_format === R5_PO && tt.playoff_third_place === true
            && tt.pickle_ante === ANTE && (tt.courts ?? []).length === 3 && !!tt.bracket_release_time, JSON.stringify(tt));
      }
      if (R2 && !formatChecked) {
        formatChecked = true;
        const { data: tt } = await admin.from('tournaments').select('format, match_type, team_creation, seeding, mlp_play_format, mlp_playoff_teams, courts').eq('id', tId).single() as { data: any };
        check('R2 tournament is mlp_random / doubles / random teams / PLUPR seeding / round robin + playoff top 4 / no courts',
          tt.format === 'mlp_random' && tt.match_type === 'doubles' && tt.team_creation === 'random' && tt.seeding === 'elo'
            && tt.mlp_play_format === 'round_robin_playoff' && tt.mlp_playoff_teams === 4 && !(tt.courts ?? []).some((c: string) => c?.trim()), JSON.stringify(tt));
      }
      if (R4 && !formatChecked) {
        formatChecked = true;
        const { data: tt } = await admin.from('tournaments').select('format, match_type, team_creation, registration_mode, seeding, max_players').eq('id', tId).single() as { data: any };
        check('R4 tournament is single_elimination / doubles / random pairs / join by request / PLUPR seeding / max 16',
          tt.format === 'single_elimination' && tt.match_type === 'doubles' && tt.team_creation === 'random' && tt.registration_mode === 'request'
            && tt.seeding === 'elo' && tt.max_players === N_PLAYERS, JSON.stringify(tt));
      }
      if (DOUBLES && !POOLS && !R4 && !formatChecked) {
        formatChecked = true;
        check(`doubles tournament is rotating_partners / doubles / playoff_format none${R7 ? ` / ante ${ANTE}` : ''}`,
          t.format === 'rotating_partners' && t.match_type === 'doubles' && t.playoff_format === 'none' && (!R7 || t.pickle_ante === ANTE),
          `format ${t.format}, match_type ${t.match_type}, playoff_format ${t.playoff_format}, ante ${t.pickle_ante}`);
      }
      if (R4 && st.brian && (regs ?? []).some((r: any) => r.user_id === st.brian && r.status === 'pending')) {
        const hc = await asBot(st, st.bots[0].id);
        const { error } = await hc.from('tournament_registrations').update({ status: 'approved' }).eq('tournament_id', tId).eq('user_id', st.brian);
        log(error ? `APPROVE ERROR (Brian): ${error.message}` : `host ${st.bots[0].name} approved your request to join`);
        await sleep(2000); continue;
      }
      if (approved.length < N_PLAYERS) {
        const msg = `waiting: ${approved.length}/${N_PLAYERS} approved` + (st.brian && !approved.includes(st.brian) ? ' (Brian has not accepted the invite yet)' : '');
        if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg; await sleep(5000); continue;
      }
      if (POOLS && !(await ensurePools(st, regs ?? []))) {
        const msg = st.brian ? 'waiting: pairs forming. ACCEPT THE PARTNER INVITE on your phone (QA Bot 15 invited you to QA Pair 8; Notifications or the tournament page)'
          : 'waiting: pairs forming';
        if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg; await sleep(fast ? FAST_MS : 5000); continue;
      }
      if (R2) { await r2Draw(st, approved); await sleep(fast ? FAST_MS : 5000); continue; }
      if (R7) await ensureCoAdmin(st, regs ?? []);
      if (R4) await r4LateAndPairs(st);
      await lockIn(st, approved); await sleep(fast ? FAST_MS : 5000); continue;
    }

    if (R2) {
      const step = await r2Tick(st, nm);
      if (step === 'stop') break;
      await sleep(step === 'scored' ? (fast ? FAST_MS : intervalMs) : 3000);
      continue;
    }
    const playoffTypes = POOLS || R5 ? ['quarterfinals', 'semifinals', 'finals', 'third_place_match'] : ['finals', 'third_place_match'];
    const groupIds = new Set((rounds ?? []).filter((r: any) => !playoffTypes.includes(r.round_type)).map((r: any) => r.id));
    const real = ms.filter((m) => m.team1_player1 && m.team2_player1);
    const pending = real.filter((m) => m.status !== 'completed' && m.status !== 'cancelled');
    if (R5) await r5Extras(st, real as any[], (rounds ?? []) as any[]);
    const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));

    // 0. playoff checks, once, as soon as the playoff rounds exist and BEFORE anyone scores them
    //    (rehearsal 1 scored the Final first and so never ran these)
    // 0b. PKL-050: the pool playoff draw = top N per pool under the PKL-052 rule, then the finals from the semis
    if (POOLS && (rounds ?? []).some((r: any) => playoffTypes.includes(r.round_type))) {
      const pr = (rounds ?? []) as PO.PR[];
      const tie = await tieRanks(tId);
      if (!playoffChecked) {
        playoffChecked = true;
        const tables = PO.poolTables(ms as PO.PM[], pr, seedOf, tie);
        const seeds = PO.perPoolSeeds(tables, PER_POOL);
        const shape = PO.perPoolPairings(tables.length, PER_POOL);
        const first = pr.filter((r) => playoffTypes.includes(r.round_type)).sort((a, b) => a.round_number - b.round_number)[0];
        const firstMs = ms.filter((m) => m.round_id === first.id);
        const bad: string[] = [];
        if (!shape) bad.push(`no bracket shape for ${tables.length} pools x top ${PER_POOL}`);
        else {
          if (first.round_type !== shape.roundType) bad.push(`first playoff round is ${first.round_type}, want ${shape.roundType}`);
          shape.pairs.forEach(([a, b], i) => {
            const m = firstMs.find((x) => x.match_order === i);
            const wantA = seeds[a - 1], wantB = b ? seeds[b - 1] : null;
            const gotA = m?.team1_player1 ? PO.keyOf(m.team1_player1, m.team1_player2 ?? null) : null;
            const gotB = m?.team2_player1 ? PO.keyOf(m.team2_player1, m.team2_player2 ?? null) : null;
            if (gotA !== wantA || gotB !== wantB) bad.push(`#${i}: ${teamLabel(gotA)} v ${teamLabel(gotB)}, want ${teamLabel(wantA)} v ${teamLabel(wantB)}`);
          });
        }
        const seedTxt = seeds.map((k, i) => `${i + 1}=${teamLabel(k)}`).join(' ');
        check(`playoff draw = top ${PER_POOL} per pool by W-L, then ±, then the admin's tie order (seeds ${seedTxt})`, bad.length === 0, bad.join(' ; '));
        check('no playoff match is already scored when the checks run',
          !ms.some((m) => !groupIds.has(m.round_id) && m.status === 'completed' && m.team2_player1));
      }
      const semis = ms.filter((m) => roundOf.get(m.round_id)?.round_type === 'semifinals' && m.team1_player1 && m.team2_player1);
      const fin = ms.filter((m) => roundOf.get(m.round_id)?.round_type === 'finals');
      const third = ms.filter((m) => roundOf.get(m.round_id)?.round_type === 'third_place_match');
      if (!finalsChecked && semis.length && semis.every((m) => m.status === 'completed') && fin.some((m) => m.team1_player1 && m.team2_player1)) {
        finalsChecked = true;
        const sk = (m: M, w: boolean) => ((m.winner_team === 'team1') === w ? PO.keyOf(m.team1_player1!, m.team1_player2 ?? null) : PO.keyOf(m.team2_player1!, m.team2_player2 ?? null));
        const keysOf = (m?: M) => (m?.team1_player1 && m.team2_player1 ? [PO.keyOf(m.team1_player1, m.team1_player2 ?? null), PO.keyOf(m.team2_player1, m.team2_player2 ?? null)].sort().join('|') : '');
        const winners = semis.map((m) => sk(m, true)).sort().join('|'), losers = semis.map((m) => sk(m, false)).sort().join('|');
        check('Final = the two semifinal winners', fin.length === 1 && keysOf(fin[0]) === winners,
          `final ${keysOf(fin[0]).split('|').map(teamLabel).join(' v ')}; semi winners ${winners.split('|').map(teamLabel).join(', ')}`);
        check('Third Place Match = the two semifinal losers (playoff_third_place on)', third.length === 1 && keysOf(third[0]) === losers,
          `${third.length} third-place match(es): ${keysOf(third[0]).split('|').map(teamLabel).join(' v ')}; semi losers ${losers.split('|').map(teamLabel).join(', ')}`);
      }
    }
    if (!POOLS && !R4 && !R5 && !playoffChecked && (rounds ?? []).some((r: any) => playoffTypes.includes(r.round_type))) {
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
    // PKL-050: a match of Brian's planned "by opp" is entered by a bot on the other side, a minute after its court call
    const oppSide = (m: M) => (st.brian && (m.team1_player1 === st.brian || m.team1_player2 === st.brian)
      ? [m.team2_player1, m.team2_player2] : [m.team1_player1, m.team1_player2]).filter((x): x is string => !!x);
    const oppReady = (m: M) => POOLS && !!st.brian && four(m).includes(st.brian) && stageOf(m) === 'group' && poolPlan(m)?.by === 'opp'
      && !!m.called_at && Date.now() - Date.parse(m.called_at) > (fast ? 5000 : 60_000);
    const botMatch = DOUBLES ? pending.find((m) => four(m).length === 4 && (four(m).every(isBot) || oppReady(m)) && (!COURTS || !!m.called_at))
      : pending.find((m) => isBot(m.team1_player1) && isBot(m.team2_player1));
    if (botMatch) {
      const reporter = oppReady(botMatch) ? oppSide(botMatch)[Math.floor(Math.random() * oppSide(botMatch).length)]
        : DOUBLES ? four(botMatch)[Math.floor(Math.random() * 4)]
        : Math.random() < 0.5 ? botMatch.team1_player1! : botMatch.team2_player1!;
      if (oppReady(botMatch)) log(`OPPONENT ENTERS your match #${botMatch.match_order} now: watch for the "Entered by ${N(reporter)}" push`);
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
        const byOpp = POOLS && stageOf(m) === 'group' && poolPlan(m)?.by === 'opp';
        return `#${m.match_order}: you + partner ${N(partner ?? null)} v ${opp}${where}` +
          (byOpp ? `  -> DON'T ENTER: your opponent enters ${side(m.team1_player1, m.team1_player2)} ${p![0]}, ${side(m.team2_player1, m.team2_player2)} ${p![1]} a minute after the court call`
          : p ? `  -> ENTER team ${side(m.team1_player1, m.team1_player2)} ${p[0]}, team ${side(m.team2_player1, m.team2_player2)} ${p[1]} (score plan)`
          : POOLS && stageOf(m) !== 'group' ? '  -> ENTER any valid score (playoff)' : ''); }).join(' ; ');
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
    // 3b. PKL-050: pools done. A tie the app makes the admin order first, then "Generate playoff".
    //     Live: Brian does both on his phone (he is a co-admin); rehearsal or control word "host": the host bot does.
    if (POOLS && playoffRounds.length === 0) {
      const hostDoes = REHEARSAL || control() === 'host';
      const pr = (rounds ?? []) as PO.PR[];
      const tie = await tieRanks(tId);
      const tables = PO.poolTables(ms as PO.PM[], pr, seedOf, tie);
      if (!poolsDone) {
        poolsDone = true;
        check('tournament is still active after the last pool match (no early auto-close)', t.status === 'active', `status ${t.status}`);
        log('POOLS DONE. Standings (W-L, then ±, then the admin tie order):\n' + tables.map((tb) => `  Pool ${tb.letter}\n` + tb.rows.map((r, i) =>
          `    ${i + 1}. ${teamLabel(r.key).padEnd(34)} ${r.wins}-${r.losses}  ${r.diff >= 0 ? '+' : ''}${r.diff}  ${r.tie != null ? `admin #${r.tie}` : ''}`).join('\n')).join('\n'));
      }
      const block = PO.tieBlock(tables, PER_POOL);
      if (block) {
        tieSeen = tieSeen ?? block;
        const names = block.keys.map(teamLabel).join(', ');
        if (!hostDoes) {
          const msg = `TIE WAITING FOR YOU: Pool ${block.letter} has a tie at ${block.position}${['st', 'nd', 'rd'][block.position - 1] ?? 'th'} (${names}). `
            + 'Open the tournament -> Standings -> Set tie order, put them in the order you want, save. (Write "host" into control.txt to let the host do it.)';
          if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg; await sleep(5000); continue;
        }
        const pref = TIE_ORDER.map((ref) => { const tm = teamsOf(st)[Number(ref.split(':')[1]) - 1]; return tm ? PO.keyOf(tm[0], tm[1]) : ''; });
        const ordered = [...block.keys].sort((a, b) => ((pref.indexOf(a) + 1) || 99) - ((pref.indexOf(b) + 1) || 99) || block.keys.indexOf(b) - block.keys.indexOf(a));
        const hc = await asBot(st, st.bots[0].id);
        const { error } = await hc.rpc('set_tournament_tie_order', { p_tournament_id: tId, p_entrant_keys: ordered });
        log(error ? `TIE ORDER ERROR: ${error.message}` : `TIE ORDER set by host ${st.bots[0].name} (Set tie order sheet): ${ordered.map(teamLabel).join(' > ')}`);
        await sleep(fast ? FAST_MS : 5000); continue;
      }
      if (tieSeen && !tieChecked) {
        tieChecked = true;
        const { data: rows } = await admin.from('tournament_tie_orders').select('entrant_key, tie_rank, set_by').eq('tournament_id', tId);
        const mine = (rows ?? []).filter((r: any) => tieSeen!.keys.includes(r.entrant_key)).sort((a: any, b: any) => a.tie_rank - b.tie_rank);
        log(`tie order saved for Pool ${tieSeen.letter}: ${mine.map((r: any) => `${teamLabel(r.entrant_key)} #${r.tie_rank}`).join(', ')}`);
        log(`tie order set by ${[...new Set(mine.map((r: any) => N(r.set_by)))].join(', ')}${st.brian && mine.every((r: any) => r.set_by === st.brian) ? ' (you, as co-admin, on your phone)' : ''}`);
        check('the tie order covers every team in the tie, each with its own rank', mine.length === tieSeen.keys.length && new Set(mine.map((r: any) => r.tie_rank)).size === mine.length);
      }
      if (!hostDoes) {
        const msg = 'PRESS "Generate playoff" on your phone (tournament page, admin section). (Write "host" into control.txt to let the host do it.)';
        if (msg !== lastWaitMsg) log(msg); lastWaitMsg = msg; await sleep(5000); continue;
      }
      if (playoffAsked) { await sleep(5000); continue; }
      await sleep(fast ? 3000 : 15000);
      const hc = await asBot(st, st.bots[0].id);
      const { error } = await hc.rpc('generate_playoff_bracket', { p_tournament_id: tId });
      playoffAsked = true;
      log(error ? 'PLAYOFF ERROR generate_playoff_bracket: ' + error.message : `PLAYOFF generated by host ${st.bots[0].name} (the app's "Generate playoff" button)`);
      continue;
    }
    if (playoffRounds.length === 0 && !DOUBLES && !R3) {
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
      if (error && R5 && r5.cancelled && /still pending/.test(error.message)) {
        check('R5: a cancelled round-robin match does not block Generate playoff', false, error.message);
        // Put the match back (status pending) so the bots play it and the run can go on to the playoff.
        await admin.from('tournament_matches').update({ status: 'pending', court: '1', called_at: new Date().toISOString() }).eq('id', r5.cancelled);
        log('R5: the cancelled match was put back to pending so the run can continue (the finding above stands)');
        r5.reinstated = true; playoffAsked = false;
      } else if (error) log('PLAYOFF ERROR generate_playoff_bracket: ' + error.message);
      else log(`PLAYOFF generated by host ${st.bots[0].name} (the app's "Generate playoff" button)`);
      continue;
    }

    // 5. everything scored, still active: let a trigger complete it, else the host completes it (admin button)
    if (!completeAsked) {
      finalSeen++;
      if (finalSeen < (fast ? 2 : 4)) { log('all matches done; waiting for the tournament to complete itself'); await sleep(fast ? 3000 : 15000); continue; }
      completeAsked = true;
      if (DOUBLES) check(POOLS ? 'tournament auto-completed after the Final and Third Place Match' : R4 ? 'tournament auto-completed after the Final' : 'tournament auto-completed after the last match (rotating_partners, playoff none)',
        false, `status ${t.status} after all ${real.length} matches`);
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
  if (R4) await finishElim(st, N, players, ranks ?? []);
  else if (!POOLS) check(`${N_PLAYERS} final ranks stored, 1..${N_PLAYERS} with no gaps`, rk.length === N_PLAYERS && rk.every((r: number, i: number) => r === i + 1), `got ${rk.join(',')}`);
  if (POOLS) await finishPools(st, N, players, ranks ?? []);
  else if (!R4) check('no playoff rounds on a rotating tournament', !(rounds ?? []).some((r: any) => ['finals', 'third_place_match'].includes(r.round_type)));
  if (!POOLS && !R4) {
    // PKL-052 rule (no head-to-head, no rating), ported from compute_tournament_final_ranks' per-player branch.
    const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
    const pr = PO.playerRanks((full ?? []) as PO.PM[], players, seedOf, await tieRanks(tId));
    const got = new Map((ranks ?? []).map((r: any) => [r.user_id, r.final_rank]));
    const badR = players.filter((u) => got.get(u) !== pr.ranks.get(u)).map((u) => `${N(u)} rank ${got.get(u) ?? '-'}, want ${pr.ranks.get(u)}`);
    check('final ranks = per-player standings (wins, fewer losses, point diff, then the admin tie order; no head-to-head)', badR.length === 0, badR.slice(0, 4).join(' ; '));
    if (pr.levels.length) log('level players (same W, L, diff; the admin tie order or seed decides): ' + pr.levels.map((g) => g.map(N).join(' = ')).join(' ; '));
    if (R7) await finishPot(st, N, players, pr.ranks);
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
 * PKL-050: pool play completion. Final ranks = compute_tournament_final_ranks ported (Final 1-2, Third Place 3-4,
 * then deepest playoff round, then the group order across pools: W, fewer L, ±, admin tie order, seed); teammates
 * share a rank. Then the ante pot: pot = ante x players, and "Pay out" (auto_payout_tournament) pays each of the top
 * 3 places floor(floor(pot x 60/25/15%) / 2) per player. Live: Brian presses "Pay out" (or control word "host").
 */
async function finishPools(st: State, N: (id: string) => string, players: string[], ranks: any[]) {
  const tId = st.tournament_id!;
  const { data: rounds } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId);
  const { data: ms } = await admin.from('tournament_matches')
    .select('id, round_id, match_order, status, winner_team, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score').eq('tournament_id', tId);
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed, status').eq('tournament_id', tId);
  const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
  const want = PO.finalRanks((ms ?? []) as PO.PM[], (rounds ?? []) as PO.PR[], seedOf, await tieRanks(tId), players).ranks;
  const got = new Map(ranks.map((r: any) => [r.user_id, r.final_rank]));
  const bad = players.filter((u) => got.get(u) !== want.get(u)).map((u) => `${N(u)} rank ${got.get(u) ?? '-'}, want ${want.get(u)}`);
  check(`final ranks: Final 1-2, Third Place 3-4, then group order across pools (W-L, ±, admin tie order); partners share a rank`,
    bad.length === 0 && ranks.length === players.length, `${ranks.length} rows; ${bad.slice(0, 4).join(' ; ')}`);
  await finishPot(st, N, players, want);
}
/**
 * R4 completion: the bracket folded the standard way (quarterfinal slot i meets slot 3-i in the semis, the semis winners
 * meet in the Final) and the final ranks follow compute_tournament_final_ranks' elimination rule: the champion pair,
 * the runner-up pair, then wins, fewer losses, point diff, the admin tie order, seed. Partners share a rank.
 */
async function finishElim(st: State, N: (id: string) => string, players: string[], ranks: any[]) {
  const tId = st.tournament_id!;
  const { data: rounds } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId).order('round_number');
  const { data: ms0 } = await admin.from('tournament_matches').select('id, round_id, match_order, status, winner_team, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score').eq('tournament_id', tId);
  const ms = (ms0 ?? []) as any[];
  const rs = (rounds ?? []) as any[];
  const byRound = rs.map((r) => ms.filter((m) => m.round_id === r.id).sort((a, b) => a.match_order - b.match_order));
  const key = (a: string | null, b: string | null) => [a, b].filter(Boolean).sort().join(':');
  const winner = (m: any) => (m?.winner_team === 'team1' ? key(m.team1_player1, m.team1_player2) : m?.winner_team === 'team2' ? key(m.team2_player1, m.team2_player2) : '');
  const sides = (m: any) => [key(m.team1_player1, m.team1_player2), key(m.team2_player1, m.team2_player2)].sort().join('|');
  log('ROUNDS: ' + rs.map((r, i) => `${r.label ?? r.round_type} (${r.round_type}, ${byRound[i].length})`).join(' -> '));
  const qf = byRound[0] ?? [], sf = byRound[1] ?? [], fin = byRound[2] ?? [];
  const wantSf = [[0, 1], [2, 3]].map(([a, b]) => [winner(qf[a]), winner(qf[b])].sort().join('|'));
  check('R4 bracket: 4 quarterfinals, 2 semifinals, 1 Final, in that order', rs.length === 3 && qf.length === 4 && sf.length === 2 && fin.length === 1,
    rs.map((r, i) => `${r.round_type}:${byRound[i].length}`).join(' '));
  check('R4 fold: semifinal 1 = winners of 1v8 and 4v5, semifinal 2 = winners of 2v7 and 3v6 (seeds 1 and 2 only meet in the Final)',
    sf.length === 2 && sides(sf[0]) === wantSf[0] && sides(sf[1]) === wantSf[1], `got ${sf.map(sides).join(' ; ')}`);
  check('R4 Final = the two semifinal winners', fin.length === 1 && sides(fin[0]) === [winner(sf[0]), winner(sf[1])].sort().join('|'));
  // the rank rule
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, seed').eq('tournament_id', tId);
  const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
  const tie = await tieRanks(tId);
  type T = { k: string; w: number; l: number; d: number; seed: number };
  const tm = new Map<string, T>();
  for (const m of ms.filter((x) => x.status === 'completed' && x.winner_team)) {
    for (const [k, mine, their, won] of [[key(m.team1_player1, m.team1_player2), m.team1_score, m.team2_score, m.winner_team === 'team1'],
      [key(m.team2_player1, m.team2_player2), m.team2_score, m.team1_score, m.winner_team === 'team2']] as [string, number, number, boolean][]) {
      const t = tm.get(k) ?? { k, w: 0, l: 0, d: 0, seed: Math.min(...k.split(':').map((u) => seedOf.get(u) ?? 999)) }; tm.set(k, t);
      if (won) t.w++; else t.l++; t.d += (mine ?? 0) - (their ?? 0);
    }
  }
  const champ = winner(fin[0]), runner = fin[0] ? sides(fin[0]).split('|').find((x) => x !== champ) : '';
  const order = [...tm.values()].sort((a, b) => Number(b.k === champ) - Number(a.k === champ) || Number(b.k === runner) - Number(a.k === runner)
    || b.w - a.w || a.l - b.l || b.d - a.d || (tie(a.k) ?? 2147483647) - (tie(b.k) ?? 2147483647) || a.seed - b.seed || (a.k < b.k ? -1 : 1));
  const want = new Map<string, number>(); order.forEach((t, i) => t.k.split(':').forEach((u) => want.set(u, i + 1)));
  const got = new Map(ranks.map((r: any) => [r.user_id, r.final_rank]));
  const bad = players.filter((u) => got.get(u) !== want.get(u)).map((u) => `${N(u)} ${got.get(u) ?? '-'}, want ${want.get(u)}`);
  check('R4 final ranks: champion pair 1, runner-up 2, then wins, fewer losses, ±, admin tie order, seed; partners share a rank',
    bad.length === 0 && ranks.length === players.length, `${ranks.length} rows; ${bad.slice(0, 4).join(' ; ')}`);
}

/** The ante pot (PKL-050, PKL-060): every ante paid in, then the payout (Brian presses Pay out as co-admin; PKL-056
 *  lets him) matches preview_tournament_payout: floor(floor(pot x pct / 100) / people at that place). */
async function finishPot(st: State, N: (id: string) => string, players: string[], want: Map<string, number>) {
  const tId = st.tournament_id!;
  const { data: t0 } = await admin.from('tournaments').select('prize_pool, pickle_ante, payout_structure, champion_payout_applied_at').eq('id', tId).single() as { data: any };
  const { data: contrib } = await admin.from('pickle_pot_contributions').select('user_id, amount_paid, kind').eq('scope_type', 'tournament').eq('scope_id', tId);
  const paidAnte = (contrib ?? []).filter((c: any) => c.kind === 'ante');
  check(`every player paid the ${ANTE} ante into the pot (${players.length} x ${ANTE} = ${players.length * ANTE})`,
    paidAnte.length === players.length && paidAnte.every((c: any) => Number(c.amount_paid) === ANTE),
    `${paidAnte.length} ante rows: ${[...new Set(paidAnte.map((c: any) => c.amount_paid))].join(',')}`);
  const pot = t0.champion_payout_applied_at ? players.length * ANTE : Number(t0.prize_pool);
  if (!t0.champion_payout_applied_at) check(`prize pool = ${players.length * ANTE} before the payout`, pot === players.length * ANTE, `prize_pool ${t0.prize_pool}`);
  for (let w = 0; !t0.champion_payout_applied_at; w++) {
    const { data: tx } = await admin.from('tournaments').select('champion_payout_applied_at').eq('id', tId).single() as { data: any };
    if (tx?.champion_payout_applied_at) break;
    if (REHEARSAL || control() === 'host' || !st.brian) {
      const hc = await asBot(st, st.bots[0].id);
      const { data, error } = await hc.rpc('auto_payout_tournament', { p_tournament_id: tId });
      log(error ? `PAYOUT ERROR: ${error.message}` : `PAYOUT by host ${st.bots[0].name} (the app's "Pay out" button): ${JSON.stringify(data)}`);
      break;
    }
    if (w === 0) log('PRESS "Pay out" on your phone (tournament page, prize pot card) and confirm. As a tournament co-admin you may '
      + '(PKL-056). If it refuses, write "host" into control.txt and the host pays out.');
    await sleep(5000);
  }
  const { data: pays } = await admin.from('pickle_pot_payouts').select('user_id, amount').eq('scope_type', 'tournament').eq('scope_id', tId);
  const expected = PO.potShares(pot, (t0.payout_structure ?? [60, 25, 15]).map(Number), want);
  const paidOf = new Map<string, number>(); for (const p of pays ?? []) paidOf.set(p.user_id, (paidOf.get(p.user_id) ?? 0) + Number(p.amount));
  const badP = [...new Set([...expected.keys(), ...paidOf.keys()])].filter((u) => (paidOf.get(u) ?? 0) !== (expected.get(u) ?? 0))
    .map((u) => `${N(u)} paid ${paidOf.get(u) ?? 0}, want ${expected.get(u) ?? 0}`);
  check(`prize pot paid: places 1-3 get ${(t0.payout_structure ?? [60, 25, 15]).join('/')}% of ${pot}${POOLS ? ', split between partners' : ''}`, badP.length === 0 && (pays ?? []).length > 0, badP.slice(0, 4).join(' ; '));
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
    .select('id, round_id, created_at, match_order, status, winner_team, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score, completed_at, play_round, court, called_at, plupr_delta, plupr_global_weight, plupr_category, plupr_ratings, plupr_applied_at, is_dreambreaker, db_order_team1')
    .eq('tournament_id', tId).order('match_order');
  const { data: rds } = await admin.from('tournament_rounds').select('id, label, round_type, round_number').eq('tournament_id', tId);
  const rdOf = new Map((rds ?? []).map((r: any) => [r.id, r]));
  const PLAYOFF_T = ['quarterfinals', 'semifinals', 'finals', 'third_place_match', 'grand_final', 'losers'];
  // PKL-086: a rotating Dreambreaker is a team game (no PLUPR, player count or match pay), so the per-player audit skips it.
  const ms = ((ms0 ?? []) as any[]).filter((m) => m.status === 'completed' && m.team1_player1 && m.team2_player1 && !(m.is_dreambreaker && m.db_order_team1));
  // _pl_tm_player_matches: round number, then match order, then created_at
  // MLP (PKL-060 R2): the notices (_pl_tm_player_matches) count every row that is not cancelled at the time, so a
  // dreambreaker counts until its meeting reaches 3 sub-match wins (it is cancelled in that same write) and a Final
  // sub-match left unplayed when the tournament closed counts too. Those rows join the player's list, never the scores.
  const goneAt = new Map<string, number>();
  const extraRows = ((R2 ? ms0 ?? [] : []) as any[]).filter((m) => m.team1_player1 && m.team2_player1 && m.status !== 'completed'
    && (m.status === 'pending' || (m.status === 'cancelled' && m.is_dreambreaker))
    && !(m.is_dreambreaker && m.db_order_team1)); // PKL-086: a rotating Dreambreaker is no one's personal match
  for (const x of extraRows.filter((m) => m.status === 'cancelled')) {
    const subs = ms.filter((m) => m.round_id === x.round_id && !m.is_dreambreaker).sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
    let a = 0, b = 0;
    for (const m of subs) { if (m.winner_team === 'team1') a++; else b++; if (a >= 3 || b >= 3) { goneAt.set(x.id, Date.parse(m.completed_at)); break; } }
  }
  const byOrder = [...ms, ...extraRows].sort((a, b) => (rdOf.get(a.round_id)?.round_number ?? 0) - (rdOf.get(b.round_id)?.round_number ?? 0)
    || a.match_order - b.match_order || String(a.created_at).localeCompare(String(b.created_at)));
  const byDone = [...ms].sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
  const mineOf = (p: string) => byOrder.filter((m) => four(m).includes(p));
  /** The player's matches that existed at time T (a playoff match is only counted once it was drawn). */
  const mineAt = (p: string, T: number) => mineOf(p).filter((m) => !(Date.parse(m.created_at) > T + 1500) && !((goneAt.get(m.id) ?? Infinity) <= T));
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
  /** _pl_tm_byes: rounds of the player's own group (round_id) with no match for them. */
  const byesOf = (p: string) => {
    const grp = mineOf(p).find((m) => m.play_round != null)?.round_id;
    if (grp === undefined) return [] as number[];
    const last = Math.max(0, ...ms.filter((m) => m.round_id === grp).map((m) => m.play_round ?? 0));
    const played = new Set(mineOf(p).filter((m) => m.round_id === grp).map((m) => m.play_round));
    return Array.from({ length: last }, (_, i) => i + 1).filter((r) => !played.has(r));
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
    const list = mineAt(p, T); const open = list.filter((x) => openAt(x, T));
    const x = open.find((y) => calledAt(y, T)) ?? open[0];
    return x ? { x, k: list.indexOf(x) + 1, n: list.length } : null;
  };
  const upNextAt = (p: string, T: number) => {
    const nx = nextAt(p, T); if (!nx) return null;
    const bb = byesBefore(p, nx.x);
    const rd = rdOf.get(nx.x.round_id);
    const rt = rd && PLAYOFF_T.includes(rd.round_type) ? ` (${rd.label ?? 'playoff'})`
      : nx.x.play_round == null ? '' : ` (round ${nx.x.play_round}${bb.length ? `, after your ${bb.length > 1 ? 'byes' : 'bye'} in ${rText(bb)}` : ''})`;
    return `Up next${rt}: ${line(nx.x, p)} (your match ${nx.k} of ${nx.n}).${courtTxt(nx.x, T)}`;
  };
  /** The "Up next" text a player should get once match m is in, or null when they have nothing open. */
  const upNext = (m: any, p: string) => upNextAt(p, ts(m.completed_at));

  const { data: notes0 } = await admin.from('notifications').select('id, user_id, title, body, push_data, created_at')
    .eq('entity_id', tId).eq('type', 'tournament').gte('created_at', st.created_at).order('created_at');
  const notes = (notes0 ?? []) as any[];
  // A player who tapped "Clear all" (NotificationsScreen) has no notification rows of any age: their alerts can't be
  // audited. Their lines are reported as "cleared by the player", not as failures (R2 live 2026-11-24).
  const cleared = new Set<string>();
  for (const p of players) {
    if (notes.some((n) => n.user_id === p)) continue;
    const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', p);
    if (!count) cleared.add(p);
  }
  if (cleared.size) log(`info: alerts cleared by the player (no notification rows at all, "Clear all"): ${[...cleared].map(N).join(', ')}; their A1/A2/A4/B2 lines are not counted`);
  const notCleared = (xs: string[]) => xs.filter((x) => ![...cleared].some((p) => x.startsWith(N(p) + ':') || x.includes(` ${N(p)} (entered it)`) || x.startsWith(`#`) && x.includes(` ${N(p)} `)));
  const kindOf = (n: any) => n.push_data?.kind ?? '';
  const { data: pay0 } = await admin.from('tournament_match_bonus_grants').select('match_id, user_id, paid').in('match_id', ms.map((m) => m.id));
  const payOf = new Map((pay0 ?? []).map((g: any) => [`${g.match_id}|${g.user_id}`, Number(g.paid)]));
  const payTxt = (n: number | undefined) => (n && n > 0 ? `+${n} 🥒 for the match.` : null);
  const bad: string[] = [];

  // A1. "your first match", once each
  for (const p of players) {
    const first = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_ready' && (n.title ?? '').startsWith(`🏓 ${tName} is on: `));
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
  const badA1 = notCleared(bad);
  check('A1 every player gets one first-match alert: the right match, round, court, and "Bye in round 1" when they sit out first',
    badA1.length === 0, badA1.slice(0, 4).join(' ; '));

  // A2 + A3. score alerts and "Up next"
  const bad2: string[] = [], bad3: string[] = [];
  let reporterUnknown = 0;
  for (const m of ms) {
    const ns = notes.filter((n) => kindOf(n) === 'tm_score' && n.title.includes(tName) && four(m).includes(n.user_id)
      && (n.body ?? '').startsWith(line(m, n.user_id) + ', ')
      && Math.abs(Date.parse(n.created_at) - Date.parse(m.completed_at)) < 1500);
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
  const badA2 = notCleared(bad2), badA3 = notCleared(bad3);
  check('A2 each score: the 3 others get "you won/lost a-b, Entered by", match pay; the one who entered it gets pay + Up next',
    badA2.length === 0 && reporterUnknown === 0, `${reporterUnknown ? `${reporterUnknown} match(es) with no "Entered by"; ` : ''}${badA2.slice(0, 4).join(' ; ')}`);
  check('A3 "Up next" names each player\'s next open match (partner, opponents, "match k of 8")', badA3.length === 0, badA3.slice(0, 4).join(' ; '));

  // A4. final placement
  const { data: ranks } = await admin.from('tournament_final_ranks').select('user_id, final_rank').eq('tournament_id', tId);
  const { data: pp } = await admin.from('tournament_placement_grants').select('user_id, paid').eq('tournament_id', tId);
  const placePay = new Map((pp ?? []).map((g: any) => [g.user_id, Number(g.paid)]));
  const ord = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  const bad4: string[] = [];
  const places = new Set(((ranks ?? []) as any[]).map((r) => r.final_rank)).size;
  const { data: tf } = await admin.from('tournaments').select('format').eq('id', tId).single() as { data: any };
  const staged = ['round_robin', 'pool_play'].includes(tf?.format) && (rds ?? []).some((r: any) => !['winners', 'pool'].includes(r.round_type));
  const rrOf = new Map<string, number>();
  if (staged) {
    const { data: regsA } = await admin.from('tournament_registrations').select('user_id, seed').eq('tournament_id', tId);
    const seedA = new Map((regsA ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
    const gAll = ((ms0 ?? []) as any[]) as PO.PM[];
    PO.groupOrder(gAll, (rds ?? []) as PO.PR[], seedA, await tieRanks(tId)).forEach((r, i) => { for (const u of PO.membersOf(r.key)) rrOf.set(u, i + 1); });
  }
  for (const r of (ranks ?? []) as any[]) {
    const k = r.final_rank as number, p = r.user_id as string;
    const title = k === 1 ? `🥇 You won ${tName}!` : k === 2 ? `🥈 2nd place in ${tName}` : k === 3 ? `🥉 3rd place in ${tName}` : `🏁 ${tName}: you finished ${ord(k)}`;
    const pay = placePay.get(p);
    const body = [`Final placement: ${ord(k)} of ${places}.`, staged && rrOf.has(p) ? `Round robin: ${ord(rrOf.get(p)!)}.` : null, pay && pay > 0 ? `+${pay} 🥒 placement pay.` : null, 'Open the tournament for the final table.'].filter(Boolean).join(' ');
    const hit = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_finished');
    if (hit.length !== 1 || hit[0].title !== title || hit[0].body !== body) bad4.push(`${N(p)}: x${hit.length} "${hit[0]?.title ?? ''} | ${hit[0]?.body ?? ''}" want "${title} | ${body}"`);
  }
  const badA4 = notCleared(bad4);
  check('A4 one final-placement alert each, with the right place and placement pay', badA4.length === 0 && (ranks ?? []).length === players.length, badA4.slice(0, 3).join(' ; '));
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
  if (st.brian && cleared.has(st.brian)) log('B2 not checked: your alerts were cleared on the phone ("Clear all"), so their pushes are gone too.');
  else if (st.brian) {
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
        const hit = notes.filter((n) => n.user_id === p && kindOf(n) === 'tm_court' && (n.body ?? '').startsWith(line(m, p) + '.')
          && Math.abs(Date.parse(n.created_at) - ts(m.called_at)) < 1500);
        const want = `${line(m, p)}. Head to ${cLabel(m.court)} now.`;
        if (hit.length !== 1 || hit[0].title !== `🏓 You're on ${cLabel(m.court)} in ${tName}` || hit[0].body !== want)
          badE2.push(`#${m.match_order} ${N(p)}: x${hit.length}${hit[0] ? ` "${hit[0].title} | ${hit[0].body}"` : ''}`);
      }
    }
    check('E2 each later call sends its 4 players "You\'re on Court N" naming the match', badE2.length === 0, badE2.slice(0, 4).join(' ; '));

    // E3 (PKL-061): the queue keeps round order. At each call: no player of the match still had an earlier-round
    // match of the same group to play, and its round was at most one ahead of the group's lowest open round.
    const badE3: string[] = [];
    const openAtT = (x: any, T: number) => !(ts(x.completed_at) <= T);
    for (const m of called.filter((x: any) => x.play_round != null)) {
      const T = ts(m.called_at);
      const grp = ms.filter((x: any) => x.round_id === m.round_id && x.play_round != null && x.id !== m.id && openAtT(x, T));
      const own = grp.filter((x: any) => x.play_round < m.play_round && four(x).some((p: string) => four(m).includes(p)));
      if (own.length) badE3.push(`#${m.match_order} (round ${m.play_round}) called while ${[...new Set(own.flatMap((x: any) => four(x).filter((p: string) => four(m).includes(p))))].map(N).join(', ')} still had round ${Math.min(...own.map((x: any) => x.play_round))} to play`);
      const low = Math.min(m.play_round, ...grp.map((x: any) => x.play_round));
      if (m.play_round > low + 1) badE3.push(`#${m.match_order} (round ${m.play_round}) called while round ${low} was still open`);
    }
    check('E3 courts keep round order: no one skips their earlier match, no match more than one round ahead (PKL-061)', badE3.length === 0, badE3.slice(0, 4).join(' ; '));
  }

  // F. bye alerts (PKL-049): one "Bye this round" per run of byes after round 1, naming the next match.
  // PKL-043 (live run 75390a): the court queue can play a round before the round ahead of it finishes.
  // The alert goes out when round r-1 finishes, and only if round r still has a match to play then;
  // a round already over gets no alert (stale).
  // Rounds are per group (a pool is its own round_id with its own rounds 1..n).
  const doneAtG = new Map<string, number>();
  for (const m of ms) if (m.play_round != null) { const k = `${m.round_id}|${m.play_round}`; doneAtG.set(k, Math.max(doneAtG.get(k) ?? 0, ts(m.completed_at))); }
  let grpOf = '';
  const doneAt = { get: (r: number) => doneAtG.get(`${grpOf}|${r}`) };
  const stillOn = (r: number) => (doneAt.get(r) ?? 0) > (doneAt.get(r - 1) ?? Infinity);
  const badF: string[] = [];
  for (const p of players) {
    grpOf = mineOf(p).find((m) => m.play_round != null)?.round_id ?? '';
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
  if (R2) return finishR2(st, nm);
  if (DOUBLES) return finishDoubles(st, nm, completeAsked);
  if (R5) return finishR5(st, nm, completeAsked);
  if (R3) return finishR3(st, nm, completeAsked);
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
  if (!DOUBLES && !R2) return die('audit needs --doubles or --r2');
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
  const { data: byName } = await admin.from('tournaments').select('id').in('name', R7 ? [T_NAME, T2_NAME] : [T_NAME]);
  for (const t of byName ?? []) tIds.add(t.id);
  if (st?.cancel_tournament_id) tIds.add(st.cancel_tournament_id);
  const bots = new Map<string, string>();
  for (const b of st?.bots ?? []) bots.set(b.id, b.email);
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) die('list users: ' + error.message);
    for (const u of data.users) if (u.email && new RegExp(`^sim_${BOT_TAG}_\\d+@pickleague\\.test$`).test(u.email)) bots.set(u.id, u.email);
    if (data.users.length < 1000) break;
  }
  if (st?.brian) {
    const now = await brianSnapshot(st.brian);
    log(`Brian before: ${JSON.stringify(st.brian_before)}`);
    log(`Brian now:    ${JSON.stringify(now)}`);
  }
  for (const tId of tIds) {
    await saveRunReplay(tId);
    const { data: rs } = await admin.from('tournament_rounds').select('id, label').eq('tournament_id', tId);
    const { data: ms } = await admin.from('tournament_matches').select('id').eq('tournament_id', tId);
    const { data: regs } = await admin.from('tournament_registrations').select('id, user_id').eq('tournament_id', tId);
    log(`tournament ${tId}`);
    log(`  rounds (${rs?.length ?? 0}): ${(rs ?? []).map((r: any) => r.id).join(' ')}`);
    log(`  matches (${ms?.length ?? 0}): ${(ms ?? []).map((m: any) => m.id).join(' ')}`);
    log(`  registrations (${regs?.length ?? 0}): ${(regs ?? []).map((r: any) => r.id).join(' ')}`);
    // PKL-050: the ante pot's rows are keyed by scope id (no foreign key), so delete them by hand
    for (const tbl of ['pickle_pot_payouts', 'pickle_pot_contributions']) {
      const { data: gone, error: pe } = await admin.from(tbl).delete().eq('scope_type', 'tournament').eq('scope_id', tId).select('id');
      if (gone?.length || pe) log(`  ${tbl} deleted (${gone?.length ?? 0}): ${(gone ?? []).map((r: any) => r.id).join(' ')}${pe ? ' :: ' + pe.message : ''}`);
    }
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

// ── replay (PKL-054) ──────────────────────────────────────────────────────────
/** Saves the run's replay (timeline + page) to state/replays before cleanup deletes the tournament. */
async function saveRunReplay(tId: string) {
  try {
    const { data: tc } = await admin.from('tournaments').select('created_at').eq('id', tId).maybeSingle();
    const since = tc?.created_at ? Date.parse(tc.created_at) - 60_000 : 0;
    const data = await collectReplay(admin, tId, checkRows.filter((c) => Date.parse(c.at) >= since));
    const out = saveReplay(data, path.join(repo, 'state', 'replays'), `${TAG}-${RUN}-${tId.slice(0, 8)}`);
    log(`replay saved: ${out} (${data.events.length} events, ${data.alerts.length} alerts, ${data.checks.length} checks)`);
  } catch (e: any) { log(`replay NOT saved for ${tId}: ${e?.message ?? e}`); }
}
async function replay() {
  const st = readState(); if (!st?.tournament_id) return die(`no ${MODE} setup found`);
  await saveRunReplay(st.tournament_id);
}

// ── cancel-check (PKL-060 R7) ─────────────────────────────────────────────────
/**
 * After the R7 tournament: the host creates a second tournament with the same ante, QA Bots 2-5 join (each pays the
 * ante), Brian is invited too (live), then the host cancels it the way the app does (cancel_tournament). Checks:
 * the pot held every ante; afterwards every player's pickles are back where they were, the host also gets the
 * create fee back (cancelled during registration), the pot is empty and refunded, and each player got the
 * "Pot refunded" and "Tournament cancelled" alerts. Write "skip" into control.txt to go on without Brian.
 */
async function cancelCheck() {
  log('=== cancel-check (PKL-060 R7: ante refunds) ===');
  const st = readState(); if (!st?.league_id) return die(`no ${MODE} setup found; run setup first`);
  const host = st.bots[0]; const hc = await asBot(st, host.id);
  const joiners = st.bots.slice(1, 5);
  const pick = async (ids: string[]) => new Map(((await admin.from('profiles').select('id, pickles').in('id', ids)).data ?? [])
    .map((p: any) => [p.id as string, Number(p.pickles)]));
  let tId = st.cancel_tournament_id;
  if (tId) {
    const { data: t0 } = await admin.from('tournaments').select('status').eq('id', tId).maybeSingle();
    if (t0?.status === 'cancelled') { log('the cancel-check tournament is already cancelled; nothing to do (cleanup removes it)'); return; }
  }
  const people = [host.id, ...joiners.map((b) => b.id), ...(st.brian ? [st.brian] : [])];
  if (!tId) {
    // fund: the create fee + ante for the host, the ante for each joiner (on top of what they hold now)
    const now0 = await pick([host.id, ...joiners.map((b) => b.id)]);
    await admin.from('profiles').update({ pickles: (now0.get(host.id) ?? 0) + 2500 + ANTE }).eq('id', host.id);
    for (const b of joiners) await admin.from('profiles').update({ pickles: (now0.get(b.id) ?? 0) + ANTE }).eq('id', b.id);
    st.cancel_before = Object.fromEntries(await pick(people)); writeState(st);
  }
  const before = new Map<string, number>(Object.entries(st.cancel_before ?? {}).map(([k, v]) => [k, Number(v)]));
  if (!tId) {
    const start = new Date(Date.now() + 24 * 3600_000);
    const { data: t, error } = await hc.from('tournaments').insert({
      league_id: st.league_id, name: T2_NAME, created_by: host.id,
      description: `QA test (${ITEM}). Created only to be cancelled: every ante must come back.`,
      format: 'rotating_partners', match_type: 'doubles', seeding: 'random', pool_count: 1, team_creation: 'fixed',
      registration_mode: 'invite_only', min_players: 4, max_players: 8, start_time: start.toISOString(), expected_length_hours: 1,
      location_name: 'QA test (online)', pickle_ante: ANTE, payout_structure: [60, 25, 15], status: 'registration',
    }).select('id').single();
    if (error) return die('create the cancel-check tournament: ' + error.message);
    tId = t!.id as string; st.cancel_tournament_id = tId; writeState(st);
    log(`tournament "${T2_NAME}"  ${tId}  (host ${host.name}, ante ${ANTE})`);
    const { error: re } = await hc.from('tournament_registrations').insert({ tournament_id: tId, user_id: host.id, status: 'approved', role: 'admin' });
    if (re) return die('host registration: ' + re.message);
    for (const b of joiners) {
      const { error: ie } = await hc.rpc('tournament_invite_player', { p_tournament_id: tId, p_user_id: b.id });
      if (ie) return die(`invite ${b.name}: ${ie.message}`);
      const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', tId).eq('user_id', b.id).single();
      const { error: ae } = await (await asBot(st, b.id)).rpc('tournament_respond_to_invite', { p_registration_id: reg!.id, p_accept: true });
      if (ae) return die(`${b.name} accept: ${ae.message}`);
      log(`  ${b.name} invited + accepted`);
    }
    if (st.brian) {
      const { error: ie } = await hc.rpc('tournament_invite_player', { p_tournament_id: tId, p_user_id: st.brian });
      if (ie) return die('invite Brian: ' + ie.message);
    }
  }
  const tid = tId as string;
  if (st.brian && !REHEARSAL) {
    for (let w = 0; ; w++) {
      const { data: r } = await admin.from('tournament_registrations').select('status').eq('tournament_id', tid).eq('user_id', st.brian).maybeSingle();
      if (r?.status === 'approved') { log('Brian accepted (paid the ante)'); break; }
      if (control() === 'skip') { log('control "skip": going on without Brian'); break; }
      if (w === 0) log(`WAITING FOR YOU: accept the invite to "${T2_NAME}" (it charges the ${ANTE} ante; the cancel gives it back). Write "skip" into control.txt to go on without you.`);
      await sleep(5000);
    }
  }
  const N = (u: string) => (u === st.brian ? 'Brian' : st.bots.find((b) => b.id === u)?.name ?? u.slice(0, 8));
  const { data: regs } = await admin.from('tournament_registrations').select('user_id, status').eq('tournament_id', tid);
  const paidIn = (regs ?? []).filter((r: any) => r.status === 'approved').map((r: any) => r.user_id as string);
  const mid = await pick(paidIn);
  const { data: tm } = await admin.from('tournaments').select('prize_pool').eq('id', tid).single() as { data: any };
  const { data: c0 } = await admin.from('pickle_pot_contributions').select('user_id, amount_paid, kind').eq('scope_type', 'tournament').eq('scope_id', tid);
  check(`cancel-check: ${paidIn.length} players each paid the ${ANTE} ante into the pot (${paidIn.length * ANTE})`,
    Number(tm?.prize_pool) === paidIn.length * ANTE && (c0 ?? []).filter((c: any) => c.kind === 'ante').length === paidIn.length,
    `prize_pool ${tm?.prize_pool}, ${(c0 ?? []).length} contributions`);
  const notCharged = paidIn.filter((u) => u !== host.id && (before.get(u) ?? 0) - (mid.get(u) ?? 0) !== ANTE)
    .map((u) => `${N(u)} ${before.get(u)} -> ${mid.get(u)}`);
  check(`cancel-check: each joining player is ${ANTE} pickles down before the cancel`, notCharged.length === 0, notCharged.join(' ; '));

  // the cancel, as the app's "Cancel tournament" (useTournamentDetail.confirmCancelTournament)
  const T = new Date(Date.now() - 2000).toISOString();
  const { data: msg, error: ce } = await hc.rpc('cancel_tournament', { p_tournament_id: tid });
  log(ce ? `CANCEL ERROR: ${ce.message}` : `CANCEL by host ${host.name}: ${msg}`);
  check('cancel-check: cancel_tournament ran', !ce, ce?.message);
  await sleep(1500);
  const after = await pick(people);
  const { data: t1 } = await admin.from('tournaments').select('status, prize_pool').eq('id', tid).single() as { data: any };
  check('cancel-check: tournament is cancelled and its pot is empty', t1?.status === 'cancelled' && Number(t1?.prize_pool) === 0,
    `status ${t1?.status}, prize_pool ${t1?.prize_pool}`);
  const { data: c1 } = await admin.from('pickle_pot_contributions').select('refunded_at').eq('scope_type', 'tournament').eq('scope_id', tid);
  check('cancel-check: every pot contribution is marked refunded', (c1 ?? []).length > 0 && (c1 ?? []).every((c: any) => !!c.refunded_at));
  // before = after funding; the host paid the create fee + ante, everyone else the ante: all of it comes back
  const off = people.filter((u) => (after.get(u) ?? 0) !== (before.get(u) ?? 0)).map((u) => `${N(u)} ${before.get(u)} -> ${after.get(u)}`);
  check('cancel-check: every player has exactly the pickles they had before (ante back; the host also gets the create fee back)', off.length === 0, off.join(' ; '));
  const { data: notes } = await admin.from('notifications').select('user_id, title').eq('entity_id', tid).gte('created_at', T);
  const lack = paidIn.flatMap((u) => [
    ...((notes ?? []).some((n: any) => n.user_id === u && n.title === '🥒 Pot refunded') ? [] : [`${N(u)}: no "Pot refunded"`]),
    ...(u === host.id || (notes ?? []).some((n: any) => n.user_id === u && n.title === '🚫 Tournament cancelled') ? [] : [`${N(u)}: no "Tournament cancelled"`]),
  ]);
  check('cancel-check: each player got "Pot refunded" and (all but the host) "Tournament cancelled"', lack.length === 0, lack.join(' ; '));
  if (st.brian && paidIn.includes(st.brian)) log('PHONE: two pushes should arrive now: "🥒 Pot refunded" and "🚫 Tournament cancelled"');
  log(`=== cancel-check done; ${failures} problem(s) ===`);
  process.exitCode = failures ? 1 : 0;
}

// ── main ──────────────────────────────────────────────────────────────────────
process.on('SIGINT', () => { log('Ctrl+C: stopped. Run again to resume from the database state.'); process.exit(130); });
const main: Record<string, () => unknown> = { setup, run, status, audit, replay, cleanup, plan, 'cancel-check': cancelCheck };
if (!main[CMD]) { console.log('usage: npx tsx live-qa-pkl034.ts setup|run|status|audit|replay|cleanup|plan [--doubles] [--rehearsal] [--fast] [--interval 60] [--restore-brian]'); process.exit(2); }
Promise.resolve(main[CMD]()).catch((e) => die(String(e?.stack ?? e)));
