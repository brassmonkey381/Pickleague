/**
 * The tournament ranking rule, for EVERY format (PKL-052, Brian 2026-11-19:
 * "NEVER use HEAD-to-HEAD at all anywhere in the app for scoring and
 * tiebreaking. Lets just go by W-L and Point Differential. Any ties after
 * that are handled manually by an admin."):
 *   1. wins desc
 *   2. losses asc
 *   3. point differential desc (points for minus against)
 *   4. admin tie order asc (tournament_tie_orders.tie_rank, set by an admin)
 *   5. seed asc (a fallback only, so the order is deterministic)
 * Rating never decides a place. A group still level after 1-3 whose members
 * do not all have distinct admin tie orders is "waiting for the admin".
 *
 * The server (compute_tournament_final_ranks, generate_playoff_bracket) uses
 * the same chain; entrantKey() is the key both sides store tie orders under.
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
 * The server's entrant key for tie orders: `${lo}:${hi}`, lo/hi being the
 * smaller/larger player id (string compare, which equals Postgres uuid order
 * for canonical lowercase uuids). A single player is `${id}:${id}`.
 */
export function entrantKey(p1: string, p2?: string | null): string {
  const b = p2 ?? p1;
  return p1 <= b ? `${p1}:${b}` : `${b}:${p1}`;
}

/** entrantKey() for a teamKey() ("a|b" or "a"). */
export function entrantKeyOfTeamKey(key: string): string {
  const [a, b] = key.split('|');
  return entrantKey(a, b ?? null);
}

/** What the ranking chain reads from an entrant. */
export type Rankable = {
  wins: number;
  losses: number;
  pf?: number;
  pa?: number;
  /** Admin tie order (lower first); absent when none is set. */
  tieRank?: number | null;
  /** Registration seed (lower first); the last, deterministic fallback. */
  seed?: number | null;
};

export const diffOf = (r: { pf?: number; pa?: number }) => (r.pf ?? 0) - (r.pa ?? 0);

/** The ranking chain as a comparator. Stable sorts keep full ties in input order. */
export function compareStandings(a: Rankable, b: Rankable): number {
  if (a.wins !== b.wins) return b.wins - a.wins;
  if (a.losses !== b.losses) return a.losses - b.losses;
  const da = diffOf(a);
  const db = diffOf(b);
  if (da !== db) return db - da;
  const ta = a.tieRank ?? Number.POSITIVE_INFINITY;
  const tb = b.tieRank ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (a.seed ?? 999) - (b.seed ?? 999);
}

/** The comparator, for callers that sort with `list.sort(buildStandingsComparator())`. */
export function buildStandingsComparator<T extends Rankable>(): (a: T, b: T) => number {
  return compareStandings;
}

/** A group of entrants level on wins, losses and point diff. */
export type LevelGroup<T> = {
  members: T[];
  /** Index of the group's first member in the ordered rows (0-based). */
  start: number;
  /** Not every member has its own admin tie order yet. */
  waiting: boolean;
};

/**
 * The groups (2+ entrants) an ordered table cannot separate on W-L and point
 * diff. `scope` keeps groups apart that are ranked separately (MLP pools in
 * one table). Members keep table order.
 */
export function levelGroups<T extends Rankable>(rows: T[], scope?: (r: T) => string): LevelGroup<T>[] {
  const byKey = new Map<string, LevelGroup<T>>();
  rows.forEach((r, i) => {
    const k = `${scope ? scope(r) : ''}|${r.wins}|${r.losses}|${diffOf(r)}`;
    const g = byKey.get(k);
    if (g) g.members.push(r);
    else byKey.set(k, { members: [r], start: i, waiting: false });
  });
  const out: LevelGroup<T>[] = [];
  for (const g of byKey.values()) {
    if (g.members.length < 2) continue;
    const ranks = g.members.map(m => m.tieRank);
    g.waiting = ranks.some(x => x == null) || new Set(ranks).size !== ranks.length;
    out.push(g);
  }
  return out.sort((a, b) => a.start - b.start);
}
