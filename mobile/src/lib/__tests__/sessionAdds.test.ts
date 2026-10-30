import { describe, expect, it } from 'vitest';
import {
  END_SHEET_DRILL_TITLE,
  endSheetDrillAction,
  historyAdds,
  isAlreadyLoggedMessage,
  isLoggedDrill,
  LATE_ADD_MS,
  loggedDrillDraftId,
  loggedDrillNote,
} from '../sessionAdds';

const NOW = Date.parse('2026-10-30T18:00:00.000Z');
const HOUR = 3_600_000;
const row = (endedAgoMs: number, lengthMs = HOUR, extra: Partial<Parameters<typeof historyAdds>[0]> = {}) => ({
  kind: 'open_play' as const,
  startedAt: new Date(NOW - endedAgoMs - lengthMs).toISOString(),
  endedAt: new Date(NOW - endedAgoMs).toISOString(),
  validReason: 'no_match_or_drill',
  ...extra,
});

describe('endSheetDrillAction (the end sheet always offers a drill)', () => {
  it('reviews the scheduled drill a session was started from', () => {
    expect(endSheetDrillAction({ kind: 'drill', sourceId: 'd1' })).toBe('review');
    expect(END_SHEET_DRILL_TITLE.review).toBe('Review drill');
  });

  it('logs a drill for open play, a drill timer with no drill, and group sessions', () => {
    expect(endSheetDrillAction({ kind: 'open_play', sourceId: null })).toBe('log');
    expect(endSheetDrillAction({ kind: 'drill', sourceId: null })).toBe('log');
    expect(endSheetDrillAction({ kind: 'event', sourceId: 'e1' })).toBe('log');
    expect(endSheetDrillAction({ kind: 'tournament', sourceId: 't1' })).toBe('log');
    expect(END_SHEET_DRILL_TITLE.log).toBe('Log a drill');
  });
});

describe('historyAdds (Add a match / Add a drill in Play history)', () => {
  it('offers both on an open-play session from today', () => {
    expect(historyAdds(row(HOUR), NOW)).toEqual({ match: true, drill: true });
  });

  it('still offers both up to 7 days after the end, then neither', () => {
    expect(historyAdds(row(LATE_ADD_MS - 60_000), NOW)).toEqual({ match: true, drill: true });
    expect(historyAdds(row(LATE_ADD_MS + 60_000), NOW)).toEqual({ match: false, drill: false });
  });

  it('nothing on a session under 5 minutes (it can never count)', () => {
    expect(historyAdds(row(HOUR, 4 * 60_000), NOW)).toEqual({ match: false, drill: false });
  });

  it('a match only, when the session has its drill already', () => {
    expect(historyAdds(row(HOUR, HOUR, { kind: 'drill' }), NOW)).toEqual({ match: true, drill: false });
    expect(historyAdds(row(HOUR, HOUR, { validReason: 'drill_in_window' }), NOW)).toEqual({ match: true, drill: false });
  });

  it('a session that counts through a match can still take a drill', () => {
    expect(historyAdds(row(HOUR, HOUR, { validReason: 'linked_match' }), NOW)).toEqual({ match: true, drill: true });
  });

  it('nothing for unreadable times', () => {
    expect(historyAdds({ kind: 'open_play', startedAt: 'x', endedAt: 'y', validReason: null }, NOW)).toEqual({
      match: false,
      drill: false,
    });
  });
});

describe('logged drills', () => {
  it('the draft key is per play session', () => {
    expect(loggedDrillDraftId('s1')).toBe('log:s1');
  });

  it('knows the server\'s "already logged"', () => {
    expect(isAlreadyLoggedMessage(' You already logged a drill for this session. ')).toBe(true);
    expect(isAlreadyLoggedMessage('Already reviewed')).toBe(false);
    expect(isAlreadyLoggedMessage(null)).toBe(false);
  });

  it('says the session counts only when the server says so', () => {
    expect(loggedDrillNote({ valid: true, reason: 'drill_in_window' })).toBe('Your play session counts now.');
    expect(loggedDrillNote({ valid: false, reason: 'no_match_or_drill' })).toBeNull();
    expect(loggedDrillNote(null)).toBeNull();
  });

  it('a logged drill is mine alone (player1 = player2); a scheduled one has a partner', () => {
    expect(isLoggedDrill({ player1_id: 'me', player2_id: 'me' })).toBe(true);
    expect(isLoggedDrill({ player1_id: 'me', player2_id: 'sam' })).toBe(false);
    expect(isLoggedDrill({ player1_id: null, player2_id: null })).toBe(false);
  });
});
