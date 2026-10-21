import { describe, expect, it } from 'vitest';
// The real foundation buildRegions, as courtArrivalRules.test.ts does.
import { buildRegions } from '../../../node_modules/@just-messin-around/expo-foundation/src/tracking/buildRegions';
import {
  arrivalLocalSchedule,
  buildCourtRegionList,
  decideArrival,
  DEFAULT_COURT_ARRIVAL_SETTINGS,
  mergeCourtRegion,
  ROUTINE_TIER,
  routineTierRegions,
  showWhileAppActive,
  STARRED_TIER,
  starredTierRegions,
  WALLET_TIER,
  walletTierRegions,
  type ArrivalFacts,
  type CourtArrivalSettings,
  type CourtRegionInfo,
  type RoutineRegionSource,
  type StarredCourtGeofence,
  type WalletRegionSource,
} from '../courtArrivalRules';
import {
  checkinLengthOptions,
  parseCourtPlayModes,
  parseCourtRoutine,
  playerModeLine,
  playModeNowLine,
  routineArrivalDue,
  routineDueAt,
  routinePlannedEndAt,
  routineTimeLine,
  routineWindowsLine,
  switchToOpenWindows,
  type CourtRoutine,
} from '../courtRoutineRules';
import { crowdLineText } from '../courtCrowd';
import { refusalCode, refusalMessage, windowsProblemCopy } from '../refusals';

const TZ = 'America/Los_Angeles';

/** A routine at Lakeside, Tue/Thu (2 + 8) 9:00 in Los Angeles, 3 h, closed then open. */
function routine(over: Partial<CourtRoutine> = {}): CourtRoutine {
  const r = parseCourtRoutine({
    ...rawBase(),
    windows: [
      { start_min: 0, end_min: 90, mode: 'closed', hint: 'friends', group: ['f1'] },
      { start_min: 90, end_min: 180, mode: 'open', hint: null, group: [] },
    ],
  });
  return { ...r, ...over };
}

// Tuesday 2026-10-20, 9:00 PDT = 16:00Z.
const TUE_9 = new Date('2026-10-20T16:00:00Z');
const at = (min: number) => new Date(TUE_9.getTime() + min * 60_000);

describe('routineDueAt (Doggle routineStopDueAt, -30 / +30)', () => {
  it('is due from 30 minutes before to 30 minutes after, on its days only', () => {
    const r = [routine()];
    expect(routineDueAt(r, 'v1', at(-30))?.routine.id).toBe('r1');
    expect(routineDueAt(r, 'v1', at(30))?.dueAt.toISOString()).toBe(TUE_9.toISOString());
    expect(routineDueAt(r, 'v1', at(-31))).toBeNull();
    expect(routineDueAt(r, 'v1', at(31))).toBeNull();
    // Wednesday: not one of its days.
    expect(routineDueAt(r, 'v1', at(24 * 60))).toBeNull();
    // Another court.
    expect(routineDueAt(r, 'v2', TUE_9)).toBeNull();
  });

  it('a skipped day opens no window; a moved day opens at its new time', () => {
    // As the server sends it (snake_case).
    const raw = (status: string, plannedAt: string) =>
      parseCourtRoutine({
        ...rawBase(),
        occurrences: [{ plan_id: 'p1', planned_at: plannedAt, planned_end_at: null, status }],
      });
    expect(routineDueAt([raw('cancelled', TUE_9.toISOString())], 'v1', TUE_9)).toBeNull();
    const moved = raw('planned', at(120).toISOString());
    expect(routineDueAt([moved], 'v1', TUE_9)).toBeNull();
    expect(routineDueAt([moved], 'v1', at(110))?.planId).toBe('p1');
  });

  it('a paused routine, or one at a court no longer starred, is never due', () => {
    expect(routineDueAt([routine({ active: false })], 'v1', TUE_9)).toBeNull();
    expect(routineDueAt([parseCourtRoutine({ ...rawBase(), starred: false })], 'v1', TUE_9)).toBeNull();
  });

  it('routineArrivalDue: off when "Check me in at my routine courts" is off; unreadable counts as on', () => {
    const r = [routine()];
    expect(routineArrivalDue(r, 'v1', null, TUE_9)).toBe(true);
    expect(routineArrivalDue(r, 'v1', true, TUE_9)).toBe(true);
    expect(routineArrivalDue(r, 'v1', false, TUE_9)).toBe(false);
    expect(routineArrivalDue(null, 'v1', true, TUE_9)).toBe(false);
  });

  it('the planned end: the occurrence\'s, else the time plus the length', () => {
    expect(routinePlannedEndAt([routine()], 'v1', TUE_9)).toBe(at(180).toISOString());
    const withOcc = parseCourtRoutine({
      ...rawBase(),
      occurrences: [{ plan_id: 'p1', planned_at: TUE_9.toISOString(), planned_end_at: at(150).toISOString(), status: 'planned' }],
    });
    expect(routinePlannedEndAt([withOcc], 'v1', TUE_9)).toBe(at(150).toISOString());
    expect(routinePlannedEndAt([withOcc], 'v1', at(200))).toBeNull();
  });
});

