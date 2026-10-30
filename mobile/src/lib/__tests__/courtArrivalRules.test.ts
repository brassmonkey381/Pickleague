import { describe, expect, it } from 'vitest';
// The real foundation buildRegions: the court list is built with it, so the
// merge and the tier order are checked against it. Imported by file because
// the /tracking barrel also loads react-native (geofencing itself).
import { buildRegions } from '../../../node_modules/@just-messin-around/expo-foundation/src/tracking/buildRegions';
import {
  ARRIVAL_NOTICE_KIND,
  ARRIVAL_SETTLE_MS,
  arrivalCheckedInCopy,
  arrivalEntriesToSettle,
  arrivalLocalSchedule,
  arrivalCheckinUntouched,
  arrivalNoticeCopy,
  arrivalStillAtCopy,
  buildCourtRegionList,
  CHECKINS_SETTINGS_LINK,
  checkInOutcome,
  checkInOutcomeCopy,
  checkinRemovedCopy,
  decideArrival,
  decideDeparture,
  decideLeaving,
  decidePromptDelivery,
  decideQueueAnswer,
  DEFAULT_COURT_ARRIVAL_SETTINGS,
  DEPARTURE_COOLDOWN_MS,
  exitCancels,
  isLocationRefusalCode,
  isWalletOnlyRegionId,
  leavingNoticeCopy,
  MAX_COURT_REGIONS,
  mergeCourtRegion,
  NOT_HERE_FAILED,
  NOT_HERE_TIMED_OUT,
  nearbyPromptBody,
  normalizeCourtArrivalSettings,
  notHereOutcome,
  monitorPromptRoute,
  promptRoute,
  reconcileArrivalEntries,
  showWhileAppActive,
  STARRED_TIER,
  starredTierRegions,
  waitingArrivalVenues,
  WALLET_TIER,
  walletNoticeCopy,
  walletTierRegions,
  type ArrivalFacts,
  type ArrivalLocalEntry,
  type CourtArrivalSettings,
  type CourtRegionInfo,
  type OpenCheckinFact,
  type StarredCourtGeofence,
  type WalletRegionSource,
} from '../courtArrivalRules';

const STARRED: CourtRegionInfo = { name: 'Lakeside', starred: true, autoCheckin: true };
const WALLET_ONLY: CourtRegionInfo = { name: 'Club Pickle', starred: false, autoCheckin: false, passId: 'p1' };
const STARRED_WALLET: CourtRegionInfo = { ...STARRED, passId: 'p2' };

const settings = (over: Partial<CourtArrivalSettings> = {}): CourtArrivalSettings => ({
  ...DEFAULT_COURT_ARRIVAL_SETTINGS,
  consent_seen: true,
  ...over,
});

const facts = (over: Partial<ArrivalFacts> = {}): ArrivalFacts => ({
  arrival: true,
  info: STARRED,
  settings: settings(),
  arrivedRecently: false,
  promptedRecently: false,
  playSessionActive: false,
  consent: 'yes',
  walletThrottled: false,
  ...over,
});

