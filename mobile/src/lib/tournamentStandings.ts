/**
 * Tournament standings: the ONE place the client turns tournament matches
 * into an ordered table.
 *
 * This module adds no ranking rule of its own. It is a wrapper with two
 * sources of order, and nothing else:
 *   1. Live standings use the ranking chain from lib/tournamentTiebreakers.ts
 *      (wins, fewer losses, point differential, the admin's tie order, seed;
 *      PKL-052: no head-to-head and no rating anywhere), the TS mirror of
 *      compute_tournament_final_ranks.
 *   2. Completed tournaments can read the server's settled ranks from
 *      `tournament_final_ranks` (RLS: readable by everyone). Those settle
 *      wagers and pin the bracket champion / grand-final loser, so "your
 *      finish" and the podium must come from them, not from a re-derivation.
 *
 * lib/__tests__/tournamentStandings.test.ts pins this module's order to the
 * comparator and to an emulation of the SQL.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { compareStandings, entrantKey, teamKey, type TiebreakerMatch } from './tournamentTiebreakers';

/** A tournament_matches row as far as standings care. Extra columns are fine. */
export type StandingsMatch = TiebreakerMatch & {
  team1_score?: number | null;
  team2_score?: number | null;
};

/** One entrant (a player in singles, a fixed pair in doubles) in the table. */
export type TeamStanding = {
  key: string;
  name: string;
  isMe: boolean;
  wins: number;
  losses: number;
  pf: number;
  pa: number;
  /** Registration seed; only present when the caller supplies `seedOf`. */
  seed?: number;
  /** The server's entrant key (entrantKey), for tie orders. */
  tieKey: string;
  /** The admin's tie order for this entrant, when one is set. */
  tieRank?: number;
};

/** Admin tie orders (tournament_tie_orders), keyed by entrantKey(). */
export type TieRanks = Record<string, number>;

export type TeamStandingsOptions = {
  /** Display name for an entrant. p1 is always set; p2 is the doubles partner. */
  nameOf: (p1: string, p2: string | null) => string;
  /**
   * Whether this entrant is the viewer. A callback rather than a user id so
   * each call site keeps its exact pre-extraction semantics (the pool table
   * and the live table compared a null partner differently; see the screen).
   */
  isMe: (p1: string, p2: string | null) => boolean;
  /**
   * Registration seed for the final tiebreak (lower is better). Omit it and
   * fully tied entrants keep first-appearance order, which is what the
   * TournamentDetail tables have always shown.
   */
  seedOf?: (p1: string, p2: string | null) => number | null | undefined;
  /** Admin tie orders, keyed by entrantKey(). */
  tieRanks?: TieRanks;
};

/**
 * Tally W-L and points for every entrant that appears in `matches`, then sort
 * with the ranking chain. Entrants are created in first-appearance
 * order and Array.prototype.sort is stable, so ties the chain can't separate
 * keep that order. Only completed matches with a winner count; scheduled ones
 * still list their entrants at 0-0. Pass a pool's matches for a pool table and
 * all matches for an overall one.
 */
export function computeTeamStandings(
  matches: StandingsMatch[],
  opts: TeamStandingsOptions,
): TeamStanding[] {
  const stats = new Map<string, TeamStanding>();
  const ensure = (p1: string | null, p2: string | null): TeamStanding | null => {
    if (!p1) return null;
    const key = teamKey(p1, p2);
    if (!stats.has(key)) {
      const entry: TeamStanding = {
        key, name: opts.nameOf(p1, p2),
        isMe: opts.isMe(p1, p2),
        wins: 0, losses: 0, pf: 0, pa: 0,
        tieKey: entrantKey(p1, p2),
      };
      const rank = opts.tieRanks?.[entry.tieKey];
      if (rank != null) entry.tieRank = rank;
      if (opts.seedOf) {
        const seed = opts.seedOf(p1, p2);
        if (seed != null) entry.seed = seed;
      }
      stats.set(key, entry);
    }
    return stats.get(key)!;
  };

  for (const m of matches) {
    const t1 = ensure(m.team1_player1, m.team1_player2);
    const t2 = ensure(m.team2_player1, m.team2_player2);
    if (!t1 || !t2) continue;
    if (m.status === 'completed' && m.winner_team) {
      t1.pf += m.team1_score ?? 0; t1.pa += m.team2_score ?? 0;
      t2.pf += m.team2_score ?? 0; t2.pa += m.team1_score ?? 0;
      if (m.winner_team === 'team1') { t1.wins++; t2.losses++; }
      else                            { t2.wins++; t1.losses++; }
    }
  }

  return Array.from(stats.values()).sort(compareStandings);
}

// ── Settled ranks (completed tournaments) ───────────────────────────────────

