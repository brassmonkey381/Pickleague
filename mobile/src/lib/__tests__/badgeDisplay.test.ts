import { describe, expect, it } from 'vitest';
import { badgeDisplayContext, badgeDisplayDescription, badgeDisplayName } from '../badgeDisplay';

describe('badgeDisplay', () => {
  it('shows the period badges as rounds and keeps every other name', () => {
    expect(badgeDisplayName('Period Champion')).toBe('Round Champion');
    expect(badgeDisplayName('Period Sweeper')).toBe('Round Sweeper');
    expect(badgeDisplayName('Season Crown')).toBe('Season Crown');
    expect(badgeDisplayName(null)).toBeNull();
  });

  it('rewrites a stored award context', () => {
    expect(badgeDisplayContext('Fall 2026 — Period 3')).toBe('Fall 2026 — Round 3');
    expect(badgeDisplayContext('Swept all 4 periods')).toBe('Swept all 4 rounds');
    expect(badgeDisplayContext('vs Sam, 11-0')).toBe('vs Sam, 11-0');
    expect(badgeDisplayContext(null)).toBeNull();
  });

  it('rewrites only the two renamed badges\' descriptions', () => {
    expect(badgeDisplayDescription('Period Champion', 'Finished #1 in a single locked-in period of a season.'))
      .toBe('Finished #1 in a single locked-in round of a season.');
    expect(badgeDisplayDescription('Period Sweeper', 'Finished #1 in every locked-in period of a single season.'))
      .toBe('Finished #1 in every locked-in round of a single season.');
    expect(badgeDisplayDescription('Season Crown', 'Best period ever')).toBe('Best period ever');
  });
});
