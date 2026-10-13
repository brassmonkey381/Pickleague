import { describe, it, expect } from 'vitest';
import {
  LEAGUE_SHEET_DEFAULTS,
  TOURNAMENT_SHEET_DEFAULTS,
  changedChip,
  countLabel,
  countSheetFilters,
  effectiveChips,
  matchesQuery,
  milesBetween,
  myCourtsCenter,
  normalizeQuery,
  pagedCount,
  quickChipsVisible,
  resolveLeagueSort,
  resolveTournamentSort,
  sheetInEffect,
  sortLeagues,
  sortVisible,
  splitLeagues,
  splitTournaments,
  toggleChip,
  widerDistance,
  type PlayLeague,
  type PlayTournament,
  type TournamentCtx,
} from '../playFilters';

// ── Fixtures ────────────────────────────────────────────────────────────────

const OAKLAND = { lat: 37.8044, lng: -122.2712 };
const SF = { lat: 37.7749, lng: -122.4194 };
const SAN_JOSE = { lat: 37.3382, lng: -121.8863 };

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

const base = { query: '', chips: [] as string[], sheet: LEAGUE_SHEET_DEFAULTS, sort: 'auto', coords: null };

// Today's prod shape: 4 leagues, the user in 3.
const TODAY: PlayLeague[] = [
  league({ id: 'dinks', name: 'Dinks', home_court: 'Lake Merritt', myRole: 'admin', ...latLng(OAKLAND) }),
  league({ id: 'the-league', name: 'The League', home_court: 'Moraga', myRole: 'member' }),
  league({ id: 'sean', name: 'Sean Leegue', home_court: 'Mission Courts', myRole: 'member', ...latLng(SF) }),
  league({ id: 'opp', name: 'Organized Pickle Play', home_court: 'Lake Merritt', ...latLng(OAKLAND) }),
];

function latLng(p: { lat: number; lng: number }) {
  return { home_court_lat: p.lat, home_court_lng: p.lng };
}

// ── Leagues ─────────────────────────────────────────────────────────────────

describe('splitLeagues: Mine is structural', () => {
  it('puts member leagues in Mine and the rest in Discover', () => {
    const s = splitLeagues(TODAY, base);
    expect(s.mine.map((l) => l.id)).toEqual(['dinks', 'sean', 'the-league']); // admin first, then by name
    expect(s.discover.map((l) => l.id)).toEqual(['opp']);
  });

  it('Mine is empty (so the section is hidden) for a user in no league', () => {
    const s = splitLeagues(TODAY.map((l) => ({ ...l, myRole: null })), base);
    expect(s.mine).toHaveLength(0);
    expect(s.chipCounts.mine).toBe(0);
    expect(s.discover).toHaveLength(4);
  });

  it('a pending join request counts as Mine', () => {
    const s = splitLeagues([league({ id: 'p', is_open: false, hasRequested: true })], base);
    expect(s.mine.map((l) => l.id)).toEqual(['p']);
    expect(s.discover).toHaveLength(0);
  });

  it('Discover-only chips never hide a Mine row', () => {
    for (const chip of ['open', 'in_season', 'has_tournaments', 'saved']) {
      const s = splitLeagues(TODAY, { ...base, chips: [chip] });
      expect(s.mine.map((l) => l.id)).toEqual(['dinks', 'sean', 'the-league']);
    }
  });

  it('sheet filters (distance, private, min players) never hide a Mine row', () => {
    const leagues = [
      ...TODAY,
      league({ id: 'private-mine', is_open: false, myRole: 'member', memberCount: 1, ...latLng(SAN_JOSE) }),
    ];
    const s = splitLeagues(leagues, {
      ...base,
      coords: OAKLAND,
      sheet: { distance: '5', private: 'hide', min_players: '20' },
    });
    expect(s.mine.map((l) => l.id)).toContain('private-mine');
    expect(s.mine).toHaveLength(4);
    expect(s.discover).toHaveLength(0);
  });

  it('search narrows Mine (and Discover) together', () => {
    const s = splitLeagues(TODAY, { ...base, query: '  lake ' });
    expect(s.mine.map((l) => l.id)).toEqual(['dinks']);
    expect(s.discover.map((l) => l.id)).toEqual(['opp']);
  });

  it('search matches the court nickname the row shows, and the admin name', () => {
    const leagues = [league({ id: 'x', name: 'Tuesday', home_court: 'Bushrod Park', adminName: 'Brian S' })];
    const courtLabel = (raw: string | null) => (raw === 'Bushrod Park' ? 'The Rod' : raw ?? '');
    expect(splitLeagues(leagues, { ...base, query: 'the rod', courtLabel }).discover).toHaveLength(1);
    expect(splitLeagues(leagues, { ...base, query: 'brian' }).discover).toHaveLength(1);
    expect(splitLeagues(leagues, { ...base, query: 'nope' }).discover).toHaveLength(0);
  });

  it('the Mine chip means "only Mine": it hides Discover', () => {
    const s = splitLeagues(TODAY, { ...base, chips: ['mine'] });
    expect(s.hideDiscover).toBe(true);
    expect(s.discover).toHaveLength(0);
    expect(s.mine).toHaveLength(3);
  });
});

