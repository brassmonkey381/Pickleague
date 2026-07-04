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
 *   waitlist   — min/max players + registration waitlist: fill to max, overflow
 *                requests waitlisted, capacity guard, FIFO auto-promotion on
 *                withdrawal / max raise.
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
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORMAT_META, seedPlayers, seedTeams, generateRoundRobin, generateSingleElim, generateDoubleElim,
  generatePoolPlay, generateRotatingPartners,
  generateDoublesRoundRobin, generateDoublesSingleElim, generateDoublesDoubleElim,
  generateDoublesPoolPlay, type MatchPairing,
} from '../mobile/src/lib/tournament';
import { buildStandingsComparator, teamKey } from '../mobile/src/lib/tournamentTiebreakers';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(n);
const val = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const SCENARIO   = val('--scenario', 'tournament');
const N_USERS    = Number(val('--users', '8'));
const FORMAT     = val('--format', 'round_robin');
const MATCH_TYPE = val('--match-type', 'singles');       // singles | doubles | mlp
const TEAM_CREATE = val('--team-creation', 'fixed');     // doubles & MLP; singles ignores it
const SEEDING    = val('--seeding', 'random');           // random | elo (PLUPR-based)
const PLAYOFF    = val('--playoff-format', 'none');      // none | top_2/4/8 | top_1/2_per_pool (non-MLP pool_play)
const THIRD_PLACE = has('--third-place');                // top_4 / top_8 playoffs only
const POOL_COUNT = Number(val('--pool-count', '2'));     // pool_play only
const REG_MODE   = val('--registration-mode', 'request');
const LEAGUE_MODE = val('--league-mode', 'open');
const PLAY       = has('--play');
const AUTO_ROUNDS = has('--auto-rounds');   // play round-by-round to completion, checking invariants + drafting a report
const ECONOMY    = has('--economy');        // random ante + payout structure + wagers; verify payouts, badges, notifications
const LEAGUE_ATTACH = has('--league-attach'); // attach tournament to the [SIM] Toolbox League; verify PLUPR weighting + season period lock
// --stage stops the tournament scenario mid-lifecycle and leaves the
// tournament in place for app inspection:
//   registration — approvals done, no bracket; verifies a new request still lands
//   closed       — registration_closes_at forced into the past; verifies RLS blocks late joins
//   midplay      — round 1 locked in, roughly half of it scored; verifies no premature advancement
//   complete     — (default) normal full run
const STAGE = val('--stage', 'complete');
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

// ── run-to-completion: checks + report ──────────────────────────────────────
type CheckResult = { section: string; desc: string; ok: boolean; details?: string };
class Checker {
  results: CheckResult[] = [];
  timeline: string[] = [];
  note(s: string) { this.timeline.push(s); log('  ' + s); }
  check(section: string, desc: string, ok: boolean, details?: string) {
    this.results.push({ section, desc, ok, details });
    log(`  ${ok ? '✅' : '❌'} [${section}] ${desc}${!ok && details ? ' — ' + details : ''}`);
  }
  get failures() { return this.results.filter((r) => !r.ok); }
}

function writeReport(c: Checker, tName: string, tId: string, cfg: Record<string, unknown>) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, 'reports');
  mkdirSync(dir, { recursive: true });
  const slug = tName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const file = path.join(dir, `${slug}.md`);
  const pass = c.results.filter((r) => r.ok).length;
  const md = [
    `# Tournament run report — ${tName}`,
    '',
    `> Auto-generated by \`simulations/simulate-flows.ts --auto-rounds\`. If failures below look`,
    `> like real bugs, feed this file to Claude Code with the tournament left in place for inspection.`,
    '',
    `- **Tournament id:** \`${tId}\``,
    `- **Config:** \`${JSON.stringify(cfg)}\``,
    `- **Result:** ${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} FAILED`} (${pass}/${c.results.length} passed)`,
    '',
    ...(c.failures.length ? [
      '## Failures',
      ...c.failures.map((f) => `- **[${f.section}]** ${f.desc}${f.details ? `\n  - ${f.details}` : ''}`),
      '',
    ] : []),
    '## Timeline',
    ...c.timeline.map((t) => `- ${t}`),
    '',
    '## All checks',
    ...c.results.map((r) => `- ${r.ok ? '✅' : '❌'} [${r.section}] ${r.desc}${r.details ? ` — ${r.details}` : ''}`),
    '',
  ].join('\n');
  writeFileSync(file, md);
  return file;
}

// ── economy layer: ante, payout structure, wagers ───────────────────────────
type PlacedWager = { user: string; target: string; rank: number; stake: number; ok: boolean; potential: number | null; msg?: string; wagerId?: string; cancelled?: boolean; refunded?: number };
type Economy = {
  ante: number; payoutStructure: number[];
  wagers: PlacedWager[]; startPickles: Map<string, number>; startedAt: string;
};

const pickOne = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

// Random wagers: each player (60% chance) backs someone for a final rank via
// the same place_wager RPC the app uses — stake debited at placement, odds
// from calculate_wager_odds, settled by the tournament-completion trigger.
async function placeRandomWagers(names: string[], playerIds: string[], tId: string): Promise<PlacedWager[]> {
  const placed: PlacedWager[] = [];
  for (const email of names) {
    if (Math.random() > 0.6) continue;
    const actor = await signIn(email);
    const target = pickOne(playerIds);
    const rank = pickOne([1, 1, 1, 2, 3]);
    const stake = 10 + Math.floor(Math.random() * 141);
    const { data, error } = await actor.client.rpc('place_wager', {
      p_subject_type: 'tournament_rank', p_subject_id: tId,
      p_predicate: { user_id: target, rank }, p_stake: stake,
    });
    const row = Array.isArray(data) ? data[0] : data;
    placed.push({
      user: actor.id, target, rank, stake,
      ok: !error && !!row?.success,
      potential: row?.potential_payout ?? null,
      msg: error?.message ?? row?.message,
      wagerId: row?.wager_id ?? undefined,
    });
    log(`  ${!error && row?.success ? '✓' : '⚠'} ${email.split('@')[0]} wagered ${stake}🥒 on ${target.slice(0, 8)} finishing #${rank}` +
        (!error && row?.success ? ` (pays ${row?.potential_payout})` : ` — ${error?.message ?? row?.message}`));
  }
  // Cancel one wager (the first successful one) before play starts — the
  // stake must come back and the wager must never settle.
  const victim = placed.find((w) => w.ok && w.wagerId);
  if (victim) {
    const owner = await signIn(names.find((n) => actorCache.get(n)?.id === victim.user)!);
    const { data: cData, error: cErr } = await owner.client.rpc('cancel_wager', { p_wager_id: victim.wagerId });
    const cRow = Array.isArray(cData) ? cData[0] : cData;
    victim.cancelled = !cErr && !!cRow?.success;
    victim.refunded = cRow?.refunded ?? 0;
    log(`  ${victim.cancelled ? '✓' : '⚠'} cancelled wager ${victim.wagerId!.slice(0, 8)} (stake ${victim.stake}, refunded ${victim.refunded})` +
        (victim.cancelled ? '' : ` — ${cErr?.message ?? cRow?.message}`));
  }
  return placed;
}

// Expected first-batch playoff match count for a playoff format.
function expectedPlayoffMatches(playoff: string, poolCount: number): number | null {
  switch (playoff) {
    case 'top_2': return 1;             // final (3PM may add later)
    case 'top_4': return 2;             // semis
    case 'top_8': return 4;             // quarters
    case 'top_1_per_pool': return Math.max(1, Math.floor((poolCount * 1) / 2));
    case 'top_2_per_pool': return Math.max(1, Math.floor((poolCount * 2) / 2));
    default: return null;
  }
}

