import { describe, expect, it } from 'vitest';
import { contributeAmounts, potAfterLine } from '../potContribute';

describe('contributeAmounts', () => {
  it('quick amounts below the balance, then Max', () => {
    expect(contributeAmounts(1240).map((c) => c.label)).toEqual(['50', '100', '250', 'Max']);
    expect(contributeAmounts(1240).at(-1)?.value).toBe(1240);
  });
  it('a small balance keeps only what fits', () => {
    expect(contributeAmounts(80).map((c) => c.label)).toEqual(['50', 'Max']);
  });
  it('nothing to give: no chips; unknown balance: no Max', () => {
    expect(contributeAmounts(0)).toEqual([]);
    expect(contributeAmounts(undefined).map((c) => c.label)).toEqual(['50', '100', '250']);
  });
});

describe('potAfterLine', () => {
  it('adds exactly the amount (no house bonus) and says what is left', () => {
    expect(potAfterLine(3500, 100, 1240)).toBe('Pot after: 3,600. You keep 1,140.');
    expect(potAfterLine(3500, 100)).toBe('Pot after: 3,600.');
  });
});
