/**
 * PKL-050: an independent oracle for doubles pool play (+ playoff), ported from the live SQL (PKL-052 rule):
 *   - _pl_tournament_group_order            -> groupOrder()      (one table across every pool: final ranks 5+)
 *   - generate_playoff_bracket, per pool    -> poolTables()      (W, fewer L, point diff, admin tie order, seed)
 *   - generate_playoff_bracket seeding      -> perPoolSeeds() + perPoolPairings()
 *   - compute_tournament_final_ranks (pool) -> finalRanks()
 *   - preview_tournament_payout (pool)      -> potShares()
 *   - the app's playoffTieBlock / levelGroups -> tieBlock()   (the Generate playoff button waits on this)
 * Pure: no network. Entrant key = "lo:hi" (the server's tournament_tie_orders.entrant_key).
 */

export type PM = {
  id: string; round_id: string; match_order: number; status: string; winner_team: string | null;
  team1_player1: string | null; team1_player2?: string | null; team2_player1: string | null; team2_player2?: string | null;
  team1_score: number | null; team2_score: number | null; created_at?: string | null; completed_at?: string | null;
};
export type PR = { id: string; label: string | null; round_type: string; round_number: number };
export type Row = { key: string; lo: string; hi: string; wins: number; losses: number; diff: number; seed: number; tie: number | null };

const MAX = 2147483647;
export const keyOf = (a: string, b?: string | null) => { const y = b ?? a; return a < y ? `${a}:${y}` : `${y}:${a}`; };
export const membersOf = (key: string) => { const [lo, hi] = key.split(':'); return lo === hi ? [lo] : [lo, hi]; };
const k1 = (m: PM) => keyOf(m.team1_player1!, m.team1_player2 ?? null);
const k2 = (m: PM) => keyOf(m.team2_player1!, m.team2_player2 ?? null);
const decided = (m: PM) => m.status === 'completed' && (m.winner_team === 'team1' || m.winner_team === 'team2');
const both = (m: PM) => !!m.team1_player1 && !!m.team2_player1;

function teamSeed(key: string, seedOf: Map<string, number>) {
  const s = membersOf(key).map((u) => seedOf.get(u)).filter((x): x is number => x != null);
  return s.length ? Math.min(...s) : 999;
}
function tally(keys: Iterable<string>, done: PM[], seedOf: Map<string, number>, tieRank: (k: string) => number | null): Row[] {
  const rows = new Map<string, Row>();
  for (const k of keys) { const [lo, hi] = k.split(':'); rows.set(k, { key: k, lo, hi, wins: 0, losses: 0, diff: 0, seed: teamSeed(k, seedOf), tie: tieRank(k) }); }
  for (const m of done) {
    const a = rows.get(k1(m)), b = rows.get(k2(m));
    const s1 = m.team1_score ?? 0, s2 = m.team2_score ?? 0;
    if (a) { a.diff += s1 - s2; if (m.winner_team === 'team1') a.wins++; else a.losses++; }
    if (b) { b.diff += s2 - s1; if (m.winner_team === 'team2') b.wins++; else b.losses++; }
  }
  return [...rows.values()];
}
/** wins desc, losses asc, diff desc, admin tie rank (unset last), seed, lo, hi: the server's one chain. */
export const byRule = (a: Row, b: Row) =>
  b.wins - a.wins || a.losses - b.losses || b.diff - a.diff || (a.tie ?? MAX) - (b.tie ?? MAX) || a.seed - b.seed
  || (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0) || (a.hi < b.hi ? -1 : a.hi > b.hi ? 1 : 0);

const isGroupRound = (r?: PR) => !r || r.round_type === 'winners' || r.round_type === 'pool';

/** _pl_tournament_group_order: every group-stage entrant (pools merged), ranked by the rule. */
export function groupOrder(ms: PM[], rounds: PR[], seedOf: Map<string, number>, tieRank: (k: string) => number | null): Row[] {
  const rOf = new Map(rounds.map((r) => [r.id, r]));
  const grp = ms.filter((m) => both(m) && isGroupRound(rOf.get(m.round_id)));
  const keys = new Set<string>(); for (const m of grp) { keys.add(k1(m)); keys.add(k2(m)); }
  return tally(keys, grp.filter(decided), seedOf, tieRank).sort(byRule);
}

export const poolLetter = (r?: PR) => (r?.label ? /^Pool ([A-Z])/.exec(r.label)?.[1] ?? null : null);

