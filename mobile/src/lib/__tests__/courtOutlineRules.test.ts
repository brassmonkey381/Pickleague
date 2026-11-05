import { describe, expect, it } from 'vitest';
import {
  arrivalCheckinOn,
  decideArrival,
  decideOutlineGate,
  DEFAULT_COURT_ARRIVAL_SETTINGS,
  isOutlineGeometry,
  MAX_REGION_RADIUS_M,
  nearbyCandidates,
  otherCourtsOn,
  PL_OUTLINE_RULE,
  type ArrivalFacts,
  type CourtArrivalSettings,
  type CourtRegionInfo,
} from '../courtArrivalRules';

const settings = (over: Partial<CourtArrivalSettings> = {}): CourtArrivalSettings => ({
  ...DEFAULT_COURT_ARRIVAL_SETTINGS,
  consent_seen: true,
  ...over,
});

const NEARBY: CourtRegionInfo = { name: 'Park Courts', starred: false, autoCheckin: false, nearby: true };

const facts = (over: Partial<ArrivalFacts> = {}): ArrivalFacts => ({
  arrival: true,
  info: NEARBY,
  settings: settings({ other_court_radius_m: 100 }),
  arrivedRecently: false,
  promptedRecently: false,
  playSessionActive: false,
  consent: 'yes',
  walletThrottled: false,
  ...over,
});

// About 100 m square at 40 N (0.0009 deg lat, 0.0012 deg lng).
const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [[[-100.0006, 39.99955], [-99.9994, 39.99955], [-99.9994, 40.00045], [-100.0006, 40.00045], [-100.0006, 39.99955]]],
};

// judgeFix with PL_OUTLINE_RULE is the foundation's (tested there); its
// /tracking barrel loads React Native, so it can't run under vitest here.
describe('PL_OUTLINE_RULE', () => {
  it("matches _pl_check_fix's slack cap and precision, with a tight edge for court outlines", () => {
    expect(PL_OUTLINE_RULE).toEqual({ edgeM: 25, maxSlackM: 75, maxAccuracyM: 150 });
  });
});

describe('isOutlineGeometry', () => {
  it('takes Polygon and MultiPolygon only', () => {
    expect(isOutlineGeometry(SQUARE)).toBe(true);
    expect(isOutlineGeometry({ type: 'MultiPolygon', coordinates: [SQUARE.coordinates] })).toBe(true);
    expect(isOutlineGeometry({ type: 'GeometryCollection', geometries: [] })).toBe(false);
    expect(isOutlineGeometry({ type: 'Polygon', coordinates: [] })).toBe(false);
    expect(isOutlineGeometry(null)).toBe(false);
  });
});

describe('the outline gate (decideOutlineGate)', () => {
  it('a court with no outline keeps the circle', () => {
    expect(decideOutlineGate({ hasOutline: false, verdict: null, arrival: true })).toBe('go');
  });

  it('on the outline, or unjudgeable: go on', () => {
    expect(decideOutlineGate({ hasOutline: true, verdict: 'in', arrival: true })).toBe('go');
    expect(decideOutlineGate({ hasOutline: true, verdict: 'unknown', arrival: false })).toBe('go');
  });

  it('off the outline or no reading: a real arrival watches, a re-report stays quiet', () => {
    expect(decideOutlineGate({ hasOutline: true, verdict: 'out', arrival: true })).toBe('watch');
    expect(decideOutlineGate({ hasOutline: true, verdict: null, arrival: true })).toBe('watch');
    expect(decideOutlineGate({ hasOutline: true, verdict: 'out', arrival: false })).toBe('quiet');
  });

  it("the arrival watch's own call is already on the outline", () => {
    expect(decideOutlineGate({ hasOutline: true, verdict: null, arrival: true, fromWatch: true })).toBe('go');
  });
});

describe('a nearby court in a spare slot (decideArrival)', () => {
  it('asks on a real arrival, never queues a check-in', () => {
    expect(decideArrival(facts())).toEqual({ mark: true, action: 'prompt' });
  });

  it('quiet on a re-report, with "Ask me at other courts" off, after a prompt, or in a play session', () => {
    expect(decideArrival(facts({ arrival: false }))).toMatchObject({ action: 'quiet', why: 'nearby_re_report' });
    expect(decideArrival(facts({ settings: settings({ other_court_radius_m: 0 }) }))).toMatchObject({
      action: 'quiet',
      why: 'nearby_off',
    });
    expect(decideArrival(facts({ promptedRecently: true }))).toMatchObject({ action: 'quiet', why: 'prompt_covers' });
    expect(decideArrival(facts({ playSessionActive: true }))).toMatchObject({ action: 'quiet', why: 'play_session' });
  });

  it('unreadable settings: asks (it was only fenced with the switch on)', () => {
    expect(decideArrival(facts({ settings: null }))).toEqual({ mark: true, action: 'prompt' });
  });
});

describe('nearbyCandidates', () => {
  it('keeps outlined rows, clamps the circle, carries the distance', () => {
    const rows = [
      { venue_id: 'a', name: 'A', lat: 1, lng: 2, radius_m: 2000, distance_m: 300, outline: SQUARE },
      { venue_id: 'b', name: 'B', lat: 1, lng: 2, radius_m: 120, distance_m: 0, outline: null },
    ];
    expect(nearbyCandidates(rows)).toEqual([{ id: 'a', lat: 1, lng: 2, radiusM: MAX_REGION_RADIUS_M, distanceM: 300 }]);
  });
});

describe('the three switches', () => {
  it('"Check me in when I arrive" needs the starred courts watched', () => {
    expect(arrivalCheckinOn(settings())).toBe(true);
    expect(arrivalCheckinOn(settings({ auto_checkin: false }))).toBe(false);
    expect(arrivalCheckinOn(settings({ court_radius_m: 0 }))).toBe(false);
  });

  it('"Ask me when I\'m at other courts" is any saved distance', () => {
    expect(otherCourtsOn(settings())).toBe(false);
    expect(otherCourtsOn(settings({ other_court_radius_m: 250 }))).toBe(true);
  });
});
