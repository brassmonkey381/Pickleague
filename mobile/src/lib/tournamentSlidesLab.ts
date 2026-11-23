// PKL-070: made-up tournaments for the multi-slide share (lib/tournamentSlides):
// pool play, single elimination and double elimination, each mid-tournament and
// finished, plus a just-drawn pool and a big round robin (the results cap). The
// share lab (lib/shareCardLab, /?sharelab) draws them and vitest checks them,
// both through the real builders: buildStandings, then buildTournamentSlides.
import { buildStandings } from '../components/tournament/standingsData';
import type { FinalRankRow } from './tournamentStandings';
import { shortNamer } from './finishShare';
import { buildTournamentSlides, type SlideMatchIn, type SlideRoundIn, type SlidesInput, type TournamentSlides } from './tournamentSlides';

export type LabTournamentId =
  | 'pool-drawn' | 'pool-mid' | 'pool-playoff' | 'pool-done'
  | 'se-mid' | 'se-done'
  | 'de-mid' | 'de-done'
  | 'rr-big';

export type LabTournament = {
  id: LabTournamentId;
  label: string;
  input: SlidesInput;
  slides: TournamentSlides;
  /** The sharer's final place (finished), else null; and their W-L. */
  rank: number | null;
  of: number | null;
  wins: number;
  losses: number;
};

const FULL: Record<string, string> = {
  me: 'Alex Rivera', p: 'Pat Doyle',
  a1: 'Sam Lee', a2: 'Sam Long', b1: 'Kim Reyes', b2: 'Lee Kang', c1: 'Maximiliana-Josephine Vasquez', c2: 'Jo Wu',
  d1: 'Ana Park', d2: 'Raj Tan', e1: 'Mo Faris', e2: 'Lu Chen', f1: 'Bo Hart', f2: 'Cy Nash', g1: 'Di Ortiz', g2: 'Ed Ruiz',
  h1: 'Eve Stone', h2: 'Gus Kim', i1: 'Ivy Moss', j1: 'Hal Price',
};

type Round = SlideRoundIn;
type M = SlideMatchIn & { round: Round | null };
let seq = 0;
function match(r: Round, t1: string[], t2: string[] | null, score: [number, number] | null, order = 0): M {
  seq++;
  return {
    id: `m${seq}`, status: score ? 'completed' : 'scheduled', match_order: order, match_type: t2 ? null : 'bye',
    winner_team: score ? (score[0] > score[1] ? 'team1' : 'team2') : null,
    team1_player1: t1[0], team1_player2: t1[1] ?? null, team2_player1: t2?.[0] ?? null, team2_player2: t2?.[1] ?? null,
    team1_score: score?.[0] ?? null, team2_score: score?.[1] ?? null,
    round_id: r.id, round: r,
  };
}

function finish(
  id: LabTournamentId, label: string,
  t: { format: string; matchType: string; status: string; playoffFormat?: string; third?: boolean },
  rounds: Round[], matches: M[], seeds: Record<string, number>, finalRanks: FinalRankRow[], expected: string[] | null,
): LabTournament {
  const ids = [...new Set(matches.flatMap((m) => [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2]).filter(Boolean) as string[])];
  const short = shortNamer(ids.map((x) => FULL[x]));
  const regs = ids.map((u) => ({
    id: `reg-${u}`, tournament_id: 't', user_id: u, status: 'approved', seed: seeds[u] ?? null,
    registered_at: '2026-11-01T00:00:00Z', invited_by: null, role: 'member', profile: { full_name: FULL[u] },
  })) as any[];
  const standings = buildStandings({
    tournament: { format: t.format, match_type: t.matchType, status: t.status } as any,
    savedMatches: matches as any, savedRounds: rounds, registrations: regs,
    profileNames: Object.fromEntries(ids.map((u) => [u, FULL[u]])), myUserId: 'me',
    mlpStandings: null, myMlpTeamId: null, finalRanks,
  });
  const input: SlidesInput = {
    title: label.startsWith('Pool') ? 'Fall Open' : label.startsWith('Single') ? 'Turkey Trot Bracket' : label.startsWith('Double') ? 'Winter Double Elim' : 'Thursday Ladder',
    format: t.format, matchType: t.matchType, status: t.status, playoffFormat: t.playoffFormat ?? 'none', playoffThirdPlace: !!t.third,
    rounds, matches, me: 'me', nameOf: (x) => short(FULL[x]), seedOf: (x) => seeds[x] ?? null, standings, expected,
  };
  const mine = matches.filter((m) => m.status === 'completed' && m.team2_player1 && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes('me'));
  const wins = mine.filter((m) => (m.winner_team === 'team1') === (m.team1_player1 === 'me' || m.team1_player2 === 'me')).length;
  const myRank = finalRanks.find((r) => r.user_id === 'me')?.final_rank ?? null;
  return {
    id, label, input, slides: buildTournamentSlides(input),
    rank: t.status === 'completed' ? myRank : null,
    of: t.status === 'completed' && finalRanks.length ? new Set(finalRanks.map((r) => r.final_rank)).size : null,
    wins, losses: mine.length - wins,
  };
}

