// Play and check-in merged (2026-10-24, "go merge play and check-in"): the
// bar's layout, the centre button's states, and the rules that start the
// timer on a check-in and end it on a check-out.
import { describe, it, expect } from 'vitest';
import { activeNavSlot, centreState, clockLabel, navSideSlots } from '../navBarRules';
import {
  checkinToCloseWithEnd,
  checkoutEndsPlay,
  endActionLabel,
  onCheckedIn,
  takeBackClearsPlay,
  TAKE_BACK_WINDOW_MS,
} from '../checkinPlayRules';

describe('the bar: Home · Saved · ( ▶ Play ) · Discover · Me', () => {
  it('side slots in order, the centre action between Saved and Discover', () => {
    expect(navSideSlots({ discover: true })).toEqual(['home', 'saved', 'discover', 'me']);
  });
  it('without Discover: Home · Saved · ( ▶ Play ) · Me', () => {
    expect(navSideSlots({ discover: false })).toEqual(['home', 'saved', 'me']);
  });
  it('no separate Play or Check in side slot any more', () => {
    for (const d of [true, false]) {
      const slots: string[] = navSideSlots({ discover: d });
      expect(slots).not.toContain('play');
      expect(slots).not.toContain('checkin');
    }
  });
  it('Saved is lit on the Bookmarks screen', () => {
    expect(activeNavSlot('Bookmarks')).toBe('saved');
    expect(activeNavSlot('Home')).toBe('home');
  });
});

describe('the centre button', () => {
  it('idle: ▶ Play, one tap checks in here and starts the timer', () => {
    const s = centreState({ playing: false, elapsedSeconds: 0, checkedInVenue: null, busy: null });
    expect(s).toMatchObject({ label: 'Play', active: false, action: 'start', accessibilityLabel: 'Play' });
  });
  it('playing: the running clock, lit, opens the island', () => {
    expect(centreState({ playing: true, elapsedSeconds: 754, checkedInVenue: 'Riverside', busy: null })).toMatchObject({
      label: '12:34',
      active: true,
      action: 'island',
      accessibilityLabel: 'Playing, 12:34',
    });
    expect(centreState({ playing: true, elapsedSeconds: 3_725, checkedInVenue: null, busy: null }).label).toBe('1:02:05');
  });
  it('playing wins over busy and a check-in', () => {
    expect(centreState({ playing: true, elapsedSeconds: 5, checkedInVenue: 'X', busy: 'out' }).action).toBe('island');
  });
  it('checked in with no session (an older check-in, or the session expired): opens the check-in island', () => {
    expect(centreState({ playing: false, elapsedSeconds: 0, checkedInVenue: 'Riverside', busy: null })).toMatchObject({
      label: 'Checked in',
      active: true,
      action: 'checkin',
      accessibilityLabel: 'Checked in at Riverside',
    });
  });
  it('says what it is doing', () => {
    expect(centreState({ playing: false, elapsedSeconds: 0, checkedInVenue: null, busy: 'find' }).label).toBe('Finding…');
    expect(centreState({ playing: false, elapsedSeconds: 0, checkedInVenue: null, busy: 'checkin' }).label).toBe('Starting…');
    expect(centreState({ playing: false, elapsedSeconds: 0, checkedInVenue: 'R', busy: 'out' }).label).toBe('Checking out…');
    expect(centreState({ playing: false, elapsedSeconds: 0, checkedInVenue: null, busy: 'extend' }).label).toBe('Play');
  });
  it('the clock: m:ss under an hour, h:mm:ss after, never negative', () => {
    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(59)).toBe('0:59');
    expect(clockLabel(3_600)).toBe('1:00:00');
    expect(clockLabel(-5)).toBe('0:00');
  });
});

describe('a check-in starts the timer', () => {
  const at = (source: 'manual' | 'geofence' | 'session') => ({ id: 'c1', venueId: 'v1', source });
  it('nothing running: start it with the check-in\'s own id (a replay on a migrated server)', () => {
    expect(onCheckedIn({ play: null, checkin: at('manual') })).toEqual({ kind: 'start', id: 'c1' });
    expect(onCheckedIn({ play: null, checkin: at('geofence') })).toEqual({ kind: 'start', id: 'c1' });
  });
  it('a "just time it" timer running: it gains the court', () => {
    expect(onCheckedIn({ play: { id: 's1', venueId: null, startedAtMs: 1 }, checkin: at('manual') })).toEqual({ kind: 'adopt' });
  });
  it('a session at a court running: nothing new', () => {
    expect(onCheckedIn({ play: { id: 's1', venueId: 'v2', startedAtMs: 1 }, checkin: at('manual') })).toBeNull();
  });
  it("a Start's own check-in: nothing (the Start is the session)", () => {
    expect(onCheckedIn({ play: null, checkin: at('session') })).toBeNull();
  });
});

describe('a check-out ends it', () => {
  const play = { id: 'c1', venueId: 'v1', startedAtMs: 1 };
  it('the check-in that started it, or any at its court', () => {
    expect(checkoutEndsPlay({ play, checkout: { id: 'c1', venueId: null } })).toBe(true);
    expect(checkoutEndsPlay({ play, checkout: { id: 'c9', venueId: 'v1' } })).toBe(true);
  });
  it('not a check-out elsewhere, nor with nothing running', () => {
    expect(checkoutEndsPlay({ play, checkout: { id: 'c9', venueId: 'v2' } })).toBe(false);
    expect(checkoutEndsPlay({ play: null, checkout: { id: 'c1', venueId: 'v1' } })).toBe(false);
    expect(checkoutEndsPlay({ play: { id: 's', venueId: null, startedAtMs: 1 }, checkout: { id: 'c1', venueId: null } })).toBe(false);
  });
});

describe('Check out (= End) on the island', () => {
  it('labelled Check out while checked in, else End', () => {
    expect(endActionLabel(true)).toBe('Check out');
    expect(endActionLabel(false)).toBe('End');
  });
  it('checks out a check-in by hand or on arrival', () => {
    expect(checkinToCloseWithEnd({ sessionId: 'c1', checkin: { id: 'c1', source: 'manual' } })).toBe('c1');
    expect(checkinToCloseWithEnd({ sessionId: 's1', checkin: { id: 'c2', source: 'geofence' } })).toBe('c2');
  });
  it("leaves a Start's own check-in to its End (the server closes it)", () => {
    expect(checkinToCloseWithEnd({ sessionId: 's1', checkin: { id: 's1', source: 'session' } })).toBeNull();
  });
  it('nothing to check out when not checked in', () => {
    expect(checkinToCloseWithEnd({ sessionId: 's1', checkin: null })).toBeNull();
  });
});

describe('a taken-back arrival drops its session', () => {
  const now = 1_000_000_000;
  it('a session at that court that began in the take-back window', () => {
    expect(takeBackClearsPlay({ play: { id: 'c1', venueId: 'v1', startedAtMs: now - 3 * 60_000 }, venueId: 'v1', nowMs: now })).toBe(true);
  });
  it('not one elsewhere, an older one, or none', () => {
    expect(takeBackClearsPlay({ play: { id: 'c1', venueId: 'v2', startedAtMs: now }, venueId: 'v1', nowMs: now })).toBe(false);
    expect(
      takeBackClearsPlay({ play: { id: 'c1', venueId: 'v1', startedAtMs: now - TAKE_BACK_WINDOW_MS }, venueId: 'v1', nowMs: now }),
    ).toBe(false);
    expect(takeBackClearsPlay({ play: null, venueId: 'v1', nowMs: now })).toBe(false);
  });
});
