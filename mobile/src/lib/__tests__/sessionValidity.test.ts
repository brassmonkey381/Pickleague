import { describe, it, expect } from 'vitest';
import {
  MIN_SESSION_MS,
  PENDING_END_NOTE,
  RECORD_WINDOW_MS,
  drillReviewNote,
  endDecision,
  endDecisionWithServer,
  endSheetBody,
  isMissingColumnError,
  lostPlayNote,
  notNowNote,
  sessionLengthLabel,
  shouldNoteRecorded,
  validityNote,
  whyNotCounted,
  type EndDecision,
  type EndedPlay,
  type SessionValidity,
} from '../sessionValidity';

const T0 = Date.parse('2026-10-16T18:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ended = (lengthMs: number, extra: Partial<EndedPlay> = {}): EndedPlay => ({
  id: 's1',
  kind: 'open_play',
  sourceId: null,
  startedAtMs: T0,
  endedAtMs: T0 + lengthMs,
  recorded: null,
  ...extra,
});
// A fixed formatter, so the copy doesn't depend on the test machine's zone.
const label = (d: Date) => d.toISOString().slice(11, 16);
const v = (x: Partial<SessionValidity>): SessionValidity => ({
  valid: false,
  reason: 'no_match_or_drill',
  needs: 'match_or_drill',
  window_ends_at: null,
  ...x,
});