describe('decideArrival (rows 13-25)', () => {
  it('marks an arrival before any check, whatever the rest decides', () => {
    expect(decideArrival(facts({ info: null }))).toMatchObject({ mark: true, action: 'quiet', why: 'not_member' });
    expect(decideArrival(facts({ settings: settings({ court_radius_m: 0 }) }))).toMatchObject({ mark: true, action: 'quiet' });
    expect(decideArrival(facts({ info: WALLET_ONLY }))).toMatchObject({ mark: true, action: 'wallet' });
    expect(decideArrival(facts({ promptedRecently: true }))).toMatchObject({ mark: true, action: 'quiet' });
  });

  it('never marks a re-report', () => {
    expect(decideArrival(facts({ arrival: false })).mark).toBe(false);
    expect(decideArrival(facts({ arrival: false, info: null })).mark).toBe(false);
  });

  it('a region this build did not fence is silent (missingMeansMember false)', () => {
    expect(decideArrival(facts({ info: null }))).toMatchObject({ action: 'quiet', why: 'not_member' });
    expect(decideArrival(facts({ info: null, arrival: false }))).toMatchObject({ action: 'quiet', why: 'not_member' });
  });

  it('a QR wallet court only: its notice on arrivals, 3 hours apart; re-reports stay quiet', () => {
    expect(decideArrival(facts({ info: WALLET_ONLY })).action).toBe('wallet');
    expect(decideArrival(facts({ info: WALLET_ONLY, arrival: false }))).toMatchObject({ action: 'quiet' });
    expect(decideArrival(facts({ info: WALLET_ONLY, walletThrottled: true }))).toMatchObject({
      action: 'quiet',
      why: 'wallet_throttled',
    });
    // Not starred and no code (a stale entry): nothing to show.
    expect(decideArrival(facts({ info: { name: 'X', starred: false, autoCheckin: false } })).action).toBe('quiet');
  });

  it('"Notice me at starred courts" Off: quiet, but a QR court still shows its code', () => {
    const off = settings({ court_radius_m: 0 });
    expect(decideArrival(facts({ settings: off }))).toMatchObject({ action: 'quiet', why: 'radius_off' });
    expect(decideArrival(facts({ settings: off, info: STARRED_WALLET })).action).toBe('wallet');
    expect(decideArrival(facts({ settings: off, info: STARRED_WALLET, walletThrottled: true })).action).toBe('quiet');
    expect(decideArrival(facts({ settings: off, info: STARRED_WALLET, arrival: false })).action).toBe('quiet');
  });

  it('unreadable settings mean the defaults: radius on, automatic check-in on', () => {
    expect(decideArrival(facts({ settings: null })).action).toBe('queue');
    expect(decideArrival(facts({ settings: null, arrival: false }))).toMatchObject({ action: 'prompt' });
  });

  it('automatic check-in off: every Enter asks first, arrival or re-report', () => {
    const off = settings({ auto_checkin: false });
    expect(decideArrival(facts({ settings: off }))).toEqual({ mark: true, action: 'prompt' });
    expect(decideArrival(facts({ settings: off, arrival: false }))).toEqual({ mark: false, action: 'prompt' });
    expect(decideArrival(facts({ settings: off, arrival: false, arrivedRecently: true })).action).toBe('prompt');
  });

  it('a re-report with automatic check-in on: quiet after a recent arrival, else a prompt', () => {
    expect(decideArrival(facts({ arrival: false, arrivedRecently: true }))).toMatchObject({ action: 'quiet', why: 're_report' });
    expect(decideArrival(facts({ arrival: false, arrivedRecently: false })).action).toBe('prompt');
  });

  it('a background prompt here in the last 15 minutes covers the arrival', () => {
    expect(decideArrival(facts({ promptedRecently: true }))).toMatchObject({ action: 'quiet', why: 'prompt_covers' });
  });

  it('a running play session asks first instead', () => {
    expect(decideArrival(facts({ playSessionActive: true }))).toEqual({ mark: true, action: 'prompt' });
  });

  it('who-sees-me not chosen: asks first and says why; unknown leaves it to the server', () => {
    expect(decideArrival(facts({ consent: 'no' }))).toEqual({ mark: true, action: 'prompt', reason: 'no_consent' });
    expect(decideArrival(facts({ consent: 'unknown' })).action).toBe('queue');
  });

  it('at a court switched off for me, consent is not the reason: the server answers off_here first', () => {
    const offHere: CourtRegionInfo = { ...STARRED, autoCheckin: false };
    expect(decideArrival(facts({ consent: 'no', info: offHere }))).toEqual({ mark: true, action: 'queue' });
    expect(decideQueueAnswer({ queued: false, reason: 'off_here', pushable: false })).toEqual({ action: 'prompt' });
  });

  it('otherwise queues the arrival', () => {
    expect(decideArrival(facts())).toEqual({ mark: true, action: 'queue' });
    expect(decideArrival(facts({ info: STARRED_WALLET })).action).toBe('queue');
  });

  it('at a starred QR court, asking first shows the code instead of "Check in nearby?"', () => {
    const off = settings({ auto_checkin: false });
    // A stand-in for the prompt (kept as quiet as it while the app is open);
    // a re-report included.
    expect(decideArrival(facts({ info: STARRED_WALLET, settings: off }))).toEqual({
      mark: true,
      action: 'wallet',
      standIn: true,
    });
    expect(decideArrival(facts({ info: STARRED_WALLET, arrival: false }))).toMatchObject({ action: 'wallet', standIn: true });
    // The QR notice of a wallet-only court, or with "Notice me" Off, is not one.
    expect(decideArrival(facts({ info: WALLET_ONLY }))).toEqual({ mark: true, action: 'wallet' });
    expect(decideArrival(facts({ info: STARRED_WALLET, settings: settings({ court_radius_m: 0 }) }))).toEqual({
      mark: true,
      action: 'wallet',
    });
    expect(decideArrival(facts({ info: STARRED_WALLET, settings: off, walletThrottled: true }))).toMatchObject({
      action: 'quiet',
      why: 'wallet_throttled',
    });
    expect(decideArrival(facts({ info: STARRED_WALLET, playSessionActive: true })).action).toBe('wallet');
  });
});

