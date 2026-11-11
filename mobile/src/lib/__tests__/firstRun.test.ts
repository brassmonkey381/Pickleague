import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));

import { courtMetaLine, courtReasons, milesLabel, normalizeSuggestedCourts, shouldShowFirstRun, type SuggestedCourt } from '../firstRun';

const now = Date.parse('2026-11-11T12:00:00Z');
const court = (o: Partial<SuggestedCourt> = {}): SuggestedCourt => ({
  venue_id: 'v1', name: 'Washington Park', city: 'Alameda', distance_m: 1287, court_count: 6,
  players_30d: 0, checkins_30d: 0, leagues: 0, sessions: 0, matches_30d: 0, favorites: 0, recommended: false, ...o,
});

describe('who sees the first run', () => {
  it('a new account that has not seen it', () => {
    expect(shouldShowFirstRun({ createdAt: '2026-11-11T10:00:00Z', nowMs: now, isGuest: false, seen: false })).toBe(true);
  });
  it('not twice, not guests, not after the first week', () => {
    expect(shouldShowFirstRun({ createdAt: '2026-11-11T10:00:00Z', nowMs: now, isGuest: false, seen: true })).toBe(false);
    expect(shouldShowFirstRun({ createdAt: '2026-11-11T10:00:00Z', nowMs: now, isGuest: true, seen: false })).toBe(false);
    expect(shouldShowFirstRun({ createdAt: '2026-10-01T10:00:00Z', nowMs: now, isGuest: false, seen: false })).toBe(false);
    expect(shouldShowFirstRun({ createdAt: null, nowMs: now, isGuest: false, seen: false })).toBe(false);
  });
});

describe('why a court is suggested', () => {
  it('strongest two reasons, plural-aware', () => {
    expect(courtReasons(court({ players_30d: 9, leagues: 2, sessions: 3 }))).toEqual(['9 players this month', '2 leagues']);
    expect(courtReasons(court({ players_30d: 1 }))).toEqual(['1 player this month']);
    expect(courtReasons(court({ sessions: 1, matches_30d: 4 }))).toEqual(['1 session a week', '4 matches this month']);
    expect(courtReasons(court({ favorites: 2 }))).toEqual(['starred by 2 players']);
  });
  it('nothing but size and distance says nothing', () => {
    expect(courtReasons(court())).toEqual([]);
  });
});

describe('the row text', () => {
  it('city, miles, courts', () => {
    expect(courtMetaLine(court())).toBe('Alameda, 0.8 mi, 6 courts');
    expect(courtMetaLine(court({ city: null, court_count: 1, distance_m: 20000 }))).toBe('12 mi, 1 court');
    expect(milesLabel(null)).toBeNull();
  });
});

describe('the RPC rows', () => {
  it('keeps rows with an id and fills numbers', () => {
    const rows = normalizeSuggestedCourts({
      nearby: [
        { venue_id: 'a', name: 'A', players_30d: '3', leagues: null, recommended: true, distance_m: 500 },
        { name: 'no id' },
        null,
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ venue_id: 'a', players_30d: 3, leagues: 0, recommended: true, distance_m: 500 });
    expect(normalizeSuggestedCourts(null)).toEqual([]);
  });
});
