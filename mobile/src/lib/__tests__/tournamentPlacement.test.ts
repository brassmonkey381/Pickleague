import { describe, it, expect } from 'vitest';
import { computeFinalPlacement, placeLabel, type PlacementMatch } from '../tournamentPlacement';
import { explainTies, tieLine } from '../tournamentTieNotes';
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

describe('tie notes (PKL-040, rule PKL-052)', () => {
  const up = (k: string) => k.toUpperCase();
  it('2-way tie on W-L: point diff decides, never head-to-head', () => {
    const notes = explainTies([
      { key: 'a', wins: 4, losses: 2, pf: 60, pa: 48 }, { key: 'b', wins: 4, losses: 2, pf: 50, pa: 41 },
    ]);
    expect(notes.a.decidedBy).toBe('diff');
    expect(tieLine(notes.a, up)).toBe('Tied on 4-2 with B; ahead on point diff (+12 vs +9).');
    expect(tieLine(notes.b, up)).toBe('Tied on 4-2 with A; behind on point diff (+9 vs +12).');
  });
  it('level on W-L and point diff with no admin order: waiting', () => {
    const notes = explainTies([
      { key: 'a', wins: 4, losses: 2, pf: 20, pa: 11 }, { key: 'b', wins: 4, losses: 2, pf: 19, pa: 10 },
    ]);
    expect(notes.a.decidedBy).toBe('waiting');
    expect(tieLine(notes.a, up)).toBe('Tied on 4-2 and +9 with B: waiting for the admin to set the order.');
  });
  it('level with a full admin order: set by the admin', () => {
    const notes = explainTies([
      { key: 'a', wins: 4, losses: 2, pf: 20, pa: 11, tieRank: 1 }, { key: 'b', wins: 4, losses: 2, pf: 19, pa: 10, tieRank: 2 },
    ]);
    expect(notes.b.decidedBy).toBe('admin');
    expect(tieLine(notes.b, up)).toBe('Tied on 4-2 and +9 with A; order set by the admin.');
  });
  it('3-way: one split by point diff, two level and waiting', () => {
    const notes = explainTies([
      { key: 'a', wins: 1, losses: 1, pf: 30, pa: 20 },
      { key: 'b', wins: 1, losses: 1, pf: 25, pa: 25 },
      { key: 'c', wins: 1, losses: 1, pf: 20, pa: 20 },
    ]);
    expect(tieLine(notes.a, k => k)).toBe('Tied on 1-1 with b, c; ahead on point diff (+10 vs 0, 0).');
    expect(notes.b.decidedBy).toBe('waiting');
    expect(notes.b.levelWith).toEqual(['c']);
  });
  it('same wins but different losses is not a tie', () => {
    const notes = explainTies([
      { key: 'a', wins: 1, losses: 0 }, { key: 'c', wins: 1, losses: 1 },
    ]);
    expect(notes).toEqual({});
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
