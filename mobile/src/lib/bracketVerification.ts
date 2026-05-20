/**
 * Tier 2 of the bracket-generation verification approach: read an existing
 * tournament's `tournament_rounds` and `tournament_matches` rows and assert
 * the structure matches the format formulas documented in
 * docs/tournament-formats/*.
 *
 * Read-only — never mutates DB state. Designed to be called from the godmode
 * console. Covers singles round_robin, single_elimination, and pool_play
 * today; other Larger Formats fall back to a generic "summary only" check.
 *
 * Pure helpers live in `./bracketVerificationHelpers` so unit tests can
 * exercise them without pulling in the supabase client.
 */

import { supabase } from './supabase';
import {
  expectedPoolPlayMatchCount,
  expectedRoundRobinMatchCount,
  expectedRoundRobinRoundCount,
  expectedSingleElimRound1MatchCount,
  nextPow2,
  poolSizes,
} from './bracketVerificationHelpers';

export type CheckResult = {
  ok: boolean | 'info';
  label: string;
  detail?: string;
};

type TournamentRow = {
  id: string;
  name: string;
  format: string;
  match_type: 'singles' | 'doubles';
  pool_count: number;
  status: string;
};

type RegRow = { id: string; user_id: string; status: string };
type RoundRow = { id: string; round_number: number; label: string; round_type: string };
type MatchRow = { id: string; round_id: string | null; match_order: number };

export async function verifyTournament(tournamentId: string): Promise<CheckResult[]> {
  const { data: t, error: tErr } = await supabase
    .from('tournaments')
    .select('id, name, format, match_type, pool_count, status')
    .eq('id', tournamentId)
    .single<TournamentRow>();

  if (tErr || !t) {
    return [{ ok: false, label: 'Load tournament', detail: tErr?.message ?? 'not found' }];
  }

  const [regsRes, roundsRes, matchesRes] = await Promise.all([
    supabase
      .from('tournament_registrations')
      .select('id, user_id, status')
      .eq('tournament_id', tournamentId)
      .eq('status', 'approved'),
    supabase
      .from('tournament_rounds')
      .select('id, round_number, label, round_type')
      .eq('tournament_id', tournamentId)
      .order('round_number', { ascending: true }),
    supabase
      .from('tournament_matches')
      .select('id, round_id, match_order')
      .eq('tournament_id', tournamentId),
  ]);

  const regs = (regsRes.data ?? []) as RegRow[];
  const rounds = (roundsRes.data ?? []) as RoundRow[];
  const matches = (matchesRes.data ?? []) as MatchRow[];

  const checks: CheckResult[] = [
    { ok: 'info', label: `${t.name}`, detail: `${t.format} · ${t.match_type} · status=${t.status}` },
    { ok: 'info', label: 'Approved registrations', detail: `${regs.length}` },
    { ok: 'info', label: 'Rounds', detail: `${rounds.length} (${roundTypeBreakdown(rounds)})` },
    { ok: 'info', label: 'Matches', detail: `${matches.length}` },
  ];

  // Format-specific assertions — only run on tournaments that have actually
  // been locked in (status active/completed), otherwise rounds/matches will
  // be empty and every check would falsely flag.
  if (t.status !== 'active' && t.status !== 'completed') {
    checks.push({
      ok: 'info',
      label: 'Skipping structural checks',
      detail: `tournament status is "${t.status}" (not yet locked in)`,
    });
    return checks;
  }

  if (t.match_type !== 'singles') {
    checks.push({
      ok: 'info',
      label: 'Doubles verification not yet implemented',
      detail: 'team count != registration count for doubles; needs doubles_pairs lookup',
    });
    return checks;
  }

  const N = regs.length;

  if (t.format === 'round_robin') {
    const expectedMatches = expectedRoundRobinMatchCount(N);
    const expectedRounds = expectedRoundRobinRoundCount(N);
    checks.push({
      ok: matches.length === expectedMatches,
      label: 'RR match count',
      detail: `expected ${expectedMatches} = N(N-1)/2 for N=${N}, got ${matches.length}`,
    });
    checks.push({
      ok: rounds.length === expectedRounds,
      label: 'RR round count',
      detail: `expected ${expectedRounds} for N=${N}, got ${rounds.length}`,
    });
  } else if (t.format === 'single_elimination') {
    const r1Expected = expectedSingleElimRound1MatchCount(N);
    const round1Matches = matches.filter(m => {
      const r = rounds.find(r => r.id === m.round_id);
      return r?.round_number === 1;
    });
    checks.push({
      ok: round1Matches.length === r1Expected,
      label: 'SE round-1 match count',
      detail: `expected ${r1Expected} (N=${N} padded to ${nextPow2(N)}, ${nextPow2(N) - N} byes), got ${round1Matches.length}`,
    });
  } else if (t.format === 'pool_play') {
    const expectedMatches = expectedPoolPlayMatchCount(N, t.pool_count);
    const sizes = poolSizes(N, t.pool_count);
    checks.push({
      ok: matches.length === expectedMatches,
      label: 'Pool play match count',
      detail: `expected ${expectedMatches} from snake-draft pool sizes [${sizes.join(', ')}], got ${matches.length}`,
    });
    const poolRounds = rounds.filter(r => r.round_type === 'pool');
    checks.push({
      ok: poolRounds.length > 0,
      label: 'Has pool rounds',
      detail: `${poolRounds.length} pool round(s) found`,
    });
  } else {
    checks.push({
      ok: 'info',
      label: `Structural verification for ${t.format} not yet implemented`,
      detail: 'falls back to summary only; see bracket-verification.md for roadmap',
    });
  }

  return checks;
}

function roundTypeBreakdown(rounds: RoundRow[]): string {
  const counts: Record<string, number> = {};
  for (const r of rounds) counts[r.round_type] = (counts[r.round_type] ?? 0) + 1;
  return Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') || 'none';
}
