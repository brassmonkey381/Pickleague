import { describe, expect, it } from 'vitest';
import { homeCourtSlot, type HomeCourtMode } from '../homeCourtSlot';

const MODES: HomeCourtMode[] = ['idle', 'checked_in', 'prompt'];

describe('homeCourtSlot: Home never remounts its check-in card', () => {
  it('one key and one wrapper type in every mode, with or without the bottom bar (the request storm)', () => {
    for (const playNav of [true, false]) {
      const slots = MODES.map((m) => homeCourtSlot(m, { playNav }));
      expect(new Set(slots.map((s) => `${s.key}:${s.wrapper}`)).size).toBe(1);
    }
  });

  it('the card reporting idle on mount, then checked in, only moves and shows it', () => {
    // What the card does as it mounts with a check-in cached: idle first, then checked_in.
    const seq = ['idle', 'checked_in', 'idle', 'checked_in'] as const;
    const slots = seq.map((m) => homeCourtSlot(m, { playNav: true }));
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].key).toBe(slots[i - 1].key);
      expect(slots[i].wrapper).toBe(slots[i - 1].wrapper);
    }
    expect(slots.map((s) => s.place)).toEqual(['row', 'now', 'row', 'now']);
  });

  it('checked in or "At <court>?": in NOW, shown', () => {
    expect(homeCourtSlot('checked_in', { playNav: true })).toMatchObject({ place: 'now', hidden: false });
    expect(homeCourtSlot('prompt', { playNav: true })).toMatchObject({ place: 'now', hidden: false });
  });

  it('idle: the court row, hidden with the bottom bar (its centre Check in does that job), shown without', () => {
    expect(homeCourtSlot('idle', { playNav: true })).toMatchObject({ place: 'row', hidden: true });
    expect(homeCourtSlot('idle', { playNav: false })).toMatchObject({ place: 'row', hidden: false });
  });
});
