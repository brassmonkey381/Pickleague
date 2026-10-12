import { describe, it, expect } from 'vitest';
import { defineNotificationCatalog } from '@just-messin-around/expo-foundation/push/catalog';
import { CATALOG } from '../notificationCatalog.data';
import { linkForAction, linkOf, pushRoutes } from '../pushLinks';

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
  });

  it('wager links stay unrouted while wagering is off', () => {
    expect(route('wager/w1')).toBeNull();
    expect(pushRoutes({ wagersEnabled: true })['wager/']).toBeTypeOf('function');
  });
});
