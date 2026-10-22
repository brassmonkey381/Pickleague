import { describe, it, expect } from 'vitest';
import { getActionFromState, getPathFromState, getStateFromPath } from '@react-navigation/core';
import { StackRouter } from '@react-navigation/routers';
import { defineNotificationCatalog } from '@just-messin-around/expo-foundation/push/catalog';
import { CATALOG } from '../notificationCatalog.data';
import { linkForAction, linkOf, pushRoutes } from '../pushLinks';
import { COURT_LINKS, linking } from '../../navigation/linking';
import { courtPathSegment } from '../courtDiscovery';

const routes = pushRoutes({ wagersEnabled: false });

/** A tiny stand-in for createDeepLinkRouter: longest matching prefix wins. */
function route(link: string) {
  const prefix = Object.keys(routes)
    .filter((p) => link.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  if (!prefix) return null;
  const tail = link.slice(prefix.length);
  const [id, ...rest] = tail.split('/');
  return routes[prefix](id, rest.join('/'));
}

describe('notification catalog', () => {
  const catalog = defineNotificationCatalog(CATALOG);

  it('has no problems (link buttons open the app, at most 3 buttons)', () => {
    expect(catalog.problems).toEqual([]);
  });

  it('every link button has a destination', () => {
    for (const id of catalog.linkActionIds) {
      expect(linkForAction(id, { entity_id: 'x', league_id: 'l' }), id).toBeTruthy();
    }
  });

  it('irreversible / costly buttons need unlock or open the app', () => {
    expect(CATALOG.match_confirm.actions.match_confirm).toMatchObject({ authenticationRequired: true });
    expect(CATALOG.tournament_invite.actions.tournament_accept).toMatchObject({ authenticationRequired: true });
    expect(CATALOG.league_invite.actions.league_join).toMatchObject({ authenticationRequired: true });
    // Accepting a friend lets them see you at the courts.
    expect(CATALOG.friend_request.actions.friend_accept).toMatchObject({ authenticationRequired: true });
    expect(Object.keys(CATALOG.friend_request.actions)).toEqual(['friend_accept', 'friend_decline']);
    expect(CATALOG.event_organizer_vote.actions.event_close_vote).toMatchObject({ opensApp: true, link: true });
  });

  it('"How did it go?" never offers I\'m in / Can\'t make it', () => {
    expect(Object.keys(CATALOG.event_record.actions)).toEqual(['event_record_result']);
  });
});

describe('linkOf', () => {
  it('uses the push link, else entity_type/entity_id', () => {
    expect(linkOf({ deepLink: 'event/e1' })).toBe('event/e1');
    expect(linkOf({ entity_type: 'match', entity_id: 'm1' })).toBe('match/m1');
    expect(linkOf({ entity_type: 'shop' })).toBe('shop/-');
    expect(linkOf({})).toBe('');
    expect(linkOf(null)).toBe('');
  });

  it('refines by kind, keeping the plain link for 1.0.3 phones on the server', () => {
    expect(linkOf({ deepLink: 'drill/r1', kind: 'drill_chat' })).toBe('drill_chat/r1');
    expect(linkOf({ entity_type: 'league', entity_id: 'l1', kind: 'league_join_request' })).toBe('league_members/l1');
    expect(linkOf({ deepLink: 'event/e1', kind: 'event_nudge_today' })).toBe('event_nudge/e1');
    // no id: leave it alone
    expect(linkOf({ deepLink: 'drill/-', kind: 'drill_chat' })).toBe('drill/-');
    // a kind on another entity: leave it alone
    expect(linkOf({ deepLink: 'shop/-', kind: 'drill_chat' })).toBe('shop/-');
  });
});

describe('routes', () => {
  it('event pushes open the event with a neutral header', () => {
    expect(route('event/e1')).toEqual(['EventDetail', { eventId: 'e1', title: 'Event' }]);
    expect(route('event_nudge/e1')).toEqual(['EventDetail', { eventId: 'e1', title: 'Event', openNudge: true }]);
    expect(route('event_close/e1')).toEqual(['EventDetail', { eventId: 'e1', title: 'Event', openClose: true }]);
  });

  it('Record result opens MatchEntry tied to the event', () => {
    expect(route(linkForAction('event_record_result', { entity_id: 'e1', league_id: 'l1' })!)).toEqual([
      'MatchEntry',
      { eventId: 'e1', leagueId: 'l1' },
    ]);
  });

  it('drill links', () => {
    expect(route('drill/r1')).toEqual(['DrillRequests', { focusId: 'r1' }]);
    expect(route('drill_chat/r1')).toEqual(['DrillRequests', { focusId: 'r1', openChat: true }]);
    expect(route(linkForAction('drill_find_time', { entity_id: 's1', partner_id: 'p1' })!)).toEqual([
      'DrillSearch',
      { partnerId: 'p1' },
    ]);
    expect(route(linkForAction('drill_find_partner', { entity_id: 'r1' })!)).toEqual(['DrillSearch', { partnerId: undefined }]);
  });

  it('league links', () => {
    expect(route('league_members/l1')).toEqual(['LeagueMembers', { leagueId: 'l1', leagueName: 'League' }]);
    expect(route(linkForAction('event_pick_new_times', { entity_id: 'e1', league_id: 'l1' })!)).toEqual([
      'CreateEvent',
      { leagueId: 'l1' },
    ]);
  });

  it('local notices and refunds', () => {
    expect(route('home/-')).toEqual(['Home']);
    expect(route('shop/-')).toEqual(['Shop']);
    expect(route('match/m1')?.[0]).toBe('MatchHistory');
    // Court arrival with a saved QR code opens that code; no id opens the wallet.
    expect(route('wallet/p1')).toEqual(['QrPass', { passId: 'p1' }]);
    expect(route('wallet/-')).toEqual(['QrWallet']);
    // Not here's notices open Settings with "Check-in automation" open.
    expect(route('settings/checkins')).toEqual(['Settings', { focus: 'checkins' }]);
    expect(route('settings/-')).toEqual(['Settings', undefined]);
  });

  it('friend links: Friends only while friends are on; a player link always', () => {
    expect(route('player/u1')).toEqual(['PlayerProfile', { userId: 'u1', userName: 'Player' }]);
    expect(route('player/-')).toBeNull();
    expect(route('friends/-')).toBeNull();
    const on = pushRoutes({ wagersEnabled: false, friendsEnabled: true });
    expect(on['friends/']('-', '')).toEqual(['Friends', { tab: 'requests' }]);
    expect(on['friends/']('find', '')).toEqual(['Friends', { tab: 'find' }]);
    expect(on['friend/']('u1', '')).toEqual(['Friends', { tab: 'requests' }]);
    // "Accepted your friend request" without its own link opens their profile.
    expect(linkOf({ entity_type: 'friend', entity_id: 'u1', kind: 'friend_accepted' })).toBe('player/u1');
    expect(linkOf({ entity_type: 'friend', entity_id: 'u1', deepLink: 'friends/-', kind: 'friend_request' })).toBe('friends/-');
  });

  it('wager links stay unrouted while wagering is off', () => {
    expect(route('wager/w1')).toBeNull();
    expect(pushRoutes({ wagersEnabled: true })['wager/']).toBeTypeOf('function');
  });
});

describe('optional focus params (ui-compaction P1)', () => {
  // Home's Up next rows pass EventDetail {focus:'vote'|'rsvp'} and
  // TournamentDetail {focus:'invite'|'next_match'}. Pushes never do: every
  // existing link must keep resolving exactly as before, with no focus key.
  it('push links resolve without focus', () => {
    for (const link of ['event/e1', 'event_nudge/e1', 'event_close/e1', 'tournament/t1', 'league/l1']) {
      const r = route(link);
      expect(r, link).toBeTruthy();
      expect(r![1], link).not.toHaveProperty('focus');
    }
    expect(route('tournament/t1')).toEqual(['TournamentDetail', { tournamentId: 't1', tournamentName: 'Tournament' }]);
  });

  it('a focus-less EventDetail / TournamentDetail URL still resolves', () => {
    const ev = getStateFromPath('events/e1', linking.config);
    expect(ev?.routes.at(-1)).toMatchObject({ name: 'EventDetail', params: { eventId: 'e1' } });
    expect(ev?.routes.at(-1)?.params).not.toHaveProperty('focus');
    const t = getStateFromPath('tournaments/t1', linking.config);
    expect(t?.routes.at(-1)).toMatchObject({ name: 'TournamentDetail', params: { tournamentId: 't1' } });
    expect(t?.routes.at(-1)?.params).not.toHaveProperty('focus');
  });

  it('a focus query param rides along on a URL', () => {
    const ev = getStateFromPath('events/e1?focus=vote', linking.config);
    expect(ev?.routes.at(-1)?.params).toEqual({ eventId: 'e1', focus: 'vote' });
  });
});

describe('linking: Home under every cold deep link', () => {
  const names = (path: string) => getStateFromPath(path, linking.config)?.routes.map((r) => r.name);

  it('the config names Home as the root initial route', () => {
    expect(linking.config?.initialRouteName).toBe('Home');
  });

  it('a cold /leagues/:id or /events/:id has Home underneath', () => {
    const s = getStateFromPath('leagues/l1', linking.config);
    expect(s?.index).toBe(1);
    expect(s?.routes.map((r) => r.name)).toEqual(['Home', 'LeagueDetail']);
    expect(s?.routes[1].params).toEqual({ leagueId: 'l1' });
    expect(names('events/e1')).toEqual(['Home', 'EventDetail']);
    expect(names('tournaments/t1/members')).toEqual(['Home', 'TournamentMembers']);
  });

  it('existing paths resolve to the same screens', () => {
    const cases: [string, string][] = [
      ['play', 'Play'],
      ['leagues', 'Leagues'],
      ['leagues/l1/members', 'LeagueMembers'],
      ['leagues/l1/events/new', 'CreateEvent'],
      ['tournaments', 'Tournaments'],
      ['tournaments/new', 'CreateTournament'],
      ['tournaments/t1/matches', 'TournamentMatchHistory'],
      ['seasons/s1/standings', 'SeasonStandings'],
      ['profile', 'Profile'],
      ['players/u1', 'PlayerProfile'],
      ['g/tok', 'GuestJoin'],
      ['drill/requests', 'DrillRequests'],
    ];
    for (const [path, screen] of cases) expect(names(path)?.at(-1), path).toBe(screen);
    // Play's tab still rides in the query string.
    expect(getStateFromPath('play?initialTab=tournaments', linking.config)?.routes.at(-1)?.params).toEqual({
      initialTab: 'tournaments',
    });
  });

  it('settings/checkins opens Check-in automation; plain settings is unchanged', () => {
    const s = getStateFromPath('settings/checkins', linking.config);
    expect(s?.routes.map((r) => r.name)).toEqual(['Home', 'Settings']);
    expect(s?.routes.at(-1)?.params).toEqual({ focus: 'checkins' });
    expect(names('settings')).toEqual(['Home', 'Settings']);
    // The optional segment leaves focus unset (the screen opens only for 'checkins').
    const plain = getStateFromPath('settings', linking.config)?.routes.at(-1)?.params as { focus?: string } | undefined;
    expect(plain?.focus).toBeUndefined();
    // The web URL bar: no "/settings/undefined".
    expect(getPathFromState(getStateFromPath('settings', linking.config)!, linking.config)).toBe('/settings');
    expect(getPathFromState(s!, linking.config)).toBe('/settings/checkins');
  });

  it('Home itself stays a single route', () => {
    expect(names('')).toEqual(['Home']);
  });

  it('signed out, the stack drops the unregistered Home (login and guest links unchanged)', () => {
    const router = StackRouter({});
    const routeNames = ['Login', 'Register', 'GuestJoin'];
    const rehydrate = (path: string) =>
      router.getRehydratedState(getStateFromPath(path, linking.config) as never, { routeNames, routeParamList: {}, routeGetIdList: {} });
    expect(rehydrate('login').routes.map((r) => r.name)).toEqual(['Login']);
    const guest = rehydrate('g/tok');
    expect(guest.routes.map((r) => r.name)).toEqual(['GuestJoin']);
    expect(guest.routes[guest.index].name).toBe('GuestJoin');
  });

  it('a warm link still navigates (no stack reset)', () => {
    const state = getStateFromPath('leagues/l1', linking.config)!;
    const action = getActionFromState(state, linking.config);
    expect(action).toMatchObject({ type: 'NAVIGATE', payload: { name: 'LeagueDetail', params: { leagueId: 'l1' } } });
  });
});

describe('court discovery links (venue ids hold ":" and "/")', () => {
  // The flag is off on master, so the table is built here with the court
  // paths in it (COURT_LINKS is what linking.ts adds while it is on).
  const config = {
    ...linking.config!,
    screens: { ...linking.config!.screens, ...COURT_LINKS },
  } as NonNullable<typeof linking.config>;

  it.each(['osm:way/123', 'g:ChIJN1t_tDeuEmsRUsoyG83frY4', 'user:2c1e/9 x'])('%s round-trips through the URL', (venueId) => {
    const state = { routes: [{ name: 'Home' }, { name: 'CourtDetail', params: { venueId } }], index: 1 };
    const path = getPathFromState(state as never, config);
    expect(path).toBe(`/courts/${courtPathSegment(venueId)}`);
    expect(path.split('/')).toHaveLength(3); // the id stays one segment
    const back = getStateFromPath(path, config);
    expect(back?.routes.map((r) => r.name)).toEqual(['Home', 'CourtDetail']);
    expect(back?.routes.at(-1)?.params).toEqual({ venueId });
  });

  it('osm:way/123 reads as osm:way%2F123 in the address bar', () => {
    const path = getPathFromState(
      { routes: [{ name: 'CourtDetail', params: { venueId: 'osm:way/123' } }] } as never,
      config,
    );
    expect(path).toBe('/courts/osm:way%2F123');
  });

  it('a link encoded with encodeURIComponent (":" as %3A) opens the same court', () => {
    const s = getStateFromPath(`courts/${encodeURIComponent('osm:way/123')}`, config);
    expect(s?.routes.at(-1)?.params).toEqual({ venueId: 'osm:way/123' });
  });

  it('/courts opens the list, with Home underneath', () => {
    expect(getStateFromPath('courts', config)?.routes.map((r) => r.name)).toEqual(['Home', 'Courts']);
  });

  it('while the flag is off, /courts paths are not registered', () => {
    expect(linking.config?.screens).not.toHaveProperty('CourtDetail');
    expect(linking.config?.screens).not.toHaveProperty('Courts');
  });
});