describe('splitLeagues: Discover filters', () => {
  it('private leagues show by default', () => {
    const leagues = [league({ id: 'priv', is_open: false }), league({ id: 'open' })];
    expect(LEAGUE_SHEET_DEFAULTS.private).toBe('show');
    expect(splitLeagues(leagues, base).discover.map((l) => l.id).sort()).toEqual(['open', 'priv']);
    expect(splitLeagues(leagues, { ...base, sheet: { ...LEAGUE_SHEET_DEFAULTS, private: 'hide' } }).discover.map((l) => l.id)).toEqual(['open']);
  });

  it('chips are AND-ed', () => {
    const leagues = [
      league({ id: 'a', activeSeasonCount: 1 }),
      league({ id: 'b', activeSeasonCount: 1, is_open: false }),
      league({ id: 'c' }),
    ];
    const s = splitLeagues(leagues, { ...base, chips: ['open', 'in_season'] });
    expect(s.discover.map((l) => l.id)).toEqual(['a']);
  });

  it('chip counts say what each chip would leave, given the other chips', () => {
    const leagues = [
      league({ id: 'a', activeSeasonCount: 1, saved: true }),
      league({ id: 'b', activeSeasonCount: 1, is_open: false }),
      league({ id: 'c', activeTournamentCount: 2 }),
    ];
    const s = splitLeagues(leagues, { ...base, chips: ['in_season'] });
    expect(s.chipCounts.open).toBe(1); // in_season AND open -> a
    expect(s.chipCounts.in_season).toBe(2); // its own count ignores itself
    expect(s.chipCounts.has_tournaments).toBe(0);
    expect(s.chipCounts.saved).toBe(1);
  });

  it('distance needs coordinates: rows without a court location drop out under a radius', () => {
    const leagues = [
      league({ id: 'oak', ...latLng(OAKLAND) }),
      league({ id: 'sj', ...latLng(SAN_JOSE) }),
      league({ id: 'nowhere' }),
    ];
    const s = splitLeagues(leagues, { ...base, coords: OAKLAND, sheet: { ...LEAGUE_SHEET_DEFAULTS, distance: '25' } });
    expect(s.discover.map((l) => l.id)).toEqual(['oak']);
  });

  it('a radius with no device location filters nothing (never an empty list)', () => {
    const leagues = [league({ id: 'oak', ...latLng(OAKLAND) }), league({ id: 'nowhere' })];
    const s = splitLeagues(leagues, { ...base, coords: null, sheet: { ...LEAGUE_SHEET_DEFAULTS, distance: '5' } });
    expect(s.discover).toHaveLength(2);
  });

  it('a saved radius with no device location is not an active filter', () => {
    const sheet = { ...LEAGUE_SHEET_DEFAULTS, distance: '25' };
    expect(splitLeagues(TODAY, { ...base, coords: null, sheet }).filtersOn).toBe(false);
    expect(splitLeagues(TODAY, { ...base, coords: OAKLAND, sheet }).filtersOn).toBe(true);
  });

  it('sheetInEffect hides the radius only while coords are missing, and keeps everything else', () => {
    const sheet = { ...LEAGUE_SHEET_DEFAULTS, distance: '25', private: 'hide' };
    expect(sheetInEffect(sheet, null)).toEqual({ ...sheet, distance: 'any' });
    expect(sheetInEffect(sheet, OAKLAND)).toBe(sheet);
    // Nothing to hide: the same object comes back (stable for memo deps).
    expect(sheetInEffect(LEAGUE_SHEET_DEFAULTS, null)).toBe(LEAGUE_SHEET_DEFAULTS);
    expect(countSheetFilters(sheetInEffect(sheet, null), LEAGUE_SHEET_DEFAULTS)).toBe(1);
  });

  it('min players', () => {
    const leagues = [league({ id: 'small', memberCount: 2 }), league({ id: 'big', memberCount: 12 })];
    const s = splitLeagues(leagues, { ...base, sheet: { ...LEAGUE_SHEET_DEFAULTS, min_players: '10' } });
    expect(s.discover.map((l) => l.id)).toEqual(['big']);
  });

  it('filtersOn counts chips and sheet groups, not search or sort', () => {
    expect(splitLeagues(TODAY, { ...base, query: 'x', sort: 'name' }).filtersOn).toBe(false);
    expect(splitLeagues(TODAY, { ...base, chips: ['open'] }).filtersOn).toBe(true);
    expect(splitLeagues(TODAY, { ...base, sheet: { ...LEAGUE_SHEET_DEFAULTS, private: 'hide' } }).filtersOn).toBe(true);
  });
});

