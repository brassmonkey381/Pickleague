// PKL-086: the MLP Dreambreaker as played: each team's 4 players play singles in an order of play, rotating every 4
// rally points, in one rally-scored game to 21, win by 2. The app records only the final score.
// Server twin: _mlp_valid_rally21 / _mlp_db_score_guard (migration_mlp_dreambreaker_rotation.sql).

export const DREAMBREAKER_RULE = 'Rally scoring to 21, win by 2. Rotate every 4 points.';

/** A final rally-game score: the winner has 21 and leads by 2 or more, or more than 21 and leads by exactly 2. */
export function validRally21(a: number, b: number): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  const hi = Math.max(a, b), d = Math.abs(a - b);
  return hi >= 21 && d >= 2 && (hi === 21 || d === 2);
}

/** Plain-words reason a Dreambreaker score can't be saved, or null when it is fine. */
export function dreambreakerProblem(a: number, b: number): string | null {
  if (validRally21(a, b)) return null;
  return 'A Dreambreaker is one rally game to 21, win by 2: for example 21-19, 21-15 or 24-22 (not 21-20 or 25-21).';
}

/** Rotating Dreambreaker (the new format): a row with an order of play for both teams. */
export function isRotatingDreambreaker(m: { is_dreambreaker?: boolean | null; db_order_team1?: string[] | null; db_order_team2?: string[] | null }): boolean {
  return !!m.is_dreambreaker && Array.isArray(m.db_order_team1) && Array.isArray(m.db_order_team2);
}

/** Move one player up (-1) or down (+1) in an order of play. Returns a new array. */
export function moveInOrder(order: string[], index: number, dir: -1 | 1): string[] {
  const j = index + dir;
  if (j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}
