import { describe, it, expect } from 'vitest';
import { calendarKinds, itemsByDay, lengthText, type CalItem } from '../calendarItems';

describe('calendarKinds (PKL-051: each calendar shows what belongs on it)', () => {
  it('my own Play history calendar offers everything', () => {
    expect(calendarKinds({ own: true })).toEqual(['matches', 'upcoming', 'events', 'drills', 'play']);
  });
  it("a league's calendar offers that league's matches and events, not personal drills or check-ins", () => {
    expect(calendarKinds({ own: true, leagueId: 'L' })).toEqual(['matches', 'upcoming', 'events']);
    expect(calendarKinds({ own: false, leagueId: 'L' })).toEqual(['matches', 'upcoming', 'events']);
  });
  it("someone else's calendar shows their results only", () => {
    expect(calendarKinds({ own: false })).toEqual(['matches']);
  });
});

describe('itemsByDay', () => {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  it('groups by day and sorts each day by time', () => {
    const items: CalItem[] = [
      { id: 'b', kind: 'drills', at: '2026-11-20T18:00:00Z', title: 'B' },
      { id: 'a', kind: 'events', at: '2026-11-20T09:00:00Z', title: 'A' },
      { id: 'c', kind: 'play', at: '2026-11-21T09:00:00Z', title: 'C' },
      { id: 'x', kind: 'play', at: 'not a date', title: 'X' },
    ];
    const m = itemsByDay(items, day);
    expect(Object.keys(m).sort()).toEqual(['2026-11-20', '2026-11-21']);
    expect(m['2026-11-20'].map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('lengthText', () => {
  it('reads minutes and hours', () => {
    expect(lengthText('2026-11-20T09:00:00Z', '2026-11-20T09:45:00Z')).toBe('45 min');
    expect(lengthText('2026-11-20T09:00:00Z', '2026-11-20T11:00:00Z')).toBe('2 h');
    expect(lengthText('2026-11-20T09:00:00Z', '2026-11-20T10:30:00Z')).toBe('1 h 30 min');
    expect(lengthText('2026-11-20T09:00:00Z', null)).toBeNull();
  });
});
