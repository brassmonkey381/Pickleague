import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));
vi.mock('../supabase', () => ({ supabase: {} }));
vi.mock('@just-messin-around/expo-foundation/supabase', () => ({ currentUserId: vi.fn() }));

import { DRAFT_KEEP_MS, draftHasContent, emptyRatings, parseDraft, parseDraftMap } from '../drillReviewDraft';

const NOW = Date.parse('2026-10-29T18:00:00Z');
const savedAt = new Date(NOW - 60_000).toISOString();

describe('drill review drafts', () => {
  it('keeps ratings (clamped, rounded) and notes', () => {
    const d = parseDraft({ ratings: { consistency: 4, effort: 9, fun: 2.6, bogus: 3 }, notes: 'worked on resets', savedAt }, NOW);
    expect(d?.ratings).toEqual({ consistency: 4, effort: 5, organization: 0, intentionality: 0, fun: 3 });
    expect(d?.notes).toBe('worked on resets');
  });

  it('reads empty, stale, broken or older-shaped copies as no draft', () => {
    expect(parseDraft({ ratings: emptyRatings(), notes: '  ', savedAt }, NOW)).toBeNull();
    expect(parseDraft({ ratings: { fun: 3 }, notes: '', savedAt: new Date(NOW - DRAFT_KEEP_MS - 1).toISOString() }, NOW)).toBeNull();
    expect(parseDraft({ ratings: { fun: 3 } }, NOW)).toBeNull();
    expect(parseDraft('nope', NOW)).toBeNull();
    expect(parseDraft({ notes: 'text only', savedAt }, NOW)?.ratings).toEqual(emptyRatings());
  });

  it('a stored map drops what it cannot read', () => {
    const raw = JSON.stringify({ a: { ratings: { fun: 5 }, notes: '', savedAt }, b: null, c: { ratings: {}, notes: '', savedAt } });
    expect(Object.keys(parseDraftMap(raw, NOW))).toEqual(['a']);
    expect(parseDraftMap('{not json', NOW)).toEqual({});
    expect(parseDraftMap('[1,2]', NOW)).toEqual({});
    expect(parseDraftMap(null, NOW)).toEqual({});
  });

  it('content means a rating or some text', () => {
    expect(draftHasContent({ ratings: emptyRatings(), notes: '' })).toBe(false);
    expect(draftHasContent({ ratings: { ...emptyRatings(), effort: 1 }, notes: '' })).toBe(true);
    expect(draftHasContent({ ratings: emptyRatings(), notes: 'x' })).toBe(true);
  });
});