function rawBase() {
  return {
    id: 'r1', venue_id: 'v1', venue_name: 'Lakeside', lat: 37.8, lng: -122.2, starred: true, auto_checkin: true,
    local_time: '09:00', days: 2 | 8, tz: TZ, length_min: 180, windows: [], active: true,
  };
}

// ── decideArrival: the routine fact ──────────────────────────────────────────
const ROUTINE_INFO: CourtRegionInfo = { name: 'Lakeside', starred: true, autoCheckin: true, routine: true };
const settings = (over: Partial<CourtArrivalSettings> = {}): CourtArrivalSettings => ({
  ...DEFAULT_COURT_ARRIVAL_SETTINGS,
  consent_seen: true,
  ...over,
});
const facts = (over: Partial<ArrivalFacts> = {}): ArrivalFacts => ({
  arrival: true,
  info: ROUTINE_INFO,
  settings: settings(),
  arrivedRecently: false,
  promptedRecently: false,
  playSessionActive: false,
  consent: 'yes',
  walletThrottled: false,
  ...over,
});

describe('decideArrival with a routine stop due', () => {
  it('checks in even with "Check me in when I arrive" off (Doggle :334-359)', () => {
    expect(decideArrival(facts({ settings: settings({ auto_checkin: false }) }))).toMatchObject({ action: 'prompt' });
    expect(decideArrival(facts({ settings: settings({ auto_checkin: false }), routineDue: true }))).toMatchObject({
      action: 'queue',
    });
  });

  it('checks in even with "Notice me at starred courts" Off', () => {
    expect(decideArrival(facts({ settings: settings({ court_radius_m: 0 }) }))).toMatchObject({ action: 'quiet' });
    expect(decideArrival(facts({ settings: settings({ court_radius_m: 0 }), routineDue: true }))).toMatchObject({
      action: 'queue',
    });
  });

  it('still asks during a play session, without consent, and stays quiet on a re-report or a covering prompt', () => {
    expect(decideArrival(facts({ routineDue: true, playSessionActive: true }))).toMatchObject({ action: 'prompt' });
    expect(decideArrival(facts({ routineDue: true, consent: 'no' }))).toMatchObject({ action: 'prompt', reason: 'no_consent' });
    expect(decideArrival(facts({ routineDue: true, promptedRecently: true }))).toMatchObject({ action: 'quiet' });
    expect(
      decideArrival(facts({ routineDue: true, arrival: false, arrivedRecently: true, settings: settings({ auto_checkin: false }) })),
    ).toMatchObject({ action: 'prompt' });
    expect(decideArrival(facts({ routineDue: true, arrival: false, arrivedRecently: true }))).toMatchObject({
      action: 'quiet',
      why: 're_report',
    });
  });

  it('a court switched off still queues (the server answers off_here and the phone asks)', () => {
    expect(decideArrival(facts({ routineDue: true, info: { ...ROUTINE_INFO, autoCheckin: false } }))).toMatchObject({
      action: 'queue',
    });
  });
});

