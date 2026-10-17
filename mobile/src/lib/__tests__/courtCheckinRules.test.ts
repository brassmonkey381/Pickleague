import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  APPROXIMATE_FIX_M,
  CHECKOUT_FIX_WAIT_MS,
  checkinEndMs,
  checkoutFixArgs,
  fixWithin,
  lapsedCheckinFacts,
  waitUntilSent,
  FIX_MAX_ACCURACY_M,
  FIX_MAX_AGE_MS,
  FIX_REUSE_MS,
  checkoutPayload,
  fixArgs,
  fixFromCoords,
  impreciseFixMessage,
  isFixFresh,
  isImpreciseFixError,
  isNotAtCourtError,
  isPreciseFix,
  isStaleFixError,
  isValidFix,
  needsCourtToExtend,
  noFixMessage,
  offersUntrackedSession,
  refusedForQueueWait,
  rejectedCheckinNotice,
  syncedAfterItEnded,
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
  it('maps a fix to the RPC arguments, with its age at send time', () => {
    expect(fixArgs(fixAt(0), NOW)).toEqual({
      p_lat: 37.8,
      p_lng: -122.26,
      p_accuracy_m: 12,
      p_fix_at: '2026-10-15T18:00:00.000Z',
      p_fix_age_ms: 0,
    });
  });

  it('measures the age on this device (a queued replay counts its time in the queue)', () => {
    // Taken 30 s before NOW, sent 50 s after it: 80 s old, whatever the clock says.
    expect(fixArgs(fixAt(30_000), NOW + 50_000).p_fix_age_ms).toBe(80_000);
  });

  it('never sends a negative age (the clock stepped back)', () => {
    expect(fixArgs(fixAt(-5_000), NOW).p_fix_age_ms).toBe(0);
  });

  it('sends nulls with no fix (a session with no court)', () => {
    expect(fixArgs(null, NOW)).toEqual({
      p_lat: null,
      p_lng: null,
      p_accuracy_m: null,
      p_fix_at: null,
      p_fix_age_ms: null,
    });
  });
});

describe('isPreciseFix', () => {
  it(`accepts up to ${FIX_MAX_ACCURACY_M} m, as the server does`, () => {
    expect(isPreciseFix({ ...fixAt(0), accuracyM: FIX_MAX_ACCURACY_M })).toBe(true);
    expect(isPreciseFix({ ...fixAt(0), accuracyM: 5 })).toBe(true);
  });

  it('refuses an approximate location, and a fix with no accuracy', () => {
    expect(isPreciseFix({ ...fixAt(0), accuracyM: FIX_MAX_ACCURACY_M + 1 })).toBe(false);
    expect(isPreciseFix({ ...fixAt(0), accuracyM: 3000 })).toBe(false);
    expect(isPreciseFix({ ...fixAt(0), accuracyM: null })).toBe(false);
  });
});

describe('impreciseFixMessage', () => {
  it('names Precise Location for an approximate location, per platform', () => {
    expect(impreciseFixMessage(2000, 'ios')).toContain('Turn on Precise Location');
    expect(impreciseFixMessage(2000, 'android')).toContain('Allow precise location');
    expect(impreciseFixMessage(2000, 'web')).toContain('browser only shared an approximate location');
    expect(impreciseFixMessage(null, 'ios')).toContain('approximate location');
  });

  it('says "try again in the open" for a poor but real fix', () => {
    const m = impreciseFixMessage(APPROXIMATE_FIX_M, 'ios');
    expect(m).toContain('about 500 m');
    expect(m).toContain('Try again in the open');
    expect(m).not.toContain('Precise Location');
  });

  it('always offers the untracked session', () => {
    for (const m of [impreciseFixMessage(300, 'ios'), impreciseFixMessage(2000, 'web'), impreciseFixMessage(null, 'android')]) {
      expect(m).toContain('start without a court');
    }
  });
});

