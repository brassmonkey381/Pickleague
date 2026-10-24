// Where a push, a link button, or a confirmation notice takes you.
//
// PURE (no react-native, no expo): lib/push.ts feeds ROUTES to the
// foundation's createDeepLinkRouter, and the tests exercise this file directly.
//
// Links are "<prefix><id>[/<rest>]". send-push puts the push's link in
// data.deepLink: "<entity_type>/<entity_id>", or the generator's
// push_data.deep_link override (migration_push_data.sql), e.g.
// 'drill_chat/<request id>' to open the chat thread itself.
//
// Screen headers never come from a push title: EventDetail, TournamentDetail,
// LeagueDetail and LeagueMembers set their header from the loaded record, so
// the params below carry neutral placeholders.

export type Route = [string, Record<string, unknown>?];
export type Routes = Record<string, (id: string, rest: string) => Route | null>;

const NO_ID = '-';
const has = (id: string | undefined | null): string | undefined => (id && id !== NO_ID ? id : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** The route table. `wagersEnabled` / `friendsEnabled`: the wager screens and
 *  the Friends screen exist only when their flag is on. `discoverEnabled`:
 *  Discover holds the leagues list and the friends (its Leagues and Players
 *  tabs), so an invite code and the friend pushes open it there directly.
 *  `checkinIsland` (PLAY_NAV_ENABLED): 'home/' still opens Home, and asks the
 *  root CheckinHost to show my check-in on the island (or "At X?").
 *  `courtsEnabled` (COURT_DISCOVERY_ENABLED): 'court/<venue id>' opens the
 *  court's page; off, Home (where the court cards are). */
export function pushRoutes(opts: {
  wagersEnabled: boolean;
  friendsEnabled?: boolean;
  discoverEnabled?: boolean;
  checkinIsland?: boolean;
  courtsEnabled?: boolean;
}): Routes {
  const discover = !!opts.discoverEnabled;
  const routes: Routes = {
    'tournament/': (id) => (has(id) ? ['TournamentDetail', { tournamentId: id, tournamentName: 'Tournament' }] : null),
    'league/': (id) => (has(id) ? ['LeagueDetail', { leagueId: id, leagueName: 'League' }] : null),
    // A league's join requests (admins).
    'league_members/': (id) => (has(id) ? ['LeagueMembers', { leagueId: id, leagueName: 'League' }] : null),
    // "Pick new times" after a vote cancelled the event.
    'league_new_event/': (id) => (has(id) ? ['CreateEvent', { leagueId: id }] : null),
    // A league invite code that could not be redeemed from the push: Join
    // with code, filled in (Discover's Leagues tab, else the Leagues list).
    'invite_code/': (id) => (has(id)
      ? (discover ? ['Discover', { tab: 'leagues', prefillInviteCode: id }] : ['Leagues', { prefillInviteCode: id }])
      : null),
    'event/': (id) => (has(id) ? ['EventDetail', { eventId: id, title: 'Event' }] : null),
    // Organizer: open the event with the group-text composer up.
    'event_nudge/': (id) => (has(id) ? ['EventDetail', { eventId: id, title: 'Event', openNudge: true }] : null),
    // Organizer: open the event with the close-voting confirm up.
    'event_close/': (id) => (has(id) ? ['EventDetail', { eventId: id, title: 'Event', openClose: true }] : null),
    // "Record result": MatchEntry tied to the event. Link: event_record/<event id>/<league id>.
    'event_record/': (id, rest) => (has(id) ? ['MatchEntry', { eventId: id, leagueId: has(rest.split('/')[0]) }] : null),
    'match/': (id) => ['MatchHistory', { title: 'Match History', initialMyMatchesOnly: true, highlightMatchId: has(id) }],
    // A drill request or a drill session (the screen finds it in either list).
    'drill/': (id) => ['DrillRequests', { focusId: has(id) }],
    'drill_chat/': (id) => ['DrillRequests', { focusId: has(id), openChat: !!has(id) }],
    'drill_search/': (id) => ['DrillSearch', { partnerId: has(id) }],
    'shop/': () => ['Shop'],
    // A gifted shop item.
    'shop_item/': () => ['Shop'],
    'profile/': (id) => ['Profile', { userId: has(id) }],
    // Another player's profile ("Sam accepted your friend request").
    'player/': (id) => (has(id) ? ['PlayerProfile', { userId: id, userName: 'Player' }] : null),
    'plupr_history/': (id) => ['CalendarAnalytics', { userId: has(id), title: 'My PLUPR History' }],
    // Court check-in reminder and arrival notice: Home's court card, and with
    // the bottom bar the island too (Home passes `checkin` to CheckinHost).
    'home/': () => (opts.checkinIsland ? ['Home', { checkin: true }] : ['Home']),
    // "Sam is on the way to Lakeside" (migration_on_my_way.sql): that court's
    // page. A venue id may hold a slash (osm:way/123), so the rest of the
    // link is part of it.
    'court/': (id, rest) =>
      has(id) ? (opts.courtsEnabled ? ['CourtDetail', { venueId: rest ? `${id}/${rest}` : id }] : ['Home']) : null,
    'notifications/': () => ['Notifications'],
    // Court arrival with a saved QR code: that code, full screen.
    'wallet/': (id) => (has(id) ? ['QrPass', { passId: id }] : ['QrWallet']),
    // Not here's notices: Settings with "Check-in automation" open, where the
    // per-court switch is. Any other id is plain Settings.
    'settings/': (id) => ['Settings', id === 'checkins' ? { focus: 'checkins' } : undefined],
  };
  // The wager screens are not registered while wagering is off: a navigate to
  // them lands nowhere, so leave those links unrouted (-> Notifications list).
  if (opts.wagersEnabled) {
    routes['wager_on_me/'] = (id) => (has(id) ? ['PlayerWagers', { userId: id, userName: 'You' }] : ['MyWagers']);
    routes['wager/'] = () => ['MyWagers'];
  }
  // Likewise the Friends screen (FRIENDS_AT_COURTS_ENABLED). A friend request
  // ('friends/-') opens its Requests tab. With Discover on, the friends live
  // in its Players tab: the same view, there.
  if (opts.friendsEnabled) {
    const friends = (tab: 'requests' | 'friends' | 'find'): Route =>
      discover ? ['Discover', { tab: 'players', players: tab }] : ['Friends', { tab }];
    routes['friends/'] = (id) => friends(id === 'friends' || id === 'find' ? id : 'requests');
    // A friend notice without its own link (entity friend/<the other player>).
    routes['friend/'] = () => friends('requests');
  }
  return routes;
}

// Pushes whose tap goes somewhere more specific than their entity, picked by
// push_data.kind. The server keeps the plain "<entity_type>/<id>" link so a
// 1.0.3 phone (which knows none of these prefixes) still lands on the entity.
const KIND_LINKS: Record<string, { from: string; to: string }> = {
  drill_chat: { from: 'drill/', to: 'drill_chat/' },
  league_join_request: { from: 'league/', to: 'league_members/' },
  event_nudge_vote: { from: 'event/', to: 'event_nudge/' },
  event_nudge_tomorrow: { from: 'event/', to: 'event_nudge/' },
  event_nudge_today: { from: 'event/', to: 'event_nudge/' },
  // Its link is player/<id> already; this covers a row written without one.
  friend_accepted: { from: 'friend/', to: 'player/' },
};

/** The push's own link (or one built from entity_type / entity_id), refined by its kind. */
export function linkOf(data: Record<string, unknown> | null | undefined): string {
  if (!data) return '';
  const type = str(data.entity_type);
  const base = str(data.deepLink) ?? (type ? `${type}/${str(data.entity_id) ?? NO_ID}` : '');
  const k = KIND_LINKS[str(data.kind) ?? ''];
  if (k && base.startsWith(k.from) && has(base.slice(k.from.length))) return k.to + base.slice(k.from.length);
  return base;
}

/**
 * Link buttons (catalog `link: true`): where each one goes. Falls back to the
 * push's own link, so a link button never opens the app to nowhere. Null for
 * anything that is not a link button (the press then goes to its handler).
 */
export function linkForAction(action: string | undefined, data: Record<string, unknown>): string | null {
  const id = str(data.entity_id);
  const leagueId = str(data.league_id);
  let link: string | undefined;
  switch (action) {
    case 'event_record_result':
      link = id ? `event_record/${id}/${leagueId ?? NO_ID}` : undefined;
      break;
    case 'event_text_group':
      link = id ? `event_nudge/${id}` : undefined;
      break;
    case 'event_close_vote':
      link = id ? `event_close/${id}` : undefined;
      break;
    case 'event_pick_new_times':
      link = leagueId ? `league_new_event/${leagueId}` : undefined;
      break;
    case 'drill_open_chat':
      link = id ? `drill_chat/${id}` : undefined;
      break;
    case 'drill_find_partner':
      link = `drill_search/${NO_ID}`;
      break;
    case 'drill_find_time':
      link = `drill_search/${str(data.partner_id) ?? NO_ID}`;
      break;
    default:
      return null;
  }
  return link ?? (linkOf(data) || `notifications/${NO_ID}`);
}

/**
 * The `go` a push or a notification tap routes through (lib/push.ts wires the
 * real navigation in; pure so the tests can drive it).
 *
 * Home is always the bottom of the stack (first screen + linking
 * initialRouteName). A plain navigate('Home') pushes a second Home under
 * routers 7.x, so `popToHome` goes back to the existing one, carrying the
 * params. `{ checkin: true }` (a 'home/' push with the bar on) also asks
 * CheckinHost for the island directly: the request is held until the host
 * mounts, so it survives a cold start, where the navigator mounts on Home
 * without these params.
 */
export function pushGo(deps: {
  isReady: () => boolean;
  popToHome: (params?: Record<string, unknown>) => void;
  navigate: (name: string, params?: Record<string, unknown>) => void;
  requestCheckinIsland: () => void;
}): (name: string, params?: Record<string, unknown>) => void {
  return (name, params) => {
    if (name === 'Home') {
      if (params?.checkin) deps.requestCheckinIsland();
      // Not ready = cold start: the navigator mounts on Home anyway.
      if (deps.isReady()) deps.popToHome(params?.checkin ? undefined : params);
      return;
    }
    deps.navigate(name, params);
  };
}
