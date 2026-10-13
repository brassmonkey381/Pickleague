// The standings TournamentDetail shows for EVERY format (UI compaction P5b),
// built only from lib/tournamentStandings.ts so the screen adds no ranking
// order of its own:
//   - fixed teams (round robin, elimination): computeTeamStandings, the
//     canonical chain (wins, 2-way head-to-head, point diff, seed);
//   - pool play: one such table per pool, scoped to that pool's matches;
//   - rotating partners: computePlayerStandings, the per-user mirror;
//   - MLP: the mlp_team_standings RPC rows in their existing display order;
//   - completed: the settled order from tournament_final_ranks, when it exists.
// Round robin / pool play with a playoff rank the GROUP STAGE only once the
// playoff exists: that's the order generate_playoff_bracket seeded from, and a
// semifinal win must not reshuffle it (the playoff result is the bracket's job,
// then the settled order's once the tournament completes).
// Pure TS (no React) so the You card and the Standings section read the same
// numbers.
import type { Tournament, TournamentRegistration } from '../../types';
import {
  computeTeamStandings, computePlayerStandings, settledStandings, sortMlpTeamStandings,
  type FinalRankRow,
} from '../../lib/tournamentStandings';
import { hasBothStages, roundStage, visibleScheduleMatches, type ScheduleMatch } from './tournamentModel';

export type StandingRow = {
  key: string;
  name: string;
  isMe: boolean;
  wins: number;
  losses: number;
  /** Points for / against (fixed-team tables only). */
  pf?: number;
  pa?: number;
};

export type StandingsTable = {
  key: string;
  /** Sub-heading above the table ("Pool A"), or null for a single table. */
  label: string | null;
  rows: StandingRow[];
};

export type StandingsData = {
  /** 'team' tables show W-L and point diff; 'player' and 'mlp' show W-L. */
  kind: 'team' | 'player' | 'mlp';
  /** The entrant column's heading. */
  entrantLabel: string;
  /** The W-L column's heading. */
  recordLabel: string;
  /** How the order was decided, one line. */
  note: string;
  tables: StandingsTable[];
  /** The order came from tournament_final_ranks. */
  settled: boolean;
  /** Group-stage matches only (a playoff exists); the screen titles it 'Group stage'. */
  groupStage?: boolean;
};

type MlpRow = {
  team_id: string; team_name: string; seed: number | null;
  pool_letter: string | null; sub_matches_won: number; sub_matches_lost: number;
};

export type StandingsInput = {
  tournament: Pick<Tournament, 'format' | 'match_type' | 'status'>;
  savedMatches: ScheduleMatch[];
  savedRounds: { id: string; round_type: string; round_number: number; label?: string | null }[];
  registrations: TournamentRegistration[];
  profileNames: Record<string, string>;
  profileRatings: Record<string, number>;
  myUserId: string | null;
  mlpStandings: MlpRow[] | null;
  /** The viewer's MLP team id (from mlp_teams), for the MLP "you" row. */
  myMlpTeamId: string | null;
  finalRanks: FinalRankRow[];
};

