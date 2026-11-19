/**
 * Why tied entrants sit where they do (PKL-040, rule from PKL-052). Adds NO
 * ranking rule: it explains the order the standings already have, which for
 * every format is wins, fewer losses, point diff, then the admin's tie order
 * (lib/tournamentTiebreakers.ts). Head-to-head and rating play no part.
 * Pure: no React, no Supabase.
 */
import { diffOf } from './tournamentTiebreakers';

/** What placed a row among the entrants level with it on W-L. */
export type TieDecider = 'diff' | 'admin' | 'waiting';

export type TieNote = {
  wins: number;
  losses: number;
  /** The other entrants on the same W-L, in table order. */
  tiedWith: string[];
  /** Their point diffs, in the same order. */
  otherDiffs: number[];
  /** Those also level on point diff (the admin orders these). */
  levelWith: string[];
  decidedBy: TieDecider;
  /** This entrant's point diff (points for minus against). */
  diff: number;
};

type TieRow = { key: string; wins: number; losses: number; pf?: number; pa?: number; tieRank?: number | null };

/**
 * Tie notes for an ordered table, one per row that shares its W-L with
 * another row. `scope` keeps apart rows that are ranked separately (MLP pools
 * shown in one table).
 */
export function explainTies<T extends TieRow>(rows: T[], scope?: (r: T) => string): Record<string, TieNote> {
  const out: Record<string, TieNote> = {};
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = `${scope ? scope(r) : ''}|${r.wins}|${r.losses}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const r of g) {
      const others = g.filter(o => o.key !== r.key);
      const diff = diffOf(r);
      const level = others.filter(o => diffOf(o) === diff);
      let decidedBy: TieDecider = 'diff';
      if (level.length > 0) {
        const ranks = [r, ...level].map(o => o.tieRank);
        decidedBy = ranks.some(x => x == null) || new Set(ranks).size !== ranks.length ? 'waiting' : 'admin';
      }
      out[r.key] = {
        wins: r.wins, losses: r.losses,
        tiedWith: others.map(o => o.key),
        otherDiffs: others.map(diffOf),
        levelWith: level.map(o => o.key),
        decidedBy, diff,
      };
    }
  }
  return out;
}

export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * One short line for a tied row, e.g.
 *   "Tied on 4-2 with Bo; ahead on point diff (+12 vs +9)."
 *   "Tied on 4-2 and +9 with Bo; order set by the admin."
 *   "Tied on 4-2 and +9 with Bo: waiting for the admin to set the order."
 */
export function tieLine(note: TieNote, nameOf: (key: string) => string): string {
  const record = `${note.wins}-${note.losses}`;
  if (note.decidedBy === 'diff') {
    const names = note.tiedWith.map(nameOf).join(', ');
    const others = note.otherDiffs.map(signed).join(', ');
    const where = note.otherDiffs.every(d => d < note.diff) ? 'ahead on'
      : note.otherDiffs.every(d => d > note.diff) ? 'behind on' : 'placed by';
    return `Tied on ${record} with ${names}; ${where} point diff (${signed(note.diff)} vs ${others}).`;
  }
  const names = note.levelWith.map(nameOf).join(', ');
  const head = `Tied on ${record} and ${signed(note.diff)} with ${names}`;
  return note.decidedBy === 'admin'
    ? `${head}; order set by the admin.`
    : `${head}: waiting for the admin to set the order.`;
}