describe('decideQueueAnswer (rows 22-25)', () => {
  it('queued posts "At X?"', () => {
    expect(decideQueueAnswer({ queued: true, pushable: true, due_at: 'x' })).toEqual({ action: 'notice' });
  });

  it('already checked in, left, court gone: quiet', () => {
    for (const reason of ['already_checked_in', 'left', 'court_gone']) {
      expect(decideQueueAnswer({ queued: false, reason })).toEqual({ action: 'quiet', why: reason });
    }
  });

  it('recently left, not starred, no consent: a prompt that says why', () => {
    for (const reason of ['recently_left', 'not_starred', 'no_consent'] as const) {
      expect(decideQueueAnswer({ queued: false, reason })).toEqual({ action: 'prompt', reason });
    }
  });

  it('off, off here, an unknown answer or no answer at all: a plain prompt', () => {
    expect(decideQueueAnswer({ queued: false, reason: 'off' })).toEqual({ action: 'prompt' });
    expect(decideQueueAnswer({ queued: false, reason: 'off_here' })).toEqual({ action: 'prompt' });
    expect(decideQueueAnswer({ queued: false, reason: 'something_new' })).toEqual({ action: 'prompt' });
    expect(decideQueueAnswer(null)).toEqual({ action: 'prompt' });
  });

  it('a prompt at a QR court is the QR notice, 3 hours apart', () => {
    expect(promptRoute(STARRED, false)).toBe('nearby');
    expect(promptRoute(null, false)).toBe('nearby');
    expect(promptRoute(STARRED_WALLET, false)).toBe('wallet');
    expect(promptRoute(STARRED_WALLET, true)).toBe('quiet');
  });

  it("the app-open monitor's prompt at a QR court is the QR notice, else it still asks", () => {
    expect(monitorPromptRoute(STARRED_WALLET, false)).toBe('wallet');
    expect(monitorPromptRoute(STARRED_WALLET, true)).toBe('nearby');
    expect(monitorPromptRoute(STARRED, false)).toBe('nearby');
    expect(monitorPromptRoute(null, false)).toBe('nearby');
  });
});

describe('decidePromptDelivery (row 28)', () => {
  it('the phone posts its own only when unreachable, or enqueued and not pushable', () => {
    expect(decidePromptDelivery({ unreachable: true })).toBe('local');
    expect(decidePromptDelivery({ unreachable: false, enqueued: true, pushable: false })).toBe('local');
    expect(decidePromptDelivery({ unreachable: false, enqueued: true, pushable: true })).toBe('server');
    expect(decidePromptDelivery({ unreachable: false, enqueued: false, pushable: true })).toBe('held');
    expect(decidePromptDelivery({ unreachable: false, enqueued: false, pushable: false })).toBe('held');
  });
});

