/**
 * PKL-090 golden samples: one small tournament per format, at set moments, built from plain data. The dev-only
 * Goldens screen renders the real Standings card and You card from them (phone-width screenshots for Brian to
 * approve), and once he approves, tests compare the app's output to the approved text (goldenText below).
 * Every example here matches docs/standings-rulebook.md.
 */
import type { StandingsInput } from '../../components/tournament/standingsData';
import type { WaitInput, WaitMatch } from '../waitReason';

export type GoldenMoment = {
  id: string;
  format: string;
  title: string;
  /** What happened so far, in words, for the reviewer. */
  story: string;
  standings: StandingsInput;
  wait: WaitInput | null;
};

type Round = { id: string; label: string | null; round_type: string; round_number: number };
let seq = 0;
const R = (id: string, type: string, num: number, label: string | null = null): Round => ({ id, label, round_type: type, round_number: num });
function M(round: Round, a: string[], b: string[], res?: [number, number], o: Partial<WaitMatch> = {}): WaitMatch & { match_type: string } {
  seq += 1;
  return {
    id: `gm${seq}`, round_id: round.id, round, match_order: seq, match_type: a.length > 1 ? 'doubles' : 'singles',
    team1_player1: a[0], team1_player2: a[1] ?? null, team2_player1: b[0], team2_player2: b[1] ?? null,
    status: res ? 'completed' : 'pending', winner_team: res ? (res[0] > res[1] ? 'team1' : 'team2') : null,
    team1_score: res?.[0] ?? null, team2_score: res?.[1] ?? null, ...o,
  };
}
const regs = (ids: string[]) => ids.map((u, i) => ({ id: `r${u}`, user_id: u, status: 'approved', seed: i + 1 })) as any[];
const base = (format: string, matchType: string, ids: string[], names: Record<string, string>, me: string,
  matches: any[], rounds: Round[], extra: Partial<StandingsInput> = {}): StandingsInput => ({
  tournament: { format: format === 'mlp-gn' ? 'mlp' : format, match_type: matchType, status: 'active', gender_neutral: format === 'mlp-gn' } as any,
  savedMatches: matches, savedRounds: rounds, registrations: regs(ids), profileNames: names, myUserId: me,
  mlpStandings: null, myMlpTeamId: null, finalRanks: [], ...extra,
});
const nameOfPlayers = (names: Record<string, string>) => (ps: string[]) => ps.map(p => names[p] ?? '?').join(' & ');
/** The same moment after the tournament closed: status completed and the stored final places (tournament_final_ranks). */
function closed(m: GoldenMoment, ranks: [string, number][]): GoldenMoment {
  return { ...m, standings: { ...m.standings, tournament: { ...m.standings.tournament, status: 'completed' } as any,
    finalRanks: ranks.map(([user_id, final_rank]) => ({ user_id, final_rank, wins: 0, losses: 0 })) as any }, wait: null };
}

// ── 1. Round robin, singles, 4 players (rulebook example A and B). Viewer: Ana. ──
function roundRobin(): GoldenMoment[] {
  const ids = ['ana', 'ben', 'cal', 'dee'];
  const names = { ana: 'Ana', ben: 'Ben', cal: 'Cal', dee: 'Dee' };
  const r = R('rr', 'winners', 1, 'Round Robin');
  const plan: [string, string, [number, number]][] = [
    ['ana', 'ben', [11, 7]], ['cal', 'dee', [11, 7]], ['ana', 'cal', [11, 9]],
    ['ana', 'dee', [4, 11]], ['ben', 'cal', [11, 3]], ['ben', 'dee', [11, 8]],
  ];
  const at = (k: number) => {
    seq = 100;
    const ms = plan.map(([a, b, res], i) => M(r, [a], [b], i < k ? res : undefined));
    return ms;
  };
  const mk = (id: string, title: string, story: string, k: number): GoldenMoment => {
    const ms = at(k);
    return { id, format: 'Round robin (singles)', title, story,
      standings: base('round_robin', 'singles', ids, names, 'ana', ms, [r]),
      wait: { format: 'round_robin', isMlp: false, hasPlayoff: false, me: ['ana'], matches: ms, nameOf: nameOfPlayers(names) } };
  };
  // Example A's last result (Cal beat Dee 11-6) is the 2nd match here, so the tie moment is after 2.
  return [
    mk('rr-0', 'Before any match', 'Nothing played yet.', 0),
    mk('rr-2', 'After 2 matches (tie flags)', 'Ana beat Ben 11-7. Cal beat Dee 11-7.', 2),
    mk('rr-4', 'Ana\'s matches are done', 'Also: Ana beat Cal 11-9, Dee beat Ana 11-4.', 4),
    mk('rr-6', 'All played', 'Also: Ben beat Cal 11-3, Ben beat Dee 11-8.', 6),
    closed(mk('rr-7', 'Tournament closed (no playoff)', 'All 6 played; the round robin is the final standings.', 6),
      [['ben', 1], ['ana', 2], ['dee', 3], ['cal', 4]]),
  ];
}

