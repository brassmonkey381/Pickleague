/**
 * PKL-091: why the viewer has no match to play right now, and what comes next, from the tournament's matches alone.
 * TournamentYouCard's "playing" state shows it instead of a bare "No match to play right now".
 *
 *   "You're in the Final"            "It starts when Semifinal 2 ends: Kitchen Kings v Erne Express, 2-2, Dreambreaker on Court 1"
 *   "Your matchups are done"         "3 more matchups to finish before the playoff draw. Now: Lob City v Paddle Battle, 1-1"
 *   "Your team is out"               "Watch the Final: Third Shot Club v Lob City, 2-1"
 *   "You finished 4th"
 *
 * No time estimates: nothing in the data gives a sound basis for one, so it gives counts. MLP talks in teams and
 * matchups (a matchup is decided at 3 game wins, PKL-089); every other format in matches. Pure: tests cover it.
 */

export type WaitMatch = {
  id: string;
  round_id: string;
  status: string;
  winner_team: 'team1' | 'team2' | null;
  team1_player1: string | null; team1_player2: string | null;
  team2_player1: string | null; team2_player2: string | null;
  team1_score?: number | null; team2_score?: number | null;
  is_dreambreaker?: boolean | null;
  match_order?: number | null;
  court?: string | null;
  called_at?: string | null;
  round?: { id: string; label: string | null; round_type: string; round_number: number } | null;
};

export type WaitInput = {
  format: string;
  isMlp: boolean;
  /** Whether a playoff follows the group stage (playoff_format set, or an MLP *_playoff format). */
  hasPlayoff: boolean;
  /** The viewer's player id, or all 4 of their MLP team's. */
  me: string[];
  matches: WaitMatch[];
  /** A side's display name: the MLP team's name, or the players' short names. */
  nameOf: (players: string[]) => string;
};

export type WaitReason = { title: string; line: string | null; matchId: string | null };

const ELIM = new Set(['single_elimination', 'double_elimination']);
const GROUP = new Set(['pool', 'winners']);
const ROUND_NAME: Record<string, string> = {
  quarterfinals: 'Quarterfinal', semifinals: 'Semifinal', finals: 'Final', third_place_match: '3rd place match',
  grand_final: 'Grand Final', losers: 'Losers round',
};
const NEXT_NAME: Record<string, string> = { quarterfinals: 'Semifinals', semifinals: 'Final' };
const courtName = (c: string) => (/^\d+$/.test(c.trim()) ? `Court ${c.trim()}` : c.trim());

type Unit = {
  key: string; roundType: string; roundNumber: number; order: number; group: boolean;
  side1: string[]; side2: string[]; firstMatchId: string;
  winner: 1 | 2 | null; open: boolean; live: string | null; label: string;
  /** Named playoff rounds (Semifinal, Final, ...) group by type, whatever their round_number; others by number. */
  stageKey: string; named: boolean;
};

function sideOf(m: WaitMatch, t: 1 | 2): string[] {
  return (t === 1 ? [m.team1_player1, m.team1_player2] : [m.team2_player1, m.team2_player2]).filter((x): x is string => !!x);
}

function buildUnits(i: WaitInput): Unit[] {
  const real = i.matches.filter(m => m.team1_player1 && m.team2_player1);
  const groups = new Map<string, WaitMatch[]>();
  for (const m of real) {
    const k = i.isMlp ? m.round_id : m.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(m);
  }
  const units: Unit[] = [];
  for (const [key, ms] of groups) {
    const sorted = [...ms].sort((a, b) => (a.match_order ?? 0) - (b.match_order ?? 0));
    const first = sorted.find(m => !m.is_dreambreaker) ?? sorted[0];
    const rt = first.round?.round_type ?? 'winners';
    const group = !ELIM.has(i.format) && GROUP.has(rt);
    const side1 = [...new Set(sorted.flatMap(m => sideOf(m, 1)))];
    const side2 = [...new Set(sorted.flatMap(m => sideOf(m, 2)))];
    let winner: 1 | 2 | null = null;
    let open: boolean;
    let live: string | null = null;
    const called = sorted.find(m => m.status === 'pending' && m.called_at && m.court);
    if (i.isMlp) {
      const done = sorted.filter(m => m.status === 'completed' && m.winner_team);
      const a = done.filter(m => m.winner_team === 'team1').length, b = done.length - a;
      const anyOpen = sorted.some(m => m.status === 'pending');
      winner = a >= 3 ? 1 : b >= 3 ? 2 : !anyOpen && done.length && a !== b ? (a > b ? 1 : 2) : null;
      open = winner == null && anyOpen;
      if (open) {
        const db = sorted.find(m => m.is_dreambreaker && m.status === 'pending');
        live = `${a}-${b}${db && a === 2 && b === 2 ? ', Dreambreaker' : ''}${called ? ` on ${courtName(called.court!)}` : ''}`;
      }
    } else {
      const m = sorted[0];
      winner = m.status === 'completed' && m.winner_team ? (m.winner_team === 'team1' ? 1 : 2) : null;
      open = m.status === 'pending';
      if (open && called) live = `on ${courtName(called.court!)} now`;
    }
    units.push({ key, roundType: rt, roundNumber: first.round?.round_number ?? 0, order: first.match_order ?? 0, group,
      side1, side2, firstMatchId: first.id, winner, open, live, label: '',
      stageKey: ROUND_NAME[rt] ? rt : `${rt}#${first.round?.round_number ?? 0}`, named: !group && !!ROUND_NAME[rt] });
  }
  // labels: "Semifinal 2: A v B", "Round 1, match 2: A v B", "A v B" for the group stage
  for (const u of units) {
    const peers = units.filter(x => x.stageKey === u.stageKey).sort((a, b) => a.roundNumber - b.roundNumber || a.order - b.order);
    const k = peers.indexOf(u) + 1;
    const name = u.group ? ''
      : u.named ? `${ROUND_NAME[u.roundType]}${peers.length > 1 ? ` ${k}` : ''}: `
      : `Round ${u.roundNumber}${peers.length > 1 ? `, match ${k}` : ''}: `;
    u.label = `${name}${i.nameOf(u.side1)} v ${i.nameOf(u.side2)}`;
  }
  return units;
}