describe('copy', () => {
  it('"Check in nearby?" matches the server push word for word (migration_court_checkin_prompt.sql)', () => {
    expect(nearbyPromptBody('Lakeside')).toBe("You're near Lakeside. Tap to check in.");
    expect(nearbyPromptBody(null)).toBe("You're near a court. Tap to check in.");
    expect(nearbyPromptBody('Lakeside', 'recently_left')).toBe(
      "You're near Lakeside. You left under 10 minutes ago, so we didn't check you in automatically. Tap to check in.",
    );
    expect(nearbyPromptBody('Lakeside', 'not_starred')).toBe(
      "You're near Lakeside. It isn't one of your starred courts anymore, so we didn't check you in automatically. Tap to check in.",
    );
    expect(nearbyPromptBody(undefined, 'no_consent')).toBe(
      "You're near a court. Choose who sees you at the courts first, so we didn't check you in automatically. Tap to check in.",
    );
  });

  it('"At X?" and its QR variant', () => {
    expect(arrivalNoticeCopy('Lakeside')).toEqual({
      title: 'At Lakeside? 🏓',
      body: 'Checking you in here in a minute.',
      deepLink: 'home/-',
    });
    expect(arrivalNoticeCopy(null).title).toBe('At your starred court? 🏓');
    expect(arrivalNoticeCopy('Lakeside', 'p2')).toEqual({
      title: 'At Lakeside? 🏓',
      body: 'Tap to show your check-in QR code. Checking you in here in a minute.',
      deepLink: 'wallet/p2',
    });
  });

  it('the phone\'s "Checked in" / "Still at" match the server pushes (migration_court_arrival_queue.sql)', () => {
    expect(arrivalCheckedInCopy('Lakeside')).toEqual({
      title: '✅ Checked in at Lakeside',
      body: "You're checked in. Check out when you leave, or tap Stay 1 more hour if you're staying.",
    });
    expect(arrivalCheckedInCopy(null).title).toBe('✅ Checked in at your starred court');
    expect(arrivalStillAtCopy('Lakeside')).toEqual({
      title: 'Still at Lakeside?',
      body: "Your check-in ends in 5 minutes. Tap Stay 1 more hour if you're staying.",
    });
    expect(arrivalStillAtCopy(null).title).toBe('Still at the courts?');
  });

  it('the wallet, take-back and leaving notices', () => {
    expect(walletNoticeCopy('Club Pickle')).toEqual({ title: "You're at Club Pickle", body: 'Tap to show your check-in QR code.' });
    expect(walletNoticeCopy('').title).toBe("You're at the courts");
    expect(checkinRemovedCopy('Lakeside')).toEqual({
      title: 'Check-in removed',
      body: "You left Lakeside within 5 minutes of arriving, so it didn't count as a visit.",
    });
    expect(checkinRemovedCopy(null).body).toBe("You left the courts within 5 minutes of arriving, so it didn't count as a visit.");
    expect(leavingNoticeCopy('Lakeside')).toEqual({
      title: 'Leaving Lakeside?',
      body: "You're still checked in. Check out, or tap Stay 1 more hour if you're staying.",
    });
    expect(leavingNoticeCopy(null).title).toBe('Leaving the courts?');
  });

  it('schedules the phone\'s own notices just after the job and 5 minutes before the end', () => {
    const due = '2026-10-20T18:01:00.000Z';
    expect(arrivalLocalSchedule(due)).toEqual({
      checkedInAtMs: Date.parse('2026-10-20T18:01:20.000Z'),
      stillAtAtMs: Date.parse('2026-10-20T19:55:00.000Z'),
      expiresAtIso: '2026-10-20T20:00:00.000Z',
    });
    expect(arrivalLocalSchedule('not a time')).toBeNull();
  });

  it('knows an arrival check-in nobody extended: 2 hours, or the old 30 minutes', () => {
    const at = '2026-10-20T18:00:00.000Z';
    expect(arrivalCheckinUntouched(at, '2026-10-20T20:00:00.000Z')).toBe(true);
    expect(arrivalCheckinUntouched(at, '2026-10-20T18:30:00.000Z')).toBe(true);
    expect(arrivalCheckinUntouched(at, '2026-10-20T21:00:00.000Z')).toBe(false);
    expect(arrivalCheckinUntouched(at, '2026-10-20T19:30:00.000Z')).toBe(false);
    expect(arrivalCheckinUntouched(at, 'not a time')).toBe(false);
  });
});

