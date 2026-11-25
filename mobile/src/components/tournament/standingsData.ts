// The standings TournamentDetail shows for EVERY format (UI compaction P5b),
// built only from lib/tournamentStandings.ts so the screen adds no ranking
// order of its own:
//   - fixed teams (round robin, elimination; singles or fixed doubles pairs):
//     computeTeamStandings;
//   - pool play: one such table per pool, scoped to that pool's matches;
//   - rotating partners: computePlayerStandings, the per-user mirror;
//   - MLP: the mlp_team_standings RPC rows, with points from the matches.
// Every table ranks by one chain (PKL-052): wins, fewer losses, point diff,
// then the admin's tie order (tournament_tie_orders), then seed. Groups still
// level after point diff without a full admin order are "waiting".
// Round robin / pool play with a playoff rank the GROUP STAGE only once the
// playoff exists, before and after completion: that's the order
// generate_playoff_bracket seeded from, and a playoff win must not reshuffle it.
//
// PKL-037: the final placement is a SEPARATE table (`placement`): stored
// tournament_final_ranks once completed, otherwise the provisional client
// placement from lib/tournamentPlacement.ts (Final 1-2, 3rd place match 3-4,
// the rest by round robin order).
// PKL-040: each table carries a one-line tie note per tied row
// (lib/tournamentTieNotes.ts) and its level groups for the admin's tie order.
// Pure TS (no React) so the You card and the Standings section read the same
// numbers.
import type { Tournament, TournamentRegistration } from '../../types';
import {
  computeTeamStandings, computePlayerStandings, orderByFinalRanks, sortMlpTeamStandings,
  type FinalRankRow, type TieRanks,
} from '../../lib/tournamentStandings';
import { compareStandings, diffOf, entrantKey, levelGroups, teamKey } from '../../lib/tournamentTiebreakers';
import { computeFinalPlacement, lastPlayoffResults, placeLabel, placementDetail, placementSourceLabel, poolFinishOrder, type PoolFinish } from '../../lib/tournamentPlacement';
import { explainTies, signed, tieLine } from '../../lib/tournamentTieNotes';
import { mlpPoolGroups, mlpTeamTieRank } from '../../lib/mlpStandings';
import { hasBothStages, roundStage, visibleScheduleMatches, type MlpTeamSlots, type ScheduleMatch } from './tournamentModel';

export type StandingRow = {
  key: string;
  name: string;
  isMe: boolean;
  wins: number;
  losses: number;
  /** Points for / against. */
  pf?: number;
  pa?: number;
  /** PKL-052: level on W-L and point diff, and the admin hasn't ordered it yet. */
  waiting?: boolean;
};

/** One group level on W-L and point diff, for the admin's tie order sheet. */
export type TieGroupView = {
  key: string;
  /** The table's label ("Pool A"), or null for a single table. */
  table: string | null;
  /** 1-based place of the group's first row in its table. */
  position: number;
  /** "4-2 and +9" */
  record: string;
  waiting: boolean;
  /** In current table order. `tieKeys` are the server entrant keys to send
   *  (one per entrant; an MLP team sends its four players). */
  entrants: { key: string; name: string; tieKeys: string[] }[];
};

export type StandingsTable = {
  key: string;
  /** Sub-heading above the table ("Pool A"), or null for a single table. */
  label: string | null;
  rows: StandingRow[];
  /** PKL-040: for each tied row, one line on what decided its place. */
  ties?: Record<string, string>;
  /** PKL-052: the groups level on W-L and point diff. */
  groups?: TieGroupView[];
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
  /** PKL-085 #8: placed by the playoff, or ranked by group-stage finish (shown under its own heading). */
  section: 'playoff' | 'rest';
  /** "Won the Final 11-7", "Out in the Semifinals, 1-3", "Pool B 3rd, 0-2, -15". */
  detail: string;
};

export type PlacementData = {
  /** One line on how the places are decided. */
  note: string;
  /** The places came from tournament_final_ranks (completed). */
  settled: boolean;
  rows: PlacementRowView[];
};

export type StandingsData = {
  /** Every kind shows W-L and point diff (PKL-052). */
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
  /** PKL-085 #8: the playoff has started, so the group-stage tables are final and locked. */
  stageLocked?: boolean;
  /** PKL-037: the final placement, a separate table. Null when there is none yet. */
  placement?: PlacementData | null;
  /** PKL-052: level groups still waiting for the admin, across all tables. */
  waitingCount: number;
};