const withLive = (u: Unit) => (u.live ? `${u.label}, ${u.live}` : u.label);
const watch = (u: Unit) => `Watch ${u.named ? 'the ' : ''}${withLive(u)}`;

export function waitReason(i: WaitInput): WaitReason | null {
  if (!i.me.length) return null;
  const units = buildUnits(i);
  const mine = (u: Unit) => u.side1.some(p => i.me.includes(p)) || u.side2.some(p => i.me.includes(p));
  const myWin = (u: Unit) => u.winner != null && (u.winner === 1 ? u.side1 : u.side2).some(p => i.me.includes(p));
  if (units.some(u => mine(u) && u.open)) return null;   // a match of mine is open: the "next match" card applies
  const team = i.isMlp;
  const you = team ? 'Your team' : 'You';
  const youre = team ? 'Your team is' : 'You\'re';

  const myPlayoff = units.filter(u => mine(u) && !u.group && u.winner != null).sort((a, b) => a.roundNumber - b.roundNumber || a.order - b.order);
  const last = myPlayoff[myPlayoff.length - 1];
  if (last) {
    const won = myWin(last);
    if (last.roundType === 'finals' || last.roundType === 'grand_final') {
      return { title: won ? `${you} won the ${ROUND_NAME[last.roundType]}` : `${you} finished 2nd`, line: null, matchId: null };
    }
    if (last.roundType === 'third_place_match') return { title: `${you} finished ${won ? '3rd' : '4th'}`, line: null, matchId: null };
    if (!won) {
      const w = units.filter(u => !u.group && u.open).sort((a, b) => b.roundNumber - a.roundNumber || a.order - b.order)[0];
      return { title: `${youre} out`, line: w ? watch(w) : null, matchId: w?.firstMatchId ?? null };
    }
    const blockers = units.filter(u => !u.group && u.open && u.stageKey === last.stageKey);
    const next = NEXT_NAME[last.roundType] ?? 'next round';
    const title = `${youre} in the ${next}`;
    if (!blockers.length) return { title, line: 'It is being drawn now.', matchId: null };
    const line = blockers.length === 1
      ? `It starts when ${withLive(blockers[0])} ends.`
      : `It starts when ${blockers.length} more matches end.`;
    return { title, line, matchId: blockers[0].firstMatchId };
  }

  const groupOpen = units.filter(u => u.group && u.open);
  const word = team ? 'matchup' : 'match';
  if (groupOpen.length) {
    const now = groupOpen.find(u => u.live);
    const n = groupOpen.length;
    const line = `${n} more ${word}${n === 1 ? '' : team ? 's' : 'es'} to finish${i.hasPlayoff ? ' before the playoff draw' : ''}`
      + (now ? `. Now: ${now.label}, ${now.live}` : '.');
    return { title: team ? 'Your matchups are done' : 'Your matches are done', line, matchId: (now ?? groupOpen[0]).firstMatchId };
  }
  const playoffOpen = units.filter(u => !u.group && u.open).sort((a, b) => b.roundNumber - a.roundNumber || a.order - b.order);
  if (units.some(u => !u.group)) {
    const w = playoffOpen[0];
    return { title: `${you} didn't make the playoff`, line: w ? watch(w) : null, matchId: w?.firstMatchId ?? null };
  }
  if (i.hasPlayoff) return { title: 'The playoff draw is next', line: 'It is drawn once every result is in.', matchId: null };
  return null;
}
