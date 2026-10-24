import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SEARCH_AREA,
  METERS_PER_MILE,
  SEARCH_AREA_STORAGE_KEY,
  asSearchRadius,
  createSearchAreaStore,
  filterBySearchArea,
  formatMiles,
  homeCourtsCenter,
  parseSearchAreaSaved,
  resolveSearchArea,
  searchAreaKey,
  searchAreaLabel,
  widerSearchRadius,
  withinSearchArea,
  type SearchArea,
  type SearchAreaStorage,
} from '../searchArea';
import {
  LEAGUE_SHEET_DEFAULTS,
  TOURNAMENT_SHEET_DEFAULTS,
  splitLeagues,
  splitTournaments,
  tournamentPoint,
  type PlayLeague,
  type PlayTournament,
  type TournamentCtx,
} from '../playFilters';
import {
  isMissingRpcError,
  leagueAnchorsInArea,
  placePlayers,
  playerMatchesQuery,
  playsAtLabel,
} from '../playersNear';

// ── Fixtures ────────────────────────────────────────────────────────────────

const OAKLAND = { lat: 37.8044, lng: -122.2712 };
const BERKELEY = { lat: 37.8715, lng: -122.273 }; // ~4.6 mi from Oakland
const SF = { lat: 37.7749, lng: -122.4194 }; // ~8.4 mi from Oakland
const SAN_JOSE = { lat: 37.3382, lng: -121.8863 }; // ~39 mi from Oakland

const CITY = { label: 'Oakland, CA', ...OAKLAND };

function area(radiusMi: number, center = OAKLAND): SearchArea {
  return { center, radiusMi, radiusM: Math.round(radiusMi * METERS_PER_MILE), source: 'city', label: 'Oakland, CA' };
}

/** A fake AsyncStorage: a map, with switches to fail reads or writes. */
function fakeStorage(initial: Record<string, string> = {}, opts: { failGet?: boolean; failSet?: boolean } = {}) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  const storage: SearchAreaStorage = {
    getItem: async (k) => {
      if (opts.failGet) throw new Error('storage unavailable');
      return data.get(k) ?? null;
    },
    setItem: async (k, v) => {
      if (opts.failSet) throw new Error('quota');
      data.set(k, v);
      writes.push(v);
    },
  };
  return { storage, data, writes };
}

// ── Saved value + resolution ────────────────────────────────────────────────

describe('parseSearchAreaSaved', () => {
  it('reads a saved value, as JSON or an object', () => {
    const v = { radiusMi: 25, mode: 'city', city: CITY };
    expect(parseSearchAreaSaved(JSON.stringify(v))).toEqual(v);
    expect(parseSearchAreaSaved(v)).toEqual(v);
  });

  it('falls back to the defaults for junk', () => {
    for (const raw of [null, undefined, 'not json', 42, '[]', { radiusMi: 'x' }]) {
      const p = parseSearchAreaSaved(raw);
      expect(p.radiusMi).toBe(5);
      expect(p.mode).toBe('device');
      expect(p.city).toBeNull();
    }
  });

  it('only keeps a radius from the choices', () => {
    expect(parseSearchAreaSaved({ radiusMi: 7 }).radiusMi).toBe(5);
    expect(parseSearchAreaSaved({ radiusMi: '10' }).radiusMi).toBe(10);
    expect(asSearchRadius(50)).toBe(50);
    expect(asSearchRadius(-1)).toBe(5);
  });

  it("drops a city with no usable point, and a 'city' mode without a city", () => {
    expect(parseSearchAreaSaved({ mode: 'city', city: { label: 'X', lat: 0, lng: 0 } })).toEqual(DEFAULT_SEARCH_AREA);
    expect(parseSearchAreaSaved({ mode: 'city', city: { label: '', lat: 1, lng: 1 } }).mode).toBe('device');
    expect(parseSearchAreaSaved({ mode: 'city', city: { label: 'X', lat: 200, lng: 1 } }).city).toBeNull();
  });
});

