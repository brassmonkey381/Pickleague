import { describe, it, expect } from 'vitest';
import {
  anonymousPlayerLabel,
  bandLabel,
  crowdLineText,
  formatLevel,
  presenceRowLabel,
  ratingBand,
  sortPresenceRows,
  type PresenceRowLike,
} from '../courtCrowd';

describe('levels and bands', () => {
  it('formats a level the way players say it', () => {
    expect(formatLevel(3.5)).toBe('3.5');
    expect(formatLevel(4)).toBe('4.0');
    expect(formatLevel(3.25)).toBe('3.25');
    expect(formatLevel(3.75)).toBe('3.75');
  });

  it('joins a band with an en dash and collapses equal ends', () => {
    expect(bandLabel(3.5, 4)).toBe('3.5–4.0');
    expect(bandLabel(4, 3.5)).toBe('3.5–4.0');
    expect(bandLabel(3.75, 3.75)).toBe('3.75');
    expect(bandLabel(null, 4)).toBeNull();
    expect(bandLabel(3.5, undefined)).toBeNull();
  });

  it('puts one rating in a half-point band', () => {
    expect(ratingBand(3.62)).toEqual({ low: 3.5, high: 4 });
    expect(ratingBand(4)).toEqual({ low: 4, high: 4.5 });
    expect(ratingBand(null)).toBeNull();
    expect(ratingBand(0)).toBeNull();
  });
});

describe('crowdLineText', () => {
  it('reads count, band and friends', () => {
    expect(crowdLineText({ here_now: 6, band_low: 3.5, band_high: 4, friends_here: 2 })).toBe(
      '6 playing now · mostly 3.5–4.0 · 2 friends',
    );
  });

  it('drops the band the server withheld and a zero friend count', () => {
    expect(crowdLineText({ here_now: 2, band_low: null, band_high: null, friends_here: 0 })).toBe('2 playing now');
    expect(crowdLineText({ here_now: 1, band_low: null, band_high: null, friends_here: 1 })).toBe(
      '1 playing now · 1 friend',
    );
  });

  it('says nothing about an empty court unless asked to', () => {
    const empty = { here_now: 0, band_low: null, band_high: null, friends_here: 0 };
    expect(crowdLineText(empty)).toBeNull();
    expect(crowdLineText(empty, 'No one checked in now')).toBe('No one checked in now');
  });

  it('never claims "nobody" without numbers', () => {
    expect(crowdLineText(null, 'No one checked in now')).toBeNull();
    expect(crowdLineText(undefined)).toBeNull();
  });
});

describe('roster rows', () => {
  const row = (p: Partial<PresenceRowLike>): PresenceRowLike => ({
    anonymous: false,
    full_name: 'Alex Kim',
    doubles_rating: 3.62,
    is_friend: false,
    is_close_friend: false,
    checked_in_at: '2026-10-15T17:00:00Z',
    ...p,
  });

  it('labels anonymous rows with a band, never a name or exact rating', () => {
    expect(anonymousPlayerLabel(3.62)).toBe('Player · 3.5–4.0');
    expect(anonymousPlayerLabel(null)).toBe('Player');
    expect(presenceRowLabel(row({ anonymous: true, full_name: null }))).toBe('Player · 3.5–4.0');
  });

  it('marks close friends', () => {
    expect(presenceRowLabel(row({ is_friend: true, is_close_friend: true }))).toBe('⭐ Alex Kim');
    expect(presenceRowLabel(row({ is_friend: true }))).toBe('Alex Kim');
    expect(presenceRowLabel(row({ full_name: '  ' }))).toBe('Player');
  });

  it('orders close friends, friends, others, then anonymous rows', () => {
    const rows = [
      row({ full_name: 'Anon', anonymous: true, checked_in_at: '2026-10-15T16:00:00Z' }),
      row({ full_name: 'Other' }),
      row({ full_name: 'Friend late', is_friend: true, checked_in_at: '2026-10-15T17:30:00Z' }),
      row({ full_name: 'Friend early', is_friend: true, checked_in_at: '2026-10-15T16:30:00Z' }),
      row({ full_name: 'Close', is_friend: true, is_close_friend: true }),
    ];
    expect(sortPresenceRows(rows).map((r) => r.full_name)).toEqual([
      'Close',
      'Friend early',
      'Friend late',
      'Other',
      'Anon',
    ]);
  });
});
