// Is the Exit real? (lib/courtArrivalRules, 2026-11-06): The Hub at 10:37,
// where the resync's re-report cancelled an arrival 4 seconds after it queued.
import { describe, expect, it } from 'vitest';
import {
  circleVerdict,
  decideExit,
  needsRegistration,
  REREGISTER_AFTER_MS,
  NEARBY_REFRESH_REGION_ID,
  regionsSignature,
} from '../courtArrivalRules';

const court = { lat: 37.7749, lng: -122.2766, radiusM: 100 };
// About 1 m of latitude.
const north = (m: number) => court.lat + m / 111_195;

describe('circleVerdict', () => {
  it('is in only when the whole accuracy circle is inside, out only when wholly outside', () => {
    expect(circleVerdict({ lat: court.lat, lng: court.lng, accuracyM: 10 }, court)).toBe('in');
    expect(circleVerdict({ lat: north(95), lng: court.lng, accuracyM: 20 }, court)).toBe('unknown');
    expect(circleVerdict({ lat: north(300), lng: court.lng, accuracyM: 20 }, court)).toBe('out');
    expect(circleVerdict({ lat: north(110), lng: court.lng, accuracyM: 50 }, court)).toBe('unknown');
  });
  it('says nothing without a reading or a circle', () => {
    expect(circleVerdict(null, court)).toBeNull();
    expect(circleVerdict({ lat: court.lat, lng: court.lng, accuracyM: 5 }, null)).toBeNull();
  });
});

describe('decideExit', () => {
  it("sets aside the resync's false Exit at The Hub (inside, right after registering)", () => {
    expect(decideExit({ previous: 'in', nearSync: true, verdict: 'in' })).toBe('ignore');
    expect(decideExit({ previous: 'in', nearSync: true, verdict: null })).toBe('ignore');
    expect(decideExit({ previous: 'in', nearSync: true, verdict: 'unknown' })).toBe('ignore');
  });
  it('lets a real departure through', () => {
    expect(decideExit({ previous: 'in', nearSync: true, verdict: 'out' })).toBe('go');
    expect(decideExit({ previous: 'in', nearSync: false, verdict: 'out' })).toBe('go');
    expect(decideExit({ previous: 'in', nearSync: false, verdict: null })).toBe('go');
    expect(decideExit({ previous: 'in', nearSync: false, verdict: 'unknown' })).toBe('go');
  });
  it('sets aside any Exit a reading puts on the court', () => {
    expect(decideExit({ previous: 'in', nearSync: false, verdict: 'in' })).toBe('ignore');
  });
  it("passes the re-report of 'outside' through (nothing to take back)", () => {
    expect(decideExit({ previous: 'out', nearSync: true, verdict: 'in' })).toBe('go');
    expect(decideExit({ previous: undefined, nearSync: true, verdict: null })).toBe('go');
  });
});

describe('needsRegistration', () => {
  const a = [{ id: 'hub', lat: 37.7, lng: -122.2, radiusM: 100 }, { id: 'park', lat: 37.8, lng: -122.3, radiusM: 150 }];
  const sig = regionsSignature(a);
  it('ignores order', () => {
    expect(regionsSignature([...a].reverse())).toBe(sig);
  });
  it("doesn't count where the refresh circle is, which moves with the phone", () => {
    const at = (lat: number, radiusM: number) => [...a, { id: NEARBY_REFRESH_REGION_ID, lat, lng: -122.2, radiusM }];
    expect(regionsSignature(at(37.7, 400))).toBe(regionsSignature(at(37.70001, 500)));
    expect(regionsSignature(at(37.7, 400))).not.toBe(sig);
  });
  it('skips the same courts while the OS still watches them', () => {
    expect(needsRegistration({ signature: sig, last: { signature: sig, atMs: 0 }, running: true, nowMs: 60_000 })).toBe(false);
  });
  it('registers a changed list, a stopped watch, a first sync, or after 6 hours', () => {
    const changed = regionsSignature([{ ...a[0], radiusM: 120 }, a[1]]);
    expect(needsRegistration({ signature: changed, last: { signature: sig, atMs: 0 }, running: true, nowMs: 1 })).toBe(true);
    expect(needsRegistration({ signature: sig, last: { signature: sig, atMs: 0 }, running: false, nowMs: 1 })).toBe(true);
    expect(needsRegistration({ signature: sig, last: null, running: true, nowMs: 1 })).toBe(true);
    expect(needsRegistration({ signature: sig, last: { signature: sig, atMs: 0 }, running: true, nowMs: REREGISTER_AFTER_MS })).toBe(true);
  });
});
