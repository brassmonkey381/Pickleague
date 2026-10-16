import { describe, it, expect } from 'vitest';
import {
  REFUSAL_CODES,
  confirmResultMessage,
  drillReviewRefusal,
  extendedNote,
  queuedRefusalNotice,
  refusalCode,
  refusalCopy,
  refusalDetail,
  refusalMessage,
  refusalTitle,
  untrackedStartNote,
  whenLabel,
  type RefusalCode,
} from '../refusals';

// A fixed formatter, so the copy doesn't depend on the test machine's zone.
const label = (d: Date) => d.toISOString().slice(11, 16);
const T0 = Date.parse('2026-10-16T18:00:00.000Z');

// The codes migration_refusal_messages.sql raises (HINT 'pl:<code>').
const SERVER_CODES: RefusalCode[] = [
  'auth.signed_out',
  'request.bad',
  'court.gone',
  'court.favorites_full',
  'fix.stale',
  'fix.stale_clock',
  'fix.imprecise',
  'fix.not_at_court',
  'fix.malformed',
  'checkin.none',
  'checkin.closed',
  'checkin.needs_fix',
  'session.not_yours',
  'match.removed',
  'match.already_confirmed',
  'match.scheduled',
  'match.confirm_expired',
  'match.not_player',
  'player.gone',
  'presence.pick_someone',
  'friend.self',
  'friend.guest_caller',
  'friend.unclaimed',
  'friend.guest',
  'friend.unavailable',
  'friend.daily_cap',
  'friend.not_friends',
];

const GENERIC = /something went wrong|an error occurred|try again later\.?$|^error/i;

describe('every refusal code has its own plain words', () => {
  it('knows every code the server raises', () => {
    for (const code of SERVER_CODES) expect(REFUSAL_CODES).toContain(code);
    for (const code of SERVER_CODES) expect(refusalCode({ message: 'x', hint: `pl:${code}` })).toBe(code);
  });

  it('each code: non-empty, not generic, a full sentence, no em dash, never a network or permission word', () => {
    const contexts = [
      {},
      { venueName: 'Lakeside', personName: 'Sam', leagueName: 'Tuesday Doubles' },
      { action: 'extend' as const, surface: 'lock' as const },
      { action: 'start' as const },
      { action: 'favorite' as const },
      { action: 'hide' as const },
    ];
    for (const code of REFUSAL_CODES) {
      for (const ctx of contexts) {
        const text = refusalCopy(code, ctx);
        expect(text.length, code).toBeGreaterThan(20);
        expect(text, code).not.toMatch(GENERIC);
        expect(text, code).toMatch(/[.!]$/);
        expect(text, code).not.toContain('—');
        // 1.0.4 would read these as no connection / not signed in / no access.
        expect(text, code).not.toMatch(/timed out|load failed|failed to fetch|network|jwt|permission denied|row-level/i);
      }
      expect(refusalTitle(code).length, code).toBeGreaterThan(3);
    }
  });

  it('words what the app knows: the court, the person, the league', () => {
    expect(refusalCopy('fix.not_at_court', { venueName: 'Lakeside' }, { distance_m: 328.4 })).toBe(
      "You're about 328 m from Lakeside. You need to be at the court to check in, so try again when you get there.",
    );
    expect(refusalCopy('fix.not_at_court', { venueName: 'Lakeside', action: 'extend' }, { distance_m: 410 })).toBe(
      "You're about 410 m from Lakeside, so your check-in can't be extended. Check in again when you're back at the court.",
    );
    expect(refusalCopy('friend.unclaimed', { personName: 'Sam' })).toBe(
      "Sam hasn't joined Pickleague yet, so you can't add them as a friend.",
    );
    expect(refusalCopy('match.not_member', { leagueName: 'Tuesday Doubles' })).toBe(
      "You're not a member of Tuesday Doubles any more, so you can't record matches there. Pick a league you're in.",
    );
  });

  it('times come from DETAIL, in the device zone', () => {
    expect(
      refusalCopy('checkin.closed', { venueName: 'Lakeside', timeLabel: label }, { ended_at: '2026-10-16T17:40:00Z' }),
    ).toBe("Your check-in at Lakeside already ended at 17:40. Check in again when you're at the court.");
    expect(
      refusalCopy('match.confirm_expired', { timeLabel: label }, { deadline: '2026-10-16T17:40:00Z' }),
    ).toBe('Too late to confirm: the hour to confirm this match ended at 17:40. Ask whoever recorded it to enter it again.');
    expect(
      refusalCopy('checkin.needs_fix', { venueName: 'Lakeside', surface: 'lock', timeLabel: label }, { last_fix_at: '2026-10-16T13:40:00Z' }),
    ).toBe(
      'Pickleague last confirmed you at Lakeside at 13:40, and a check-in lasts at most 4 hours past that. Open Pickleague at the court to stay checked in.',
    );
  });

  it('a block stays vague: the same words as a deleted account', () => {
    expect(refusalCopy('friend.unavailable', { personName: 'Sam' })).toBe(
      "This player isn't available, so you can't add them as a friend.",
    );
  });
});