// ── 2. Pool play + top 2 per pool, singles, 2 pools of 3. Viewer: Ana (Pool A). ──
function pools(): GoldenMoment[] {
  const ids = ['ana', 'ben', 'cal', 'dee', 'eve', 'fay'];
  const names = { ana: 'Ana', ben: 'Ben', cal: 'Cal', dee: 'Dee', eve: 'Eve', fay: 'Fay' };
  const pa = R('pa', 'pool', 1, 'Pool A'), pb = R('pb', 'pool', 2, 'Pool B'), sf = R('sf', 'semifinals', 1000, 'Semifinals'), fin = R('fin', 'finals', 1001, 'Finals'), third = R('tp', 'third_place_match', 1001, 'Third Place Match');
  const build = (stage: number, noThird = false) => {
    seq = 200;
    const done = stage >= 1;
    const ms: any[] = [
      M(pa, ['ana'], ['ben'], [11, 6]), M(pa, ['ana'], ['cal'], [11, 8]), M(pa, ['ben'], ['cal'], done ? [11, 9] : undefined),
      M(pb, ['dee'], ['eve'], [11, 5]), M(pb, ['dee'], ['fay'], done ? [9, 11] : undefined, done ? {} : { called_at: '2026-11-25T18:00:00Z', court: '2' }),
      M(pb, ['eve'], ['fay'], done ? [11, 7] : undefined),
    ];
    const rounds = [pa, pb];
    if (stage >= 1) {   // A1 v B2, B1 v A2
      rounds.push(sf);
      // Pool B: Eve and Fay are both 1-1, -2; Eve is 2nd on seed. A1 v B2, B1 v A2.
      ms.push(M(sf, ['ana'], ['eve'], stage >= 2 ? [11, 4] : undefined),
        M(sf, ['dee'], ['ben'], stage >= 3 ? [9, 11] : undefined, stage === 2 ? { called_at: '2026-11-25T19:00:00Z', court: '1' } : {}));
    }
    if (stage >= 3) {
      if (noThird) { rounds.push(fin); ms.push(M(fin, ['ana'], ['ben'], [11, 8])); }
      else { rounds.push(fin, third); ms.push(M(fin, ['ana'], ['ben'], [11, 8]), M(third, ['eve'], ['dee'], [6, 11])); }
    }
    return { ms, rounds };
  };
  const mk = (id: string, title: string, story: string, stage: number, noThird = false): GoldenMoment => {
    const { ms, rounds } = build(stage, noThird);
    return { id, format: 'Pool play + playoff (singles)', title, story,
      standings: base('pool_play', 'singles', ids, names, 'ana', ms, rounds),
      wait: { format: 'pool_play', isMlp: false, hasPlayoff: true, me: ['ana'], matches: ms, nameOf: nameOfPlayers(names) } };
  };
  return [
    mk('pool-1', 'Ana done, pools still going', 'Pool A: Ana beat Ben 11-6 and Cal 11-8. Pool B: Dee beat Eve 11-5; Dee v Fay is on Court 2.', 0),
    mk('pool-2', 'Pools done, semifinals drawn', 'Ben beat Cal 11-9. Fay beat Dee 11-9, Eve beat Fay 11-7. Semifinals: Ana v Eve (A1 v B2), Dee v Ben (B1 v A2).', 1),
    mk('pool-3', 'Ana in the Final, waiting on the other semifinal', 'Ana beat Eve 11-4. Dee v Ben is on Court 1.', 2),
    mk('pool-4', 'Playoff finished', 'Ben beat Dee 11-9. Final: Ana beat Ben 11-8. 3rd-place match: Dee beat Eve 11-6.', 3),
    closed(mk('pool-5', 'Tournament closed', 'Same results as pool-4; the tournament has closed and stored its final places.', 3),
      [['ana', 1], ['ben', 2], ['dee', 3], ['eve', 4], ['fay', 5], ['cal', 6]]),
    // Brian 2026-11-25 ("shared 3rd"): no 3rd-place match, so both semifinal losers are 3rd and the next is 5th
    closed(mk('pool-6', 'Tournament closed, no 3rd-place match', 'Same pools and semifinals; Final: Ana beat Ben 11-8. No 3rd-place match: Dee and Eve share 3rd.', 3, true),
      [['ana', 1], ['ben', 2], ['dee', 3], ['eve', 3], ['fay', 5], ['cal', 6]]),
  ];
}

