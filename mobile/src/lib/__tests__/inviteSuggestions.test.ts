import { describe, it, expect } from 'vitest';
import { METERS_PER_MILE, circleAround, withinSearchArea, type SearchArea } from '../searchArea';
import {
  firstWithAnyone,
  invitePlaceOf,
  readAllPages,
  suggestedFirst,
  suggestionSteps,
  suggestionsHeading,
  withinLevel,
} from '../inviteSuggestions';
import { leagueAnchorsInArea } from '../playersNear';

const OAKLAND = { lat: 37.8044, lng: -122.2712 };
const BERKELEY = { lat: 37.8715, lng: -122.273 }; // ~4.6 mi from Oakland
const SF = { lat: 37.7749, lng: -122.4194 }; // ~8.4 mi from Oakland

function area(radiusMi: number, center = SF, label: string | null = 'San Francisco, CA'): SearchArea {
  return { center, radiusMi, radiusM: Math.round(radiusMi * METERS_PER_MILE), source: 'city', label };
}

describe('invitePlaceOf', () => {
  it('takes a located row, trimming the name', () => {
    expect(invitePlaceOf('  Lake Merritt ', OAKLAND.lat, OAKLAND.lng)).toEqual({ name: 'Lake Merritt', point: OAKLAND });
    expect(invitePlaceOf(null, OAKLAND.lat, OAKLAND.lng)).toEqual({ name: null, point: OAKLAND });
    expect(invitePlaceOf('  ', OAKLAND.lat, OAKLAND.lng)!.name).toBeNull();
  });

  it('a row with no usable point is no place (the search area is used instead)', () => {
    expect(invitePlaceOf('Lake Merritt', null, null)).toBeNull();
    expect(invitePlaceOf('Lake Merritt', 0, 0)).toBeNull();
    expect(invitePlaceOf('Lake Merritt', Number.NaN, OAKLAND.lng)).toBeNull();
  });
});

describe('circleAround', () => {
  it('a circle of the area radius around the place', () => {
    const c = circleAround(OAKLAND, 10);
    expect(c).toEqual({ center: OAKLAND, radiusMi: 10, radiusM: Math.round(10 * METERS_PER_MILE) });
    expect(withinSearchArea(BERKELEY, c)).toBe(true);
    expect(withinSearchArea(SF, c)).toBe(true);
    expect(withinSearchArea(SF, circleAround(OAKLAND, 5))).toBe(false);
  });

  it('a bad radius reads as the default 5 mi', () => {
    expect(circleAround(OAKLAND, Number.NaN).radiusMi).toBe(5);
    expect(circleAround(OAKLAND, 0).radiusMi).toBe(5);
  });
});

describe('suggestionSteps', () => {
  const court = { name: 'Lake Merritt', point: OAKLAND };

  it('the place first (at the area radius), then the search area', () => {
    const steps = suggestionSteps(court, area(10), 10);
    expect(steps.map((s) => s.source)).toEqual(['place', 'area']);
    expect(steps[0]).toMatchObject({ label: 'Lake Merritt', circle: { center: OAKLAND, radiusMi: 10 } });
    expect(steps[1]).toMatchObject({ label: 'San Francisco, CA', circle: { center: SF, radiusMi: 10 } });
  });

  it('no place: the search area alone; no area either: nothing (the old suggestions)', () => {
    expect(suggestionSteps(null, area(5), 5).map((s) => s.source)).toEqual(['area']);
    expect(suggestionSteps(null, null, 5)).toEqual([]);
  });

  it('no area: the place alone, at the radius setting', () => {
    const steps = suggestionSteps(court, null, 25);
    expect(steps).toHaveLength(1);
    expect(steps[0].circle.radiusMi).toBe(25);
  });

  it('skips the area when it is the same circle as the place', () => {
    expect(suggestionSteps(court, area(5, OAKLAND), 5).map((s) => s.source)).toEqual(['place']);
    // Same centre, another radius: a different circle.
    expect(suggestionSteps(court, area(10, OAKLAND), 5).map((s) => s.source)).toEqual(['place', 'area']);
  });
});

