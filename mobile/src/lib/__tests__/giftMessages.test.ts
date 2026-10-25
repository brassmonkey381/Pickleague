import { describe, expect, it } from 'vitest';
import { giftNoteIds, mergeGiftNotes } from '../giftMessages';

const rows = [
  { id: 'p1', gifted_by_user_id: 'u1', gift_message: null },
  { id: 'p2', gifted_by_user_id: null, gift_message: null },
  { id: 'p3', gifted_by_user_id: 'u2', gift_message: 'old note' },
  { id: 'p4', gifted_by_user_id: 'u3', gift_message: null },
];

describe('giftNoteIds', () => {
  it('asks only about gifts that have no note yet', () => {
    expect(giftNoteIds(rows)).toEqual(['p1', 'p4']);
  });
  it('is empty when nothing was gifted', () => {
    expect(giftNoteIds([{ id: 'x', gifted_by_user_id: null, gift_message: null }])).toEqual([]);
  });
});

describe('mergeGiftNotes', () => {
  it('fills the notes it found and leaves the rest', () => {
    const out = mergeGiftNotes(rows, [{ purchase_id: 'p1', message: 'Happy birthday' }]);
    expect(out.map((r) => r.gift_message)).toEqual(['Happy birthday', null, 'old note', null]);
  });
  it('never overwrites a note the row already has', () => {
    const out = mergeGiftNotes(rows, [{ purchase_id: 'p3', message: 'new' }]);
    expect(out[2].gift_message).toBe('old note');
  });
  it('returns the rows untouched for no notes (a stranger, or a failed read)', () => {
    expect(mergeGiftNotes(rows, [])).toBe(rows);
    expect(mergeGiftNotes(rows, null)).toBe(rows);
  });
});