type MlpRow = {
  team_id: string; team_name: string; seed: number | null;
  pool_letter: string | null; sub_matches_won: number; sub_matches_lost: number;
  matchups_won?: number; matchups_lost?: number; point_diff?: number;
};

export type StandingsInput = {
  tournament: Pick<Tournament, 'format' | 'match_type' | 'status'>;
  savedMatches: ScheduleMatch[];
  savedRounds: { id: string; round_type: string; round_number: number; label?: string | null }[];
  registrations: TournamentRegistration[];
  profileNames: Record<string, string>;
  myUserId: string | null;
  mlpStandings: MlpRow[] | null;
  /** The viewer's MLP team id (from mlp_teams), for the MLP "you" row. */
  myMlpTeamId: string | null;
  /** MLP teams' player slots: points for the ± column and the tie keys. */
  mlpTeams?: MlpTeamSlots[];
  finalRanks: FinalRankRow[];
  /** Admin tie orders (tournament_tie_orders), keyed by entrant key. */
  tieRanks?: TieRanks;
};

/** The one line under every table on how places are decided. */
export const RANK_RULE = 'Wins, then fewer losses, then point differential. A tie after that is ordered by the tournament admin.';

type Rankish = StandingRow & { tieRank?: number | null; tieKeys: string[] };

/**
 * Tie notes, level groups and waiting flags for one ordered table. `scope`
 * keeps apart rows ranked separately (MLP pools in one table).
 */
function withTieInfo(
  key: string, label: string | null, rows: Rankish[], scope?: (r: Rankish) => string,
): StandingsTable {
  // PKL-089: a tie only matters once there are results. Rows that haven't played get no tie note and no level
  // group, so a pool still at 0-0 doesn't ask the admin to order it before any game.
  const played = (r: Rankish) => r.wins + r.losses > 0 || (r.pf ?? 0) + (r.pa ?? 0) > 0;
  const notes = explainTies(rows, scope);
  for (const r of rows) if (!played(r)) delete notes[r.key];
  const nameByKey = new Map(rows.map(r => [r.key, r.name]));
  const ties: Record<string, string> = {};
  for (const k of Object.keys(notes)) ties[k] = tieLine(notes[k], x => nameByKey.get(x) ?? '?');
  const groups: TieGroupView[] = levelGroups(rows, scope).filter(g => g.members.some(played)).map(g => {
    if (g.waiting) for (const m of g.members) m.waiting = true;
    const first = g.members[0];
    return {
      key: `${key}:${g.start}`,
      table: label,
      position: g.start + 1,
      record: `${first.wins}-${first.losses} and ${signed(diffOf(first))}`,
      waiting: g.waiting,
      entrants: g.members.map(m => ({ key: m.key, name: m.name, tieKeys: m.tieKeys })),
    };
  });
  return { key, label, rows, ties, groups };
}

