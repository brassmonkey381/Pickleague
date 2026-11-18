import { describe, it, expect } from 'vitest';
import { computeFinalPlacement, placeLabel, type PlacementMatch } from '../tournamentPlacement';
import { explainTeamTies, explainPlayerTies, tieLine, meetingsOf, type TieMatch } from '../tournamentTieNotes';
import { tournamentSignature } from '../tournamentSignature';

const pm = (
  round_type: string, round_number: number, a: string, b: string, winner: 'team1' | 'team2' | null,
): PlacementMatch => ({
  round_type, round_number,
  team1_player1: a, team1_player2: null, team2_player1: b, team2_player2: null,
  winner_team: winner, status: winner ? 'completed' : 'pending',
});
const rr8 = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
const flat = (rows: ReturnType<typeof computeFinalPlacement>) => rows.map(r => `${r.key}:${placeLabel(r)}:${r.source}`);

describe('computeFinalPlacement (PKL-037, Brian 2026-11-18)', () => {
  it('Final 1-2, 3rd place match 3-4, round robin 5-8 (the B1 case)', () => {
    // p4 wins the 3PM over p3: p4 is 3rd, p3 4th, whatever their RR wins.
    const rows = computeFinalPlacement(rr8, [pm('finals', 1000, 'p1', 'p2', 'team2'), pm('third_place_match', 1100, 'p3', 'p4', 'team2')]);
    expect(flat(rows)).toEqual([
      'p2:1:final', 'p1:2:final', 'p4:3:third_place', 'p3:4:third_place',
      'p5:5:group', 'p6:6:group', 'p7:7:group', 'p8:8:group',
    ]);
    expect(rows.every(r => r.decided)).toBe(true);
  });
  it('either medal match can finish first', () => {
    const thirdOnly = computeFinalPlacement(rr8, [pm('finals', 1000, 'p1', 'p2', null), pm('third_place_match', 1100, 'p3', 'p4', 'team1')]);
    expect(flat(thirdOnly).slice(0, 4)).toEqual(['p1:1-2:final', 'p2:1-2:final', 'p3:3:third_place', 'p4:4:third_place']);
    const finalOnly = computeFinalPlacement(rr8, [pm('finals', 1000, 'p1', 'p2', 'team1'), pm('third_place_match', 1100, 'p3', 'p4', null)]);
    expect(flat(finalOnly).slice(0, 4)).toEqual(['p1:1:final', 'p2:2:final', 'p3:3-4:third_place', 'p4:3-4:third_place']);
  });
  it('Final only: 3-N from the round robin', () => {
    const rows = computeFinalPlacement(['p1', 'p2', 'p3'], [pm('finals', 1000, 'p1', 'p2', 'team2')]);
    expect(flat(rows)).toEqual(['p2:1:final', 'p1:2:final', 'p3:3:group']);
  });
  it('top 4 without a 3rd place match: semifinal losers 3-4 by RR order', () => {
    const rows = computeFinalPlacement(rr8, [
      pm('semifinals', 900, 'p1', 'p4', 'team2'), pm('semifinals', 900, 'p2', 'p3', 'team1'),
      pm('finals', 1000, 'p4', 'p2', 'team1'),
    ]);
    expect(flat(rows).slice(0, 5)).toEqual(['p4:1:final', 'p2:2:final', 'p1:3:playoff', 'p3:4:playoff', 'p5:5:group']);
  });
  it('doubles keys: pairs are placed as one entrant', () => {
    const d = (rt: string, a: [string, string], b: [string, string], w: 'team1' | 'team2'): PlacementMatch => ({
      round_type: rt, round_number: 1000,
      team1_player1: a[0], team1_player2: a[1], team2_player1: b[0], team2_player2: b[1],
      winner_team: w, status: 'completed',
    });
    const rows = computeFinalPlacement(['a|b', 'c|d', 'e|f'], [d('finals', ['b', 'a'], ['c', 'd'], 'team2')]);
    expect(flat(rows)).toEqual(['c|d:1:final', 'a|b:2:final', 'e|f:3:group']);
  });
});

const tm = (a: string, b: string, winner: 'team1' | 'team2', s1: number, s2: number): TieMatch => ({
  team1_player1: a, team1_player2: null, team2_player1: b, team2_player2: null,
  winner_team: winner, status: 'completed', team1_score: s1, team2_score: s2,
});

