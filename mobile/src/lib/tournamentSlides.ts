// PKL-070: the whole tournament as 1-3 share slides (Post 4:5 or Story 9:16),
// drawn by components/share/ShareCardArt ('slide-1' .. 'slide-3'):
//   1. Format & draw: the format in a line, then the pools with their teams,
//      the round-1 bracket with seeds, or the field.
//   2. Results: every round or pool with its scores (an elimination draw in
//      bracket order, a double elimination as winners | losers columns).
//   3. Standings: the final places, or the standings now.
// The sharer is marked on every slide (`me`). Names come in already short and
// masked (lib/finishShare shortNamer + cardPlayer rules), so nothing here
// knows a full name. Pure TS: vitest covers it.
//
// Sharing several images: the app ships over the air, so there's no native
// "save all to Photos" (expo-media-library). The studio shares one slide at a
// time; PickleShareStudio's copy walks the sharer through Save Image per slide
// and picking all of them for an Instagram carousel.
import { ordinal } from './finishShare';
import type { StandingsData } from '../components/tournament/standingsData';

export type SlidePageId = 'draw' | 'results' | 'standings';
export const SLIDE_PAGE_NAME: Record<SlidePageId, string> = {
  draw: 'Format & draw',
  results: 'Results',
  standings: 'Standings',
};

/** A team (or a player) on a slide. */
export type SlideSide = { name: string; seed: number | null; me: boolean };
export type SlideMatch = {
  a: SlideSide | null;
  b: SlideSide | null;
  /** Scores, when played. */
  sa: number | null;
  sb: number | null;
  win: 'a' | 'b' | null;
  bye: boolean;
  me: boolean;
};
export type SlideSection = {
  label: string;
  /** done: every match scored; now: being played; next: not drawn yet. */
  state: 'done' | 'now' | 'next';
  matches: SlideMatch[];
  /** Matches left off to keep the slide readable ("6 more, see the standings"). */
  more: number;
  /** A pool of up to GRID_MAX teams as a pool sheet (every team against every other), far denser than boxes. */
  grid?: SlideGrid | null;
};
/** cells[i][j]: team i's score against team j ("11-3", from i's side), '' not played yet, null itself. */
export type SlideGrid = { teams: SlideSide[]; cells: (string | null)[][]; won: (boolean | null)[][] };
/** Pools this size or smaller draw as a pool sheet. */
export const GRID_MAX = 6;
export type SlidePool = { label: string; teams: SlideSide[] };
export type SlideDraw =
  | { kind: 'pools'; pools: SlidePool[]; then: string[] }
  | { kind: 'bracket'; section: SlideSection; then: string[] }
  | { kind: 'field'; teams: SlideSide[]; then: string[] };
export type SlideResults = {
  /** Full-width sections (pools, playoff rounds, a Grand Final). */
  main: SlideSection[];
  /** Double elimination: the winners and losers brackets side by side, above `main`. */
  winners: SlideSection[] | null;
  losers: SlideSection[] | null;
};
export type SlideStandRow = { place: string; name: string; record: string; me: boolean; note: string | null };
export type SlideTable = { label: string | null; rows: SlideStandRow[] };
export type SlideStandings = { title: string; tables: SlideTable[]; note: string | null };

export type TournamentSlides = {
  title: string;
  /** "Pool play, 2 pools, top 2 per pool to the playoff". */
  formatLine: string;
  /** "8 teams, doubles". */
  fieldLine: string;
  /** "Final results", "9 of 16 matches played". */
  statusLine: string;
  finished: boolean;
  draw: SlideDraw;
  results: SlideResults | null;
  standings: SlideStandings | null;
  /** The slides there are, in order (1-3). */
  pages: SlidePageId[];
};

export type SlideRoundIn = { id: string; label: string | null; round_type: string; round_number: number };
export type SlideMatchIn = {
  id: string;
  status: string;
  match_order?: number | null;
  match_type?: string | null;
  is_dreambreaker?: boolean | null;
  play_round?: number | null;
  winner_team: 'team1' | 'team2' | null;
  team1_player1: string | null;
  team1_player2: string | null;
  team2_player1: string | null;
  team2_player2: string | null;
  team1_score?: number | null;
  team2_score?: number | null;
  round_id?: string | null;
  round?: { id: string } | null;
};

