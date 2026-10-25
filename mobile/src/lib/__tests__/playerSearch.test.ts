import { describe, expect, it } from 'vitest';
import {
  MIN_SEARCH_CHARS,
  SHORT_QUERY_HINT,
  groupSearchResults,
  searchEmptyCopy,
  searchableQuery,
} from '../playerSearch';

const row = (id: string, distance_m: number | null) => ({ id, distance_m });

describe('searchableQuery', () => {
  it('needs 2 letters after trimming and a leading @', () => {
    expect(MIN_SEARCH_CHARS).toBe(2);
    expect(searchableQuery('')).toBeNull();
    expect(searchableQuery(null)).toBeNull();
    expect(searchableQuery('  a ')).toBeNull();
    expect(searchableQuery('@a')).toBeNull();
    expect(searchableQuery(' @ b')).toBeNull();
    expect(searchableQuery('ab')).toBe('ab');
    expect(searchableQuery('  @sam  ')).toBe('sam');
    expect(searchableQuery('Sam Lee')).toBe('Sam Lee');
  });

  it('caps the query at 80 characters (the server keeps 80)', () => {
    expect(searchableQuery('x'.repeat(200))).toHaveLength(80);
  });
});

describe('groupSearchResults', () => {
  it('puts the placed rows under "Near <area>" first, in order, then "Everywhere else"', () => {
    const rows = [row('a', 100), row('b', 900), row('c', null), row('d', null)];
    const out = groupSearchResults(rows, 'Alameda, CA', true);
    expect(out.map((s) => [s.key, s.title, s.rows.map((r) => r.id)])).toEqual([
      ['near', 'Near Alameda, CA', ['a', 'b']],
      ['everywhere', 'Everywhere else', ['c', 'd']],
    ]);
  });

  it('splits by placement even if the server order were mixed', () => {
    const out = groupSearchResults([row('c', null), row('a', 5)], 'X', true);
    expect(out.map((s) => s.rows.map((r) => r.id))).toEqual([['a'], ['c']]);
  });

  it('says so when no one near matches', () => {
    const out = groupSearchResults([row('c', null)], 'Alameda, CA', true);
    expect(out).toEqual([{ key: 'everywhere', title: 'Everywhere else (no one near Alameda, CA)', rows: [row('c', null)] }]);
  });

  it('only a near group when everyone matching is near', () => {
    const out = groupSearchResults([row('a', 1)], null, true);
    expect(out).toEqual([{ key: 'near', title: 'Near your area', rows: [row('a', 1)] }]);
  });

  it('no area: one group, no heading', () => {
    expect(groupSearchResults([row('a', null)], 'Alameda', false)).toEqual([
      { key: 'everywhere', title: null, rows: [row('a', null)] },
    ]);
  });

  it('nothing: no groups', () => {
    expect(groupSearchResults([], 'Alameda', true)).toEqual([]);
    expect(groupSearchResults([], null, false)).toEqual([]);
  });
});

describe('copy', () => {
  it('names the query in the empty state', () => {
    expect(searchEmptyCopy('zed').title).toBe('No players match "zed"');
    expect(searchEmptyCopy('zed').subtitle).toMatch(/@username/);
  });

  it('the short-query hint says how many letters', () => {
    expect(SHORT_QUERY_HINT).toContain('2 or more letters');
  });
});