describe('fix refusals', () => {
  const precise = { message: "Your location isn't precise enough to confirm you're at the court. Make sure Precise Location is on for Pickleague, then try again." };
  const stale = { message: 'Your location is out of date. Try again at the court.' };
  const far = { message: 'You need to be at the court to check in (about 240 m away).' };
  const farExtend = { message: 'You need to be at the court to stay checked in (about 240 m away).' };
  const cap = { message: "To stay checked in, open Pickleague at the court so it can confirm you're still there." };

  it('tells each one apart', () => {
    expect(isImpreciseFixError(precise)).toBe(true);
    expect(isStaleFixError(stale)).toBe(true);
    expect(isImpreciseFixError(stale)).toBe(false);
    expect(isStaleFixError(far)).toBe(false);
  });

  it('offers the untracked session after any of the check-in refusals about the fix or the tap', () => {
    for (const e of [precise, stale, far]) expect(offersUntrackedSession(e)).toBe(true);
    // migration_checkin_tap_time.sql: the fix away from the tap, a tap over 12 hours old.
    expect(offersUntrackedSession({ message: 'Your location was taken ...', hint: 'pl:fix.after_tap' })).toBe(true);
    expect(offersUntrackedSession({ message: 'This check-in was saved ...', hint: 'pl:checkin.too_old' })).toBe(true);
    expect(offersUntrackedSession({ message: 'Court not found' })).toBe(false);
    expect(offersUntrackedSession({ message: 'x', hint: 'pl:checkin.closed' })).toBe(false);
    expect(offersUntrackedSession(null)).toBe(false);
  });

  it('knows when an extension needs the player back at the court', () => {
    expect(needsCourtToExtend(cap)).toBe(true);
    expect(needsCourtToExtend(farExtend)).toBe(true);
    expect(needsCourtToExtend({ message: 'Check-in is no longer open' })).toBe(false);
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

  it('carries the fix taken at the tap (the stay proof), so a queued check-out keeps it', () => {
    expect(checkoutPayload('c1', undefined, NOW, fixAt(1_000))).toEqual({
      id: 'c1',
      at: '2026-10-15T18:00:00.000Z',
      fix: fixAt(1_000),
    });
  });

  it('leaves out a missing or unusable fix', () => {
    expect('fix' in checkoutPayload('c1', undefined, NOW, null)).toBe(false);
    expect('fix' in checkoutPayload('c1', undefined, NOW, { ...fixAt(0), lat: 0, lng: 0 })).toBe(false);
  });
});

describe('checkoutFixArgs', () => {
  it('sends the fix with its age at send time, and no p_fix_at (checkout_venue takes none)', () => {
    expect(checkoutFixArgs(fixAt(1_000), NOW)).toEqual({
      p_lat: 37.8,
      p_lng: -122.26,
      p_accuracy_m: 12,
      p_fix_age_ms: 1_000,
    });
  });

  it('a queued check-out sent later counts its time in the queue', () => {
    // Taken 2 s before the tap at NOW, replayed 10 minutes later.
    expect(checkoutFixArgs(fixAt(2_000), NOW + 600_000).p_fix_age_ms).toBe(602_000);
  });

  it('sends nothing at all without a fix, so the call keeps the Phase 1 shape', () => {
    expect(checkoutFixArgs(null, NOW)).toEqual({});
    expect(checkoutFixArgs(undefined, NOW)).toEqual({});
    expect(checkoutFixArgs({ ...fixAt(0), lat: Number.NaN }, NOW)).toEqual({});
  });
});

describe('fixWithin (check-out never waits more than 3 s for a fix)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`waits ${CHECKOUT_FIX_WAIT_MS} ms by default for the stay proof`, () => {
    expect(CHECKOUT_FIX_WAIT_MS).toBe(3_000);
  });

  it('returns a fix that comes back in time', async () => {
    await expect(fixWithin(async () => fixAt(0), CHECKOUT_FIX_WAIT_MS)).resolves.toEqual(fixAt(0));
  });

  it('gives up at the bound and goes without one', async () => {
    vi.useFakeTimers();
    let settled: DeviceFix | null | 'pending' = 'pending';
    const never = new Promise<DeviceFix | null>(() => {});
    void fixWithin(() => never, CHECKOUT_FIX_WAIT_MS).then((f) => {
      settled = f;
    });
    await vi.advanceTimersByTimeAsync(CHECKOUT_FIX_WAIT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeNull();
  });

  it('a fix that arrives after the bound is not used', async () => {
    vi.useFakeTimers();
    const late = new Promise<DeviceFix | null>((resolve) => setTimeout(() => resolve(fixAt(0)), 5_000));
    const p = fixWithin(() => late, CHECKOUT_FIX_WAIT_MS);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBeNull();
  });

  it('no permission, a failed read or an unusable reading: no fix, no error', async () => {
    await expect(fixWithin(async () => null, 50)).resolves.toBeNull();
    await expect(fixWithin(() => Promise.reject(new Error('location off')), 50)).resolves.toBeNull();
    await expect(
      fixWithin(() => {
        throw new Error('sync throw');
      }, 50),
    ).resolves.toBeNull();
    await expect(fixWithin(async () => ({ ...fixAt(0), lat: 0, lng: 0 }), 50)).resolves.toBeNull();
  });
});