describe('resolveSearchArea', () => {
  it('uses the device location in device mode', () => {
    const a = resolveSearchArea({ radiusMi: 10, mode: 'device', city: CITY }, SF);
    expect(a).toMatchObject({ center: SF, source: 'device', label: null, radiusMi: 10 });
    expect(a!.radiusM).toBe(Math.round(10 * METERS_PER_MILE));
  });

  it('falls back to the searched city while location is off or denied', () => {
    expect(resolveSearchArea({ radiusMi: 5, mode: 'device', city: CITY }, null))
      .toMatchObject({ center: OAKLAND, source: 'city', label: 'Oakland, CA' });
  });

  it('keeps a chosen city even when the location is known', () => {
    expect(resolveSearchArea({ radiusMi: 5, mode: 'city', city: CITY }, SF)).toMatchObject({ center: OAKLAND, source: 'city' });
  });

  it('is null with none of them (nothing is limited)', () => {
    expect(resolveSearchArea(DEFAULT_SEARCH_AREA, null)).toBeNull();
    expect(resolveSearchArea(DEFAULT_SEARCH_AREA, { lat: 0, lng: 0 })).toBeNull();
    expect(resolveSearchArea(DEFAULT_SEARCH_AREA, null, null)).toBeNull();
    expect(resolveSearchArea(DEFAULT_SEARCH_AREA, null, { lat: 0, lng: 0 })).toBeNull();
  });

  it("falls back to my leagues' courts with no location and no city", () => {
    expect(resolveSearchArea({ ...DEFAULT_SEARCH_AREA, radiusMi: 10 }, null, BERKELEY))
      .toMatchObject({ center: BERKELEY, source: 'courts', label: null, radiusMi: 10 });
  });

  it('the courts are the LAST fallback: the device and any city win', () => {
    expect(resolveSearchArea(DEFAULT_SEARCH_AREA, SF, BERKELEY)!.source).toBe('device');
    expect(resolveSearchArea({ radiusMi: 5, mode: 'device', city: CITY }, null, BERKELEY))
      .toMatchObject({ center: OAKLAND, source: 'city' });
    expect(resolveSearchArea({ radiusMi: 5, mode: 'city', city: CITY }, SF, BERKELEY)!.source).toBe('city');
  });

  it('labels and keys', () => {
    expect(searchAreaLabel(null, null)).toBe('Choose an area');
    expect(searchAreaLabel(area(5), null)).toBe('Near Oakland, CA · 5 mi');
    expect(searchAreaLabel({ ...area(10), source: 'device', label: null }, 'Alameda, CA')).toBe('Near Alameda, CA · 10 mi');
    expect(searchAreaLabel({ ...area(5), source: 'courts', label: null }, null)).toBe('Near your courts · 5 mi');
    expect(searchAreaLabel({ ...area(5), source: 'courts', label: null }, 'Berkeley, CA')).toBe('Near Berkeley, CA · 5 mi');
    expect(searchAreaKey(null)).toBe('anywhere');
    expect(searchAreaKey(area(5))).toBe(searchAreaKey({ ...area(5), center: { lat: 37.80441, lng: -122.27121 } }));
    expect(searchAreaKey(area(5))).not.toBe(searchAreaKey(area(10)));
  });
});

describe('homeCourtsCenter', () => {
  const NYC = { lat: 40.7128, lng: -74.006 };

  it('is null with no located court', () => {
    expect(homeCourtsCenter([])).toBeNull();
    expect(homeCourtsCenter([null, undefined, { lat: 0, lng: 0 }])).toBeNull();
  });

  it('is the court itself with one', () => {
    expect(homeCourtsCenter([BERKELEY])).toEqual(BERKELEY);
  });

  it('averages the biggest cluster, not every court (no Kansas between SF and New York)', () => {
    const c = homeCourtsCenter([NYC, OAKLAND, BERKELEY])!;
    expect(c.lat).toBeCloseTo((OAKLAND.lat + BERKELEY.lat) / 2, 6);
    expect(c.lng).toBeCloseTo((OAKLAND.lng + BERKELEY.lng) / 2, 6);
  });

  it('takes the first court on a tie', () => {
    expect(homeCourtsCenter([NYC, OAKLAND])).toEqual(NYC);
  });
});

// ── Distance filtering ──────────────────────────────────────────────────────