/** A tournament_final_ranks row. Both partners of a doubles team share a rank. */
export type FinalRankRow = {
  user_id: string;
  final_rank: number;
  wins: number;
  losses: number;
};

/**
 * Read a tournament's settled ranks, best first. Returns [] when none exist
 * yet (not completed, or compute_tournament_final_ranks hasn't run) and on a
 * read error, so callers fall back to live standings rather than show nothing.
 * The client is a parameter to keep this module pure for tests.
 */
export async function fetchFinalRanks(
  client: SupabaseClient,
  tournamentId: string,
): Promise<FinalRankRow[]> {
  const { data, error } = await client
    .from('tournament_final_ranks')
    .select('user_id, final_rank, wins, losses')
    .eq('tournament_id', tournamentId)
    .order('final_rank', { ascending: true });
  if (error || !data) return [];
  return data as FinalRankRow[];
}

/** The viewer's settled finishing position, or null when they have none. */
export function finalRankOf(ranks: FinalRankRow[], userId: string | null | undefined): number | null {
  if (!userId) return null;
  const row = ranks.find(r => r.user_id === userId);
  return row ? row.final_rank : null;
}

/**
 * Reorder a standings table by settled ranks. An entrant's rank is the best
 * rank among its members (partners share one on the team path anyway).
 * Entrants without a settled rank trail, in their existing order; equal ranks
 * keep their existing order too. Nothing is re-derived here.
 */
export function orderByFinalRanks<T extends { key: string }>(
  standings: T[],
  ranks: FinalRankRow[],
): T[] {
  if (ranks.length === 0) return standings;
  const rankOf = new Map(ranks.map(r => [r.user_id, r.final_rank]));
  const entrantRank = (key: string): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const id of key.split('|')) {
      const r = rankOf.get(id);
      if (r != null && r < best) best = r;
    }
    return best;
  };
  return standings
    .map((s, i) => ({ s, i, r: entrantRank(s.key) }))
    .sort((a, b) => {
      if (a.r !== b.r) {
        if (a.r === Number.POSITIVE_INFINITY) return 1;
        if (b.r === Number.POSITIVE_INFINITY) return -1;
        return a.r - b.r;
      }
      return a.i - b.i;
    })
    .map(x => x.s);
}

/**
 * The table to show: settled ranks once the tournament is completed and they
 * exist, otherwise the live canonical order unchanged.
 */
export function settledStandings<T extends { key: string }>(
  standings: T[],
  opts: { status: string | null | undefined; finalRanks?: FinalRankRow[] | null },
): T[] {
  if (opts.status !== 'completed' || !opts.finalRanks || opts.finalRanks.length === 0) {
    return standings;
  }
  return orderByFinalRanks(standings, opts.finalRanks);
}

// ── MLP team table ──────────────────────────────────────────────────────────

/** A mlp_team_standings RPC row, as far as ordering cares. Points and the
 *  admin tie order are added by the caller (the RPC has neither). */
export type MlpTeamStandingLike = {
  /** PKL-084: matchups (team vs team) won and lost; absent from an older server, then 0. */
  matchups_won?: number;
  matchups_lost?: number;
  sub_matches_won: number;
  sub_matches_lost: number;
  seed: number | null;
  pf?: number;
  pa?: number;
  tieRank?: number | null;
};

/**
 * Display order of the MLP team table (PKL-084, the server's mlp_team_standings order): matchups won desc, fewer
 * matchups lost, point diff, games (sub-matches) won desc, fewer lost, the admin's tie order, seed. Never head-to-head.
 * Returns a sorted copy.
 */
export function sortMlpTeamStandings<T extends MlpTeamStandingLike>(rows: T[]): T[] {
  const big = Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) =>
    ((b.matchups_won ?? 0) - (a.matchups_won ?? 0))
    || ((a.matchups_lost ?? 0) - (b.matchups_lost ?? 0))
    || (((b.pf ?? 0) - (b.pa ?? 0)) - ((a.pf ?? 0) - (a.pa ?? 0)))
    || (b.sub_matches_won - a.sub_matches_won)
    || (a.sub_matches_lost - b.sub_matches_lost)
    || ((a.tieRank ?? big) - (b.tieRank ?? big))
    || ((a.seed ?? big) - (b.seed ?? big)));
}

// ── Per-player table (rotating partners) ────────────────────────────────────

/** A tournament_matches row for the per-player tally. `game_scores` is the
 *  best-of-N breakdown ([{t1, t2}, ...]) when the match had more than one game. */
export type PlayerStandingsMatch = StandingsMatch & {
  game_scores?: { t1: number | string; t2: number | string }[] | null;
};