export type SlidesInput = {
  title: string;
  format: string;
  matchType: 'singles' | 'doubles' | string;
  status: string;
  playoffFormat?: string | null;
  playoffThirdPlace?: boolean | null;
  rounds: readonly SlideRoundIn[];
  matches: readonly SlideMatchIn[];
  me: string;
  /** A player's short, masked name ("Sam L.", "a player"). */
  nameOf: (id: string) => string;
  /** A player's registration seed. */
  seedOf?: (id: string) => number | null | undefined;
  /** The standings the app shows (components/tournament/standingsData buildStandings). */
  standings: StandingsData | null;
  /** Playoff stages the settings will create, drawn or not (lib/tournamentFlow predictFlow). */
  expected?: readonly string[] | null;
};

/** At most this many result boxes on the Results slide; past it, pools I'm not in fold into one line each. */
export const RESULTS_CAP = 20;
/** At most this many rows on the Standings slide (my row always stays). */
export const STANDINGS_CAP = 16;

const ELIM = new Set(['single_elimination', 'double_elimination']);
const GROUP_TYPES = new Set(['winners', 'pool']);
const PLAYOFF_ORDER: Record<string, number> = { quarterfinals: 1, semifinals: 2, third_place_match: 3, finals: 4, grand_final: 5 };
const LABEL_ORDER: Record<string, number> = { quarterfinals: 1, semifinals: 2, 'third place match': 3, 'third place': 3, finals: 4 };
const GROUP_LABEL: Record<string, string> = {
  pool_play: 'Pool play', round_robin: 'Round robin', rotating_partners: 'Rotating partners', mlp: 'Team play', mlp_random: 'Team play',
};

const norm = (s: string) => s.trim().toLowerCase().replace(/^final$/, 'finals').replace(/^third place$/, 'third place match');

/** "Finals" -> "Final", "Third Place Match" -> "Third place", "Grand Final (Reset)" stays. */
export function slideStageLabel(label: string): string {
  const l = label.trim();
  if (/^third place( match)?$/i.test(l)) return 'Third place';
  if (/^finals?$/i.test(l)) return 'Final';
  // The server's first-round names ("Single Elim Schedule", "Round Robin Schedule").
  if (/^single elim(ination)? schedule$/i.test(l) || /^double elim(ination)? schedule$/i.test(l)) return 'Round 1';
  if (/^round robin schedule$/i.test(l)) return 'Round robin';
  return l;
}

/** "Pool play, 2 pools, top 2 per pool to the playoff". No middle dots (the copy rule). */
export function slideFormatLine(format: string, o: { pools: number; playoffFormat?: string | null; thirdPlace?: boolean | null }): string {
  const parts: string[] = [];
  switch (format) {
    case 'pool_play': parts.push('Pool play'); if (o.pools > 0) parts.push(`${o.pools} pool${o.pools === 1 ? '' : 's'}`); break;
    case 'round_robin': parts.push('Round robin'); break;
    case 'single_elimination': parts.push('Single elimination'); break;
    case 'double_elimination': parts.push('Double elimination, out after 2 losses'); break;
    case 'rotating_partners': parts.push('Rotating partners, a new partner each round'); break;
    case 'mlp': case 'mlp_random': parts.push('Team play (MLP)'); break;
    default: parts.push(format.replace(/_/g, ' '));
  }
  if (!ELIM.has(format)) {
    const pf = o.playoffFormat ?? 'none';
    const to = ({
      top_2: 'top 2 to the Final', top_4: 'top 4 to the playoff', top_8: 'top 8 to the playoff',
      top_1_per_pool: 'pool winners to the playoff', top_2_per_pool: 'top 2 per pool to the playoff',
    } as Record<string, string>)[pf];
    if (to) parts.push(to);
  }
  if (o.thirdPlace && (ELIM.has(format) || (o.playoffFormat && o.playoffFormat !== 'none')) && format !== 'double_elimination') {
    parts.push('third place match');
  }
  return parts.join(', ');
}