describe('withinSearchArea / filterBySearchArea', () => {
  it('measures great-circle miles against the radius', () => {
    expect(withinSearchArea(BERKELEY, area(5))).toBe(true);
    expect(withinSearchArea(SF, area(5))).toBe(false);
    expect(withinSearchArea(SF, area(10))).toBe(true);
    expect(withinSearchArea(SAN_JOSE, area(25))).toBe(false);
    expect(withinSearchArea(SAN_JOSE, area(50))).toBe(true);
  });

  it('leaves out a row with no location under an area, keeps everything without one', () => {
    expect(withinSearchArea(null, area(50))).toBe(false);
    expect(withinSearchArea(null, null)).toBe(true);
    expect(withinSearchArea(SAN_JOSE, null)).toBe(true);
  });

  it('keeps the order, and any one of several points counts', () => {
    const rows = [
      { id: 'sj', pts: [SAN_JOSE] },
      { id: 'b', pts: [BERKELEY] },
      { id: 'both', pts: [SAN_JOSE, SF] },
      { id: 'none', pts: [null] },
    ];
    expect(filterBySearchArea(rows, area(10), (r) => r.pts).map((r) => r.id)).toEqual(['b', 'both']);
    expect(filterBySearchArea(rows, null, (r) => r.pts).map((r) => r.id)).toEqual(['sj', 'b', 'both', 'none']);
  });

  it('widens one step at a time, and formats miles', () => {
    expect(widerSearchRadius(5)).toBe(10);
    expect(widerSearchRadius(25)).toBe(50);
    expect(widerSearchRadius(50)).toBeNull();
    expect(formatMiles(0.04)).toBe('0.1 mi');
    expect(formatMiles(0.44)).toBe('0.4 mi');
    expect(formatMiles(3.4)).toBe('3 mi');
  });
});

// ── The shared store ────────────────────────────────────────────────────────

