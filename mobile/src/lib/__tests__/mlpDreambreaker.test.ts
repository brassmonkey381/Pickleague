import { describe, expect, it } from 'vitest';
import { dreambreakerProblem, isRotatingDreambreaker, moveInOrder, validRally21 } from '../mlpDreambreaker';

describe('validRally21 (PKL-086)', () => {
  it('accepts a rally game to 21, win by 2', () => {
    for (const [a, b] of [[21, 19], [19, 21], [21, 0], [21, 15], [24, 22], [30, 28]]) expect(validRally21(a, b)).toBe(true);
  });
  it('refuses scores that are not a finished game to 21 by 2', () => {
    for (const [a, b] of [[21, 20], [25, 21], [20, 18], [11, 9], [21, 21], [-1, 21], [21.5, 19]]) expect(validRally21(a, b)).toBe(false);
  });
  it('explains a bad score', () => {
    expect(dreambreakerProblem(21, 19)).toBeNull();
    expect(dreambreakerProblem(21, 20)).toMatch(/21, win by 2/);
  });
});

describe('order of play', () => {
  it('moves a player up and down, never off the ends', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 2, -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveInOrder(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('tells a rotating Dreambreaker from an old one-player one', () => {
    expect(isRotatingDreambreaker({ is_dreambreaker: true, db_order_team1: ['a'], db_order_team2: ['b'] })).toBe(true);
    expect(isRotatingDreambreaker({ is_dreambreaker: true })).toBe(false);
    expect(isRotatingDreambreaker({ is_dreambreaker: false, db_order_team1: ['a'], db_order_team2: ['b'] })).toBe(false);
  });
});