// ── Regions: routine courts first ────────────────────────────────────────────
describe('routine courts are fenced first', () => {
  const pass = (regionId: string, passId: string, name = 'Club'): WalletRegionSource => ({
    regionId,
    passId,
    name,
    lat: 1,
    lng: 2,
  });
  const star = (id: string, over: Partial<StarredCourtGeofence> = {}): StarredCourtGeofence => ({
    venue_id: id,
    name: `Court ${id}`,
    lat: 3,
    lng: 4,
    radius_m: null,
    auto_checkin: true,
    ...over,
  });
  const rt = (id: string, over: Partial<RoutineRegionSource> = {}): RoutineRegionSource => ({
    venueId: id,
    name: `Court ${id}`,
    lat: 3,
    lng: 4,
    radiusM: null,
    autoCheckin: true,
    live: true,
    ...over,
  });

  async function build(routine: RoutineRegionSource[], wallet: WalletRegionSource[], starred: StarredCourtGeofence[], radius = 100) {
    const built = await buildRegions(
      [
        { name: ROUTINE_TIER, load: () => routineTierRegions(routine) },
        { name: WALLET_TIER, load: () => walletTierRegions(wallet) },
        { name: STARRED_TIER, required: true, load: () => starredTierRegions(starred, radius) },
      ],
      { merge: mergeCourtRegion },
    );
    return buildCourtRegionList(built, { wallet, starred, routine });
  }

  it('routine tier: one per court, outline else 150 m, live only', () => {
    expect(
      routineTierRegions([rt('a'), rt('a'), rt('b', { radiusM: 90 }), rt('c', { live: false }), rt('d', { lat: null })]),
    ).toEqual([
      { id: 'a', lat: 3, lng: 4, radiusM: 150 },
      { id: 'b', lat: 3, lng: 4, radiusM: 90 },
    ]);
  });

  it('routine courts come before wallet and starred courts, and are starred routine courts in the info', async () => {
    const { regions, info } = await build([rt('s2')], [pass('w1', 'p1')], [star('s1'), star('s2')]);
    expect(regions.map((r) => r.id)).toEqual(['s2', 'w1', 's1']);
    expect(info[0]).toEqual({ id: 's2', name: 'Court s2', starred: true, autoCheckin: true, routine: true });
    expect(info[2]).toEqual({ id: 's1', name: 'Court s1', starred: true, autoCheckin: true });
  });

  it('with "Notice me at starred courts" Off the routine court is still fenced (150 m)', async () => {
    const { regions, info } = await build([rt('s2', { autoCheckin: false })], [], [star('s2')], 0);
    expect(regions).toEqual([{ id: 's2', lat: 3, lng: 4, radiusM: 150 }]);
    expect(info[0]).toMatchObject({ starred: true, autoCheckin: false, routine: true });
  });

  it('kept first when the 20 run out', async () => {
    const many = Array.from({ length: 22 }, (_, i) => star(`s${i}`));
    const { regions } = await build([rt('r1')], [], many);
    expect(regions).toHaveLength(20);
    expect(regions[0].id).toBe('r1');
  });
});

// ── The phone's own "Checked in" / "Still at" for a routine arrival ──────────
describe('arrivalLocalSchedule with a planned end', () => {
  const due = '2026-10-20T16:01:00.000Z'; // arrived 16:00
  it('ends at the planned end when it comes first, never under 30 minutes', () => {
    expect(arrivalLocalSchedule(due, '2026-10-20T17:30:00.000Z')?.expiresAtIso).toBe('2026-10-20T17:30:00.000Z');
    expect(arrivalLocalSchedule(due, '2026-10-20T16:10:00.000Z')?.expiresAtIso).toBe('2026-10-20T16:30:00.000Z');
    expect(arrivalLocalSchedule(due, '2026-10-20T19:00:00.000Z')?.expiresAtIso).toBe('2026-10-20T18:00:00.000Z');
    expect(arrivalLocalSchedule(due, null)?.expiresAtIso).toBe('2026-10-20T18:00:00.000Z');
  });
});