describe('createSearchAreaStore', () => {
  it('starts at the defaults, then loads what this device saved', async () => {
    const saved = { radiusMi: 25, mode: 'city', city: CITY };
    const { storage } = fakeStorage({ [SEARCH_AREA_STORAGE_KEY]: JSON.stringify(saved) });
    const store = createSearchAreaStore(storage);
    expect(store.get()).toEqual(DEFAULT_SEARCH_AREA);
    expect(store.ready()).toBe(false);
    await store.load();
    expect(store.ready()).toBe(true);
    expect(store.get()).toEqual(saved);
  });

  it('is one value for every subscriber (a change on one tab is the area on all)', async () => {
    const { storage, data } = fakeStorage();
    const store = createSearchAreaStore(storage);
    await store.load();
    const seenA: number[] = [];
    const seenB: number[] = [];
    store.subscribe((v) => seenA.push(v.radiusMi));
    const offB = store.subscribe((v) => seenB.push(v.radiusMi));
    store.setRadius(10);
    offB();
    store.setRadius(25);
    expect(seenA).toEqual([10, 25]);
    expect(seenB).toEqual([10]);
    await Promise.resolve();
    expect(JSON.parse(data.get(SEARCH_AREA_STORAGE_KEY)!)).toMatchObject({ radiusMi: 25 });
  });

  it('picks a city, then goes back to my location keeping the city as the fallback', async () => {
    const store = createSearchAreaStore(fakeStorage().storage);
    await store.load();
    store.pickCity(CITY);
    expect(store.get()).toMatchObject({ mode: 'city', city: CITY });
    expect(resolveSearchArea(store.get(), SF)!.source).toBe('city');
    store.preferDevice();
    expect(store.get()).toMatchObject({ mode: 'device', city: CITY });
    expect(resolveSearchArea(store.get(), SF)!.center).toEqual(SF);
    expect(resolveSearchArea(store.get(), null)!.center).toEqual(OAKLAND);
  });

  it('ignores a bad radius or city, and does not notify for no change', async () => {
    const store = createSearchAreaStore(fakeStorage().storage);
    await store.load();
    let n = 0;
    store.subscribe(() => n++);
    store.setRadius(5); // already 5
    store.pickCity({ label: ' ', lat: 1, lng: 1 });
    store.pickCity({ label: 'Nowhere', lat: Number.NaN, lng: 1 });
    expect(n).toBe(0);
    store.setRadius(7); // not a choice: the default, which it already is
    expect(store.get().radiusMi).toBe(5);
    expect(n).toBe(0);
  });

  it('a change made before the read finishes is not overwritten by it', async () => {
    const saved = { radiusMi: 50, mode: 'device', city: null };
    const store = createSearchAreaStore(fakeStorage({ [SEARCH_AREA_STORAGE_KEY]: JSON.stringify(saved) }).storage);
    const loading = store.load();
    store.setRadius(10);
    await loading;
    expect(store.get().radiusMi).toBe(10);
  });

  it('survives storage that fails (a private window): defaults, and changes hold for the run', async () => {
    const store = createSearchAreaStore(fakeStorage({}, { failGet: true, failSet: true }).storage);
    await store.load();
    expect(store.ready()).toBe(true);
    expect(store.get()).toEqual(DEFAULT_SEARCH_AREA);
    store.setRadius(25);
    expect(store.get().radiusMi).toBe(25);
  });

  it('remembers the device\'s nearest city as the fallback, keeping my location the centre', async () => {
    const { storage, data } = fakeStorage();
    const store = createSearchAreaStore(storage);
    await store.rememberCity(CITY);
    expect(store.get()).toMatchObject({ mode: 'device', city: CITY });
    expect(resolveSearchArea(store.get(), SF)!.source).toBe('device');
    // The next run without a location (a fresh web visit) still has an area.
    await Promise.resolve();
    const next = createSearchAreaStore(fakeStorage({ [SEARCH_AREA_STORAGE_KEY]: data.get(SEARCH_AREA_STORAGE_KEY)! }).storage);
    await next.load();
    expect(resolveSearchArea(next.get(), null)).toMatchObject({ center: OAKLAND, source: 'city', label: 'Oakland, CA' });
  });

  it('never replaces a city the player chose, nor what storage held', async () => {
    const chosen = { label: 'Berkeley, CA', ...BERKELEY };
    const saved = { radiusMi: 25, mode: 'city', city: chosen };
    const store = createSearchAreaStore(fakeStorage({ [SEARCH_AREA_STORAGE_KEY]: JSON.stringify(saved) }).storage);
    // Before the read finishes: it waits for it, then sees the chosen city.
    await store.rememberCity(CITY);
    expect(store.get()).toEqual(saved);
  });

  it('ignores a remembered city with no usable point or label', async () => {
    const store = createSearchAreaStore(fakeStorage().storage);
    await store.rememberCity({ label: 'Nowhere', lat: 0, lng: 0 });
    await store.rememberCity({ label: ' ', lat: 1, lng: 1 });
    expect(store.get()).toEqual(DEFAULT_SEARCH_AREA);
  });

  it('load runs once', async () => {
    let reads = 0;
    const store = createSearchAreaStore({ getItem: async () => { reads++; return null; }, setItem: async () => {} });
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(reads).toBe(1);
  });
});

// ── Leagues and tournaments under an area ───────────────────────────────────

function league(over: Partial<PlayLeague> & { id: string }): PlayLeague {
  return {
    name: over.id,
    home_court: null,
    home_court_lat: null,
    home_court_lng: null,
    is_open: true,
    created_at: '2026-01-01T00:00:00Z',
    myRole: null,
    hasRequested: false,
    memberCount: 3,
    adminName: null,
    activeSeasonCount: 0,
    activeTournamentCount: 0,
    saved: false,
    recentMatchCount: 0,
    ...over,
  };
}
const at = (p: { lat: number; lng: number }) => ({ home_court_lat: p.lat, home_court_lng: p.lng });
const lq = { query: '', chips: [] as string[], sheet: LEAGUE_SHEET_DEFAULTS, sort: 'auto', coords: null };

const LEAGUES = [
  league({ id: 'mine-far', myRole: 'member', ...at(SAN_JOSE) }),
  league({ id: 'mine-nowhere', myRole: 'admin' }),
  league({ id: 'berkeley', ...at(BERKELEY) }),
  league({ id: 'oakland', ...at(OAKLAND) }),
  league({ id: 'sf', ...at(SF) }),
  league({ id: 'nowhere' }),
];

