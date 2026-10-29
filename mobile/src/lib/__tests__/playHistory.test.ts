import { describe, it, expect } from 'vitest';
import {
  matchCountLabel,
  mergeHistory,
  nextHistoryCursor,
  playHistoryDay,
  playHistoryStatus,
  playHistoryTitle,
  playHistoryWhen,
  parsePlayHistory,
  type PlayHistoryRow,
} from '../playHistory';

const row = (id: string, startedAt: string): PlayHistoryRow => ({
  id,
  kind: 'open_play',
  venueId: null,
  venueName: null,
  startedAt,
  endedAt: startedAt,
  valid: false,
  validReason: null,
  atCourt: false,
  rewardsPending: false,
  matchCount: 0,
});

describe('play history rows', () => {
  it('title: court and kind, or the kind alone', () => {
    expect(playHistoryTitle({ kind: 'open_play', venueName: 'Lakeside' })).toBe('Lakeside · Open play');
    expect(playHistoryTitle({ kind: 'drill', venueName: null })).toBe('Drill');
  });

  it('day: Today, Yesterday, a date, a date with its year', () => {
    const now = new Date(2026, 9, 29, 15, 0);
    expect(playHistoryDay(new Date(2026, 9, 29, 9, 0), now)).toBe('Today');
    expect(playHistoryDay(new Date(2026, 9, 28, 23, 0), now)).toBe('Yesterday');
    expect(playHistoryDay(new Date(2026, 9, 20, 9, 0), now)).toBe('Oct 20');
    expect(playHistoryDay(new Date(2025, 11, 31, 9, 0), now)).toBe('Dec 31, 2025');
  });

  it('when: day, times and how long', () => {
    const start = new Date(2026, 9, 29, 18, 10);
    const end = new Date(2026, 9, 29, 20, 5);
    expect(playHistoryWhen({ startedAt: start.toISOString(), endedAt: end.toISOString() }, new Date(2026, 9, 29, 21).getTime()))
      .toBe('Today · 6:10 PM–8:05 PM · 1h 55m');
  });

  it('status: counts, waits on a confirm, or says why not', () => {
    expect(playHistoryStatus({ valid: true, validReason: 'linked_match', rewardsPending: false }).label).toBe('Counts');
    expect(playHistoryStatus({ valid: true, validReason: 'linked_match', rewardsPending: true }).label).toBe('Counts once confirmed');
    expect(playHistoryStatus({ valid: false, validReason: 'too_short', rewardsPending: false }).note).toBe('It lasted under 5 minutes.');
    expect(playHistoryStatus({ valid: false, validReason: 'no_match_or_drill', rewardsPending: false }).note).toMatch(/No match or drill/);
    expect(playHistoryStatus({ valid: false, validReason: null, rewardsPending: false }))
      .toEqual({ label: "Didn't count", tone: 'neutral', note: null });
  });

  it('match counts', () => {
    expect(matchCountLabel(0)).toBe('');
    expect(matchCountLabel(1)).toBe('1 match');
    expect(matchCountLabel(3)).toBe('3 matches');
  });

  it('pages: a cursor only after a full page; merged newest first, no repeats', () => {
    const a = [row('1', '2026-10-29T10:00:00Z'), row('2', '2026-10-28T10:00:00Z')];
    expect(nextHistoryCursor(a, 2)).toBe('2026-10-28T10:00:00Z');
    expect(nextHistoryCursor(a, 3)).toBeNull();
    const merged = mergeHistory(a, [row('2', '2026-10-28T10:00:00Z'), row('3', '2026-10-27T10:00:00Z')]);
    expect(merged.map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('parses the RPC rows, skipping broken ones', () => {
    const rows = parsePlayHistory([
      { session_id: 's1', kind: 'drill', venue_id: 'v', venue_name: 'Lakeside', started_at: 'a', ended_at: 'b',
        valid: true, valid_reason: 'linked_match', at_court: true, rewards_pending: false, match_count: 2 },
      { session_id: 's2', started_at: 'a' },
      null,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 's1', kind: 'drill', venueName: 'Lakeside', valid: true, matchCount: 2 });
    expect(parsePlayHistory(null)).toEqual([]);
  });
});