describe('chips and sort appear as the list grows', () => {
  it('chips: only above 6 Discover rows, or while a filter is on', () => {
    expect(quickChipsVisible(1, false)).toBe(false);
    expect(quickChipsVisible(6, false)).toBe(false);
    expect(quickChipsVisible(7, false)).toBe(true);
    expect(quickChipsVisible(0, true)).toBe(true);
  });

  it('sort: hidden at 6 rows or fewer', () => {
    expect(sortVisible(6)).toBe(false);
    expect(sortVisible(7)).toBe(true);
  });
});

describe('route-param chips are never saved', () => {
  it("Home's Mine chip from route params is in effect but not in the saved set", () => {
    const saved: string[] = [];
    const route = ['mine'];
    expect(effectiveChips(saved, route)).toEqual(['mine']);
    // The user turns another chip on: only that one is saved.
    const next = toggleChip({ saved, route }, 'open');
    expect(next.on).toBe(true);
    expect(next.saved).toEqual(['open']);
    expect(next.route).toEqual(['mine']);
    expect(effectiveChips(next.saved, next.route)).toEqual(['open', 'mine']);
  });

  it('turning the route Mine chip off removes it for the visit, still without saving anything', () => {
    const next = toggleChip({ saved: ['open'], route: ['mine'] }, 'mine');
    expect(next.on).toBe(false);
    expect(next.saved).toEqual(['open']);
    expect(next.route).toEqual([]);
  });

  it('a chip the user turns on is saved; off is removed', () => {
    const on = toggleChip({ saved: [], route: [] }, 'mine');
    expect(on.saved).toEqual(['mine']);
    const off = toggleChip({ saved: on.saved, route: [] }, 'mine');
    expect(off.saved).toEqual([]);
  });

  it('changedChip finds the toggled chip between two values arrays', () => {
    expect(changedChip(['a'], ['a', 'b'])).toBe('b');
    expect(changedChip(['a', 'b'], ['b'])).toBe('a');
    expect(changedChip(['a'], ['a'])).toBeNull();
  });
});