export function buildTournamentSlides(i: SlidesInput): TournamentSlides {
  const { format, me } = i;
  const elim = ELIM.has(format);
  const double = format === 'double_elimination';
  const perPlayer = format === 'rotating_partners' || format === 'mlp' || format === 'mlp_random';
  const finished = i.status === 'completed';
  const roundIdOf = (m: SlideMatchIn) => m.round_id ?? m.round?.id ?? null;
  const roundById = new Map(i.rounds.map((r) => [r.id, r]));
  const visible = i.matches.filter((m) => !(m.is_dreambreaker && m.status === 'cancelled') && m.status !== 'cancelled');

  const seedOfTeam = (p1: string, p2: string | null): number | null => {
    if (!i.seedOf) return null;
    const s = [i.seedOf(p1), p2 ? i.seedOf(p2) : null].filter((x): x is number => x != null);
    return s.length ? Math.min(...s) : null;
  };
  const side = (p1: string | null, p2: string | null): SlideSide | null =>
    p1 ? { name: p2 ? `${i.nameOf(p1)} & ${i.nameOf(p2)}` : i.nameOf(p1), seed: perPlayer ? null : seedOfTeam(p1, p2), me: p1 === me || p2 === me } : null;
  const isBye = (m: SlideMatchIn) => m.match_type === 'bye' || !m.team1_player1 || !m.team2_player1;
  const played = (m: SlideMatchIn) => m.status === 'completed' && !!m.winner_team && !isBye(m);
  const toMatch = (m: SlideMatchIn): SlideMatch => {
    const a = side(m.team1_player1, m.team1_player2);
    const b = side(m.team2_player1, m.team2_player2);
    const p = played(m);
    return {
      a, b,
      sa: p ? m.team1_score ?? null : null,
      sb: p ? m.team2_score ?? null : null,
      win: p ? (m.winner_team === 'team1' ? 'a' : 'b') : null,
      bye: isBye(m),
      me: !!(a?.me || b?.me),
    };
  };
  const byOrder = (a: SlideMatchIn, b: SlideMatchIn) =>
    (a.play_round ?? 0) - (b.play_round ?? 0) || (a.match_order ?? 0) - (b.match_order ?? 0);
  const stateOf = (ms: SlideMatchIn[]): SlideSection['state'] =>
    ms.length === 0 ? 'next' : ms.every((m) => isBye(m) || m.status === 'completed') ? 'done' : 'now';

  // ── which bucket each round is in ──
  type Bucket = 'group' | 'playoff' | 'winners' | 'losers' | 'gf';
  const bucketOf = (rt: string | undefined): Bucket => {
    if (double) return rt === 'losers' ? 'losers' : rt === 'grand_final' ? 'gf' : 'winners';
    if (elim) return 'playoff';
    return !rt || GROUP_TYPES.has(rt) ? 'group' : 'playoff';
  };
  const matchesOf = (rid: string) => visible.filter((m) => roundIdOf(m) === rid).sort(byOrder);
  const drawnRounds = i.rounds.filter((r) => visible.some((m) => roundIdOf(m) === r.id));
  const ordered = (b: Bucket) => drawnRounds.filter((r) => bucketOf(r.round_type) === b)
    .sort((x, y) => (b === 'playoff' && !elim
      ? (PLAYOFF_ORDER[x.round_type] ?? LABEL_ORDER[norm(x.label ?? '')] ?? 0) - (PLAYOFF_ORDER[y.round_type] ?? LABEL_ORDER[norm(y.label ?? '')] ?? 0)
      : 0) || x.round_number - y.round_number);
  const sectionOf = (r: SlideRoundIn, label?: string, keepByes = false): SlideSection => {
    const ms = matchesOf(r.id);
    return {
      label: label ?? slideStageLabel(r.label?.trim() || r.round_type.replace(/_/g, ' ')),
      state: stateOf(ms),
      matches: ms.filter((m) => keepByes || !isBye(m)).map(toMatch),
      more: 0,
    };
  };
  // Matches with no round (old rows) count as the group stage.
  const loose = visible.filter((m) => { const rid = roundIdOf(m); return !rid || !roundById.has(rid); }).sort(byOrder);

  /** The pool sheet for a group section's matches (null past GRID_MAX teams, or a rematch). */
  const gridOf = (ms: SlideMatchIn[]): SlideGrid | null => {
    if (perPlayer) return null;
    const keyOf = (p1: string | null, p2: string | null) => [p1, p2].filter(Boolean).sort().join('|');
    const sides = new Map<string, SlideSide>();
    for (const m of ms) {
      for (const [p1, p2] of [[m.team1_player1, m.team1_player2], [m.team2_player1, m.team2_player2]] as [string | null, string | null][]) {
        if (p1 && !sides.has(keyOf(p1, p2))) sides.set(keyOf(p1, p2), side(p1, p2)!);
      }
    }
    // In seed order, the way the draw lists the pool.
    const order = [...sides.entries()].sort((a, b) => (a[1].seed ?? 1e9) - (b[1].seed ?? 1e9));
    const n = order.length;
    if (n < 3 || n > GRID_MAX) return null;
    const at = new Map(order.map(([k], idx) => [k, idx]));
    const cells: (string | null)[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? null : '')));
    const won: (boolean | null)[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
    const met = new Set<string>();
    for (const m of ms) {
      const i = at.get(keyOf(m.team1_player1, m.team1_player2));
      const j = at.get(keyOf(m.team2_player1, m.team2_player2));
      if (i == null || j == null || i === j) continue;
      const pair = `${Math.min(i, j)}:${Math.max(i, j)}`;
      if (met.has(pair)) return null; // a rematch: boxes say it better
      met.add(pair);
      if (!played(m)) continue;
      const a = m.team1_score ?? 0, b = m.team2_score ?? 0;
      cells[i][j] = `${a}-${b}`; cells[j][i] = `${b}-${a}`;
      won[i][j] = m.winner_team === 'team1'; won[j][i] = m.winner_team === 'team2';
    }
    return { teams: order.map(([, s]) => s), cells, won };
  };

  // ── group stage ──
  const poolRounds = format === 'pool_play' ? ordered('group').filter((r) => r.round_type === 'pool') : [];
  const groupSections: SlideSection[] = [];
  if (!elim) {
    if (poolRounds.length) {
      poolRounds.forEach((r, k) => groupSections.push({
        ...sectionOf(r, r.label?.trim() || `Pool ${String.fromCharCode(65 + k)}`),
        grid: gridOf(matchesOf(r.id).filter((m) => !isBye(m))),
      }));
    } else {
      const ms = [...ordered('group').flatMap((r) => matchesOf(r.id)), ...loose].sort(byOrder);
      const real = ms.filter((m) => !isBye(m));
      if (ms.length) groupSections.push({ label: GROUP_LABEL[format] ?? 'Group stage', state: stateOf(ms), matches: real.map(toMatch), more: 0, grid: gridOf(real) });
    }
  }

  // ── playoff / bracket rounds, with the stages still to come ──
  const playoffSections: SlideSection[] = ordered('playoff').map((r) => sectionOf(r));
  if (elim && loose.length && !double) {
    playoffSections.unshift({ label: 'Round 1', state: stateOf(loose), matches: loose.filter((m) => !isBye(m)).map(toMatch), more: 0 });
  }
  if (!double) {
    for (const l of i.expected ?? []) {
      const label = slideStageLabel(l);
      if (playoffSections.some((s) => norm(s.label) === norm(label))) continue;
      playoffSections.push({ label, state: 'next', matches: [], more: 0 });
    }
    if (!elim) {
      const rank = (s: SlideSection) => LABEL_ORDER[norm(s.label)] ?? 0;
      playoffSections.sort((a, b) => rank(a) - rank(b));
    } else {
      // An elimination draw: drawn rounds in order, then the ones to come; the third place match before the Final.
      const fin = playoffSections.findIndex((s) => norm(s.label) === 'finals');
      const third = playoffSections.findIndex((s) => norm(s.label) === 'third place match');
      if (fin >= 0 && third > fin) playoffSections.splice(fin, 0, ...playoffSections.splice(third, 1));
    }
  }
  const winnersSections = double ? ordered('winners').map((r) => sectionOf(r)) : null;
  const losersSections = double ? ordered('losers').map((r) => sectionOf(r)) : null;
  const gfSections = double ? ordered('gf').map((r) => sectionOf(r)) : [];

  // ── the field and the format line ──
  const sidesOf = (ms: readonly SlideMatchIn[]): SlideSide[] => {
    const seen = new Map<string, SlideSide>();
    for (const m of ms) {
      const pairs: [string | null, string | null][] = [[m.team1_player1, m.team1_player2], [m.team2_player1, m.team2_player2]];
      for (const [p1, p2] of pairs) {
        if (!p1) continue;
        if (perPlayer) {
          for (const p of [p1, p2]) if (p && !seen.has(p)) seen.set(p, side(p, null)!);
        } else {
          const k = [p1, p2].filter(Boolean).sort().join('|');
          if (!seen.has(k)) seen.set(k, side(p1, p2)!);
        }
      }
    }
    return [...seen.values()].sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9));
  };
  const field = sidesOf(visible);
  const doublesTeams = i.matchType === 'doubles' && !perPlayer;
  const fieldLine = format === 'mlp' || format === 'mlp_random'
    ? `${field.length} players`
    : `${field.length} ${doublesTeams ? 'teams' : 'players'}${format === 'rotating_partners' ? '' : doublesTeams ? ', doubles' : ', singles'}`;
  const formatLine = slideFormatLine(format, { pools: poolRounds.length, playoffFormat: i.playoffFormat, thirdPlace: i.playoffThirdPlace });
  const real = visible.filter((m) => !isBye(m));
  const playedCount = real.filter(played).length;
  const statusLine = finished ? 'Final results' : `${playedCount} of ${real.length} matches played`;

  // ── slide 1: the draw ──
  const later = (secs: SlideSection[]) => secs.map((s) => s.label);
  let draw: SlideDraw;
  if (poolRounds.length) {
    draw = {
      kind: 'pools',
      pools: poolRounds.map((r, k) => ({ label: groupSections[k].label, teams: sidesOf(matchesOf(r.id)) })),
      then: later(playoffSections),
    };
  } else if (elim) {
    const first = double ? ordered('winners')[0] : ordered('playoff')[0];
    if (first) {
      const sec = sectionOf(first, slideStageLabel(first.label?.trim() || 'Round 1'), true);
      draw = {
        kind: 'bracket',
        section: sec,
        then: double ? ['Winners and losers brackets', 'Grand Final'] : later(playoffSections.slice(1)),
      };
    } else {
      draw = { kind: 'field', teams: field, then: [] };
    }
  } else {
    draw = { kind: 'field', teams: field, then: later(playoffSections) };
  }

  // ── slide 2: results, kept readable ──
  let results: SlideResults | null = null;
  if (playedCount > 0) {
    results = capResults({
      main: double ? gfSections : [...groupSections, ...playoffSections],
      winners: winnersSections,
      losers: losersSections,
    }, groupSections.length);
  }

  // ── slide 3: standings ──
  const standings = playedCount > 0 ? standingsSlide(i, { finished, elim, double, visible, played, isBye, roundIdOf, roundById, side }) : null;

  const pages: SlidePageId[] = ['draw'];
  if (results) pages.push('results');
  if (standings && standings.tables.some((t) => t.rows.length > 0)) pages.push('standings');
  return { title: i.title, formatLine, fieldLine, statusLine, finished, draw, results, standings: pages.includes('standings') ? standings : null, pages };
}

