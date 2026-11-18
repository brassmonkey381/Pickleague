// The standings TournamentDetail shows for EVERY format (UI compaction P5b),
// built only from lib/tournamentStandings.ts so the screen adds no ranking
// order of its own:
//   - fixed teams (round robin, elimination; singles or fixed doubles pairs):
//     computeTeamStandings, the canonical chain (wins, 2-way head-to-head,
//     point diff, seed);
//   - pool play: one such table per pool, scoped to that pool's matches;
//   - rotating partners: computePlayerStandings, the per-user mirror;
//   - MLP: the mlp_team_standings RPC rows in their existing display order.
// Round robin / pool play with a playoff rank the GROUP STAGE only once the
// playoff exists, before and after completion: that's the order
// generate_playoff_bracket seeded from, and a playoff win must not reshuffle it.
//
// PKL-037: the final placement is a SEPARATE table (`placement`): stored
// tournament_final_ranks once completed, otherwise the provisional client
// placement from lib/tournamentPlacement.ts (Final 1-2, 3rd place match 3-4,
// the rest by round robin order).
// PKL-040: each table carries a one-line tie note per tied row
// (lib/tournamentTieNotes.ts).
// Pure TS (no React) so the You card and the Standings section read the same
// numbers.
import type { Tournament, TournamentRegistration } from '../../types';
import {
  computeTeamStandings, computePlayerStandings, orderByFinalRanks, sortMlpTeamStandings,
  type FinalRankRow,
} from '../../lib/tournamentStandings';
import { computeFinalPlacement, placeLabel, placementSourceLabel } from '../../lib/tournamentPlacement';
import { explainPlayerTies, explainTeamTies, tieLine } from '../../lib/tournamentTieNotes';
import { hasBothStages, roundStage, visibleScheduleMatches, type ScheduleMatch } from './tournamentModel';

export type StandingRow = {
  key: string;
  name: string;
  isMe: boolean;
  wins: number;
  losses: number;
  /** Points for / against. */
  pf?: number;
  pa?: number;
};

export type StandingsTable = {
  key: string;
  /** Sub-heading above the table ("Pool A"), or null for a single table. */
  label: string | null;
  rows: StandingRow[];
  /** PKL-040: for each tied row, one line on what decided its place. */
  ties?: Record<string, string>;
};

/** One row of the final placement table (PKL-037). */
export type PlacementRowView = {
  key: string;
  name: string;
  isMe: boolean;
  /** "3", or "1-2" while the deciding match is still to be played. */
  place: string;
  /** What decided it: "Final", "3rd place match", "Round robin". */
  from: string;
  decided: boolean;
  /** Record over every match, playoff included. */
  wins: number;
  losses: number;
};