describe('isNotAtCourtError', () => {
  it("recognises checkin_venue's refusal (and extend_checkin's)", () => {
    expect(isNotAtCourtError({ message: 'You need to be at the court to check in (about 240 m away).' })).toBe(true);
    expect(isNotAtCourtError(new Error('You need to be at the court to check in (about 3 m away).'))).toBe(true);
    expect(isNotAtCourtError({ message: 'You need to be at the court to stay checked in (about 90 m away).' })).toBe(true);
  });

  it('ignores everything else', () => {
    expect(isNotAtCourtError({ message: 'Court not found' })).toBe(false);
    expect(isNotAtCourtError(null)).toBe(false);
    expect(isNotAtCourtError('need to be at the court')).toBe(false);
  });
});

describe('refusedForQueueWait (an older server judged the fix by its age when sent)', () => {
  const tap = new Date(NOW - 40 * 60_000).toISOString();
  // The fix taken 5 s before the tap, the replay sent 40 min later.
  const tapFix: DeviceFix = { ...fixAt(40 * 60_000 + 5_000) };
  const staleCode = { message: 'Your location is out of date: ...', hint: 'pl:fix.stale' };
  const staleOld = { message: "Your location is out of date: it's more than 2 minutes old. Try again at the court." };

  it('an "out of date" on a fix that was fresh at its tap: the older server refused the wait', () => {
    expect(refusedForQueueWait(staleCode, tapFix, tap)).toBe(true);
    expect(refusedForQueueWait(staleOld, tapFix, tap)).toBe(true);
  });

  it('a fix already 3 min old at the tap: the current server\'s own reason, not the wait', () => {
    const oldAtTap: DeviceFix = { ...fixAt(43 * 60_000) };
    expect(refusedForQueueWait(staleCode, oldAtTap, tap)).toBe(false);
  });

  it('any other refusal is never the wait (too old, the fix after the tap, how far, too vague)', () => {
    for (const hint of ['pl:checkin.too_old', 'pl:fix.after_tap', 'pl:fix.not_at_court', 'pl:fix.imprecise', 'pl:court.gone']) {
      expect(refusedForQueueWait({ message: 'x', hint }, tapFix, tap)).toBe(false);
    }
    expect(refusedForQueueWait({ message: 'You need to be at the court to check in (about 240 m away).' }, tapFix, tap)).toBe(false);
    expect(refusedForQueueWait(staleCode, null, tap)).toBe(false);
    expect(refusedForQueueWait(staleCode, tapFix, 'not a time')).toBe(false);
  });
});

describe('syncedAfterItEnded (stored as a visit nobody saw)', () => {
  const row = (expires: string, created: string | undefined, confirmed?: boolean) => ({
    expires_at: expires,
    created_at: created,
    location_confirmed: confirmed,
  });

  it('a confirmed row that ended before the server stored it', () => {
    expect(syncedAfterItEnded(row('2026-10-16T17:40:00Z', '2026-10-16T18:05:00Z', true))).toBe(true);
    // Ended the moment it was stored (a replay capped by a newer check-in).
    expect(syncedAfterItEnded(row('2026-10-16T18:05:00Z', '2026-10-16T18:05:00Z', true))).toBe(true);
  });

  it('not one still running, an older server\'s closed-before-stored row (unconfirmed), or a server that sent no created_at', () => {
    expect(syncedAfterItEnded(row('2026-10-16T19:40:00Z', '2026-10-16T18:05:00Z', true))).toBe(false);
    expect(syncedAfterItEnded(row('2026-10-16T17:40:00Z', '2026-10-16T18:05:00Z', false))).toBe(false);
    expect(syncedAfterItEnded(row('2026-10-16T17:40:00Z', undefined, true))).toBe(false);
    expect(syncedAfterItEnded(null)).toBe(false);
  });

  it('its check-out reached Pickleague first: the current server stores it closed, so it ended before it was stored', () => {
    // Still running by its expiry, but closed at the check-out that landed first.
    const closed = { ...row('2026-10-16T19:40:00Z', '2026-10-16T18:05:00Z', true), checked_out_at: '2026-10-16T18:00:00Z' };
    expect(syncedAfterItEnded(closed)).toBe(true);
    expect(checkinEndMs(closed)).toBe(Date.parse('2026-10-16T18:00:00Z'));
    // A check-out after it was stored (a normal one) is not that.
    expect(syncedAfterItEnded({ ...closed, checked_out_at: '2026-10-16T18:30:00Z' })).toBe(false);
    // The end is never later than the expiry.
    expect(checkinEndMs({ expires_at: '2026-10-16T17:40:00Z', checked_out_at: '2026-10-16T18:30:00Z' })).toBe(
      Date.parse('2026-10-16T17:40:00Z'),
    );
  });
});

