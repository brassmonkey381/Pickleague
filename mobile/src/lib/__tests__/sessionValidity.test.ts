import { describe, it, expect } from 'vitest';
import {
  MIN_SESSION_MS,
  RECORD_WINDOW_MS,
  endDecision,
  isMissingColumnError,
  notNowNote,
  sessionLengthLabel,
  validityNote,
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
  recorded: false,
  ...extra,
});
// A fixed formatter, so the copy doesn't depend on the test machine's zone.
const label = (d: Date) => d.toISOString().slice(11, 16);

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

  it('offers the drill review for a drill session', () => {
    const d = endDecision(ended(45 * MIN, { kind: 'drill', sourceId: 'd1' }));
    expect(d.show === 'record' && d.offerDrill).toBe(true);
  });

  it('does not ask again when a match was already recorded from the session', () => {
    expect(endDecision(ended(30 * MIN, { recorded: true }))).toEqual({
      show: 'note',
      tone: 'success',
      message: 'Session ended. It counts: you recorded a match.',
    });
  });

  it('still calls a too-short session too short, recorded match or not', () => {
    const d = endDecision(ended(2 * MIN, { recorded: true }));
    expect(d.show === 'note' && d.tone).toBe('info');
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
});

describe('validityNote (my_session_validity, worded)', () => {
  const v = (x: Partial<SessionValidity>): SessionValidity => ({
    valid: false,
    reason: 'no_match_or_drill',
    needs: 'match_or_drill',
    window_ends_at: null,
    ...x,
  });

  it('says nothing without an answer or while the session runs', () => {
    expect(validityNote(null, T0, label)).toBeNull();
    expect(validityNote(undefined, T0, label)).toBeNull();
    expect(validityNote(v({ reason: 'open', needs: null }), T0, label)).toBeNull();
    expect(validityNote(v({ reason: 'open', needs: 'minutes' }), T0, label)).toBeNull();
  });

  it('a valid session counts, whatever made it valid (pending confirmation too)', () => {
    for (const reason of ['linked_match', 'match_in_window', 'drill_in_window'] as const) {
      expect(validityNote(v({ valid: true, reason, needs: null }), T0, label)).toBe('This play session counts now.');
    }
    expect(
      validityNote(
        v({ valid: true, reason: 'linked_match', needs: null, rewards_pending_confirmation: true }),
        T0,
        label,
      ),
    ).toBe('This play session counts now.');
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