describe('departure (rows 38-39)', () => {
  it('cancels only for a recent arrival at a court; QR spots have no court to cancel at', () => {
    expect(isWalletOnlyRegionId('qr:abc')).toBe(true);
    expect(exitCancels('venue-1', true)).toBe(true);
    expect(exitCancels('venue-1', false)).toBe(false);
    expect(exitCancels('qr:abc', true)).toBe(false);
  });

  it('a removed or closed arrival check-in is taken back, with nothing to remind about', () => {
    const base = { regionId: 'venue-1', playSession: null, settings: settings() };
    expect(decideDeparture({ ...base, cancel: { queued: false, result: { dropped: false, removed: true, closed: true } } })).toEqual({
      action: 'took_back',
    });
    expect(decideDeparture({ ...base, cancel: { queued: false, result: { dropped: false, removed: false, closed: true } } })).toEqual({
      action: 'took_back',
    });
    // Even during a play session or with the reminder off: the take-back comes first.
    expect(
      decideDeparture({
        regionId: 'venue-1',
        playSession: { venueId: 'venue-2' },
        settings: settings({ departure_reminder: false }),
        cancel: { queued: false, result: { dropped: false, removed: true, closed: true } },
      }),
    ).toEqual({ action: 'took_back' });
  });

  it('dropped, queued or no cancel: goes on to "Leaving X?" (Check in now may have checked me in)', () => {
    const base = { regionId: 'venue-1', playSession: null, settings: settings() };
    expect(decideDeparture({ ...base, cancel: { queued: false, result: { dropped: true, removed: false, closed: false } } })).toEqual({
      action: 'check_open',
    });
    expect(decideDeparture({ ...base, cancel: { queued: true } })).toEqual({ action: 'check_open' });
    expect(decideDeparture({ ...base, cancel: null })).toEqual({ action: 'check_open' });
  });

  it('skips a play session at another court or at none, and the reminder switched off; unreadable settings keep it on', () => {
    const at = { cancel: null, regionId: 'venue-1' };
    expect(decideDeparture({ ...at, playSession: { venueId: 'venue-2' }, settings: settings() })).toEqual({
      action: 'quiet',
      why: 'play_session',
    });
    expect(decideDeparture({ ...at, playSession: { venueId: null }, settings: settings() })).toEqual({
      action: 'quiet',
      why: 'play_session',
    });
    expect(decideDeparture({ ...at, playSession: null, settings: settings({ departure_reminder: false }) })).toEqual({
      action: 'quiet',
      why: 'reminder_off',
    });
    expect(decideDeparture({ ...at, playSession: null, settings: null })).toEqual({ action: 'check_open' });
  });

  it('a session at the court left (its check-in started it): "Leaving X?" goes on, its Check out ends the session', () => {
    const at = { cancel: null, regionId: 'venue-1', playSession: { venueId: 'venue-1' } };
    expect(decideDeparture({ ...at, settings: settings() })).toEqual({ action: 'check_open' });
    expect(decideDeparture({ ...at, settings: null })).toEqual({ action: 'check_open' });
    // The reminder switched off still wins.
    expect(decideDeparture({ ...at, settings: settings({ departure_reminder: false }) })).toEqual({
      action: 'quiet',
      why: 'reminder_off',
    });
  });

  const open = (over: Partial<OpenCheckinFact> = {}): OpenCheckinFact => ({
    id: 'c1',
    venue_id: 'venue-1',
    expires_at: '2026-10-20T19:00:00.000Z',
    source: 'manual',
    via_arrival: false,
    venue_name: 'Lakeside',
    ...over,
  });
  const NOW = Date.parse('2026-10-20T18:30:00.000Z');

  it('"Leaving X?" for an open check-in at this court, with everything its buttons need', () => {
    expect(decideLeaving({ regionId: 'venue-1', open: open({ via_arrival: true, source: 'geofence' }), nowMs: NOW })).toEqual({
      action: 'leaving',
      title: 'Leaving Lakeside?',
      body: "You're still checked in. Check out, or tap Stay 1 more hour if you're staying.",
      data: {
        checkin_id: 'c1',
        expires_at: '2026-10-20T19:00:00.000Z',
        venue_id: 'venue-1',
        venue_name: 'Lakeside',
        via_arrival: true,
        deepLink: 'home/-',
        kind: 'checkin-departure',
      },
    });
  });

  it('is never posted without a check-in id (Check out with none closes every check-in)', () => {
    expect(decideLeaving({ regionId: 'venue-1', open: open({ id: null }), nowMs: NOW })).toEqual({
      action: 'quiet',
      why: 'no_checkin_id',
    });
  });

  it('skips no check-in, one elsewhere, and a second within 30 minutes', () => {
    expect(decideLeaving({ regionId: 'venue-1', open: null, nowMs: NOW })).toMatchObject({ action: 'quiet', why: 'not_checked_in' });
    expect(decideLeaving({ regionId: 'venue-2', open: open(), nowMs: NOW })).toMatchObject({ why: 'checked_in_elsewhere' });
    expect(
      decideLeaving({ regionId: 'venue-1', open: open(), nowMs: NOW, lastPromptAtMs: NOW - DEPARTURE_COOLDOWN_MS + 1 }),
    ).toMatchObject({ why: 'cooldown' });
    expect(
      decideLeaving({ regionId: 'venue-1', open: open(), nowMs: NOW, lastPromptAtMs: NOW - DEPARTURE_COOLDOWN_MS }).action,
    ).toBe('leaving');
  });

  it("a ▶ Play's own check-in gets it too (Check out = End since the merge)", () => {
    expect(decideLeaving({ regionId: 'venue-1', open: open({ source: 'session' }), nowMs: NOW })).toMatchObject({
      action: 'leaving',
      data: { checkin_id: open().id },
    });
  });

  it('names the court from the check-in, else the region, else "the courts"', () => {
    const named = decideLeaving({ regionId: 'venue-1', open: open({ venue_name: null }), nowMs: NOW, regionName: 'Saved name' });
    expect(named).toMatchObject({ title: 'Leaving Saved name?', data: { venue_name: 'Saved name' } });
    const none = decideLeaving({ regionId: 'venue-1', open: open({ venue_name: null }), nowMs: NOW });
    expect(none).toMatchObject({ title: 'Leaving the courts?', data: { venue_name: null, via_arrival: false } });
  });
});