describe('splitLeagues under a search area', () => {
  it('limits Discover to the area and leaves out leagues with no location; Mine is untouched', () => {
    const s = splitLeagues(LEAGUES, { ...lq, areaLimited: true, area: area(5) });
    expect(s.mine.map((l) => l.id).sort()).toEqual(['mine-far', 'mine-nowhere']);
    expect(s.discover.map((l) => l.id)).toEqual(['oakland', 'berkeley']); // Nearest from the centre
    expect(s.sort).toBe('nearest');
  });

  it('a wider radius brings more in', () => {
    const s = splitLeagues(LEAGUES, { ...lq, areaLimited: true, area: area(10) });
    expect(s.discover.map((l) => l.id)).toEqual(['oakland', 'berkeley', 'sf']);
  });

  it('without an area yet nothing is limited', () => {
    const s = splitLeagues(LEAGUES, { ...lq, areaLimited: true, area: null });
    expect(s.discover.map((l) => l.id).sort()).toEqual(['berkeley', 'nowhere', 'oakland', 'sf']);
  });

  it("search is limited too, and the sheet's own Distance is ignored under an area", () => {
    const s = splitLeagues(LEAGUES, {
      ...lq, query: 'sf', sheet: { ...LEAGUE_SHEET_DEFAULTS, distance: '50' }, coords: SAN_JOSE, areaLimited: true, area: area(5),
    });
    expect(s.discover).toEqual([]);
    expect(s.filtersOn).toBe(false);
  });

  it('outside Discover (areaLimited off) the area has no effect', () => {
    const s = splitLeagues(LEAGUES, { ...lq, area: area(5) });
    expect(s.discover).toHaveLength(4);
  });
});

