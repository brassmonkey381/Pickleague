import { describe, it, expect } from 'vitest';
import {
  PLAY_END_PENDING_MAX_AGE_MS,
  addPendingEnd,
  isEndPending,
  prunePendingEnds,
  removePendingEnd,
} from '../playEndPending';

const NOW = Date.parse('2026-10-15T18:00:00.000Z');
const DAY = 86_400_000;

describe('pending-End guard', () => {
  it('a queued End keeps its session from coming back until it is cleared', () => {
    let m = addPendingEnd({}, 's1', NOW);
    expect(isEndPending(m, 's1', NOW + 60_000)).toBe(true);
    expect(isEndPending(m, 's2', NOW + 60_000)).toBe(false);
    m = removePendingEnd(m, 's1');
    expect(isEndPending(m, 's1', NOW + 60_000)).toBe(false);
  });

  it('a landed End stays a tombstone: a resume read already in flight that answers "open" is still skipped', () => {
    // End tapped at NOW and landed a moment later: lib/playSession no longer
    // clears the entry on success, so a stale "open" read handled minutes
    // later still finds it.
    const m = addPendingEnd({}, 's1', NOW);
    expect(isEndPending(m, 's1', NOW + 10 * 60_000)).toBe(true);
  });

  it('expires an entry after 3 days (the server closed that session long before)', () => {
    const m = addPendingEnd({}, 's1', NOW);
    expect(isEndPending(m, 's1', NOW + 3 * DAY - 1)).toBe(true);
    expect(isEndPending(m, 's1', NOW + PLAY_END_PENDING_MAX_AGE_MS)).toBe(false);
  });

  it('adding and removing never mutate the stored map', () => {
    const a = addPendingEnd({}, 's1', NOW);
    const b = addPendingEnd(a, 's2', NOW);
    expect(a).toEqual({ s1: NOW });
    expect(removePendingEnd(b, 's1')).toEqual({ s2: NOW });
    expect(b).toEqual({ s1: NOW, s2: NOW });
    // Removing something absent hands back the same map.
    expect(removePendingEnd(a, 'nope')).toBe(a);
  });
});

describe('prunePendingEnds (reading the stored map)', () => {
  it('reads the JSON AsyncStorage holds and drops expired entries', () => {
    const raw = JSON.stringify({ fresh: NOW - DAY, old: NOW - 4 * DAY });
    expect(prunePendingEnds(raw, NOW)).toEqual({ fresh: NOW - DAY });
  });

  it('drops malformed entries and survives junk', () => {
    expect(prunePendingEnds(JSON.stringify({ a: 'yesterday', b: null, c: NOW }), NOW)).toEqual({ c: NOW });
    expect(prunePendingEnds('{not json', NOW)).toEqual({});
    expect(prunePendingEnds(null, NOW)).toEqual({});
    expect(prunePendingEnds(JSON.stringify(['s1']), NOW)).toEqual({});
    expect(prunePendingEnds(JSON.stringify(42), NOW)).toEqual({});
  });

  it('takes an already-parsed object too', () => {
    expect(prunePendingEnds({ s1: NOW }, NOW)).toEqual({ s1: NOW });
  });
});