/** generate_playoff_bracket's per-pool standings (completed pool matches only). */
export function poolTables(ms: PM[], rounds: PR[], seedOf: Map<string, number>, tieRank: (k: string) => number | null) {
  const rOf = new Map(rounds.map((r) => [r.id, r]));
  const letters = [...new Set(rounds.map(poolLetter).filter((x): x is string => !!x))].sort();
  return letters.map((letter) => {
    const done = ms.filter((m) => poolLetter(rOf.get(m.round_id)) === letter && m.status === 'completed' && both(m));
    const keys = new Set<string>(); for (const m of done) { keys.add(k1(m)); keys.add(k2(m)); }
    return { letter, rows: tally(keys, done.filter(decided), seedOf, tieRank).sort(byRule) };
  });
}

/** The app's levelGroups + playoffTieBlock: a waiting level group starting inside the cut blocks the draw. */
export function tieGroups(rows: Row[]) {
  const by = new Map<string, { start: number; members: Row[] }>();
  rows.forEach((r, i) => { const k = `${r.wins}|${r.losses}|${r.diff}`; const g = by.get(k); if (g) g.members.push(r); else by.set(k, { start: i, members: [r] }); });
  return [...by.values()].filter((g) => g.members.length > 1).map((g) => {
    const ranks = g.members.map((m) => m.tie);
    return { position: g.start + 1, keys: g.members.map((m) => m.key), waiting: ranks.some((x) => x == null) || new Set(ranks).size !== ranks.length };
  }).sort((a, b) => a.position - b.position);
}
export function tieBlock(tables: { letter: string; rows: Row[] }[], perPool: number): { letter: string; position: number; keys: string[] } | null {
  for (const t of tables) {
    const g = tieGroups(t.rows).find((x) => x.waiting && x.position <= perPool);
    if (g) return { letter: t.letter, position: g.position, keys: g.keys };
  }
  return null;
}

/** Seeds for top_N_per_pool: pool rank first, then pool letter (A1, B1, ..., A2, B2, ...). */
export function perPoolSeeds(tables: { letter: string; rows: Row[] }[], n: number): string[] {
  const out: { key: string; rank: number; letter: string }[] = [];
  for (const t of tables) t.rows.slice(0, n).forEach((r, i) => out.push({ key: r.key, rank: i + 1, letter: t.letter }));
  return out.sort((a, b) => a.rank - b.rank || a.letter.charCodeAt(0) - b.letter.charCodeAt(0)).map((x) => x.key);
}

/** generate_playoff_bracket's pairing table (1-based seeds; 0 = bye), by match_order. */
export function perPoolPairings(pools: number, n: number): { pairs: [number, number][]; roundType: string } | null {
  const size = pools * n;
  let pairs: [number, number][] | null = null, padded = 0;
  if (size === 2) { pairs = [[1, 2]]; padded = 2; }
  else if (size === 4 && (pools === 2 || pools === 4)) { pairs = [[1, 4], [2, 3]]; padded = 4; }
  else if (size === 6 && pools === 3) { pairs = [[1, 0], [2, 0], [3, 5], [4, 6]]; padded = 8; }
  else if (size === 6 && pools === 6) { pairs = [[1, 0], [2, 0], [3, 6], [4, 5]]; padded = 8; }
  else if (size === 8 && pools === 4) { pairs = [[1, 8], [4, 6], [2, 7], [3, 5]]; padded = 8; }
  else if (size === 8 && pools === 2) { pairs = [[1, 8], [4, 5], [2, 7], [3, 6]]; padded = 8; }
  if (!pairs) return null;
  return { pairs, roundType: padded === 8 ? 'quarterfinals' : padded === 4 ? 'semifinals' : 'finals' };
}