function tourn(over: Partial<PlayTournament> & { id: string }): PlayTournament {
  return {
    name: over.id,
    league_id: null,
    status: 'registration',
    format: 'round_robin',
    match_type: 'doubles',
    start_time: null,
    registration_closes_at: null,
    expected_length_hours: null,
    max_players: null,
    pickle_ante: 0,
    location_name: null,
    location_lat: null,
    location_lng: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}
const tctx = (over: Partial<TournamentCtx> = {}): TournamentCtx => ({
  myRegs: {},
  myLeagueIds: new Set(),
  availability: [],
  approvedCounts: {},
  leagueNames: {},
  coords: null,
  now: Date.parse('2026-10-24T12:00:00Z'),
  ...over,
});
const tq = { query: '', chips: [] as string[], sheet: TOURNAMENT_SHEET_DEFAULTS, sort: 'soonest' };

describe('splitTournaments under a search area', () => {
  const list = [
    tourn({ id: 'venue-near', location_lat: BERKELEY.lat, location_lng: BERKELEY.lng }),
    tourn({ id: 'venue-far', location_lat: SAN_JOSE.lat, location_lng: SAN_JOSE.lng }),
    tourn({ id: 'league-near', league_id: 'L-oak' }),
    tourn({ id: 'league-far', league_id: 'L-sj' }),
    tourn({ id: 'nowhere' }),
    tourn({ id: 'mine-far', location_lat: SAN_JOSE.lat, location_lng: SAN_JOSE.lng }),
    tourn({ id: 'ended-near', status: 'completed', location_lat: OAKLAND.lat, location_lng: OAKLAND.lng }),
    tourn({ id: 'ended-far', status: 'completed', location_lat: SAN_JOSE.lat, location_lng: SAN_JOSE.lng }),
    tourn({ id: 'ended-mine-far', status: 'completed', location_lat: SAN_JOSE.lat, location_lng: SAN_JOSE.lng }),
  ];
  const ctx = tctx({
    areaLimited: true,
    area: area(5),
    leaguePoints: { 'L-oak': OAKLAND, 'L-sj': SAN_JOSE },
    myRegs: { 'mine-far': { status: 'approved', invited_by: null }, 'ended-mine-far': { status: 'approved', invited_by: null } },
  });

  it('places a tournament by its venue, else its league home court', () => {
    expect(tournamentPoint(list[0])).toEqual(BERKELEY);
    expect(tournamentPoint(list[2], { 'L-oak': OAKLAND })).toEqual(OAKLAND);
    expect(tournamentPoint(list[4], { 'L-oak': OAKLAND })).toBeNull();
  });

  it('limits Open / In progress / Ended to the area; my own are never limited', () => {
    const s = splitTournaments(list, tq, ctx);
    expect(s.mine.map((t) => t.id)).toEqual(['mine-far']);
    expect(s.open.map((t) => t.id).sort()).toEqual(['league-near', 'venue-near']);
    expect(s.ended.map((t) => t.id).sort()).toEqual(['ended-mine-far', 'ended-near']);
  });

  it('without an area nothing is limited', () => {
    const s = splitTournaments(list, tq, { ...ctx, area: null });
    expect(s.open).toHaveLength(5);
  });
});

// ── Players near (the fallback before the SQL is applied) ──────────────────

describe('players near: the league fallback', () => {
  const leagues = [
    { id: 'oak', home_court: 'Lake Merritt', home_court_lat: OAKLAND.lat, home_court_lng: OAKLAND.lng, is_open: true },
    { id: 'brk', home_court: 'Live Oak', home_court_lat: BERKELEY.lat, home_court_lng: BERKELEY.lng, is_open: true },
    { id: 'closed', home_court: 'Club', home_court_lat: OAKLAND.lat, home_court_lng: OAKLAND.lng, is_open: false },
    { id: 'shared', home_court: 'Shared', home_court_lat: OAKLAND.lat, home_court_lng: OAKLAND.lng, is_open: false },
    { id: 'sj', home_court: 'SJ', home_court_lat: SAN_JOSE.lat, home_court_lng: SAN_JOSE.lng, is_open: true },
  ];
  const now = Date.parse('2026-10-24T12:00:00Z');
  const members = [
    { league_id: 'oak', user_id: 'ann' },
    { league_id: 'brk', user_id: 'ann' },
    { league_id: 'brk', user_id: 'bob' },
    { league_id: 'closed', user_id: 'cat' },
    { league_id: 'shared', user_id: 'dan' },
    { league_id: 'shared', user_id: 'me' },
    { league_id: 'sj', user_id: 'eve' },
    { league_id: 'oak', user_id: 'guest', expires_at: '2026-10-01T00:00:00Z' },
    { league_id: 'oak', user_id: 'me' },
  ];

  it('places players at their nearest league court in the area, with the server rules', () => {
    const a = leagueAnchorsInArea(leagues, members, area(10), { meId: 'me', now });
    expect([...a.keys()].sort()).toEqual(['ann', 'bob', 'dan']);
    expect(a.get('ann')!.place).toBe('Lake Merritt'); // Oakland (0 mi) beats Berkeley
    expect(a.get('bob')!.place).toBe('Live Oak');
    expect(a.has('cat')).toBe(false); // a closed league I'm not in
    expect(a.has('eve')).toBe(false); // too far
    expect(a.has('guest')).toBe(false); // an expired guest pass
    expect(a.has('me')).toBe(false);
  });

  it('orders the placed players nearest first and drops the rest', () => {
    const a = leagueAnchorsInArea(leagues, members, area(10), { meId: 'me', now });
    const rows = placePlayers(
      [{ id: 'bob', full_name: 'Bob' }, { id: 'eve', full_name: 'Eve' }, { id: 'ann', full_name: 'Ann' }],
      a,
    );
    expect(rows.map((r) => r.id)).toEqual(['ann', 'bob']);
    expect(rows[0]).toMatchObject({ place_kind: 'league', place_name: 'Lake Merritt' });
  });

  it('labels, name search, and the missing-RPC test', () => {
    expect(playsAtLabel({ place_name: 'Lake Merritt', distance_m: 3 * METERS_PER_MILE })).toBe('Plays at Lake Merritt · 3 mi');
    expect(playsAtLabel({ place_name: null, distance_m: 300 })).toBe('Plays nearby · 0.2 mi');
    expect(playsAtLabel({ place_name: 'X', distance_m: null })).toBeNull();
    expect(playerMatchesQuery({ full_name: 'Ann Lee', username: 'annl' }, '@ANNL')).toBe(true);
    expect(playerMatchesQuery({ full_name: 'Ann Lee', username: null }, 'bob')).toBe(false);
    expect(isMissingRpcError({ code: 'PGRST202', message: 'x' })).toBe(true);
    expect(isMissingRpcError({ message: 'Could not find the function public.discover_players_near' })).toBe(true);
    expect(isMissingRpcError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingRpcError(null)).toBe(false);
  });
});