describe('lapsedCheckinFacts (the "saved late" notice, on the server clock)', () => {
  const T = (hhmm: string) => Date.parse(`2026-10-16T${hhmm}:00Z`);
  const iso = (hhmm: string) => new Date(T(hhmm)).toISOString();
  // Tapped 14:00 (server) for 120 min, stored at 17:05.
  const row = { checked_in_at: iso('14:00'), expires_at: iso('16:00'), created_at: iso('17:05'), checked_out_at: null };

  it('a phone 10 min fast: the tap is the server\'s, so a 2-hour check-in reads as 2 hours', () => {
    const f = lapsedCheckinFacts({ row, tapIso: iso('14:10') });
    expect(f).toEqual({ tapMs: T('14:00'), endedMs: T('16:00'), syncedMs: T('17:05'), checkedOut: false, checkInAgain: true });
    // The device's tap only when the row has none.
    expect(lapsedCheckinFacts({ row: { ...row, checked_in_at: undefined }, tapIso: iso('14:10') }).tapMs).toBe(T('14:10'));
  });

  it('checked out here while it was still queued: that check-out is the end (moved onto the server clock), no "check in again"', () => {
    // Phone 10 min fast: tapped 14:10 and checked out 15:00 on the phone = 14:50 on the server.
    const f = lapsedCheckinFacts({ row, tapIso: iso('14:10'), leftAtMs: T('15:00') });
    expect(f).toEqual({ tapMs: T('14:00'), endedMs: T('14:50'), syncedMs: T('17:05'), checkedOut: true, checkInAgain: false });
  });

  it('checked out here after it had ended anyway: ended at its expiry, still no "check in again"', () => {
    const f = lapsedCheckinFacts({ row, tapIso: iso('14:00'), leftAtMs: T('16:30') });
    expect(f).toEqual({ tapMs: T('14:00'), endedMs: T('16:00'), syncedMs: T('17:05'), checkedOut: false, checkInAgain: false });
  });

  it('its check-out reached Pickleague first: the server\'s check-out is the end', () => {
    const f = lapsedCheckinFacts({ row: { ...row, expires_at: iso('18:00'), checked_out_at: iso('15:00') }, tapIso: iso('14:00') });
    expect(f).toEqual({ tapMs: T('14:00'), endedMs: T('15:00'), syncedMs: T('17:05'), checkedOut: true, checkInAgain: false });
  });

  it('a newer check-in of mine is current: no "check in again"', () => {
    expect(lapsedCheckinFacts({ row, tapIso: iso('14:00'), newerCheckin: true }).checkInAgain).toBe(false);
  });
});

describe('waitUntilSent (a queued check-in or Start goes before what closes it)', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('kicks the queue, then returns as soon as it has gone', async () => {
    const c = clock();
    const kick = vi.fn();
    let polls = 0;
    const sent = await waitUntilSent({ kick, stillQueued: async () => ++polls < 3, ms: 3_000, nowMs: c.now, sleep: c.sleep });
    expect(sent).toBe(true);
    expect(kick).toHaveBeenCalledTimes(1);
    expect(polls).toBe(3);
    expect(c.now()).toBe(400);
  });

  it('gives up after `ms` while it is still queued (offline, or another account\'s queue)', async () => {
    const c = clock();
    const sent = await waitUntilSent({ kick: () => {}, stillQueued: async () => true, ms: CHECKOUT_FIX_WAIT_MS, nowMs: c.now, sleep: c.sleep });
    expect(sent).toBe(false);
    expect(c.now()).toBe(CHECKOUT_FIX_WAIT_MS);
  });

  it('never throws: a failing kick or read ends the wait', async () => {
    const c = clock();
    await expect(
      waitUntilSent({
        kick: () => {
          throw new Error('no queue');
        },
        stillQueued: async () => {
          throw new Error('storage');
        },
        ms: 3_000,
        nowMs: c.now,
        sleep: c.sleep,
      }),
    ).resolves.toBe(true);
  });
});