// ── 3. MLP, one pool of 3 teams + the R6 semifinal moment. Viewer: on Aces / on Third Shot Club. ──
function mlp(neutral: boolean): GoldenMoment[] {
  const teamsList = neutral ? ['Aces', 'Bolts', 'Comets'] : ['Aces', 'Bolts', 'Comets'];
  const members = (t: string) => [0, 1, 2, 3].map(k => `${t.toLowerCase()}${k}`);
  const names: Record<string, string> = {};
  for (const t of teamsList) members(t).forEach((p, k) => { names[p] = `${t[0]}${k + 1}`; });
  const slots: [number, number][] = [[0, 1], [2, 3], [0, 2], [1, 3]];
  const meeting = (r: Round, a: string, b: string, res: ([number, number] | undefined)[], db?: [number, number] | 'cancelled') => {
    const A = members(a), B = members(b);
    const games = slots.map(([x, y], i) => M(r, [A[x], A[y]], [B[x], B[y]], res[i]));
    const d = M(r, [A[0]], [B[0]], db && db !== 'cancelled' ? db : undefined, { is_dreambreaker: true, ...(db === 'cancelled' ? { status: 'cancelled' } : {}) });
    return [...games, d];
  };
  const rAB = R('ab', 'pool', 1, 'Pool A'), rAC = R('ac', 'pool', 2, 'Pool A'), rBC = R('bc', 'pool', 3, 'Pool A');
  const stages: { id: string; title: string; story: string; ms: () => any[] }[] = [
    { id: 'm-1', title: 'Aces lead Bolts 3-0, game 4 still to play', story: 'Aces won games 1-3 (11-6, 11-8, 11-9).',
      ms: () => meeting(rAB, 'Aces', 'Bolts', [[11, 6], [11, 8], [11, 9], undefined], 'cancelled') },
    { id: 'm-2', title: 'Aces v Comets at 2-2, Dreambreaker next', story: 'Bolts won game 4 (Aces 3-1). Aces v Comets: 11-4, 9-11, 11-7, 6-11.',
      ms: () => [...meeting(rAB, 'Aces', 'Bolts', [[11, 6], [11, 8], [11, 9], [5, 11]], 'cancelled'),
        ...meeting(rAC, 'Aces', 'Comets', [[11, 4], [9, 11], [11, 7], [6, 11]])] },
    { id: 'm-3', title: 'Pool finished', story: 'Comets won the Dreambreaker 21-18. Bolts beat Comets 3-1 (11-2, 11-5, 11-8, 9-11).',
      ms: () => [...meeting(rAB, 'Aces', 'Bolts', [[11, 6], [11, 8], [11, 9], [5, 11]], 'cancelled'),
        ...meeting(rAC, 'Aces', 'Comets', [[11, 4], [9, 11], [11, 7], [6, 11]], [18, 21]),
        ...meeting(rBC, 'Bolts', 'Comets', [[11, 2], [11, 5], [11, 8], [9, 11]], 'cancelled')] },
  ];
  const fmt = neutral ? 'MLP, gender neutral' : 'MLP';
  return stages.map(s => {
    seq = neutral ? 400 : 300;
    const ms = s.ms();
    const teams = teamsList.map((t, i) => { const p = members(t); return { id: t, name: t, seed: i + 1, male_1_id: p[0], male_2_id: p[1], female_1_id: p[2], female_2_id: p[3] }; });
    // the server's mlp_team_standings rows, as the rulebook computes them (section 4)
    const rows = mlpRows(teams, ms);
    return {
      id: `${neutral ? 'gn' : 'mlp'}-${s.id.slice(2)}`, format: fmt, title: s.title, story: s.story,
      standings: base(neutral ? 'mlp-gn' : 'mlp', 'doubles', [], names, 'aces0', ms, [rAB, rAC, rBC], {
        mlpStandings: rows, myMlpTeamId: 'Aces', mlpTeams: teams,
      }),
      wait: { format: 'mlp', isMlp: true, hasPlayoff: true, me: members('Aces'), matches: ms,
        nameOf: ps => teams.find(t => ps.some(p => [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].includes(p)))?.name ?? '?' },
    };
  });
}