// ── Words ────────────────────────────────────────────────────────────────────
describe('routine and window copy', () => {
  it('a routine as a line, and its windows from its start', () => {
    const r = routine();
    expect(routineTimeLine(r)).toBe('Tue, Thu · 9 AM · 3 h');
    expect(routineWindowsLine(r)).toBe('9 AM–10:30 AM Closed group · 10:30 AM–12 PM Open play');
    expect(routineWindowsLine({ localTime: '09:00', windows: [] })).toBe('');
    expect(routineWindowsLine({ localTime: '09:00', windows: [{ startMin: 0, endMin: 60, mode: null }] })).toBe('');
  });

  it('the mode now, as the server words it', () => {
    const abs = [
      { startsAt: at(0).toISOString(), endsAt: at(90).toISOString(), mode: 'closed' as const },
      { startsAt: at(90).toISOString(), endsAt: at(180).toISOString(), mode: 'open' as const },
    ];
    expect(playModeNowLine(abs, at(10), TZ)).toBe('Closed group until 10:30 AM, then open play');
    expect(playModeNowLine(abs, at(100), TZ)).toBe('Open play until 12 PM');
    expect(playModeNowLine(abs, at(200), TZ)).toBe('');
  });

  it('a roster row: open until, closed with names (first names) or not, open from', () => {
    const base = { modeUntil: at(90).toISOString(), nextOpenAt: null, closedGroup: [] };
    expect(playerModeLine({ ...base, modeNow: 'open' }, TZ)).toBe('Open to play until 10:30 AM');
    expect(playerModeLine({ ...base, modeNow: 'closed', closedGroup: [{ userId: 'a', fullName: 'Ann Lee' }, { userId: 'b', fullName: 'Bob' }] }, TZ)).toBe(
      'Closed group with Ann, Bob',
    );
    expect(playerModeLine({ ...base, modeNow: 'closed', nextOpenAt: at(90).toISOString() }, TZ)).toBe(
      'Closed group · open from 10:30 AM',
    );
    expect(playerModeLine({ ...base, modeNow: null }, TZ)).toBe('');
  });

  it('court_play_modes parsed, counts floored at 0', () => {
    const m = parseCourtPlayModes({
      open_now: 2,
      closed_now: -1,
      players: [{ checkin_id: 'c1', user_id: 'u1', mode_now: 'open', mode_until: null, closed_group: null }],
    });
    expect(m).toMatchObject({ openNow: 2, closedNow: 0, unsaidNow: 0 });
    expect(m.players[0]).toMatchObject({ checkinId: 'c1', modeNow: 'open', closedGroup: [] });
  });

  it('crowd line: "N here · M open to play" only with the number', () => {
    const crowd = { here_now: 6, band_low: 3.5, band_high: 4, friends_here: 0 };
    expect(crowdLineText(crowd)).toBe('6 playing now · mostly 3.5–4.0');
    expect(crowdLineText(crowd, null, { openNow: 4 })).toBe('6 here · 4 open to play · mostly 3.5–4.0');
    expect(crowdLineText(crowd, null, { openNow: 0 })).toBe('6 here · mostly 3.5–4.0');
    expect(crowdLineText(crowd, null, { openNow: 9 })).toBe('6 here · 6 open to play · mostly 3.5–4.0');
  });

  it('windows.bad: which window, and what is wrong', () => {
    expect(windowsProblemCopy('too_short', 1)).toBe('Play window 2 is too short: each one needs at least 15 minutes.');
    expect(windowsProblemCopy('gap', 2)).toMatch(/whole time/);
    expect(windowsProblemCopy('group_too_big', 0)).toMatch(/at most 7/);
    expect(windowsProblemCopy('something_new')).toMatch(/Update Pickleague/);
    const e = { message: 'x', hint: 'pl:windows.bad', details: '{"problem":"off_step","index":0}' };
    expect(refusalCode(e)).toBe('windows.bad');
    expect(refusalMessage(e)).toBe("Play window 1 doesn't start and end on a quarter hour. Move its ends, then save.");
    expect(refusalMessage({ hint: 'pl:routine.not_starred' }, { venueName: 'Lakeside' })).toBe(
      'Routines are for your starred courts. Star Lakeside first, then add it to your routine.',
    );
    expect(refusalMessage({ hint: 'pl:checkin.none' }, { action: 'plan' })).toMatch(/nothing to plan/);
  });
});

// ── A check-in's plan ────────────────────────────────────────────────────────
describe('check-in plan helpers', () => {
  it('lengths whose end is at least 15 minutes away', () => {
    const start = at(0).toISOString();
    expect(checkinLengthOptions(start, at(0).getTime())).toEqual([60, 90, 120, 180, 240]);
    expect(checkinLengthOptions(start, at(100).getTime())).toEqual([120, 180, 240]);
  });

  it('switch to open play now: cut at now, the rest open; null when open already', () => {
    const abs = [
      { startsAt: at(0).toISOString(), endsAt: at(90).toISOString(), mode: 'closed' as const, hint: null, group: [] },
      { startsAt: at(90).toISOString(), endsAt: at(180).toISOString(), mode: 'open' as const, hint: null, group: [] },
    ];
    const next = switchToOpenWindows(abs, at(0).toISOString(), at(180).toISOString(), at(30));
    expect(next?.map((w) => [w.startsAt, w.endsAt, w.mode])).toEqual([
      [at(0).toISOString(), at(30).toISOString(), 'closed'],
      [at(30).toISOString(), at(180).toISOString(), 'open'],
    ]);
    expect(switchToOpenWindows(abs, at(0).toISOString(), at(180).toISOString(), at(100))).toBeNull();
    // Nothing said: not said until now, open after.
    expect(switchToOpenWindows([], at(0).toISOString(), at(120).toISOString(), at(20))?.map((w) => w.mode)).toEqual([null, 'open']);
    // Just checked in: open from the start.
    expect(switchToOpenWindows([], at(0).toISOString(), at(120).toISOString(), at(0))?.map((w) => [w.startsAt, w.mode])).toEqual([
      [at(0).toISOString(), 'open'],
    ]);
  });
});

describe('routine pushes', () => {
  it('"Staying until" stays quiet while the app is open, like the other arrival pushes', () => {
    expect(showWhileAppActive({ kind: 'arrival_extend_until' })).toBe(false);
    expect(showWhileAppActive({ kind: 'routine_reminder' })).toBe(true);
  });
});