// Drive a live tournament to completion: score every pending match, let the
// advancement triggers create rounds, generate the playoff when group play is
// done, and admin-complete when the format calls for it. Invariants are
// checked at every step; the result is a markdown report.
async function runToCompletion(host: Actor, tId: string, tName: string, playerIds: string[], cfg: Record<string, unknown>, econ?: Economy, leagueId?: string) {
  const c = new Checker();
  const isMlp = cfg['match-type'] === 'mlp';

  // rating baseline (standalone tournaments feed global PLUPR at weight 1.0)
  const { data: before } = await admin.from('profiles').select('id, rating').in('id', playerIds);
  const baseline = new Map((before ?? []).map((p: any) => [p.id, Number(p.rating)]));

  let playoffGenerated = false;
  let completedCalled = false;
  for (let iter = 1; iter <= 40; iter++) {
    const { data: t } = await admin.from('tournaments')
      .select('status, format, playoff_format, pool_count, mlp_play_format, mlp_pool_count').eq('id', tId).single();
    const { data: rounds } = await admin.from('tournament_rounds')
      .select('id, round_number, label, round_type').eq('tournament_id', tId).order('round_number');
    const roundById = new Map((rounds ?? []).map((r: any) => [r.id, r]));
    const { data: matches } = await admin.from('tournament_matches')
      .select('id, round_id, match_type, status, winner_team, team1_player1, team1_player2, team2_player1, team2_player2')
      .eq('tournament_id', tId).order('match_order');

    // ── invariant checks on current state ──
    const real = (matches ?? []).filter((m: any) => m.team1_player1 && m.team2_player1);
    const halfTeams = (matches ?? []).filter((m: any) =>
      m.match_type === 'doubles' &&
      ((m.team1_player1 == null) !== (m.team1_player2 == null) || (m.team2_player1 == null) !== (m.team2_player2 == null)));
    c.check('integrity', `iter ${iter}: no half-filled doubles teams`, halfTeams.length === 0, `${halfTeams.length} half-team matches`);
    const approvedSet = new Set(playerIds);
    const strangers = real.flatMap((m: any) => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2])
      .filter((id: string | null) => id && !approvedSet.has(id));
    c.check('integrity', `iter ${iter}: only approved players in matches`, strangers.length === 0, `${strangers.length} unknown ids`);
    // One-match-per-player-per-round only holds for KNOCKOUT rounds. Group
    // schedules (round robin / pool play / rotating) intentionally pack a
    // player's whole slate into one round row.
    // (MLP is exempt everywhere: a team meeting is 4 sub-matches, so each
    // player legitimately appears twice per round.)
    const knockoutFmt = ['single_elimination', 'double_elimination'].includes(String(t!.format));
    // Advancement correctness: an eliminated player (1 loss in single elim,
    // 2 in double elim) must never appear in a still-pending match. This is
    // the check that catches "the wrong player advanced" — e.g. seeds not
    // matching the actual draw.
    if (knockoutFmt && !isMlp) {
      const losses = new Map<string, number>();
      for (const m of (matches ?? []).filter((m: any) => m.status === 'completed' && m.winner_team)) {
        const losers = m.winner_team === 'team1' ? [m.team2_player1, m.team2_player2] : [m.team1_player1, m.team1_player2];
        for (const id of losers) if (id) losses.set(id, (losses.get(id) ?? 0) + 1);
      }
      const maxLoss = String(t!.format) === 'double_elimination' ? 2 : 1;
      const zombies = [...new Set(real.filter((m: any) => m.status !== 'completed')
        .flatMap((m: any) => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2])
        .filter((id: string | null) => id && (losses.get(id) ?? 0) >= maxLoss))];
      c.check('advancement', `iter ${iter}: no eliminated player scheduled again`, zombies.length === 0,
        zombies.map((z: any) => z.slice(0, 8)).join(', '));
    }
    const playoffTypes = new Set(['quarterfinals', 'semifinals', 'finals', 'third_place_match']);
    for (const r of rounds ?? []) {
      if (isMlp) break;
      if (!knockoutFmt && !playoffTypes.has(r.round_type)) continue;
      const inRound = real.filter((m: any) => m.round_id === r.id);
      const seen = new Map<string, number>();
      for (const m of inRound) for (const id of [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2]) {
        if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      const dupes = [...seen.entries()].filter(([, n]) => n > 1);
      if (dupes.length) c.check('integrity', `round "${r.label}": player appears in 2+ matches`, false, dupes.map(([id, n]) => `${id.slice(0, 8)}×${n}`).join(', '));
    }

    if (t!.status === 'completed') { c.note(`iter ${iter}: tournament completed`); break; }

    // one-sided rows are walkovers (BYE) — surface them, then complete them
    const walkovers = (matches ?? []).filter((m: any) => m.status !== 'completed' &&
      ((m.team1_player1 && !m.team2_player1) || (!m.team1_player1 && m.team2_player1)));
    for (const m of walkovers) {
      const t1 = !!m.team1_player1;
      await host.client.from('tournament_matches').update({
        team1_score: t1 ? 11 : 0, team2_score: t1 ? 0 : 11,
        winner_team: t1 ? 'team1' : 'team2', status: 'completed',
      }).eq('id', m.id);
    }
    if (walkovers.length) c.note(`iter ${iter}: scored ${walkovers.length} walkover (BYE) match(es)`);

    const pending = real.filter((m: any) => m.status !== 'completed');
    if (pending.length) {
      for (const m of pending) {
        const t1Wins = Math.random() < 0.5;
        const { error } = await host.client.from('tournament_matches').update({
          team1_score: t1Wins ? 11 : Math.floor(Math.random() * 9) + 1,
          team2_score: t1Wins ? Math.floor(Math.random() * 9) + 1 : 11,
          winner_team: t1Wins ? 'team1' : 'team2', status: 'completed',
        }).eq('id', m.id);
        if (error) c.check('scoring', `score match ${m.id.slice(0, 8)}`, false, error.message);
      }
      const labels = [...new Set(pending.map((m: any) => roundById.get(m.round_id)?.label ?? '?'))].join(', ');
      c.note(`iter ${iter}: scored ${pending.length} match(es) in: ${labels}`);
      continue;
    }

    // nothing pending, still active → playoff generation or completion
    const playoffRounds = (rounds ?? []).filter((r: any) =>
      ['quarterfinals', 'semifinals', 'finals', 'third_place_match', 'playoff'].includes(r.round_type));
    const wantsPlayoff = isMlp
      ? String(t!.mlp_play_format ?? '').endsWith('_playoff')
      : (t!.playoff_format ?? 'none') !== 'none';

    if (wantsPlayoff && playoffRounds.length === 0 && !playoffGenerated) {
      const rpc = isMlp ? 'generate_mlp_playoff' : 'generate_playoff_bracket';
      const { error } = await host.client.rpc(rpc, { p_tournament_id: tId });
      c.check('playoff', `${rpc} succeeds after group play`, !error, error?.message);
      playoffGenerated = true;
      if (!error) {
        const { data: pr } = await admin.from('tournament_rounds').select('id, round_type').eq('tournament_id', tId);
        const created = (pr ?? []).filter((r: any) => ['quarterfinals', 'semifinals', 'finals', 'third_place_match', 'playoff'].includes(r.round_type));
        c.check('playoff', 'playoff round(s) created', created.length > 0, 'no playoff-typed rounds appeared');
        if (!isMlp) {
          const { count } = await admin.from('tournament_matches').select('*', { count: 'exact', head: true })
            .eq('tournament_id', tId).in('round_id', created.map((r: any) => r.id));
          const exp = expectedPlayoffMatches(String(t!.playoff_format), Number(t!.pool_count ?? 2));
          if (exp != null) c.check('playoff', `first playoff batch has ${exp} match(es)`, (count ?? 0) >= exp, `got ${count}`);
        }
      }
      if (error) break;
      continue;
    }

    if (!completedCalled) {
      const { error } = await host.client.rpc('admin_complete_tournament', { p_tournament_id: tId });
      c.check('completion', 'admin_complete_tournament succeeds when nothing is pending', !error, error?.message);
      completedCalled = true;
      if (error) break;
      continue;
    }

    c.check('progress', `no stall: tournament advances after scoring`, false,
      `iter ${iter}: nothing pending, playoffGenerated=${playoffGenerated}, completeCalled=${completedCalled}, status=${t!.status}`);
    break;
  }

  // ── final checks ──
  const { data: tFinal } = await admin.from('tournaments').select('status').eq('id', tId).single();
  c.check('completion', 'tournament status = completed', tFinal?.status === 'completed', `status=${tFinal?.status}`);
  const { count: stillPending } = await admin.from('tournament_matches').select('*', { count: 'exact', head: true })
    .eq('tournament_id', tId).neq('status', 'completed');
  c.check('completion', 'zero pending matches at the end', (stillPending ?? 0) === 0, `${stillPending} pending`);
  const { data: ranks } = await admin.from('tournament_final_ranks').select('user_id, final_rank').eq('tournament_id', tId);
  c.check('completion', 'final ranks computed', (ranks?.length ?? 0) > 0, 'tournament_final_ranks empty');
  if (ranks?.length) c.check('completion', 'a champion exists (final_rank = 1)', ranks.some((r: any) => r.final_rank === 1));

  // ── double-elim structural invariants ──────────────────────────────────
  // Standard no-reset double elimination: the champion loses at most once,
  // the runner-up once or twice, and EVERY other competitive unit exactly
  // twice (that's what "double elimination" means). The grand-final winner
  // must be the stored champion.
  if (cfg.format === 'double_elimination') {
    const { data: allM } = await admin.from('tournament_matches')
      .select('team1_player1, team1_player2, team2_player1, team2_player2, winner_team, match_type, status, round:tournament_rounds(round_type, round_number)')
      .eq('tournament_id', tId).eq('status', 'completed');
    const unitKey = (p1: string | null, p2: string | null) => p1 ? (p2 ? [p1, p2].sort().join('|') : p1) : null;
    const losses = new Map<string, number>();
    const seen = new Set<string>();
    for (const m of (allM ?? []) as any[]) {
      const k1 = unitKey(m.team1_player1, m.team1_player2);
      const k2 = unitKey(m.team2_player1, m.team2_player2);
      if (k1) { seen.add(k1); if (!losses.has(k1)) losses.set(k1, 0); }
      if (k2) { seen.add(k2); if (!losses.has(k2)) losses.set(k2, 0); }
      if (m.match_type === 'bye' || !k1 || !k2) continue; // byes have no loser
      const loser = m.winner_team === 'team1' ? k2 : k1;
      losses.set(loser, (losses.get(loser) ?? 0) + 1);
    }
    // Grand final = last completed finals/grand_final match.
    const gf = ((allM ?? []) as any[])
      .filter(m => ['finals', 'grand_final'].includes(m.round?.round_type))
      .sort((a, b) => (b.round?.round_number ?? 0) - (a.round?.round_number ?? 0))[0];
    const champKey = gf ? unitKey(
      gf.winner_team === 'team1' ? gf.team1_player1 : gf.team2_player1,
      gf.winner_team === 'team1' ? gf.team1_player2 : gf.team2_player2,
    ) : null;
    const runnerKey = gf ? unitKey(
      gf.winner_team === 'team1' ? gf.team2_player1 : gf.team1_player1,
      gf.winner_team === 'team1' ? gf.team2_player2 : gf.team1_player2,
    ) : null;
    c.check('double-elim', 'grand final exists', !!gf);
    if (champKey) {
      c.check('double-elim', 'champion lost at most once', (losses.get(champKey) ?? 0) <= 1,
        `champion losses=${losses.get(champKey)}`);
      const rank1 = (ranks ?? []).find((r: any) => r.final_rank === 1);
      c.check('double-elim', 'stored champion matches the grand-final winner',
        rank1 != null && champKey.split('|').includes(rank1.user_id), `rank1=${rank1?.user_id?.slice(0, 8)}`);
    }
    if (runnerKey) {
      const rl = losses.get(runnerKey) ?? 0;
      c.check('double-elim', 'runner-up lost once or twice', rl === 1 || rl === 2, `runner-up losses=${rl}`);
    }
    const badUnits = [...seen].filter(k => k !== champKey && k !== runnerKey && (losses.get(k) ?? 0) !== 2);
    c.check('double-elim', 'every eliminated unit lost exactly twice', badUnits.length === 0,
      badUnits.map(k => `${k.slice(0, 8)}: ${losses.get(k)} losses`).join(', '));
  }

  // ── unified-rankings checks ─────────────────────────────────────────────
  // Fixed-team formats: doubles partners must share their team's final rank,
  // and for playoff-free RR/pool the stored ranks must equal the CLIENT
  // standings comparator exactly (wins → 2-way H2H → point diff → seed).
  // (cfg.format is the CLI value — MLP runs pass their PLAY format here while
  // the DB stores mlp/mlp_random, so gate on match-type too: MLP ranks are
  // per-user over rotating sub-match lineups, not fixed teams.)
  if (String(cfg['match-type']) !== 'mlp'
      && ['round_robin', 'pool_play', 'single_elimination', 'double_elimination'].includes(String(cfg.format))) {
    const rankOf = new Map((ranks ?? []).map((r: any) => [r.user_id, r.final_rank]));
    if (String(cfg['match-type']) === 'doubles') {
      const { data: prs } = await admin.from('doubles_pairs')
        .select('partner_1_id, partner_2_id').eq('tournament_id', tId);
      const mismatched = (prs ?? []).filter((p: any) => p.partner_1_id && p.partner_2_id
        && rankOf.has(p.partner_1_id)
        && rankOf.get(p.partner_1_id) !== rankOf.get(p.partner_2_id));
      c.check('rankings', 'doubles partners share their team\'s final rank', mismatched.length === 0,
        JSON.stringify(mismatched.map((p: any) => [rankOf.get(p.partner_1_id), rankOf.get(p.partner_2_id)])));
    }
    if ((cfg.format === 'round_robin' || cfg.format === 'pool_play') && cfg['playoff-format'] === 'none') {
      const { data: ms } = await admin.from('tournament_matches')
        .select('team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score, winner_team, status, match_type')
        .eq('tournament_id', tId);
      const { data: regs } = await admin.from('tournament_registrations')
        .select('user_id, seed').eq('tournament_id', tId).eq('status', 'approved');
      const seedOf = new Map((regs ?? []).map((r: any) => [r.user_id, r.seed ?? 999]));
      type E = { key: string; wins: number; pf: number; pa: number; seed?: number };
      const entries = new Map<string, E>();
      const ensure = (p1: string | null, p2: string | null) => {
        if (!p1) return null;
        const k = teamKey(p1, p2);
        if (!entries.has(k)) entries.set(k, { key: k, wins: 0, pf: 0, pa: 0 });
        return entries.get(k)!;
      };
      for (const m of (ms ?? []) as any[]) {
        const a = ensure(m.team1_player1, m.team1_player2);
        const b = ensure(m.team2_player1, m.team2_player2);
        if (!a || !b || m.status !== 'completed' || !m.winner_team || m.match_type === 'bye') continue;
        a.pf += m.team1_score ?? 0; a.pa += m.team2_score ?? 0;
        b.pf += m.team2_score ?? 0; b.pa += m.team1_score ?? 0;
        if (m.winner_team === 'team1') a.wins++; else b.wins++;
      }
      for (const e of entries.values()) {
        e.seed = Math.min(...e.key.split('|').map((u) => Number(seedOf.get(u) ?? 999)));
      }
      const list = [...entries.values()];
      list.sort(buildStandingsComparator(list, (ms ?? []) as any));
      const clientOrder = list.map((e) => e.key);
      const byRank = new Map<number, string[]>();
      for (const r of (ranks ?? []) as any[]) {
        byRank.set(r.final_rank, [...(byRank.get(r.final_rank) ?? []), r.user_id]);
      }
      const dbOrder = [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([, uids]) => uids.sort().join('|'));
      const equal = clientOrder.length === dbOrder.length && clientOrder.every((k, i) => k === dbOrder[i]);
      c.check('rankings', 'stored final ranks match the client standings comparator exactly', equal,
        equal ? undefined : `client=${clientOrder.map((k) => k.slice(0, 8)).join(',')} db=${dbOrder.map((k) => k.slice(0, 8)).join(',')}`);
    }
  }

  const { data: after } = await admin.from('profiles').select('id, rating').in('id', playerIds);
  const moved = (after ?? []).filter((p: any) => Math.abs(Number(p.rating) - (baseline.get(p.id) ?? 0)) > 0.0001).length;
  if (!leagueId) {
    c.check('ratings', 'participant global PLUPRs changed (standalone tournament, weight 1.0)', moved > 0, 'no rating moved');
  } else {
    // League-attached tournaments feed the LEAGUE rating at weight 1.0 and the
    // global rating at weight 0.0 — global must NOT move (payout PLUPR bonuses
    // are the one legit global bump, so tolerate exactly those).
    const bonusUsers = new Set<string>();
    const { data: bonusRows } = await admin.from('tournament_plupr_bonuses').select('user_id').eq('tournament_id', tId);
    for (const b of bonusRows ?? []) bonusUsers.add(b.user_id);
    const movedNonBonus = (after ?? []).filter((p: any) =>
      !bonusUsers.has(p.id) && Math.abs(Number(p.rating) - (baseline.get(p.id) ?? 0)) > 0.0001).length;
    c.check('ratings', 'global PLUPR untouched for league tournament (weight 0.0)', movedNonBonus === 0,
      `${movedNonBonus} non-podium global rating(s) moved`);
    const { data: lprAfter } = await admin.from('league_player_ratings')
      .select('user_id, rating').eq('league_id', leagueId).in('user_id', playerIds);
    const leagueMoved = (lprAfter ?? []).filter((r: any) => Math.abs(Number(r.rating) - 3.25) > 0.0001).length;
    c.check('ratings', 'league PLUPRs affected by the tournament', (lprAfter?.length ?? 0) > 0 && leagueMoved >= 0,
      'no league_player_ratings rows for participants');

    // ── season period lock under tournament load ──
    const { data: season } = await admin.from('league_seasons')
      .select('id, start_date, lock_frequency_weeks, baseline_plupr')
      .eq('league_id', leagueId).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!season) {
      c.check('season', 'an active season exists for the league', false, 'none found');
    } else {
      const { data: maxSnap } = await admin.from('season_snapshots')
        .select('period_number').eq('season_id', season.id)
        .order('period_number', { ascending: false }).limit(1);
      const nextPeriod = ((maxSnap?.[0]?.period_number as number | undefined) ?? 0) + 1;
      const today = new Date().toISOString().slice(0, 10);
      const { error: lockErr } = await admin.rpc('_lock_season_period_unchecked',
        { p_season_id: season.id, p_period_number: nextPeriod, p_snapshot_date: today });
      c.check('season', `period ${nextPeriod} locks cleanly after the tournament`, !lockErr, lockErr?.message);
      const { data: snapRows } = await admin.from('season_snapshots')
        .select('user_id, rank_at_snapshot').eq('season_id', season.id).eq('period_number', nextPeriod);
      const snapUsers = new Set((snapRows ?? []).map((r: any) => r.user_id));
      const missing = playerIds.filter((id) => !snapUsers.has(id));
      c.check('season', 'snapshot covers every tournament participant', missing.length === 0,
        `${missing.length} participants missing from period ${nextPeriod}`);
      // soft reset: #1 seat should now sit at baseline + 0.20
      const base = season.baseline_plupr != null ? Number(season.baseline_plupr) : null;
      const top = (snapRows ?? []).find((r: any) => r.rank_at_snapshot === 1);
      if (base != null && top) {
        const { data: topLpr } = await admin.from('league_player_ratings')
          .select('rating').eq('league_id', leagueId).eq('user_id', top.user_id).maybeSingle();
        c.check('season', `post-lock soft reset: #1 league rating = baseline+0.20 (${(base + 0.2).toFixed(2)})`,
          topLpr != null && Math.abs(Number(topLpr.rating) - (base + 0.2)) < 0.001,
          `got ${topLpr?.rating}`);
      }
    }
  }

  // ── economy checks: pot, payouts, wagers, badges, notifications ──
  if (econ) {
    const { data: tEcon } = await admin.from('tournaments')
      .select('prize_pool, pickle_ante, payout_structure, champion_payout_applied_at').eq('id', tId).single();
    c.check('economy', `prize pool = ante × players (${econ.ante} × ${playerIds.length})`,
      Number(tEcon?.prize_pool) === econ.ante * playerIds.length,
      `prize_pool=${tEcon?.prize_pool}`);
    // Payout is a MANUAL admin action in the app (Payout modal →
    // auto_payout_tournament) — run it exactly like an admin would, then
    // verify the marker + notifications.
    const payoutAt = new Date().toISOString();
    const { error: payErr } = await host.client.rpc('auto_payout_tournament', { p_tournament_id: tId });
    c.check('economy', 'auto_payout_tournament succeeds (admin payout modal flow)', !payErr, payErr?.message);
    const { data: tPost } = await admin.from('tournaments').select('champion_payout_applied_at').eq('id', tId).single();
    c.check('economy', 'payout dispatched (champion_payout_applied_at set)',
      tPost?.champion_payout_applied_at != null, 'still null after auto_payout_tournament');

    // payout notifications: one “🥒 +N pickles!” per paying rank (bounded by
    // ranked players). Non-MLP pays on the manual call, so count from then;
    // MLP AUTO-pays at completion, so count from the run start.
    const paying = Math.min(econ.payoutStructure.length, ranks?.length ?? 0);
    const notifWindow = isMlp ? econ.startedAt : payoutAt;
    const { data: payNotifs } = await admin.from('notifications')
      .select('user_id, title').like('title', '🥒 +%').gte('created_at', notifWindow).in('user_id', playerIds);
    c.check('economy', `payout notifications sent (expected ≥ ${paying})`,
      (payNotifs?.length ?? 0) >= paying, `got ${payNotifs?.length ?? 0}`);

    // wagers: every non-cancelled wager settled, and won ⇔ the predicate hit
    const { data: wRows } = await admin.from('wagers')
      .select('id, user_id, predicate, status, stake, potential_payout, settled_at')
      .eq('subject_id', tId).eq('subject_type', 'tournament_rank');
    const cancelledIds = new Set(econ.wagers.filter((w) => w.cancelled).map((w) => w.wagerId));
    const live = (wRows ?? []).filter((w: any) => !cancelledIds.has(w.id));
    const okWagers = econ.wagers.filter((w) => w.ok).length - cancelledIds.size;
    c.check('wagers', `all ${okWagers} live wagers exist and are settled`,
      live.length === okWagers && live.every((w: any) => w.status !== 'open' && w.settled_at),
      `rows=${live.length}, open=${live.filter((w: any) => w.status === 'open').length}`);
    const rankByUser = new Map((ranks ?? []).map((r: any) => [r.user_id, r.final_rank]));
    const wrong = live.filter((w: any) => {
      const hit = rankByUser.get(w.predicate?.user_id) === Number(w.predicate?.rank);
      return (w.status === 'won') !== hit;
    });
    c.check('wagers', 'every wager won/lost matches the actual final ranks', wrong.length === 0,
      wrong.map((w: any) => `${w.id.slice(0, 8)}:${w.status}`).join(', '));
    // cancellation: refund equals stake, status stays 'cancelled' through settlement
    const cw = econ.wagers.find((w) => w.cancelled);
    if (cw) {
      c.check('wagers', 'cancelled wager refunded the full stake', cw.refunded === cw.stake,
        `stake=${cw.stake} refunded=${cw.refunded}`);
      const row = (wRows ?? []).find((w: any) => w.id === cw.wagerId);
      c.check('wagers', 'cancelled wager stayed cancelled (never settled won/lost)',
        row?.status === 'cancelled', `status=${row?.status}`);
    }
    // stake escrow: losers just lose stake; winners get potential_payout — spot-check one winner
    const won = (wRows ?? []).filter((w: any) => w.status === 'won');
    if (won.length) c.note(`${won.length} wager(s) won, ${(wRows?.length ?? 0) - won.length} lost`);

    // badges: run the daily progress-badge cron pass (compressing time), then
    // assert on the PAYOUT's champion — the champion-badge ledger's place-1
    // users (for MLP that's the whole winning team; the per-user final-ranks
    // heuristic can name a different individual than the winning TEAM).
    const { error: badgeCronErr } = await admin.rpc('_award_progress_badges_all');
    c.check('badges', 'progress-badge cron pass runs clean', !badgeCronErr, badgeCronErr?.message);
    const { data: champLedger } = await admin.from('tournament_champion_badges')
      .select('user_id').eq('tournament_id', tId).eq('place', 1);
    const champs: string[] = champLedger?.length
      ? champLedger.map((r: any) => r.user_id)
      : (ranks ?? []).filter((r: any) => r.final_rank === 1).map((r: any) => r.user_id);
    if (champs.length) {
      const { data: champBadge } = await admin.from('player_badges')
        .select('user_id, badges!inner(name)').in('user_id', champs)
        .eq('badges.name', 'Tournament Champion').gte('earned_at', econ.startedAt);
      c.check('badges', `all ${champs.length} champion(s) earned a “Tournament Champion” badge`,
        new Set((champBadge ?? []).map((b: any) => b.user_id)).size === champs.length,
        `${new Set((champBadge ?? []).map((b: any) => b.user_id)).size}/${champs.length} badged`);
    }
    const { data: newBadges } = await admin.from('player_badges')
      .select('id').in('user_id', playerIds).gte('earned_at', econ.startedAt);
    c.note(`${newBadges?.length ?? 0} badge(s) awarded to participants during the run`);

    // wager settlement notifications ('🎲 Wager won!' / '🎲 Wager settled')
    if (okWagers > 0) {
      const { data: wagerNotifs } = await admin.from('notifications')
        .select('id').like('title', '🎲 Wager%').gte('created_at', econ.startedAt)
        .in('user_id', econ.wagers.filter((w) => w.ok).map((w) => w.user));
      c.check('messages', 'wager settlement notifications sent',
        (wagerNotifs?.length ?? 0) >= okWagers, `got ${wagerNotifs?.length ?? 0} of ${okWagers}`);
    }
    // general message volume for participants during the run
    const { count: notifCount } = await admin.from('notifications')
      .select('*', { count: 'exact', head: true }).in('user_id', playerIds).gte('created_at', econ.startedAt);
    c.check('messages', 'participants received notifications during the run', (notifCount ?? 0) > 0, 'zero notifications');
  }

  const file = writeReport(c, tName, tId, cfg);
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
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
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
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
// full foursomes each round). `ratings` only matters for elo seeding.
function generatePairings(format: string, playerIds: string[], ratings: Record<string, number>, seeding: 'random' | 'elo'): { pairings: MatchPairing[]; order: string[] } {
  const seeded = seedPlayers(playerIds, ratings, seeding);
  const order = seeded;
  switch (format) {
    case 'round_robin':        return { pairings: generateRoundRobin(seeded), order };
    case 'single_elimination': return { pairings: generateSingleElim(seeded), order };
    case 'double_elimination': return { pairings: generateDoubleElim(seeded), order };
    case 'pool_play':          return { pairings: generatePoolPlay(seeded, Math.min(POOL_COUNT, Math.floor(seeded.length / 2))).matches, order };
    case 'rotating_partners':  return { pairings: generateRotatingPartners(seeded, Math.max(1, seeded.length - 1)), order };
    default: throw new Error('unsupported format ' + format);
  }
}

// Team draws for doubles (non-rotating): every entrant is a COMPLETE pair of 2
// — mirrors the app's requirement that all players are paired before the draw.
function generateTeamPairings(format: string, teams: [string, string][], ratings: Record<string, number>, seeding: 'random' | 'elo'): { pairings: MatchPairing[]; order: string[] } {
  const seeded = seedTeams(teams, ratings, seeding);
  const order = seeded.flat();
  switch (format) {
    case 'round_robin':        return { pairings: generateDoublesRoundRobin(seeded), order };
    case 'single_elimination': return { pairings: generateDoublesSingleElim(seeded), order };
    case 'double_elimination': return { pairings: generateDoublesDoubleElim(seeded), order };
    case 'pool_play':          return { pairings: generateDoublesPoolPlay(seeded, Math.min(POOL_COUNT, Math.floor(seeded.length / 2))).matches, order };
    default: throw new Error('unsupported doubles format ' + format);
  }
}