describe('tie notes (PKL-040)', () => {
  it('2-way tie: H2H decides, the line shows the result and the diff', () => {
    const matches = [tm('a', 'b', 'team1', 11, 8)];
    const notes = explainTeamTies([
      { key: 'a', wins: 2, pf: 30, pa: 25 }, { key: 'b', wins: 2, pf: 40, pa: 20 },
    ], matches);
    expect(notes.a.decidedBy).toBe('h2h');
    expect(tieLine(notes.a, k => k.toUpperCase())).toBe('Tied on 2 wins with B. H2H: won 11-8. Diff +5. Decided by head-to-head.');
    expect(tieLine(notes.b, k => k.toUpperCase())).toBe('Tied on 2 wins with A. H2H: lost 8-11. Diff +20. Decided by head-to-head.');
  });
  it('2-way tie with no meeting: point diff, then seed', () => {
    const byDiff = explainTeamTies([{ key: 'a', wins: 1, pf: 20, pa: 10 }, { key: 'b', wins: 1, pf: 15, pa: 10 }], []);
    expect(byDiff.a.decidedBy).toBe('diff');
    expect(tieLine(byDiff.b, k => k)).toBe('Tied on 1 win with a. H2H: not played. Diff +5. Decided by point diff.');
    const bySeed = explainTeamTies([{ key: 'a', wins: 1, pf: 10, pa: 10, seed: 1 }, { key: 'b', wins: 1, pf: 10, pa: 10, seed: 2 }], []);
    expect(bySeed.a.decidedBy).toBe('seed');
  });
  it('3-way tie: H2H is shown but skipped, point diff decides', () => {
    const matches = [tm('a', 'b', 'team1', 11, 9), tm('b', 'c', 'team1', 11, 9), tm('c', 'a', 'team1', 11, 9)];
    const notes = explainTeamTies([
      { key: 'a', wins: 1, pf: 30, pa: 20 }, { key: 'b', wins: 1, pf: 25, pa: 20 }, { key: 'c', wins: 1, pf: 20, pa: 20 },
    ], matches);
    expect(notes.a.decidedBy).toBe('diff');
    expect(tieLine(notes.a, k => k)).toBe(
      'Tied on 1 win with b, c. H2H: won 11-9 vs b; lost 9-11 vs c (not used in a 3+ way tie). Diff +10. Decided by point diff.');
  });
  it('per player: records as opponents only, never as partners', () => {
    const m: TieMatch = {
      team1_player1: 'a', team1_player2: 'b', team2_player1: 'c', team2_player2: 'd',
      winner_team: 'team1', status: 'completed', team1_score: 11, team2_score: 4,
    };
    expect(meetingsOf([m], 'a', 'b', 'player')).toMatchObject({ won: 0, lost: 0 });
    expect(meetingsOf([m], 'a', 'c', 'player')).toMatchObject({ won: 1, lost: 0, scores: ['won 11-4'] });
    const notes = explainPlayerTies([
      { key: 'a', wins: 1, losses: 0 }, { key: 'c', wins: 1, losses: 1 },
    ], [m]);
    expect(notes.a.decidedBy).toBe('losses');
  });
});

describe('tournamentSignature (PKL-038)', () => {
  const base = { id: 'm1', status: 'pending', winner_team: null, team1_score: null, team2_score: null, team1_player1: 'a', team2_player1: 'b' };
  it('moves on a score, a new round (the playoff draw) or a status change; ignores row order', () => {
    const s0 = tournamentSignature([base, { ...base, id: 'm0' }], ['r1'], 'active');
    expect(tournamentSignature([{ ...base, id: 'm0' }, base], ['r1'], 'active')).toBe(s0);
    expect(tournamentSignature([{ ...base, status: 'completed', winner_team: 'team1', team1_score: 11, team2_score: 5 }, { ...base, id: 'm0' }], ['r1'], 'active')).not.toBe(s0);
    expect(tournamentSignature([base, { ...base, id: 'm0' }], ['r1', 'r2'], 'active')).not.toBe(s0);
    expect(tournamentSignature([base, { ...base, id: 'm0' }], ['r1'], 'completed')).not.toBe(s0);
  });
});