describe('endDecision', () => {
  it('says plainly that a session under 5 minutes does not count, and how long it was (no sheet)', () => {
    expect(endDecision(ended(4 * MIN + 1_000))).toEqual({
      show: 'note',
      tone: 'info',
      message: "Session ended after 4 min. Sessions under 5 minutes don't count.",
    });
  });

  it('...and that a match recorded during it is still recorded', () => {
    expect(endDecision(ended(2 * MIN, { recorded: 'match_pending' }))).toEqual({
      show: 'note',
      tone: 'info',
      message: "Session ended after 2 min. Sessions under 5 minutes don't count. Your match is still recorded.",
    });
  });

  it('asks for a match or drill from exactly 5 minutes, with the 2-hour window', () => {
    expect(endDecision(ended(MIN_SESSION_MS))).toEqual({
      show: 'record',
      lengthLabel: '5 min',
      lengthMs: MIN_SESSION_MS,
      offerDrill: false,
      windowEndsAtMs: T0 + MIN_SESSION_MS + RECORD_WINDOW_MS,
    });
  });

  it('offers the drill review for any drill session (the server counts any drill held during it)', () => {
    const fromNotice = endDecision(ended(45 * MIN, { kind: 'drill', sourceId: 'd1' }));
    const fromChip = endDecision(ended(45 * MIN, { kind: 'drill', sourceId: null }));
    expect(fromNotice.show === 'record' && fromNotice.offerDrill).toBe(true);
    expect(fromChip.show === 'record' && fromChip.offerDrill).toBe(true);
  });

  it('decision 3: a pending match counts once the other team confirms (within the hour)', () => {
    expect(PENDING_END_NOTE).toBe('Session ended. It counts once the other team confirms (within the hour).');
    // 'match' is what a build before 2026-10-16 stored: read as pending.
    for (const recorded of ['match_pending', 'match'] as const) {
      expect(endDecision(ended(30 * MIN, { recorded }))).toEqual({ show: 'note', tone: 'success', message: PENDING_END_NOTE });
    }
  });

  it('a match stored confirmed counts outright', () => {
    expect(endDecision(ended(30 * MIN, { recorded: 'match_confirmed' }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: you recorded a match.',
    });
  });

  it('names the reviewed drill', () => {
    expect(endDecision(ended(30 * MIN, { recorded: 'drill' }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: you reviewed a drill held during it.',
    });
  });
});

describe('endDecisionWithServer (End asks my_session_validity before the sheet)', () => {
  const ask = endDecision(ended(35 * MIN)) as Extract<EndDecision, { show: 'record' }>;

  it('a session the server still has open, with nothing more needed (End on its way), counts', () => {
    expect(endDecisionWithServer(ask, v({ reason: 'open', needs: null }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: a match or drill you played is recorded.',
    });
  });

  it('...but while its match is still pending, it counts once the other team confirms', () => {
    const d = endDecisionWithServer(ask, v({ reason: 'open', needs: null, match_pending: true }));
    expect(d.show === 'note' && d.message).toBe(PENDING_END_NOTE);
  });

  it('a valid session counts: a match a partner or opponent recorded, no duplicate asked for', () => {
    expect(endDecisionWithServer(ask, v({ valid: true, reason: 'match_in_window', needs: null }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: a match you played in is recorded.',
    });
  });

  it('says when the match still needs the other team (decision 3)', () => {
    const d = endDecisionWithServer(
      ask,
      v({ valid: true, reason: 'linked_match', needs: null, rewards_pending_confirmation: true }),
    );
    expect(d.show === 'note' && d.message).toBe(PENDING_END_NOTE);
  });

  it('names a reviewed drill', () => {
    const d = endDecisionWithServer(ask, v({ valid: true, reason: 'drill_in_window', needs: null }));
    expect(d.show === 'note' && d.message).toBe('Session ended. It counts: you reviewed a drill held during it.');
  });

  it('too short by the server (it moved the start): the too-short note with that reason, not the sheet', () => {
    for (const x of [v({ reason: 'too_short', needs: 'minutes' }), v({ reason: 'open', needs: 'minutes' })]) {
      expect(endDecisionWithServer(ask, x)).toEqual({
        show: 'note',
        tone: 'info',
        message:
          "Session ended. Pickleague counted under 5 minutes of it because it overlapped your previous session. Sessions under 5 minutes don't count.",
      });
    }
  });

  it('too short because the server moved its start (it overlapped an earlier session): says so', () => {
    const d = endDecisionWithServer(
      ask,
      v({ reason: 'too_short', needs: 'minutes', started_at: iso(T0 + 32 * MIN), ended_at: iso(T0 + 35 * MIN) }),
    );
    expect(d).toEqual({
      show: 'note',
      tone: 'info',
      message:
        "Session ended. Pickleague counted only 3 min of it because it overlapped your previous session. Sessions under 5 minutes don't count.",
    });
  });

  it('a match or drill still needed: the sheet, unchanged (sure)', () => {
    expect(endDecisionWithServer(ask, v({}))).toEqual(ask);
    expect(endDecisionWithServer(ask, v({ reason: 'open', needs: 'match_or_drill' }))).toEqual(ask);
  });

  it('...with why, when what the player recorded counts for another session', () => {
    const d = endDecisionWithServer(
      ask,
      v({ why: 'match_counted_elsewhere', match_at: iso(T0 + 40 * MIN), counted_for_started_at: iso(T0 - 90 * MIN) }),
      { timeLabel: label },
    );
    expect(d).toEqual({
      ...ask,
      why: 'The match recorded at 18:40 counts for your session from 16:30, and a match counts for one session only.',
    });
  });

  it('no answer (not on the server yet, timed out, failed): the sheet, hedged', () => {
    expect(endDecisionWithServer(ask, null)).toEqual({ ...ask, unsure: true });
    expect(endDecisionWithServer(ask, 'unknown')).toEqual({ ...ask, unsure: true });
  });

  it('leaves a local toast alone', () => {
    const short = endDecision(ended(2 * MIN));
    expect(endDecisionWithServer(short, v({ valid: true, reason: 'linked_match', needs: null }))).toBe(short);
  });
});

describe('endSheetBody', () => {
  const ask = endDecision(ended(35 * MIN)) as Extract<EndDecision, { show: 'record' }>;

  it('says why it does not count yet, and by when to record one', () => {
    expect(endSheetBody(ask, { timeLabel: label })).toBe(
      "Session ended after 35 min. It doesn't count yet: no match or drill is recorded for it. Record one by 20:35.",
    );
  });

  it('never claims nothing was recorded when the server could not say', () => {
    expect(endSheetBody({ ...ask, unsure: true }, { timeLabel: label })).toBe(
      "Session ended after 35 min. If you haven't recorded what you played yet, record a match or drill by 20:35 and this session counts.",
    );
  });

  it("with the server's why", () => {
    const why = 'The match recorded at 18:40 counts for your session from 16:30, and a match counts for one session only.';
    expect(endSheetBody({ ...ask, why }, { timeLabel: label })).toBe(
      `Session ended after 35 min. ${why} Record another match or drill by 20:35 to make this one count.`,
    );
  });
});

describe('whyNotCounted', () => {
  it('a drill held another day', () => {
    expect(
      whyNotCounted(v({ why: 'drill_not_during_session', drill_starts_at: iso(T0 - 24 * 60 * MIN) }), { timeLabel: label }),
    ).toBe("Your drill review doesn't count for it: that drill was scheduled for 18:00, not during this session.");
    expect(whyNotCounted(v({ why: 'drill_not_during_session' }))).toBe(
      "Your drill review doesn't count for it: that drill wasn't held during this session.",
    );
  });

  it('nothing to say without a why', () => {
    expect(whyNotCounted(v({}))).toBeNull();
  });
});

describe('sessionLengthLabel', () => {
  it('reads minutes, then hours and minutes', () => {
    expect(sessionLengthLabel(20_000)).toBe('1 min');
    expect(sessionLengthLabel(42 * MIN)).toBe('42 min');
    expect(sessionLengthLabel(60 * MIN)).toBe('1 h');
    expect(sessionLengthLabel(65 * MIN)).toBe('1 h 5 min');
    expect(sessionLengthLabel(125 * MIN)).toBe('2 h 5 min');
  });
});

describe('notNowNote', () => {
  it('names the time the window closes', () => {
    expect(notNowNote(T0 + RECORD_WINDOW_MS, label)).toBe('Saved. It counts if you record a match or drill by 20:00.');
  });

  it('hedged when the server could not say whether something already counts', () => {
    expect(notNowNote(T0 + RECORD_WINDOW_MS, label, true)).toBe(
      "Saved. If nothing's recorded yet, it counts once you record a match or drill by 20:00.",
    );
  });
});

describe('shouldNoteRecorded (MatchEntry: does this match make my session count?)', () => {
  it('a match I played in, linked and kept by the server, counts', () => {
    expect(shouldNoteRecorded({ iPlayed: true, sessionId: 's1', sentLink: true, linkedBack: 's1' })).toBe(true);
  });

  it('a match between other players never counts for me (the server drops the link and the window ignores it)', () => {
    expect(shouldNoteRecorded({ iPlayed: false, sessionId: 's1', sentLink: true, linkedBack: 's1' })).toBe(false);
    expect(shouldNoteRecorded({ iPlayed: false, sessionId: 's1', sentLink: false })).toBe(false);
  });

  it('a link the server dropped (session not stored yet, refused, or over) is not claimed: End asks the server', () => {
    expect(shouldNoteRecorded({ iPlayed: true, sessionId: 's1', sentLink: true, linkedBack: null })).toBe(false);
  });

  it('an unlinked match I played in while my session runs counts (from Home, a league, an event)', () => {
    expect(shouldNoteRecorded({ iPlayed: true, sessionId: 's1', sentLink: false })).toBe(true);
  });

  it('a server without the column (no link read back) is taken at its word', () => {
    expect(shouldNoteRecorded({ iPlayed: true, sessionId: 's1', sentLink: true, linkedBack: undefined })).toBe(true);
  });
});

describe('validityNote (my_session_validity, worded)', () => {
  it('says nothing without an answer', () => {
    expect(validityNote(null, T0, label)).toBeNull();
    expect(validityNote(undefined, T0, label)).toBeNull();
  });

  it('a running session: counts now, counts once confirmed (by when), or once it has run 5 minutes', () => {
    expect(validityNote(v({ reason: 'open', needs: null }), T0, label)).toBe('Your play session counts now.');
    expect(
      validityNote(v({ reason: 'open', needs: null, match_pending: true, confirm_by: iso(T0 + 60 * MIN) }), T0, label),
    ).toBe('Your play session counts once the other team confirms this match, by 19:00.');
    expect(validityNote(v({ reason: 'open', needs: 'minutes' }), T0, label)).toBe(
      'Your match is recorded. It counts for your play session once the session has run 5 minutes.',
    );
    expect(validityNote(v({ reason: 'open', needs: 'match_or_drill' }), T0, label)).toBeNull();
  });

  it('a valid session counts, whatever made it valid', () => {
    for (const reason of ['linked_match', 'match_in_window', 'drill_in_window'] as const) {
      expect(validityNote(v({ valid: true, reason, needs: null }), T0, label)).toBe('This play session counts now.');
    }
  });

  it('...pending: once the other team confirms, by when (or within the hour)', () => {
    expect(
      validityNote(
        v({ valid: true, reason: 'linked_match', needs: null, rewards_pending_confirmation: true, confirm_by: iso(T0 + 45 * MIN) }),
        T0,
        label,
      ),
    ).toBe('This play session counts once the other team confirms this match, by 18:45.');
    expect(
      validityNote(v({ valid: true, reason: 'linked_match', needs: null, rewards_pending_confirmation: true }), T0, label),
    ).toBe('This play session counts once the other team confirms this match, within the hour.');
  });

  it('too short, and how long it was when the server says', () => {
    expect(validityNote(v({ reason: 'too_short', needs: 'minutes' }), T0, label)).toBe(
      "Sessions under 5 minutes don't count.",
    );
    expect(
      validityNote(v({ reason: 'too_short', needs: 'minutes', started_at: iso(T0), ended_at: iso(T0 + 3 * MIN) }), T0, label),
    ).toBe("Sessions under 5 minutes don't count. This one lasted 3 min.");
  });

  it('still in the window: by when, with why when the server says', () => {
    expect(validityNote(v({ window_ends_at: iso(T0 + 30 * MIN) }), T0, label)).toBe(
      'This session counts once you record a match or drill by 18:30.',
    );
    expect(
      validityNote(
        v({ window_ends_at: iso(T0 + 30 * MIN), why: 'drill_not_during_session', drill_starts_at: iso(T0 - 120 * MIN) }),
        T0,
        label,
      ),
    ).toBe(
      "Your drill review doesn't count for it: that drill was scheduled for 16:00, not during this session. This session counts once you record a match or drill by 18:30.",
    );
  });

  it('window closed (or unknown): it did not count', () => {
    const missed = "This session didn't count: no match or drill was recorded within 2 hours of its end.";
    expect(validityNote(v({ window_ends_at: iso(T0 - MIN) }), T0, label)).toBe(missed);
    expect(validityNote(v({ window_ends_at: iso(T0) }), T0, label)).toBe(missed);
    expect(validityNote(v({ window_ends_at: null }), T0, label)).toBe(missed);
  });
});

describe('drillReviewNote (after a drill review)', () => {
  it('counts now through the drill', () => {
    expect(drillReviewNote(v({ valid: true, reason: 'drill_in_window', needs: null }))).toBe(
      'Your play session counts now: you reviewed a drill held during it.',
    );
    expect(drillReviewNote(v({ reason: 'open', needs: null }), { running: true })).toBe(
      'Your play session counts now: you reviewed a drill held during it.',
    );
  });

  it('a drill held another time: why', () => {
    expect(drillReviewNote(v({ why: 'drill_not_during_session', drill_starts_at: iso(T0) }), { timeLabel: label })).toBe(
      "This drill doesn't count for your play session: it was scheduled for 18:00, not during the session.",
    );
  });

  it('nothing to say: no answer, or it already counted through a match', () => {
    expect(drillReviewNote(null)).toBeNull();
    expect(drillReviewNote(v({ valid: true, reason: 'linked_match', needs: null }))).toBeNull();
  });
});

describe("lostPlayNote (the island's session ended without this device)", () => {
  it('auto-ended after 6 hours, with the time left to record', () => {
    const start = T0 - 6 * 60 * MIN - 30 * MIN;
    expect(
      lostPlayNote({ reason: 'auto_ended', startedAtMs: start, endedAtMs: start + 6 * 60 * MIN }, { timeLabel: label, nowMs: T0 }),
    ).toBe(
      'Your play session ended on its own after 6 hours, at 17:30. If you played, record a match or drill by 19:30 so it counts.',
    );
  });

  it('ended elsewhere, or never saved', () => {
    expect(lostPlayNote({ reason: 'ended_elsewhere', startedAtMs: T0, endedAtMs: T0 + 30 * MIN }, { timeLabel: label })).toBe(
      'Your play session from 18:00 ended at 18:30, on another device or when you started a new one.',
    );
    expect(lostPlayNote({ reason: 'never_saved', startedAtMs: T0, endedAtMs: null }, { timeLabel: label })).toBe(
      "Your play session from 18:00 never reached Pickleague, so it isn't saved and won't count. Start a new one when you play.",
    );
  });
});

describe('isMissingColumnError', () => {
  const err = { code: 'PGRST204', message: "Could not find the 'play_session_id' column of 'matches' in the schema cache" };

  it('matches PostgREST refusing that column', () => {
    expect(isMissingColumnError(err, 'play_session_id')).toBe(true);
  });

  it('ignores other columns, other codes and anything else', () => {
    expect(isMissingColumnError(err, 'event_id')).toBe(false);
    expect(isMissingColumnError({ ...err, code: '42501' }, 'play_session_id')).toBe(false);
    expect(isMissingColumnError(new Error('network'), 'play_session_id')).toBe(false);
    expect(isMissingColumnError(null, 'play_session_id')).toBe(false);
  });
});
