import { describe, it, expect } from 'vitest';
import { hereChoices, hereFirst, nextEmptySlot } from '../matchPlayersHere';

const members = [
  { id: 'a', full_name: 'Zoe' },
  { id: 'b', full_name: 'Ann' },
  { id: 'c', full_name: 'Cal' },
  { id: 'd', full_name: null },
];

describe('MatchEntry "Here now"', () => {
  it('lists pickable players here, not picked yet, by name', () => {
    expect(hereChoices(members, new Set(['a', 'b', 'd', 'x']), ['b'])).toEqual([
      { id: 'd', name: 'Player' },
      { id: 'a', name: 'Zoe' },
    ]);
    expect(hereChoices(members, new Set(), [])).toEqual([]);
  });

  it('fills team 1 first, partners only in doubles', () => {
    const empty = { p1: '', partner1: '', p2: '', partner2: '' };
    expect(nextEmptySlot('doubles', { ...empty, p1: 'me' })).toBe('partner1');
    expect(nextEmptySlot('singles', { ...empty, p1: 'me' })).toBe('p2');
    expect(nextEmptySlot('singles', { ...empty, p1: 'me', p2: 'x' })).toBeNull();
    expect(nextEmptySlot('doubles', { p1: 'a', partner1: 'b', p2: 'c', partner2: '' })).toBe('partner2');
  });

  it('puts the players here first in the picker, marked', () => {
    const items = [{ id: 'a', name: 'Zoe' }, { id: 'b', name: 'Ann' }];
    expect(hereFirst(items, new Set(['a']))).toEqual([{ id: 'a', name: 'Zoe · here' }, { id: 'b', name: 'Ann' }]);
    expect(hereFirst(items, new Set())).toEqual(items);
  });
});