describe('refusalCode: codes first, then the texts an older server sends', () => {
  it('reads the HINT, ignoring unknown codes', () => {
    expect(refusalCode({ message: 'whatever', hint: 'pl:checkin.closed' })).toBe('checkin.closed');
    expect(refusalCode({ message: 'whatever', hint: 'pl:no.such_code' })).toBeNull();
    expect(refusalCode({ message: 'whatever', hint: 'something else' })).toBeNull();
  });

  it('maps the pre-2026-10-16 messages', () => {
    const cases: [string, RefusalCode][] = [
      ['Not authenticated', 'auth.signed_out'],
      ['You need to be at the court to check in (about 328 m away).', 'fix.not_at_court'],
      ["Your location isn't precise enough to confirm you're at the court.", 'fix.imprecise'],
      ['Your location is out of date. Try again at the court.', 'fix.stale'],
      ["Your location is out of date. Check that your phone's date and time are set automatically, then try again at the court.", 'fix.stale_clock'],
      ["Your location didn't come through. Try again.", 'fix.malformed'],
      ['Court not found', 'court.gone'],
      ['Check-in is no longer open', 'checkin.closed'],
      ["To stay checked in, open Pickleague at the court so it can confirm you're still there.", 'checkin.needs_fix'],
      ['Missing check-in id', 'request.bad'],
      ['Not your session', 'session.not_yours'],
      ['Match not found', 'match.removed'],
      ['Confirmation window has expired', 'match.confirm_expired'],
      ['Match is no longer pending', 'match.not_pending'],
      ['Only players on this match can confirm it', 'match.not_player'],
      ['Player not found', 'player.gone'],
      ['Pick someone else', 'presence.pick_someone'],
      ["You can't add yourself as a friend", 'friend.self'],
      ['Create an account to add friends', 'friend.guest_caller'],
      ["This player isn't available", 'friend.unavailable'],
      ["You've sent 20 friend requests today. Try again tomorrow.", 'friend.daily_cap'],
      ['Only friends can be close friends', 'friend.not_friends'],
      ['You can star up to 5 courts. Remove one first.', 'court.favorites_full'],
    ];
    for (const [message, code] of cases) expect(refusalCode({ message }), message).toBe(code);
  });

  it('an old "(about N m away)" still gives the distance', () => {
    expect(refusalMessage({ message: 'You need to be at the court to check in (about 240 m away).' }, { venueName: 'Lakeside' })).toBe(
      "You're about 240 m from Lakeside. You need to be at the court to check in, so try again when you get there.",
    );
  });

  it('unknown refusals fall back: no code, no copy (the caller shows the kit text or its own fallback)', () => {
    expect(refusalCode(null)).toBeNull();
    expect(refusalCode(new Error('Failed to fetch'))).toBeNull();
    expect(refusalCode({ message: 'new row for relation "x" violates check constraint "y"', code: '23514' })).toBeNull();
    expect(refusalMessage({ message: 'Something nobody planned for' })).toBeNull();
  });

  it('DETAIL is read only when it is a JSON object', () => {
    expect(refusalDetail({ details: '{"distance_m": 12}' })).toEqual({ distance_m: 12 });
    expect(refusalDetail({ details: 'Key (id)=(1) already exists.' })).toEqual({});
    expect(refusalDetail({ details: '{broken' })).toEqual({});
    expect(refusalDetail(null)).toEqual({});
  });
});

