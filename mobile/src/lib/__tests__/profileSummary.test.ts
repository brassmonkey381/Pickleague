import { describe, it, expect } from 'vitest';
import {
  TOTAL_CELLS,
  availabilityShortSummary as availabilitySummary,
  cellIdx,
  hoursPerWeekLabel,
} from '@just-messin-around/expo-foundation/scheduling/availability';
import {
  nextUnlockTeaser,
  rewardForBadge,
  type UnlockProgressInput,
} from '../profileSummary';

/** A weekly grid with `slots` (half hours) on for each listed day (0 = Mon). */
function grid(days: number[], from: number, to: number): boolean[] {
  const av = Array(TOTAL_CELLS).fill(false);
  for (const d of days) for (let s = from; s < to; s++) av[cellIdx(d, s)] = true;
  return av;
}

describe('hoursPerWeekLabel', () => {
  it('singular, whole and half hours', () => {
    expect(hoursPerWeekLabel(2)).toBe('1 hr/wk');
    expect(hoursPerWeekLabel(18)).toBe('9 hrs/wk');
    expect(hoursPerWeekLabel(5)).toBe('2.5 hrs/wk');
  });
});

describe('availabilitySummary', () => {
  it('is null when nothing is set or the shape is wrong', () => {
    expect(availabilitySummary(Array(TOTAL_CELLS).fill(false))).toBeNull();
    expect(availabilitySummary([true, true])).toBeNull();
    expect(availabilitySummary(null)).toBeNull();
  });

  it('names weeknights (the plan example: 9 hrs/wk)', () => {
    // Mon-Thu 6-8 PM (slots 36..39) = 8 hrs, plus Fri 6-7 PM = 1 hr.
    const av = grid([0, 1, 2, 3], 36, 40);
    for (let s = 36; s < 38; s++) av[cellIdx(4, s)] = true;
    expect(availabilitySummary(av)).toBe('Weeknights · 9 hrs/wk');
  });

  it('names weekends', () => {
    expect(availabilitySummary(grid([5, 6], 18, 24))).toBe('Weekends · 6 hrs/wk');
  });

  it('names two buckets, biggest first', () => {
    const av = grid([0, 1, 2], 36, 44);      // 12 hrs weeknights
    for (const d of [5, 6]) for (let s = 18, e = 22; s < e; s++) av[cellIdx(d, s)] = true; // 4 hrs weekends
    expect(availabilitySummary(av)).toBe('Weeknights & weekends · 16 hrs/wk');
  });

  it('names only buckets holding at least a quarter of the hours', () => {
    // 1 slot each in mornings / afternoons / weekends (20% each) and 2 in
    // nights (40%, late night folds in): only weeknights is named.
    const av = Array(TOTAL_CELLS).fill(false);
    av[cellIdx(0, 12)] = true;  // morning
    av[cellIdx(0, 26)] = true;  // afternoon
    av[cellIdx(0, 40)] = true;  // night
    av[cellIdx(5, 20)] = true;  // weekend
    av[cellIdx(1, 2)] = true;   // late night -> nights (now 2/5 = 40%)
    expect(availabilitySummary(av)).toBe('Weeknights · 2.5 hrs/wk');
  });
});

describe('rewardForBadge', () => {
  it('prefers the avatar, then a tag slot, then a tag', () => {
    expect(rewardForBadge('Hot Streak')).toMatch(/avatar$/);
    expect(rewardForBadge('Veteran')).toBe('+1 tag slot');
    expect(rewardForBadge('Court Hopper')).toMatch(/Globe Trotter tag$/);
    expect(rewardForBadge('No Such Badge')).toBeNull();
  });
});

describe('nextUnlockTeaser', () => {
  const p = (badge: string, current: number, target: number, extra: Partial<UnlockProgressInput> = {}): UnlockProgressInput => ({
    badge, current, target, pct: Math.min(current / target, 1), earned: false, perLeague: false, ...extra,
  });

  const league = (badge: string, earned = false): UnlockProgressInput =>
    ({ badge, current: 0, target: 0, pct: 0, earned, perLeague: true });

  /** Narrows to the 'next' shape (fails the test otherwise). */
  const next = (r: ReturnType<typeof nextUnlockTeaser>) => {
    expect(r.kind).toBe('next');
    return r as Extract<typeof r, { kind: 'next' }>;
  };

  it('counts league-only badges left once every measurable one is earned', () => {
    // Not "Every unlock earned": Hat Trick still gates a tag.
    expect(nextUnlockTeaser([
      p('Hot Streak', 5, 5, { earned: true }),
      league('Hat Trick'),
      league('League Leader', true),
    ])).toEqual({ kind: 'league_only', remaining: 1 });
  });

  it('is all_earned only when no unearned badge of any kind is left', () => {
    expect(nextUnlockTeaser([
      p('Hot Streak', 5, 5, { earned: true }),
      league('Hat Trick', true),
    ])).toEqual({ kind: 'all_earned' });
  });

  it('picks the closest badge that unlocks a reward', () => {
    const t = next(nextUnlockTeaser([
      p('Court Hopper', 4, 5),     // 80%, unlocks a tag
      p('Hot Streak', 3, 5),       // 60%, unlocks an avatar
    ]));
    expect(t.badge).toBe('Court Hopper');
    expect(t.valueText).toBe('4/5');
    expect(t.a11yValue).toBe('4 of 5');
  });

  it('skips per-league and earned badges', () => {
    const t = next(nextUnlockTeaser([
      league('League Leader'),
      p('Veteran', 30, 30, { earned: true }),
      p('Hot Streak', 1, 5),
    ]));
    expect(t.badge).toBe('Hot Streak');
    expect(t.reward).toMatch(/avatar$/);
  });

  it('shows the PLUPR goal as a percentage, never the rating', () => {
    const t = next(nextUnlockTeaser([p('Top Rated', 3.5, 4.0, { pct: 0.33 })]));
    expect(t.valueText).toBe('33%');
    expect(t.valueText).not.toContain('3.5');
  });
});