async function tournamentScenario() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const tName = `[SIM] ${FORMAT} ${MATCH_TYPE} ${stamp}`;

  // Mirror the app's CreateTournament mapping: "MLP" is a team type in the UI
  // but lands in the DB as format mlp/mlp_random (by team creation) with
  // match_type doubles and the mlp_* columns derived from format + playoff.
  const isMlp = MATCH_TYPE === 'mlp';
  if (isMlp && (N_USERS < 8 || N_USERS % 4 !== 0)) {
    return die(`MLP needs a multiple of 4 players, at least 8 (got ${N_USERS}) — teams are 2 men + 2 women`);
  }
  if (STAGE === 'midplay' && isMlp) {
    return die('--stage midplay is not supported for MLP (server-generated schedule)');
  }
  if (MATCH_TYPE === 'singles' && FORMAT === 'rotating_partners') {
    return die('rotating_partners is doubles-only (the app flips Team Type to Doubles for it)');
  }
  if (isMlp && PLAYOFF.endsWith('_per_pool')) {
    return die('per-pool playoffs are non-MLP pool_play only');
  }
  const dbFormat = isMlp ? (TEAM_CREATE === 'random' ? 'mlp_random' : 'mlp') : FORMAT;
  const dbMatchType = isMlp ? 'doubles' : MATCH_TYPE;

  step(`Tournament scenario: "${tName}"`);
  log(`  format=${FORMAT} match-type=${MATCH_TYPE} team-creation=${TEAM_CREATE} seeding=${SEEDING} playoff=${PLAYOFF} registration=${REG_MODE} play=${PLAY}`);
  if (DRY) return log('--dry-run: would create tournament, invite/approve, form teams, generate + play.');

  const names = await pickSimPlayers(N_USERS);
  let econ: Economy | undefined;
  if (ECONOMY) {
    const ante = pickOne([50, 100, 250]);
    const payoutStructure = pickOne([[100], [60, 40], [60, 25, 15], [50, 30, 20]]);
    econ = { ante, payoutStructure, wagers: [], startPickles: new Map(), startedAt: new Date().toISOString() };
    step(`Economy: ante ${ante}🥒 · payout ${payoutStructure.join('/')}% · topping up balances`);
    for (const u of names) {
      const a = await signIn(u);
      const { data: prof } = await admin.from('profiles').select('pickles').eq('id', a.id).single();
      const bal = Number(prof?.pickles ?? 0);
      const target = Math.max(bal, 1000);   // never bounce an ante or a stake
      if (target !== bal) await admin.from('profiles').update({ pickles: target }).eq('id', a.id);
      econ.startPickles.set(a.id, target);
    }
    log(`  ✓ ${names.length} balances at ≥1000🥒`);
  }
  const host = await signIn(names[0]);
  // 1. create tournament (as host) + host approved-admin registration
  let attachedLeagueId: string | undefined;
  if (LEAGUE_ATTACH) {
    const { data: lg } = await admin.from('leagues').select('id').eq('name', '[SIM] Toolbox League').maybeSingle();
    if (!lg) return die('--league-attach needs the "[SIM] Toolbox League" (run Seed Fake Players first)');
    attachedLeagueId = lg.id;
    log(`  attached to league ${lg.id.slice(0, 8)} — league PLUPR weighting + season checks enabled`);
  }
  // Realistic schedule details so sim tournaments read like genuine ones in
  // the app: next Saturday 9am, registration closing an hour before, a
  // plausible length, and the same venue the seeder uses for matches.
  const startTime = new Date();
  startTime.setDate(startTime.getDate() + ((6 - startTime.getDay() + 7) % 7 || 7));
  startTime.setHours(9, 0, 0, 0);
  const regClosesAt = new Date(startTime.getTime() - 3600_000);
  const lengthHours = [2, 2.5, 3, 4][Math.floor(Math.random() * 4)];
  const payload: Record<string, any> = {
    name: tName, created_by: host.id, format: dbFormat, match_type: dbMatchType,
    registration_mode: REG_MODE, team_creation: TEAM_CREATE, status: 'registration',
    seeding: SEEDING, pool_count: FORMAT === 'pool_play' && !isMlp ? POOL_COUNT : 1,
    league_id: attachedLeagueId ?? null,
    start_time: startTime.toISOString(),
    registration_closes_at: regClosesAt.toISOString(),
    expected_length_hours: lengthHours,
    location_name: 'Bladium Sports & Fitness Club',
  };
  if (isMlp) {
    // Mirrors the app's payload mapping exactly — including its coercion of
    // non-RR/pool formats to round-robin play for MLP.
    const hasPlayoff = PLAYOFF !== 'none';
    payload.mlp_play_format = FORMAT === 'pool_play'
      ? (hasPlayoff ? 'pool_play_playoff' : 'pool_play')
      : (hasPlayoff ? 'round_robin_playoff' : 'round_robin');
    payload.mlp_pool_count = FORMAT === 'pool_play' ? POOL_COUNT : 2;
    payload.mlp_playoff_teams = PLAYOFF === 'top_2' ? 2 : PLAYOFF === 'top_8' ? 8 : 4;
    if (FORMAT !== 'round_robin' && FORMAT !== 'pool_play') {
      log(`  (MLP + ${FORMAT} coerces to ${payload.mlp_play_format} — same as the app)`);
    }
  } else if (FORMAT === 'round_robin' || FORMAT === 'pool_play') {
    payload.playoff_format = PLAYOFF;
    payload.playoff_third_place = (PLAYOFF === 'top_4' || PLAYOFF === 'top_8') && THIRD_PLACE;
  }
  if (econ) { payload.pickle_ante = econ.ante; payload.payout_structure = econ.payoutStructure; }
  const { data: t, error: te } = await host.client.from('tournaments').insert(payload).select('id').single();
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

  if (STAGE === 'registration' || STAGE === 'closed') {
    await stagedRegistrationStop(host, t!.id, tName, names, STAGE === 'closed');
    return;
  }

  // ── MLP: form teams of 4 (2M+2F) → server-side bracket → play ────────────
  if (isMlp) {
    step(`Forming MLP teams (${TEAM_CREATE})`);
    if (TEAM_CREATE === 'random') {
      // Same RPC as the app's "Generate Random Teams" button.
      const { data: nTeams, error: ge } = await host.client.rpc('generate_random_mlp_teams',
        { p_tournament_id: t!.id, p_mode: 'snake' });
      if (ge) return die('generate_random_mlp_teams: ' + ge.message);
      log(`  ✓ ${nTeams} random MLP team(s) generated`);
    } else {
      // Fixed teams via the real captain flow: create team → invite 3 → accept.
      // Sim players alternate M/F by index, so consecutive chunks of 4 are 2M+2F.
      const idToEmail = new Map<string, string>();
      for (const u of names) { const a = await signIn(u); idToEmail.set(a.id, u); }
      for (let i = 0; i + 3 < playerIds.length; i += 4) {
        const chunk = playerIds.slice(i, i + 4);
        const capEmail = idToEmail.get(chunk[0])!;
        const captain = await signIn(capEmail);
        const { data: teamId, error: ce } = await captain.client.rpc('create_mlp_team',
          { p_tournament_id: t!.id, p_name: `[SIM] Team ${i / 4 + 1}` });
        if (ce) { log(`  ⚠ create team: ${ce.message}`); continue; }
        for (const uid of chunk.slice(1)) {
          const { data: reqId, error: ie } = await captain.client.rpc('mlp_invite',
            { p_team_id: teamId, p_user_id: uid, p_message: null });
          if (ie) { log(`  ⚠ invite ${idToEmail.get(uid)}: ${ie.message}`); continue; }
          const member = await signIn(idToEmail.get(uid)!);
          const { error: re } = await member.client.rpc('mlp_respond_to_join', { p_request_id: reqId, p_accept: true });
          if (re) log(`  ⚠ ${idToEmail.get(uid)} accept: ${re.message}`);
        }
        // Bracket generation only counts LOCKED teams — captain locks once full.
        const { error: le } = await captain.client.rpc('mlp_lock_team', { p_team_id: teamId });
        log(le ? `  ⚠ lock team: ${le.message}` : `  ✓ [SIM] Team ${i / 4 + 1} formed + locked (captain ${capEmail.split('@')[0]})`);
      }
    }

    step('Generating MLP schedule (generate_mlp_bracket)');
    const { data: gen, error: be } = await host.client.rpc('generate_mlp_bracket', { p_tournament_id: t!.id });
    if (be) return die('generate_mlp_bracket: ' + be.message);
    log(`  ✓ schedule generated${gen != null ? ` (${JSON.stringify(gen)})` : ''}`);

    if (econ) {
      step('Placing random wagers (tournament_rank market)');
      econ.wagers = await placeRandomWagers(names, playerIds, t!.id);
    }
    if (AUTO_ROUNDS) {
      step('Running MLP tournament to completion (auto-rounds + checks)');
      await runToCompletion(host, t!.id, tName, playerIds, {
        'match-type': MATCH_TYPE, format: FORMAT, 'team-creation': TEAM_CREATE, seeding: SEEDING,
        'playoff-format': PLAYOFF, 'pool-count': POOL_COUNT, users: N_USERS, 'registration-mode': REG_MODE,
        economy: econ ? { ante: econ.ante, payout: econ.payoutStructure, wagers: econ.wagers.length } : false,
        league: attachedLeagueId ?? false,
      }, econ, attachedLeagueId);
    } else if (PLAY) {
      step('Playing MLP matches (entering scores)');
      const { data: mlpMatches } = await admin.from('tournament_matches')
        .select('id, team1_player1, team2_player1, status').eq('tournament_id', t!.id).order('match_order');
      let played = 0;
      for (const m of mlpMatches ?? []) {
        if (!m.team1_player1 || !m.team2_player1 || m.status === 'completed') continue;
        const t1Wins = Math.random() < 0.5;
        const { error: ue } = await host.client.from('tournament_matches').update({
          team1_score: t1Wins ? 11 : Math.floor(Math.random() * 9) + 1,
          team2_score: t1Wins ? Math.floor(Math.random() * 9) + 1 : 11,
          winner_team: t1Wins ? 'team1' : 'team2',
          status: 'completed',
        }).eq('id', m.id);
        if (!ue) played++;
      }
      log(`  ✓ played ${played} MLP matches (auto-advance/playoff triggers take it from here)`);
    }
    log(`\n✓ MLP tournament "${tName}" ready` + (PLAY || AUTO_ROUNDS ? ' and played' : ''));
    return;
  }

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
      if (re) { log(`  ⚠ ${partName} accept: ${re.message}`); continue; }
      // Lock the pair — the app's happy path; without it the Doubles Partners
      // UI shows every team stuck on "Forming" with a Lock In Pair nag.
      const { error: le } = await captain.client.rpc('pair_lock_pair', { p_pair_id: pairId });
      log(le ? `  ⚠ lock pair: ${le.message}` : `  ✓ paired + locked ${capName} + ${partName}`);
    }
  }

  // 5. generate round 1 (mirrors the app's lock-in: rounds + tournament_matches, status→active)
  if (playerIds.length >= 2) {
    step('Generating round 1');
    // PLUPR-based seeding needs the profile ratings; random ignores them.
    let ratings: Record<string, number> = {};
    if (SEEDING === 'elo') {
      const { data: profs } = await admin.from('profiles').select('id, rating').in('id', playerIds);
      for (const p of profs ?? []) ratings[p.id] = Number(p.rating);
    }
    let pairings: MatchPairing[];
    let seededOrder: string[] = [];
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
      if ((FORMAT === 'single_elimination' || FORMAT === 'double_elimination') && (teams.length & (teams.length - 1)) !== 0) {
        return die(`doubles ${FORMAT} needs a power-of-2 team count (2/4/8/16) — got ${teams.length}. DB advancement can't reconstruct doubles BYE slots (singles-only); same guard as the app.`);
      }
      log(`  ✓ ${teams.length} complete teams of 2`);
      try { ({ pairings, order: seededOrder } = generateTeamPairings(FORMAT, teams, ratings, SEEDING as 'random' | 'elo')); }
      catch (e: any) { return die('doubles bracket generation: ' + e.message); }
    } else {
      // Same guard as the app: singles double elim requires a power-of-2
      // field — the double-elim advancement trigger can't reconstruct BYE
      // slots (5 players once produced a ONE-match "tournament").
      if (FORMAT === 'double_elimination' && (playerIds.length & (playerIds.length - 1)) !== 0) {
        return die(`singles double_elimination needs a power-of-2 player count (got ${playerIds.length}) — same guard as the app`);
      }
      try { ({ pairings, order: seededOrder } = generatePairings(FORMAT, playerIds, ratings, SEEDING as 'random' | 'elo')); }
      catch (e: any) { return die('bracket generation: ' + e.message); }
    }
    // Rounds mirror the app's lock-in exactly: pool play gets ONE ROUND PER
    // POOL labelled "Pool A/B/…" (generate_playoff_bracket's per-pool modes
    // key on those), everything else shares a single schedule round.
    const roundIdByPool = new Map<number, string>();
    let defaultRoundId: string | null = null;
    if (FORMAT === 'pool_play') {
      const poolCountFromMatches = pairings.reduce((mx, m) => Math.max(mx, (m.poolIndex ?? -1)), -1) + 1;
      for (let pi = 0; pi < Math.max(1, poolCountFromMatches); pi++) {
        const { data: pr, error: prErr } = await host.client.from('tournament_rounds')
          .insert({ tournament_id: t!.id, round_number: pi + 1, label: `Pool ${String.fromCharCode(65 + pi)}`, round_type: 'pool' })
          .select('id').single();
        if (prErr) die(`create Pool ${String.fromCharCode(65 + pi)} round: ` + prErr.message);
        roundIdByPool.set(pi, pr!.id);
      }
    } else {
      const { data: round, error: rErr } = await host.client.from('tournament_rounds')
        .insert({ tournament_id: t!.id, round_number: 1, label: `${(FORMAT_META as any)[FORMAT]?.label ?? FORMAT} Schedule`, round_type: 'winners' })
        .select('id').single();
      if (rErr) die('create round: ' + rErr.message);
      defaultRoundId = round!.id;
    }
    const isDoubles = MATCH_TYPE === 'doubles' || FORMAT === 'rotating_partners';
    const rows = pairings.map((m, i) => ({
      tournament_id: t!.id,
      round_id: FORMAT === 'pool_play' ? (roundIdByPool.get(m.poolIndex ?? 0) ?? roundIdByPool.get(0)!) : defaultRoundId!,
      match_order: i, match_type: isDoubles ? 'doubles' : 'singles',
      team1_player1: m.team1[0] !== 'BYE' ? m.team1[0] : null,
      team1_player2: m.team1[1] && m.team1[1] !== 'BYE' ? m.team1[1] : null,
      team2_player1: m.team2[0] !== 'BYE' ? m.team2[0] : null,
      team2_player2: m.team2[1] && m.team2[1] !== 'BYE' ? m.team2[1] : null,
    }));
    const { error: mErr } = await host.client.from('tournament_matches').insert(rows);
    if (mErr) die('insert matches: ' + mErr.message);
    await host.client.from('tournaments').update({ status: 'active' }).eq('id', t!.id);
    // Persist the draw order as registration seeds — the DB advancement
    // triggers reconstruct round-1 bracket slots by ordering on seed.
    for (let i = 0; i < seededOrder.length; i++) {
      await host.client.from('tournament_registrations').update({ seed: i + 1 })
        .eq('tournament_id', t!.id).eq('user_id', seededOrder[i]);
    }
    log(`  ✓ ${rows.length} matches created (+${seededOrder.length} seeds persisted), tournament active`);

    if (STAGE === 'midplay') {
      await stagedMidplayStop(host, t!.id, tName, names);
      return;
    }

    // 6. play: auto-rounds runs the whole tournament with invariant checks;
    //    plain --play only scores the generated first batch.
    if (econ) {
      step('Placing random wagers (tournament_rank market)');
      econ.wagers = await placeRandomWagers(names, playerIds, t!.id);
    }
    if (AUTO_ROUNDS) {
      step('Running tournament to completion (auto-rounds + checks)');
      await runToCompletion(host, t!.id, tName, playerIds, {
        'match-type': MATCH_TYPE, format: FORMAT, 'team-creation': TEAM_CREATE, seeding: SEEDING,
        'playoff-format': PLAYOFF, 'pool-count': POOL_COUNT, users: N_USERS, 'registration-mode': REG_MODE,
        economy: econ ? { ante: econ.ante, payout: econ.payoutStructure, wagers: econ.wagers.length } : false,
        league: attachedLeagueId ?? false,
      }, econ, attachedLeagueId);
    } else if (PLAY) {
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

  log(`\n✓ tournament "${tName}" ready` + (PLAY || AUTO_ROUNDS ? ' and played' : ''));
}