describe('rejectedCheckinNotice', () => {
  it('explains the old 2-minute rule only when an older server refused the wait, then what to do', () => {
    const text = rejectedCheckinNotice({
      venueName: 'Lakeside',
      timeLabel: '5:40 PM',
      waitedTooLong: true,
      error: { message: "Your location is out of date: it's more than 2 minutes old. Try again at the court." },
    });
    expect(text).toBe(
      "Your check-in at Lakeside (5:40 PM) didn't go through. It reached Pickleague more than 2 minutes after you tapped, too late to confirm you were there. Check in again when you're at the court.",
    );
  });

  it('a check-in an older build saved without a fix gets its own reason (never the 2-minute one)', () => {
    expect(
      rejectedCheckinNotice({ venueName: 'Lakeside', timeLabel: '5:40 PM', waitedTooLong: true, noFix: true, error: null }),
    ).toBe(
      "Your check-in at Lakeside (5:40 PM) didn't go through. It was saved by an older version of Pickleague without your location. Check in again at the court.",
    );
  });

  it('synced over 12 hours after the tap: says so (the tap time is in the first sentence)', () => {
    expect(
      rejectedCheckinNotice({
        venueName: 'Lakeside',
        timeLabel: '5:40 AM',
        waitedTooLong: false,
        error: { message: 'This check-in was saved with no signal at ...', hint: 'pl:checkin.too_old', details: '{"tapped_at": "2026-10-16T12:40:00Z", "limit_hours": 12}' },
      }),
    ).toBe(
      "Your check-in at Lakeside (5:40 AM) didn't go through. It reached Pickleague more than 12 hours after you tapped, too late to count. Check in again when you're at the court.",
    );
  });

  it('over 12 hours late is always another day\'s tap: the notice gives its day (device zone)', () => {
    const now = new Date(2026, 9, 16, 9, 0).getTime(); // Fri 9:00 AM
    expect(
      rejectedCheckinNotice({
        venueName: 'Lakeside',
        tapMs: new Date(2026, 9, 14, 17, 40).getTime(), // Wed 5:40 PM
        nowMs: now,
        waitedTooLong: false,
        error: { message: 'This check-in was saved with no signal at ...', hint: 'pl:checkin.too_old' },
      }),
    ).toBe(
      "Your check-in at Lakeside (Wed 5:40 PM) didn't go through. It reached Pickleague more than 12 hours after you tapped, too late to count. Check in again when you're at the court.",
    );
  });

  it('a fix taken over 2 minutes after the tap: says so', () => {
    expect(
      rejectedCheckinNotice({
        venueName: 'Lakeside',
        timeLabel: '5:40 PM',
        waitedTooLong: false,
        error: { message: 'Your location was taken ...', hint: 'pl:fix.after_tap' },
      }),
    ).toBe(
      "Your check-in at Lakeside (5:40 PM) didn't go through. Your location was taken more than 2 minutes after you tapped, so it can't show you were at the court then. Check in again when you're at the court.",
    );
  });

  it("not at the court with an old fix: the distance, never the 2-minute reason", () => {
    // The code and its DETAIL (migration_refusal_messages.sql)...
    expect(
      rejectedCheckinNotice({
        venueName: 'Lakeside',
        timeLabel: '5:40 PM',
        waitedTooLong: false,
        error: { message: 'You need to be at the court to check in. ...', hint: 'pl:fix.not_at_court', details: '{"distance_m": 240}' },
      }),
    ).toBe(
      "Your check-in at Lakeside (5:40 PM) didn't go through. You're about 240 m from Lakeside. You need to be at the court to check in, so try again when you get there.",
    );
    // ...or an older server's text.
    expect(
      rejectedCheckinNotice({
        venueName: 'Lakeside',
        timeLabel: '5:40 PM',
        waitedTooLong: false,
        error: { message: 'You need to be at the court to check in (about 240 m away).' },
      }),
    ).toBe(
      "Your check-in at Lakeside (5:40 PM) didn't go through. You're about 240 m from Lakeside. You need to be at the court to check in, so try again when you get there.",
    );
    expect(rejectedCheckinNotice({ venueName: 'Lakeside', timeLabel: '5:40 PM', waitedTooLong: false, error: null })).toBe(
      "Your check-in at Lakeside (5:40 PM) didn't go through. Check in again when you're at the court.",
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
