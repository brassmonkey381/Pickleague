import { describe, expect, it } from 'vitest';
import { monthAllowed, parseSince, sinceDate, sinceLabel, sinceYears } from '../playingSince';

describe('playing since', () => {
  it('labels a stored month', () => {
    expect(sinceLabel('2021-03-01')).toBe('SINCE MAR 2021');
    expect(sinceLabel(null)).toBeNull();
    expect(sinceLabel('nonsense')).toBeNull();
  });

  it('round-trips the date the server stores', () => {
    expect(sinceDate(2019, 0)).toBe('2019-01-01');
    expect(parseSince(sinceDate(2019, 11))).toEqual({ year: 2019, month: 11 });
  });

  it('offers this year back to 1965 and no future month', () => {
    const now = new Date(2026, 10, 4);
    const ys = sinceYears(now);
    expect(ys[0]).toBe(2026);
    expect(ys[ys.length - 1]).toBe(1965);
    expect(monthAllowed(2026, 10, now)).toBe(true);
    expect(monthAllowed(2026, 11, now)).toBe(false);
    expect(monthAllowed(2025, 11, now)).toBe(true);
  });
});
