// Discover's tabs and the old routes that fold into it (lib/discoverTabs.ts).
import { describe, it, expect } from 'vitest';
import {
  DISCOVER_TABS,
  asDiscoverTab,
  asPlayersView,
  availableDiscoverTabs,
  discoverParamsForLegacy,
  discoverPath,
  legacyRouteForDiscover,
  openingDiscoverTab,
  rewriteLegacyDiscoverPath,
} from '../discoverTabs';

const ALL = availableDiscoverTabs({ places: true, players: true });

describe('tabs', () => {
  it("are in the user's order: Leagues · Tournaments · Places · Players", () => {
    expect(DISCOVER_TABS).toEqual(['leagues', 'tournaments', 'places', 'players']);
    expect(ALL).toEqual(['leagues', 'tournaments', 'places', 'players']);
  });

  it('Places and Players follow their own flags; the order holds', () => {
    expect(availableDiscoverTabs({ places: false, players: true })).toEqual(['leagues', 'tournaments', 'players']);
    expect(availableDiscoverTabs({ places: true, players: false })).toEqual(['leagues', 'tournaments', 'places']);
    expect(availableDiscoverTabs({ places: false, players: false })).toEqual(['leagues', 'tournaments']);
  });

  it('reads tabs and Players views strictly', () => {
    expect(asDiscoverTab('places')).toBe('places');
    for (const v of ['Places', 'courts', '', undefined, null, 3]) expect(asDiscoverTab(v)).toBeNull();
    expect(asPlayersView('find')).toBe('find');
    for (const v of ['Find', 'played', undefined]) expect(asPlayersView(v)).toBeNull();
  });
});

describe('openingDiscoverTab', () => {
  it('the route tab first', () => {
    expect(openingDiscoverTab('players', 'places', ALL)).toBe('players');
  });

  it('else the tab used last', () => {
    expect(openingDiscoverTab(undefined, 'places', ALL)).toBe('places');
    expect(openingDiscoverTab('bogus', 'tournaments', ALL)).toBe('tournaments');
  });

  it('else Leagues', () => {
    expect(openingDiscoverTab(undefined, null, ALL)).toBe('leagues');
    expect(openingDiscoverTab(null, 'nope', ALL)).toBe('leagues');
  });

  it('a tab that is not on offer never opens', () => {
    const noPlaces = availableDiscoverTabs({ places: false, players: true });
    expect(openingDiscoverTab('places', 'places', noPlaces)).toBe('leagues');
    expect(openingDiscoverTab('places', 'players', noPlaces)).toBe('players');
  });
});

describe('discoverParamsForLegacy (the aliases forward what their callers send)', () => {
  it('Play: Leagues, or Tournaments; mine and an invite code ride along', () => {
    expect(discoverParamsForLegacy('Play')).toEqual({ tab: 'leagues' });
    expect(discoverParamsForLegacy('Play', { initialTab: 'leagues' })).toEqual({ tab: 'leagues' });
    expect(discoverParamsForLegacy('Play', { initialTab: 'tournaments', mine: true })).toEqual({ tab: 'tournaments', mine: true });
    expect(discoverParamsForLegacy('Play', { initialTab: 'leagues', mine: true })).toEqual({ tab: 'leagues', mine: true });
  });

  it('Play: an invite code brings Leagues forward (Join with code lives there)', () => {
    expect(discoverParamsForLegacy('Play', { initialTab: 'tournaments', prefillInviteCode: 'ABC123' })).toEqual({
      tab: 'leagues',
      prefillInviteCode: 'ABC123',
    });
  });

  it("Play: a URL's mine='true' (a string) is not carried", () => {
    expect(discoverParamsForLegacy('Play', { mine: 'true' })).toEqual({ tab: 'leagues' });
  });

  it('Leagues keeps its invite code', () => {
    expect(discoverParamsForLegacy('Leagues')).toEqual({ tab: 'leagues' });
    expect(discoverParamsForLegacy('Leagues', { prefillInviteCode: 'ABC123' })).toEqual({ tab: 'leagues', prefillInviteCode: 'ABC123' });
    expect(discoverParamsForLegacy('Leagues', { prefillInviteCode: '' })).toEqual({ tab: 'leagues' });
  });

  it("Tournaments: the full list folds in; a league's own list does not", () => {
    expect(discoverParamsForLegacy('Tournaments')).toEqual({ tab: 'tournaments' });
    expect(discoverParamsForLegacy('Tournaments', {})).toEqual({ tab: 'tournaments' });
    expect(discoverParamsForLegacy('Tournaments', { leagueId: 'l1', leagueName: 'Dinks' })).toBeNull();
  });

  it('Courts keeps its centre (numbers, or numeric strings from a URL)', () => {
    expect(discoverParamsForLegacy('Courts')).toEqual({ tab: 'places' });
    expect(discoverParamsForLegacy('Courts', { lat: 37.77, lng: -122.42 })).toEqual({ tab: 'places', lat: 37.77, lng: -122.42 });
    expect(discoverParamsForLegacy('Courts', { lat: '37.77', lng: '-122.42' })).toEqual({ tab: 'places', lat: 37.77, lng: -122.42 });
    expect(discoverParamsForLegacy('Courts', { lat: 'x', lng: '' })).toEqual({ tab: 'places' });
  });

  it("Friends: its tab becomes Players' view", () => {
    expect(discoverParamsForLegacy('Friends')).toEqual({ tab: 'players' });
    expect(discoverParamsForLegacy('Friends', { tab: 'requests' })).toEqual({ tab: 'players', players: 'requests' });
    expect(discoverParamsForLegacy('Friends', { tab: 'find' })).toEqual({ tab: 'players', players: 'find' });
    expect(discoverParamsForLegacy('Friends', { tab: 'bogus' })).toEqual({ tab: 'players' });
  });
});

