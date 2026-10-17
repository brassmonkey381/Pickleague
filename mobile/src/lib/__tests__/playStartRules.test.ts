import { describe, it, expect } from 'vitest';
import { START_CHECKIN_MAX_MS, untrackedReason, type UntrackedStartInput } from '../playStartRules';
import type { DeviceFix } from '../courtCheckinRules';

const NOW = Date.parse('2026-10-16T18:00:00.000Z');
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const MIN = 60_000;
/** The fix taken 5 s before a tap `tapAgoMs` ago, 12 m accurate. */
const fixFor = (tapAgoMs: number, accuracyM: number | null = 12): DeviceFix => ({
  lat: 37.8,
  lng: -122.26,
  accuracyM,
  fixAt: iso(tapAgoMs + 5_000),
});

/** A Start at Lakeside tapped `tapAgoMs` ago with its tap-time fix, untracked unless the overrides say otherwise. */
function input(tapAgoMs: number, over: Partial<UntrackedStartInput> = {}): UntrackedStartInput {
  return {
    payload: { venueId: 'lakeside', at: iso(tapAgoMs), fix: fixFor(tapAgoMs) },
    row: { venue_id: 'lakeside' },
    cur: null,
    sessionCheckin: null,
    nowMs: NOW,
    ...over,
  };
}

describe('untrackedReason: why a Start at a court did not check me in', () => {
  it('a live Start whose fix was not at the court', () => {
    expect(untrackedReason(input(0))).toBe('not_at_court');
  });

  it('the court is gone', () => {
    expect(untrackedReason(input(0, { row: { venue_id: null } }))).toBe('court_gone');
  });

  it('no fix: the location, or the check-in the sheet relied on', () => {
    expect(untrackedReason(input(0, { payload: { venueId: 'lakeside', at: iso(0), fix: null } }))).toBe('no_fix');
    expect(
      untrackedReason(input(0, { payload: { venueId: 'lakeside', at: iso(0), fix: null, viaCheckin: true }, cur: null })),
    ).toBe('checkin_gone');
    expect(
      untrackedReason(
        input(0, {
          payload: { venueId: 'lakeside', at: iso(0), fix: null, viaCheckin: true },
          cur: { venueId: 'lakeside', private: true },
        }),
      ),
    ).toBe('checkin_private');
  });

  it('an approximate fix', () => {
    expect(untrackedReason(input(0, { payload: { venueId: 'lakeside', at: iso(0), fix: fixFor(0, 2000) } }))).toBe('imprecise');
  });

  it('replayed after its check-in would have ended: stored, nobody saw it (the server\'s own times say so)', () => {
    const sessionCheckin = {
      expires_at: iso(60 * MIN),
      created_at: iso(0),
      location_confirmed: true,
    };
    expect(untrackedReason(input(4 * 60 * MIN, { sessionCheckin }))).toBe('synced_late');
  });

  it('replayed more than 12 hours after the tap: too old (the phone clock on both ends)', () => {
    expect(untrackedReason(input(START_CHECKIN_MAX_MS + MIN))).toBe('too_old');
    expect(START_CHECKIN_MAX_MS).toBe(12 * 3600_000);
  });

  it('replayed late with nothing stored: the location did not confirm the court at the tap (never "too late")', () => {
    expect(untrackedReason(input(40 * MIN))).toBe('unconfirmed_late');
    // Just under the limit is still that, not too old.
    expect(untrackedReason(input(START_CHECKIN_MAX_MS - MIN))).toBe('unconfirmed_late');
  });

  it('a stored check-in still running is not "synced late"', () => {
    const sessionCheckin = { expires_at: iso(-60 * MIN), created_at: iso(0), location_confirmed: true };
    expect(untrackedReason(input(40 * MIN, { sessionCheckin }))).toBe('unconfirmed_late');
  });
});