/** How many boxes a results slide draws (a pool sheet counts as half a box per team). */
export function resultBoxes(r: SlideResults): number {
  const n = (ss: SlideSection[] | null) => (ss ?? []).reduce((k, s) => k + (s.grid ? Math.ceil(s.grid.teams.length / 2) : s.matches.length), 0);
  return n(r.main) + n(r.winners) + n(r.losers);
}

/**
 * Over RESULTS_CAP boxes: fold the group sections the sharer isn't in into one
 * line each ("6 matches, see the standings"), then trim the rest of the group
 * stage to the sharer's own matches, then early bracket rounds the same way.
 * The playoff's later rounds always stay whole.
 */
function capResults(r: SlideResults, groupCount: number): SlideResults {
  const fold = (s: SlideSection, keep: (m: SlideMatch) => boolean): SlideSection => {
    const kept = s.matches.filter(keep);
    return { ...s, matches: kept, more: s.more + s.matches.length - kept.length, grid: null };
  };
  const steps: ((s: SlideSection, idx: number, col: 'main' | 'winners' | 'losers') => SlideSection)[] = [
    (s, idx, col) => (col === 'main' && idx < groupCount && !s.matches.some((m) => m.me) ? fold(s, () => false) : s),
    (s, idx, col) => (col === 'main' && idx < groupCount ? fold(s, (m) => m.me) : s),
  ];
  let out = r;
  for (const step of steps) {
    if (resultBoxes(out) <= RESULTS_CAP) return out;
    out = {
      main: out.main.map((s, k) => step(s, k, 'main')),
      winners: out.winners?.map((s, k) => step(s, k, 'winners')) ?? null,
      losers: out.losers?.map((s, k) => step(s, k, 'losers')) ?? null,
    };
  }
  // Still over: the earliest rounds with the most matches keep only the sharer's.
  const cols: ('main' | 'winners' | 'losers')[] = ['main', 'winners', 'losers'];
  for (let guard = 0; resultBoxes(out) > RESULTS_CAP && guard < 64; guard++) {
    let best: { col: 'main' | 'winners' | 'losers'; k: number; n: number } | null = null;
    for (const col of cols) {
      (out[col] ?? []).forEach((s, k) => {
        const n = s.matches.filter((m) => !m.me).length;
        if (n > 1 && (!best || n > best.n)) best = { col, k, n };
      });
    }
    if (!best) break;
    const b: { col: 'main' | 'winners' | 'losers'; k: number } = best;
    out = { ...out, [b.col]: (out[b.col] ?? []).map((s, k) => (k === b.k ? fold(s, (m) => m.me) : s)) };
  }
  return out;
}

