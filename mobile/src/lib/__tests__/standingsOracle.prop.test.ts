/**
 * PKL-090: generated tournaments, checked after EVERY match against the standings oracle (lib/standingsOracle.ts).
 *
 * Covers round robin, pool play, round robin + playoff, single elimination (singles and doubles), rotating partners
 * (best-of-N games), and MLP (pools, the Dreambreaker at 2-2, cancelled Dreambreakers, any-4 gender-neutral teams).
 * After every score: the app's tables (buildStandings) = the oracle's, plus invariants (total W = total L = games
 * counted, no tie flag on a row that hasn't played), and for MLP the Standings card and the Playoff block
 * (lib/mlpStandings) show the same order and W-L (PKL-089).
 *
 * A failure prints fast-check's seed and path. Replay it with:  FC_SEED=<seed> FC_PATH=<path> npx vitest run standingsOracle
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildStandings } from '../../components/tournament/standingsData';
import { matchResultsKey } from '../../components/tournament/tournamentModel';
import { mlpPoolGroups } from '../mlpStandings';
import { entrantKey } from '../tournamentTiebreakers';
import {
  oracleFixedTable, oracleMlpRows, oracleMlpTables, oraclePlayerTable,
  type OracleMatch, type OracleMeeting, type OracleMlpTeam,
} from '../standingsOracle';

const RUNS = { fixed: 500, player: 250, mlp: 400 };
const fcOpts = (numRuns: number) => ({
  numRuns,
  ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED), path: process.env.FC_PATH, endOnFailure: true } : {}),
});
let tournaments = 0;
let checks = 0;

// ── fixed entrants ───────────────────────────────────────────────────────────

type Fmt = 'round_robin' | 'pool_play' | 'rr_playoff' | 'single_elimination';
type Row = { id: string; round: { id: string; label: string | null; round_type: string; round_number: number }; match_type: string;
  status: string; winner_team: 'team1' | 'team2' | null; team1_player1: string | null; team1_player2: string | null;
  team2_player1: string | null; team2_player2: string | null; team1_score: number | null; team2_score: number | null;
  game_scores?: { t1: number; t2: number }[] | null };

const keyOf = (ps: string[]) => [...ps].sort().join('|');
const pairs = (xs: number[]) => xs.flatMap((a, i) => xs.slice(i + 1).map(b => [a, b] as [number, number]));

const fixedArb = fc.record({
  fmt: fc.constantFrom<Fmt>('round_robin', 'pool_play', 'rr_playoff', 'single_elimination'),
  doubles: fc.boolean(),
  n: fc.integer({ min: 2, max: 9 }),
  pools: fc.integer({ min: 2, max: 3 }),
  seed: fc.integer(),
});

/** A deterministic PRNG from the case's seed (mulberry32), so a failing case replays exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
function shuffle<T>(r: () => number, xs: T[]): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const score = (r: () => number): [number, number] => { const lose = Math.floor(r() * 10); return r() < 0.5 ? [11, lose] : [lose, 11]; };

function runFixed(c: { fmt: Fmt; doubles: boolean; n: number; pools: number; seed: number }) {
  const r = rng(c.seed);
  const n = c.fmt === 'single_elimination' ? pick(r, [2, 4, 8]) : c.fmt === 'pool_play' ? Math.max(c.n, c.pools * 2) : Math.max(2, c.n);
  const players = Array.from({ length: n }, (_, i) => (c.doubles ? [`p${i}a`, `p${i}b`] : [`p${i}`]));
  const keys = players.map(keyOf);
  const seedOfKey = new Map(keys.map((k, i) => [k, i + 1]));
  // Admin tie orders on about a third of entrants (server key: entrantKey of the pair).
  const tieRanks: Record<string, number> = {};
  const tieOfKey = new Map<string, number>();
  players.forEach((ps, i) => { if (r() < 0.33) { const v = Math.floor(r() * 5) + 1; tieRanks[entrantKey(ps[0], ps[1] ?? null)] = v; tieOfKey.set(keys[i], v); } });
  const registrations = players.flat().map(u => ({ user_id: u, status: 'approved', seed: seedOfKey.get(keys[players.findIndex(ps => ps.includes(u))])! })) as any[];
  const rounds: Row['round'][] = [];
  const rows: Row[] = [];
  let id = 0;
  const addMatch = (round: Row['round'], a: number, b: number) => rows.push({
    id: `m${id++}`, round, match_type: c.doubles ? 'doubles' : 'singles', status: 'pending', winner_team: null,
    team1_player1: players[a][0], team1_player2: players[a][1] ?? null, team2_player1: players[b][0], team2_player2: players[b][1] ?? null,
    team1_score: null, team2_score: null,
  });
  const idx = keys.map((_, i) => i);
  const poolOf = new Map<number, string>();
  if (c.fmt === 'pool_play') {
    for (let p = 0; p < c.pools; p++) {
      const members = idx.filter(i => i % c.pools === p);
      const round = { id: `pool${p}`, label: `Pool ${'ABC'[p]}`, round_type: 'pool', round_number: p + 1 };
      rounds.push(round); members.forEach(i => poolOf.set(i, round.id));
      for (const [a, b] of pairs(members)) addMatch(round, a, b);
    }
  } else if (c.fmt === 'round_robin' || c.fmt === 'rr_playoff') {
    const round = { id: 'rr', label: 'Round robin', round_type: 'winners', round_number: 1 };
    rounds.push(round);
    for (const [a, b] of pairs(idx)) addMatch(round, a, b);
  }
  const fmtName = c.fmt === 'rr_playoff' ? 'round_robin' : c.fmt;

  const play = (m: Row) => {
    if (c.fmt !== 'single_elimination' && r() < 0.08) { m.status = 'cancelled'; return; }   // a cancel: never counts
    const [s1, s2] = score(r);
    m.status = 'completed'; m.team1_score = s1; m.team2_score = s2; m.winner_team = s1 > s2 ? 'team1' : 'team2';
  };
  const toOracle = (m: Row): OracleMatch => ({
    id: m.id, side1: [keyOf([m.team1_player1!, m.team1_player2].filter(Boolean) as string[])],
    side2: [keyOf([m.team2_player1!, m.team2_player2].filter(Boolean) as string[])],
    status: m.status as OracleMatch['status'], winner: m.winner_team === 'team1' ? 1 : m.winner_team === 'team2' ? 2 : null,
    s1: m.team1_score, s2: m.team2_score,
  });
  const check = () => {
    const before = rows.length;
    const d = buildStandings({
      tournament: { format: fmtName, match_type: c.doubles ? 'doubles' : 'singles', status: 'active' } as any,
      savedMatches: rows as any, savedRounds: rounds, registrations, profileNames: {}, myUserId: null,
      mlpStandings: null, myMlpTeamId: null, finalRanks: [], tieRanks,
    });
    expect(rows.length).toBe(before);
    if (!d) return;
    // The oracle's tables: pool play = one per pool; two-stage = group rounds only; else every match.
    const groupRows = c.fmt === 'rr_playoff' ? rows.filter(m => m.round.round_type === 'winners') : rows;
    const want = c.fmt === 'pool_play'
      ? rounds.filter(x => x.round_type === 'pool').map(x => rows.filter(m => m.round.id === x.id))
      : [groupRows];
    expect(d.tables.length).toBe(want.length);
    d.tables.forEach((t, ti) => {
      const o = oracleFixedTable(want[ti].map(toOracle), k => seedOfKey.get(k)!, k => tieOfKey.get(k) ?? null);
      expect(t.rows.map(x => [x.key, x.wins, x.losses, x.pf, x.pa])).toEqual(o.map(x => [x.key, x.wins, x.losses, x.pf, x.pa]));
      const done = want[ti].filter(m => m.status === 'completed').length;
      expect(t.rows.reduce((s, x) => s + x.wins, 0)).toBe(done);
      expect(t.rows.reduce((s, x) => s + x.losses, 0)).toBe(done);
      for (const k of Object.keys(t.ties ?? {})) {
        const x = t.rows.find(y => y.key === k)!;
        expect(x.wins + x.losses + (x.pf ?? 0) + (x.pa ?? 0)).toBeGreaterThan(0);   // PKL-089: no tie flag before play
      }
      checks++;
    });
  };

  if (c.fmt === 'single_elimination') {
    let alive = shuffle(r, idx), rn = 1;
    while (alive.length > 1) {
      const round = { id: `elim${rn}`, label: `Round ${rn}`, round_type: alive.length === 2 ? 'finals' : 'winners', round_number: rn };
      rounds.push(round);
      const ms: Row[] = [];
      for (let i = 0; i < alive.length; i += 2) { addMatch(round, alive[i], alive[i + 1]); ms.push(rows[rows.length - 1]); }
      check();
      const next: number[] = [];
      for (const m of shuffle(r, ms)) { play(m); check(); }
      for (const m of ms) next.push(keys.indexOf(m.winner_team === 'team1' ? keyOf([m.team1_player1!, m.team1_player2].filter(Boolean) as string[]) : keyOf([m.team2_player1!, m.team2_player2].filter(Boolean) as string[])));
      alive = next; rn++;
    }
  } else {
    check();
    for (const m of shuffle(r, rows)) { play(m); check(); }
    if (c.fmt === 'rr_playoff' && n >= 2) {
      // the playoff arrives: its matches never move the round robin table
      const semis = { id: 'sf', label: 'Semifinals', round_type: 'semifinals', round_number: 1000 };
      rounds.push(semis);
      addMatch(semis, 0, n - 1); check();
      play(rows[rows.length - 1]); check();
    }
  }
  tournaments++;
}

// ── rotating partners ────────────────────────────────────────────────────────

function runPlayers(c: { n: number; matches: number; seed: number }) {
  const r = rng(c.seed);
  const players = Array.from({ length: c.n }, (_, i) => `u${i}`);
  const seedOf = new Map(players.map((p, i) => [p, i + 1]));
  const tieRanks: Record<string, number> = {};
  for (const p of players) if (r() < 0.3) tieRanks[entrantKey(p)] = Math.floor(r() * 4) + 1;
  const rows: Row[] = [];
  const round = { id: 'rp', label: 'Round 1', round_type: 'winners', round_number: 1 };
  for (let i = 0; i < c.matches; i++) {
    const [a, b, x, y] = shuffle(r, players);
    rows.push({ id: `m${i}`, round, match_type: 'doubles', status: 'pending', winner_team: null,
      team1_player1: a, team1_player2: b, team2_player1: x, team2_player2: y, team1_score: null, team2_score: null });
  }
  const check = () => {
    const d = buildStandings({
      tournament: { format: 'rotating_partners', match_type: 'doubles', status: 'active' } as any,
      savedMatches: rows as any, savedRounds: [round],
      registrations: players.map(p => ({ user_id: p, status: 'approved', seed: seedOf.get(p) })) as any,
      profileNames: {}, myUserId: null, mlpStandings: null, myMlpTeamId: null, finalRanks: [], tieRanks,
    })!;
    const o = oraclePlayerTable(players, rows.map(m => ({
      id: m.id, side1: [m.team1_player1!, m.team1_player2!], side2: [m.team2_player1!, m.team2_player2!],
      status: m.status as any, winner: m.winner_team === 'team1' ? 1 : m.winner_team === 'team2' ? 2 : null,
      s1: m.team1_score, s2: m.team2_score, games: m.game_scores?.map(g => [g.t1, g.t2] as [number, number]) ?? null,
    })), p => seedOf.get(p)!, p => tieRanks[entrantKey(p)] ?? null);
    expect(d.tables[0].rows.map(x => [x.key, x.wins, x.losses, x.pf, x.pa])).toEqual(o.map(x => [x.key, x.wins, x.losses, x.pf, x.pa]));
    // each match adds 2 players' worth of wins and losses per game won
    const w = d.tables[0].rows.reduce((s, x) => s + x.wins, 0), l = d.tables[0].rows.reduce((s, x) => s + x.losses, 0);
    expect(w).toBe(l);
    checks++;
  };
  check();
  for (const m of shuffle(r, rows)) {
    if (r() < 0.4) {   // best of 3
      const g: { t1: number; t2: number }[] = [];
      let a = 0, b = 0;
      while (a < 2 && b < 2) { const [x, y] = score(r); g.push({ t1: x, t2: y }); if (x > y) a++; else b++; }
      m.game_scores = g; m.team1_score = g.reduce((s, x) => s + x.t1, 0); m.team2_score = g.reduce((s, x) => s + x.t2, 0);
      m.winner_team = a > b ? 'team1' : 'team2';
    } else {
      const [x, y] = score(r); m.team1_score = x; m.team2_score = y; m.winner_team = x > y ? 'team1' : 'team2';
    }
    m.status = 'completed';
    check();
  }
  tournaments++;
}

// ── MLP ──────────────────────────────────────────────────────────────────────

function runMlp(c: { teams: number; pools: number; neutral: boolean; seed: number }) {
  const r = rng(c.seed);
  const pools = Math.min(c.pools, Math.floor(c.teams / 2));
  const teams = Array.from({ length: c.teams }, (_, i) => ({
    id: `T${i}`, seed: i + 1, pool: pools > 1 ? 'AB'[i % pools] : '',
    // PKL-088: gender-neutral teams are any 4 players; standings never look at who fills which slot.
    members: Array.from({ length: 4 }, (_, k) => `T${i}${c.neutral ? 'x' : k < 2 ? 'm' : 'f'}${k}`),
  }));
  const tieRanks: Record<string, number> = {};
  const teamTie = new Map<string, number | null>();
  for (const t of teams) {
    const v = r() < 0.3 ? Math.floor(r() * 4) + 1 : null;
    if (v != null) tieRanks[entrantKey(t.members[Math.floor(r() * 4)])] = v;
    teamTie.set(t.id, v);
  }
  // meetings: every pair in the same pool; 4 games then a Dreambreaker
  type G = Row & { is_dreambreaker?: boolean; meeting: number };
  const rows: G[] = [];
  const meetings: { a: typeof teams[number]; b: typeof teams[number]; games: G[] }[] = [];
  let id = 0;
  teams.forEach((A, i) => teams.slice(i + 1).forEach(B => {
    if (A.pool !== B.pool) return;
    const round = { id: `R${meetings.length}`, label: `${A.id} v ${B.id}`, round_type: pools > 1 ? 'pool' : 'winners', round_number: meetings.length + 1 };
    const slots: [number, number][] = [[0, 1], [2, 3], [0, 2], [1, 3]];
    const games: G[] = slots.map(([x, y]) => ({ id: `g${id++}`, round, match_type: 'doubles', status: 'pending', winner_team: null,
      team1_player1: A.members[x], team1_player2: A.members[y], team2_player1: B.members[x], team2_player2: B.members[y],
      team1_score: null, team2_score: null, meeting: meetings.length }));
    games.push({ id: `g${id++}`, round, match_type: 'doubles', status: 'pending', winner_team: null, is_dreambreaker: true,
      team1_player1: A.members[0], team1_player2: null, team2_player1: B.members[0], team2_player2: null,
      team1_score: null, team2_score: null, meeting: meetings.length });
    meetings.push({ a: A, b: B, games }); rows.push(...games);
  }));
  const oTeams: OracleMlpTeam[] = teams.map(t => ({ id: t.id, pool: t.pool, seed: t.seed, tieRank: teamTie.get(t.id) ?? null }));
  const mlpTeams = teams.map(t => ({ id: t.id, male_1_id: t.members[0], male_2_id: t.members[1], female_1_id: t.members[2], female_2_id: t.members[3] }));

  const check = (prevKey: string | null) => {
    const om: OracleMeeting[] = meetings.map(m => ({ a: m.a.id, b: m.b.id, games: m.games.map(g => ({
      status: g.status as any, winner: g.winner_team === 'team1' ? 1 : g.winner_team === 'team2' ? 2 : null, s1: g.team1_score, s2: g.team2_score })) }));
    const oRows = oracleMlpRows(oTeams, om);
    // what the server's mlp_team_standings returns, modelled by the oracle
    const rpc = oRows.map(x => ({ team_id: x.team_id, team_name: x.team_id, seed: x.seed, pool_letter: x.pool || null,
      sub_matches_won: x.games_won, sub_matches_lost: x.games_lost, matchups_won: x.matchups_won, matchups_lost: x.matchups_lost, point_diff: x.point_diff }));
    const d = buildStandings({
      tournament: { format: 'mlp', match_type: 'doubles', status: 'active' } as any,
      savedMatches: rows as any, savedRounds: [], registrations: [], profileNames: {}, myUserId: null,
      mlpStandings: rpc, myMlpTeamId: null, mlpTeams, finalRanks: [], tieRanks,
    })!;
    const want = oracleMlpTables(oRows);
    // the Standings card
    expect(d.tables.map(t => t.rows.map(x => [x.key, x.wins, x.losses, (x.pf ?? 0) - (x.pa ?? 0)])))
      .toEqual(want.map(t => t.rows.map(x => [x.team_id, x.matchups_won, x.matchups_lost, x.point_diff])));
    expect(d.tables.map(t => t.label)).toEqual(want.map(t => (t.pool ? `Pool ${t.pool}` : null)));
    // the Playoff block (MlpPlayoffPreview orders with mlpPoolGroups + the team's tie rank): same order, same W-L
    const block = mlpPoolGroups(rpc.map(x => ({ ...x, tieRank: teamTie.get(x.team_id) ?? null })));
    expect(block.map(g => g.rows.map(x => [x.team_id, x.matchups_won, x.matchups_lost])))
      .toEqual(d.tables.map(t => t.rows.map(x => [x.key, x.wins, x.losses])));
    // invariants
    const mw = oRows.reduce((s, x) => s + x.matchups_won, 0), ml = oRows.reduce((s, x) => s + x.matchups_lost, 0);
    expect(mw).toBe(ml);
    for (const t of d.tables) for (const k of Object.keys(t.ties ?? {})) {
      const x = t.rows.find(y => y.key === k)!;
      expect(x.wins + x.losses + (x.pf ?? 0) + (x.pa ?? 0)).toBeGreaterThan(0);
    }
    // PKL-089: every score changes the re-fetch key (the old trigger, the row count, never changed)
    const key = matchResultsKey(rows);
    if (prevKey != null) expect(key).not.toBe(prevKey);
    checks++;
    return key;
  };

  let key = check(null);
  // play games in a random interleaving across meetings; the Dreambreaker only at 2-2, cancelled once a team has 3
  const queue = shuffle(r, meetings.flatMap(m => m.games.slice(0, 4)));
  for (const g of queue) {
    const m = meetings[g.meeting];
    const [s1, s2] = score(r);
    g.status = 'completed'; g.team1_score = s1; g.team2_score = s2; g.winner_team = s1 > s2 ? 'team1' : 'team2';
    const done = m.games.slice(0, 4).filter(x => x.status === 'completed');
    const a = done.filter(x => x.winner_team === 'team1').length, b = done.length - a;
    const db = m.games[4];
    if ((a >= 3 || b >= 3) && db.status === 'pending') db.status = 'cancelled';
    key = check(key);
    if (done.length === 4 && a === 2 && db.status === 'pending') {
      const w = Math.floor(r() * 8);
      const t1 = r() < 0.5;
      db.status = 'completed'; db.team1_score = t1 ? 21 : 13 + w; db.team2_score = t1 ? 13 + w : 21; db.winner_team = t1 ? 'team1' : 'team2';
      key = check(key);
    }
  }
  tournaments++;
}

describe('PKL-090 standings oracle: generated tournaments, checked after every match', () => {
  it('fixed entrants: round robin, pool play, round robin + playoff, single elimination (singles and doubles)', () => {
    fc.assert(fc.property(fixedArb, c => { runFixed(c); }), fcOpts(RUNS.fixed));
  });
  it('rotating partners: per-player records, best-of-3 games counted', () => {
    fc.assert(fc.property(fc.record({ n: fc.integer({ min: 4, max: 10 }), matches: fc.integer({ min: 1, max: 14 }), seed: fc.integer() }),
      c => { runPlayers(c); }), fcOpts(RUNS.player));
  });
  it('MLP: pools, the Dreambreaker at 2-2, decided at 3 game wins, gender-neutral teams; card = Playoff block', () => {
    fc.assert(fc.property(fc.record({ teams: fc.integer({ min: 2, max: 8 }), pools: fc.integer({ min: 1, max: 2 }), neutral: fc.boolean(), seed: fc.integer() }),
      c => { runMlp(c); }), fcOpts(RUNS.mlp));
  });
  it('ran at least 1000 tournaments', () => {
    expect(tournaments).toBeGreaterThanOrEqual(1000);
    console.log(`[PKL-090] ${tournaments} tournaments, ${checks} standings checks`);
  });
});
