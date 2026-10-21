import { describe, it, expect } from 'vitest';
import { replaceSheetCopy } from '../courtStarReplace';

const stars = [
  { venue_id: 'a', venue_name: 'Lakeside' },
  { venue_id: 'b', venue_name: 'Rotary Park' },
  { venue_id: 'c', venue_name: 'Elm Grove' },
];

describe('replaceSheetCopy (Doggle\'s "Replace a favorite?")', () => {
  it('names the new court and offers each starred one, in order', () => {
    const c = replaceSheetCopy(stars, 'Harbor Club');
    expect(c.title).toBe('Replace a starred court?');
    expect(c.subtitle).toBe('You already have 3 starred courts. Pick one to replace with “Harbor Club”.');
    expect(c.rows).toEqual([
      { venueId: 'a', label: 'Replace Lakeside' },
      { venueId: 'b', label: 'Replace Rotary Park' },
      { venueId: 'c', label: 'Replace Elm Grove' },
    ]);
  });

  it('without a name for the new court', () => {
    expect(replaceSheetCopy(stars, '  ').subtitle).toBe('You already have 3 starred courts. Pick one to replace.');
  });

  it('two starred courts with one name still get distinct rows', () => {
    const c = replaceSheetCopy([
      { venue_id: 'a', venue_name: 'Court 1' },
      { venue_id: 'b', venue_name: 'Court 1' },
      { venue_id: 'c', venue_name: null },
    ]);
    expect(c.rows.map((r) => r.label)).toEqual(['Replace Court 1', 'Replace Court 1 (2)', 'Replace this court']);
  });
});