describe('league sort fallbacks', () => {
  const ctxNone = { coords: null, center: null };

  it('auto: Nearest with location, else Near my courts for members, else Most active', () => {
    expect(resolveLeagueSort('auto', { coords: OAKLAND, center: SF })).toBe('nearest');
    expect(resolveLeagueSort('auto', { coords: null, center: SF })).toBe('near_courts');
    expect(resolveLeagueSort('auto', ctxNone)).toBe('active');
  });

  it('a saved Nearest falls back when location is gone', () => {
    expect(resolveLeagueSort('nearest', { coords: null, center: SF })).toBe('near_courts');
    expect(resolveLeagueSort('nearest', ctxNone)).toBe('active');
    expect(resolveLeagueSort('near_courts', ctxNone)).toBe('active');
    expect(resolveLeagueSort('name', ctxNone)).toBe('name');
    expect(resolveLeagueSort('garbage', ctxNone)).toBe('active');
  });

  it('"near my courts" is the average of my leagues\' home_court_lat/lng (members only)', () => {
    const c = myCourtsCenter([
      league({ id: 'a', myRole: 'member', home_court_lat: 37, home_court_lng: -122 }),
      league({ id: 'b', myRole: 'admin', home_court_lat: 38, home_court_lng: -121 }),
      league({ id: 'c', myRole: null, home_court_lat: 10, home_court_lng: 10 }),
      league({ id: 'd', myRole: 'member' }), // no coords: ignored
    ]);
    expect(c).toEqual({ lat: 37.5, lng: -121.5 });
    expect(myCourtsCenter([league({ id: 'x' })])).toBeNull();
  });

  it('a member with no location gets Discover sorted by distance from their courts', () => {
    const leagues = [
      league({ id: 'mine', myRole: 'member', ...latLng(OAKLAND) }),
      league({ id: 'sj', ...latLng(SAN_JOSE) }),
      league({ id: 'sf', ...latLng(SF) }),
      league({ id: 'nowhere', recentMatchCount: 99 }),
    ];
    const s = splitLeagues(leagues, base);
    expect(s.sort).toBe('near_courts');
    expect(s.discover.map((l) => l.id)).toEqual(['sf', 'sj', 'nowhere']);
  });

  it('Most active = matches in the last 30 days, then players, then name', () => {
    const out = sortLeagues(
      [
        league({ id: 'b', name: 'B', recentMatchCount: 2 }),
        league({ id: 'a', name: 'A', recentMatchCount: 2 }),
        league({ id: 'c', name: 'C', recentMatchCount: 9 }),
        league({ id: 'd', name: 'D', recentMatchCount: 2, memberCount: 30 }),
      ],
      'active',
      ctxNone,
    );
    expect(out.map((l) => l.id)).toEqual(['c', 'd', 'a', 'b']);
  });
});

describe('small helpers', () => {
  it('search words are AND-ed across fields', () => {
    expect(normalizeQuery('  Lake   Merritt ')).toBe('lake merritt');
    expect(matchesQuery(['Dinks', 'Lake Merritt'], 'dinks lake')).toBe(true);
    expect(matchesQuery(['Dinks', 'Lake Merritt'], 'dinks moraga')).toBe(false);
    expect(matchesQuery([null, undefined], '')).toBe(true);
  });

  it('paging and "38 of 153"', () => {
    expect(pagedCount(153, 1)).toBe(25);
    expect(pagedCount(153, 7)).toBe(153);
    expect(countLabel(25, 153)).toBe('25 of 153');
    expect(countLabel(4, 4)).toBe('4');
  });

  it('widen distance', () => {
    expect(widerDistance('25')).toBe('50');
    expect(widerDistance('50')).toBeNull();
    expect(widerDistance('any')).toBeNull();
  });

  it('miles between Oakland and SF is about 8', () => {
    expect(milesBetween(OAKLAND, SF)).toBeGreaterThan(7);
    expect(milesBetween(OAKLAND, SF)).toBeLessThan(10);
  });

  it('sheet filter count compares multi values as sets', () => {
    expect(countSheetFilters({ format: ['a', 'b'] }, { format: [] })).toBe(1);
    expect(countSheetFilters({ format: [] }, { format: [] })).toBe(0);
    expect(countSheetFilters({ ...TOURNAMENT_SHEET_DEFAULTS }, TOURNAMENT_SHEET_DEFAULTS)).toBe(0);
  });
});

// ── Tournaments ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-13T12:00:00Z').getTime();

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

function ctx(over: Partial<TournamentCtx> = {}): TournamentCtx {
  return {
    myRegs: {},
    myLeagueIds: new Set(),
    availability: [],
    approvedCounts: {},
    leagueNames: {},
    coords: null,
    now: NOW,
    ...over,
  };
}

const tq = { query: '', chips: [] as string[], sheet: TOURNAMENT_SHEET_DEFAULTS, sort: 'soonest' };