/** Null when there is nothing to rank yet (no saved matches, no MLP rows). */
export function buildStandings(i: StandingsInput): StandingsData | null {
  const { tournament: t, myUserId } = i;
  const isMlp = t.format === 'mlp' || t.format === 'mlp_random';

  if (isMlp) {
    if (!i.mlpStandings || i.mlpStandings.length === 0) return null;
    return {
      kind: 'mlp',
      entrantLabel: 'Team',
      recordLabel: 'Sub W-L',
      note: 'By sub-matches won (men\'s, women\'s and 2 mixed per team meeting).',
      settled: false,
      tables: [{
        key: 'mlp',
        label: null,
        rows: sortMlpTeamStandings(i.mlpStandings).map(r => ({
          key: r.team_id,
          name: r.pool_letter ? `${r.team_name} · Pool ${r.pool_letter}` : r.team_name,
          isMe: !!i.myMlpTeamId && r.team_id === i.myMlpTeamId,
          wins: r.sub_matches_won,
          losses: r.sub_matches_lost,
        })),
      }],
    };
  }

  const matches = visibleScheduleMatches(i.savedMatches);
  if (matches.length === 0) return null;
  const nameOf = (id: string) => i.profileNames[id] ?? '?';
  const completed = t.status === 'completed';

  if (t.format === 'rotating_partners') {
    const entrants = i.registrations.filter(r => r.status === 'approved').map(r => r.user_id);
    const live = computePlayerStandings(matches as any, {
      entrants,
      nameOf,
      isMe: id => id === myUserId,
      ratingOf: id => i.profileRatings[id],
    });
    const rows = settledStandings(live, { status: t.status, finalRanks: i.finalRanks });
    return {
      kind: 'player',
      entrantLabel: 'Player',
      recordLabel: 'W-L',
      note: completed && i.finalRanks.length > 0
        ? 'Final order, as settled when the tournament completed.'
        : 'Each player\'s own wins and losses (games, in best-of matches), then PLUPR.',
      settled: completed && i.finalRanks.length > 0,
      tables: [{ key: 'players', label: null, rows }],
    };
  }

  // Fixed teams: a singles player, or a doubles pair.
  const seedByUser = new Map(i.registrations.map(r => [r.user_id, r.seed]));
  const seedOf = (p1: string, p2: string | null) => {
    const a = seedByUser.get(p1) ?? null;
    const b = p2 ? (seedByUser.get(p2) ?? null) : null;
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  };
  const opts = {
    nameOf: (p1: string, p2: string | null) => (p2 ? `${nameOf(p1)} & ${nameOf(p2)}` : nameOf(p1)),
    // A null partner never matches a null viewer (the live table's guard).
    isMe: (p1: string, p2: string | null) => !!myUserId && (p1 === myUserId || p2 === myUserId),
    seedOf,
  };
  const entrantLabel = t.match_type === 'doubles' ? 'Team' : 'Player';
  const teamNote = 'By wins, then head-to-head (2-way ties), then point differential.';

  const settledNow = completed && i.finalRanks.length > 0;
  // Two-stage draw (round robin / pool play + playoff, once the playoff
  // rounds exist): rank the group stage only. Elimination formats are one
  // bracket (roundStage says 'playoff' for every round), so they never filter.
  const groupOnly = !settledNow
    && (t.format === 'round_robin' || t.format === 'pool_play')
    && hasBothStages(i.savedRounds, t.format);
  const poolRounds = i.savedRounds
    .filter(r => r.round_type === 'pool')
    .sort((a, b) => a.round_number - b.round_number);

  if (t.format === 'pool_play' && poolRounds.length > 0 && !settledNow) {
    return {
      kind: 'team',
      entrantLabel,
      recordLabel: 'W-L',
      note: `Pool tables. ${teamNote}`,
      settled: false,
      groupStage: groupOnly,
      tables: poolRounds.map((r, pi) => ({
        key: r.id,
        label: r.label ?? `Pool ${String.fromCharCode(65 + pi)}`,
        rows: computeTeamStandings(matches.filter(m => m.round?.id === r.id) as any, opts),
      })),
    };
  }

  const ranked = groupOnly
    ? matches.filter(m => roundStage(m.round?.round_type, t.format) === 'group')
    : matches;
  if (ranked.length === 0) return null;
  const live = computeTeamStandings(ranked as any, opts);
  return {
    kind: 'team',
    entrantLabel,
    recordLabel: 'W-L',
    note: settledNow ? 'Final order, as settled when the tournament completed.'
      : groupOnly ? `Group stage. ${teamNote}` : teamNote,
    settled: settledNow,
    groupStage: groupOnly,
    tables: [{ key: 'overall', label: null, rows: settledStandings(live, { status: t.status, finalRanks: i.finalRanks }) }],
  };
}

/** The viewer's row and its 1-based position (and table label), or null. */
export function myStanding(data: StandingsData | null):
  { row: StandingRow; position: number; of: number; table: string | null } | null {
  if (!data) return null;
  for (const tbl of data.tables) {
    const idx = tbl.rows.findIndex(r => r.isMe);
    if (idx >= 0) return { row: tbl.rows[idx], position: idx + 1, of: tbl.rows.length, table: tbl.label };
  }
  return null;
}
