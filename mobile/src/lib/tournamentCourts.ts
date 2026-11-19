// PKL-039 + PKL-049: tournament courts and bye rounds, the client's half.
//
// The server owns the queue (supabase/migration_tournament_courts_byes.sql,
// _pl_tm_call_next): it writes tournament_matches.court / called_at when a
// court frees up and a match whose players are all free is next. These pure
// helpers read those columns to tell a player where they stand, and work out
// schedule rounds and byes the same way the server does (_pl_tm_schedule):
// play_round when the row has it, else the draw's shape (floor(players / 4)
// matches a round for rotating partners and fixed doubles, floor(players / 2)
// for singles, in match_order).
//
// tournaments.courts null or [] = "no courts reserved": players find an open
// court, as before; nothing is called and anyone in the match can score it.
import type { ScheduleMatch } from '../components/tournament/tournamentModel';

export type CourtMatch = ScheduleMatch & {
  play_round?: number | null;
  court?: string | null;
  called_at?: string | null;
};

/** Formats with schedule rounds (and so byes). */
export const ROUND_FORMATS: ReadonlySet<string> = new Set(['rotating_partners', 'round_robin', 'pool_play']);

/** "4" -> "Court 4"; "Center" -> "Center" (the server's _pl_tm_court_label). */
export function courtLabel(court: string): string {
  const c = court.trim();
  return /^[0-9]+$/.test(c) ? `Court ${c}` : c;
}

/** The admin's typed list ("1, 2, Center") -> ['1', '2', 'Center']; blanks and repeats dropped. */
export function parseCourts(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const c = raw.trim().replace(/^court\s+(?=\d+$)/i, '');
    if (c && !out.some(o => o.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  return out;
}

export function courtsText(courts: string[] | null | undefined): string {
  return (courts ?? []).join(', ');
}

export function hasCourts(courts: string[] | null | undefined): boolean {
  return (courts ?? []).some(c => c.trim() !== '');
}

const isOpen = (m: ScheduleMatch) => m.status !== 'completed' && m.status !== 'cancelled';
const players = (m: ScheduleMatch) =>
  [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].filter(Boolean) as string[];
const isScheduleRound = (m: ScheduleMatch) => !m.round || m.round.round_type === 'winners' || m.round.round_type === 'pool';

/** Each schedule match's round (match id -> round number). Empty for other formats. */
export function playRounds(matches: CourtMatch[], format: string, matchType: string | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!ROUND_FORMATS.has(format)) return out;
  const groups = new Map<string, CourtMatch[]>();
  for (const m of matches) {
    if (!isScheduleRound(m) || !m.team1_player1 || !m.team2_player1) continue;
    const k = m.round?.id ?? '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(m);
  }
  const perTeam = format === 'rotating_partners' || matchType === 'doubles' ? 4 : 2;
  for (const g of groups.values()) {
    g.sort((a, b) => (a.match_order ?? 0) - (b.match_order ?? 0) || a.id.localeCompare(b.id));
    const n = new Set(g.flatMap(players)).size;
    const per = Math.max(1, Math.floor(n / perTeam));
    g.forEach((m, i) => out.set(m.id, m.play_round ?? Math.floor(i / per) + 1));
  }
  return out;
}

/** A player's bye rounds in their group: rounds with no match of theirs, ascending. */
export function byesFor(matches: CourtMatch[], rounds: Map<string, number>, userId: string | null): number[] {
  if (!userId) return [];
  const mine = matches.filter(m => rounds.has(m.id) && players(m).includes(userId));
  if (mine.length === 0) return [];
  const group = mine[0].round?.id ?? '';
  const inGroup = matches.filter(m => rounds.has(m.id) && (m.round?.id ?? '') === group);
  const last = Math.max(...inGroup.map(m => rounds.get(m.id)!));
  const played = new Set(mine.map(m => rounds.get(m.id)!));
  const out: number[] = [];
  for (let r = 1; r <= last; r++) if (!played.has(r)) out.push(r);
  return out;
}

/** Byes right before one of the player's matches (after their previous match). */
export function byesBefore(matches: CourtMatch[], rounds: Map<string, number>, userId: string | null, match: CourtMatch): number[] {
  const r = rounds.get(match.id);
  if (r == null || !userId) return [];
  const prev = Math.max(0, ...matches
    .filter(m => rounds.has(m.id) && players(m).includes(userId) && rounds.get(m.id)! < r)
    .map(m => rounds.get(m.id)!));
  return byesFor(matches, rounds, userId).filter(b => b > prev && b < r);
}

/** [4] -> 'round 4'; [4, 5] -> 'rounds 4 and 5'; [3, 4, 5] -> 'rounds 3, 4 and 5'. */
export function roundsText(rs: number[]): string {
  if (rs.length === 0) return '';
  if (rs.length === 1) return `round ${rs[0]}`;
  return `rounds ${rs.slice(0, -1).join(', ')} and ${rs[rs.length - 1]}`;
}

/** The round that is being played: the lowest round with an open match. */
export function currentRound(matches: CourtMatch[], rounds: Map<string, number>): number | null {
  const open = matches.filter(m => rounds.has(m.id) && isOpen(m)).map(m => rounds.get(m.id)!);
  return open.length ? Math.min(...open) : null;
}

export type CourtState =
  | { kind: 'free_play' }                                    // no courts reserved
  | { kind: 'on_court'; court: string }                      // called: go play
  | { kind: 'waiting_player'; busy: string[]; court: string | null } // a player of it is still on a court
  | { kind: 'waiting_court'; ahead: number };               // everyone is free; courts are full

/** Where a match stands in the court queue. */
export function courtState(match: CourtMatch, matches: CourtMatch[], courts: string[] | null | undefined,
  rounds: Map<string, number>): CourtState {
  if (!hasCourts(courts)) return { kind: 'free_play' };
  if (match.called_at && match.court && isOpen(match)) return { kind: 'on_court', court: match.court };
  const live = matches.filter(m => m.called_at && isOpen(m) && m.id !== match.id);
  const mine = players(match);
  for (const m of live) {
    const busy = players(m).filter(p => mine.includes(p));
    if (busy.length) return { kind: 'waiting_player', busy, court: m.court ?? null };
  }
  const key = (m: CourtMatch) => [m.round?.round_number ?? 0, rounds.get(m.id) ?? 0, m.match_order ?? 0];
  const before = (a: CourtMatch, b: CourtMatch) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
    return false;
  };
  const ahead = matches.filter(m => isOpen(m) && !m.called_at && m.id !== match.id
    && !!m.team1_player1 && !!m.team2_player1 && m.match_type !== 'bye' && before(m, match)).length;
  return { kind: 'waiting_court', ahead };
}