export type PlayerStanding = {
  /** The player's user id (a one-member "team" key, so the settled-rank and
   *  pin helpers below work on it unchanged). */
  key: string;
  name: string;
  isMe: boolean;
  wins: number;
  losses: number;
  /** Points scored / conceded by the player's side. */
  pf: number;
  pa: number;
  /** The server's entrant key (`${id}:${id}`), for tie orders. */
  tieKey: string;
  tieRank?: number;
  seed?: number;
};

/**
 * Per-player standings for formats whose lineups change every match
 * (rotating partners). The client mirror of the PER-USER path of
 * compute_tournament_final_ranks:
 *   - entrants are the approved players, in the order given;
 *   - only completed matches with a winner count;
 *   - a match with a non-empty game_scores array counts GAMES won and lost
 *     (best-of-N), otherwise the match itself is one win or one loss;
 *   - order: the shared chain (wins, fewer losses, point diff, the admin's
 *     tie order, seed), then entrant order. No head-to-head, no rating
 *     (PKL-052).
 */
export function computePlayerStandings(
  matches: PlayerStandingsMatch[],
  opts: {
    entrants: string[];
    nameOf: (userId: string) => string;
    isMe: (userId: string) => boolean;
    seedOf?: (userId: string) => number | null | undefined;
    tieRanks?: TieRanks;
  },
): PlayerStanding[] {
  const rows = opts.entrants.map((id, i) => {
    const row: PlayerStanding = {
      key: id, name: opts.nameOf(id), isMe: opts.isMe(id), wins: 0, losses: 0, pf: 0, pa: 0,
      tieKey: entrantKey(id),
    };
    const rank = opts.tieRanks?.[row.tieKey];
    if (rank != null) row.tieRank = rank;
    const seed = opts.seedOf?.(id);
    if (seed != null) row.seed = seed;
    return { i, row };
  });
  const byId = new Map(rows.map(r => [r.row.key, r.row]));
  for (const m of matches) {
    if ((m.status ?? 'completed') !== 'completed') continue;
    if (m.winner_team !== 'team1' && m.winner_team !== 'team2') continue;
    const team1 = [m.team1_player1, m.team1_player2].filter(Boolean) as string[];
    const team2 = [m.team2_player1, m.team2_player2].filter(Boolean) as string[];
    const games = Array.isArray(m.game_scores) && m.game_scores.length > 0 ? m.game_scores : null;
    // Games won by each side (best-of-N), or the match as one game.
    let g1 = 0;
    let g2 = 0;
    if (games) {
      for (const g of games) {
        const a = Number(g.t1);
        const b = Number(g.t2);
        if (a > b) g1++;
        else if (b > a) g2++;
      }
    } else if (m.winner_team === 'team1') g1 = 1;
    else g2 = 1;
    const s1 = m.team1_score ?? 0;
    const s2 = m.team2_score ?? 0;
    for (const id of team1) { const r = byId.get(id); if (r) { r.wins += g1; r.losses += g2; r.pf += s1; r.pa += s2; } }
    for (const id of team2) { const r = byId.get(id); if (r) { r.wins += g2; r.losses += g1; r.pf += s2; r.pa += s1; } }
  }
  return rows
    .sort((a, b) => compareStandings(a.row, b.row) || a.i - b.i)
    .map(r => r.row);
}

// ── Display helpers (no ordering of their own) ──────────────────────────────

/**
 * The visible slice of an ordered table with the viewer's row pinned: the top
 * `limit` rows, plus the viewer's row (with its real position) when it falls
 * below the cut. Pure presentation; the order is whatever the caller passed.
 */
export function pinMyRow<T extends { isMe: boolean }>(
  rows: T[],
  limit: number,
): { top: { row: T; position: number }[]; pinned: { row: T; position: number } | null; hidden: number } {
  const top = rows.slice(0, Math.max(0, limit)).map((row, i) => ({ row, position: i + 1 }));
  const meIndex = rows.findIndex(r => r.isMe);
  const pinned = meIndex >= limit ? { row: rows[meIndex], position: meIndex + 1 } : null;
  const hidden = Math.max(0, rows.length - top.length - (pinned ? 1 : 0));
  return { top, pinned, hidden };
}

/** One podium place from the settled ranks: doubles partners share a place. */
export type PodiumPlace = { rank: number; userIds: string[] };

/**
 * The top `places` distinct finishing ranks from tournament_final_ranks, in
 * rank order, with everyone who holds each rank (both partners of a doubles
 * team). Read straight from the stored ranks; nothing is re-derived.
 */
export function podiumFromFinalRanks(ranks: FinalRankRow[], places = 3): PodiumPlace[] {
  const out: PodiumPlace[] = [];
  const sorted = [...ranks].sort((a, b) => a.final_rank - b.final_rank);
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.rank === r.final_rank) { last.userIds.push(r.user_id); continue; }
    if (out.length >= places) break;
    out.push({ rank: r.final_rank, userIds: [r.user_id] });
  }
  return out;
}
