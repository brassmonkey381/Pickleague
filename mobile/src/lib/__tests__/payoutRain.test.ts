import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rained: number[] = [];
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@just-messin-around/expo-foundation/ui/rewardRain', () => ({
  rainReward: (n: number) => rained.push(n),
}));

import { holdPayoutRain, rainAmount, rainPayout, releasePayoutRain } from '../payoutRain';

describe('payout rain', () => {
  beforeEach(() => {
    rained.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rains a whole, positive amount only', () => {
    expect(rainAmount(25)).toBe(25);
    expect(rainAmount(12.7)).toBe(12);
    expect(rainAmount(0)).toBe(0);
    expect(rainAmount(-5)).toBe(0);
    expect(rainAmount(null)).toBe(0);
    expect(rainAmount(undefined)).toBe(0);
    expect(rainAmount(Number.NaN)).toBe(0);
  });

  it('rains now, or after the delay, and never for nothing', () => {
    rainPayout(25);
    rainPayout(null);
    rainPayout(0);
    expect(rained).toEqual([25]);
    rainPayout(10, 300);
    expect(rained).toEqual([25]);
    vi.advanceTimersByTime(300);
    expect(rained).toEqual([25, 10]);
  });

  it('holds a shared payout until the share studio closes, once', () => {
    holdPayoutRain(25);
    expect(rained).toEqual([]);
    releasePayoutRain();
    vi.runAllTimers();
    expect(rained).toEqual([25]);
    releasePayoutRain();
    vi.runAllTimers();
    expect(rained).toEqual([25]);
  });

  it('releasing with nothing held rains nothing', () => {
    holdPayoutRain(null);
    releasePayoutRain(0);
    expect(rained).toEqual([]);
  });
});
