import { describe, expect, it } from 'vitest';
import { groupedRowEdges, groupedRowStyle } from '../groupedRows';

const items = [
  { kind: 'header', section: 'mine' },
  { kind: 'row', section: 'mine' },
  { kind: 'row', section: 'mine' },
  { kind: 'header', section: 'discover' },
  { kind: 'row', section: 'discover' },
];

describe('groupedRowEdges', () => {
  it('finds the ends of each run of rows', () => {
    expect(groupedRowEdges(items, 1)).toEqual({ first: true, last: false });
    expect(groupedRowEdges(items, 2)).toEqual({ first: false, last: true });
    expect(groupedRowEdges(items, 4)).toEqual({ first: true, last: true });
  });
});

describe('groupedRowStyle', () => {
  const c = { surface: '#fff', border: '#ddd', radiusCard: 18 };
  it('puts the top edge on the first row and the bottom edge on the last', () => {
    expect(groupedRowStyle(c, { first: true, last: false }).borderTopWidth).toBe(1);
    expect(groupedRowStyle(c, { first: true, last: false }).borderBottomWidth).toBeUndefined();
    expect(groupedRowStyle(c, { first: false, last: false }).borderTopWidth).toBeUndefined();
    expect(groupedRowStyle(c, { first: false, last: true }).borderBottomWidth).toBe(1);
    const one = groupedRowStyle(c, { first: true, last: true });
    expect([one.borderTopWidth, one.borderBottomWidth, one.borderTopLeftRadius]).toEqual([1, 1, 18]);
  });
});
