/**
 * Final placement for a two-stage tournament (round robin / pool play, then a
 * playoff). PKL-037, Brian's rule of 2026-11-18:
 *   - the Final decides places 1 and 2;
 *   - the Third Place Match decides places 3 and 4;
 *   - everyone else is placed by the round-robin (group-stage) order.
 *   With only a Final: 1-2 from the Final, 3-N from the round robin.
 *
 * Bigger playoffs follow the same idea: entrants knocked out in a later
 * playoff round place ahead of those knocked out earlier, and entrants
 * knocked out in the same round keep their round-robin order.
 *
 * This is the PROVISIONAL client view. Once the tournament completes, the
 * stored tournament_final_ranks are what the screen shows (they settle
 * wagers); this module only orders and labels rows before that.
 *
 * Pure: no React, no Supabase. Entrant keys are teamKey() keys, so doubles
 * pairs work the same as singles players.
 */
import { teamKey, type TiebreakerMatch } from './tournamentTiebreakers';

export type PlacementMatch = TiebreakerMatch & {
  /** tournament_rounds.round_type of the match's round. */
  round_type: string | null | undefined;
  round_number?: number | null;
};

/** What decided a place. */
export type PlacementSource = 'final' | 'third_place' | 'playoff' | 'group';

export type PlacementRow = {
  key: string;
  /** Best place this entrant can still get (equals the place once decided). */
  place: number;
  /** Worst place it can still get; equals `place` once decided. */
  placeTo: number;
  source: PlacementSource;
  /** false while the deciding match is still to be played. */
  decided: boolean;
};

const FINAL_TYPES = new Set(['finals', 'grand_final']);
const THIRD_TYPE = 'third_place_match';

const sidesOf = (m: TiebreakerMatch): [string, string] | null => {
  if (!m.team1_player1 || !m.team2_player1) return null;
  return [teamKey(m.team1_player1, m.team1_player2), teamKey(m.team2_player1, m.team2_player2)];
};

const isDone = (m: TiebreakerMatch) =>
  m.status === 'completed' && (m.winner_team === 'team1' || m.winner_team === 'team2');

/**
 * Order every entrant into final places.
 *
 * @param groupOrder entrant keys in round-robin standings order (best first).
 *   Entrants missing here but present in the playoff are appended.
 * @param playoffMatches the playoff matches only (no group-stage rows).
 * @returns rows best first. Undecided tiers share a place range (e.g. the
 *   two finalists are both "1-2" until the Final is scored).
 */
export function computeFinalPlacement(
  groupOrder: string[],
  playoffMatches: PlacementMatch[],
): PlacementRow[] {
  const groupIndex = new Map<string, number>();
  groupOrder.forEach((k, i) => { if (!groupIndex.has(k)) groupIndex.set(k, i); });
  const byGroup = (a: string, b: string) =>
    (groupIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (groupIndex.get(b) ?? Number.MAX_SAFE_INTEGER);

  const out: PlacementRow[] = [];
  const placed = new Set<string>();
  const push = (keys: string[], source: PlacementSource, decided: boolean) => {
    const fresh = keys.filter(k => !placed.has(k));
    if (fresh.length === 0) return;
    const first = out.length + 1;
    const last = out.length + fresh.length;
    fresh.forEach((k, i) => {
      placed.add(k);
      out.push(decided
        ? { key: k, place: first + i, placeTo: first + i, source, decided: true }
        : { key: k, place: first, placeTo: last, source, decided: false });
    });
  };

  /** A medal match: winner then loser once played, else both share the range. */
  const medal = (m: PlacementMatch | undefined, source: PlacementSource) => {
    if (!m) return;
    const sides = sidesOf(m);
    if (!sides) return;
    if (isDone(m)) {
      const [w, l] = m.winner_team === 'team1' ? sides : [sides[1], sides[0]];
      push([w], source, true);
      push([l], source, true);
    } else {
      push([...sides].sort(byGroup), source, false);
    }
  };

  const final = playoffMatches.find(m => FINAL_TYPES.has(m.round_type ?? ''));
  const third = playoffMatches.find(m => m.round_type === THIRD_TYPE);
  medal(final, 'final');
  medal(third, 'third_place');

  // Earlier playoff rounds, latest first: who went out there.
  const rounds = new Map<number, PlacementMatch[]>();
  for (const m of playoffMatches) {
    if (m === final || m === third) continue;
    if (FINAL_TYPES.has(m.round_type ?? '') || m.round_type === THIRD_TYPE) continue;
    const n = m.round_number ?? 0;
    if (!rounds.has(n)) rounds.set(n, []);
    rounds.get(n)!.push(m);
  }
  for (const n of [...rounds.keys()].sort((a, b) => b - a)) {
    const ms = rounds.get(n)!;
    // Still-alive entrants of an unfinished round share an undecided range
    // (their next round doesn't exist yet); losers go out together.
    const pending: string[] = [];
    const winners: string[] = [];
    const losers: string[] = [];
    for (const m of ms) {
      const sides = sidesOf(m);
      if (!sides) {
        // A bye row: the lone entrant advances.
        if (m.team1_player1) winners.push(teamKey(m.team1_player1, m.team1_player2));
        continue;
      }
      if (isDone(m)) {
        const [w, l] = m.winner_team === 'team1' ? sides : [sides[1], sides[0]];
        winners.push(w);
        losers.push(l);
      } else {
        pending.push(...sides);
      }
    }
    push([...winners, ...pending].filter(k => !placed.has(k)).sort(byGroup), 'playoff', false);
    push(losers.sort(byGroup), 'playoff', true);
  }

  // Everyone else by the round robin.
  const rest = [...groupIndex.keys()].filter(k => !placed.has(k));
  rest.forEach(k => push([k], 'group', true));
  return out;
}

/** "1", or "1-2" while the deciding match is to be played. */
export function placeLabel(r: Pick<PlacementRow, 'place' | 'placeTo'>): string {
  return r.place === r.placeTo ? String(r.place) : `${r.place}-${r.placeTo}`;
}

/** Short "decided by" label for the placement table. */
export function placementSourceLabel(s: PlacementSource): string {
  switch (s) {
    case 'final': return 'Final';
    case 'third_place': return '3rd place match';
    case 'playoff': return 'Playoff';
    case 'group': return 'Round robin';
  }
}
