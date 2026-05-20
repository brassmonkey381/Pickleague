import { describe, it, expect } from 'vitest';
import {
  poolSizes,
  expectedPoolPlayMatchCount,
  expectedRoundRobinMatchCount,
  expectedRoundRobinRoundCount,
  nextPow2,
  expectedSingleElimRound1MatchCount,
} from '../bracketVerificationHelpers';

describe('poolSizes (mirrors assignPools snake-draft)', () => {
  it('12 players / 3 pools → 4,4,4', () => {
    expect(poolSizes(12, 3)).toEqual([4, 4, 4]);
  });

  it('10 players / 3 pools → 3,3,4 (snake puts extras in last pools)', () => {
    expect(poolSizes(10, 3)).toEqual([3, 3, 4]);
  });

  it('8 players / 2 pools → 4,4', () => {
    expect(poolSizes(8, 2)).toEqual([4, 4]);
  });

  it('16 players / 4 pools → 4,4,4,4', () => {
    expect(poolSizes(16, 4)).toEqual([4, 4, 4, 4]);
  });

  it('11 players / 4 pools → 3,3,3,2 (snake makes one pool smaller)', () => {
    const sizes = poolSizes(11, 4);
    expect(sizes.reduce((a, b) => a + b)).toBe(11);
    expect(sizes.length).toBe(4);
  });
});

describe('expectedPoolPlayMatchCount', () => {
  it('12 players / 3 pools → 18 matches (6 per pool × 3 pools)', () => {
    expect(expectedPoolPlayMatchCount(12, 3)).toBe(18);
  });

  it('8 players / 2 pools → 12 matches (6 per pool × 2 pools)', () => {
    expect(expectedPoolPlayMatchCount(8, 2)).toBe(12);
  });

  it('10 players / 3 pools → 12 matches (3+3+6 from sizes 3,3,4)', () => {
    expect(expectedPoolPlayMatchCount(10, 3)).toBe(12);
  });
});

describe('expectedRoundRobinMatchCount + RoundCount', () => {
  it('N=8 → 28 matches, 7 rounds', () => {
    expect(expectedRoundRobinMatchCount(8)).toBe(28);
    expect(expectedRoundRobinRoundCount(8)).toBe(7);
  });

  it('N=5 (odd) → 10 matches, 5 rounds', () => {
    expect(expectedRoundRobinMatchCount(5)).toBe(10);
    expect(expectedRoundRobinRoundCount(5)).toBe(5);
  });

  it('N=2 → 1 match, 1 round', () => {
    expect(expectedRoundRobinMatchCount(2)).toBe(1);
    expect(expectedRoundRobinRoundCount(2)).toBe(1);
  });
});

describe('nextPow2', () => {
  it('returns the next power of 2 at or above N', () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(8)).toBe(8);
    expect(nextPow2(9)).toBe(16);
    expect(nextPow2(16)).toBe(16);
    expect(nextPow2(17)).toBe(32);
  });
});

describe('expectedSingleElimRound1MatchCount', () => {
  it('N=8 (power of 2) → 4 round-1 matches, no byes', () => {
    expect(expectedSingleElimRound1MatchCount(8)).toBe(4);
  });

  it('N=16 (power of 2) → 8 round-1 matches', () => {
    expect(expectedSingleElimRound1MatchCount(16)).toBe(8);
  });

  it('N=5 → 1 round-1 match (padded to 8, 3 byes for top 3 seeds)', () => {
    expect(expectedSingleElimRound1MatchCount(5)).toBe(1);
  });

  it('N=6 → 2 round-1 matches (padded to 8, 2 byes)', () => {
    expect(expectedSingleElimRound1MatchCount(6)).toBe(2);
  });

  it('N=12 → 4 round-1 matches (padded to 16, 4 byes)', () => {
    expect(expectedSingleElimRound1MatchCount(12)).toBe(4);
  });

  it('N=2 → 1 round-1 match', () => {
    expect(expectedSingleElimRound1MatchCount(2)).toBe(1);
  });
});
