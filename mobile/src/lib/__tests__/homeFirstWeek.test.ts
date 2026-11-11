import { describe, expect, it } from 'vitest';
import { FIRST_WEEK_MS, homeFirstWeekLayout, inFirstWeek } from '../homeFirstWeek';

describe('the first week', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  it('is the 7 days after sign-up', () => {
    expect(inFirstWeek('2026-11-10T11:00:00Z', now)).toBe(true);
    expect(inFirstWeek(new Date(now - FIRST_WEEK_MS + 1000).toISOString(), now)).toBe(true);
    expect(inFirstWeek(new Date(now - FIRST_WEEK_MS).toISOString(), now)).toBe(false);
  });
  it('an unknown or bad date gets the usual Home', () => {
    expect(inFirstWeek(null, now)).toBe(false);
    expect(inFirstWeek(undefined, now)).toBe(false);
    expect(inFirstWeek('not a date', now)).toBe(false);
  });
});

describe('the new-player Home', () => {
  it('first week, no league: lead with Get started, no stats, no feed', () => {
    expect(homeFirstWeekLayout(true, false)).toEqual({ leadWithStart: true, hideStats: true, hideFeed: true });
  });
  it('first week, joined a league: the feed is back for UP NEXT', () => {
    expect(homeFirstWeekLayout(true, true)).toEqual({ leadWithStart: true, hideStats: true, hideFeed: false });
  });
  it('after the first week: the usual Home', () => {
    expect(homeFirstWeekLayout(false, false)).toEqual({ leadWithStart: false, hideStats: false, hideFeed: false });
    expect(homeFirstWeekLayout(false, true)).toEqual({ leadWithStart: false, hideStats: false, hideFeed: false });
  });
});
