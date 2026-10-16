import { describe, it, expect } from 'vitest';
import { courtNote, mergeCourtCandidates, visibilityLine } from '../playStartCourts';

const court = (id: string) => ({ id, name: `Court ${id}` });
const NOW = Date.parse('2026-10-15T18:00:00.000Z');
const until = (iso: string) => `at ${iso}`;

describe('mergeCourtCandidates (the start sheet preselects the first)', () => {
  it('puts my check-in first, then the court I am standing in, then my usual courts', () => {
    const list = mergeCourtCandidates({
      recent: [court('r')],
      favorite: [court('f')],
      home: [court('h')],
      here: [court('x')],
      checked_in: [court('c')],
    });
    expect(list.map((c) => c.id)).toEqual(['c', 'x', 'h', 'f', 'r']);
    expect(list[0].reason).toBe('checked_in');
  });

  it('keeps the strongest reason for a court that shows up twice', () => {
    const list = mergeCourtCandidates({ here: [court('a')], home: [court('a'), court('b')], recent: [court('b')] });
    expect(list).toEqual([
      { id: 'a', name: 'Court a', reason: 'here' },
      { id: 'b', name: 'Court b', reason: 'home' },
    ]);
  });

  it('caps the list and skips rows without an id', () => {
    const list = mergeCourtCandidates({ recent: [court('1'), { id: '', name: 'x' }, court('2'), court('3')] }, 2);
    expect(list.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('is empty with nothing known (the sheet then preselects no court)', () => {
    expect(mergeCourtCandidates({})).toEqual([]);
  });

  it('labels every reason', () => {
    expect(courtNote('here')).toBe("You're here");
    expect(courtNote('home')).toBe('League home court');
  });
});

describe('visibilityLine', () => {
  it('says only I see a session with no court', () => {
    expect(visibilityLine({ level: 'everyone', pausedUntil: null }, false, NOW, until)).toBe(
      'No court: only you see this session.',
    );
  });

  it('names who sees me at the court, defaulting to friends and league-mates', () => {
    expect(visibilityLine(null, true, NOW, until)).toBe('Visible to friends and league-mates');
    expect(visibilityLine({ level: 'leaguemates', pausedUntil: null }, true, NOW, until)).toBe(
      'Visible to friends and league-mates',
    );
    expect(visibilityLine({ level: 'friends', pausedUntil: null }, true, NOW, until)).toBe('Visible to friends');
    expect(visibilityLine({ level: 'everyone', pausedUntil: null }, true, NOW, until)).toBe(
      'Visible to everyone at the courts',
    );
    expect(visibilityLine({ level: 'hidden', pausedUntil: null }, true, NOW, until)).toBe('Hidden: others see "Player"');
  });

  it('a pause wins while it lasts, then the level applies again', () => {
    const later = new Date(NOW + 3_600_000).toISOString();
    expect(visibilityLine({ level: 'friends', pausedUntil: later }, true, NOW, until)).toBe(
      `Sharing paused until at ${later}: others see "Player".`,
    );
    const past = new Date(NOW - 1).toISOString();
    expect(visibilityLine({ level: 'friends', pausedUntil: past }, true, NOW, until)).toBe('Visible to friends');
  });
});
