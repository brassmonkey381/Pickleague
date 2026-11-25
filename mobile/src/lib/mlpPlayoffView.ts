/**
 * PKL-085 option A (Brian 2026-11-25): what the MLP Playoff section shows once the playoff is drawn: the champion,
 * the podium (1st-3rd, then 4th), the Final, the 3rd-place match and the earlier rounds as team-v-team tiles with
 * per-game chips, then the teams that didn't reach the playoff by pool finish. Pure: tests cover it.
 *
 * A matchup is decided at 3 game wins (PKL-089). Places come from computeFinalPlacement (PKL-037/085 #8) over
 * the playoff matchups, with non-qualifiers in pool-finish order (pool place, then matchups W-L, ±, games).
 */
import { computeFinalPlacement, poolFinishOrder, type PlacementMatch, type PoolFinish } from './tournamentPlacement';

export type MlpViewMatch = {
  id: string; round_id: string; status: string; winner_team: 'team1' | 'team2' | null;
  team1_player1: string | null; team1_player2: string | null; team2_player1: string | null; team2_player2: string | null;
  team1_score?: number | null; team2_score?: number | null; is_dreambreaker?: boolean | null; match_order?: number | null;
};
export type MlpViewRound = { id: string; round_type: string; round_number: number };
export type MlpViewTeam = { id: string; name: string; male_1_id: string | null; male_2_id: string | null; female_1_id: string | null; female_2_id: string | null };
export type MlpViewRow = { team_id: string; pool_letter: string | null; seed: number | null; matchups_won?: number; matchups_lost?: number;
  sub_matches_won: number; sub_matches_lost: number; point_diff?: number };

export type GameChip = { label: string; s1: number | null; s2: number | null; winner: 1 | 2 | null };
export type MatchupTile = {
  key: string; roundType: string;
  a: { id: string; name: string }; b: { id: string; name: string };
  aWins: number; bWins: number; winner: 'a' | 'b' | null; games: GameChip[];
};
export type MlpPlayoffView = {
  champion: { id: string; name: string; line: string } | null;
  podium: { place: number; id: string; name: string }[];
  fourth: { id: string; name: string } | null;
  final: MatchupTile | null;
  third: MatchupTile | null;
  earlier: { roundType: string; tiles: MatchupTile[] }[];
  rest: { place: number; id: string; name: string; detail: string }[];
  /** Each team's badge color slot: its order in the tournament, so no two teams share a color (up to 8). */
  colorSlot: Record<string, number>;
};

const GROUP = new Set(['pool', 'winners']);
const ROUND_ORDER = ['quarterfinals', 'semifinals'];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

