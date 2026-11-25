/**
 * PKL-090: the standings ORACLE, a reference model written straight from the written rules, deliberately WITHOUT
 * importing the app's standings code. Tests generate tournaments and check, after every match, that what the app
 * shows (components/tournament/standingsData.ts -> lib/tournamentStandings.ts, lib/mlpStandings.ts) equals this.
 *
 * The rules it encodes:
 *   - PKL-052: never head-to-head. Order is wins desc, fewer losses, point diff (points for - against), then the
 *     admin's tie order, then registration seed.
 *   - Only a completed match with a winner counts. A pending or cancelled match lists its entrants at 0-0.
 *   - Rotating partners: each PLAYER has a record; a best-of-N match counts its games (game_scores) as wins and
 *     losses, a single game counts as one; points are the side's match score.
 *   - Two-stage formats (round robin / pool play + a playoff): the table ranks the group stage only. Pool play has one
 *     table per pool. Elimination brackets are one table over every match.
 *   - MLP (PKL-084): a team's record is MATCHUPS (team v team). A matchup is 4 games plus a Dreambreaker at 2-2; it is
 *     1 win for the team that reaches 3 game wins (PKL-089: as soon as it does, even with a game still open), or,
 *     with no game open, for the team with more game wins. Order: matchups won desc, fewer matchups lost, point diff,
 *     games won desc, fewer games lost, admin tie order, seed. Pools rank on their own. Games and points count every
 *     completed game of the team, Dreambreaker included (PKL-086: the rotating Dreambreaker is excluded from PLUPR
 *     and player counts, not from team standings).
 *   - PKL-088: gender neutral changes who may fill a team's 4 slots and which PLUPR moves; standings never read gender.
 */

export type OracleRow = {
  key: string;
  wins: number;
  losses: number;
  pf: number;
  pa: number;
  seed: number;
  tieRank: number | null;
};

const BIG = Number.MAX_SAFE_INTEGER;

/** PKL-052 order. Every key in a generated tournament has its own seed, so the order is total. */
export function oracleCompare(a: OracleRow, b: OracleRow): number {
  if (a.wins !== b.wins) return b.wins - a.wins;
  if (a.losses !== b.losses) return a.losses - b.losses;
  const d = (b.pf - b.pa) - (a.pf - a.pa);
  if (d !== 0) return d;
  const t = (a.tieRank ?? BIG) - (b.tieRank ?? BIG);
  if (t !== 0) return t;
  return a.seed - b.seed;
}

export type OracleMatch = {
  id: string;
  /** Entrant keys (fixed teams) or player ids (rotating partners / MLP). */
  side1: string[];
  side2: string[];
  status: 'completed' | 'pending' | 'cancelled';
  winner: 1 | 2 | null;
  s1: number | null;
  s2: number | null;
  /** Best-of-N game scores, rotating partners only. */
  games?: [number, number][] | null;
};

/** Fixed entrants (a singles player or a doubles pair, by key): one table over the given matches. */
export function oracleFixedTable(
  matches: OracleMatch[], seedOf: (key: string) => number, tieRankOf: (key: string) => number | null = () => null,
): OracleRow[] {
  const rows = new Map<string, OracleRow>();
  const row = (k: string) => {
    if (!rows.has(k)) rows.set(k, { key: k, wins: 0, losses: 0, pf: 0, pa: 0, seed: seedOf(k), tieRank: tieRankOf(k) });
    return rows.get(k)!;
  };
  for (const m of matches) {
    const a = row(m.side1[0]), b = row(m.side2[0]);
    if (m.status !== 'completed' || !m.winner) continue;
    a.pf += m.s1 ?? 0; a.pa += m.s2 ?? 0; b.pf += m.s2 ?? 0; b.pa += m.s1 ?? 0;
    if (m.winner === 1) { a.wins++; b.losses++; } else { b.wins++; a.losses++; }
  }
  return [...rows.values()].sort(oracleCompare);
}

