import { describe, it, expect } from 'vitest';
import {
  FIX_MAX_AGE_MS,
  FIX_REUSE_MS,
  checkoutPayload,
  fixArgs,
  fixFromCoords,
  isFixFresh,
  isNotAtCourtError,
  isValidFix,
  noFixMessage,
  rejectedCheckinNotice,
  type DeviceFix,
} from '../courtCheckinRules';

const NOW = Date.parse('2026-10-15T18:00:00.000Z');
const fixAt = (agoMs: number): DeviceFix => ({
  lat: 37.8,
  lng: -122.26,
  accuracyM: 12,
  fixAt: new Date(NOW - agoMs).toISOString(),
});

describe('isValidFix', () => {
  it('accepts a real fix, with or without an accuracy', () => {
    expect(isValidFix(fixAt(0))).toBe(true);
    expect(isValidFix({ ...fixAt(0), accuracyM: null })).toBe(true);
  });

  it('refuses what the server could not place', () => {
    expect(isValidFix(null)).toBe(false);
    expect(isValidFix(undefined)).toBe(false);
    expect(isValidFix({})).toBe(false);
    expect(isValidFix({ ...fixAt(0), lat: Number.NaN })).toBe(false);
    expect(isValidFix({ ...fixAt(0), lat: 91 })).toBe(false);
    expect(isValidFix({ ...fixAt(0), lng: -181 })).toBe(false);
    // 0,0 is a failed read, not a court.
    expect(isValidFix({ ...fixAt(0), lat: 0, lng: 0 })).toBe(false);
    expect(isValidFix({ ...fixAt(0), accuracyM: -1 })).toBe(false);
    expect(isValidFix({ ...fixAt(0), accuracyM: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isValidFix({ ...fixAt(0), fixAt: 'not a time' })).toBe(false);
  });
});

describe('fixFromCoords', () => {
  it('stamps the fix with the time it was taken', () => {
    expect(fixFromCoords({ lat: 37.8, lng: -122.26, accuracy: 9 }, NOW)).toEqual({
      lat: 37.8,
      lng: -122.26,
      accuracyM: 9,
      fixAt: '2026-10-15T18:00:00.000Z',
    });
  });

  it('is null for no coords or an unusable reading', () => {
    expect(fixFromCoords(null, NOW)).toBeNull();
    expect(fixFromCoords({ lat: 0, lng: 0, accuracy: 5 }, NOW)).toBeNull();
    expect(fixFromCoords({ lat: 37.8, lng: -122.26 }, NOW)?.accuracyM).toBeNull();
  });
});

describe('isFixFresh (the server takes a fix up to 2 minutes old)', () => {
  it('is fresh up to the limit and stale past it', () => {
    expect(isFixFresh(fixAt(0), NOW)).toBe(true);
    expect(isFixFresh(fixAt(FIX_MAX_AGE_MS), NOW)).toBe(true);
    expect(isFixFresh(fixAt(FIX_MAX_AGE_MS + 1), NOW)).toBe(false);
  });

  it('allows a little clock skew into the future, not more', () => {
    expect(isFixFresh(fixAt(-30_000), NOW)).toBe(true);
    expect(isFixFresh(fixAt(-61_000), NOW)).toBe(false);
  });

  it('takes a tighter limit for reusing a fix on the next tap', () => {
    expect(isFixFresh(fixAt(FIX_REUSE_MS - 1), NOW, FIX_REUSE_MS)).toBe(true);
    expect(isFixFresh(fixAt(FIX_REUSE_MS + 1), NOW, FIX_REUSE_MS)).toBe(false);
  });

  it('is never fresh without a fix', () => {
    expect(isFixFresh(null, NOW)).toBe(false);
    expect(isFixFresh(undefined, NOW)).toBe(false);
  });
});

describe('fixArgs', () => {
  it('maps a fix to the four RPC arguments', () => {
    expect(fixArgs(fixAt(0))).toEqual({
      p_lat: 37.8,
      p_lng: -122.26,
      p_accuracy_m: 12,
      p_fix_at: '2026-10-15T18:00:00.000Z',
    });
  });

  it('sends nulls with no fix (a session with no court)', () => {
    expect(fixArgs(null)).toEqual({ p_lat: null, p_lng: null, p_accuracy_m: null, p_fix_at: null });
  });
});

describe('checkoutPayload', () => {
  it('carries when I left, so a late replay is not stretched to the expiry', () => {
    expect(checkoutPayload('c1', 'geofence', NOW)).toEqual({ id: 'c1', source: 'geofence', at: '2026-10-15T18:00:00.000Z' });
  });

  it('leaves out the source filter when there is none (and keeps a null id: all of mine)', () => {
    const p = checkoutPayload(null, undefined, NOW);
    expect(p).toEqual({ id: null, at: '2026-10-15T18:00:00.000Z' });
    expect('source' in p).toBe(false);
  });
});

describe('isNotAtCourtError', () => {
  it("recognises checkin_venue's refusal", () => {
    expect(isNotAtCourtError({ message: 'You need to be at the court to check in (about 240 m away).' })).toBe(true);
    expect(isNotAtCourtError(new Error('You need to be at the court to check in (about 3 m away).'))).toBe(true);
  });

  it('ignores everything else', () => {
    expect(isNotAtCourtError({ message: 'Court not found' })).toBe(false);
    expect(isNotAtCourtError(null)).toBe(false);
    expect(isNotAtCourtError('need to be at the court')).toBe(false);
  });
});

describe('rejectedCheckinNotice', () => {
  it('explains the 2-minute rule when the queued fix had gone stale', () => {
    const text = rejectedCheckinNotice({
      venueName: 'Lakeside',
      timeLabel: '5:40 PM',
      fixWasStale: true,
      error: { message: 'You need to be at the court to check in (about 0 m away).' },
    });
    expect(text).toContain("Your check-in at Lakeside (5:40 PM) didn't go through.");
    expect(text).toContain('within 2 minutes');
    expect(text).not.toContain('about 0 m away');
  });

  it("otherwise passes on the server's reason", () => {
    expect(
      rejectedCheckinNotice({
        venueName: 'Lakeside',
        timeLabel: '5:40 PM',
        fixWasStale: false,
        error: { message: 'You need to be at the court to check in (about 240 m away).' },
      }),
    ).toBe("Your check-in at Lakeside (5:40 PM) didn't go through. You need to be at the court to check in (about 240 m away).");
    expect(rejectedCheckinNotice({ venueName: 'Lakeside', timeLabel: '5:40 PM', fixWasStale: false, error: null })).toBe(
      "Your check-in at Lakeside (5:40 PM) didn't go through.",
    );
  });
});

describe('noFixMessage', () => {
  it('points a denied permission at the right settings, and always offers the untracked session', () => {
    expect(noFixMessage('denied', 'ios')).toContain('Settings');
    expect(noFixMessage('denied', 'web')).toContain('browser');
    for (const m of [noFixMessage('denied', 'ios'), noFixMessage('denied', 'web'), noFixMessage('granted', 'android')]) {
      expect(m).toContain('start without a court');
    }
  });

  it('says it could not get a fix when permission is not the problem', () => {
    expect(noFixMessage('granted', 'ios')).toMatch(/^Couldn't get your location/);
    expect(noFixMessage('undetermined', 'web')).toMatch(/^Couldn't get your location/);
  });
});