type StandCtx = {
  finished: boolean;
  elim: boolean;
  double: boolean;
  visible: SlideMatchIn[];
  played: (m: SlideMatchIn) => boolean;
  isBye: (m: SlideMatchIn) => boolean;
  roundIdOf: (m: SlideMatchIn) => string | null;
  roundById: Map<string, SlideRoundIn>;
  side: (p1: string | null, p2: string | null) => SlideSide | null;
};

function standingsSlide(i: SlidesInput, c: StandCtx): SlideStandings | null {
  const sd = i.standings;
  const title = c.finished ? 'Final standings' : 'Standings now';
  const players = new Set(c.visible.flatMap((m) => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2]).filter(Boolean) as string[]);
  // A standings key is "a|b" (a pair), a player id, or an MLP team id (its name is the team's).
  const nameOfKey = (key: string, fallback: string) => {
    const ids = key.split('|');
    return ids.every((id) => players.has(id)) ? ids.map(i.nameOf).join(' & ') : fallback;
  };

  if (sd?.placement && sd.placement.rows.length && (c.finished || sd.placement.rows.some((r) => r.decided))) {
    const rows = sd.placement.rows.map((r) => ({
      place: r.place, name: nameOfKey(r.key, r.name), record: `${r.wins}-${r.losses}`, me: r.isMe, note: null,
    }));
    return {
      title: c.finished ? 'Final standings' : 'Places so far',
      tables: [{ label: null, rows: capRows(rows) }],
      note: c.finished ? null : 'Places still to be decided show a range.',
    };
  }

  if (c.elim) {
    // Mid-bracket: who's still in, then who's out and where (later exits first).
    type T = { key: string; side: SlideSide; w: number; l: number; outAt: number; outIn: string | null };
    const teams = new Map<string, T>();
    const keyOf = (p1: string, p2: string | null) => [p1, p2].filter(Boolean).sort().join('|');
    const ordered = [...c.visible].sort((a, b) => {
      const ra = c.roundById.get(c.roundIdOf(a) ?? '');
      const rb = c.roundById.get(c.roundIdOf(b) ?? '');
      return (ra?.round_number ?? 0) - (rb?.round_number ?? 0) || (a.match_order ?? 0) - (b.match_order ?? 0);
    });
    let step = 0;
    for (const m of ordered) {
      step++;
      for (const [p1, p2] of [[m.team1_player1, m.team1_player2], [m.team2_player1, m.team2_player2]] as [string | null, string | null][]) {
        if (!p1) continue;
        const k = keyOf(p1, p2);
        if (!teams.has(k)) teams.set(k, { key: k, side: c.side(p1, p2)!, w: 0, l: 0, outAt: 0, outIn: null });
      }
      if (!c.played(m)) continue;
      const t1 = teams.get(keyOf(m.team1_player1!, m.team1_player2))!;
      const t2 = teams.get(keyOf(m.team2_player1!, m.team2_player2))!;
      const [w, l] = m.winner_team === 'team1' ? [t1, t2] : [t2, t1];
      w.w++; l.l++;
      if (l.l >= (c.double ? 2 : 1) && !l.outAt) {
        l.outAt = step;
        const r = c.roundById.get(c.roundIdOf(m) ?? '');
        l.outIn = r ? slideStageLabel(r.label?.trim() || r.round_type.replace(/_/g, ' ')) : null;
      }
    }
    const all = [...teams.values()];
    const alive = all.filter((t) => !t.outAt).sort((a, b) => b.w - a.w || a.l - b.l || (a.side.seed ?? 1e9) - (b.side.seed ?? 1e9));
    const out = all.filter((t) => t.outAt).sort((a, b) => b.outAt - a.outAt);
    const row = (t: T, place: string): SlideStandRow => ({
      place, name: t.side.name, record: `${t.w}-${t.l}`, me: t.side.me, note: t.outIn ? `out in ${t.outIn}` : c.double && t.l === 1 ? 'one loss' : null,
    });
    const tables: SlideTable[] = [{ label: 'Still in', rows: alive.map((t) => row(t, '')) }];
    if (out.length) tables.push({ label: 'Out', rows: out.map((t) => row(t, '')) });
    return { title, tables: capTables(tables), note: null };
  }

  if (!sd) return null;
  const tables: SlideTable[] = sd.tables.map((t) => ({
    label: t.label,
    rows: t.rows.map((r, k) => ({ place: ordinal(k + 1), name: nameOfKey(r.key, r.name), record: `${r.wins}-${r.losses}`, me: r.isMe, note: null })),
  }));
  return { title, tables: capTables(tables), note: sd.groupStage ? 'Group stage only.' : null };
}

