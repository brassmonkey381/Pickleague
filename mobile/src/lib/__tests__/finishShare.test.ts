import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_PLAYER,
  cardPlayer,
  cardPodium,
  finishShareMessage,
  initialsOf,
  medalFor,
  ordinal,
  placeHeadline,
  recordLabel,
  shortName,
} from '../finishShare';

describe('shortName / initialsOf', () => {
  it('shortens to First L.', () => {
    expect(shortName('Taylor Jordan Smith')).toBe('Taylor S.');
    expect(shortName('  sam   lee ')).toBe('sam L.');
    expect(shortName('Cher')).toBe('Cher');
    expect(shortName('')).toBe(ANONYMOUS_PLAYER);
    expect(shortName(null)).toBe(ANONYMOUS_PLAYER);
  });
  it('takes first and last initials', () => {
    expect(initialsOf('Taylor Jordan Smith')).toBe('TS');
    expect(initialsOf('cher')).toBe('C');
    expect(initialsOf(undefined)).toBe('?');
  });
});

describe('cardPlayer', () => {
  const blocked = new Set(['b1']);
  it('masks blocked, deleted and nameless players', () => {
    expect(cardPlayer({ id: 'b1', fullName: 'Blocked Person' }, blocked)).toEqual({ name: ANONYMOUS_PLAYER, initials: '?' });
    expect(cardPlayer({ id: 'd1', fullName: 'Gone Person', deleted: true }, blocked)).toEqual({ name: ANONYMOUS_PLAYER, initials: '?' });
    expect(cardPlayer({ id: 'n1', fullName: '  ' }, blocked)).toEqual({ name: ANONYMOUS_PLAYER, initials: '?' });
  });
  it('shows everyone else as First L.', () => {
    expect(cardPlayer({ id: 'p1', fullName: 'Pat Doe' }, blocked)).toEqual({ name: 'Pat D.', initials: 'PD' });
  });
});

describe('places', () => {
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  });
  it('medals for 1-3 only', () => {
    expect([1, 2, 3, 4].map(medalFor)).toEqual(['gold', 'silver', 'bronze', null]);
  });
  it('headlines', () => {
    expect(placeHeadline(1, 12)).toBe('Champion');
    expect(placeHeadline(2, 12)).toBe('2nd place');
    expect(placeHeadline(5, 12)).toBe('5th of 12');
    expect(placeHeadline(5, null)).toBe('5th place');
  });
  it('record only with both counts', () => {
    expect(recordLabel(7, 3)).toBe('7-3');
    expect(recordLabel(0, 0)).toBe('0-0');
    expect(recordLabel(null, 3)).toBeNull();
  });
});

describe('cardPodium', () => {
  it('keeps places 1-3 in order, ties together, masked', () => {
    const out = cardPodium(
      [
        { rank: 3, players: [{ id: 'c', fullName: 'Cy Z' }, { id: 'x', fullName: 'Blocked One' }] },
        { rank: 1, players: [{ id: 'a', fullName: 'Al B' }] },
        { rank: 4, players: [{ id: 'd', fullName: 'Di Q' }] },
      ],
      new Set(['x']),
    );
    expect(out).toEqual([
      { rank: 1, players: [{ name: 'Al B.', initials: 'AB' }] },
      { rank: 3, players: [{ name: 'Cy Z.', initials: 'CZ' }, { name: ANONYMOUS_PLAYER, initials: '?' }] },
    ]);
  });
});

describe('finishShareMessage', () => {
  const link = 'https://www.pickleague.club/invite/ABC';
  it('a win', () => {
    expect(finishShareMessage({ kind: 'tournament', title: 'Fall Classic', league: null, rank: 1, of: 8 }, link))
      .toBe(`I won Fall Classic on Pickleague 🥒 ${link}`);
  });
  it('a season place', () => {
    expect(finishShareMessage({ kind: 'season', title: 'Season 3', league: 'Tuesday Ladder', rank: 5, of: 12 }, link))
      .toBe(`I finished 5th of 12 in Tuesday Ladder (Season 3) on Pickleague 🥒 ${link}`);
    expect(finishShareMessage({ kind: 'season', title: 'Season 3', league: 'Tuesday Ladder', rank: 2, of: 12 }, link))
      .toBe(`I finished 2nd in Tuesday Ladder (Season 3) on Pickleague 🥒 ${link}`);
  });
});