const countWaiting = (tables: StandingsTable[]) =>
  tables.reduce((n, t) => n + (t.groups ?? []).filter(g => g.waiting).length, 0);

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
    // Points per team from its sub-matches (the RPC has W-L only), and the
    // team's four players as its tie keys. A team's admin tie order is its
    // best player's (the RPC sends the four together, in team order).
    const members = new Map((i.mlpTeams ?? []).map(t => [t.id,
      [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].filter(Boolean) as string[]]));
    const pts = new Map<string, { pf: number; pa: number }>();
    for (const [teamId, ids] of members) {
      const p = { pf: 0, pa: 0 };
      for (const m of visibleScheduleMatches(i.savedMatches)) {
        if (m.status !== 'completed' || !m.winner_team) continue;
        const on1 = [m.team1_player1, m.team1_player2].some(x => !!x && ids.includes(x));
        const on2 = [m.team2_player1, m.team2_player2].some(x => !!x && ids.includes(x));
        if (on1 === on2) continue;
        const s1 = m.team1_score ?? 0;
        const s2 = m.team2_score ?? 0;
        p.pf += on1 ? s1 : s2;
        p.pa += on1 ? s2 : s1;
      }
      pts.set(teamId, p);
    }
    // PKL-090: ordered and grouped by lib/mlpStandings (the same function the Playoff block uses).
    const withPts = i.mlpStandings.map(r => {
      const ids = members.get(r.team_id) ?? [];
      return {
        ...r, ...(pts.get(r.team_id) ?? { pf: 0, pa: 0 }),
        tieRank: mlpTeamTieRank(ids, i.tieRanks),
        tieKeys: ids.map(id => entrantKey(id)),
      };
    });
    const toRow = (r: typeof withPts[number]): Rankish => ({
      key: r.team_id,
      name: r.team_name,
      isMe: !!i.myMlpTeamId && r.team_id === i.myMlpTeamId,
      wins: r.matchups_won ?? r.sub_matches_won,
      losses: r.matchups_lost ?? r.sub_matches_lost,
      pf: r.pf, pa: r.pa,
      tieRank: r.tieRank,
      tieKeys: r.tieKeys,
    });
    // PKL-089: one table per pool (Pool A, Pool B, ...), each ranked on its own; one table when there are no pools.
    const groups = mlpPoolGroups(withPts);
    const tables = groups.some(g => g.pool !== '')
      ? groups.map(g => withTieInfo(`mlp:${g.pool}`, g.pool ? `Pool ${g.pool}` : null, g.rows.map(toRow)))
      : [withTieInfo('mlp', null, (groups[0]?.rows ?? []).map(toRow))];
    return {
      kind: 'mlp',
      entrantLabel: 'Team',
      recordLabel: 'W-L',
      note: "A matchup is 4 games (men's, women's, 2 mixed) and a Dreambreaker at 2-2; winning it is 1 win. Ties: point diff, then games won, then the admin's order.",
      settled: false,
      tables,
      waitingCount: countWaiting(tables),
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
    const approved = i.registrations.filter(r => r.status === 'approved');
    const seedById = new Map(approved.map(r => [r.user_id, r.seed]));
    const live = computePlayerStandings(matches as any, {
      entrants: approved.map(r => r.user_id),
      nameOf,
      isMe: id => id === myUserId,
      seedOf: id => seedById.get(id),
      tieRanks: i.tieRanks,
    });
    const table = withTieInfo('players', null, live.map(r => ({ ...r, tieKeys: [r.tieKey] })));
    let placement: PlacementData | null = null;
    if (settledNow) {
      const places = storedPlaces(live, i.finalRanks);
      placement = {
        note: SETTLED_NOTE,
        settled: true,
        rows: orderByFinalRanks(live, i.finalRanks).map(r => ({
          key: r.key, name: r.name, isMe: r.isMe,
          place: places.has(r.key) ? String(places.get(r.key)) : '-',
          from: 'Standings', decided: true, wins: r.wins, losses: r.losses, section: 'rest' as const, detail: '',
        })),
      };
    } else if (allPlayed && live.some(r => r.wins + r.losses > 0)) {
      placement = {
        note: 'Every match is in. Places follow the standings.',
        settled: false,
        rows: live.map((r, idx) => ({
          key: r.key, name: r.name, isMe: r.isMe, place: String(idx + 1),
          from: 'Standings', decided: true, wins: r.wins, losses: r.losses, section: 'rest' as const, detail: '',
        })),
      };
    }
    return {
      kind: 'player',
      entrantLabel: 'Player',
      recordLabel: 'W-L',
      note: `Each player's own record (games, in best-of matches). ${RANK_RULE}`,
      settled: settledNow,
      tables: [table],
      placement,
      waitingCount: countWaiting([table]),
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
    tieRanks: i.tieRanks,
  };
  const entrantLabel = t.match_type === 'doubles' ? 'Team' : 'Player';
  const teamNote = RANK_RULE;

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
    return withTieInfo(key, label, rows.map(r => ({ ...r, tieKeys: [r.tieKey] })));
  };

  const poolRounds = i.savedRounds
    .filter(r => r.round_type === 'pool')
    .sort((a, b) => a.round_number - b.round_number);
  const tables: StandingsTable[] = t.format === 'pool_play' && poolRounds.length > 0
    ? poolRounds.map((r, pi) => withTies(r.id, r.label ?? `Pool ${String.fromCharCode(65 + pi)}`,
        matches.filter(m => m.round?.id === r.id)))
    : groupMatches.length > 0 ? [withTies('overall', null, groupMatches)] : [];
  if (tables.length === 0) return null;

  // ── Final placement (PKL-037; PKL-085 #8: two stages, never mixed) ──
  // Playoff rows say how the playoff placed them; everyone else ranks by pool finish (pool place, then record).
  const groupOrder = computeTeamStandings(groupMatches as any, opts);
  const overall = computeTeamStandings(matches as any, opts);
  const byKey = new Map(overall.map(r => [r.key, r]));
  const groupRow = new Map(groupOrder.map(r => [r.key, r]));
  const record = (key: string) => {
    const r = byKey.get(key);
    return { wins: r?.wins ?? 0, losses: r?.losses ?? 0 };
  };
  const finish = new Map<string, PoolFinish>();
  for (const tb of tables) tb.rows.forEach((r, idx) => finish.set(r.key, {
    pool: tb.label ? tb.label.replace(/^Pool /, '') : null, place: idx + 1, wins: r.wins, losses: r.losses, diff: diffOf(r),
  }));
  const finishOrder = poolFinishOrder(finish, (x, y) => {
    const rx = groupRow.get(x), ry = groupRow.get(y);
    return rx && ry ? compareStandings(rx, ry) : 0;
  });
  const placementMatches = (twoStage ? playoffMatches : matches).map(m => ({
    ...m, round_type: m.round?.round_type, round_number: m.round?.round_number,
  }));
  const provisional = twoStage ? computeFinalPlacement(finishOrder, placementMatches) : null;
  const lastOf = lastPlayoffResults(placementMatches.filter(m => m.team1_player1 && m.team2_player1).map(m => ({
    side1: teamKey(m.team1_player1!, m.team1_player2), side2: teamKey(m.team2_player1!, m.team2_player2),
    roundType: m.round_type ?? '', roundNumber: m.round_number ?? 0, status: m.status, winner: m.winner_team,
    score: m.team1_score != null && m.team2_score != null ? [m.team1_score, m.team2_score] as [number, number] : null,
  })));
  const sectionOf = (key: string): 'playoff' | 'rest' => (lastOf.has(key) ? 'playoff' : 'rest');
  const detailOf = (key: string) => placementDetail(sectionOf(key), lastOf.get(key) ?? null, finish.get(key));
  const noun = t.match_type === 'doubles' ? 'Teams' : 'Players';
  const splitNote = `The playoff decides the top places. ${noun} who didn't reach it rank by their ${t.format === 'pool_play' ? 'pool' : 'round robin'} finish.`;

  let placement: PlacementData | null = null;
  if (settledNow) {
    const places = storedPlaces(overall, i.finalRanks);
    placement = {
      note: twoStage ? splitNote : SETTLED_NOTE,
      settled: true,
      rows: orderByFinalRanks(overall, i.finalRanks).map(r => ({
        key: r.key, name: r.name, isMe: r.isMe,
        place: places.has(r.key) ? String(places.get(r.key)) : '-',
        from: sectionOf(r.key) === 'playoff' ? 'Playoff' : t.format === 'pool_play' ? 'Pool play' : 'Round robin',
        decided: true,
        section: twoStage ? sectionOf(r.key) : 'playoff',
        detail: detailOf(r.key),
        ...record(r.key),
      })),
    };
  } else if (provisional) {
    placement = {
      note: splitNote,
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
          section: sectionOf(p.key),
          detail: detailOf(p.key),
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
    stageLocked: twoStage,
    tables,
    placement,
    waitingCount: countWaiting(tables),
  };
}

/**
 * PKL-052: why the playoff can't be drawn yet, or null. A group waiting for
 * the admin blocks it when any member sits inside the advancing places of a
 * table that feeds the playoff (it decides who advances, or their seed).
 * Pool play with an overall top N blocks on any waiting group in any pool.
 */
export function playoffTieBlock(
  data: StandingsData | null,
  playoffFormat: string | null | undefined,
): string | null {
  if (!data || data.kind === 'mlp') return null;
  const perPool = playoffFormat === 'top_1_per_pool' ? 1 : playoffFormat === 'top_2_per_pool' ? 2 : null;
  const topN = playoffFormat === 'top_2' ? 2 : playoffFormat === 'top_4' ? 4 : playoffFormat === 'top_8' ? 8 : null;
  const multi = data.tables.length > 1;
  for (const t of data.tables) {
    const cut = perPool ?? (multi ? Number.POSITIVE_INFINITY : topN ?? Number.POSITIVE_INFINITY);
    const g = (t.groups ?? []).find(x => x.waiting && x.position <= cut);
    if (g) {
      const where = t.label ? `${t.label} has` : 'The standings have';
      return `${where} a tie at ${ordinal(g.position)}: set the tie order first.`;
    }
  }
  return null;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
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