const ranks = (places: [string[], number][]): FinalRankRow[] =>
  places.flatMap(([us, rank]) => us.map((user_id) => ({ user_id, final_rank: rank, wins: 0, losses: 0 })));

// ── Pool play: 8 doubles teams, 2 pools of 4, top 2 per pool to the semis, third place ──
function poolPlay(stage: 'drawn' | 'mid' | 'playoff' | 'done'): LabTournament {
  const T = {
    t1: ['a1', 'a2'], t2: ['b1', 'b2'], t3: ['c1', 'c2'], t4: ['me', 'p'],
    t5: ['d1', 'd2'], t6: ['e1', 'e2'], t7: ['f1', 'f2'], t8: ['g1', 'g2'],
  };
  const seeds: Record<string, number> = {};
  Object.values(T).forEach((pair, i) => pair.forEach((u) => { seeds[u] = i + 1; }));
  const PA: Round = { id: 'pa', label: 'Pool A', round_type: 'pool', round_number: 1 };
  const PB: Round = { id: 'pb', label: 'Pool B', round_type: 'pool', round_number: 2 };
  const SF: Round = { id: 'sf', label: 'Semifinals', round_type: 'semifinals', round_number: 1000 };
  const F: Round = { id: 'f', label: 'Finals', round_type: 'finals', round_number: 1100 };
  const TP: Round = { id: 'tp', label: 'Third Place Match', round_type: 'third_place_match', round_number: 1200 };
  // Snake: A = 1, 4, 5, 8; B = 2, 3, 6, 7. Played in this order; `n` of them have scores.
  const n = stage === 'drawn' ? 0 : stage === 'mid' ? 8 : 12;
  const pool: [Round, string[], string[], [number, number]][] = [
    [PA, T.t1, T.t8, [11, 3]], [PA, T.t4, T.t5, [11, 8]], [PB, T.t2, T.t7, [11, 6]], [PB, T.t3, T.t6, [9, 11]],
    [PA, T.t1, T.t5, [11, 5]], [PA, T.t4, T.t8, [11, 9]], [PB, T.t2, T.t6, [11, 7]], [PB, T.t3, T.t7, [11, 4]],
    [PA, T.t1, T.t4, [8, 11]], [PA, T.t5, T.t8, [11, 6]], [PB, T.t2, T.t3, [11, 10]], [PB, T.t6, T.t7, [11, 2]],
  ];
  const matches = pool.map(([r, a, b, sc], i) => match(r, a, b, i < n ? sc : null, i));
  const rounds = [PA, PB];
  // A: me 3-0, t1 2-1; B: t2 3-0, t6 2-1. Semis: me v t6, t2 v t1.
  if (stage === 'playoff' || stage === 'done') {
    rounds.push(SF, F, TP);
    matches.push(match(SF, T.t4, T.t6, [11, 7], 1), match(SF, T.t2, T.t1, stage === 'done' ? [12, 10] : null, 2));
    if (stage === 'done') matches.push(match(F, T.t4, T.t2, [9, 11], 1), match(TP, T.t6, T.t1, [11, 8], 1));
  }
  const fr = stage === 'done'
    ? ranks([[T.t2, 1], [T.t4, 2], [T.t6, 3], [T.t1, 4], [T.t5, 5], [T.t3, 6], [T.t8, 7], [T.t7, 8]])
    : [];
  const label = { drawn: 'Pool play, just drawn', mid: 'Pool play, mid-pools', playoff: 'Pool play, mid-playoff', done: 'Pool play, finished' }[stage];
  return finish(`pool-${stage}` as LabTournamentId, label,
    { format: 'pool_play', matchType: 'doubles', status: stage === 'done' ? 'completed' : 'active', playoffFormat: 'top_2_per_pool', third: true },
    rounds, matches, seeds, fr, ['Semifinals', 'Finals', 'Third Place Match']);
}

