import { describe, it, expect } from 'vitest';
import {
  START_CHECKIN_MAX_MS,
  checkedInBySession,
  sessionCheckinCounts,
  untrackedReason,
  untrackedStartNotice,
  type UntrackedStartInput,
} from '../playStartRules';
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

  it('its End reached Pickleague first: the check-in stored closed at the End is "synced late"', () => {
    const sessionCheckin = {
      expires_at: iso(-140 * MIN),
      checked_out_at: iso(2 * MIN),
      created_at: iso(0),
      location_confirmed: true,
    };
    expect(untrackedReason(input(40 * MIN, { sessionCheckin }))).toBe('synced_late');
  });
});

describe('untrackedStartNotice: whether and where to say it', () => {
  const at = (tapAgoMs: number, over: Partial<UntrackedStartInput> = {}, showing = false, queued = true) => ({
    ...input(tapAgoMs, over),
    sessionId: 'S1',
    showing,
    queued,
  });

  it('a replay that lands after End cleared the island (the usual offline case) still gets its card', () => {
    // Synced 13 h late: nothing stored.
    expect(untrackedStartNotice(at(START_CHECKIN_MAX_MS + MIN))).toEqual({ onIsland: false, reason: 'too_old' });
    // Stored only after it had ended.
    const sessionCheckin = { expires_at: iso(60 * MIN), created_at: iso(0), location_confirmed: true };
    expect(untrackedStartNotice(at(4 * 60 * MIN, { sessionCheckin }))).toEqual({ onIsland: false, reason: 'synced_late' });
  });

  it('says nothing when the Start checked me in, even though the island is idle and my current check-in hides it', () => {
    // Its own check-in, stored and running (the End that closes it is still on its way).
    const sessionCheckin = { expires_at: iso(-140 * MIN), created_at: iso(0), location_confirmed: true, checked_out_at: null };
    expect(sessionCheckinCounts(sessionCheckin)).toBe(true);
    expect(untrackedStartNotice(at(40 * MIN, { sessionCheckin, cur: null }))).toBeNull();
    // Or it adopted my check-in at that court.
    expect(untrackedStartNotice(at(40 * MIN, { cur: { id: 'C9', venueId: 'lakeside' } }))).toBeNull();
    expect(checkedInBySession({ id: 'S1', venueId: 'elsewhere' }, 'S1', [])).toBe(true);
    // A private check-in there never counts.
    expect(checkedInBySession({ id: 'C9', venueId: 'lakeside', private: true }, 'S1', ['lakeside'])).toBe(false);
  });

  it('on the island only for a live Start the island still shows', () => {
    expect(untrackedStartNotice(at(0, {}, true, false))).toEqual({ onIsland: true, reason: 'not_at_court' });
    // A replay is said on a card even while its session still runs.
    expect(untrackedStartNotice(at(40 * MIN, {}, true, true))).toEqual({ onIsland: false, reason: 'unconfirmed_late' });
    // A live Start whose session ended before the check finished: a card, never silence.
    expect(untrackedStartNotice(at(0, {}, false, false))).toEqual({ onIsland: false, reason: 'not_at_court' });
  });
});
