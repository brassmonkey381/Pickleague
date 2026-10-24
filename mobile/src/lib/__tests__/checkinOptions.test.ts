import { describe, it, expect } from 'vitest';
import {
  checkinOptionIds,
  courtHeaderActions,
  lineActionIds,
  lineIsPast,
  movesCheckinNote,
  planOptionIds,
  type CourtHeaderState,
  type LineActionContext,
} from '../checkinOptions';

// Thu Oct 22 2026, 3 PM local.
const NOW = new Date(2026, 9, 22, 15, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 9, 22, h, m).toISOString();

const header = (p: Partial<CourtHeaderState> = {}): CourtHeaderState => ({
  day: 'today',
  hereMine: false,
  friendHere: false,
  canOnMyWay: true,
  onMyWaySent: false,
  canPlan: true,
  ...p,
});

const ctx = (p: Partial<LineActionContext> = {}): LineActionContext => ({
  day: 'today',
  nowMs: NOW,
  hereMine: false,
  canOnMyWay: true,
  onMyWaySent: false,
  ...p,
});

describe('the court card header (one Check in, as Doggle)', () => {
  it('shows only Check in today when no friend is here', () => {
    expect(courtHeaderActions(header())).toEqual(['checkIn']);
  });

  it('adds On my way before Check in while a friend is here', () => {
    expect(courtHeaderActions(header({ friendHere: true }))).toEqual(['onMyWay', 'checkIn']);
  });

  it('says "On the way" once told in the last 30 minutes', () => {
    expect(courtHeaderActions(header({ friendHere: true, onMyWaySent: true }))).toEqual(['onMyWaySent', 'checkIn']);
  });

  it('never offers On my way without friends to tell', () => {
    expect(courtHeaderActions(header({ friendHere: true, canOnMyWay: false }))).toEqual(['checkIn']);
  });

  it('is empty once checked in here (my own line has Stay and Check out)', () => {
    expect(courtHeaderActions(header({ hereMine: true, friendHere: true }))).toEqual([]);
  });

  it('shows Plan tomorrow, and nothing later this week', () => {
    expect(courtHeaderActions(header({ day: 'tomorrow' }))).toEqual(['plan']);
    expect(courtHeaderActions(header({ day: 'tomorrow', canPlan: false }))).toEqual([]);
    expect(courtHeaderActions(header({ day: 'later', friendHere: true }))).toEqual([]);
  });
});

describe('the Check in sheet', () => {
  it('lists Check in now, On my way and Make this a routine, in that order', () => {
    expect(checkinOptionIds({ canOnMyWay: true, canRoutine: true })).toEqual(['checkInNow', 'onMyWay', 'makeRoutine']);
  });

  it('always has Check in now; On my way needs friends, a routine a starred court', () => {
    expect(checkinOptionIds({ canOnMyWay: false, canRoutine: false })).toEqual(['checkInNow']);
    expect(checkinOptionIds({ canOnMyWay: false, canRoutine: true })).toEqual(['checkInNow', 'makeRoutine']);
  });

  it("plans tomorrow as a routine only (there's no one-off plan yet)", () => {
    expect(planOptionIds({ canRoutine: true })).toEqual(['makeRoutine']);
    expect(planOptionIds({ canRoutine: false })).toEqual([]);
  });

  it('warns that a check-in here moves me from another court', () => {
    expect(movesCheckinNote({ venueId: 'b', venueName: 'Star Park', expiresAt: at(17) }, 'a', NOW)).toBe(
      "You're checked in at Star Park. Checking in here moves you.",
    );
    expect(movesCheckinNote({ venueId: 'a', venueName: 'Lakeside', expiresAt: at(17) }, 'a', NOW)).toBeUndefined();
    expect(movesCheckinNote(null, 'a', NOW)).toBeUndefined();
  });

  it('says nothing about a check-in elsewhere that has run out', () => {
    expect(movesCheckinNote({ venueId: 'b', venueName: 'Star Park', expiresAt: at(13) }, 'a', NOW)).toBeUndefined();
    expect(movesCheckinNote({ venueId: 'b', venueName: 'Star Park', expiresAt: at(15) }, 'a', NOW)).toBeUndefined();
  });
});