describe('queuedRefusalNotice: a write saved with no signal and refused later', () => {
  it('a check-out: where, when, why, until when they may still show, what to do', () => {
    expect(
      queuedRefusalNotice({
        what: 'check_out',
        venueName: 'Lakeside',
        tapMs: T0,
        untilMs: T0 + 2 * 3_600_000,
        nowMs: T0 + 60_000,
        timeLabel: label,
        error: { message: 'whatever', hint: 'pl:request.bad', code: 'P0001' },
      }),
    ).toBe(
      "Your check-out at Lakeside (18:00) didn't reach Pickleague. That didn't go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again. You may still show there until 20:00. Tap Check out to try again.",
    );
  });

  it('a Start: not saved, so it won\'t count, and why', () => {
    expect(
      queuedRefusalNotice({
        what: 'start',
        tapMs: T0,
        timeLabel: label,
        error: { message: 'x', hint: 'pl:session.not_yours', code: 'P0001' },
      }),
    ).toBe(
      "Your play session from 18:00 wasn't saved, so it won't count. That play session belongs to another account, so it wasn't saved. Start a new session.",
    );
    // A raw Postgres text is never shown: the plain action instead.
    expect(
      queuedRefusalNotice({ what: 'start', tapMs: T0, timeLabel: label, error: { message: 'violates check constraint', code: '23514' } }),
    ).toBe("Your play session from 18:00 wasn't saved, so it won't count. Start a new one when you play.");
  });

  it('an End: the session may still be running; tap End again', () => {
    expect(queuedRefusalNotice({ what: 'end', tapMs: T0, timeLabel: label, error: null })).toBe(
      "Your End (18:00) didn't reach Pickleague, so your play session may still be running. Tap End again.",
    );
  });
});

describe('extendedNote: +1 h answered with less', () => {
  it('the full hour', () => {
    expect(extendedNote({ requestedUntilMs: T0, gotUntilMs: T0, timeLabel: label })).toEqual({
      full: true,
      message: 'Checked in until 18:00.',
    });
  });

  it('less, and why', () => {
    expect(
      extendedNote({ requestedUntilMs: T0, gotUntilMs: T0 - 45 * 60_000, venueName: 'Lakeside', timeLabel: label }),
    ).toEqual({
      full: false,
      message:
        "Checked in until 17:15, not a full hour: Pickleague couldn't confirm you're still at Lakeside. Open Pickleague at the court to stay later.",
    });
  });
});

describe('the rest of the "said why" copy', () => {
  it('confirm results: settled, the other team still has to (by when), my team already did', () => {
    const d = '2026-10-16T18:40:00Z';
    expect(confirmResultMessage('completed', d, { timeLabel: label })).toBe('Match confirmed. Ratings update shortly.');
    expect(confirmResultMessage('one_team_confirmed', d, { timeLabel: label })).toBe(
      'Confirmed for your team. The other team has until 18:40 to confirm, then ratings update.',
    );
    expect(confirmResultMessage('already_your_team', d, { timeLabel: label })).toBe(
      "Your team already confirmed this match. It's waiting on the other team until 18:40.",
    );
  });

  it('drill review answers, old and new', () => {
    expect(drillReviewRefusal('Already reviewed')).toBe('You already reviewed this drill. Each drill gets one review.');
    expect(drillReviewRefusal('This drill starts Thu Oct 16, 5:40 PM. You can review it after it starts.')).toBe(
      'This drill starts Thu Oct 16, 5:40 PM. You can review it after it starts.',
    );
    expect(drillReviewRefusal(null)).toBe("Your review wasn't saved. Try again.");
  });

  it('a Start at a court that did not check me in: the real reason', () => {
    expect(untrackedStartNote('Lakeside', 'not_at_court')).toBe(
      "Not checked in at Lakeside: you're not at the court, so only you see this session. Check in from Home when you get there.",
    );
    expect(untrackedStartNote('Lakeside', 'stale')).toContain('reached Pickleague too late');
    expect(untrackedStartNote('Lakeside', 'imprecise')).toContain('Precise Location');
    expect(untrackedStartNote('Lakeside', 'no_fix')).toContain("couldn't get your location");
    expect(untrackedStartNote(null, 'court_gone')).toContain("isn't in Pickleague any more");
  });

  it('whenLabel: the time today, the weekday otherwise (device zone)', () => {
    const now = new Date(2026, 9, 16, 18, 0).getTime();
    expect(whenLabel(new Date(2026, 9, 16, 17, 40), now)).toBe('5:40 PM');
    expect(whenLabel(new Date(2026, 9, 15, 17, 40), now)).toBe('Thu 5:40 PM');
  });
});
