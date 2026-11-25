// PKL-089: the MLP Standings card showed every team 0-0 while the Playoff block showed the real matchup W-L.
// Cause: the card re-fetched mlp_team_standings only when the match ROW COUNT changed, and a score adds no rows.
import { describe, expect, it } from 'vitest';
import { buildStandings } from '../standingsData';
import { matchResultsKey } from '../tournamentModel';

const team = (id: string, pool: string | null, w = 0, l = 0, seed = 1) => ({
  team_id: id, team_name: id, seed, pool_letter: pool, sub_matches_won: 0, sub_matches_lost: 0, matchups_won: w, matchups_lost: l,
});
const slots = (id: string) => ({ id, male_1_id: `${id}1`, male_2_id: `${id}2`, female_1_id: `${id}3`, female_2_id: `${id}4` });
const game = (id: string, a: string, b: string, s1: number | null, s2: number | null) => ({
  id, round_id: 'r1', match_order: 1, status: s1 == null ? 'pending' : 'completed',
  team1_player1: `${a}1`, team1_player2: `${a}2`, team2_player1: `${b}1`, team2_player2: `${b}2`,
  team1_score: s1, team2_score: s2, winner_team: s1 == null ? null : s1 > (s2 ?? 0) ? 'team1' : 'team2',
}) as any;
const input = (rows: any[], matches: any[] = []) => ({
  tournament: { format: 'mlp', match_type: 'doubles', status: 'active' } as any,
  savedMatches: matches, savedRounds: [], registrations: [], profileNames: {}, myUserId: null,
  mlpStandings: rows, myMlpTeamId: null, mlpTeams: ['TSC', 'DD', 'EE', 'KK', 'LC', 'PB'].map(slots),
  finalRanks: [],
});

describe('PKL-089 MLP standings card', () => {
  it('the re-fetch key changes when a score lands, not only when rows are added', () => {
    const before = [game('g1', 'TSC', 'DD', null, null), game('g2', 'TSC', 'DD', null, null)];
    const after = [game('g1', 'TSC', 'DD', 11, 4), game('g2', 'TSC', 'DD', null, null)];
    expect(after.length).toBe(before.length);                 // the old trigger (row count) saw no change
    expect(matchResultsKey(after)).not.toBe(matchResultsKey(before));
    expect(matchResultsKey([...before].reverse())).toBe(matchResultsKey(before)); // order doesn't matter
  });

  it('shows the matchup W-L the server sends (1-0 after a decided matchup)', () => {
    const d = buildStandings(input([team('TSC', 'A', 1, 0, 1), team('DD', 'A', 0, 1, 2), team('EE', 'A', 0, 0, 3)],
      [game('g1', 'TSC', 'DD', 11, 2)]))!;
    const tsc = d.tables.flatMap(t => t.rows).find(r => r.key === 'TSC')!;
    expect([tsc.wins, tsc.losses]).toEqual([1, 0]);
  });

  it('groups by pool: one table per pool, labelled, team names without ", Pool X"', () => {
    const d = buildStandings(input([
      team('TSC', 'A', 1, 0, 1), team('DD', 'A', 0, 1, 2), team('EE', 'A', 0, 0, 3),
      team('KK', 'B', 0, 0, 4), team('LC', 'B', 0, 0, 5), team('PB', 'B', 0, 0, 6),
    ], [game('g1', 'TSC', 'DD', 11, 2)]))!;
    expect(d.tables.map(t => t.label)).toEqual(['Pool A', 'Pool B']);
    expect(d.tables[0].rows.map(r => r.key)).toEqual(['TSC', 'EE', 'DD']);
    expect(d.tables[1].rows.map(r => r.name)).toEqual(['KK', 'LC', 'PB']);
  });

  it('no "admin to order" for teams that have not played', () => {
    const d = buildStandings(input([
      team('TSC', 'A', 1, 0, 1), team('DD', 'A', 0, 1, 2), team('EE', 'A', 0, 0, 3),
      team('KK', 'B', 0, 0, 4), team('LC', 'B', 0, 0, 5), team('PB', 'B', 0, 0, 6),
    ], [game('g1', 'TSC', 'DD', 11, 2)]))!;
    const poolB = d.tables[1];
    expect(Object.keys(poolB.ties ?? {})).toEqual([]);
    expect(poolB.groups ?? []).toEqual([]);
    expect(d.waitingCount).toBe(0);
  });

  it('a real tie after play is still flagged', () => {
    const d = buildStandings(input([team('KK', 'B', 1, 0, 4), team('LC', 'B', 1, 0, 5)],
      [game('g1', 'KK', 'PB', 11, 5), game('g2', 'LC', 'PB', 11, 5)]))!;
    expect(Object.keys(d.tables[0].ties ?? {}).sort()).toEqual(['KK', 'LC']);
    expect(d.waitingCount).toBe(1);
  });
});