describe('checkInOutcome (row 30)', () => {
  it('no fix on "At X?": already when confirmed, arriving while the arrival may still land', () => {
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: false, confirmed: true })).toBe('already');
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: false, confirmed: false, pending: true })).toBe('arriving');
    // A timeout or error reading it counts as still coming (Doggle).
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: false, confirmed: false, pending: null })).toBe('arriving');
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: false, confirmed: false, pending: false })).toBe('refused');
  });

  it('no fix on any other notice: refused', () => {
    expect(checkInOutcome({ onArrivalNotice: false, hasFix: false })).toBe('refused');
  });

  it('a fix: done, queued, or already when the row handed back is the arrival check-in', () => {
    expect(checkInOutcome({ onArrivalNotice: false, hasFix: true, checkin: { queued: false } })).toBe('done');
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: true, checkin: { queued: true } })).toBe('queued');
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: true, checkin: { queued: false, viaArrival: true } })).toBe('already');
  });

  it('a location refusal while the arrival is still coming says "Checking you in"', () => {
    expect(isLocationRefusalCode('fix.not_at_court')).toBe(true);
    expect(isLocationRefusalCode('court.gone')).toBe(false);
    expect(isLocationRefusalCode(null)).toBe(false);
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: true, refusalCode: 'fix.not_at_court', pending: null })).toBe('arriving');
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: true, refusalCode: 'fix.imprecise', pending: true })).toBe('arriving');
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: true, refusalCode: 'fix.not_at_court', pending: false })).toBe('refused');
    expect(checkInOutcome({ onArrivalNotice: false, hasFix: true, refusalCode: 'fix.not_at_court' })).toBe('refused');
    expect(checkInOutcome({ onArrivalNotice: true, hasFix: true, refusalCode: 'court.gone', pending: true })).toBe('refused');
  });

  it('words the new outcomes', () => {
    expect(checkInOutcomeCopy('already', 'Lakeside')).toEqual({
      title: "You're already checked in",
      body: "You're checked in at Lakeside.",
    });
    expect(checkInOutcomeCopy('already', null).body).toBe("You're checked in.");
    expect(checkInOutcomeCopy('arriving', 'Lakeside')).toEqual({
      title: 'Checking you in',
      body: "We couldn't confirm your location just now, but you'll be checked in here in a minute if you stay.",
    });
  });
});

describe('notHereOutcome (row 31)', () => {
  it('queued for signal', () => {
    expect(notHereOutcome({ queued: true }, 'Lakeside')).toEqual({
      title: 'Saved 📶',
      body: "No signal. We'll stop the check-in here once you're back online (within 2 hours). If it already counted, we'll check you out instead.",
      link: CHECKINS_SETTINGS_LINK,
    });
  });

  it('checked out (it already counted): links home', () => {
    expect(notHereOutcome({ queued: false, result: { dropped: false, removed: false, closed: true } }, 'Lakeside')).toEqual({
      title: 'Checked out',
      body: "You're checked out at Lakeside.",
      link: 'home/-',
    });
  });

  it('taken back', () => {
    expect(notHereOutcome({ queued: false, result: { dropped: false, removed: true, closed: false } }, 'Lakeside')).toEqual({
      title: 'Check-in removed',
      body: "We took back your check-in at Lakeside. It won't count as a visit.",
      link: CHECKINS_SETTINGS_LINK,
    });
  });

  it('nothing to act on', () => {
    expect(notHereOutcome({ queued: false, result: { dropped: false, removed: false, closed: false } }, 'Lakeside')).toEqual({
      title: 'Not checked in',
      body: "You weren't checked in at Lakeside.",
      link: CHECKINS_SETTINGS_LINK,
    });
  });

  it('a waiting arrival dropped, or no answer: not this time, and where to stop it', () => {
    const body =
      "We won't check you in at Lakeside this time. To stop it there, turn that court off in Settings, under Check-in automation.";
    expect(notHereOutcome({ queued: false, result: { dropped: true, removed: false, closed: false } }, 'Lakeside')).toEqual({
      title: 'Not checked in',
      body,
      link: CHECKINS_SETTINGS_LINK,
    });
    expect(notHereOutcome({ queued: false }, 'Lakeside').body).toBe(body);
    expect(notHereOutcome({ queued: false }, null).body).toBe(
      "We won't check you in this time. To stop it there, turn that court off in Settings, under Check-in automation.",
    );
  });

  it('timed out and failed', () => {
    expect(NOT_HERE_TIMED_OUT).toEqual({ title: 'That may not have saved', body: 'Open Pickleague to check your visit.' });
    expect(NOT_HERE_FAILED).toEqual({ title: "Couldn't cancel that check-in", body: 'Open Pickleague to check your visit.' });
  });
});

