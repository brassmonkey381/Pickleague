import { describe, it, expect } from 'vitest';
import { noticeBodyForDisplay, PICKLE_UNIT } from '../noticeText';

describe('noticeBodyForDisplay', () => {
  it('spells pickles out after a number', () => {
    expect(noticeBodyForDisplay('You received 150 \u{1F952} for your first doubles match. Tap to see your shop'))
      .toBe('You received 150 pickles for your first doubles match. Tap to see your shop');
    expect(noticeBodyForDisplay('You finished 2nd in Summer Smash. +75 \u{1F952}.'))
      .toBe('You finished 2nd in Summer Smash. +75 pickles.');
    expect(noticeBodyForDisplay('Entry fee: 1 \u{1F952}, charged when you accept.'))
      .toBe('Entry fee: 1 pickle, charged when you accept.');
  });

  it('drops a leading emoji and a pickle with no number', () => {
    expect(noticeBodyForDisplay('\u{1F525} Day 5 streak: +200\u{1F952}!')).toBe('Day 5 streak: +200 pickles!');
    expect(noticeBodyForDisplay('Prizes:\n• \u{1F952} 50 pickles')).toBe('Prizes:\n• 50 pickles');
  });

  it('leaves plain text alone', () => {
    expect(noticeBodyForDisplay('Jake accepted your friend request.')).toBe('Jake accepted your friend request.');
    expect(noticeBodyForDisplay(null)).toBe('');
  });

  it('the unit is the pickle', () => {
    expect(PICKLE_UNIT.emoji).toBe('\u{1F952}');
  });
});