// ── Single elimination: 8 doubles teams, standard order (1v8, 4v5, 2v7, 3v6) ──
function singleElim(stage: 'mid' | 'done'): LabTournament {
  const T = [['a1', 'a2'], ['b1', 'b2'], ['me', 'p'], ['c1', 'c2'], ['d1', 'd2'], ['e1', 'e2'], ['f1', 'f2'], ['g1', 'g2']];
  const seeds: Record<string, number> = {};
  T.forEach((pair, i) => pair.forEach((u) => { seeds[u] = i + 1; }));
  const R1: Round = { id: 'r1', label: 'Single Elim Schedule', round_type: 'winners', round_number: 1 };
  const R2: Round = { id: 'r2', label: 'Round 2', round_type: 'winners', round_number: 2 };
  const F: Round = { id: 'f', label: 'Finals', round_type: 'finals', round_number: 3 };
  const s = (i: number) => T[i - 1];
  const matches = [
    match(R1, s(1), s(8), [11, 4], 1), match(R1, s(4), s(5), [9, 11], 2), match(R1, s(2), s(7), [11, 6], 3), match(R1, s(3), s(6), [11, 9], 4),
    match(R2, s(1), s(5), [11, 7], 1), match(R2, s(2), s(3), stage === 'done' ? [10, 12] : null, 2),
  ];
  const rounds = [R1, R2];
  if (stage === 'done') { rounds.push(F); matches.push(match(F, s(1), s(3), [11, 8], 1)); }
  const fr = stage === 'done' ? ranks([[s(1), 1], [s(3), 2], [s(5), 3], [s(2), 3], [s(4), 5], [s(6), 5], [s(7), 5], [s(8), 5]]) : [];
  return finish(`se-${stage}`, stage === 'mid' ? 'Single elimination, mid-bracket' : 'Single elimination, finished',
    { format: 'single_elimination', matchType: 'doubles', status: stage === 'done' ? 'completed' : 'active' },
    rounds, matches, seeds, fr, ['Single Elim Schedule', 'Round 2', 'Finals']);
}

// ── Double elimination: 8 singles players; I lose the winners final, win the losers final, lose the Grand Final ──
function doubleElim(stage: 'mid' | 'done'): LabTournament {
  const P = ['a1', 'b1', 'me', 'c1', 'd1', 'e1', 'f1', 'g1'];
  const seeds: Record<string, number> = Object.fromEntries(P.map((u, i) => [u, i + 1]));
  const s = (i: number) => [P[i - 1]];
  const W = (n: number): Round => ({ id: `w${n}`, label: `Winners Round ${n}`, round_type: 'winners', round_number: n });
  const L = (n: number): Round => ({ id: `l${n}`, label: `Losers Round ${n}`, round_type: 'losers', round_number: n });
  const GF: Round = { id: 'gf', label: 'Grand Final', round_type: 'grand_final', round_number: 1 };
  const done = stage === 'done';
  const matches = [
    match(W(1), s(1), s(8), [11, 2], 1), match(W(1), s(4), s(5), [11, 9], 2), match(W(1), s(2), s(7), [11, 5], 3), match(W(1), s(3), s(6), [11, 8], 4),
    match(W(2), s(1), s(4), [11, 6], 1), match(W(2), s(2), s(3), [7, 11], 2),
    match(L(1), s(8), s(5), [6, 11], 1), match(L(1), s(7), s(6), [9, 11], 2),
    match(L(2), s(4), s(6), [11, 3], 1), match(L(2), s(2), s(5), done ? [11, 9] : null, 2),
    match(W(3), s(1), s(3), done ? [11, 9] : null, 1),
  ];
  const rounds = [W(1), W(2), W(3), L(1), L(2)];
  if (done) {
    rounds.push(L(3), L(4), GF);
    matches.push(match(L(3), s(4), s(2), [8, 11], 1), match(L(4), s(3), s(2), [11, 7], 1), match(GF, s(1), s(3), [11, 9], 1));
  }
  const fr = done ? ranks([[s(1), 1], [s(3), 2], [s(2), 3], [s(4), 4], [s(5), 5], [s(6), 5], [s(7), 7], [s(8), 7]]) : [];
  return finish(`de-${stage}`, stage === 'mid' ? 'Double elimination, mid-bracket' : 'Double elimination, finished',
    { format: 'double_elimination', matchType: 'singles', status: done ? 'completed' : 'active' },
    rounds, matches, seeds, fr, null);
}

// ── A big singles round robin (10 players, 45 matches): the results slide folds to my matches ──
function bigRoundRobin(): LabTournament {
  const P = ['a1', 'b1', 'c1', 'me', 'd1', 'e1', 'f1', 'g1', 'h1', 'i1'];
  const seeds: Record<string, number> = Object.fromEntries(P.map((u, i) => [u, i + 1]));
  const RR: Round = { id: 'rr', label: 'Round Robin Schedule', round_type: 'winners', round_number: 1 };
  const matches: M[] = [];
  let k = 0;
  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) matches.push(match(RR, [P[i]], [P[j]], k++ < 30 ? [11, 4 + ((i + j) % 6)] : null, k));
  }
  return finish('rr-big', 'Round robin, 10 players, 30 of 45 played',
    { format: 'round_robin', matchType: 'singles', status: 'active' }, [RR], matches, seeds, [], null);
}

export function labTournaments(): LabTournament[] {
  seq = 0;
  return [
    poolPlay('drawn'), poolPlay('mid'), poolPlay('playoff'), poolPlay('done'),
    singleElim('mid'), singleElim('done'),
    doubleElim('mid'), doubleElim('done'),
    bigRoundRobin(),
  ];
}