/** At most STANDINGS_CAP rows; the sharer's row always stays. */
function capRows(rows: SlideStandRow[], cap = STANDINGS_CAP): SlideStandRow[] {
  if (rows.length <= cap) return rows;
  const head = rows.slice(0, cap - 1);
  const mine = rows.slice(cap - 1).find((r) => r.me);
  return mine ? [...head, mine] : rows.slice(0, cap);
}
function capTables(tables: SlideTable[]): SlideTable[] {
  const total = tables.reduce((n, t) => n + t.rows.length, 0);
  if (total <= STANDINGS_CAP) return tables;
  const each = Math.max(3, Math.floor(STANDINGS_CAP / tables.length));
  return tables.map((t) => ({ ...t, rows: capRows(t.rows, each) }));
}

/** 'slide-2' -> 1; anything else -> -1. */
export function slideIndexOf(template: string): number {
  const m = /^slide-(\d)$/.exec(template);
  return m ? Number(m[1]) - 1 : -1;
}

/**
 * Results rows: a section with many boxes takes a full row (boxes two across);
 * single-box sections (a Final and a Third place, a pool's last match) pair up
 * side by side, so a slide isn't half empty.
 */
export function packSections(sections: readonly SlideSection[]): SlideSection[][] {
  const rows: SlideSection[][] = [];
  const small = (s: SlideSection) => s.matches.length <= 1 && s.more === 0;
  for (const s of sections) {
    const last = rows[rows.length - 1];
    if (small(s) && last && last.length === 1 && small(last[0])) last.push(s);
    else rows.push([s]);
  }
  return rows;
}