export type PlacementData = {
  /** One line on how the places are decided. */
  note: string;
  /** The places came from tournament_final_ranks (completed). */
  settled: boolean;
  rows: PlacementRowView[];
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
  /** The final placement came from tournament_final_ranks. */
  settled: boolean;
  /** Group-stage matches only (a playoff exists). */
  groupStage?: boolean;
  /** PKL-037: the final placement, a separate table. Null when there is none yet. */
  placement?: PlacementData | null;
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

const SETTLED_NOTE = 'Final places, as stored when the tournament closed.';

/** Stored places for these rows (best rank among a team's members). */
function storedPlaces(rows: { key: string }[], ranks: FinalRankRow[]): Map<string, number> {
  const rankOf = new Map(ranks.map(r => [r.user_id, r.final_rank]));
  const out = new Map<string, number>();
  for (const r of rows) {
    let best = Number.POSITIVE_INFINITY;
    for (const id of r.key.split('|')) {
      const v = rankOf.get(id);
      if (v != null && v < best) best = v;
    }
    if (best !== Number.POSITIVE_INFINITY) out.set(r.key, best);
  }
  return out;
}

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
          name: r.pool_letter ? `${r.team_name}, Pool ${r.pool_letter}` : r.team_name,
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
  const settledNow = completed && i.finalRanks.length > 0;
  const allPlayed = matches.every(m => m.status === 'completed' || m.match_type === 'bye');

  if (t.format === 'rotating_partners') {
    // Per player: partners change every match. This format has no playoff,
    // so the final placement follows this order (the server also pins the
    // champion badge holder first). It gets its own table once stored, or
    // once every match is in.
    const entrants = i.registrations.filter(r => r.status === 'approved').map(r => r.user_id);
    const ratingOf = (id: string) => i.profileRatings[id];
    const live = computePlayerStandings(matches as any, {
      entrants,
      nameOf,
      isMe: id => id === myUserId,
      ratingOf,
    });
    const notes = explainPlayerTies(live, matches as any, ratingOf);
    const ties: Record<string, string> = {};
    for (const k of Object.keys(notes)) ties[k] = tieLine(notes[k], nameOf, 'player');
    let placement: PlacementData | null = null;
    if (settledNow) {
      const places = storedPlaces(live, i.finalRanks);
      placement = {
        note: SETTLED_NOTE,
        settled: true,
        rows: orderByFinalRanks(live, i.finalRanks).map(r => ({
          key: r.key, name: r.name, isMe: r.isMe,
          place: places.has(r.key) ? String(places.get(r.key)) : '-',
          from: 'Standings', decided: true, wins: r.wins, losses: r.losses,
        })),
      };
    } else if (allPlayed && live.some(r => r.wins + r.losses > 0)) {
      placement = {
        note: 'Every match is in. Places follow the standings.',
        settled: false,
        rows: live.map((r, idx) => ({
          key: r.key, name: r.name, isMe: r.isMe, place: String(idx + 1),
          from: 'Standings', decided: true, wins: r.wins, losses: r.losses,
        })),
      };
    }
    return {
      kind: 'player',
      entrantLabel: 'Player',
      recordLabel: 'W-L',
      note: 'Each player\'s own wins (games, in best-of matches), then fewer losses, then PLUPR.',
      settled: settledNow,
      tables: [{ key: 'players', label: null, rows: live, ties }],
      placement,
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
  const teamNote = 'By wins, then head-to-head (2-way ties), then point diff, then seed.';

  // Two-stage draw (round robin / pool play + playoff, once the playoff
  // rounds exist): the standings rank the group stage only, always, even
  // after completion. Elimination formats are one bracket (roundStage says
  // 'playoff' for every round), so they never filter.
  const twoStage = (t.format === 'round_robin' || t.format === 'pool_play')
    && hasBothStages(i.savedRounds, t.format);
  const groupMatches = twoStage
    ? matches.filter(m => roundStage(m.round?.round_type, t.format) === 'group')
    : matches;
  const playoffMatches = twoStage
    ? matches.filter(m => roundStage(m.round?.round_type, t.format) === 'playoff')
    : [];

  const withTies = (key: string, label: string | null, ms: typeof matches): StandingsTable => {
    const rows = computeTeamStandings(ms as any, opts);
    const notes = explainTeamTies(rows, ms as any);
    const byKey = new Map(rows.map(r => [r.key, r.name]));
    const ties: Record<string, string> = {};
    for (const k of Object.keys(notes)) ties[k] = tieLine(notes[k], x => byKey.get(x) ?? '?', 'team');
    return { key, label, rows, ties };
  };

  const poolRounds = i.savedRounds
    .filter(r => r.round_type === 'pool')
    .sort((a, b) => a.round_number - b.round_number);
  const tables: StandingsTable[] = t.format === 'pool_play' && poolRounds.length > 0
    ? poolRounds.map((r, pi) => withTies(r.id, r.label ?? `Pool ${String.fromCharCode(65 + pi)}`,
        matches.filter(m => m.round?.id === r.id)))
    : groupMatches.length > 0 ? [withTies('overall', null, groupMatches)] : [];
  if (tables.length === 0) return null;

  // ── Final placement (PKL-037) ──
  const groupOrder = computeTeamStandings(groupMatches as any, opts);
  const overall = computeTeamStandings(matches as any, opts);
  const byKey = new Map(overall.map(r => [r.key, r]));
  const record = (key: string) => {
    const r = byKey.get(key);
    return { wins: r?.wins ?? 0, losses: r?.losses ?? 0 };
  };
  const provisional = twoStage
    ? computeFinalPlacement(groupOrder.map(r => r.key), playoffMatches.map(m => ({
        ...m, round_type: m.round?.round_type, round_number: m.round?.round_number,
      })))
    : null;
  const sourceOf = new Map((provisional ?? []).map(p => [p.key, p.source]));
  const defaultFrom = t.format === 'round_robin' ? 'Round robin'
    : t.format === 'pool_play' ? 'Pool play'
    : 'Bracket';

  let placement: PlacementData | null = null;
  if (settledNow) {
    const places = storedPlaces(overall, i.finalRanks);
    placement = {
      note: SETTLED_NOTE,
      settled: true,
      rows: orderByFinalRanks(overall, i.finalRanks).map(r => ({
        key: r.key, name: r.name, isMe: r.isMe,
        place: places.has(r.key) ? String(places.get(r.key)) : '-',
        from: sourceOf.has(r.key) ? placementSourceLabel(sourceOf.get(r.key)!) : defaultFrom,
        decided: true,
        ...record(r.key),
      })),
    };
  } else if (provisional) {
    const hasThird = playoffMatches.some(m => m.round?.round_type === 'third_place_match');
    const hasFinal = playoffMatches.some(m => m.round?.round_type === 'finals');
    placement = {
      note: hasFinal && hasThird
        ? '1-2 from the Final, 3-4 from the 3rd place match, the rest by round robin order.'
        : hasFinal
          ? '1-2 from the Final, the rest by round robin order.'
          : 'Playoff results first, the rest by round robin order.',
      settled: false,
      rows: provisional.map(p => {
        const r = byKey.get(p.key);
        return {
          key: p.key,
          name: r?.name ?? '?',
          isMe: r?.isMe ?? false,
          place: placeLabel(p),
          from: placementSourceLabel(p.source),
          decided: p.decided,
          ...record(p.key),
        };
      }),
    };
  }

  return {
    kind: 'team',
    entrantLabel,
    recordLabel: 'W-L',
    note: t.format === 'pool_play' && poolRounds.length > 0 ? `Pool tables. ${teamNote}`
      : twoStage ? `Round robin matches only. ${teamNote}` : teamNote,
    settled: settledNow,
    groupStage: twoStage,
    tables,
    placement,
  };
}

/** The viewer's final placement row, or null. */
export function myPlacement(data: StandingsData | null): PlacementRowView | null {
  return data?.placement?.rows.find(r => r.isMe) ?? null;
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