describe("a line's time chip", () => {
  it('my check-in: Stay 1 more hour, then Check out', () => {
    expect(lineActionIds({ kind: 'mine', queued: false }, ctx({ hereMine: true }))).toEqual(['extend', 'checkOut']);
  });

  it('my check-in still queued offline: Check out only', () => {
    expect(lineActionIds({ kind: 'mine', queued: true }, ctx({ hereMine: true }))).toEqual(['checkOut']);
  });

  it("my routine stop today: Check in now, On my way, Change today's time, Edit, Skip (Doggle's order)", () => {
    expect(lineActionIds({ kind: 'stop', status: 'planned', at: at(18) }, ctx())).toEqual([
      'checkInNow',
      'onMyWay',
      'changeTime',
      'editRoutine',
      'skipStop',
    ]);
  });

  it('my routine stop: no On my way over 30 minutes past its time, or without friends', () => {
    expect(lineActionIds({ kind: 'stop', status: 'planned', at: at(14, 20) }, ctx())).not.toContain('onMyWay');
    expect(lineActionIds({ kind: 'stop', status: 'planned', at: at(14, 40) }, ctx())).toContain('onMyWay');
    expect(lineActionIds({ kind: 'stop', status: 'planned', at: at(18) }, ctx({ canOnMyWay: false }))).not.toContain('onMyWay');
  });

  it('my routine stop once checked in here: no Check in now or On my way', () => {
    expect(lineActionIds({ kind: 'stop', status: 'planned', at: at(18) }, ctx({ hereMine: true }))).toEqual([
      'changeTime',
      'editRoutine',
      'skipStop',
    ]);
  });

  it('my routine stop tomorrow: change, edit, skip only', () => {
    expect(lineActionIds({ kind: 'stop', status: 'planned', at: at(18) }, ctx({ day: 'tomorrow' }))).toEqual([
      'changeTime',
      'editRoutine',
      'skipStop',
    ]);
  });

  it('my routine stop once its time has passed: no Change time or Skip (Doggle: only while ahead)', () => {
    // 2:40 PM, 20 minutes ago: still Check in now and On my way, then Edit.
    expect(lineActionIds({ kind: 'stop', status: 'planned', at: at(14, 40) }, ctx())).toEqual([
      'checkInNow',
      'onMyWay',
      'editRoutine',
    ]);
    // Exactly now counts as passed.
    const ids = lineActionIds({ kind: 'stop', status: 'planned', at: at(15) }, ctx());
    expect(ids).not.toContain('changeTime');
    expect(ids).not.toContain('skipStop');
  });

  it('a skipped stop: Undo skip, Edit my routine', () => {
    expect(lineActionIds({ kind: 'stop', status: 'cancelled', at: at(18) }, ctx())).toEqual(['undoSkip', 'editRoutine']);
  });

  it('a friend here: On my way, Check in here, their profile', () => {
    expect(lineActionIds({ kind: 'here' }, ctx())).toEqual(['onMyWay', 'checkInHere', 'profile']);
  });

  it('a friend here once told, or once checked in here myself', () => {
    expect(lineActionIds({ kind: 'here' }, ctx({ onMyWaySent: true }))).toEqual(['checkInHere', 'profile']);
    expect(lineActionIds({ kind: 'here' }, ctx({ hereMine: true }))).toEqual(['profile']);
  });

  it('a friend who left: their profile only', () => {
    expect(lineActionIds({ kind: 'left' }, ctx())).toEqual(['profile']);
  });
});

describe('which lines are faded (Doggle isPast)', () => {
  it('a visit that ended and a skipped stop', () => {
    expect(lineIsPast({ kind: 'left' }, NOW)).toBe(true);
    expect(lineIsPast({ kind: 'stop', status: 'cancelled', at: at(18) }, NOW)).toBe(true);
  });

  it('a stop whose time has passed, not one still ahead', () => {
    expect(lineIsPast({ kind: 'stop', status: 'planned', at: at(14, 40) }, NOW)).toBe(true);
    expect(lineIsPast({ kind: 'stop', status: 'planned', at: at(15) }, NOW)).toBe(true);
    expect(lineIsPast({ kind: 'stop', status: 'planned', at: at(18) }, NOW)).toBe(false);
  });

  it('never my own check-in or a friend here now', () => {
    expect(lineIsPast({ kind: 'mine', queued: false }, NOW)).toBe(false);
    expect(lineIsPast({ kind: 'here' }, NOW)).toBe(false);
  });
});