/** compute_tournament_final_ranks, round robin / pool play branch. user id -> final rank. */
export function finalRanks(ms: PM[], rounds: PR[], seedOf: Map<string, number>, tieRank: (k: string) => number | null, approved: string[]) {
  const rOf = new Map(rounds.map((r) => [r.id, r]));
  const rr = groupOrder(ms, rounds, seedOf, tieRank);
  const rrRank = new Map(rr.map((r, i) => [r.key, i + 1]));
  const pm = ms.filter((m) => both(m) && !isGroupRound(rOf.get(m.round_id)) && !!rOf.get(m.round_id));
  const last = (types: string[]) => pm.filter((m) => types.includes(rOf.get(m.round_id)!.round_type) && decided(m))
    .sort((a, b) => rOf.get(b.round_id)!.round_number - rOf.get(a.round_id)!.round_number || b.match_order - a.match_order)[0];
  const tier = new Map<string, number>();
  const pin = (k: string, t: number) => tier.set(k, Math.min(tier.get(k) ?? 99, t));
  const fin = last(['finals', 'grand_final']), third = last(['third_place_match']);
  if (fin) { pin(fin.winner_team === 'team1' ? k1(fin) : k2(fin), 1); pin(fin.winner_team === 'team1' ? k2(fin) : k1(fin), 2); }
  if (third) { pin(third.winner_team === 'team1' ? k1(third) : k2(third), 3); pin(third.winner_team === 'team1' ? k2(third) : k1(third), 4); }
  const deepest = new Map<string, number>();
  for (const m of pm) for (const k of [k1(m), k2(m)]) deepest.set(k, Math.max(deepest.get(k) ?? -1, rOf.get(m.round_id)!.round_number));
  const teams = [...new Set([...rr.map((r) => r.key), ...deepest.keys()])];
  const cmpS = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  teams.sort((a, b) => (tier.get(a) ?? (deepest.has(a) ? 5 : 6)) - (tier.get(b) ?? (deepest.has(b) ? 5 : 6))
    || (deepest.get(b) ?? 0) - (deepest.get(a) ?? 0) || (rrRank.get(a) ?? MAX) - (rrRank.get(b) ?? MAX)
    || cmpS(a.split(':')[0], b.split(':')[0]) || cmpS(a.split(':')[1], b.split(':')[1]));
  const out = new Map<string, number>();
  teams.forEach((k, i) => { for (const u of membersOf(k)) out.set(u, i + 1); });
  const left = approved.filter((u) => !out.has(u)).sort((a, b) => (seedOf.get(a) ?? 999) - (seedOf.get(b) ?? 999) || cmpS(a, b));
  left.forEach((u, i) => out.set(u, teams.length + i + 1));
  return { ranks: out, teamOrder: teams };
}

/** preview_tournament_payout from stored final ranks: per user, floor(floor(pot x pct / 100) / people at that place). */
export function potShares(pot: number, structure: number[], ranks: Map<string, number>) {
  const out = new Map<string, number>();
  structure.forEach((pct, i) => {
    const at = [...ranks.entries()].filter(([, r]) => r === i + 1).map(([u]) => u);
    for (const u of at) out.set(u, Math.floor(Math.floor((pot * pct) / 100) / Math.max(at.length, 1)));
  });
  return out;
}

/** PKL-060 R7: compute_tournament_final_ranks, per-player branch (rotating partners, no playoff): over completed
 *  matches with a winner, wins desc, losses asc, point diff desc, the admin's tie order (key "u:u"), seed, user id.
 *  Ranks are dense 1..N over every approved player. Also returns the level groups (same W, L, diff). */
export function playerRanks(ms: PM[], players: string[], seedOf: Map<string, number>, tieRank: (k: string) => number | null) {
  const rows = new Map(players.map((u) => [u, { u, wins: 0, losses: 0, diff: 0 }]));
  for (const m of ms.filter(decided)) {
    const t1 = [m.team1_player1, m.team1_player2 ?? null].filter((x): x is string => !!x);
    const t2 = [m.team2_player1, m.team2_player2 ?? null].filter((x): x is string => !!x);
    const s1 = m.team1_score ?? 0, s2 = m.team2_score ?? 0;
    for (const u of t1) { const r = rows.get(u); if (!r) continue; r.diff += s1 - s2; if (m.winner_team === 'team1') r.wins++; else r.losses++; }
    for (const u of t2) { const r = rows.get(u); if (!r) continue; r.diff += s2 - s1; if (m.winner_team === 'team2') r.wins++; else r.losses++; }
  }
  const order = [...rows.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.diff - a.diff
    || (tieRank(keyOf(a.u)) ?? MAX) - (tieRank(keyOf(b.u)) ?? MAX) || (seedOf.get(a.u) ?? 999) - (seedOf.get(b.u) ?? 999)
    || (a.u < b.u ? -1 : a.u > b.u ? 1 : 0));
  const ranks = new Map(order.map((r, i) => [r.u, i + 1]));
  const lv = new Map<string, string[]>();
  for (const r of order) { const k = `${r.wins}|${r.losses}|${r.diff}`; lv.set(k, [...(lv.get(k) ?? []), r.u]); }
  return { ranks, order, levels: [...lv.values()].filter((g) => g.length > 1) };
}
