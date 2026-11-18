/**
 * Why tied entrants sit where they do (PKL-040). Adds NO ranking rule: it
 * explains the order the standings already have, using the same chains:
 *   - fixed teams (singles, fixed doubles pairs): wins, then head-to-head
 *     only for an exact 2-way tie, then point diff, then seed
 *     (lib/tournamentTiebreakers.ts);
 *   - rotating partners (per player): wins, then fewer losses, then PLUPR
 *     (computePlayerStandings). Partners change every match, so there is no
 *     team head-to-head: the note shows the player's record against the other
 *     tied player when they were on opposite sides, and their point diff, as
 *     information only.
 * Pure: no React, no Supabase.
 */
import { headToHead, teamKey, type TiebreakerMatch } from './tournamentTiebreakers';

export type TieMatch = TiebreakerMatch & {
  team1_score?: number | null;
  team2_score?: number | null;
};

export type TieDecider = 'h2h' | 'diff' | 'seed' | 'losses' | 'rating' | 'none';

/** One opponent's meetings, from this entrant's side. */
export type HeadToHeadLine = { vs: string; won: number; lost: number; scores: string[] };

export type TieNote = {
  wins: number;
  /** The other entrants on the same wins, in table order. */
  tiedWith: string[];
  decidedBy: TieDecider;
  h2h: HeadToHeadLine[];
  /** Point diff (points for minus against). */
  diff: number;
  /** Per-player tables only: losses and rating, for the note. */
  losses?: number;
  rating?: number | null;
};

type Mode = 'team' | 'player';

function sideKeys(m: TieMatch, side: 1 | 2): string[] {
  const p1 = side === 1 ? m.team1_player1 : m.team2_player1;
  const p2 = side === 1 ? m.team1_player2 : m.team2_player2;
  return p1 ? [p1, p2].filter(Boolean) as string[] : [];
}

/** True when `key` plays on this side: the whole team (team mode) or one of its players. */
function onSide(m: TieMatch, side: 1 | 2, key: string, mode: Mode): boolean {
  const ids = sideKeys(m, side);
  if (ids.length === 0) return false;
  return mode === 'team' ? teamKey(ids[0], ids[1] ?? null) === key : ids.includes(key);
}

/** Completed meetings of `a` against `b` (opposite sides), from a's view. */
export function meetingsOf(matches: TieMatch[], a: string, b: string, mode: Mode): HeadToHeadLine {
  const line: HeadToHeadLine = { vs: b, won: 0, lost: 0, scores: [] };
  for (const m of matches) {
    if (m.status !== 'completed' || (m.winner_team !== 'team1' && m.winner_team !== 'team2')) continue;
    let aSide: 1 | 2 | null = null;
    if (onSide(m, 1, a, mode) && onSide(m, 2, b, mode)) aSide = 1;
    else if (onSide(m, 2, a, mode) && onSide(m, 1, b, mode)) aSide = 2;
    if (!aSide) continue;
    const won = (m.winner_team === 'team1') === (aSide === 1);
    if (won) line.won++; else line.lost++;
    const mine = aSide === 1 ? m.team1_score : m.team2_score;
    const theirs = aSide === 1 ? m.team2_score : m.team1_score;
    line.scores.push(`${won ? 'won' : 'lost'}${mine != null && theirs != null ? ` ${mine}-${theirs}` : ''}`);
  }
  return line;
}

const uniqueIn = <T>(v: T, all: T[]) => all.filter(x => x === v).length === 1;

