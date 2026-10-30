import { describe, expect, it } from 'vitest';
import {
  DRILL_WEEKS,
  clipText,
  drillCardModel,
  drillStats,
  lengthLabel,
  minutesBetween,
  playMix,
  playTypeLabel,
  shareDefaultDetails,
  shareDetailOptions,
  shareStudioKey,
  shareTemplatesFor,
  starsLabel,
  type DrillShareData,
} from '../shareCards';
import { labSamples } from '../shareCardLab';

describe('lengths', () => {
  it('says hours and minutes', () => {
    expect(lengthLabel(0.2)).toBe('1 min');
    expect(lengthLabel(45)).toBe('45 min');
    expect(lengthLabel(60)).toBe('1 h');
    expect(lengthLabel(105)).toBe('1 h 45 min');
    expect(lengthLabel(119.6)).toBe('2 h');
  });
  it('measures between instants, never backwards', () => {
    expect(minutesBetween('2026-10-27T18:00:00Z', '2026-10-27T19:45:00Z')).toBe(105);
    expect(minutesBetween('2026-10-27T19:00:00Z', '2026-10-27T18:00:00Z')).toBe(0);
    expect(minutesBetween(null, '2026-10-27T18:00:00Z')).toBe(0);
  });
});

describe('type of play', () => {
  const at = (h: number, m = 0) => `2026-10-27T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
  it('clips windows to the session and merges modes', () => {
    const mix = playMix([
      { startsAt: at(17), endsAt: at(18, 30), mode: 'closed' },
      { startsAt: at(18, 30), endsAt: at(19), mode: 'open' },
      { startsAt: at(19), endsAt: at(20), mode: 'closed' },
      { startsAt: at(20), endsAt: at(21), mode: null },
    ], at(18), at(19, 45));
    expect(mix).toEqual([{ mode: 'closed', minutes: 75 }, { mode: 'open', minutes: 30 }]);
    expect(playTypeLabel(mix, 'Open play')).toBe('1 h 15 min closed group · 30 min open play');
  });
  it('says one mode when it is nearly all of it, else the kind', () => {
    expect(playTypeLabel([{ mode: 'open', minutes: 100 }, { mode: 'closed', minutes: 5 }], 'x')).toBe('Open play');
    expect(playTypeLabel([{ mode: 'drill', minutes: 60 }], 'x')).toBe('Drill');
    expect(playTypeLabel([], 'Open play')).toBe('Open play');
    expect(playMix([], at(18), at(19))).toEqual([]);
    expect(playMix(null, at(18), at(19))).toEqual([]);
  });
});

describe('drill stats', () => {
  // Thursday Oct 29, 2026, local time.
  const now = new Date(2026, 9, 29, 12, 0);
  const s = (y: number, mo: number, d: number, min: number) => {
    const a = new Date(y, mo, d, 9, 0);
    return { startedAt: a.toISOString(), endedAt: new Date(a.getTime() + min * 60_000).toISOString() };
  };
  it('counts the month, the weeks and the streak', () => {
    const r = drillStats([s(2026, 9, 27, 60), s(2026, 9, 20, 30), s(2026, 9, 13, 45), s(2026, 8, 30, 90), s(2026, 8, 1, 50)], now);
    expect(r.monthCount).toBe(3);
    expect(r.monthMinutes).toBe(135);
    expect(r.weeks).toHaveLength(DRILL_WEEKS);
    expect(r.weeks[DRILL_WEEKS - 1]).toBe(60);
    expect(r.weeks[DRILL_WEEKS - 2]).toBe(30);
    expect(r.weekStreak).toBe(3); // Oct 26, 19, 12; Oct 5 has none
  });
  it('keeps the streak alive early in a week with no drill yet', () => {
    const r = drillStats([s(2026, 9, 21, 60), s(2026, 9, 14, 60)], now);
    expect(r.weekStreak).toBe(2);
    expect(drillStats([s(2026, 9, 7, 60)], now).weekStreak).toBe(0);
    expect(drillStats([], now)).toEqual({ monthCount: 0, monthMinutes: 0, weeks: new Array(DRILL_WEEKS).fill(0), weekStreak: 0 });
  });
});

describe('drill card', () => {
  const base: DrillShareData = {
    partner: { name: 'Pat D.', initials: 'PD' }, court: 'Lakeside', date: 'Today', minutes: 95,
    focus: ['Third-shot drops', 'Resets'],
    review: { rating: 4, facets: [{ label: 'Effort', stars: 5 }, { label: 'Fun', stars: 0 }], notes: 'Felt good' },
    stats: { monthCount: 6, monthMinutes: 540, weeks: [0, 0, 0, 0, 30, 60, 0, 95], weekStreak: 4 },
  };
  it('leads with the time drilled and offers the drill toggles', () => {
    const m = drillCardModel(base);
    expect(m.kind).toBe('drill');
    expect(m.hero).toEqual({ big: '1 h 35 min', small: 'of drilling', medal: null });
    expect(m.title).toBe('Drilled with Pat D.');
    expect(shareDetailOptions(m).map((o) => o.id)).toEqual(['rating', 'month', 'streak', 'court', 'date', 'focus', 'facets', 'weeks', 'notes']);
    expect(shareDefaultDetails(m)).toMatchObject({ rating: true, focus: true, weeks: true, notes: false, facets: false, court: false });
    expect(m.stats.find((x) => x.id === 'month')?.value).toBe('6 drills · 9 h this month');
    expect(m.rows.find((r) => r.id === 'facets')?.items).toHaveLength(1);
    expect(m.message).toBe('Put in 1 h 35 min of drilling with Pat D. on Pickleague 🥒💪');
    expect(m.showsScores).toBe(false);
  });
  it('still says something with no timer, review or history', () => {
    const m = drillCardModel({ ...base, partner: null, court: null, minutes: null, focus: [], review: null, stats: { monthCount: 0, monthMinutes: 0, weeks: new Array(8).fill(0), weekStreak: 0 } });
    expect(m.hero.big).toBe('Put in the work');
    expect(shareDetailOptions(m).map((o) => o.id)).toEqual(['date']);
    expect(m.message).toBe('Drilled on Pickleague 🥒💪');
    expect(drillCardModel({ ...base, minutes: null }).hero.big).toBe('★★★★☆');
  });
  it('opens on its own layout with no photos', () => {
    expect(shareTemplatesFor(0, 'drill')[0]).toBe('grind');
    expect(shareTemplatesFor(0, 'session')).not.toContain('grind');
    expect(shareTemplatesFor(2, 'drill')).not.toContain('grind');
  });
});

describe('helpers', () => {
  it('draws stars and clips notes at a word', () => {
    expect(starsLabel(3)).toBe('★★★☆☆');
    expect(starsLabel(9)).toBe('★★★★★');
    expect(clipText('short', 20)).toBe('short');
    expect(clipText('one two three four five six', 15)).toBe('one two three…');
  });
  it('gives a card a studio key by the toggles it offers', () => {
    const [a, b] = labSamples().filter((x) => x.group === 'Session');
    expect(shareStudioKey(a.model)).not.toBe(shareStudioKey(b.model));
  });
});

describe('share card lab', () => {
  it('has every kind, each with a message and toggles that exist', () => {
    const samples = labSamples();
    expect(new Set(samples.map((x) => x.model.kind))).toEqual(new Set(['finish', 'match', 'session', 'drill', 'event', 'bracket', 'group']));
    expect(new Set(samples.map((x) => x.id)).size).toBe(samples.length);
    for (const x of samples) {
      expect(x.model.message.length).toBeGreaterThan(0);
      const ids = shareDetailOptions(x.model).map((o) => o.id);
      for (const off of x.model.offByDefault) if (ids.includes(off)) expect(shareDefaultDetails(x.model)[off]).toBe(false);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