describe('legacyRouteForDiscover (Discover off: the old screen that held the tab)', () => {
  const on = { courts: true, friends: true };

  it('Leagues and Tournaments: the Play hub on that tab', () => {
    expect(legacyRouteForDiscover({ tab: 'leagues' }, on)).toEqual(['Play', { initialTab: 'leagues' }]);
    expect(legacyRouteForDiscover({}, on)).toEqual(['Play', { initialTab: 'leagues' }]);
    expect(legacyRouteForDiscover({ tab: 'tournaments', mine: true }, on)).toEqual(['Play', { initialTab: 'tournaments', mine: true }]);
    expect(legacyRouteForDiscover({ tab: 'tournaments', prefillInviteCode: 'C' }, on)).toEqual([
      'Play',
      { initialTab: 'leagues', prefillInviteCode: 'C' },
    ]);
  });

  it('Places: Courts, only with court discovery', () => {
    expect(legacyRouteForDiscover({ tab: 'places' }, on)).toEqual(['Courts', undefined]);
    expect(legacyRouteForDiscover({ tab: 'places', lat: 1, lng: 2 }, on)).toEqual(['Courts', { lat: 1, lng: 2 }]);
    expect(legacyRouteForDiscover({ tab: 'places' }, { courts: false, friends: true })).toBeNull();
  });

  it('Players: Friends, only with friends', () => {
    expect(legacyRouteForDiscover({ tab: 'players', players: 'requests' }, on)).toEqual(['Friends', { tab: 'requests' }]);
    expect(legacyRouteForDiscover({ tab: 'players' }, on)).toEqual(['Friends', undefined]);
    expect(legacyRouteForDiscover({ tab: 'players' }, { courts: true, friends: false })).toBeNull();
  });

  it('round trip: an old route to Discover and back lands on the same screen and tab', () => {
    const p = discoverParamsForLegacy('Friends', { tab: 'find' })!;
    expect(legacyRouteForDiscover(p, on)).toEqual(['Friends', { tab: 'find' }]);
    const q = discoverParamsForLegacy('Play', { initialTab: 'tournaments', mine: true })!;
    expect(legacyRouteForDiscover(q, on)).toEqual(['Play', { initialTab: 'tournaments', mine: true }]);
  });
});

describe('URLs', () => {
  it('discoverPath: /discover/<tab> and the rest as a query', () => {
    expect(discoverPath({ tab: 'places' })).toBe('discover/places');
    expect(discoverPath({})).toBe('discover');
    expect(discoverPath({ tab: 'players', players: 'requests' })).toBe('discover/players?players=requests');
    expect(discoverPath({ tab: 'leagues', prefillInviteCode: 'A B&C' })).toBe('discover/leagues?prefillInviteCode=A%20B%26C');
  });

  it.each([
    ['play', 'discover/leagues'],
    ['/play', '/discover/leagues'],
    ['play?initialTab=tournaments', 'discover/tournaments'],
    ['/play?initialTab=tournaments&mine=true', '/discover/tournaments'],
    ['play?initialTab=tournaments&prefillInviteCode=XYZ', 'discover/leagues?prefillInviteCode=XYZ'],
    ['leagues', 'discover/leagues'],
    ['/leagues/', '/discover/leagues'],
    ['leagues?prefillInviteCode=AB12CD', 'discover/leagues?prefillInviteCode=AB12CD'],
    ['tournaments', 'discover/tournaments'],
    ['courts', 'discover/places'],
    ['/courts?lat=37.77&lng=-122.42', '/discover/places?lat=37.77&lng=-122.42'],
    ['friends', 'discover/players'],
    ['/friends?tab=find', '/discover/players?players=find'],
    ['friends?tab=requests#top', 'discover/players?players=requests#top'],
  ])('%s -> %s', (from, to) => {
    expect(rewriteLegacyDiscoverPath(from)).toBe(to);
  });

  it.each([
    '',
    '/',
    'leagues/l1',
    'leagues/l1/members',
    'tournaments/t1',
    'tournaments/new',
    'tournaments?leagueId=l1',
    'courts/osm:way%2F123',
    'friendsx',
    'Play',
    'discover',
    'discover/places',
    'settings/checkins',
    'invite/ABC',
    'g/tok',
  ])('%s is left alone', (path) => {
    expect(rewriteLegacyDiscoverPath(path)).toBe(path);
  });
});
