import { describe, it, expect } from 'vitest';
import { atSelectedCourt, courtNote, mergeCourtCandidates, startNeedsFix, visibilityLine } from '../playStartCourts';

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
    // Everyone means anyone signed in, anywhere, not just people at the court.
    expect(visibilityLine({ level: 'everyone', pausedUntil: null }, true, NOW, until)).toBe(
      'Visible to anyone signed in to Pickleague',
    );
    expect(visibilityLine({ level: 'hidden', pausedUntil: null }, true, NOW, until)).toBe('Hidden: others see "a player"');
  });

  it('a pause wins while it lasts, then the level applies again', () => {
    const later = new Date(NOW + 3_600_000).toISOString();
    expect(visibilityLine({ level: 'friends', pausedUntil: later }, true, NOW, until)).toBe(
      `Sharing paused until at ${later}: others see "a player".`,
    );
    const past = new Date(NOW - 1).toISOString();
    expect(visibilityLine({ level: 'friends', pausedUntil: past }, true, NOW, until)).toBe('Visible to friends');
  });

  it('promises presence only at a court I seem to be at', () => {
    const v = { level: 'leaguemates', pausedUntil: null };
    expect(visibilityLine(v, true, NOW, until, false)).toBe(
      "You don't seem to be at this court: this session won't show you there.",
    );
    expect(visibilityLine(v, true, NOW, until, null)).toBe(
      "If you're at the court when you start: visible to friends and league-mates",
    );
    expect(visibilityLine({ level: 'everyone', pausedUntil: null }, true, NOW, until, null)).toBe(
      "If you're at the court when you start: visible to anyone signed in to Pickleague",
    );
    expect(visibilityLine(v, true, NOW, until, true)).toBe('Visible to friends and league-mates');
    // No court wins over everything.
    expect(visibilityLine(v, false, NOW, until, false)).toBe('No court: only you see this session.');
  });
});

describe('startNeedsFix', () => {
  it("needs no fix at my check-in's court (the server adopts that check-in)", () => {
    expect(startNeedsFix({ id: 'a', name: 'A', reason: 'checked_in' }, 'a')).toBe(false);
  });

  it('needs one everywhere else, and once that check-in has ended', () => {
    expect(startNeedsFix({ id: 'a', name: 'A', reason: 'checked_in' }, null)).toBe(true);
    expect(startNeedsFix({ id: 'a', name: 'A', reason: 'checked_in' }, 'b')).toBe(true);
    expect(startNeedsFix({ id: 'a', name: 'A', reason: 'here' }, 'a')).toBe(true);
    expect(startNeedsFix({ id: 'h', name: 'H', reason: 'home' }, null)).toBe(true);
  });
});

describe('atSelectedCourt', () => {
  const c = (id: string, reason: 'checked_in' | 'here' | 'home' | 'favorite' | 'recent') => ({ id, name: id, reason });

  it('trusts my check-in and a fix inside the fence', () => {
    expect(atSelectedCourt(c('a', 'checked_in'), null, false)).toBe(true);
    expect(atSelectedCourt(c('a', 'here'), { id: 'a', inside: true }, true)).toBe(true);
  });

  it('is unsure near a court but outside its mapped fence, or with no fix yet', () => {
    expect(atSelectedCourt(c('a', 'here'), { id: 'a', inside: false }, true)).toBeNull();
    expect(atSelectedCourt(c('h', 'home'), null, false)).toBeNull();
  });

  it('says no when the fix is somewhere else (a home court chosen from my sofa)', () => {
    expect(atSelectedCourt(c('h', 'home'), null, true)).toBe(false);
    expect(atSelectedCourt(c('h', 'home'), { id: 'x', inside: true }, true)).toBe(false);
  });

  it('knows nothing without a court', () => {
    expect(atSelectedCourt(null, null, true)).toBeNull();
  });
});