/** mlp_team_standings as the rulebook (section 4) defines it: matchups at 3 game wins, games and ± over every game. */
function mlpRows(teams: { id: string; name: string; seed: number; male_1_id: string; male_2_id: string; female_1_id: string; female_2_id: string }[], ms: any[]) {
  const teamOf = (p: string) => teams.find(t => [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].includes(p))!.id;
  const row = new Map(teams.map(t => [t.id, { team_id: t.id, team_name: t.name, seed: t.seed, pool_letter: 'A',
    sub_matches_won: 0, sub_matches_lost: 0, matchups_won: 0, matchups_lost: 0, point_diff: 0 }]));
  const byRound = new Map<string, any[]>();
  for (const m of ms) { if (!byRound.has(m.round_id)) byRound.set(m.round_id, []); byRound.get(m.round_id)!.push(m); }
  for (const games of byRound.values()) {
    const A = row.get(teamOf(games[0].team1_player1))!, B = row.get(teamOf(games[0].team2_player1))!;
    let a = 0, b = 0;
    for (const g of games) {
      if (g.status !== 'completed') continue;
      if (g.winner_team === 'team1') { a++; A.sub_matches_won++; B.sub_matches_lost++; } else { b++; B.sub_matches_won++; A.sub_matches_lost++; }
      A.point_diff += g.team1_score - g.team2_score; B.point_diff += g.team2_score - g.team1_score;
    }
    const open = games.some(g => g.status === 'pending');
    const w = a >= 3 ? 'A' : b >= 3 ? 'B' : !open && a !== b ? (a > b ? 'A' : 'B') : null;
    if (w === 'A') { A.matchups_won++; B.matchups_lost++; } else if (w === 'B') { B.matchups_won++; A.matchups_lost++; }
  }
  return [...row.values()];
}

// ── 4. The R6 semifinal moment (Brian's PKL-091 screenshot): his team won its semifinal; the other is 2-2. ──
function r6Semis(): GoldenMoment {
  seq = 500;
  const T: Record<string, string[]> = {
    'Third Shot Club': ['t1', 't2', 't3', 't4'], 'Lob City': ['l1', 'l2', 'l3', 'l4'],
    'Kitchen Kings': ['k1', 'k2', 'k3', 'k4'], 'Erne Express': ['e1', 'e2', 'e3', 'e4'],
  };
  const sf1 = R('sf1', 'semifinals', 1001, 'Semifinals'), sf2 = R('sf2', 'semifinals', 1001, 'Semifinals');
  const slots: [number, number][] = [[0, 1], [2, 3], [0, 2], [1, 3]];
  const meet = (r: Round, a: string, b: string, res: ([number, number] | undefined)[], db: any, o: Partial<WaitMatch> = {}) =>
    [...slots.map(([x, y], i) => M(r, [T[a][x], T[a][y]], [T[b][x], T[b][y]], res[i])),
      M(r, [T[a][0]], [T[b][0]], undefined, { is_dreambreaker: true, ...(db === 'cancelled' ? { status: 'cancelled' } : o) })];
  const ms = [
    ...meet(sf1, 'Third Shot Club', 'Lob City', [[11, 7], [11, 9], [11, 6], undefined], 'cancelled'),
    ...meet(sf2, 'Kitchen Kings', 'Erne Express', [[11, 8], [7, 11], [11, 9], [10, 12]], 'pending', { called_at: '2026-11-25T03:00:00Z', court: '1' }),
  ];
  const teamName = (ps: string[]) => Object.keys(T).find(k => ps.some(p => T[k].includes(p))) ?? '?';
  return {
    id: 'mlp-semis', format: 'MLP playoff', title: 'Your team won its semifinal; the other is 2-2',
    story: 'Third Shot Club beat Lob City 3-0. Kitchen Kings v Erne Express is 2-2, Dreambreaker on Court 1.',
    standings: { ...base('mlp', 'doubles', [], {}, 't1', ms, [sf1, sf2]), mlpStandings: [] },
    wait: { format: 'mlp', isMlp: true, hasPlayoff: true, me: T['Third Shot Club'], matches: ms, nameOf: teamName },
  };
}