describe('showWhileAppActive (row 33)', () => {
  it('shows "At X?" and every other Pickleague notice', () => {
    expect(showWhileAppActive({ kind: ARRIVAL_NOTICE_KIND })).toBe(true);
    expect(showWhileAppActive({ kind: 'event_vote' })).toBe(true);
    expect(showWhileAppActive({ deepLink: 'wallet/p1' })).toBe(true);
    expect(showWhileAppActive({})).toBe(true);
    expect(showWhileAppActive(null)).toBe(true);
  });

  it('hides the court prompts, the arrival pushes and "Leaving X?"', () => {
    for (const kind of ['court_prompt', 'arrival_checkin', 'arrival_extend', 'arrival_failed', 'arrival_expired', 'checkin-departure']) {
      expect(showWhileAppActive({ kind })).toBe(false);
    }
  });
});

describe("the phone's own Checked in / Still at (D3) against the server", () => {
  const now = 50_000_000;
  // "Checked in" went off `ago` ms before now; "Still at" `untilIn` ms after it.
  const entry = (id: string, ago: number, untilIn = 20 * 60_000): ArrivalLocalEntry => ({
    id,
    at: now - ago,
    until: now - ago + untilIn,
  });

  it('a switch turned off cancels only arrivals still waiting out their minute', () => {
    const entries = { a: entry('x', -30_000), b: entry('y', 10_000) };
    expect(waitingArrivalVenues(entries, now)).toEqual(['a']);
    expect(waitingArrivalVenues(entries, now, 'b')).toEqual([]);
    expect(waitingArrivalVenues(entries, now, 'a')).toEqual(['a']);
  });

  it('leaves an entry the server may not have decided yet (its job can run a minute late)', () => {
    const entries = { a: entry('x', ARRIVAL_SETTLE_MS - 1) };
    expect(arrivalEntriesToSettle(entries, now)).toBe(false);
    expect(reconcileArrivalEntries(entries, null, now)).toEqual({ cancel: [], forget: [] });
  });

  it('cancels one whose check-in is not my open one: never made, or over', () => {
    const entries = { a: entry('x', ARRIVAL_SETTLE_MS), b: entry('y', 5 * 60_000) };
    expect(arrivalEntriesToSettle(entries, now)).toBe(true);
    expect(reconcileArrivalEntries(entries, null, now)).toEqual({ cancel: ['a', 'b'], forget: [] });
    expect(reconcileArrivalEntries(entries, { id: 'other' }, now)).toEqual({ cancel: ['a', 'b'], forget: [] });
  });

  it('keeps my open one until its "Still at" has gone off, then forgets it', () => {
    expect(reconcileArrivalEntries({ a: entry('x', 5 * 60_000) }, { id: 'x' }, now)).toEqual({ cancel: [], forget: [] });
    expect(reconcileArrivalEntries({ a: entry('x', 26 * 60_000, 25 * 60_000) }, { id: 'x' }, now)).toEqual({
      cancel: [],
      forget: ['a'],
    });
  });
});

describe('settings', () => {
  it('fills what is missing or not one of the choices with the defaults', () => {
    expect(normalizeCourtArrivalSettings(null)).toEqual(DEFAULT_COURT_ARRIVAL_SETTINGS);
    expect(
      normalizeCourtArrivalSettings({
        court_radius_m: 250,
        other_court_radius_m: 37,
        auto_checkin: false,
        departure_reminder: 'yes',
        consent_seen: true,
        auto_checkin_set_at: '2026-10-20T00:00:00Z',
      }),
    ).toEqual({
      court_radius_m: 250,
      other_court_radius_m: 0,
      auto_checkin: false,
      auto_checkin_set_at: '2026-10-20T00:00:00Z',
      departure_reminder: true,
      consent_seen: true,
    });
  });
});