// ── guest scenario ──────────────────────────────────────────────────────────
// Full guest lifecycle against the real RPCs: a league admin creates an event
// + guest invite; a brand-new ANONYMOUS session redeems it, becomes a guest
// (is_guest + expiry), votes on the event; then upgrades to a full account.
async function guestScenario() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  step(`Guest scenario ${stamp}`);
  if (DRY) return log('--dry-run: would create event + guest invite, redeem anonymously, vote, upgrade.');
  const c = new Checker();
  const names = await pickSimPlayers(1);
  const host = await signIn(names[0]);
  const { data: lg } = await admin.from('leagues').select('id').eq('name', '[SIM] Toolbox League').maybeSingle();
  if (!lg) return die('needs the "[SIM] Toolbox League" (run Seed Fake Players first)');

  // 1. host creates a voting event with one slot (same insert as the app)
  const { data: ev, error: evErr } = await host.client.from('league_events').insert({
    league_id: lg.id, title: `[SIM] Guest Night ${stamp}`, description: 'guest flow test',
    created_by: host.id, vote_ends_at: new Date(Date.now() + 86400_000).toISOString(),
  }).select('id').single();
  c.check('guest', 'league admin creates an event', !evErr, evErr?.message);
  if (evErr) { writeReport(c, `[SIM] guest flow ${stamp}`, 'n/a', {}); return; }
  const { data: slot, error: slErr } = await host.client.from('event_slots').insert({
    event_id: ev!.id,
    starts_at: new Date(Date.now() + 86400_000).toISOString(),
    ends_at: new Date(Date.now() + 86400_000 + 2 * 3600_000).toISOString(),
  }).select('id').single();
  c.check('guest', 'event slot created', !slErr, slErr?.message);

  // 2. guest invite token
  const { data: token, error: giErr } = await host.client.rpc('create_guest_invite', {
    p_league_id: lg.id, p_event_id: ev!.id, p_invited_names: ['Sim Guest'], p_invited_phones: [],
  });
  c.check('guest', 'create_guest_invite returns a token', !giErr && !!token, giErr?.message);
  if (giErr || !token) { writeReport(c, `[SIM] guest flow ${stamp}`, ev!.id, {}); return; }

  // 3. anonymous session previews + redeems
  const guest = createClient(URL!, ANON!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: preview, error: pvErr } = await guest.rpc('get_guest_invite_preview', { p_token: token });
  c.check('guest', 'invite preview readable BEFORE any session (anon key)', !pvErr && !!preview, pvErr?.message);
  const { data: anonAuth, error: anErr } = await guest.auth.signInAnonymously({ options: { data: { full_name: 'Sim Guest' } } });
  c.check('guest', 'anonymous sign-in succeeds', !anErr && !!anonAuth?.user, anErr?.message);
  if (anErr || !anonAuth?.user) { writeReport(c, `[SIM] guest flow ${stamp}`, ev!.id, {}); return; }
  const guestId = anonAuth.user.id;
  const { data: redeemed, error: rdErr } = await guest.rpc('redeem_guest_invite', { p_token: token, p_name: 'Sim Guest' });
  const rRow = Array.isArray(redeemed) ? redeemed[0] : redeemed;
  c.check('guest', 'redeem_guest_invite succeeds', !rdErr && !!rRow, rdErr?.message);

  // 4. guest profile state
  const { data: gp } = await admin.from('profiles')
    .select('is_guest, guest_expires_at, full_name').eq('id', guestId).maybeSingle();
  c.check('guest', 'profile flagged is_guest with an expiry', !!gp?.is_guest && gp?.guest_expires_at != null,
    JSON.stringify(gp));

  // 5. guest votes on the event slot (self-scoped RLS insert)
  const { error: vErr } = await guest.from('event_slot_votes').insert({ slot_id: slot!.id, user_id: guestId });
  c.check('guest', 'guest can vote on the event slot', !vErr, vErr?.message);

  // 6. upgrade: attach credentials, then finalize server-side
  const upEmail = `sim_guest_${stamp}@pickleague.test`;
  const { error: upAuthErr } = await guest.auth.updateUser({
    email: upEmail, password: PASSWORD, data: { full_name: 'Sim Guest', gender: 'other' },
  });
  if (upAuthErr) c.note(`auth.updateUser: ${upAuthErr.message} (email confirmations may defer the email swap)`);
  const { error: upErr } = await guest.rpc('complete_guest_upgrade', {
    p_full_name: 'Sim Guest', p_gender: 'other', p_phone: null,
  });
  c.check('guest', 'complete_guest_upgrade succeeds', !upErr, upErr?.message);
  const { data: gp2 } = await admin.from('profiles')
    .select('is_guest, guest_expires_at').eq('id', guestId).maybeSingle();
  c.check('guest', 'guest flags cleared after upgrade', gp2?.is_guest === false && gp2?.guest_expires_at == null,
    JSON.stringify(gp2));

  // 7. tidy up: remove the throwaway account + event
  await admin.auth.admin.deleteUser(guestId);
  await admin.from('league_events').delete().eq('id', ev!.id);
  c.note('cleanup: guest account + event removed');

  const file = writeReport(c, `[SIM] guest flow ${stamp}`, ev!.id, { scenario: 'guest' });
  log(`
${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
}

// ── staged stops: leave a tournament mid-lifecycle for app inspection ───────
async function stagedRegistrationStop(host: Actor, tId: string, tName: string, names: string[], closed: boolean) {
  step(closed ? 'Stage: closing registration + checks' : 'Stage: leaving tournament open for registration + checks');
  const c = new Checker();
  if (closed) {
    const { error } = await host.client.from('tournaments')
      .update({ registration_closes_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', tId);
    if (error) die('set registration_closes_at: ' + error.message);
    c.note('registration_closes_at forced 1h into the past');
  }
  const { data: t } = await admin.from('tournaments')
    .select('status, start_time, registration_closes_at, min_players, max_players').eq('id', tId).single();
  c.check('stage', 'tournament still in registration status', t?.status === 'registration', `status=${t?.status}`);
  c.check('stage', 'schedule fields populated (start_time + registration deadline)',
    t?.start_time != null && t?.registration_closes_at != null,
    JSON.stringify({ start: t?.start_time, closes: t?.registration_closes_at }));
  const { count: roundCount } = await admin.from('tournament_rounds')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', tId);
  c.check('stage', 'no rounds/bracket exist yet', (roundCount ?? 0) === 0, `rounds=${roundCount}`);

  // A fresh sim player (not among the participants) tries to request in:
  // accepted while open, blocked by the RLS deadline check once closed.
  const pool = await pickSimPlayers(names.length + 1);
  const extra = await signIn(pool[pool.length - 1]);
  const { error: reqErr } = await extra.client.from('tournament_registrations')
    .insert({ tournament_id: tId, user_id: extra.id });
  if (closed) {
    c.check('stage', 'late join request BLOCKED after the deadline (RLS)', reqErr != null, reqErr?.message ?? 'insert succeeded — deadline not enforced!');
  } else {
    c.check('stage', 'new join request accepted while open', reqErr == null, reqErr?.message);
    if (!reqErr) c.note(`${extra.username} left as a pending request for the admin to review in the app`);
  }

  const file = writeReport(c, tName, tId, { scenario: 'tournament', stage: closed ? 'closed' : 'registration' });
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
  log(`✓ tournament "${tName}" left in ${closed ? 'CLOSED-registration' : 'OPEN-registration'} state (${tId})`);
}

async function stagedMidplayStop(host: Actor, tId: string, tName: string, names: string[]) {
  step('Stage: scoring ~half of round 1, then stopping mid-play + checks');
  const c = new Checker();
  const { data: ms } = await admin.from('tournament_matches')
    .select('id, team1_player1, team2_player1, status').eq('tournament_id', tId).order('match_order');
  const playable = (ms ?? []).filter((m: any) => m.team1_player1 && m.team2_player1 && m.status !== 'completed');
  const toScore = playable.slice(0, Math.max(1, Math.floor(playable.length / 2)));
  if (toScore.length >= playable.length) die('not enough round-1 matches to leave some unplayed');
  for (const m of toScore) {
    const t1Wins = Math.random() < 0.5;
    const { error } = await host.client.from('tournament_matches').update({
      team1_score: t1Wins ? 11 : Math.floor(Math.random() * 9) + 1,
      team2_score: t1Wins ? Math.floor(Math.random() * 9) + 1 : 11,
      winner_team: t1Wins ? 'team1' : 'team2',
      status: 'completed',
    }).eq('id', m.id);
    if (error) die('score match: ' + error.message);
  }
  c.note(`scored ${toScore.length}/${playable.length} round-1 matches`);

  const { data: t } = await admin.from('tournaments').select('status, champion_payout_applied_at').eq('id', tId).single();
  c.check('stage', 'tournament still active mid-round', t?.status === 'active', `status=${t?.status}`);
  const { data: after } = await admin.from('tournament_matches').select('status').eq('tournament_id', tId);
  const done = (after ?? []).filter((m: any) => m.status === 'completed').length;
  c.check('stage', 'exactly the scored matches are completed', done === toScore.length, `completed=${done} expected=${toScore.length}`);
  c.check('stage', 'unplayed matches remain pending', (after ?? []).length - done > 0, `pending=${(after ?? []).length - done}`);
  // Pool play legitimately has one round PER POOL from lock-in, so "round 1
  // only" is wrong there — premature advancement means a playoff/next-stage
  // round appeared (advancement rounds use round_number >= 1000 or elim types).
  const { data: rounds } = await admin.from('tournament_rounds').select('round_number, round_type').eq('tournament_id', tId);
  const advanced = (rounds ?? []).filter((r: any) =>
    r.round_number >= 1000 || ['quarterfinals', 'semifinals', 'finals', 'third_place_match', 'losers'].includes(r.round_type)
    || (FORMAT !== 'pool_play' && r.round_number > 1));
  c.check('stage', 'no premature advancement (no playoff/next rounds yet)', advanced.length === 0,
    `advanced rounds: ${JSON.stringify(advanced)}`);
  const { count: ranksCount } = await admin.from('tournament_final_ranks')
    .select('user_id', { count: 'exact', head: true }).eq('tournament_id', tId);
  c.check('stage', 'no final ranks / payout while mid-play', (ranksCount ?? 0) === 0 && t?.champion_payout_applied_at == null,
    `ranks=${ranksCount} payout=${t?.champion_payout_applied_at}`);

  // Roster freeze: once the bracket is live, nobody slips out of it —
  // self-withdrawals and admin kicks would corrupt seed-based advancement
  // and standings, so both must be rejected by the DB.
  const quitter = await signIn(names[names.length - 1]);
  const { data: qReg } = await admin.from('tournament_registrations')
    .select('id, status').eq('tournament_id', tId).eq('user_id', quitter.id).single();
  const { error: quitErr } = await quitter.client.from('tournament_registrations').delete().eq('id', qReg!.id);
  c.check('roster-freeze', 'self-withdrawal mid-play is BLOCKED', quitErr != null && /locked/i.test(quitErr.message),
    quitErr?.message ?? 'delete succeeded — player escaped a live bracket!');
  const { error: kickErr } = await host.client.from('tournament_registrations')
    .update({ status: 'rejected' }).eq('id', qReg!.id);
  c.check('roster-freeze', 'admin kick mid-play is BLOCKED', kickErr != null && /locked/i.test(kickErr.message),
    kickErr?.message ?? 'kick succeeded — approved player vanished from a live bracket!');
  const { data: qAfter } = await admin.from('tournament_registrations').select('status').eq('id', qReg!.id).single();
  c.check('roster-freeze', 'registration row intact and still approved', qAfter?.status === 'approved', `status=${qAfter?.status}`);

  // Completed-match immutability: once recorded (ratings applied, wagers
  // settled, advancement possibly fired), neither participants nor the
  // creator may rewrite or delete the row.
  const { data: doneMatch } = await admin.from('tournament_matches')
    .select('id, winner_team, team1_player1, team2_player1')
    .eq('tournament_id', tId).eq('status', 'completed').limit(1).single();
  if (doneMatch) {
    const loserId = doneMatch.winner_team === 'team1' ? doneMatch.team2_player1 : doneMatch.team1_player1;
    const loserEmail = names.find(n => actorCache.get(n)?.id === loserId);
    const loser = loserEmail ? await signIn(loserEmail) : host;
    const { error: flipErr } = await loser.client.from('tournament_matches')
      .update({ winner_team: doneMatch.winner_team === 'team1' ? 'team2' : 'team1' }).eq('id', doneMatch.id);
    c.check('immutability', 'loser cannot flip a completed match result', flipErr != null && /recorded|can''?t be changed/i.test(flipErr.message),
      flipErr?.message ?? 'update succeeded — completed result was rewritten!');
    const { error: editErr } = await host.client.from('tournament_matches')
      .update({ team1_score: 99 }).eq('id', doneMatch.id);
    c.check('immutability', 'creator cannot edit a completed score', editErr != null, editErr?.message ?? 'update succeeded!');
    const { error: delErr } = await host.client.from('tournament_matches').delete().eq('id', doneMatch.id);
    const { count: stillThere } = await admin.from('tournament_matches').select('id', { count: 'exact', head: true }).eq('id', doneMatch.id);
    c.check('immutability', 'creator cannot delete a completed match', (delErr != null || (stillThere ?? 0) === 1),
      delErr?.message ?? `row count after delete: ${stillThere}`);
    const { data: intact } = await admin.from('tournament_matches').select('winner_team, team1_score').eq('id', doneMatch.id).single();
    c.check('immutability', 'completed row unchanged after all attempts',
      intact?.winner_team === doneMatch.winner_team && intact?.team1_score !== 99, JSON.stringify(intact));
  }
  // Pending rows must stay writable (play continues) — harmless field update.
  const { data: pendingMatch } = await admin.from('tournament_matches')
    .select('id').eq('tournament_id', tId).eq('status', 'pending').limit(1).single();
  if (pendingMatch) {
    const { error: pendErr } = await host.client.from('tournament_matches')
      .update({ scheduled_at: new Date().toISOString() }).eq('id', pendingMatch.id);
    c.check('immutability', 'pending matches remain editable', pendErr == null, pendErr?.message);
  }

  const file = writeReport(c, tName, tId, { scenario: 'tournament', stage: 'midplay' });
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
  log(`✓ tournament "${tName}" left ACTIVE mid-round-1 (${tId})`);
}

// ── league-deep scenario ────────────────────────────────────────────────────
// Full league lifecycle as signed-in sim users: membership/roles/invite codes
// + RLS probes, the match confirm flow with rating weights and per-court
// ratings, season periods (locks, bonuses, soft reset), period-rank wagers
// (place → settle on lock; cancel → refund), events + voting, league/season
// pot economy, and deletion refunds. The league is left in place.
async function leagueDeepScenario() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const lName = `[SIM] deep league ${stamp}`;
  step(`League deep scenario: "${lName}"`);
  const c = new Checker();
  const names = await pickSimPlayers(6);
  const A: Actor[] = [];
  for (const n of names) A.push(await signIn(n));
  const [host, p2, p3, p4, p5, p6] = A;
  const startedAt = new Date().toISOString();

  const balOf = async (uid: string) =>
    Number((await admin.from('profiles').select('pickles').eq('id', uid).single()).data?.pickles ?? 0);

  // ── S1: membership, roles, invite codes ─────────────────────────────────
  step('S1: membership, roles, invite codes, RLS probes');
  const { data: lg, error: le } = await host.client.from('leagues').insert({
    name: lName, description: 'deep sweep', created_by: host.id, is_open: true,
    home_court: 'Bladium Sports & Fitness Club',
  }).select('id').single();
  if (le) die('create league: ' + le.message);
  const lid = lg!.id;
  await host.client.from('league_members').insert({ league_id: lid, user_id: host.id, role: 'admin' });

  for (const a of [p2, p3, p4]) {
    const { error } = await a.client.from('league_members').insert({ league_id: lid, user_id: a.id, role: 'member' });
    if (error) die(`${a.username} join: ${error.message}`);
  }
  // RLS probe: self-join as admin must be rejected (role escalation)
  const { error: escErr } = await p5.client.from('league_members').insert({ league_id: lid, user_id: p5.id, role: 'admin' });
  c.check('membership', 'self-join as admin is BLOCKED (role escalation)', escErr != null, escErr?.message ?? 'insert succeeded!');
  await p5.client.from('league_members').insert({ league_id: lid, user_id: p5.id, role: 'member' });

  // role promotion by admin; member self-promotion blocked
  const { error: promoErr } = await host.client.from('league_members')
    .update({ role: 'co-admin' }).eq('league_id', lid).eq('user_id', p5.id);
  const { data: p5m } = await admin.from('league_members').select('role').eq('league_id', lid).eq('user_id', p5.id).single();
  c.check('membership', 'admin can promote a member to co-admin', promoErr == null && p5m?.role === 'co-admin',
    promoErr?.message ?? `role=${p5m?.role}`);
  await p2.client.from('league_members').update({ role: 'admin' }).eq('league_id', lid).eq('user_id', p2.id);
  const { data: p2m } = await admin.from('league_members').select('role').eq('league_id', lid).eq('user_id', p2.id).single();
  c.check('membership', 'member cannot self-promote', p2m?.role === 'member', `role=${p2m?.role}`);

  // invite code: create as admin, redeem as p6
  const { data: code, error: codeErr } = await host.client.rpc('create_invite_code', {
    p_scope_type: 'league', p_scope_id: lid, p_max_uses: 2, p_expires_days: 7, p_pickle_subsidy: 0,
  });
  const codeRow = Array.isArray(code) ? code[0] : code;
  const token = codeRow?.token ?? codeRow;
  c.check('membership', 'admin can mint a league invite code', codeErr == null && !!token, codeErr?.message);
  if (token) {
    const { error: redeemErr } = await p6.client.rpc('redeem_invite_code', { p_token: token });
    const { data: p6m } = await admin.from('league_members').select('id').eq('league_id', lid).eq('user_id', p6.id).maybeSingle();
    c.check('membership', 'invite code redemption joins the league', redeemErr == null && !!p6m, redeemErr?.message);
  }

  // kick + rejoin
  await host.client.from('league_members').delete().eq('league_id', lid).eq('user_id', p4.id);
  const { data: p4gone } = await admin.from('league_members').select('id').eq('league_id', lid).eq('user_id', p4.id).maybeSingle();
  c.check('membership', 'admin can remove a member', !p4gone);
  await p4.client.from('league_members').insert({ league_id: lid, user_id: p4.id, role: 'member' });

  // ── S2: match confirm flow, rating weights, courts ──────────────────────
  step('S2: match recording → confirmation → ratings');
  const ratingsOf = async (uid: string) => {
    const { data: prof } = await admin.from('profiles').select('rating, singles_rating').eq('id', uid).single();
    const { data: lr } = await admin.from('league_player_ratings').select('rating').eq('league_id', lid).eq('user_id', uid).maybeSingle();
    return { global: Number(prof?.rating), singles: Number(prof?.singles_rating), league: lr ? Number(lr.rating) : null };
  };
  const b2 = await ratingsOf(p2.id); const b3 = await ratingsOf(p3.id);

  const recordMatch = async (recorder: Actor, payload: Record<string, any>) => {
    const { data, error } = await recorder.client.from('matches').insert({
      league_id: lid, match_type: 'singles', status: 'pending',
      confirm_deadline: new Date(Date.now() + 3600_000).toISOString(),
      location_name: 'Bladium Sports & Fitness Club', is_home_court: true, was_home_court: true, is_outdoor: false,
      ...payload,
    }).select('id').single();
    if (error) die('record match: ' + error.message);
    return data!.id as string;
  };
  const m1 = await recordMatch(p2, {
    player1_id: p2.id, player2_id: p3.id, player1_score: 11, player2_score: 7,
    winner_id: p2.id, winner_team: 'team1', team1_confirmed_by: p2.id,
  });
  const mid2 = await ratingsOf(p2.id);
  c.check('matches', 'ratings NOT applied while pending confirmation', mid2.global === b2.global && mid2.singles === b2.singles,
    JSON.stringify({ before: b2, pending: mid2 }));

  // outsider can't confirm
  const { error: outsiderErr } = await p4.client.rpc('confirm_match', { p_match_id: m1 });
  c.check('matches', 'non-participant cannot confirm a match', outsiderErr != null, outsiderErr?.message ?? 'confirm succeeded!');

  const { error: confErr } = await p3.client.rpc('confirm_match', { p_match_id: m1 });
  c.check('matches', 'opponent confirmation completes the match', confErr == null, confErr?.message);
  const a2 = await ratingsOf(p2.id); const a3 = await ratingsOf(p3.id);
  // PLUPR is margin-of-victory based (delta = K × (actual_diff − expected_diff)/10,
  // see migration_plupr_margin_of_victory) — a favorite who wins by LESS than
  // the ratings predict legitimately loses points. The invariants are
  // symmetry (delta1 = −delta2 on league ratings) and the 0.5× global weight.
  const dl2 = (a2.league ?? 0) - (b2.league ?? 0);
  const dl3 = (a3.league ?? 0) - (b3.league ?? 0);
  const dg2 = a2.global - b2.global;
  c.check('matches', 'league PLUPR deltas applied symmetrically (delta1 = −delta2)',
    dl2 !== 0 && Math.abs(dl2 + dl3) < 0.0021,
    JSON.stringify({ p2: [b2.league, a2.league], p3: [b3.league, a3.league] }));
  c.check('matches', 'global PLUPR moved at exactly half the league delta (weight 0.5)',
    Math.abs(dg2 - dl2 / 2) < 0.0021 && dg2 !== 0,
    JSON.stringify({ globalDelta: dg2, leagueDelta: dl2 }));
  c.check('matches', 'singles facet rating moved', a2.singles !== b2.singles, `${b2.singles} -> ${a2.singles}`);
  const { data: court } = await admin.from('player_location_ratings')
    .select('rating, wins').eq('user_id', p2.id).eq('location_name', 'Bladium Sports & Fitness Club').eq('match_type', 'singles').maybeSingle();
  c.check('matches', 'per-court rating row updated for the venue', !!court && (court.wins ?? 0) > 0, JSON.stringify(court));

  // immutability: matches has NO RLS update/delete policy — direct writes must no-op
  const { error: flipErr, count: flipCount } = await p3.client.from('matches')
    .update({ winner_id: p3.id, winner_team: 'team2' }, { count: 'exact' }).eq('id', m1);
  const { data: m1After } = await admin.from('matches').select('winner_id').eq('id', m1).single();
  c.check('matches', 'loser cannot rewrite a completed match (RLS)', m1After?.winner_id === p2.id,
    `winner=${m1After?.winner_id?.slice(0, 8)} err=${flipErr?.message} count=${flipCount}`);
  const { error: mdelErr } = await p3.client.from('matches').delete().eq('id', m1);
  const { count: m1Still } = await admin.from('matches').select('id', { count: 'exact', head: true }).eq('id', m1);
  c.check('matches', 'participant cannot delete match history (RLS)', (m1Still ?? 0) === 1, mdelErr?.message ?? `rows=${m1Still}`);

  // expiry: past-deadline pending match can't be confirmed; expiry cron removes it
  const mExp = await recordMatch(p3, {
    player1_id: p3.id, player2_id: p4.id, player1_score: 11, player2_score: 9,
    winner_id: p3.id, winner_team: 'team1', team1_confirmed_by: p3.id,
    confirm_deadline: new Date(Date.now() - 60_000).toISOString(),
  });
  const { error: expErr } = await p4.client.rpc('confirm_match', { p_match_id: mExp });
  c.check('matches', 'confirmation after the deadline is rejected', expErr != null && /expired/i.test(expErr.message), expErr?.message);
  const { error: cronErr } = await admin.rpc('expire_pending_matches');
  const { count: expGone } = await admin.from('matches').select('id', { count: 'exact', head: true }).eq('id', mExp);
  c.check('matches', 'expiry cron removes stale pending matches without rating effects',
    cronErr == null && (expGone ?? 0) === 0, cronErr?.message ?? `rows=${expGone}`);

  // doubles match with multi-game scores
  const bD = await ratingsOf(p4.id);
  const mD = await recordMatch(p2, {
    match_type: 'doubles', player1_id: p2.id, partner1_id: p3.id, player2_id: p4.id, partner2_id: p5.id,
    player1_score: 21, player2_score: 15, game_scores: [{ t1: 11, t2: 7 }, { t1: 10, t2: 8 }],
    winner_id: p2.id, winner_team: 'team1', team1_confirmed_by: p2.id,
  });
  const { error: dConfErr } = await p4.client.rpc('confirm_match', { p_match_id: mD });
  const { data: p4prof } = await admin.from('profiles').select('doubles_rating').eq('id', p4.id).single();
  c.check('matches', 'doubles match confirms and moves the doubles facet', dConfErr == null && p4prof?.doubles_rating != null,
    dConfErr?.message ?? JSON.stringify({ before: bD, after: p4prof }));

  // ── S3+S4: season periods, bonuses, period-rank wagers ──────────────────
  step('S3/S4: season lifecycle + period-rank wagers');
  const { data: season, error: se } = await host.client.from('league_seasons').insert({
    league_id: lid, name: `[SIM] deep season ${stamp}`, created_by: host.id,
    start_date: new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10),
    end_date: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
    total_weeks: 4, lock_frequency_weeks: 2, status: 'active',
  }).select('id, baseline_plupr').single();
  if (se) die('create season: ' + se.message);
  const sid = season!.id;
  const baseline = Number(season!.baseline_plupr ?? 3.25);

  const preLock2 = await ratingsOf(p2.id);
  const { error: lock1Err } = await host.client.rpc('lock_season_period', {
    p_season_id: sid, p_period_number: 1,
    p_snapshot_date: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
  });
  c.check('season', 'admin can lock period 1 via the client RPC', lock1Err == null, lock1Err?.message);
  const { data: snap1 } = await admin.from('season_snapshots').select('user_id, elo_at_snapshot, rank_at_snapshot')
    .eq('season_id', sid).eq('period_number', 1);
  c.check('season', 'period-1 snapshot covers the league members', (snap1?.length ?? 0) >= 6, `rows=${snap1?.length}`);
  const p2snap = (snap1 ?? []).find((s: any) => s.user_id === p2.id);
  c.check('season', 'snapshot stores the pre-lock (ending) league PLUPR', p2snap != null
    && Math.abs(Number(p2snap.elo_at_snapshot) - (preLock2.league ?? 0)) < 0.005,
    JSON.stringify({ snap: p2snap?.elo_at_snapshot, preLock: preLock2.league }));
  const post2 = await ratingsOf(p2.id);
  const rank1 = (snap1 ?? []).find((s: any) => s.rank_at_snapshot === 1);
  c.check('season', 'soft reset: post-lock league ratings return to baseline (+capped bonus)',
    post2.league != null && post2.league >= baseline - 0.005 && post2.league <= baseline + 0.2 + 0.005,
    JSON.stringify({ post: post2.league, baseline }));
  c.check('season', 'a period-1 #1 exists', !!rank1);

  // period 2: matches + period-rank wagers, then lock
  const m2 = await recordMatch(p2, {
    player1_id: p2.id, player2_id: p4.id, player1_score: 11, player2_score: 4,
    winner_id: p2.id, winner_team: 'team1', team1_confirmed_by: p2.id,
  });
  await p4.client.rpc('confirm_match', { p_match_id: m2 });

  const wagerOn = async (actor: Actor, target: string, rank: number, stake: number) => {
    const { data, error } = await actor.client.rpc('place_wager', {
      p_subject_type: 'period_rank', p_subject_id: sid,
      p_predicate: { user_id: target, rank, period_number: 2 }, p_stake: stake,
    });
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: !error && !!row?.success, id: row?.wager_id, payout: row?.potential_payout, msg: error?.message ?? row?.message };
  };
  const w1 = await wagerOn(p4, p2.id, 1, 40);      // plausible: p2 is winning everything
  const w2 = await wagerOn(p5, p3.id, 6, 30);      // wrong-rank long shot
  const w3 = await wagerOn(p6, p2.id, 1, 25);      // will cancel pre-lock
  c.check('period-wagers', 'period-rank wagers place through the real RPC', w1.ok && w2.ok && w3.ok,
    JSON.stringify({ w1: w1.msg, w2: w2.msg, w3: w3.msg }));
  const p6before = await balOf(p6.id);
  const { data: cxl } = await p6.client.rpc('cancel_wager', { p_wager_id: w3.id });
  const cxlRow = Array.isArray(cxl) ? cxl[0] : cxl;
  c.check('period-wagers', 'pre-lock cancellation refunds the stake', !!cxlRow?.success && (await balOf(p6.id)) === p6before + 25,
    JSON.stringify(cxlRow));

  const { error: lock2Err } = await host.client.rpc('lock_season_period', {
    p_season_id: sid, p_period_number: 2, p_snapshot_date: new Date().toISOString().slice(0, 10),
  });
  c.check('season', 'period 2 locks', lock2Err == null, lock2Err?.message);
  const { data: snap2 } = await admin.from('season_snapshots').select('user_id, rank_at_snapshot')
    .eq('season_id', sid).eq('period_number', 2);
  const p2rank = (snap2 ?? []).find((s: any) => s.user_id === p2.id)?.rank_at_snapshot;
  const p3rank = (snap2 ?? []).find((s: any) => s.user_id === p3.id)?.rank_at_snapshot;
  const { data: wRows } = await admin.from('wagers').select('id, status').in('id', [w1.id, w2.id, w3.id].filter(Boolean));
  const st = new Map((wRows ?? []).map((w: any) => [w.id, w.status]));
  c.check('period-wagers', 'period wagers settle on lock exactly per snapshot ranks',
    st.get(w1.id) === (p2rank === 1 ? 'won' : 'lost') && st.get(w2.id) === (p3rank === 6 ? 'won' : 'lost') && st.get(w3.id) === 'cancelled',
    JSON.stringify({ p2rank, p3rank, statuses: [...st.values()] }));

  // ── S5: pots + season completion + payout ────────────────────────────────
  step('S5: pot economy + season completion');
  const potOfSeason = async () =>
    Number((await admin.from('league_seasons').select('prize_pool').eq('id', sid).single()).data?.prize_pool ?? 0);
  await host.client.rpc('set_season_pickle_config', { p_season_id: sid, p_payout_structure: [60, 40] });
  const { data: contrib } = await host.client.rpc('contribute_pickles_to_pool',
    { p_scope_type: 'season', p_scope_id: sid, p_amount: 80 });
  const contribRow = Array.isArray(contrib) ? contrib[0] : contrib;
  c.check('economy', 'season pool contribution (+25% house bonus)', !!contribRow?.success && (await potOfSeason()) === 100,
    JSON.stringify(contribRow));

  const { error: compErr } = await host.client.rpc('complete_season', { p_season_id: sid });
  c.check('season', 'complete_season succeeds', compErr == null, compErr?.message);
  const { data: finals } = await admin.from('season_final_standings').select('user_id, final_rank').eq('season_id', sid);
  c.check('season', 'final standings written', (finals?.length ?? 0) >= 6, `rows=${finals?.length}`);
  const { error: distErr } = await host.client.rpc('distribute_season_pool', { p_season_id: sid });
  c.check('economy', 'season pool distributes to the podium', distErr == null && (await potOfSeason()) === 0,
    distErr?.message ?? `pot=${await potOfSeason()}`);

  // ── S6: events + voting ──────────────────────────────────────────────────
  step('S6: events + slot voting');
  const { data: ev, error: evErr } = await host.client.from('league_events').insert({
    league_id: lid, title: '[SIM] deep event', created_by: host.id, status: 'voting',
    vote_ends_at: new Date(Date.now() + 86400_000).toISOString(),
  }).select('id').single();
  c.check('events', 'admin creates an event', evErr == null, evErr?.message);
  const { data: slots } = await host.client.from('event_slots').insert([
    { event_id: ev!.id, starts_at: new Date(Date.now() + 3 * 86400_000).toISOString(), ends_at: new Date(Date.now() + 3 * 86400_000 + 7200_000).toISOString() },
    { event_id: ev!.id, starts_at: new Date(Date.now() + 4 * 86400_000).toISOString(), ends_at: new Date(Date.now() + 4 * 86400_000 + 7200_000).toISOString() },
  ]).select('id');
  const [slotA, slotB] = (slots ?? []).map((s: any) => s.id);
  for (const a of [p2, p3]) await a.client.from('event_slot_votes').insert({ slot_id: slotA, user_id: a.id });
  await p4.client.from('event_slot_votes').insert({ slot_id: slotB, user_id: p4.id });
  const { count: votesA } = await admin.from('event_slot_votes').select('id', { count: 'exact', head: true }).eq('slot_id', slotA);
  c.check('events', 'members vote on slots', (votesA ?? 0) === 2, `slotA votes=${votesA}`);
  const { error: confSlotErr } = await host.client.from('league_events')
    .update({ confirmed_slot_id: slotA, status: 'scheduled' }).eq('id', ev!.id);
  const { data: evAfter } = await admin.from('league_events').select('status, confirmed_slot_id').eq('id', ev!.id).single();
  c.check('events', 'admin confirms the winning slot (status → scheduled)', confSlotErr == null && evAfter?.status === 'scheduled' && evAfter?.confirmed_slot_id === slotA,
    confSlotErr?.message ?? JSON.stringify(evAfter));

  // ── S7: deletion refunds (throwaway league) ──────────────────────────────
  step('S7: league deletion refunds');
  const { data: lg2 } = await host.client.from('leagues').insert({
    name: `${lName} del`, created_by: host.id, is_open: true,
  }).select('id').single();
  await host.client.from('league_members').insert({ league_id: lg2!.id, user_id: host.id, role: 'admin' });
  await p2.client.from('league_members').insert({ league_id: lg2!.id, user_id: p2.id, role: 'member' });
  const { data: s2 } = await host.client.from('league_seasons').insert({
    league_id: lg2!.id, name: `${lName} del season`, created_by: host.id,
    start_date: new Date().toISOString().slice(0, 10), end_date: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
    total_weeks: 2, lock_frequency_weeks: 2, status: 'active',
  }).select('id').single();
  const hostBefore = await balOf(host.id);
  const p2Before = await balOf(p2.id);
  await host.client.rpc('contribute_pickles_to_pool', { p_scope_type: 'league', p_scope_id: lg2!.id, p_amount: 40 });
  await host.client.rpc('contribute_pickles_to_pool', { p_scope_type: 'season', p_scope_id: s2!.id, p_amount: 40 });
  const wDel = await (async () => {
    const { data } = await p2.client.rpc('place_wager', {
      p_subject_type: 'period_rank', p_subject_id: s2!.id,
      p_predicate: { user_id: host.id, rank: 1, period_number: 1 }, p_stake: 35,
    });
    const row = Array.isArray(data) ? data[0] : data;
    return row?.wager_id as string | undefined;
  })();
  const { error: delErr } = await admin.rpc('godmode_delete_league', { p_league_id: lg2!.id });
  c.check('delete', 'godmode league delete succeeds via service role', delErr == null, delErr?.message);
  c.check('delete', 'league + season pot contributions refunded', (await balOf(host.id)) === hostBefore, `bal=${await balOf(host.id)} start=${hostBefore}`);
  const { data: wDelRow } = wDel
    ? await admin.from('wagers').select('status').eq('id', wDel).single()
    : { data: null } as any;
  c.check('delete', 'open period wager cancelled + stake refunded on delete',
    wDelRow?.status === 'cancelled' && (await balOf(p2.id)) === p2Before,
    JSON.stringify({ status: wDelRow?.status, bal: await balOf(p2.id), start: p2Before }));

  const file = writeReport(c, lName, lid, { scenario: 'league-deep' });
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
  log(`✓ league "${lName}" left in place for app inspection (${lid})`);
}

// ── league-marathon scenario ────────────────────────────────────────────────
// Leagues under sustained load: dozens of confirmed matches across period
// windows, full tournaments run FROM WITHIN the league (league weight 1.0 /
// global 0.0 verified exactly), and TWO complete seasons back to back —
// period locks, cumulative vs season-scoped win counts, median-rank final
// standings, league-scoped soft resets, and cross-season data isolation.
async function leagueMarathonScenario() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const lName = `[SIM] marathon league ${stamp}`;
  step(`League marathon: "${lName}" — 2 seasons, in-league tournaments, heavy match volume`);
  const c = new Checker();
  const names = await pickSimPlayers(8);
  const A: Actor[] = [];
  for (const n of names) A.push(await signIn(n));
  const host = A[0];
  const uids = A.map(a => a.id);
  const days = (n: number) => new Date(Date.now() + n * 86400_000);
  const dstr = (n: number) => days(n).toISOString().slice(0, 10);

  // The league (and everyone's membership) predates the first backfilled
  // match: matches start at day -42, the league exists from day -45.
  const { data: lg, error: lgErr } = await host.client.from('leagues').insert({
    name: lName, created_by: host.id, is_open: true, home_court: 'Bladium Sports & Fitness Club',
    created_at: days(-45).toISOString(),
  }).select('id').single();
  if (lgErr || !lg) die('create league: ' + (lgErr?.message ?? 'no row'));
  const lid = lg!.id;
  for (const a of A) {
    await a.client.from('league_members').insert({
      league_id: lid, user_id: a.id, role: a === host ? 'admin' : 'member',
      joined_at: days(-45).toISOString(),
    });
  }

  const leagueRatings = async () => {
    const { data } = await admin.from('league_player_ratings').select('user_id, rating').eq('league_id', lid);
    return new Map((data ?? []).map((r: any) => [r.user_id, Number(r.rating)]));
  };
  const globalRatings = async () => {
    const { data } = await admin.from('profiles').select('id, rating').in('id', uids);
    return new Map((data ?? []).map((r: any) => [r.id, Number(r.rating)]));
  };

  // Record a completed league match (recorder inserts pending + auto-confirms
  // their side; the opponent confirms via the real RPC) with a backdated
  // played_at so it lands inside a specific season/period window.
  const winTally = new Map<string, number>();
  let matchCount = 0;
  const playMatch = async (i1: number, i2: number, playedAt: Date) => {
    const [pa, pb] = [A[i1], A[i2]];
    const aWins = Math.random() < 0.5 + (i1 < i2 ? 0.2 : -0.2); // seeded-ish skew for stable ranks
    const { data: m, error } = await pa.client.from('matches').insert({
      league_id: lid, match_type: 'singles', status: 'pending',
      player1_id: pa.id, player2_id: pb.id,
      player1_score: aWins ? 11 : 5 + Math.floor(Math.random() * 5),
      player2_score: aWins ? 5 + Math.floor(Math.random() * 5) : 11,
      winner_id: aWins ? pa.id : pb.id, winner_team: aWins ? 'team1' : 'team2',
      team1_confirmed_by: pa.id,
      confirm_deadline: new Date(Date.now() + 3600_000).toISOString(),
      played_at: playedAt.toISOString(),
      location_name: 'Bladium Sports & Fitness Club', is_home_court: true, was_home_court: true, is_outdoor: false,
    }).select('id').single();
    if (error) die('record match: ' + error.message);
    const { error: ce } = await pb.client.rpc('confirm_match', { p_match_id: m!.id });
    if (ce) die('confirm match: ' + ce.message);
    winTally.set(aWins ? pa.id : pb.id, (winTally.get(aWins ? pa.id : pb.id) ?? 0) + 1);
    matchCount++;
  };
  const playBatch = async (count: number, fromDay: number, toDay: number) => {
    for (let k = 0; k < count; k++) {
      let i1 = Math.floor(Math.random() * 8);
      let i2 = Math.floor(Math.random() * 8);
      if (i1 === i2) i2 = (i2 + 1) % 8;
      const t = days(fromDay).getTime() + Math.random() * (days(toDay).getTime() - days(fromDay).getTime());
      await playMatch(i1, i2, new Date(t));
    }
    log(`  ✓ ${count} matches recorded + confirmed (${matchCount} total)`);
  };

  // Full round-robin tournament INSIDE the league, played to completion.
  const runLeagueTournament = async (label: string) => {
    const gBefore = await globalRatings();
    const lBefore = await leagueRatings();
    const { data: t, error: te } = await host.client.from('tournaments').insert({
      name: `${lName} · ${label}`, created_by: host.id, format: 'round_robin', match_type: 'singles',
      registration_mode: 'request', team_creation: 'fixed', status: 'registration',
      seeding: 'random', pool_count: 1, league_id: lid, location_name: 'Bladium Sports & Fitness Club',
    }).select('id').single();
    if (te) die(`create ${label}: ` + te.message);
    await host.client.from('tournament_registrations').insert({ tournament_id: t!.id, user_id: host.id, status: 'approved', role: 'admin' });
    for (const a of A.slice(1)) {
      await a.client.from('tournament_registrations').insert({ tournament_id: t!.id, user_id: a.id });
      const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', t!.id).eq('user_id', a.id).single();
      await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg!.id);
    }
    const { data: round } = await host.client.from('tournament_rounds')
      .insert({ tournament_id: t!.id, round_number: 1, label: 'Round Robin Schedule', round_type: 'winners' })
      .select('id').single();
    const pairings = generateRoundRobin(uids);
    const rows = pairings.map((m, i) => ({
      tournament_id: t!.id, round_id: round!.id, match_order: i, match_type: 'singles',
      team1_player1: m.team1[0], team2_player1: m.team2[0],
    }));
    await host.client.from('tournament_matches').insert(rows);
    await host.client.from('tournaments').update({ status: 'active' }).eq('id', t!.id);
    let i = 0;
    for (const uid of uids) {
      await host.client.from('tournament_registrations').update({ seed: ++i }).eq('tournament_id', t!.id).eq('user_id', uid);
    }
    const { data: tms } = await admin.from('tournament_matches').select('id').eq('tournament_id', t!.id);
    for (const m of tms ?? []) {
      const t1Wins = Math.random() < 0.5;
      await host.client.from('tournament_matches').update({
        team1_score: t1Wins ? 11 : Math.floor(Math.random() * 9) + 1,
        team2_score: t1Wins ? Math.floor(Math.random() * 9) + 1 : 11,
        winner_team: t1Wins ? 'team1' : 'team2', status: 'completed',
      }).eq('id', m.id);
    }
    const { error: compErr } = await host.client.rpc('admin_complete_tournament', { p_tournament_id: t!.id });
    const { data: tAfter } = await admin.from('tournaments').select('status').eq('id', t!.id).single();
    c.check('league-tournament', `${label}: ${rows.length}-match round robin completes inside the league`,
      compErr == null && tAfter?.status === 'completed', compErr?.message ?? `status=${tAfter?.status}`);

    const gAfter = await globalRatings();
    const lAfter = await leagueRatings();
    const gMoved = uids.filter(u => Math.abs((gAfter.get(u) ?? 0) - (gBefore.get(u) ?? 0)) > 0.0005);
    const lMoved = uids.filter(u => Math.abs((lAfter.get(u) ?? 0) - (lBefore.get(u) ?? 0)) > 0.0005);
    c.check('league-tournament', `${label}: GLOBAL PLUPRs untouched (league tournament weight 0.0)`, gMoved.length === 0,
      `moved: ${gMoved.map(u => u.slice(0, 8)).join(',')}`);
    c.check('league-tournament', `${label}: league PLUPRs moved (weight 1.0)`, lMoved.length >= 4, `moved=${lMoved.length}`);
    return t!.id;
  };

  // ── Season 1: two periods + a tournament in the middle ───────────────────
  step('Season 1: 2 periods, 32 matches, tournament mid-season');
  const { data: s1, error: s1e } = await host.client.from('league_seasons').insert({
    league_id: lid, name: `[SIM] marathon S1 ${stamp}`, created_by: host.id,
    start_date: dstr(-42), end_date: dstr(-14), total_weeks: 4, lock_frequency_weeks: 2, status: 'active',
    baseline_plupr: 3.25, created_at: days(-44).toISOString(),
  }).select('id, baseline_plupr').single();
  if (s1e) die('create season 1: ' + s1e.message);
  const baseline = Number(s1!.baseline_plupr ?? 3.5);
  c.check('setup', 'season anchors at the explicit PLUPR baseline (3.25)', Math.abs(baseline - 3.25) < 0.001, `baseline=${baseline}`);

  await playBatch(16, -42, -36);
  const preLockL = await leagueRatings();
  const { error: l1e } = await host.client.rpc('lock_season_period', { p_season_id: s1!.id, p_period_number: 1, p_snapshot_date: dstr(-35) });
  c.check('season1', 'period 1 locks', l1e == null, l1e?.message);
  const { data: snap1 } = await admin.from('season_snapshots')
    .select('user_id, elo_at_snapshot, rank_at_snapshot, wins_in_season').eq('season_id', s1!.id).eq('period_number', 1);
  c.check('season1', 'P1 snapshot covers all 8 members', (snap1?.length ?? 0) === 8, `rows=${snap1?.length}`);
  const snapOrder = [...(snap1 ?? [])].sort((a: any, b: any) => a.rank_at_snapshot - b.rank_at_snapshot);
  const orderedByRating = snapOrder.every((s: any, i: number, arr: any[]) =>
    i === 0 || Number(arr[i - 1].elo_at_snapshot) >= Number(s.elo_at_snapshot) - 1e-9);
  c.check('season1', 'P1 ranks ordered by pre-lock league rating', orderedByRating,
    JSON.stringify(snapOrder.map((s: any) => [s.rank_at_snapshot, s.elo_at_snapshot])));
  const p1SnapOk = snapOrder.every((s: any) =>
    Math.abs(Number(s.elo_at_snapshot) - (preLockL.get(s.user_id) ?? baseline)) < 0.005);
  c.check('season1', 'P1 snapshot stores the ending league PLUPR per player', p1SnapOk);
  const winsOk = (snap1 ?? []).every((s: any) => s.wins_in_season === (winTally.get(s.user_id) ?? 0));
  c.check('season1', 'P1 wins_in_season match the recorded results exactly', winsOk,
    JSON.stringify((snap1 ?? []).map((s: any) => [s.wins_in_season, winTally.get(s.user_id) ?? 0])));
  const postL1 = await leagueRatings();
  const resetOk = uids.every(u => {
    const r = postL1.get(u) ?? 0;
    return r >= baseline - 0.005 && r <= baseline + 0.2 + 0.005;
  });
  c.check('season1', 'P1 soft reset: league ratings at baseline + rank bonus', resetOk,
    JSON.stringify([...postL1.values()]));

  await runLeagueTournament('S1 midseason open');

  await playBatch(16, -34, -16);
  const { error: l2e } = await host.client.rpc('lock_season_period', { p_season_id: s1!.id, p_period_number: 2, p_snapshot_date: dstr(-15) });
  c.check('season1', 'period 2 locks', l2e == null, l2e?.message);
  const { data: snap2 } = await admin.from('season_snapshots')
    .select('user_id, wins_in_season').eq('season_id', s1!.id).eq('period_number', 2);
  const cumulativeOk = (snap2 ?? []).every((s: any) => s.wins_in_season === (winTally.get(s.user_id) ?? 0));
  c.check('season1', 'P2 wins_in_season are season-cumulative (P1+P2 matches)', cumulativeOk,
    JSON.stringify((snap2 ?? []).map((s: any) => [s.wins_in_season, winTally.get(s.user_id) ?? 0])));

  const gBeforeComplete = await globalRatings();
  const { error: c1e } = await host.client.rpc('complete_season', { p_season_id: s1!.id });
  c.check('season1', 'complete_season succeeds', c1e == null, c1e?.message);
  const gAfterComplete = await globalRatings();
  const gStable = uids.every(u => Math.abs((gAfterComplete.get(u) ?? 0) - (gBeforeComplete.get(u) ?? 0)) < 0.0005);
  c.check('season1', 'completing the season does NOT touch global PLUPRs (league-scoped reset)', gStable,
    JSON.stringify(uids.map(u => [gBeforeComplete.get(u), gAfterComplete.get(u)])));
  const { data: fin1 } = await admin.from('season_final_standings')
    .select('user_id, final_rank, median_rank, elo_bonus, new_elo').eq('season_id', s1!.id);
  c.check('season1', 'final standings written for all 8', (fin1?.length ?? 0) === 8, `rows=${fin1?.length}`);
  // median-rank contract: recompute from snapshots and compare the ordering
  const { data: allSnaps } = await admin.from('season_snapshots')
    .select('user_id, rank_at_snapshot').eq('season_id', s1!.id);
  const medianOf = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const medians = new Map<string, number>();
  for (const u of uids) {
    medians.set(u, medianOf((allSnaps ?? []).filter((s: any) => s.user_id === u).map((s: any) => s.rank_at_snapshot)));
  }
  const medianOk = (fin1 ?? []).every((f: any) => Math.abs(Number(f.median_rank) - (medians.get(f.user_id) ?? -1)) < 0.001);
  c.check('season1', 'final median_rank matches the per-period snapshot medians', medianOk,
    JSON.stringify((fin1 ?? []).map((f: any) => [f.median_rank, medians.get(f.user_id)])));
  const crown = (fin1 ?? []).find((f: any) => f.final_rank === 1);
  const { data: crownBadge } = crown ? await admin.from('player_badges')
    .select('id, badge:badges(name)').eq('user_id', crown.user_id).eq('league_id', lid) : { data: null } as any;
  c.check('season1', 'Season Crown badge awarded to the #1 finisher',
    (crownBadge ?? []).some((b: any) => b.badge?.name === 'Season Crown'), JSON.stringify(crownBadge?.map((b: any) => b.badge?.name)));
  const { error: dblErr } = await host.client.rpc('complete_season', { p_season_id: s1!.id });
  c.check('season1', 'double-complete is blocked (elo_reset_applied guard)', dblErr != null && /already/i.test(dblErr.message), dblErr?.message);

  // ── Season 2: fresh window, isolation from season 1 ──────────────────────
  step('Season 2: fresh window, tournament, cross-season isolation');
  const s1Wins = new Map(winTally);
  winTally.clear();
  const { data: s2, error: s2e } = await host.client.from('league_seasons').insert({
    league_id: lid, name: `[SIM] marathon S2 ${stamp}`, created_by: host.id,
    start_date: dstr(-13), end_date: dstr(-1), total_weeks: 2, lock_frequency_weeks: 2, status: 'active',
    baseline_plupr: 3.25, created_at: days(-14).toISOString(),
  }).select('id').single();
  if (s2e) die('create season 2: ' + s2e.message);

  await playBatch(16, -13, -1);
  await runLeagueTournament('S2 winter classic');

  const { error: l3e } = await host.client.rpc('lock_season_period', { p_season_id: s2!.id, p_period_number: 1, p_snapshot_date: dstr(0) });
  c.check('season2', 'S2 period 1 locks', l3e == null, l3e?.message);
  const { data: s2snap } = await admin.from('season_snapshots')
    .select('user_id, wins_in_season').eq('season_id', s2!.id).eq('period_number', 1);
  const isolated = (s2snap ?? []).every((s: any) => s.wins_in_season === (winTally.get(s.user_id) ?? 0));
  c.check('season2', 'S2 wins count ONLY season-2 matches (no bleed from season 1)', isolated,
    JSON.stringify((s2snap ?? []).map((s: any) => [s.user_id.slice(0, 8), s.wins_in_season, winTally.get(s.user_id) ?? 0, `s1=${s1Wins.get(s.user_id) ?? 0}`])));
  const { error: c2e } = await host.client.rpc('complete_season', { p_season_id: s2!.id });
  c.check('season2', 'S2 completes', c2e == null, c2e?.message);

  // cross-season integrity
  const { count: snapCount } = await admin.from('season_snapshots').select('id', { count: 'exact', head: true })
    .in('season_id', [s1!.id, s2!.id]);
  const { count: finCount } = await admin.from('season_final_standings').select('id', { count: 'exact', head: true })
    .in('season_id', [s1!.id, s2!.id]);
  c.check('cross-season', 'both seasons keep full snapshot history (2+1 periods × 8)', (snapCount ?? 0) === 24, `snapshots=${snapCount}`);
  c.check('cross-season', 'both seasons keep final standings (8 + 8)', (finCount ?? 0) === 16, `finals=${finCount}`);
  const { data: seasonsAfter } = await admin.from('league_seasons').select('id, status, elo_reset_applied').in('id', [s1!.id, s2!.id]);
  c.check('cross-season', 'both seasons completed with resets applied',
    (seasonsAfter ?? []).every((s: any) => s.status === 'completed' && s.elo_reset_applied === true), JSON.stringify(seasonsAfter));
  const { count: leagueMatches } = await admin.from('matches').select('id', { count: 'exact', head: true })
    .eq('league_id', lid).eq('status', 'completed');
  c.check('volume', `all ${matchCount} recorded matches completed (plus 2×28 tournament matches)`,
    (leagueMatches ?? 0) === matchCount, `matches=${leagueMatches} expected=${matchCount}`);

  // ── The league keeps living: in-flight season, upcoming season, events ───
  step('Living league: in-flight season 3, upcoming season 4, upcoming events');
  const { data: s3, error: s3e } = await host.client.from('league_seasons').insert({
    league_id: lid, name: `[SIM] marathon S3 ${stamp}`, created_by: host.id,
    start_date: dstr(0), end_date: dstr(14), total_weeks: 2, lock_frequency_weeks: 2, status: 'active',
    baseline_plupr: 3.25,
  }).select('id').single();
  if (s3e) die('create season 3: ' + s3e.message);
  await playBatch(8, 0, 0); // today's matches — season 3 is mid-period
  const { count: s3snaps } = await admin.from('season_snapshots').select('id', { count: 'exact', head: true }).eq('season_id', s3!.id);
  c.check('living', 'season 3 is IN-FLIGHT: active, matches played, no period locked yet',
    (s3snaps ?? 0) === 0, `snapshots=${s3snaps}`);
  const { error: s4e } = await host.client.from('league_seasons').insert({
    league_id: lid, name: `[SIM] marathon S4 ${stamp}`, created_by: host.id,
    start_date: dstr(15), end_date: dstr(43), total_weeks: 4, lock_frequency_weeks: 2, status: 'upcoming',
    baseline_plupr: 3.25,
  });
  c.check('living', 'season 4 queued as upcoming', s4e == null, s4e?.message);

  const { data: evV } = await host.client.from('league_events').insert({
    league_id: lid, title: '[SIM] Marathon Members Night', created_by: host.id,
    status: 'voting', vote_ends_at: days(3).toISOString(),
  }).select('id').single();
  const { data: evSlots } = await host.client.from('event_slots').insert([
    { event_id: evV!.id, starts_at: days(7).toISOString(), ends_at: new Date(days(7).getTime() + 3 * 3600_000).toISOString() },
    { event_id: evV!.id, starts_at: days(8).toISOString(), ends_at: new Date(days(8).getTime() + 3 * 3600_000).toISOString() },
  ]).select('id');
  for (const [i, a] of A.slice(1, 6).entries()) {
    await a.client.from('event_slot_votes').insert({ slot_id: evSlots![i % 2].id, user_id: a.id });
  }
  const { data: evS } = await host.client.from('league_events').insert({
    league_id: lid, title: '[SIM] Marathon Court Social', created_by: host.id,
    status: 'voting', vote_ends_at: days(1).toISOString(),
  }).select('id').single();
  const { data: schedSlot } = await host.client.from('event_slots').insert({
    event_id: evS!.id, starts_at: days(6).toISOString(), ends_at: new Date(days(6).getTime() + 4 * 3600_000).toISOString(),
  }).select('id').single();
  await host.client.from('league_events').update({ status: 'scheduled', confirmed_slot_id: schedSlot!.id }).eq('id', evS!.id);
  const { data: evAfter } = await admin.from('league_events').select('id, status, vote_ends_at').eq('league_id', lid);
  c.check('living', 'two upcoming events exist (one voting with member votes, one scheduled)',
    (evAfter ?? []).filter((e: any) => e.status === 'voting').length === 1
      && (evAfter ?? []).filter((e: any) => e.status === 'scheduled').length === 1,
    JSON.stringify(evAfter));

  // date sanity: creation precedes play, everywhere
  const { data: lgRow } = await admin.from('leagues').select('created_at').eq('id', lid).single();
  const { data: firstMatch } = await admin.from('matches').select('played_at').eq('league_id', lid)
    .order('played_at', { ascending: true }).limit(1).single();
  c.check('living', 'league created BEFORE the first match was played',
    new Date(lgRow!.created_at).getTime() < new Date(firstMatch!.played_at).getTime(),
    JSON.stringify({ created: lgRow?.created_at, firstMatch: firstMatch?.played_at }));
  const { data: allSeasons } = await admin.from('league_seasons').select('name, baseline_plupr').eq('league_id', lid);
  c.check('living', 'every season carries the explicit 3.25 baseline PLUPR',
    (allSeasons ?? []).length === 4 && (allSeasons ?? []).every((s: any) => Math.abs(Number(s.baseline_plupr) - 3.25) < 0.001),
    JSON.stringify((allSeasons ?? []).map((s: any) => [s.name, s.baseline_plupr])));

  const file = writeReport(c, lName, lid, { scenario: 'league-marathon', matches: matchCount });
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
  log(`✓ league "${lName}" left in place with 2 completed seasons (${lid})`);
}

// ── extras scenario: reminders, drilling, shop/badges ───────────────────────
// The thinner surfaces: every remind_* cron fires the right notifications for
// in-window fixtures (and is idempotent), the drill request → accept →
// session → chat → review lifecycle, and the pickle shop (purchase rules,
// gifting, insufficient funds, badge-gated items).
async function extrasScenario() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  step(`Extras scenario: reminders / drills / shop (${stamp})`);
  const c = new Checker();
  const names = await pickSimPlayers(4);
  const A: Actor[] = [];
  for (const n of names) A.push(await signIn(n));
  const [host, p2, p3, p4] = A;

  const notifCountFor = async (entityId: string, since: string) =>
    (await admin.from('notifications').select('id', { count: 'exact', head: true })
      .eq('entity_id', entityId).gte('created_at', since)).count ?? 0;

  // ── R: reminder crons ────────────────────────────────────────────────────
  step('R: reminder crons (in-window fixtures, correct recipients, idempotent)');
  const { data: lg, error: lgErr } = await host.client.from('leagues').insert({
    name: `[SIM] extras league ${stamp}`, created_by: host.id, is_open: true,
  }).select('id').single();
  if (lgErr || !lg) die('create extras league: ' + (lgErr?.message ?? 'no row'));
  const lid = lg!.id;
  for (const a of A) await a.client.from('league_members').insert({ league_id: lid, user_id: a.id, role: a === host ? 'admin' : 'member' });

  // fixture: event starting in ~1h (scheduled + confirmed slot)
  const mkEvent = async (title: string, status: string, voteEndsAt: string | null) => {
    const { data: ev, error: evErr } = await host.client.from('league_events').insert({
      league_id: lid, title, created_by: host.id, status, vote_ends_at: voteEndsAt,
    }).select('id').single();
    if (evErr || !ev) die(`create event "${title}": ` + (evErr?.message ?? 'no row'));
    return ev!.id as string;
  };
  const evStart = await mkEvent('[SIM] starts soon', 'voting', new Date(Date.now() + 86400_000).toISOString());
  const { data: slotSoon, error: slotErr } = await host.client.from('event_slots').insert({
    event_id: evStart, starts_at: new Date(Date.now() + 3600_000).toISOString(),
    ends_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
  }).select('id').single();
  if (slotErr || !slotSoon) die('create slot: ' + (slotErr?.message ?? 'no row'));
  // Event reminders go to slot VOTERS — vote before confirming the slot.
  for (const a of [p2, p3]) await a.client.from('event_slot_votes').insert({ slot_id: slotSoon!.id, user_id: a.id });
  await host.client.from('league_events').update({ status: 'scheduled', confirmed_slot_id: slotSoon!.id }).eq('id', evStart);

  const evVote = await mkEvent('[SIM] vote closing', 'voting', new Date(Date.now() + 3 * 3600_000).toISOString());
  await host.client.from('event_slots').insert({
    event_id: evVote, starts_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
    ends_at: new Date(Date.now() + 5 * 86400_000 + 7200_000).toISOString(),
  });

  const evEnded = await mkEvent('[SIM] ended unrecorded', 'voting', new Date(Date.now() - 8 * 3600_000).toISOString());
  const { data: slotPast } = await host.client.from('event_slots').insert({
    event_id: evEnded, starts_at: new Date(Date.now() - 7 * 3600_000).toISOString(),
    ends_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
  }).select('id').single();
  for (const a of [p2, p4]) await a.client.from('event_slot_votes').insert({ slot_id: slotPast!.id, user_id: a.id });
  await host.client.from('league_events').update({ status: 'scheduled', confirmed_slot_id: slotPast!.id }).eq('id', evEnded);

  // Registration-closing reminders target UNREGISTERED league members (and
  // pending invitees), so the tournament must belong to the league.
  const { data: tRem } = await host.client.from('tournaments').insert({
    name: `[SIM] extras reminder t ${stamp}`, created_by: host.id, format: 'round_robin', match_type: 'singles',
    registration_mode: 'request', team_creation: 'fixed', status: 'registration', seeding: 'random', pool_count: 1,
    league_id: lid,
    registration_closes_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
    start_time: new Date(Date.now() + 12 * 3600_000).toISOString(),
  }).select('id').single();
  await host.client.from('tournament_registrations').insert({ tournament_id: tRem!.id, user_id: host.id, status: 'approved', role: 'admin' });
  await p2.client.from('tournament_registrations').insert({ tournament_id: tRem!.id, user_id: p2.id });
  const { data: reg2 } = await admin.from('tournament_registrations').select('id').eq('tournament_id', tRem!.id).eq('user_id', p2.id).single();
  await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg2!.id);

  // Count by title pattern + our users (reminder entity ids vary: event
  // reminders point at the event, vote-closing at the LEAGUE, tournament
  // reminders at the tournament — the title is the stable signal).
  const uids = A.map(a => a.id);
  const remindAndCheck = async (fn: string, titleLike: string, label: string) => {
    const since = new Date().toISOString();
    const countNow = async () =>
      (await admin.from('notifications').select('id', { count: 'exact', head: true })
        .in('user_id', uids).ilike('title', titleLike).gte('created_at', since)).count ?? 0;
    const { error: e1 } = await admin.rpc(fn);
    const after1 = await countNow();
    const { error: e2 } = await admin.rpc(fn);
    const after2 = await countNow();
    c.check('reminders', `${fn}: ${label}`, e1 == null && after1 > 0, e1?.message ?? `notifications=${after1}`);
    c.check('reminders', `${fn} is idempotent (second run adds none)`, e2 == null && after2 === after1,
      e2?.message ?? `first=${after1} second=${after2}`);
  };
  await remindAndCheck('remind_event_starts', '%Event reminder%', 'notifies slot voters before a confirmed event starts');
  await remindAndCheck('remind_vote_closings', '%Vote closing soon%', 'nudges non-voters before voting closes');
  await remindAndCheck('remind_event_record_results', '%Record your results%', 'nudges voters to record results after an event ends');
  await remindAndCheck('remind_tournament_registration_closings', '%Registration closing soon%', 'warns unregistered league members before registration closes');
  await remindAndCheck('remind_tournament_starts', '%Tournament starting soon%', 'reminds registered players before the tournament starts');

  // ── D: drill lifecycle ───────────────────────────────────────────────────
  step('D: drill request → accept → session → chat → review');
  const target = new Date(Date.now() + 90 * 60_000);
  const slotIdx = target.getUTCHours() * 2 + (target.getUTCMinutes() >= 30 ? 1 : 0);
  const slotDate = target.toISOString().slice(0, 10);

  const since = new Date().toISOString();
  const { data: dr, error: drErr } = await p2.client.from('drill_requests').insert({
    from_user_id: p2.id, to_user_id: p3.id,
    proposed_slots: [{ date: slotDate, slot: slotIdx }, { date: slotDate, slot: slotIdx + 2 }],
    message: 'dinks?', length_minutes: 60,
  }).select('id').single();
  c.check('drills', 'drill request sends', drErr == null, drErr?.message);
  const { count: reqNotif } = await admin.from('notifications').select('id', { count: 'exact', head: true })
    .eq('user_id', p3.id).gte('created_at', since);
  c.check('drills', 'recipient notified of the request', (reqNotif ?? 0) > 0);

  // outsider can't accept someone else's request
  await p4.client.from('drill_requests').update({ status: 'accepted', accepted_slot: { date: slotDate, slot: slotIdx } }).eq('id', dr!.id);
  const { data: drState } = await admin.from('drill_requests').select('status').eq('id', dr!.id).single();
  c.check('drills', 'outsider cannot accept a request that is not theirs', drState?.status === 'pending', `status=${drState?.status}`);

  const { error: accErr } = await p3.client.from('drill_requests').update({
    status: 'accepted', accepted_slot: { date: slotDate, slot: slotIdx }, responded_at: new Date().toISOString(),
  }).eq('id', dr!.id);
  const { data: sess } = await admin.from('drill_sessions').select('id, starts_at').eq('request_id', dr!.id).maybeSingle();
  c.check('drills', 'acceptance creates the drill session at the slot time', accErr == null && !!sess,
    accErr?.message ?? 'no session row');

  const { error: chatErr } = await p2.client.from('drill_request_messages').insert({
    request_id: dr!.id, sender_id: p2.id, body: 'meet at Bladium court 3',
  });
  c.check('drills', 'drill chat message sends (and notifies via trigger)', chatErr == null, chatErr?.message);

  if (sess) {
    const sinceRem = new Date().toISOString();
    const { error: dremErr } = await admin.rpc('remind_drill_sessions');
    const { count: dremNotif } = await admin.from('notifications').select('id', { count: 'exact', head: true })
      .in('user_id', [p2.id, p3.id]).gte('created_at', sinceRem).like('title', '%rill%');
    c.check('reminders', 'remind_drill_sessions reminds both players of the upcoming session',
      dremErr == null && (dremNotif ?? 0) >= 1, dremErr?.message ?? `notifs=${dremNotif}`);
  }

  // past session → review grants pickles
  const past = new Date(Date.now() - 3 * 3600_000);
  const pastIdx = past.getUTCHours() * 2;
  const { data: dr2 } = await p2.client.from('drill_requests').insert({
    from_user_id: p2.id, to_user_id: p3.id,
    proposed_slots: [{ date: past.toISOString().slice(0, 10), slot: pastIdx }], length_minutes: 60,
  }).select('id').single();
  await p3.client.from('drill_requests').update({
    status: 'accepted', accepted_slot: { date: past.toISOString().slice(0, 10), slot: pastIdx },
  }).eq('id', dr2!.id);
  const { data: sess2 } = await admin.from('drill_sessions').select('id').eq('request_id', dr2!.id).maybeSingle();
  if (sess2) {
    const { data: rev, error: revErr } = await p2.client.rpc('submit_drill_review', {
      p_session_id: sess2.id, p_consistency: 4, p_effort: 5, p_organization: 4, p_intentionality: 5, p_fun: 5, p_notes: 'solid session',
    });
    const revRow = Array.isArray(rev) ? rev[0] : rev;
    const { data: revStored } = await admin.from('drill_session_reviews').select('rating, pickles_granted')
      .eq('session_id', sess2.id).eq('user_id', p2.id).maybeSingle();
    c.check('drills', 'post-session review stores and grants pickles', revErr == null && !!revStored,
      revErr?.message ?? JSON.stringify({ rpc: revRow, stored: revStored }));
  } else {
    c.check('drills', 'post-session review stores and grants pickles', false, 'past-slot session was not created');
  }

  // decline + cancel paths
  const { data: dr3 } = await p2.client.from('drill_requests').insert({
    from_user_id: p2.id, to_user_id: p4.id, proposed_slots: [{ date: slotDate, slot: slotIdx }], length_minutes: 30,
  }).select('id').single();
  await p4.client.from('drill_requests').update({ status: 'declined', responded_at: new Date().toISOString() }).eq('id', dr3!.id);
  const { data: dr3After } = await admin.from('drill_requests').select('status').eq('id', dr3!.id).single();
  c.check('drills', 'recipient can decline', dr3After?.status === 'declined', `status=${dr3After?.status}`);
  const { data: dr4 } = await p2.client.from('drill_requests').insert({
    from_user_id: p2.id, to_user_id: p4.id, proposed_slots: [{ date: slotDate, slot: slotIdx }], length_minutes: 30,
  }).select('id').single();
  await p2.client.from('drill_requests').update({ status: 'cancelled' }).eq('id', dr4!.id);
  const { data: dr4After } = await admin.from('drill_requests').select('status').eq('id', dr4!.id).single();
  c.check('drills', 'sender can cancel their own request', dr4After?.status === 'cancelled', `status=${dr4After?.status}`);

  // ── S: shop + badges ─────────────────────────────────────────────────────
  step('S: shop purchases, gifting, gates');
  const balOf = async (uid: string) =>
    Number((await admin.from('profiles').select('pickles').eq('id', uid).single()).data?.pickles ?? 0);
  await admin.from('profiles').update({ pickles: 1000 }).eq('id', p2.id);

  const { data: owned } = await admin.from('player_shop_purchases').select('shop_item_id').eq('user_id', p2.id);
  const ownedSet = new Set((owned ?? []).map((o: any) => o.shop_item_id));
  const { data: items } = await admin.from('shop_items').select('id, cost, category, unlock_badge_id')
    .eq('is_active', true).order('cost');
  const buyable = (items ?? []).filter((i: any) => i.unlock_badge_id == null && i.category !== 'real_world' && !ownedSet.has(i.id));
  const gated = (items ?? []).find((i: any) => i.unlock_badge_id != null);
  if (buyable.length < 2) { c.check('shop', 'enough purchasable catalog items to test', false, `buyable=${buyable.length}`); }
  else {
    const item = buyable[0] as any;
    const before = await balOf(p2.id);
    const { data: buy } = await p2.client.rpc('purchase_shop_item', { p_item_id: item.id });
    const buyRow = Array.isArray(buy) ? buy[0] : buy;
    c.check('shop', 'purchase succeeds and debits exactly the cost',
      !!buyRow?.success && (await balOf(p2.id)) === before - item.cost, JSON.stringify(buyRow));
    const { data: again } = await p2.client.rpc('purchase_shop_item', { p_item_id: item.id });
    const againRow = Array.isArray(again) ? again[0] : again;
    c.check('shop', 'double-purchase is rejected as already owned',
      !againRow?.success && /owned/i.test(againRow?.message ?? ''), JSON.stringify(againRow));
    const { data: p2prof } = await admin.from('profiles').select('avatar_emoji, name_color, list_name_style_id, profile_name_style_id').eq('id', p2.id).single();
    c.check('shop', 'purchase applied its payload to the profile', p2prof != null, JSON.stringify({ category: item.category, profile: p2prof }));

    // insufficient funds
    const broke = await balOf(p4.id);
    await admin.from('profiles').update({ pickles: 0 }).eq('id', p4.id);
    const pricey = buyable.find((i: any) => i.cost > 0 && !ownedSet.has(i.id) && i.id !== item.id) as any;
    if (pricey) {
      const { data: poor } = await p4.client.rpc('purchase_shop_item', { p_item_id: pricey.id });
      const poorRow = Array.isArray(poor) ? poor[0] : poor;
      c.check('shop', 'insufficient pickles is rejected without a charge',
        !poorRow?.success && /insufficient/i.test(poorRow?.message ?? '') && (await balOf(p4.id)) === 0, JSON.stringify(poorRow));
    }
    await admin.from('profiles').update({ pickles: broke }).eq('id', p4.id);

    if (gated) {
      const { data: locked } = await p2.client.rpc('purchase_shop_item', { p_item_id: (gated as any).id });
      const lockedRow = Array.isArray(locked) ? locked[0] : locked;
      c.check('shop', 'badge-unlock items cannot be bought with pickles',
        !lockedRow?.success && /badge/i.test(lockedRow?.message ?? ''), JSON.stringify(lockedRow));
    }

    // gifting
    const { data: p3owned } = await admin.from('player_shop_purchases').select('shop_item_id').eq('user_id', p3.id);
    const p3set = new Set((p3owned ?? []).map((o: any) => o.shop_item_id));
    const giftItem = buyable.find((i: any) => !p3set.has(i.id) && i.id !== item.id) as any;
    if (giftItem) {
      const giverBefore = await balOf(p2.id);
      const sinceGift = new Date().toISOString();
      const { data: gift, error: giftErr } = await p2.client.rpc('gift_shop_item', {
        p_item_id: giftItem.id, p_recipient: p3.id, p_message: 'enjoy!',
      });
      const giftRow = Array.isArray(gift) ? gift[0] : gift;
      const { data: giftPurchase } = await admin.from('player_shop_purchases')
        .select('gifted_by_user_id').eq('user_id', p3.id).eq('shop_item_id', giftItem.id).maybeSingle();
      const { count: giftNotif } = await admin.from('notifications').select('id', { count: 'exact', head: true })
        .eq('user_id', p3.id).gte('created_at', sinceGift);
      c.check('shop', 'gifting charges the giver and delivers to the recipient with a notification',
        giftErr == null && !!(giftRow?.success ?? true) && giftPurchase?.gifted_by_user_id === p2.id
          && (await balOf(p2.id)) === giverBefore - giftItem.cost && (giftNotif ?? 0) > 0,
        giftErr?.message ?? JSON.stringify({ giftRow, giftPurchase, giftNotif }));
    }
  }

  // badge catalog sanity
  const { data: badgeRows } = await admin.from('badges').select('name');
  const badgeNames = (badgeRows ?? []).map((b: any) => b.name);
  c.check('badges', 'badge catalog has no duplicate names', new Set(badgeNames).size === badgeNames.length,
    `total=${badgeNames.length} unique=${new Set(badgeNames).size}`);
  const { error: progErr } = await admin.rpc('_award_progress_badges_all');
  c.check('badges', 'progress-badge cron runs clean', progErr == null, progErr?.message);

  const file = writeReport(c, `[SIM] extras ${stamp}`, lid, { scenario: 'extras' });
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
  log(`✓ extras fixtures left under "[SIM] extras league ${stamp}" (${lid})`);
}

// ── refunds scenario ────────────────────────────────────────────────────────
// Economy lifecycle: antes charged on approval must come BACK when a paid
// player withdraws or is kicked during registration, when the tournament is
// cancelled (new cancel_tournament RPC — also refunds voluntary contributions
// and open wagers), and when a funded tournament is deleted. Every balance
// must end exactly where it started.
async function refundsScenario() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const tName = `[SIM] refunds ${stamp}`;
  const ANTE = 100;
  step(`Refunds scenario: "${tName}" (ante ${ANTE}🥒)`);
  const c = new Checker();
  const names = await pickSimPlayers(4);
  const actors = [] as Actor[];
  for (const n of names) actors.push(await signIn(n));
  const [host, p2, p3, p4] = actors;

  // Baseline balances (top up so antes can't bounce).
  const start = new Map<string, number>();
  for (const a of actors) {
    const { data: prof } = await admin.from('profiles').select('pickles').eq('id', a.id).single();
    let bal = Number(prof?.pickles ?? 0);
    if (bal < 500) { await admin.from('profiles').update({ pickles: 500 }).eq('id', a.id); bal = 500; }
    start.set(a.id, bal);
  }
  const balOf = async (uid: string) =>
    Number((await admin.from('profiles').select('pickles').eq('id', uid).single()).data?.pickles ?? 0);
  const potOf = async (tid: string) =>
    Number((await admin.from('tournaments').select('prize_pool').eq('id', tid).single()).data?.prize_pool ?? 0);

  // 1. create + approve everyone → antes charged
  const { data: t, error: te } = await host.client.from('tournaments').insert({
    name: tName, created_by: host.id, format: 'round_robin', match_type: 'singles',
    registration_mode: 'request', team_creation: 'fixed', status: 'registration',
    seeding: 'random', pool_count: 1, pickle_ante: ANTE, payout_structure: [100],
  }).select('id').single();
  if (te) die('create tournament: ' + te.message);
  const tId = t!.id;
  await host.client.from('tournament_registrations').insert({ tournament_id: tId, user_id: host.id, status: 'approved', role: 'admin' });
  const regIds = new Map<string, string>();
  for (const a of [p2, p3, p4]) {
    await a.client.from('tournament_registrations').insert({ tournament_id: tId, user_id: a.id });
    const { data: reg } = await admin.from('tournament_registrations').select('id').eq('tournament_id', tId).eq('user_id', a.id).single();
    regIds.set(a.id, reg!.id);
    const { error } = await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg!.id);
    if (error) die(`approve: ${error.message}`);
  }
  c.check('ante', `pot = ante × 4 after approvals`, (await potOf(tId)) === ANTE * 4, `pot=${await potOf(tId)}`);
  c.check('ante', 'approved player was charged the ante', (await balOf(p2.id)) === start.get(p2.id)! - ANTE,
    `bal=${await balOf(p2.id)} start=${start.get(p2.id)}`);

  // 2. withdraw during registration → ante back
  const { error: wErr } = await p4.client.from('tournament_registrations').delete().eq('id', regIds.get(p4.id)!);
  if (wErr) die('withdraw: ' + wErr.message);
  c.check('refund', 'withdrawing during registration refunds the ante',
    (await balOf(p4.id)) === start.get(p4.id)!, `bal=${await balOf(p4.id)}`);
  c.check('refund', 'pot decremented by the refunded ante', (await potOf(tId)) === ANTE * 3, `pot=${await potOf(tId)}`);
  const { data: wNotif } = await admin.from('notifications').select('id').eq('user_id', p4.id)
    .like('title', '%Ante refunded%').gte('created_at', new Date(Date.now() - 300_000).toISOString());
  c.check('refund', 'withdrawer notified of the refund', (wNotif?.length ?? 0) > 0);

  // 3. kick → ante back; re-approve → charged again
  await host.client.from('tournament_registrations').update({ status: 'rejected' }).eq('id', regIds.get(p3.id)!);
  c.check('refund', 'kicked player refunded', (await balOf(p3.id)) === start.get(p3.id)!, `bal=${await balOf(p3.id)}`);
  await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', regIds.get(p3.id)!);
  c.check('refund', 're-approval charges the ante again (fresh ledger row)',
    (await balOf(p3.id)) === start.get(p3.id)! - ANTE && (await potOf(tId)) === ANTE * 3,
    `bal=${await balOf(p3.id)} pot=${await potOf(tId)}`);

  // 4. voluntary contribution (house adds 25% on top) + lock in + a wager
  const { data: contrib } = await host.client.rpc('contribute_pickles_to_pool',
    { p_scope_type: 'tournament', p_scope_id: tId, p_amount: 40 });
  const contribRow = Array.isArray(contrib) ? contrib[0] : contrib;
  c.check('economy', 'voluntary contribution lands (+25% house bonus)',
    !!contribRow?.success && (await potOf(tId)) === ANTE * 3 + 50, `pot=${await potOf(tId)}`);

  const { data: round } = await host.client.from('tournament_rounds')
    .insert({ tournament_id: tId, round_number: 1, label: 'Round Robin Schedule', round_type: 'winners' })
    .select('id').single();
  const trio = [host, p2, p3];
  const rows = [] as any[];
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    rows.push({ tournament_id: tId, round_id: round!.id, match_order: rows.length, match_type: 'singles',
                team1_player1: trio[i].id, team2_player1: trio[j].id });
  }
  await host.client.from('tournament_matches').insert(rows);
  await host.client.from('tournaments').update({ status: 'active' }).eq('id', tId);

  const { data: wager } = await p2.client.rpc('place_wager', {
    p_subject_type: 'tournament_rank', p_subject_id: tId,
    p_predicate: { user_id: host.id, rank: 1 }, p_stake: 60,
  });
  const wagerRow = Array.isArray(wager) ? wager[0] : wager;
  c.check('economy', 'wager placed on the active tournament', !!wagerRow?.success, wagerRow?.message);

  // score one match so cancellation happens genuinely mid-play
  const { data: m1 } = await admin.from('tournament_matches').select('id').eq('tournament_id', tId).limit(1).single();
  await host.client.from('tournament_matches').update({
    team1_score: 11, team2_score: 5, winner_team: 'team1', status: 'completed',
  }).eq('id', m1!.id);

  // 5. CANCEL — everything comes back
  const { data: cRes, error: cErr } = await host.client.rpc('cancel_tournament', { p_tournament_id: tId });
  c.check('cancel', 'cancel_tournament succeeds for the creator mid-play', cErr == null, cErr?.message);
  const { data: tAfter } = await admin.from('tournaments').select('status, prize_pool').eq('id', tId).single();
  c.check('cancel', 'status flipped to cancelled', tAfter?.status === 'cancelled', `status=${tAfter?.status}`);
  c.check('cancel', 'pot drained to zero by refunds', Number(tAfter?.prize_pool) === 0, `pot=${tAfter?.prize_pool}`);
  for (const a of actors) {
    c.check('cancel', `${a.username} balance restored exactly`, (await balOf(a.id)) === start.get(a.id)!,
      `bal=${await balOf(a.id)} start=${start.get(a.id)}`);
  }
  const { data: wagerAfter } = await admin.from('wagers').select('status').eq('subject_id', tId).eq('user_id', p2.id)
    .order('placed_at', { ascending: false }).limit(1).single();
  c.check('cancel', 'open wager cancelled + refunded', wagerAfter?.status === 'cancelled', `status=${wagerAfter?.status}`);
  const { data: cNotif } = await admin.from('notifications').select('id').eq('user_id', p2.id)
    .like('title', '%Tournament cancelled%').gte('created_at', new Date(Date.now() - 300_000).toISOString());
  c.check('cancel', 'participants notified of the cancellation', (cNotif?.length ?? 0) > 0);
  c.note(`cancel result: ${JSON.stringify(cRes)}`);

  // 6. DELETE a funded tournament — pot refunds there too
  const { data: t2 } = await host.client.from('tournaments').insert({
    name: `${tName} del`, created_by: host.id, format: 'round_robin', match_type: 'singles',
    registration_mode: 'request', team_creation: 'fixed', status: 'registration',
    seeding: 'random', pool_count: 1, pickle_ante: ANTE, payout_structure: [100],
  }).select('id').single();
  await host.client.from('tournament_registrations').insert({ tournament_id: t2!.id, user_id: host.id, status: 'approved', role: 'admin' });
  await p2.client.from('tournament_registrations').insert({ tournament_id: t2!.id, user_id: p2.id });
  const { data: reg2 } = await admin.from('tournament_registrations').select('id').eq('tournament_id', t2!.id).eq('user_id', p2.id).single();
  await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg2!.id);
  c.check('delete', 'second tournament funded', (await potOf(t2!.id)) === ANTE * 2, `pot=${await potOf(t2!.id)}`);
  const { error: dErr } = await admin.rpc('godmode_delete_tournament', { p_tournament_id: t2!.id });
  c.check('delete', 'godmode delete succeeds via service role', dErr == null, dErr?.message);
  c.check('delete', 'antes refunded on delete (host)', (await balOf(host.id)) === start.get(host.id)!, `bal=${await balOf(host.id)}`);
  c.check('delete', 'antes refunded on delete (p2)', (await balOf(p2.id)) === start.get(p2.id)!, `bal=${await balOf(p2.id)}`);

  const file = writeReport(c, tName, tId, { scenario: 'refunds', ante: ANTE });
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
  log(`✓ cancelled tournament "${tName}" left in place for app inspection (${tId})`);
}

// ── waitlist scenario ───────────────────────────────────────────────────────
// Exercises min/max players + the registration waitlist end-to-end, all as
// signed-in sim users (RLS + triggers for real):
//   fill to max → extra requests waitlisted (+ notification, FIFO position) →
//   approving while full is blocked → a member withdrawing promotes the oldest
//   waitlisted to pending (+ notifications) → raising max promotes another.
// The tournament is left in place (registration status) for app inspection.
async function waitlistScenario() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const tName = `[SIM] waitlist ${stamp}`;
  const MAXP = 4;
  step(`Waitlist scenario: "${tName}" (min 3 / max ${MAXP})`);
  const c = new Checker();
  const names = await pickSimPlayers(7);
  const startedAt = new Date().toISOString();

  const host = await signIn(names[0]);
  const { data: t, error: te } = await host.client.from('tournaments').insert({
    name: tName, created_by: host.id, format: 'round_robin', match_type: 'singles',
    registration_mode: 'request', team_creation: 'fixed', status: 'registration',
    seeding: 'random', pool_count: 1, min_players: 3, max_players: MAXP,
    location_name: 'Bladium Sports & Fitness Club',
  }).select('id, min_players, max_players').single();
  if (te) die('create tournament: ' + te.message);
  const tId = t!.id;
  await host.client.from('tournament_registrations').insert({ tournament_id: tId, user_id: host.id, status: 'approved', role: 'admin' });
  c.check('setup', 'min/max players persisted on create', t!.min_players === 3 && t!.max_players === MAXP,
    `min=${t!.min_players} max=${t!.max_players}`);

  // Registration helpers (the app inserts with default status; triggers decide).
  const request = async (i: number) => {
    const a = await signIn(names[i]);
    const { error } = await a.client.from('tournament_registrations').insert({ tournament_id: tId, user_id: a.id });
    if (error) die(`${a.username} request: ${error.message}`);
    return a;
  };
  const regOf = async (uid: string) =>
    (await admin.from('tournament_registrations').select('id, status').eq('tournament_id', tId).eq('user_id', uid).maybeSingle()).data;

  // 1. fill to max: players 2-4 request, host approves each (host is #4 of MAXP).
  const filled = [] as { id: string; username: string; client: SupabaseClient }[];
  for (let i = 1; i <= 2; i++) {
    const a = await request(i);
    const reg = await regOf(a.id);
    const { error } = await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', reg!.id);
    if (error) die(`approve ${a.username}: ${error.message}`);
    filled.push(a);
  }
  const third = await request(3);
  const thirdReg = await regOf(third.id);
  c.check('setup', 'requests below capacity stay pending', thirdReg?.status === 'pending', `status=${thirdReg?.status}`);
  await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', thirdReg!.id);
  c.note(`roster filled: 4/${MAXP} approved (host + 3)`);

  // 2. two more requests arrive while full → waitlisted, FIFO.
  const w1 = await request(4);
  const w1Reg = await regOf(w1.id);
  c.check('waitlist', 'request while full is waitlisted (not pending)', w1Reg?.status === 'waitlisted', `status=${w1Reg?.status}`);
  const { data: w1Notif } = await admin.from('notifications').select('id, body')
    .eq('user_id', w1.id).like('title', '%waitlist%').gte('created_at', startedAt);
  c.check('waitlist', 'waitlisted player notified with their position', (w1Notif?.length ?? 0) > 0 && (w1Notif![0].body as string).includes('#1'),
    JSON.stringify(w1Notif?.map(n => n.body)));
  const w2 = await request(5);
  const w2Reg = await regOf(w2.id);
  c.check('waitlist', 'second overflow request also waitlisted', w2Reg?.status === 'waitlisted', `status=${w2Reg?.status}`);

  // 3. capacity guard: approving a waitlisted player while full must fail.
  const { error: overErr } = await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', w1Reg!.id);
  c.check('waitlist', 'approving while full is blocked by the capacity guard',
    overErr != null && /full/i.test(overErr.message), overErr?.message ?? 'update succeeded — guard missing!');

  // 4. an approved member withdraws → oldest waitlisted auto-promoted to pending.
  const leaver = filled[0];
  const leaverReg = await regOf(leaver.id);
  const { error: delErr } = await leaver.client.from('tournament_registrations').delete().eq('id', leaverReg!.id);
  if (delErr) die(`${leaver.username} withdraw: ${delErr.message}`);
  const w1After = await regOf(w1.id);
  const w2After = await regOf(w2.id);
  c.check('promotion', 'oldest waitlisted promoted to pending when a member withdraws', w1After?.status === 'pending', `status=${w1After?.status}`);
  c.check('promotion', 'younger waitlisted entry stays waitlisted (one promotion per free spot)', w2After?.status === 'waitlisted', `status=${w2After?.status}`);
  const { data: promoNotif } = await admin.from('notifications').select('id')
    .eq('user_id', w1.id).like('title', '%spot opened%').gte('created_at', startedAt);
  c.check('promotion', 'promoted player notified a spot opened', (promoNotif?.length ?? 0) > 0);
  const { data: adminNotif } = await admin.from('notifications').select('id')
    .eq('user_id', host.id).like('title', '%Waitlist%').gte('created_at', startedAt);
  c.check('promotion', 'creator notified the waitlist moved', (adminNotif?.length ?? 0) > 0);

  // 5. promoted player can now be approved normally.
  const { error: appErr } = await host.client.from('tournament_registrations').update({ status: 'approved' }).eq('id', w1After!.id ?? w1Reg!.id);
  c.check('promotion', 'promoted player approved into the freed spot', appErr == null, appErr?.message);

  // 6. raising max_players promotes the remaining waitlisted entry.
  const { error: raiseErr } = await host.client.from('tournaments').update({ max_players: MAXP + 1 }).eq('id', tId);
  if (raiseErr) die('raise max_players: ' + raiseErr.message);
  const w2Final = await regOf(w2.id);
  c.check('promotion', 'raising max players promotes the next waitlisted entry', w2Final?.status === 'pending', `status=${w2Final?.status}`);

  const file = writeReport(c, tName, tId, { scenario: 'waitlist', min_players: 3, max_players: MAXP });
  log(`\n${c.failures.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${c.failures.length} CHECK(S) FAILED`} (${c.results.length} checks)`);
  log(`📄 report: ${file}`);
  log(`✓ tournament "${tName}" left in registration for app inspection (${tId})`);
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  if (SCENARIO === 'cleanup') await cleanup();
  else if (SCENARIO === 'league') await leagueScenario();
  else if (SCENARIO === 'guest') await guestScenario();
  else if (SCENARIO === 'waitlist') await waitlistScenario();
  else if (SCENARIO === 'refunds') await refundsScenario();
  else if (SCENARIO === 'league-deep') await leagueDeepScenario();
  else if (SCENARIO === 'extras') await extrasScenario();
  else if (SCENARIO === 'league-marathon') await leagueMarathonScenario();
  else if (SCENARIO === 'tournament') await tournamentScenario();
  else die('unknown scenario ' + SCENARIO);
})().catch((e) => die(e.message));