export function buildMlpPlayoffView(i: {
  rounds: MlpViewRound[]; matches: MlpViewMatch[]; teams: MlpViewTeam[]; rows: MlpViewRow[];
  /** PKL-088: gender-neutral games are Doubles 1-4 (D1-D4), not M/W/X1/X2. */
  genderNeutral?: boolean;
}): MlpPlayoffView | null {
  const roundOf = new Map(i.rounds.map(r => [r.id, r]));
  const members = (t: MlpViewTeam) => [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].filter(Boolean) as string[];
  const teamOf = (p: string | null) => (p ? i.teams.find(t => members(t).includes(p)) : undefined);
  const labels = i.genderNeutral ? ['D1', 'D2', 'D3', 'D4'] : ['M', 'W', 'X1', 'X2'];

  const byRound = new Map<string, MlpViewMatch[]>();
  for (const m of i.matches) {
    const r = roundOf.get(m.round_id);
    if (!r || GROUP.has(r.round_type)) continue;
    if (!byRound.has(m.round_id)) byRound.set(m.round_id, []);
    byRound.get(m.round_id)!.push(m);
  }
  if (byRound.size === 0) return null;

  const tiles: MatchupTile[] = [];
  for (const [rid, ms] of byRound) {
    const sorted = [...ms].sort((x, y) => (x.match_order ?? 0) - (y.match_order ?? 0));
    const first = sorted.find(m => !m.is_dreambreaker) ?? sorted[0];
    const A = teamOf(first.team1_player1), B = teamOf(first.team2_player1);
    if (!A || !B) continue;
    const games: GameChip[] = [];
    let k = 0;
    for (const m of sorted) {
      if (m.is_dreambreaker && m.status === 'cancelled') continue;
      const label = m.is_dreambreaker ? 'DB' : labels[k++] ?? `G${k}`;
      const done = m.status === 'completed' && !!m.winner_team;
      games.push({ label, s1: done ? m.team1_score ?? null : null, s2: done ? m.team2_score ?? null : null,
        winner: done ? (m.winner_team === 'team1' ? 1 : 2) : null });
    }
    const aWins = games.filter(g => g.winner === 1).length, bWins = games.filter(g => g.winner === 2).length;
    const open = sorted.some(m => m.status === 'pending');
    const winner = aWins >= 3 ? 'a' : bWins >= 3 ? 'b' : !open && aWins !== bWins ? (aWins > bWins ? 'a' : 'b') : null;
    tiles.push({ key: rid, roundType: roundOf.get(rid)!.round_type, a: { id: A.id, name: A.name }, b: { id: B.id, name: B.name },
      aWins, bWins, winner, games });
  }

  // places: pool finish for the order of everyone else
  const finish = new Map<string, PoolFinish>();
  const pools = [...new Set(i.rows.map(r => r.pool_letter ?? ''))];
  for (const p of pools) {
    const rows = i.rows.filter(r => (r.pool_letter ?? '') === p).sort((x, y) =>
      ((y.matchups_won ?? 0) - (x.matchups_won ?? 0)) || ((x.matchups_lost ?? 0) - (y.matchups_lost ?? 0))
      || ((y.point_diff ?? 0) - (x.point_diff ?? 0)) || (y.sub_matches_won - x.sub_matches_won) || ((x.seed ?? 999) - (y.seed ?? 999)));
    rows.forEach((r, idx) => finish.set(r.team_id, { pool: p || null, place: idx + 1,
      wins: r.matchups_won ?? 0, losses: r.matchups_lost ?? 0, diff: r.point_diff ?? 0 }));
  }
  const seedOf = new Map(i.rows.map(r => [r.team_id, r.seed ?? 999]));
  const order = poolFinishOrder(finish, (x, y) => (seedOf.get(x) ?? 999) - (seedOf.get(y) ?? 999));
  const pm: PlacementMatch[] = tiles.map(t => ({
    team1_player1: t.a.id, team1_player2: null, team2_player1: t.b.id, team2_player2: null,
    status: t.winner ? 'completed' : 'pending', winner_team: t.winner === 'a' ? 'team1' : t.winner === 'b' ? 'team2' : null,
    round_type: t.roundType, round_number: i.rounds.find(r => r.id === t.key)?.round_number ?? 0,
  }));
  const placed = computeFinalPlacement(order, pm);
  const nameOf = (id: string) => i.teams.find(t => t.id === id)?.name ?? '?';
  const inPlayoff = new Set(tiles.flatMap(t => [t.a.id, t.b.id]));

  const final = tiles.find(t => t.roundType === 'finals' || t.roundType === 'grand_final') ?? null;
  const third = tiles.find(t => t.roundType === 'third_place_match') ?? null;
  const decided = placed.filter(p => p.decided && inPlayoff.has(p.key));
  const champ = final?.winner ? (final.winner === 'a' ? final.a : final.b) : null;
  const runner = final?.winner ? (final.winner === 'a' ? final.b : final.a) : null;
  const score = final ? (final.winner === 'a' ? `${final.aWins}-${final.bWins}` : `${final.bWins}-${final.aWins}`) : '';
  return {
    champion: champ && runner ? { ...champ, line: `Won the Final ${score} over ${runner.name}` } : null,
    podium: decided.filter(p => p.place <= 3).map(p => ({ place: p.place, id: p.key, name: nameOf(p.key) })),
    fourth: (() => { const p = decided.find(x => x.place === 4); return p ? { id: p.key, name: nameOf(p.key) } : null; })(),
    final, third,
    earlier: ROUND_ORDER.slice().reverse().map(rt => ({ roundType: rt, tiles: tiles.filter(t => t.roundType === rt) })).filter(g => g.tiles.length),
    colorSlot: Object.fromEntries(i.teams.map((t, k) => [t.id, k])),
    rest: placed.filter(p => !inPlayoff.has(p.key)).map(p => {
      const f = finish.get(p.key);
      return { place: p.place, id: p.key, name: nameOf(p.key),
        detail: f ? `${f.pool ? `Pool ${f.pool}` : 'Round robin'} ${ordinal(f.place)}, ${f.wins}-${f.losses}, ${f.diff > 0 ? '+' : ''}${f.diff}` : '' };
    }),
  };
}

/** A team's badge: up to 3 initials and its color (by slot when known, else from its id). */
const BADGE = ['#2e8b57', '#b4472f', '#3a6ea5', '#6b4fa0', '#e0a92e', '#2f7f80', '#8a5a2b', '#c0507a'];
export function teamBadge(id: string, name: string, slot?: number): { initials: string; color: string; darkText: boolean } {
  let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = BADGE[(slot ?? h) % BADGE.length];
  const initials = name.split(/\s+/).filter(Boolean).map(w => w[0]!.toUpperCase()).join('').slice(0, 3) || '?';
  return { initials, color, darkText: color === '#e0a92e' };
}
