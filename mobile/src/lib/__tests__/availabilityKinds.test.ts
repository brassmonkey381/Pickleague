import { describe, expect, it } from 'vitest';
import { KIND, fromKinds, kindsSummary, toKinds } from '../availabilityKinds';

const N = 336;
const grid = (on: number[]) => Array.from({ length: N }, (_, i) => on.includes(i));

describe('availability kinds', () => {
  it('reads play, drill and either from the two stored grids', () => {
    const k = toKinds(grid([0, 1]), grid([1, 2]));
    expect(k.slice(0, 4)).toEqual([KIND.play, KIND.either, KIND.drill, KIND.off]);
  });

  it('writes back the same two grids', () => {
    const k = toKinds(grid([0, 1]), grid([1, 2]));
    const out = fromKinds(k);
    expect(out.availability.slice(0, 4)).toEqual([true, true, false, false]);
    expect(out.drill_availability.slice(0, 4)).toEqual([false, true, true, false]);
  });

  it('treats missing or wrong-sized grids as empty', () => {
    expect(toKinds(null, undefined).every(v => v === KIND.off)).toBe(true);
    expect(toKinds([true], []).length).toBe(N);
  });

  it('sums the hours of each kind', () => {
    expect(kindsSummary(toKinds(grid([0, 1, 2, 3]), grid([3, 4])))).toBe('1.5 h play, 0.5 h drill, 0.5 h either');
    expect(kindsSummary(toKinds(null, null))).toBe('Not set');
  });
});
