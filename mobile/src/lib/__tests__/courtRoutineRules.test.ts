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
import { applyWindowEdit, modeAt, windowsToAbsolute, type TimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import {
  buttonCheckinMinutes,
  DEFAULT_CHECKIN_MINUTES,
  routineDueWithoutOccurrence,
  routineOccurrenceEndAt,
  checkinLengthOptions,
  checkinPlanEditorWindows,
  checkinPlanLine,
  checkinPlanSheetStart,
  checkinPlanStartLength,
  checkinPlanToSave,
  checkinPlanWindowsToSave,
  fitCheckinPlanWindows,
  parseCourtPlayModes,
  parseCourtRoutine,
  PLAY_WINDOW_RULES,
  playerModeLine,
  playModeNowLine,
  routineArrivalDue,
  routineCheckinMinutes,
  routineCheckinUntil,
  routineDueAt,
  routinePlannedEndAt,
  routineTimeLine,
  routineWindowsLine,
  routineWindowsToSave,
  stayUntilLabel,
  stayUntilOffer,
  switchToOpenPlan,
  switchToOpenWindows,
  type CourtRoutine,
  type PlayMode,
  type RoutineOccurrence,
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

/**
 * `r` with Tuesday's occurrence (`startMin` from 9:00), as
 * list_my_court_routines sends it: the server makes today's while its window
 * is still open (migration_court_routines_planned_end.sql), so a copy read
 * since has it.
 */
function withToday(r: CourtRoutine, startMin = 0, status: RoutineOccurrence['status'] = 'planned'): CourtRoutine {
  const plannedAt = at(startMin);
  const occ: RoutineOccurrence = {
    planId: 'p-today',
    plannedAt: plannedAt.toISOString(),
    plannedEndAt: at(startMin + r.lengthMin).toISOString(),
    status,
    windows: windowsToAbsolute(r.windows, plannedAt),
  };
  return { ...r, occurrences: [occ], next: occ };
}

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

// ── The split: Closed group / Open play over one visit (user report 2026-10-22:
// "the split of closed / open time during a window does not seem to work") ──
describe('the closed / open split, end to end', () => {
  const span = (list: readonly TimeWindow<PlayMode>[] | null) =>
    (list ?? []).map((w) => `${w.startMin}-${w.endMin}:${w.mode}`).join(' ');
  const abs = (s: number, e: number, mode: PlayMode | null) => ({
    startsAt: at(s).toISOString(),
    endsAt: at(e).toISOString(),
    mode,
    hint: null,
    group: [] as string[],
  });
  const absSpan = (list: readonly { startsAt: string; endsAt: string; mode: PlayMode | null }[] | null | undefined) =>
    (list ?? []).map((w) => `${(Date.parse(w.startsAt) - TUE_9.getTime()) / 60_000}-${(Date.parse(w.endsAt) - TUE_9.getTime()) / 60_000}:${w.mode}`).join(' ');

  it('Split in the editor makes two windows, and each can take its own mode (TimeWindowsEditor runs applyWindowEdit)', () => {
    // A new routine: 3 h, nothing said. Before foundation 1.58 the editor merged the
    // two same-mode halves straight back, so Split did nothing.
    let list = applyWindowEdit<PlayMode>([], { type: 'split', index: 0 }, 180, PLAY_WINDOW_RULES);
    expect(span(list)).toBe('0-90:null 90-180:null');
    list = applyWindowEdit(list, { type: 'update', index: 0, patch: { mode: 'closed' } }, 180, PLAY_WINDOW_RULES);
    list = applyWindowEdit(list, { type: 'update', index: 1, patch: { mode: 'open' } }, 180, PLAY_WINDOW_RULES);
    expect(span(list)).toBe('0-90:closed 90-180:open');
    // The check-in sheet starts all Open play: Split, then the first half closed.
    let plan = applyWindowEdit<PlayMode>([{ startMin: 0, endMin: 120, mode: 'open' }], { type: 'split', index: 0 }, 120, PLAY_WINDOW_RULES);
    expect(span(plan)).toBe('0-60:open 60-120:open');
    plan = applyWindowEdit(plan, { type: 'update', index: 0, patch: { mode: 'closed' } }, 120, PLAY_WINDOW_RULES);
    expect(span(plan)).toBe('0-60:closed 60-120:open');
  });

  it('a routine saves its split merged and valid; nothing said saves as none', () => {
    const split = [
      { startMin: 0, endMin: 45, mode: 'closed' as const, hint: null, group: [] },
      { startMin: 45, endMin: 90, mode: 'closed' as const, hint: null, group: [] },
      { startMin: 90, endMin: 180, mode: 'open' as const, hint: null, group: [] },
    ];
    expect(span(routineWindowsToSave(split, 180))).toBe('0-90:closed 90-180:open');
    expect(span(routineWindowsToSave([], 180))).toBe('');
    expect(span(routineWindowsToSave([{ startMin: 0, endMin: 90, mode: null }, { startMin: 90, endMin: 180, mode: null }], 180))).toBe('');
    // Windows from a longer length are fitted to this one.
    expect(span(routineWindowsToSave([{ startMin: 0, endMin: 60, mode: 'closed' }, { startMin: 60, endMin: 240, mode: 'open' }], 120))).toBe(
      '0-60:closed 60-120:open',
    );
  });

  it('a check-in plan saves what the sheet shows: fitted to the chosen length, absolute from the check-in', () => {
    // Closed 1 h, open 1 h, then the length goes from 2 h down to 1.5 h.
    const shown = fitCheckinPlanWindows(
      [
        { startMin: 0, endMin: 60, mode: 'closed', hint: null, group: [] },
        { startMin: 60, endMin: 120, mode: 'open', hint: null, group: [] },
      ],
      90,
    );
    expect(span(shown)).toBe('0-60:closed 60-90:open');
    expect(absSpan(checkinPlanWindowsToSave(shown, 90, at(0).toISOString()))).toBe('0-60:closed 60-90:open');
    // Shorter than the second window's start: it goes (the server refused it as too_short).
    expect(absSpan(checkinPlanWindowsToSave([{ startMin: 0, endMin: 60, mode: 'closed' }, { startMin: 60, endMin: 120, mode: 'open' }], 60, at(0).toISOString()))).toBe(
      '0-60:closed',
    );
    // A split left the same on both sides saves as one; all Not set saves as none ([] clears).
    expect(absSpan(checkinPlanWindowsToSave([{ startMin: 0, endMin: 60, mode: 'open' }, { startMin: 60, endMin: 120, mode: 'open' }], 120, at(0).toISOString()))).toBe(
      '0-120:open',
    );
    expect(checkinPlanWindowsToSave([{ startMin: 0, endMin: 120, mode: null }], 120, at(0).toISOString())).toEqual([]);
  });

  it('the plan sheet opens a routine arrival\'s windows from the check-in, on the 15-minute grid', () => {
    // Routine 9:00-12:00, closed until 10:30. Arrived 9:20; planned end 12:00 (160 min after).
    const windows = [abs(0, 90, 'closed'), abs(90, 180, 'open')];
    const opened = checkinPlanEditorWindows(windows, at(20).toISOString(), 165);
    expect(span(opened)).toBe('0-75:closed 75-165:open');
    // Arrived early (8:45): the closed group starts at the check-in.
    expect(span(checkinPlanEditorWindows(windows, at(-15).toISOString(), 195))).toBe('0-105:closed 105-195:open');
    // A first window that ended before the check-in is gone.
    expect(span(checkinPlanEditorWindows([abs(0, 15, 'closed'), abs(15, 180, 'open')], at(25).toISOString(), 150))).toBe('0-150:open');
    // Nothing planned: all open play (decision 5).
    expect(span(checkinPlanEditorWindows([], at(0).toISOString(), 120))).toBe('0-120:open');
  });

  it('the line under my check-in reads like the server: nothing said, then open play', () => {
    const windows = [abs(0, 60, null), abs(60, 180, 'open')];
    expect(playModeNowLine(windows, at(10), TZ)).toBe('Open play from 10 AM');
    expect(playModeNowLine([abs(0, 60, 'closed'), abs(60, 180, null)], at(10), TZ)).toBe('Closed group until 10 AM');
    // Others see the same on the roster (court_play_modes: mode_now null, next_open_at).
    expect(playerModeLine({ modeNow: null, modeUntil: at(60).toISOString(), nextOpenAt: at(60).toISOString(), closedGroup: [] }, TZ)).toBe(
      'Open to play from 10 AM',
    );
  });

  it('"Switch to open play now" before the first window (an early arrival) opens play now', () => {
    // Routine windows from 9:00; checked in 8:45; at 8:50 the player switches.
    const plan = { checkedInAt: at(-15).toISOString(), plannedEndAt: at(180).toISOString(), expiresAt: at(105).toISOString(), windows: [abs(0, 60, 'closed'), abs(60, 180, 'open')] };
    const next = switchToOpenPlan(plan, at(-10));
    expect(next?.plannedEnd).toBeNull();
    expect(absSpan(next?.windows)).toBe('-15--10:closed -10-180:open');
    expect(modeAt(next!.windows, at(-10))?.mode).toBe('open');
  });

  it('"Switch to open play now" after the planned end (the check-in was extended) moves the plan to the check-in\'s end', () => {
    const plan = { checkedInAt: at(0).toISOString(), plannedEndAt: at(120).toISOString(), expiresAt: at(180).toISOString(), windows: [abs(0, 60, 'open'), abs(60, 120, 'closed')] };
    const next = switchToOpenPlan(plan, at(150));
    expect(next?.plannedEnd?.toISOString()).toBe(at(180).toISOString());
    expect(absSpan(next?.windows)).toBe('0-60:open 60-150:closed 150-180:open');
    // Open already (the last mode carries on): nothing to do.
    expect(switchToOpenPlan({ ...plan, windows: [abs(0, 60, 'closed'), abs(60, 120, 'open')] }, at(150))).toBeNull();
  });

  it('"Switch to open play now" drops a window that ended before the check-in (the server refused it as too_short)', () => {
    const plan = { checkedInAt: at(25).toISOString(), plannedEndAt: at(180).toISOString(), expiresAt: at(145).toISOString(), windows: [abs(0, 15, 'open'), abs(15, 180, 'closed')] };
    const next = switchToOpenPlan(plan, at(40));
    expect(absSpan(next?.windows)).toBe('25-40:closed 40-180:open');
  });
});

// ── A check-in made by hand on a 3-hour split (review of the R14 fix): on the
// web every routine check-in is made by hand; it asked for 2 hours, the server
// left no planned end, and the plan sheet opened at 2 hours without the open
// part ("opens 0-120:closed, then 0-180:closed, saved 0-180:closed"). ──────────
describe('a check-in by hand on a 3-hour split reaches its open part', () => {
  const span = (list: readonly TimeWindow<PlayMode>[] | null) =>
    (list ?? []).map((w) => `${w.startMin}-${w.endMin}:${w.mode}`).join(' ');
  const abs = (s: number, e: number, mode: PlayMode | null) => ({
    startsAt: at(s).toISOString(),
    endsAt: at(e).toISOString(),
    mode,
    hint: null,
    group: [] as string[],
  });
  const absSpan = (list: readonly { startsAt: string; endsAt: string; mode: PlayMode | null }[]) =>
    list.map((w) => `${(Date.parse(w.startsAt) - TUE_9.getTime()) / 60_000}-${(Date.parse(w.endsAt) - TUE_9.getTime()) / 60_000}:${w.mode}`).join(' ');
  // The routine 9:00-12:00, closed group 2 h, then open play 1 h.
  const split = () =>
    routine({
      windows: [
        { startMin: 0, endMin: 120, mode: 'closed', hint: null, group: [] },
        { startMin: 120, endMin: 180, mode: 'open', hint: null, group: [] },
      ],
    });
  // Checked in by hand at 8:50 with 2 hours asked, as the review's live probe:
  // the occurrence's windows, no planned end (the server before
  // migration_court_routines_planned_end.sql).
  const oldCheckin = {
    checkedInAt: at(-10).toISOString(),
    expiresAt: at(110).toISOString(),
    plannedEndAt: null as string | null,
    windows: [abs(0, 120, 'closed'), abs(120, 180, 'open')],
  };

  it('a check-in by hand asks for the routine\'s length: to its planned end, 2 to 4 hours', () => {
    // Today's occurrence in my copy (the server makes it; round 3 needs it).
    const r = [withToday(split())];
    expect(routineCheckinMinutes(r, 'v1', at(-10))).toBe(190);
    expect(routineCheckinMinutes(r, 'v1', at(20))).toBe(160);
    // Seconds past the minute round up, so the check-in never ends before the plan.
    expect(routineCheckinMinutes(r, 'v1', new Date(at(20).getTime() + 30_000))).toBe(160);
    // Not due (another court, or after the window): the caller's 2 hours.
    expect(routineCheckinMinutes(r, 'v2', at(0))).toBeNull();
    expect(routineCheckinMinutes(r, 'v1', at(45))).toBeNull();
    // A 4-hour routine checked in 25 minutes early: checkin_venue's 4 hours.
    expect(routineCheckinMinutes([withToday(routine({ lengthMin: 240 }))], 'v1', at(-25))).toBe(240);
    // 25 minutes into a 30-minute routine: never under 2 hours (D1; it was the server's 30-minute floor).
    expect(routineCheckinMinutes([withToday(routine({ lengthMin: 30 }))], 'v1', at(25))).toBe(DEFAULT_CHECKIN_MINUTES);
  });

  it('asked that way, the check-in is still running, and open, in the routine\'s last hour', () => {
    const minutes = routineCheckinMinutes([withToday(split())], 'v1', at(-10))!;
    const ends = at(-10).getTime() + minutes * 60_000;
    expect(ends).toBe(at(180).getTime());
    expect(modeAt(oldCheckin.windows, at(150))?.mode).toBe('open');
    expect(at(150).getTime()).toBeLessThan(ends);
    // The old 2 hours ended at 10:50, still closed.
    expect(modeAt(oldCheckin.windows, new Date(Date.parse(oldCheckin.expiresAt) - 60_000))?.mode).toBe('closed');
  });

  it('the plan sheet opens past the end with every window, when there is no planned end', () => {
    // Latest of the planned end (none), the end (120 min) and the last window's end (190 min), on the grid.
    expect(checkinPlanStartLength(oldCheckin)).toBe(195);
    const start = checkinPlanSheetStart(oldCheckin);
    expect(start.lengthMin).toBe(195);
    expect(span(start.windows)).toBe('0-135:closed 135-195:open');
    // Opened and saved as is: the open window survives.
    const saved = checkinPlanWindowsToSave(start.windows, start.lengthMin, oldCheckin.checkedInAt);
    expect(absSpan(saved)).toBe('-10-125:closed 125-185:open');
    expect(modeAt(saved, at(150))?.mode).toBe('open');
  });

  it('choosing 3 h keeps the split; shorter and back never collapses it into one mode', () => {
    const { windows: base } = checkinPlanSheetStart(oldCheckin);
    const three = fitCheckinPlanWindows(base, 180);
    expect(span(three)).toBe('0-135:closed 135-180:open');
    expect(absSpan(checkinPlanWindowsToSave(three, 180, oldCheckin.checkedInAt))).toBe('-10-125:closed 125-170:open');
    // 2 hours: the split point is past the end, so all closed ...
    expect(span(fitCheckinPlanWindows(base, 120))).toBe('0-120:closed');
    // ... and back to 3 or 4 hours from what the player left: split again.
    expect(span(fitCheckinPlanWindows(base, 180))).toBe('0-135:closed 135-180:open');
    expect(span(fitCheckinPlanWindows(base, 240))).toBe('0-135:closed 135-240:open');
  });

  it('with the planned end the server sets now, or an extended check-in, the sheet opens at the latest end', () => {
    // migration_court_routines_planned_end.sql: planned end 12:00, the end still 10:50.
    expect(checkinPlanStartLength({ ...oldCheckin, plannedEndAt: at(180).toISOString() })).toBe(195);
    // Extended past the planned end: the end.
    expect(checkinPlanStartLength({ ...oldCheckin, plannedEndAt: at(110).toISOString(), expiresAt: at(230).toISOString(), windows: [] })).toBe(240);
    // A plain check-in by hand: 2 hours, all open play.
    const plain = { checkedInAt: at(0).toISOString(), expiresAt: at(120).toISOString(), plannedEndAt: null, windows: [] };
    expect(checkinPlanStartLength(plain)).toBe(120);
    expect(span(checkinPlanSheetStart(plain).windows)).toBe('0-120:open');
    // A planned end a few seconds off the grid adds no step.
    expect(checkinPlanStartLength({ ...plain, plannedEndAt: new Date(at(120).getTime() + 20_000).toISOString() })).toBe(120);
  });

  it('"Stay until" is offered while the check-in ends more than a minute before its planned end', () => {
    const withEnd = { ...oldCheckin, plannedEndAt: at(180).toISOString() };
    expect(stayUntilOffer(withEnd, at(60))).toBe(at(180).toISOString());
    expect(stayUntilLabel(at(180).toISOString(), TZ)).toBe('Stay until 12 PM');
    expect(stayUntilOffer(oldCheckin, at(60))).toBeNull();
    expect(stayUntilOffer({ ...withEnd, expiresAt: at(180).toISOString() }, at(60))).toBeNull();
    expect(stayUntilOffer({ ...withEnd, expiresAt: new Date(at(180).getTime() - 30_000).toISOString() }, at(60))).toBeNull();
    expect(stayUntilOffer(withEnd, at(181))).toBeNull();
  });
});

// ── Review of the planned-end fix (round 2): "Stay until" on a 4-hour routine,
// the notification buttons' length, Home's "until", the plan sheet's open and
// save, "Planned until" after its time. ─────────────────────────────────────
describe('a routine check-in, round 2 of the review', () => {
  const span = (list: readonly TimeWindow<PlayMode>[] | null) =>
    (list ?? []).map((w) => `${w.startMin}-${w.endMin}:${w.mode}`).join(' ');
  const abs = (s: number, e: number, mode: PlayMode | null) => ({
    startsAt: at(s).toISOString(),
    endsAt: at(e).toISOString(),
    mode,
    hint: null,
    group: [] as string[],
  });
  const absSpan = (list: readonly { startsAt: string; endsAt: string; mode: PlayMode | null }[]) =>
    list.map((w) => `${(Date.parse(w.startsAt) - TUE_9.getTime()) / 60_000}-${(Date.parse(w.endsAt) - TUE_9.getTime()) / 60_000}:${w.mode}`).join(' ');
  const iso = (min: number) => at(min).toISOString();
  // The routine 9:00-12:00, closed group 2 h, then open play 1 h.
  const split = () =>
    routine({
      windows: [
        { startMin: 0, endMin: 120, mode: 'closed', hint: null, group: [] },
        { startMin: 120, endMin: 180, mode: 'open', hint: null, group: [] },
      ],
    });

  it('"Stay until" never offers past extend_checkin\'s 4 hours: a 4-hour routine checked in by hand at 8:50 has nothing to offer', () => {
    // Asked 240 (the cap): ends 12:50, planned 1 PM, last fix at the check-in.
    const early = { checkedInAt: iso(-10), fixAt: iso(-10), locationConfirmed: true, expiresAt: iso(230), plannedEndAt: iso(240) };
    expect(stayUntilOffer(early, at(60))).toBeNull();
    expect(stayUntilOffer(early, at(200))).toBeNull();
    // A fresh fix since (Stay 1 more hour with location) reaches 1 PM.
    expect(stayUntilOffer({ ...early, fixAt: iso(30) }, at(60))).toBe(iso(240));
    // Unknown confirmation (set_checkin_plan's answer) counts as confirmed: no offer either.
    expect(stayUntilOffer({ ...early, locationConfirmed: null, fixAt: null }, at(60))).toBeNull();
  });

  it('"Stay until" on an arrival check-in (no fix) offers 4 hours past the arrival, then goes', () => {
    // Arrived 8:52 on a 4-hour routine: the 2-hour arrival length, planned 1 PM.
    const arrival = { checkedInAt: iso(-8), fixAt: null, locationConfirmed: true, expiresAt: iso(112), plannedEndAt: iso(240) };
    const offer = stayUntilOffer(arrival, at(100));
    expect(offer).toBe(iso(232));
    expect(stayUntilLabel(offer!, TZ)).toBe('Stay until 12:52 PM');
    // Extended to it (extend_checkin gives exactly that): nothing more to offer, so no button that always fails.
    expect(stayUntilOffer({ ...arrival, expiresAt: offer! }, at(110))).toBeNull();
    // A check-in without a fix (an older build's, private): only the 4 hours from now apply.
    expect(stayUntilOffer({ ...arrival, locationConfirmed: false }, at(100))).toBe(iso(240));
    expect(stayUntilOffer({ ...arrival, locationConfirmed: false, plannedEndAt: iso(400) }, at(100))).toBe(iso(340));
  });

  it('a notification\'s Check in asks for the routine\'s length: the tapped reminder\'s occurrence first, else my routines', () => {
    const reminder = { plannedAt: iso(0), plannedEndAt: iso(180) };
    // Pressed at 9:05: to 12 PM, with no read of my routines.
    expect(buttonCheckinMinutes(null, 'v1', at(5), reminder)).toBe(175);
    // Pressed at 8:50 on a 4-hour stop: checkin_venue's 4 hours.
    expect(buttonCheckinMinutes(null, 'v1', at(-10), { plannedAt: iso(0), plannedEndAt: iso(240) })).toBe(240);
    // A day moved to 10:00-1 PM: the push knows it even when this phone's copy says 9:00.
    expect(buttonCheckinMinutes([split()], 'v1', at(55), { plannedAt: iso(60), plannedEndAt: iso(240) })).toBe(185);
    // Pressed after its window (9:40): the server won't link it, so the reminder says nothing ...
    expect(buttonCheckinMinutes(null, 'v1', at(40), reminder)).toBeNull();
    // ... and "At X?" / "Check in nearby?" (no reminder) read my routines.
    expect(buttonCheckinMinutes([withToday(split())], 'v1', at(-10), null)).toBe(190);
    expect(buttonCheckinMinutes([withToday(split())], 'v2', at(-10), null)).toBeNull();
    // The 2 hours they asked before ended a 3-hour split still closed; this length reaches the open hour.
    const ends = at(-10).getTime() + 190 * 60_000;
    expect(modeAt([abs(0, 120, 'closed'), abs(120, 180, 'open')], at(150))?.mode).toBe('open');
    expect(at(150).getTime()).toBeLessThan(ends);
  });

  it('Home\'s card: "until" is the planned end on every render, and follows the stop\'s window', () => {
    const r = [withToday(split())];
    expect(routineCheckinUntil(r, 'v1', at(-10))).toBe(iso(180));
    expect(routineCheckinUntil(r, 'v1', new Date(at(-9).getTime() + 37_000))).toBe(iso(180));
    expect(routineCheckinUntil(r, 'v1', at(29))).toBe(iso(180));
    // The window closes at 9:30: the card goes back to "for 2 hours".
    expect(routineCheckinUntil(r, 'v1', at(31))).toBeNull();
    // A 4-hour stop at 8:35: what the tap asks, 4 hours from now.
    const four = [withToday(routine({ lengthMin: 240 }))];
    expect(routineCheckinUntil(four, 'v1', at(-25))).toBe(iso(215));
    expect(routineCheckinUntil(four, 'v1', at(-24))).toBe(iso(216));
  });

  it('the plan sheet opens a 9:29 check-in planned to 12:00 at 2 h 30 min, and an open and save changes nothing', () => {
    const late = { checkedInAt: iso(29), expiresAt: iso(149), plannedEndAt: iso(180), windows: [abs(0, 120, 'closed'), abs(120, 180, 'open')] };
    const start = checkinPlanSheetStart(late);
    expect(start.lengthMin).toBe(150);
    expect(span(start.windows)).toBe('0-90:closed 90-150:open');
    const saved = checkinPlanToSave(start, start.windows, start.lengthMin, late.checkedInAt);
    // Before: planned until 12:14, split at 10:59.
    expect(saved.plannedEnd.toISOString()).toBe(iso(180));
    expect(absSpan(saved.windows)).toBe('29-120:closed 120-180:open');
  });

  it('the plan sheet keeps a boundary the player left at its own minute, and a new length or split on the grid', () => {
    const late = { checkedInAt: iso(29), expiresAt: iso(149), plannedEndAt: iso(180), windows: [abs(0, 120, 'closed'), abs(120, 180, 'open')] };
    const start = checkinPlanSheetStart(late);
    // 3 hours picked: the end is the check-in + 3 h; the split stays at 11:00.
    const three = fitCheckinPlanWindows(start.windows, 180);
    const longer = checkinPlanToSave(start, three, 180, late.checkedInAt);
    expect(longer.plannedEnd.toISOString()).toBe(iso(209));
    expect(absSpan(longer.windows)).toBe('29-120:closed 120-209:open');
    // The split moved 15 minutes later: on the grid from the check-in.
    const moved = applyWindowEdit(start.windows, { type: 'move', index: 0, deltaMin: 15 }, 150, PLAY_WINDOW_RULES)!;
    expect(span(moved)).toBe('0-105:closed 105-150:open');
    expect(absSpan(checkinPlanToSave(start, moved, 150, late.checkedInAt).windows)).toBe('29-134:closed 134-180:open');
    // A mode changed, the split left alone: still 11:00.
    const unsaid = applyWindowEdit(start.windows, { type: 'update', index: 0, patch: { mode: null } }, 150, PLAY_WINDOW_RULES)!;
    expect(absSpan(checkinPlanToSave(start, unsaid, 150, late.checkedInAt).windows)).toBe('29-120:null 120-180:open');
  });

  it('the opening length still never cuts a window: one starting in the last minutes keeps the step up', () => {
    // "Switch to open play now" at 11:55 on a check-in to 12:00 (9:29 + 151 min).
    const switched = { checkedInAt: iso(29), expiresAt: iso(180), plannedEndAt: iso(180), windows: [abs(29, 175, 'closed'), abs(175, 180, 'open')] };
    const start = checkinPlanSheetStart(switched);
    expect(start.lengthMin).toBe(165);
    expect(start.windows.at(-1)?.mode).toBe('open');
    // Saved as opened: the switch's own minute and the planned end.
    const saved = checkinPlanToSave(start, start.windows, start.lengthMin, switched.checkedInAt);
    expect(saved.plannedEnd.toISOString()).toBe(iso(180));
    expect(absSpan(saved.windows)).toBe('29-175:closed 175-180:open');
    // The review's first case still opens past the end (8:50, 2 h asked, windows to 12:00): 3 h 15 min.
    const old = { checkedInAt: iso(-10), expiresAt: iso(110), plannedEndAt: null, windows: [abs(0, 120, 'closed'), abs(120, 180, 'open')] };
    const oldStart = checkinPlanSheetStart(old);
    expect(oldStart.lengthMin).toBe(195);
    const oldSaved = checkinPlanToSave(oldStart, oldStart.windows, oldStart.lengthMin, old.checkedInAt);
    expect(oldSaved.plannedEnd.toISOString()).toBe(iso(180));
    expect(absSpan(oldSaved.windows)).toBe('-10-120:closed 120-180:open');
    expect(modeAt(oldSaved.windows, at(150))?.mode).toBe('open');
  });

  it('"Planned until" goes once its time has passed; the mode line comes first', () => {
    const plan = { plannedEndAt: iso(60), windows: [] as ReturnType<typeof abs>[] };
    expect(checkinPlanLine(plan, at(30), TZ)).toBe('Planned until 10 AM');
    expect(checkinPlanLine(plan, at(61), TZ)).toBe('');
    expect(checkinPlanLine({ plannedEndAt: null, windows: [] }, at(30), TZ)).toBe('');
    expect(checkinPlanLine({ plannedEndAt: iso(180), windows: [abs(0, 120, 'closed'), abs(120, 180, 'open')] }, at(30), TZ)).toBe(
      playModeNowLine([abs(0, 120, 'closed'), abs(120, 180, 'open')], at(30), TZ),
    );
  });
});

// ── Round 3: a routine saved after its time, D1 (never under 2 hours), the
// plan sheet's open and save with a sliver first window or past 4 hours. ────
describe('a routine check-in, round 3 of the review', () => {
  const span = (list: readonly TimeWindow<PlayMode>[] | null) =>
    (list ?? []).map((w) => `${w.startMin}-${w.endMin}:${w.mode}`).join(' ');
  const abs = (s: number, e: number, mode: PlayMode | null) => ({
    startsAt: at(s).toISOString(),
    endsAt: at(e).toISOString(),
    mode,
    hint: null,
    group: [] as string[],
  });
  const absSpan = (list: readonly { startsAt: string; endsAt: string; mode: PlayMode | null }[]) =>
    list.map((w) => `${(Date.parse(w.startsAt) - TUE_9.getTime()) / 60_000}-${(Date.parse(w.endsAt) - TUE_9.getTime()) / 60_000}:${w.mode}`).join(' ');
  const iso = (min: number) => at(min).toISOString();
  // The routine 9:00-12:00, closed group 2 h, then open play 1 h.
  const split = () =>
    routine({
      windows: [
        { startMin: 0, endMin: 120, mode: 'closed', hint: null, group: [] },
        { startMin: 120, endMin: 180, mode: 'open', hint: null, group: [] },
      ],
    });

  it('a routine saved after its time has no occurrence today (the old server): 2 hours asked and said, not "until 12 PM" (probe X4)', () => {
    // Saved at 9:07 for 9:00: the server before round 3 made only the next day's.
    const copy = [split()];
    // An arrival still keys off the weekly time (Doggle's routineStopDueAt) ...
    expect(routineDueAt(copy, 'v1', at(7))?.planId).toBeNull();
    expect(routineDueWithoutOccurrence(copy, 'v1', at(7))).toBe(true);
    // ... but a check-in runs to a routine's end only with an occurrence the server links.
    expect(routineOccurrenceEndAt(copy, 'v1', at(7))).toBeNull();
    expect(routineCheckinMinutes(copy, 'v1', at(7))).toBeNull();
    expect(routineCheckinUntil(copy, 'v1', at(7))).toBeNull();
    expect(buttonCheckinMinutes(copy, 'v1', at(7), null)).toBeNull();
    // Not due at all: nothing to read fresh.
    expect(routineDueWithoutOccurrence(copy, 'v1', at(45))).toBe(false);
    expect(routineDueWithoutOccurrence(copy, 'v2', at(7))).toBe(false);
  });

  it('with today\'s occurrence (made during its window now, re-made on an edit) the check-in runs to its end', () => {
    const fresh = [withToday(split())];
    expect(routineDueWithoutOccurrence(fresh, 'v1', at(7))).toBe(false);
    expect(routineOccurrenceEndAt(fresh, 'v1', at(7))).toBe(iso(180));
    expect(routineCheckinMinutes(fresh, 'v1', at(7))).toBe(173);
    expect(routineCheckinUntil(fresh, 'v1', at(7))).toBe(iso(180));
    // Edited at 9:07 to 2 h 30 min: today's occurrence is re-made with the new end.
    const edited = [withToday(routine({ lengthMin: 150 }))];
    expect(routineCheckinMinutes(edited, 'v1', at(7))).toBe(143);
    expect(routineCheckinUntil(edited, 'v1', at(7))).toBe(iso(150));
    // Kept already (checked in): no stop is due, so nothing is asked.
    expect(routineCheckinMinutes([withToday(split(), 0, 'completed')], 'v1', at(7))).toBeNull();
    // A moved occurrence's own end wins over the weekly length.
    const moved = withToday(split(), 20);
    expect(routineOccurrenceEndAt([moved], 'v1', at(40))).toBe(iso(200));
    // Two routines at one court 15 minutes apart: the server makes only one of
    // them (30 minutes apart at least), and a check-in keeps that one, as
    // _pl_routine_plan_at does, whichever the weekly times find first.
    const pair = [routine({ id: 'r2', localTime: '09:15', lengthMin: 60, windows: [] }), withToday(split())];
    expect(routineDueAt(pair, 'v1', at(10))?.routine.id).toBe('r2');
    expect(routineOccurrenceEndAt(pair, 'v1', at(10))).toBe(iso(180));
    expect(routineDueWithoutOccurrence(pair, 'v1', at(10))).toBe(false);
    expect(routineCheckinMinutes(pair, 'v1', at(10))).toBe(170);
  });

  it('D1: a check-in never ends before 2 hours, whatever the routine\'s length', () => {
    expect(DEFAULT_CHECKIN_MINUTES).toBe(120);
    // A 1-hour routine checked in 10 minutes early: 70 minutes to its end, 2 hours asked.
    const hour = [withToday(routine({ lengthMin: 60, windows: [] }))];
    expect(routineCheckinMinutes(hour, 'v1', at(-10))).toBe(120);
    // ... and the card says "for 2 hours", not "until 10 AM".
    expect(routineCheckinUntil(hour, 'v1', at(-10))).toBeNull();
    // A 2-hour routine: on time, 2 hours (the default); 10 minutes early, to its end.
    const two = [withToday(routine({ lengthMin: 120, windows: [] }))];
    expect(routineCheckinMinutes(two, 'v1', at(0))).toBe(120);
    expect(routineCheckinUntil(two, 'v1', at(0))).toBeNull();
    expect(routineCheckinMinutes(two, 'v1', at(-10))).toBe(130);
    expect(routineCheckinUntil(two, 'v1', at(-10))).toBe(iso(120));
    // The routine reminder's Check in on a 1-hour stop: 2 hours too.
    expect(buttonCheckinMinutes(null, 'v1', at(5), { plannedAt: iso(0), plannedEndAt: iso(60) })).toBe(120);
    // Capped as before: 4 hours.
    expect(buttonCheckinMinutes(null, 'v1', at(-25), { plannedAt: iso(0), plannedEndAt: iso(240) })).toBe(240);
  });

  it('the plan sheet keeps a first window with minutes left (the 15-minute grid drops it) on an open and save', () => {
    // Routine 9:00: closed group 30 minutes, then open play to 12:00. Checked in by hand at 9:23.
    const plan = { checkedInAt: iso(23), expiresAt: iso(180), plannedEndAt: iso(180), windows: [abs(0, 30, 'closed'), abs(30, 180, 'open')] };
    const start = checkinPlanSheetStart(plan, at(25));
    // 7 closed minutes can't show on the 15-minute grid.
    expect(start.lengthMin).toBe(150);
    expect(span(start.windows)).toBe('0-150:open');
    // Opened and saved: the plan as it was (before: open from 9:23).
    const saved = checkinPlanToSave(start, start.windows, start.lengthMin, plan.checkedInAt);
    expect(saved.plannedEnd.toISOString()).toBe(iso(180));
    expect(absSpan(saved.windows)).toBe('23-30:closed 30-180:open');
    // 3 hours picked: the closed minutes stay in front, the rest on the grid.
    const three = checkinPlanToSave(start, fitCheckinPlanWindows(start.windows, 180), 180, plan.checkedInAt);
    expect(three.plannedEnd.toISOString()).toBe(iso(203));
    expect(absSpan(three.windows)).toBe('23-30:closed 30-203:open');
    // The first window changed to Closed group: that is the plan from the check-in.
    const closed = applyWindowEdit(start.windows, { type: 'update', index: 0, patch: { mode: 'closed' } }, 150, PLAY_WINDOW_RULES)!;
    expect(absSpan(checkinPlanToSave(start, closed, 150, plan.checkedInAt).windows)).toBe('23-180:closed');
  });

  it('the plan sheet keeps a planned end more than 4 hours after the check-in when the server takes it', () => {
    // Checked in 8:00, kept going with a fix at 11:00 to 1 PM: closed to 11, open to 1.
    const long = {
      checkedInAt: iso(-60), expiresAt: iso(240), plannedEndAt: iso(240), fixAt: iso(120), locationConfirmed: true,
      windows: [abs(-60, 120, 'closed'), abs(120, 240, 'open')],
    };
    const start = checkinPlanSheetStart(long, at(150));
    expect(start.lengthMin).toBe(240);
    expect(span(start.windows)).toBe('0-180:closed 180-240:open');
    expect(start.endAt).toBe(iso(240));
    const saved = checkinPlanToSave(start, start.windows, start.lengthMin, long.checkedInAt);
    // Before: cut to 12 PM (8:00 + 4 h), the check-in ended an hour early.
    expect(saved.plannedEnd.toISOString()).toBe(iso(240));
    expect(absSpan(saved.windows)).toBe('-60-120:closed 120-240:open');

    // A 4-hour routine checked in by hand at 8:31 (4 hours asked, ends 12:31, planned 1 PM).
    const early = {
      checkedInAt: iso(-29), expiresAt: iso(211), plannedEndAt: iso(240), fixAt: iso(-29), locationConfirmed: true,
      windows: [abs(0, 120, 'closed'), abs(120, 240, 'open')],
    };
    // Without a newer fix set_checkin_plan stops at 12:31, so that is the end kept ...
    expect(checkinPlanSheetStart(early, at(0)).endAt).toBe(iso(211));
    // ... with one (Stay 1 more hour with location at 9:00) it takes 1 PM.
    const fixed = checkinPlanSheetStart({ ...early, fixAt: iso(0) }, at(0));
    expect(fixed.endAt).toBe(iso(240));
    const kept = checkinPlanToSave(fixed, fixed.windows, fixed.lengthMin, early.checkedInAt);
    expect(kept.plannedEnd.toISOString()).toBe(iso(240));
    expect(absSpan(kept.windows)).toBe('-29-120:closed 120-240:open');
  });
});

describe('a routine deleted or paused during its window, round 4 of the review', () => {
  const iso = (min: number) => at(min).toISOString();
  // As list_my_court_routines sends it (snake_case), today's occurrence 9:00.
  const raw = (over: Record<string, unknown>, occurrences: Record<string, unknown>[] = []) =>
    parseCourtRoutine({ ...rawBase(), ...over, occurrences, next: occurrences[0] ?? null });
  const occ = (windows: Record<string, unknown>[], lengthMin = 180) => ({
    plan_id: 'p-today', planned_at: iso(0), planned_end_at: iso(lengthMin), status: 'planned', windows,
  });
  const closedThenOpen = [
    { starts_at: iso(0), ends_at: iso(120), mode: 'closed', hint: null, group: [] },
    { starts_at: iso(120), ends_at: iso(180), mode: 'open', hint: null, group: [] },
  ];

  it('paused at 9:07: the answer has no occurrence, so a check-in asks 2 hours and reads nothing fresh (probe Z5)', () => {
    // The server now takes today's planned occurrence with the pause.
    const paused = [raw({ active: false })];
    expect(routineDueAt(paused, 'v1', at(7))).toBeNull();
    expect(routineDueWithoutOccurrence(paused, 'v1', at(7))).toBe(false);
    expect(routineOccurrenceEndAt(paused, 'v1', at(7))).toBeNull();
    expect(routineCheckinMinutes(paused, 'v1', at(7))).toBeNull();
    expect(routineCheckinUntil(paused, 'v1', at(7))).toBeNull();
    expect(buttonCheckinMinutes(paused, 'v1', at(7), null)).toBeNull();
    // The server before round 4 left it in the answer and linked a check-in to
    // it; the app followed the server there too (the occurrence, not the switch).
    const before = [raw({ active: false }, [occ(closedThenOpen)])];
    expect(routineCheckinMinutes(before, 'v1', at(7))).toBe(173);
  });

  it('Z7: deleted at 9:07 and saved again for 9:00 open then closed: the check-in takes the new split, 2 hours', () => {
    // The delete's answer: the routine is gone, nothing is due.
    expect(routineCheckinMinutes([], 'v1', at(7))).toBeNull();
    // The new routine's answer has today's occurrence (the old one no longer blocks it).
    const openThenClosed = [
      { starts_at: iso(0), ends_at: iso(60), mode: 'open', hint: 'all_levels', group: [] },
      { starts_at: iso(60), ends_at: iso(120), mode: 'closed', hint: null, group: [] },
    ];
    const fresh = [raw({ id: 'r2', length_min: 120 }, [occ(openThenClosed, 120)])];
    expect(routineDueWithoutOccurrence(fresh, 'v1', at(7))).toBe(false);
    expect(routineOccurrenceEndAt(fresh, 'v1', at(7))).toBe(iso(120));
    // 113 minutes to its end: 2 hours asked (D1), and Home says "for 2 hours".
    expect(routineCheckinMinutes(fresh, 'v1', at(7))).toBe(DEFAULT_CHECKIN_MINUTES);
    expect(routineCheckinUntil(fresh, 'v1', at(7))).toBeNull();
    // The plan the server copies onto the check-in: open play now, closed from 10:00.
    const windows = fresh[0].next!.windows!;
    expect(windows.map((w) => w.mode)).toEqual(['open', 'closed']);
  });
});

describe('routine pushes', () => {
  it('"Staying until" stays quiet while the app is open, like the other arrival pushes', () => {
    expect(showWhileAppActive({ kind: 'arrival_extend_until' })).toBe(false);
    expect(showWhileAppActive({ kind: 'routine_reminder' })).toBe(true);
  });
});