describe('splitTournaments', () => {
  it('Mine lists invites first, and excludes rejections and ended tournaments', () => {
    const list = [
      tourn({ id: 'registered', start_time: '2026-10-14T16:00:00Z' }),
      tourn({ id: 'invited', start_time: '2026-11-01T16:00:00Z' }),
      tourn({ id: 'rejected' }),
      tourn({ id: 'ended-mine', status: 'completed' }),
      tourn({ id: 'other' }),
    ];
    const s = splitTournaments(list, tq, ctx({
      myRegs: {
        registered: { status: 'approved', invited_by: null },
        invited: { status: 'pending', invited_by: 'u2' },
        rejected: { status: 'rejected', invited_by: null },
        'ended-mine': { status: 'approved', invited_by: null },
      },
    }));
    expect(s.mine.map((t) => t.id)).toEqual(['invited', 'registered']);
    expect(s.open.map((t) => t.id).sort()).toEqual(['other', 'rejected']);
    expect(s.ended.map((t) => t.id)).toEqual(['ended-mine']);
  });

  it('Discover chips never hide Mine', () => {
    const list = [tourn({ id: 'mine', match_type: 'singles' }), tourn({ id: 'd' })];
    const s = splitTournaments(list, { ...tq, chips: ['doubles', 'this_week'] }, ctx({
      myRegs: { mine: { status: 'approved', invited_by: null } },
    }));
    expect(s.mine.map((t) => t.id)).toEqual(['mine']);
  });

  it('search covers every status and the league name', () => {
    const list = [
      tourn({ id: 'a', name: 'Fall Open', status: 'completed' }),
      tourn({ id: 'b', name: 'Spring Fling', status: 'cancelled', league_id: 'L1' }),
      tourn({ id: 'c', name: 'Oakland Classic', status: 'active' }),
    ];
    const c = ctx({ leagueNames: { L1: 'Dinks' } });
    expect(splitTournaments(list, { ...tq, query: 'fall' }, c).ended.map((t) => t.id)).toEqual(['a']);
    expect(splitTournaments(list, { ...tq, query: 'dinks' }, c).ended.map((t) => t.id)).toEqual(['b']);
    expect(splitTournaments(list, { ...tq, query: 'oakland' }, c).inProgress.map((t) => t.id)).toEqual(['c']);
  });

  it('Starting soon sorts by start_time ascending, no start last', () => {
    const list = [
      tourn({ id: 'none' }),
      tourn({ id: 'late', start_time: '2026-12-01T00:00:00Z' }),
      tourn({ id: 'soon', start_time: '2026-10-20T00:00:00Z' }),
    ];
    expect(splitTournaments(list, tq, ctx()).open.map((t) => t.id)).toEqual(['soon', 'late', 'none']);
    expect(resolveTournamentSort('nearest', null)).toBe('soonest');
  });

  it('Open now honours the registration deadline', () => {
    const list = [
      tourn({ id: 'open' }),
      tourn({ id: 'closed', registration_closes_at: '2026-10-01T00:00:00Z' }),
      tourn({ id: 'running', status: 'active' }),
    ];
    const s = splitTournaments(list, { ...tq, chips: ['open_now'] }, ctx());
    expect([...s.open, ...s.inProgress].map((t) => t.id)).toEqual(['open']);
  });

  it('In my leagues / Singles', () => {
    const list = [
      tourn({ id: 'mine-league', league_id: 'L1' }),
      tourn({ id: 'singles', match_type: 'singles' }),
    ];
    const c = ctx({ myLeagueIds: new Set(['L1']) });
    expect(splitTournaments(list, { ...tq, chips: ['in_my_leagues'] }, c).open.map((t) => t.id)).toEqual(['mine-league']);
    expect(splitTournaments(list, { ...tq, chips: ['singles'] }, c).open.map((t) => t.id)).toEqual(['singles']);
  });

  it('Spots left uses APPROVED registrations against max_players', () => {
    const list = [tourn({ id: 'full', max_players: 2 }), tourn({ id: 'room', max_players: 8 })];
    const s = splitTournaments(list, { ...tq, sheet: { ...TOURNAMENT_SHEET_DEFAULTS, spots: 'open' } }, ctx({
      approvedCounts: { full: 2, room: 3 },
    }));
    expect(s.open.map((t) => t.id)).toEqual(['room']);
  });

  it('"show ended" is a display choice, not a filter', () => {
    const s = splitTournaments([tourn({ id: 'a' })], { ...tq, sheet: { ...TOURNAMENT_SHEET_DEFAULTS, ended: 'shown' } }, ctx());
    expect(s.filtersOn).toBe(false);
  });

  it('a saved radius with no device location is not an active filter', () => {
    const sheet = { ...TOURNAMENT_SHEET_DEFAULTS, distance: '25' };
    expect(splitTournaments([tourn({ id: 'a' })], { ...tq, sheet }, ctx()).filtersOn).toBe(false);
    expect(splitTournaments([tourn({ id: 'a' })], { ...tq, sheet }, ctx({ coords: OAKLAND })).filtersOn).toBe(true);
  });
});
