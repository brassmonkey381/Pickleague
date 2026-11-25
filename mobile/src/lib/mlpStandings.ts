/**
 * PKL-090: the ONE place MLP team standings are ordered and grouped, for every screen that shows them: the Standings
 * card (components/tournament/standingsData.ts) and the Playoff block (components/MlpPlayoffPreview.tsx). Both read
 * the server's mlp_team_standings rows (PKL-089: one fetch, re-fetched on every score) and order them here, so the
 * two can't disagree. The rule (PKL-084): matchups won desc, fewer matchups lost, point diff, games won desc, fewer
 * games lost, the admin's tie order, seed. Never head-to-head (PKL-052). Pools rank on their own.
 */
import { entrantKey } from './tournamentTiebreakers';
import type { TieRanks } from './tournamentStandings';

/** A mlp_team_standings row, as far as ordering cares. */
export type MlpStandingRowLike = {
  team_id: string;
  pool_letter: string | null;
  seed: number | null;
  matchups_won?: number;
  matchups_lost?: number;
  sub_matches_won: number;
  sub_matches_lost: number;
  /** The server's point diff over the team's games. */
  point_diff?: number;
  /** Points for/against from the matches; used only when point_diff is absent. */
  pf?: number;
  pa?: number;
  /** The admin's tie order for the team (lower first). */
  tieRank?: number | null;
};

export const mlpDiff = (r: MlpStandingRowLike) => r.point_diff ?? ((r.pf ?? 0) - (r.pa ?? 0));

/** The PKL-084 comparator. */
export function compareMlpTeams(a: MlpStandingRowLike, b: MlpStandingRowLike): number {
  const big = Number.MAX_SAFE_INTEGER;
  return ((b.matchups_won ?? 0) - (a.matchups_won ?? 0))
    || ((a.matchups_lost ?? 0) - (b.matchups_lost ?? 0))
    || (mlpDiff(b) - mlpDiff(a))
    || (b.sub_matches_won - a.sub_matches_won)
    || (a.sub_matches_lost - b.sub_matches_lost)
    || ((a.tieRank ?? big) - (b.tieRank ?? big))
    || ((a.seed ?? big) - (b.seed ?? big));
}

/**
 * A team's admin tie order: its best-placed player's (the server's tie orders are per player for MLP; the four
 * players of a team share one place).
 */
export function mlpTeamTieRank(memberIds: (string | null | undefined)[], tieRanks: TieRanks | undefined): number | null {
  const own = memberIds.filter((x): x is string => !!x).map(id => tieRanks?.[entrantKey(id)]).filter((x): x is number => x != null);
  return own.length ? Math.min(...own) : null;
}

/** The standings by pool, each ordered by the rule. No pools: one group with pool ''. */
export function mlpPoolGroups<T extends MlpStandingRowLike>(rows: T[]): { pool: string; rows: T[] }[] {
  const pools = [...new Set(rows.map(r => r.pool_letter ?? ''))].sort();
  return pools.map(pool => ({ pool, rows: rows.filter(r => (r.pool_letter ?? '') === pool).sort(compareMlpTeams) }));
}