describe('the watched courts (rows 5, 7)', () => {
  const pass = (regionId: string, passId: string, name = 'Club'): WalletRegionSource => ({
    regionId,
    passId,
    name,
    lat: 37.8,
    lng: -122.2,
  });
  const star = (venue_id: string, over: Partial<StarredCourtGeofence> = {}): StarredCourtGeofence => ({
    venue_id,
    name: `Court ${venue_id}`,
    lat: 37.7,
    lng: -122.1,
    radius_m: null,
    auto_checkin: true,
    ...over,
  });

  async function build(wallet: WalletRegionSource[], starred: StarredCourtGeofence[], courtRadiusM: number) {
    const built = await buildRegions(
      [
        { name: WALLET_TIER, load: () => walletTierRegions(wallet) },
        { name: STARRED_TIER, required: true, load: () => starredTierRegions(starred, courtRadiusM) },
      ],
      { merge: mergeCourtRegion },
    );
    return { built, ...buildCourtRegionList(built, { wallet, starred }) };
  }

  it('wallet courts first at 100 m, then starred courts at their outline or the chosen distance', async () => {
    const { regions, info } = await build(
      [pass('w1', 'p1'), pass('qr:p9', 'p9', 'Gym')],
      [star('s1', { radius_m: 140 }), star('s2')],
      250,
    );
    expect(regions.map((r) => [r.id, r.radiusM])).toEqual([
      ['w1', 100],
      ['qr:p9', 100],
      ['s1', 140],
      ['s2', 250],
    ]);
    expect(info).toEqual([
      { id: 'w1', name: 'Club', starred: false, autoCheckin: false, passId: 'p1' },
      { id: 'qr:p9', name: 'Gym', starred: false, autoCheckin: false, passId: 'p9' },
      { id: 's1', name: 'Court s1', starred: true, autoCheckin: true },
      { id: 's2', name: 'Court s2', starred: true, autoCheckin: true },
    ]);
  });

  it('a starred QR court keeps its wallet place and code but takes the starred circle', async () => {
    const { regions, info } = await build([pass('s1', 'p1')], [star('s0'), star('s1', { auto_checkin: false })], 1000);
    expect(regions.map((r) => [r.id, r.radiusM])).toEqual([
      ['s1', 800], // 1 km, clamped
      ['s0', 800],
    ]);
    expect(info[0]).toEqual({ id: 's1', name: 'Court s1', starred: true, autoCheckin: false, passId: 'p1' });
  });

  it('the first saved code wins for a court with two', async () => {
    const { regions, info } = await build([pass('w1', 'first'), pass('w1', 'second')], [], 100);
    expect(regions).toHaveLength(1);
    expect(info[0].passId).toBe('first');
  });

  it('"Notice me at starred courts" Off watches no starred court; courts without a pin are skipped', async () => {
    expect(starredTierRegions([star('s1')], 0)).toEqual([]);
    expect(starredTierRegions([star('s1', { lat: null })], 100)).toEqual([]);
    const { regions } = await build([pass('w1', 'p1')], [star('s1')], 0);
    expect(regions.map((r) => r.id)).toEqual(['w1']);
  });

  it('clamps every circle to 50-800 m and keeps at most 20, wallet courts first', async () => {
    const { regions } = await build(
      [pass('w1', 'p1')],
      [star('tiny', { radius_m: 20 }), ...Array.from({ length: 25 }, (_, i) => star(`s${i}`))],
      1000,
    );
    expect(regions).toHaveLength(MAX_COURT_REGIONS);
    expect(regions[0]).toMatchObject({ id: 'w1', radiusM: 100 });
    expect(regions[1]).toMatchObject({ id: 'tiny', radiusM: 50 });
    expect(regions.every((r) => r.radiusM >= 50 && r.radiusM <= 800)).toBe(true);
  });

  it('a failed starred read aborts the build (the courts already watched stay)', async () => {
    const built = await buildRegions(
      [
        { name: WALLET_TIER, load: () => walletTierRegions([pass('w1', 'p1')]) },
        {
          name: STARRED_TIER,
          required: true,
          load: async () => {
            throw new Error('offline');
          },
        },
      ],
      { merge: mergeCourtRegion },
    );
    expect(built.abort).toBe(true);
  });

  it('merge keeps the first circle unless a starred tier brings its own', () => {
    const a = { id: 'x', lat: 1, lng: 2, radiusM: 100 };
    const b = { id: 'x', lat: 1, lng: 2, radiusM: 400 };
    expect(mergeCourtRegion(a, b, { kept: [WALLET_TIER], incoming: STARRED_TIER })).toEqual({ ...a, radiusM: 400 });
    expect(mergeCourtRegion(a, b, { kept: [WALLET_TIER], incoming: WALLET_TIER })).toEqual(a);
    expect(mergeCourtRegion(a, b, { kept: [STARRED_TIER], incoming: STARRED_TIER })).toEqual(a);
  });
});
