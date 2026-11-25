import { describe, expect, it } from 'vitest';
import { buildMlpPlayoffView, type MlpViewMatch } from '../mlpPlayoffView';

// The approved option A mock (Brian 2026-11-25): Saturday Smash MLP.
const names: Record<string, string> = { TSC: 'Third Shot Club', DD: 'Dink Dynasty', EE: 'Erne Express', KK: 'Kitchen Kings', LC: 'Lob City', PB: 'Paddle Battle' };
const teams = Object.keys(names).map(id => ({ id, name: names[id], male_1_id: `${id}1`, male_2_id: `${id}2`, female_1_id: `${id}3`, female_2_id: `${id}4` }));
const rows = [
  ['TSC', 'A', 1, 2, 0, 24, 6, 1], ['EE', 'A', 4, 1, 1, -6, 3, 4], ['DD', 'A', 5, 0, 2, -18, 2, 6],
  ['KK', 'B', 2, 2, 0, 12, 6, 3], ['LC', 'B', 3, 1, 1, 3, 5, 4], ['PB', 'B', 6, 0, 2, -15, 1, 6],
].map(([team_id, pool_letter, seed, w, l, d, gw, gl]) => ({ team_id: team_id as string, pool_letter: pool_letter as string, seed: seed as number,
  matchups_won: w as number, matchups_lost: l as number, point_diff: d as number, sub_matches_won: gw as number, sub_matches_lost: gl as number }));
let n = 0;
function meeting(rid: string, a: string, b: string, games: [number, number][], db?: [number, number]): MlpViewMatch[] {
  const slots = [[1, 2], [3, 4], [1, 3], [2, 4]];
  const out: MlpViewMatch[] = games.map(([s1, s2], k) => ({ id: `m${n++}`, round_id: rid, match_order: n, status: 'completed',
    winner_team: s1 > s2 ? 'team1' : 'team2', team1_player1: `${a}${slots[k][0]}`, team1_player2: `${a}${slots[k][1]}`,
    team2_player1: `${b}${slots[k][0]}`, team2_player2: `${b}${slots[k][1]}`, team1_score: s1, team2_score: s2 }));
  out.push({ id: `m${n++}`, round_id: rid, match_order: n, is_dreambreaker: true, status: db ? 'completed' : 'cancelled',
    winner_team: db ? (db[0] > db[1] ? 'team1' : 'team2') : null, team1_player1: `${a}1`, team1_player2: null, team2_player1: `${b}1`, team2_player2: null,
    team1_score: db?.[0] ?? null, team2_score: db?.[1] ?? null });
  return out;
}
const rounds = [
  { id: 'sf1', round_type: 'semifinals', round_number: 1001 }, { id: 'sf2', round_type: 'semifinals', round_number: 1001 },
  { id: 'fin', round_type: 'finals', round_number: 1002 }, { id: 'tp', round_type: 'third_place_match', round_number: 1002 },
];
const matches = [
  ...meeting('sf1', 'TSC', 'LC', [[11, 5], [11, 9], [8, 11], [11, 7]]),
  ...meeting('sf2', 'KK', 'EE', [[11, 6], [9, 11], [11, 8], [7, 11]], [21, 17]),
  ...meeting('fin', 'TSC', 'KK', [[11, 8], [9, 11], [11, 6], [7, 11]], [21, 19]),
  ...meeting('tp', 'EE', 'LC', [[11, 4], [11, 9], [6, 11], [11, 8]]),
];

describe('PKL-085 option A: the MLP playoff view', () => {
  it('reads like the approved mock', () => {
    const v = buildMlpPlayoffView({ rounds, matches, teams, rows })!;
    expect(v.champion).toEqual({ id: 'TSC', name: 'Third Shot Club', line: 'Won the Final 3-2 over Kitchen Kings' });
    expect(v.podium.map(p => [p.place, p.id])).toEqual([[1, 'TSC'], [2, 'KK'], [3, 'EE']]);
    expect(v.fourth?.id).toBe('LC');
    expect(v.final?.games.map(g => `${g.label} ${g.s1}-${g.s2}`)).toEqual(['M 11-8', 'W 9-11', 'X1 11-6', 'X2 7-11', 'DB 21-19']);
    expect([v.final?.aWins, v.final?.bWins, v.final?.winner]).toEqual([3, 2, 'a']);
    expect(v.third?.games.map(g => g.label)).toEqual(['M', 'W', 'X1', 'X2']);   // the cancelled Dreambreaker isn't a chip
    expect(v.earlier.map(g => [g.roundType, g.tiles.map(t => `${t.a.id} ${t.aWins}-${t.bWins} ${t.b.id}`)]))
      .toEqual([['semifinals', ['TSC 3-1 LC', 'KK 3-2 EE']]]);
    expect(v.rest).toEqual([
      { place: 5, id: 'PB', name: 'Paddle Battle', detail: 'Pool B 3rd, 0-2, -15' },
      { place: 6, id: 'DD', name: 'Dink Dynasty', detail: 'Pool A 3rd, 0-2, -18' },
    ]);
  });

  it('semifinals still going: no champion, no podium, the tiles show the live state', () => {
    const live = matches.filter(m => m.round_id.startsWith('sf')).map(m => (m.round_id === 'sf2' && m.is_dreambreaker
      ? { ...m, status: 'pending', winner_team: null, team1_score: null, team2_score: null } : m));
    const v = buildMlpPlayoffView({ rounds, matches: live, teams, rows })!;
    expect(v.champion).toBeNull();
    expect(v.podium).toEqual([]);
    const sf2 = v.earlier[0].tiles[1];
    expect([sf2.aWins, sf2.bWins, sf2.winner, sf2.games[4].label, sf2.games[4].winner]).toEqual([2, 2, null, 'DB', null]);
  });

  it('gender neutral: the games are D1-D4', () => {
    const v = buildMlpPlayoffView({ rounds, matches, teams, rows, genderNeutral: true })!;
    expect(v.final?.games.map(g => g.label)).toEqual(['D1', 'D2', 'D3', 'D4', 'DB']);
  });

  it('no playoff rounds yet: nothing to show', () => {
    expect(buildMlpPlayoffView({ rounds, matches: [], teams, rows })).toBeNull();
  });
});