/** One line for a court state ("On Court 2 now", "Waiting for Sam's match on Court 1 to finish"). */
export function courtStateLine(s: CourtState, name: (id: string) => string): string | null {
  switch (s.kind) {
    case 'free_play': return null;
    case 'on_court': return `On ${courtLabel(s.court)} now. Head there to play.`;
    case 'waiting_player': {
      const who = s.busy.map(name).join(' & ');
      return `Waiting for ${who}'s match${s.court ? ` on ${courtLabel(s.court)}` : ''} to finish.`;
    }
    case 'waiting_court':
      return s.ahead > 0
        ? `Waiting for a free court, ${s.ahead} match${s.ahead === 1 ? '' : 'es'} ahead.`
        : 'Waiting for a free court. You\'re next.';
  }
}

/**
 * Can this viewer score the match now? With courts reserved only a called
 * match, unless they are the host (the server's PL_TM_NOT_CALLED gate).
 */
export function courtAllowsScoring(match: CourtMatch, courts: string[] | null | undefined, isHost: boolean): boolean {
  return !hasCourts(courts) || !!match.called_at || isHost;
}

/** Schedule rows: where each of the viewer's byes goes (before the first match of that round). */
export function byeSlots(matches: CourtMatch[], rounds: Map<string, number>, userId: string | null):
  { round: number; beforeMatchId: string | null }[] {
  return byesFor(matches, rounds, userId).map(round => {
    const first = matches
      .filter(m => rounds.get(m.id) === round)
      .sort((a, b) => (a.match_order ?? 0) - (b.match_order ?? 0))[0];
    return { round, beforeMatchId: first?.id ?? null };
  });
}