/** Tie notes for a fixed-team table (already in canonical order). */
export function explainTeamTies(
  rows: { key: string; wins: number; pf: number; pa: number; seed?: number }[],
  matches: TieMatch[],
): Record<string, TieNote> {
  const out: Record<string, TieNote> = {};
  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!groups.has(r.wins)) groups.set(r.wins, []);
    groups.get(r.wins)!.push(r);
  }
  for (const [wins, g] of groups) {
    if (g.length < 2) continue;
    const diffs = g.map(r => r.pf - r.pa);
    for (const r of g) {
      const others = g.filter(o => o.key !== r.key);
      const diff = r.pf - r.pa;
      let decidedBy: TieDecider;
      if (g.length === 2) {
        const o = others[0];
        const oDiff = o.pf - o.pa;
        decidedBy = headToHead(matches, r.key, o.key) !== 0 ? 'h2h'
          : diff !== oDiff ? 'diff'
          : (r.seed ?? 999) !== (o.seed ?? 999) ? 'seed' : 'none';
      } else {
        const sameDiff = g.filter(o => o.pf - o.pa === diff);
        decidedBy = uniqueIn(diff, diffs) ? 'diff'
          : uniqueIn(r.seed ?? 999, sameDiff.map(o => o.seed ?? 999)) ? 'seed' : 'none';
      }
      out[r.key] = {
        wins, tiedWith: others.map(o => o.key), decidedBy, diff,
        h2h: others.map(o => meetingsOf(matches, r.key, o.key, 'team')),
      };
    }
  }
  return out;
}

/** Tie notes for a per-player table (rotating partners). */
export function explainPlayerTies(
  rows: { key: string; wins: number; losses: number; pf?: number; pa?: number }[],
  matches: TieMatch[],
  ratingOf?: (id: string) => number | null | undefined,
): Record<string, TieNote> {
  const out: Record<string, TieNote> = {};
  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!groups.has(r.wins)) groups.set(r.wins, []);
    groups.get(r.wins)!.push(r);
  }
  const rating = (id: string) => ratingOf?.(id) ?? 0;
  for (const [wins, g] of groups) {
    if (g.length < 2) continue;
    const losses = g.map(r => r.losses);
    for (const r of g) {
      const others = g.filter(o => o.key !== r.key);
      const sameLosses = g.filter(o => o.losses === r.losses);
      const decidedBy: TieDecider = uniqueIn(r.losses, losses) ? 'losses'
        : uniqueIn(rating(r.key), sameLosses.map(o => rating(o.key))) ? 'rating' : 'none';
      out[r.key] = {
        wins, tiedWith: others.map(o => o.key), decidedBy,
        diff: (r.pf ?? 0) - (r.pa ?? 0),
        losses: r.losses,
        rating: ratingOf?.(r.key) ?? null,
        h2h: others.map(o => meetingsOf(matches, r.key, o.key, 'player')),
      };
    }
  }
  return out;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

const DECIDER_TEXT: Record<TieDecider, string> = {
  h2h: 'Decided by head-to-head.',
  diff: 'Decided by point diff.',
  seed: 'Decided by seed.',
  losses: 'Decided by fewer losses.',
  rating: 'Decided by PLUPR.',
  none: 'Still level.',
};

/**
 * One short line for a tied row, e.g.
 *   "Tied on 4 wins with Bo. H2H: won 11-8. Diff +12. Decided by head-to-head."
 * Per-player notes say "Vs Bo" (records as opponents) instead of "H2H".
 */
export function tieLine(note: TieNote, nameOf: (key: string) => string, mode: Mode = 'team'): string {
  const w = `${note.wins} win${note.wins === 1 ? '' : 's'}`;
  const parts: string[] = [`Tied on ${w} with ${note.tiedWith.map(nameOf).join(', ')}.`];
  const multi = note.h2h.length > 1;
  const h2h = note.h2h.map(l => {
    const res = l.scores.length > 0 ? l.scores.join(', ') : 'not played';
    return multi || mode === 'player' ? `${res} vs ${nameOf(l.vs)}` : res;
  }).join('; ');
  if (mode === 'team') {
    parts.push(`H2H: ${h2h}${multi ? ' (not used in a 3+ way tie)' : ''}.`);
  } else {
    parts.push(`As opponents: ${h2h}.`);
  }
  parts.push(`Diff ${signed(note.diff)}.`);
  if (mode === 'player' && note.decidedBy === 'losses') parts.push(`${note.losses} lost.`);
  parts.push(DECIDER_TEXT[note.decidedBy]);
  return parts.join(' ');
}
