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
  else if (SCENARIO === 'tournament') await tournamentScenario();
  else die('unknown scenario ' + SCENARIO);
})().catch((e) => die(e.message));