// ── 5. MLP finished, option A (Brian 2026-11-25): 6 teams, 2 pools, semis, Final, 3rd-place. Viewer on Third Shot Club. ──
function mlpFinished(third = true): GoldenMoment {
  seq = 600;
  const names = ['Third Shot Club', 'Kitchen Kings', 'Lob City', 'Erne Express', 'Dink Dynasty', 'Paddle Battle'];
  const ids = ['TSC', 'KK', 'LC', 'EE', 'DD', 'PB'];
  const pool: Record<string, string> = { TSC: 'A', EE: 'A', DD: 'A', KK: 'B', LC: 'B', PB: 'B' };
  const mem = (t: string) => [1, 2, 3, 4].map(k => `${t.toLowerCase()}${k}`);
  const teams = ids.map((id, i) => { const p = mem(id); return { id, name: names[i], seed: i + 1, male_1_id: p[0], male_2_id: p[1], female_1_id: p[2], female_2_id: p[3] }; });
  const slots: [number, number][] = [[0, 1], [2, 3], [0, 2], [1, 3]];
  const meet = (r: Round, a: string, b: string, g: [number, number][], db?: [number, number]) => {
    const A = mem(a), B = mem(b);
    return [...g.map((x, k) => M(r, [A[slots[k][0]], A[slots[k][1]]], [B[slots[k][0]], B[slots[k][1]]], x)),
      M(r, [A[0]], [B[0]], db, { is_dreambreaker: true, ...(db ? {} : { status: 'cancelled' }) })];
  };
  const rs: Round[] = [];
  const r = (id: string, type: string, n: number) => { const x = R(id, type, n, null); rs.push(x); return x; };
  const ms = [
    ...meet(r('p1', 'pool', 1), 'TSC', 'EE', [[11, 6], [11, 8], [9, 11], [11, 5]]),
    ...meet(r('p2', 'pool', 2), 'TSC', 'DD', [[11, 3], [11, 7], [11, 9], [8, 11]]),
    ...meet(r('p3', 'pool', 3), 'EE', 'DD', [[11, 9], [7, 11], [11, 6], [11, 8]]),
    ...meet(r('p4', 'pool', 4), 'KK', 'LC', [[11, 8], [9, 11], [11, 7], [6, 11]], [21, 18]),
    ...meet(r('p5', 'pool', 5), 'KK', 'PB', [[11, 4], [11, 9], [8, 11], [11, 6]]),
    ...meet(r('p6', 'pool', 6), 'LC', 'PB', [[11, 7], [11, 9], [9, 11], [11, 8]]),
    ...meet(r('sf1', 'semifinals', 1001), 'TSC', 'LC', [[11, 5], [11, 9], [8, 11], [11, 7]]),
    ...meet(r('sf2', 'semifinals', 1001), 'KK', 'EE', [[11, 6], [9, 11], [11, 8], [7, 11]], [21, 17]),
    ...meet(r('fin', 'finals', 1002), 'TSC', 'KK', [[11, 8], [9, 11], [11, 6], [7, 11]], [21, 19]),
    ...(third ? meet(r('tp', 'third_place_match', 1002), 'EE', 'LC', [[11, 4], [11, 9], [6, 11], [11, 8]]) : []),
  ];
  const poolMs = ms.filter(m => (m.round as Round).round_type === 'pool');
  const rows = mlpRows(teams, poolMs).map(x => ({ ...x, pool_letter: pool[x.team_id] }));
  return {
    id: third ? 'mlp-final' : 'mlp-final-shared3', format: 'MLP playoff', title: third ? 'Finished (option A)' : 'Finished, no 3rd-place match (shared 3rd)',
    story: third ? 'Pools, then semifinals TSC v LC and KK v EE, the Final TSC v KK 3-2 (Dreambreaker 21-19), and the 3rd-place match EE v LC 3-1.'
      : 'Same as mlp-final without the 3rd-place match (a 4-team MLP playoff never draws one): Lob City and Erne Express share 3rd.',
    standings: { ...base('mlp', 'doubles', [], {}, 'tsc1', poolMs, rs.filter(x => x.round_type === 'pool')), mlpStandings: rows, myMlpTeamId: 'TSC', mlpTeams: teams,
      // the playoff map reads every round and match
      savedRounds: rs, savedMatches: ms } as any,
    wait: null,
  };
}

export function goldenMoments(): GoldenMoment[] {
  return [...roundRobin(), ...pools(), ...mlp(false), ...mlp(true), r6Semis(), mlpFinished(), mlpFinished(false)];
}