/** Rotating partners: one row per player, games counted in best-of-N matches. */
export function oraclePlayerTable(
  players: string[], matches: OracleMatch[], seedOf: (id: string) => number, tieRankOf: (id: string) => number | null = () => null,
): OracleRow[] {
  const rows = new Map(players.map(p => [p, { key: p, wins: 0, losses: 0, pf: 0, pa: 0, seed: seedOf(p), tieRank: tieRankOf(p) } as OracleRow]));
  for (const m of matches) {
    if (m.status !== 'completed' || !m.winner) continue;
    let g1 = 0, g2 = 0;
    if (m.games && m.games.length) for (const [x, y] of m.games) { if (x > y) g1++; else if (y > x) g2++; }
    else if (m.winner === 1) g1 = 1; else g2 = 1;
    for (const p of m.side1) { const r = rows.get(p); if (r) { r.wins += g1; r.losses += g2; r.pf += m.s1 ?? 0; r.pa += m.s2 ?? 0; } }
    for (const p of m.side2) { const r = rows.get(p); if (r) { r.wins += g2; r.losses += g1; r.pf += m.s2 ?? 0; r.pa += m.s1 ?? 0; } }
  }
  return [...rows.values()].sort(oracleCompare);
}

// ── MLP ──────────────────────────────────────────────────────────────────────

export type OracleMlpTeam = { id: string; pool: string; seed: number; tieRank: number | null };
/** One matchup: team A v team B, its games in order (4, then the Dreambreaker). winner 1 = team A. */
export type OracleMeeting = { a: string; b: string; games: { status: OracleMatch['status']; winner: 1 | 2 | null; s1: number | null; s2: number | null }[] };

export type OracleMlpRow = {
  team_id: string; pool: string; seed: number; tieRank: number | null;
  matchups_won: number; matchups_lost: number; games_won: number; games_lost: number; point_diff: number;
};

/** The matchup winner by the rule, or null while undecided. */
export function oracleMeetingWinner(m: OracleMeeting): 1 | 2 | null {
  const done = m.games.filter(g => g.status === 'completed' && g.winner);
  const a = done.filter(g => g.winner === 1).length, b = done.filter(g => g.winner === 2).length;
  if (a >= 3) return 1;
  if (b >= 3) return 2;
  const open = m.games.some(g => g.status === 'pending');
  if (!open && done.length > 0 && a !== b) return a > b ? 1 : 2;
  return null;
}

export function oracleMlpRows(teams: OracleMlpTeam[], meetings: OracleMeeting[]): OracleMlpRow[] {
  const rows = new Map(teams.map(t => [t.id, {
    team_id: t.id, pool: t.pool, seed: t.seed, tieRank: t.tieRank,
    matchups_won: 0, matchups_lost: 0, games_won: 0, games_lost: 0, point_diff: 0,
  } as OracleMlpRow]));
  for (const m of meetings) {
    const A = rows.get(m.a)!, B = rows.get(m.b)!;
    for (const g of m.games) {
      if (g.status !== 'completed' || !g.winner) continue;
      if (g.winner === 1) { A.games_won++; B.games_lost++; } else { B.games_won++; A.games_lost++; }
      A.point_diff += (g.s1 ?? 0) - (g.s2 ?? 0); B.point_diff += (g.s2 ?? 0) - (g.s1 ?? 0);
    }
    const w = oracleMeetingWinner(m);
    if (w === 1) { A.matchups_won++; B.matchups_lost++; } else if (w === 2) { B.matchups_won++; A.matchups_lost++; }
  }
  return [...rows.values()];
}

/** The MLP tables: per pool, in rule order. */
export function oracleMlpTables(rows: OracleMlpRow[]): { pool: string; rows: OracleMlpRow[] }[] {
  const cmp = (a: OracleMlpRow, b: OracleMlpRow) =>
    (b.matchups_won - a.matchups_won) || (a.matchups_lost - b.matchups_lost) || (b.point_diff - a.point_diff)
    || (b.games_won - a.games_won) || (a.games_lost - b.games_lost) || ((a.tieRank ?? BIG) - (b.tieRank ?? BIG)) || (a.seed - b.seed);
  return [...new Set(rows.map(r => r.pool))].sort().map(pool => ({ pool, rows: rows.filter(r => r.pool === pool).sort(cmp) }));
}