describe('firstWithAnyone', () => {
  const steps = ['place', 'area'] as const;

  it('keeps the first step that finds anyone', async () => {
    const seen: string[] = [];
    const hit = await firstWithAnyone(steps, async (s) => {
      seen.push(s);
      return s === 'place' ? [{ id: 'a' }] : [{ id: 'b' }];
    });
    expect(hit).toEqual({ step: 'place', rows: [{ id: 'a' }] });
    expect(seen).toEqual(['place']); // the area is never read
  });

  it('falls through an empty place to the area', async () => {
    const hit = await firstWithAnyone(steps, async (s) => (s === 'place' ? [] : [{ id: 'b' }]));
    expect(hit).toEqual({ step: 'area', rows: [{ id: 'b' }] });
  });

  it('applies keep before judging a step empty (the level band)', async () => {
    const rows = { place: [{ id: 'pro', rating: 5.2 }], area: [{ id: 'mid', rating: 3.4 }] };
    const hit = await firstWithAnyone(steps, async (s) => rows[s], (r) => withinLevel(r, 3.5, 1.5));
    expect(hit).toEqual({ step: 'area', rows: [{ id: 'mid', rating: 3.4 }] });
  });

  it('null when no step finds anyone, or there are no steps', async () => {
    expect(await firstWithAnyone(steps, async () => [])).toBeNull();
    expect(await firstWithAnyone([], async () => [{ id: 'x' }])).toBeNull();
  });

  it('a failing read throws (an empty list never stands for a failed read)', async () => {
    await expect(firstWithAnyone(steps, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
});

describe('withinLevel', () => {
  it('keeps ±band of the level in order, never a row with no rating', () => {
    const rows = [
      { id: 'a', rating: 3.0 },
      { id: 'b', rating: 5.1 },
      { id: 'c', rating: null },
      { id: 'd', rating: 2.0 },
      { id: 'e', rating: 4.99 },
    ];
    expect(withinLevel(rows, 3.5, 1.5).map((r) => r.id)).toEqual(['a', 'd', 'e']);
  });
});

describe('suggestionsHeading', () => {
  it('names where the suggestions come from', () => {
    expect(suggestionsHeading('place', 'Lake Merritt', 5)).toBe('Players near Lake Merritt · 5 mi');
    expect(suggestionsHeading('place', null, 10)).toBe('Players near the court · 10 mi');
    expect(suggestionsHeading('area', 'Oakland, CA', 25)).toBe('Players near Oakland, CA · 25 mi');
    expect(suggestionsHeading('area', null, 5)).toBe('Players near your search area · 5 mi');
    expect(suggestionsHeading('anywhere', 'x', 5)).toBeNull();
  });
});

describe('suggestedFirst (suggest nearby, search all)', () => {
  it('the suggestions in their order, then everyone else by name, each once', () => {
    const near = [{ id: 'z', full_name: 'Zed' }, { id: 'a', full_name: 'Ann' }];
    const everyone = [
      { id: 'c', full_name: 'Cal' },
      { id: 'a', full_name: 'Ann' },
      { id: 'b', full_name: 'Bea' },
      { id: 'z', full_name: 'Zed' },
    ];
    expect(suggestedFirst(near, everyone).map((p) => p.id)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('no suggestions: everyone by name (the old list)', () => {
    expect(suggestedFirst([], [{ id: '2', full_name: 'Bo' }, { id: '1', full_name: 'Al' }]).map((p) => p.id)).toEqual(['1', '2']);
  });
});

describe('readAllPages (search everyone past the 500-row cap)', () => {
  const people = Array.from({ length: 1203 }, (_, i) => ({ id: `p${String(i).padStart(4, '0')}` }));
  const fetchPage = (pageSize: number) => async (exclude: readonly string[]) => {
    const skip = new Set(exclude);
    return people.filter((p) => !skip.has(p.id)).slice(0, pageSize);
  };

  it('reads every page by leaving out what came back', async () => {
    const calls: number[] = [];
    const all = await readAllPages(async (ex) => {
      calls.push(ex.length);
      return fetchPage(500)(ex);
    });
    expect(all).toHaveLength(1203);
    expect(new Set(all.map((p) => p.id)).size).toBe(1203);
    expect(calls).toEqual([0, 500, 1000]);
  });

  it('one short page is one call', async () => {
    let n = 0;
    const all = await readAllPages(async () => {
      n++;
      return people.slice(0, 42);
    });
    expect(all).toHaveLength(42);
    expect(n).toBe(1);
  });

  it('stops at maxPages, and when a full page brings nothing new', async () => {
    expect(await readAllPages(fetchPage(500), 500, 2)).toHaveLength(1000);
    let n = 0;
    const stuck = await readAllPages(async () => {
      n++;
      return people.slice(0, 500); // a server that ignores p_exclude
    });
    expect(stuck).toHaveLength(500);
    expect(n).toBe(2);
  });
});

describe('the client fallback places by league courts only', () => {
  it('a circle around a court finds that league, never a star or a check-in (there is no input for them)', () => {
    const leagues = [
      { id: 'oak', home_court: 'Lake Merritt', home_court_lat: OAKLAND.lat, home_court_lng: OAKLAND.lng, is_open: true },
      { id: 'sf', home_court: 'Golden Gate Park', home_court_lat: SF.lat, home_court_lng: SF.lng, is_open: true },
    ];
    const members = [
      { league_id: 'oak', user_id: 'ann' },
      { league_id: 'sf', user_id: 'sam' },
    ];
    const a = leagueAnchorsInArea(leagues, members, circleAround(OAKLAND, 5), { meId: 'me', now: Date.now() });
    expect([...a.keys()]).toEqual(['ann']);
    expect(a.get('ann')!.place).toBe('Lake Merritt');
  });
});
