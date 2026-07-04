import { describe, it, expect } from 'vitest';
import { predictFlow, predictTotalMatches } from '../tournamentFlow';

const labels = (stages: ReturnType<typeof predictFlow>) => (stages ?? []).map(s => s.label);
const counts = (stages: ReturnType<typeof predictFlow>) => (stages ?? []).map(s => s.matchCount);

describe('predictFlow — pool play', () => {
  // Mirrors the real "[SIM] pool_play singles 20260704180816": 9 players,
  // 3 pools, top_2_per_pool → 16 schedule rows (incl. 2 QF byes).
  it('9 players / 3 pools / top_2_per_pool → Pools A-C, QF(4, 2 byes), SF(2), F(1) = 16', () => {
    const stages = predictFlow({ format: 'pool_play', playoffFormat: 'top_2_per_pool', poolCount: 3, entrants: 9 })!;
    expect(labels(stages)).toEqual(['Pool A', 'Pool B', 'Pool C', 'Quarterfinals', 'Semifinals', 'Finals']);
    expect(counts(stages)).toEqual([3, 3, 3, 4, 2, 1]);
    expect(stages[3].byes).toBe(2); // 6 qualifiers padded to an 8 bracket
    expect(predictTotalMatches({ format: 'pool_play', playoffFormat: 'top_2_per_pool', poolCount: 3, entrants: 9 })).toBe(16);
  });

  it('8 players / 2 pools / top_2_per_pool → 4 qualifiers, straight to semis', () => {
    const stages = predictFlow({ format: 'pool_play', playoffFormat: 'top_2_per_pool', poolCount: 2, entrants: 8 })!;
    expect(labels(stages)).toEqual(['Pool A', 'Pool B', 'Semifinals', 'Finals']);
    expect(counts(stages)).toEqual([6, 6, 2, 1]);
  });

  it('uneven pools follow the snake sizes (7 players / 2 pools → snake puts the extra in Pool B)', () => {
    const stages = predictFlow({ format: 'pool_play', playoffFormat: 'none', poolCount: 2, entrants: 7 })!;
    expect(counts(stages)).toEqual([3, 6]); // rr(3), rr(4) — serpentine assignment
  });

  it('unsupported per-pool qualifier counts are unpredictable (3 pools × top_1 = 3)', () => {
    expect(predictFlow({ format: 'pool_play', playoffFormat: 'top_1_per_pool', poolCount: 3, entrants: 9 })).toBeNull();
  });
});

describe('predictFlow — round robin playoffs', () => {
  it('top_2 creates Finals AND the up-front Third Place Match (≥4 entrants)', () => {
    const stages = predictFlow({ format: 'round_robin', playoffFormat: 'top_2', entrants: 6 })!;
    expect(labels(stages)).toEqual(['Round Robin Schedule', 'Finals', 'Third Place Match']);
    expect(counts(stages)).toEqual([15, 1, 1]);
  });

  it('top_2 with only 3 entrants has no Third Place Match', () => {
    const stages = predictFlow({ format: 'round_robin', playoffFormat: 'top_2', entrants: 3 })!;
    expect(labels(stages)).toEqual(['Round Robin Schedule', 'Finals']);
  });

  it('top_4 + third place → Semifinals, Finals, Third Place Match', () => {
    const stages = predictFlow({ format: 'round_robin', playoffFormat: 'top_4', playoffThirdPlace: true, entrants: 8 })!;
    expect(labels(stages)).toEqual(['Round Robin Schedule', 'Semifinals', 'Finals', 'Third Place Match']);
    expect(counts(stages)).toEqual([28, 2, 1, 1]);
  });

  it('top_8 without third place → QF, SF, F', () => {
    const stages = predictFlow({ format: 'round_robin', playoffFormat: 'top_8', entrants: 10 })!;
    expect(labels(stages)).toEqual(['Round Robin Schedule', 'Quarterfinals', 'Semifinals', 'Finals']);
    expect(counts(stages)).toEqual([45, 4, 2, 1]);
  });

  it('playoff needing more entrants than exist is unpredictable', () => {
    expect(predictFlow({ format: 'round_robin', playoffFormat: 'top_8', entrants: 6 })).toBeNull();
  });
});

describe('predictFlow — single elimination', () => {
  it('8 entrants → 4/2/1 with DB round labels', () => {
    const stages = predictFlow({ format: 'single_elimination', entrants: 8 })!;
    expect(labels(stages)).toEqual(['Single Elim Schedule', 'Round 2', 'Finals']);
    expect(counts(stages)).toEqual([4, 2, 1]);
    expect(stages.map(s => s.byes)).toEqual([0, 0, 0]);
  });

  it('6 entrants pad to 8 with 2 first-round byes', () => {
    const stages = predictFlow({ format: 'single_elimination', entrants: 6 })!;
    expect(counts(stages)).toEqual([4, 2, 1]);
    expect(stages[0].byes).toBe(2);
  });

  it('16 entrants → 8/4/2/1', () => {
    const stages = predictFlow({ format: 'single_elimination', entrants: 16 })!;
    expect(labels(stages)).toEqual(['Single Elim Schedule', 'Round 2', 'Round 3', 'Finals']);
    expect(counts(stages)).toEqual([8, 4, 2, 1]);
  });
});

describe('predictFlow — dynamic formats decline to guess', () => {
  it.each(['double_elimination', 'mlp', 'mlp_random', 'rotating_partners'])('%s → null', (format) => {
    expect(predictFlow({ format, entrants: 8 })).toBeNull();
  });
});
