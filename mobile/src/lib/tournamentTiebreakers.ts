/**
 * Tiebreaker helpers for non-MLP RR / pool-play standings.
 *
 * The canonical tiebreak chain (see docs/tournament-formats/seeding-and-tiebreakers.md):
 *   1. Wins desc
 *   2. Head-to-head (ONLY when exactly 2 entrants are tied on wins)
 *   3. Point differential desc
 *   4. Registration seed asc
 *
 * This file is the TS-side mirror of the SQL logic in
 * supabase/migration_playoff_tiebreaker_and_3pm.sql so that the Live
 * Standings panel and the playoff seeding agree.
 */

export type TiebreakerMatch = {
  team1_player1: string | null;
  team1_player2: string | null;
  team2_player1: string | null;
  team2_player2: string | null;
  winner_team: 'team1' | 'team2' | null;
  status: string;
};

/** Build a stable team key. Doubles teams use the sorted pair; singles use the single id. */
export function teamKey(p1: string, p2: string | null): string {
  return p2 ? [p1, p2].sort().join('|') : p1;
}

/**
 * Head-to-head between EXACTLY two team keys.
 *
 * @returns
 *   -1 if `keyA` won the head-to-head (sort A before B),
 *    1 if `keyB` won (sort A after B),
 *    0 if H2H is indecisive (no completed matches between them, or a split series).
 *
 * IMPORTANT: callers must only invoke this when exactly 2 entrants share
 * the same wins count. With 3+ tied entrants H2H is ambiguous and the
 * canonical rule is to skip straight to point differential. (The CALLER
 * decides whether the 2-tied precondition holds; this function does not.)
 */
export function headToHead(
  matches: TiebreakerMatch[],
  keyA: string,
  keyB: string,
): -1 | 0 | 1 {
  let winsA = 0;
  let winsB = 0;
  for (const m of matches) {
    if (m.status !== 'completed' || !m.winner_team) continue;
    if (!m.team1_player1 || !m.team2_player1) continue;
    const t1 = teamKey(m.team1_player1, m.team1_player2);
    const t2 = teamKey(m.team2_player1, m.team2_player2);
    const aIsTeam1 = t1 === keyA && t2 === keyB;
    const aIsTeam2 = t2 === keyA && t1 === keyB;
    if (!aIsTeam1 && !aIsTeam2) continue;
    const team1Won = m.winner_team === 'team1';
    if (aIsTeam1) {
      if (team1Won) winsA++; else winsB++;
    } else {
      if (team1Won) winsB++; else winsA++;
    }
  }
  if (winsA > winsB) return -1;
  if (winsB > winsA) return 1;
  return 0;
}

/**
 * Build a comparator that applies the full tiebreak chain across an array
 * of entrants. Pre-computes the wins-bucket counts so H2H is only applied
 * to exact 2-way ties.
 *
 * Entries must expose: `key` (stable team key), `wins`, `pf`, `pa`.
 * Optional `seed` is used as the final fallback (lower seed = better).
 */
export function buildStandingsComparator<
  T extends { key: string; wins: number; pf: number; pa: number; seed?: number },
>(entries: T[], matches: TiebreakerMatch[]) {
  // How many entrants share each wins count?
  const winsBuckets = new Map<number, number>();
  for (const e of entries) {
    winsBuckets.set(e.wins, (winsBuckets.get(e.wins) ?? 0) + 1);
  }
  return (a: T, b: T): number => {
    if (a.wins !== b.wins) return b.wins - a.wins;
    // H2H only when exactly 2 entrants share this wins count.
    if (winsBuckets.get(a.wins) === 2) {
      const h2h = headToHead(matches, a.key, b.key);
      if (h2h !== 0) return h2h;
    }
    const diffA = a.pf - a.pa;
    const diffB = b.pf - b.pa;
    if (diffA !== diffB) return diffB - diffA;
    const sA = a.seed ?? 999;
    const sB = b.seed ?? 999;
    return sA - sB;
  };
}
