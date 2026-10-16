import { describe, it, expect } from 'vitest';
import {
  MIN_SESSION_MS,
  RECORD_WINDOW_MS,
  endDecision,
  endDecisionWithServer,
  endSheetBody,
  isMissingColumnError,
  notNowNote,
  sessionLengthLabel,
  shouldNoteRecorded,
  validityNote,
  type EndDecision,
  type EndedPlay,
  type SessionValidity,
} from '../sessionValidity';

const T0 = Date.parse('2026-10-16T18:00:00.000Z');
const MIN = 60_000;
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
  it('says plainly that a session under 5 minutes does not count (no sheet)', () => {
    expect(endDecision(ended(4 * MIN + 59_000))).toEqual({
      show: 'note',
      tone: 'info',
      message: "Session ended. Sessions under 5 minutes don't count.",
    });
  });

  it('asks for a match or drill from exactly 5 minutes, with the 2-hour window', () => {
    expect(endDecision(ended(MIN_SESSION_MS))).toEqual({
      show: 'record',
      lengthLabel: '5 min',
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

  it('does not ask again when a match was already recorded for the session', () => {
    expect(endDecision(ended(30 * MIN, { recorded: 'match' }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: you recorded a match.',
    });
  });

  it('does not ask again when the server said a reviewed drill made it count', () => {
    expect(endDecision(ended(30 * MIN, { recorded: 'drill' }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: you recorded a match or drill.',
    });
  });

  it('still calls a too-short session too short, recorded match or not', () => {
    const d = endDecision(ended(2 * MIN, { recorded: 'match' }));
    expect(d.show === 'note' && d.tone).toBe('info');
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

  it('a valid session counts: a match a partner or opponent recorded, no duplicate asked for', () => {
    expect(endDecisionWithServer(ask, v({ valid: true, reason: 'match_in_window', needs: null }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: a match you played in is recorded.',
    });
  });

  it('says when the match still needs the other team within the hour', () => {
    const d = endDecisionWithServer(
      ask,
      v({ valid: true, reason: 'linked_match', needs: null, rewards_pending_confirmation: true }),
    );
    expect(d.show === 'note' && d.message).toBe(
      "Session ended. It counts: a match you played in is recorded. If the other team doesn't confirm within the hour, it stops counting.",
    );
  });

  it('names a reviewed drill', () => {
    const d = endDecisionWithServer(ask, v({ valid: true, reason: 'drill_in_window', needs: null }));
    expect(d.show === 'note' && d.message).toBe('Session ended. It counts: you reviewed a drill.');
  });

  it('too short by the server: the too-short note, not the sheet', () => {
    for (const x of [v({ reason: 'too_short', needs: 'minutes' }), v({ reason: 'open', needs: 'minutes' })]) {
      expect(endDecisionWithServer(ask, x)).toEqual({
        show: 'note',
        tone: 'info',
        message: "Session ended. Sessions under 5 minutes don't count.",
      });
    }
  });

  it('a match or drill still needed: the sheet, unchanged (sure)', () => {
    expect(endDecisionWithServer(ask, v({}))).toEqual(ask);
    expect(endDecisionWithServer(ask, v({ reason: 'open', needs: 'match_or_drill' }))).toEqual(ask);
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

  it('asks plainly when the server said nothing counts yet', () => {
    expect(endSheetBody(ask)).toBe('Session ended after 35 min. It counts once you record what you played, within 2 hours.');
  });

  it('never claims nothing was recorded when the server could not say', () => {
    expect(endSheetBody({ ...ask, unsure: true })).toBe(
      "Session ended after 35 min. If you haven't recorded what you played yet, record it within 2 hours and this session counts.",
    );
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
    expect(notNowNote(T0 + RECORD_WINDOW_MS, label)).toBe(
      'Saved. This session counts once you record a match or drill within 2 hours (by 20:00).',
    );
  });

  it('hedged when the server could not say whether something already counts', () => {
    expect(notNowNote(T0 + RECORD_WINDOW_MS, label, true)).toBe(
      "Saved. If nothing's recorded yet, this session counts once you record a match or drill by 20:00.",
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
  it('says nothing without an answer or while the session runs', () => {
    expect(validityNote(null, T0, label)).toBeNull();
    expect(validityNote(undefined, T0, label)).toBeNull();
    expect(validityNote(v({ reason: 'open', needs: null }), T0, label)).toBeNull();
    expect(validityNote(v({ reason: 'open', needs: 'minutes' }), T0, label)).toBeNull();
  });

  it('a valid session counts, whatever made it valid', () => {
    for (const reason of ['linked_match', 'match_in_window', 'drill_in_window'] as const) {
      expect(validityNote(v({ valid: true, reason, needs: null }), T0, label)).toBe('This play session counts now.');
    }
  });

  it('...and says it lapses if the other team does not confirm within the hour', () => {
    expect(
      validityNote(
        v({ valid: true, reason: 'linked_match', needs: null, rewards_pending_confirmation: true }),
        T0,
        label,
      ),
    ).toBe("This play session counts now. If the other team doesn't confirm within the hour, it stops counting.");
  });

  it('too short', () => {
    expect(validityNote(v({ reason: 'too_short', needs: 'minutes' }), T0, label)).toBe(
      "Sessions under 5 minutes don't count.",
    );
  });

  it('still in the window: by when', () => {
    expect(validityNote(v({ window_ends_at: new Date(T0 + 30 * MIN).toISOString() }), T0, label)).toBe(
      'This session counts once you record a match or drill by 18:30.',
    );
  });

  it('window closed (or unknown): it did not count', () => {
    const missed = "This session didn't count: no match or drill was recorded within 2 hours of its end.";
    expect(validityNote(v({ window_ends_at: new Date(T0 - MIN).toISOString() }), T0, label)).toBe(missed);
    expect(validityNote(v({ window_ends_at: new Date(T0).toISOString() }), T0, label)).toBe(missed);
    expect(validityNote(v({ window_ends_at: null }), T0, label)).toBe(missed);
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
