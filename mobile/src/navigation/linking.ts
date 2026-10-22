// The deep-link table for the root stack. Its own module (pure: no
// react-native import) so vitest can run getStateFromPath against the real
// config; AppNavigator passes it to NavigationContainer.
// core, not native: native's index pulls in react-native, which vitest can't load.
import { getStateFromPath as defaultGetStateFromPath } from '@react-navigation/core';
import type { LinkingOptions } from '@react-navigation/native';
import type { RootStackParamList } from '../types';
import {
  COURT_DISCOVERY_ENABLED,
  DISCOVER_ENABLED,
  FRIENDS_AT_COURTS_ENABLED,
  REFERRALS_ENABLED,
  ROUTINES_ENABLED,
  WAGERS_ENABLED,
} from '../lib/features';
import { rewriteLegacyDiscoverPath } from '../lib/discoverTabs';

/**
 * Discover's path (registered only while DISCOVER_ENABLED): /discover opens the
 * tab used last, /discover/<leagues|tournaments|places|players> that tab. Its
 * other params ride in the query (?players=requests, ?lat=..&lng=..,
 * ?prefillInviteCode=..). lat / lng parse back to numbers (Places reads only
 * numbers). Exported for the tests.
 */
export const DISCOVER_LINK = {
  path: 'discover/:tab?',
  parse: { lat: finiteOrUndefined, lng: finiteOrUndefined },
} as const;

/** A query number, or undefined for '' and junk (Number('') is 0, Number('x') NaN). */
function finiteOrUndefined(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
}

/** React Navigation's getStateFromPath after the old-list rewrite (lib/discoverTabs). */
export const discoverAwareStateFromPath: typeof defaultGetStateFromPath = (path, options) =>
  defaultGetStateFromPath(rewriteLegacyDiscoverPath(path), options);

/**
 * Court discovery's paths (registered only while COURT_DISCOVERY_ENABLED).
 * A venue id holds ':' and '/' ('osm:way/123', 'g:<place id>'): React
 * Navigation percent-encodes a param's '/' (and anything outside RFC 3986's
 * pchar) when it builds the URL and decodes it when it reads one, so
 * /courts/osm:way%2F123 opens 'osm:way/123'. lib/courtDiscovery courtShareUrl
 * builds the shared link the same way. Exported for the round-trip tests.
 */
export const COURT_LINKS = {
  Courts: 'courts',
  CourtDetail: 'courts/:venueId',
} as const;

export const linking: LinkingOptions<RootStackParamList> = {
  // Both origins are live and both are shared: ShareLinkButton builds
  // `https://www.pickleague.club/...` (so the Open Graph card unfurls from the
  // canonical origin, api/_lib/cards.tsx FALLBACK_ORIGIN) while invite and
  // guest-pass messages use the apex. A universal link that opens the app but
  // matches no prefix lands on Home instead of the screen the sender meant, so
  // both must be listed here AND in ios.associatedDomains.
  prefixes: ['https://pickleague.club', 'https://www.pickleague.club', 'pickleague://'],
  // While Discover is on, the old list links open it on their tab, with what
  // they carried: /play -> /discover/leagues (?initialTab=tournaments ->
  // /discover/tournaments), /leagues -> /discover/leagues (?prefillInviteCode
  // kept), /tournaments -> /discover/tournaments (with ?leagueId it stays the
  // league's list), /courts -> /discover/places (?lat&lng kept), /friends ->
  // /discover/players (?tab=find -> ?players=find). Rewritten before parsing,
  // so no alias screen mounts and the address bar shows /discover/<tab>.
  // /courts/<venue id> and every other path are untouched.
  ...(DISCOVER_ENABLED ? { getStateFromPath: discoverAwareStateFromPath } : {}),
  config: {
    // Home sits under every deep link. Without it a cold open of
    // /leagues/:id (web URL, universal link, or a cold-start push routed
    // through the linking table) leaves LeagueDetail alone in the stack, and
    // no screen has a headerLeft fallback, so Saved / Notifications /
    // Settings (Home-only entry points; there is no tab bar) are unreachable.
    // getStateFromPath turns 'leagues/l1' into [Home, LeagueDetail]; the
    // root-level initialRouteName is honoured (core 7.x getInitialRoutes,
    // parentScreens []), a link to '' (Home itself) stays a single route,
    // and a warm link still dispatches a plain NAVIGATE (getActionFromState
    // special-cases [initialRoute, target]). Signed out, the stack's
    // rehydration drops Home because it isn't registered, so /login and
    // /g/:token resolve as before. Covered by __tests__/pushLinks.test.ts.
    initialRouteName: 'Home',
    screens: {
      Login: 'login',
      Register: 'register',
      GuestJoin: 'g/:token',
      Home: '',
      ...(DISCOVER_ENABLED ? { Discover: DISCOVER_LINK } : {}),
      Play: 'play',
      Leagues: 'leagues',
      LeagueDetail: 'leagues/:leagueId',
      LeagueMembers: 'leagues/:leagueId/members',
      LeagueInfo: 'leagues/:leagueId/info',
      Invite: 'leagues/:leagueId/invite',
      Events: 'leagues/:leagueId/events',
      CreateEvent: 'leagues/:leagueId/events/new',
      EventDetail: 'events/:eventId',
      Tournaments: 'tournaments',
      TournamentDetail: 'tournaments/:tournamentId',
      TournamentMembers: 'tournaments/:tournamentId/members',
      TournamentInfo: 'tournaments/:tournamentId/info',
      TournamentInvite: 'tournaments/:tournamentId/invite',
      TournamentInvitePlayers: 'tournaments/:tournamentId/invite-players',
      TournamentMatchHistory: 'tournaments/:tournamentId/matches',
      CreateTournament: 'tournaments/new',
      MatchEntry: 'match-entry',
      MatchHistory: 'matches',
      CalendarAnalytics: 'analytics/calendar',
      SeasonStandings: 'seasons/:seasonId/standings',
      Profile: {
        path: 'profile/:userId?',
      },
      PlayerProfile: 'players/:userId',
      Claim: 'claim',
      Notifications: 'notifications',
      // settings/checkins opens "Check-in automation" (the push link of the
      // same name, lib/pushLinks.ts); plain settings is unchanged.
      Settings: 'settings/:focus?',
      About: 'about',
      Shop: 'shop',
      GiftPickles: 'gift-pickles',
      ScoringAlgo: 'scoring-algo',
      UnlockProgress: 'unlock-progress',
      Drill: 'drill',
      DrillSearch: 'drill/search',
      DrillRequests: 'drill/requests',
      Godmode: 'godmode',
      BlockedPlayers: 'blocked-players',
      ModerationQueue: 'moderation',
      AdminBoundaries: 'admin/outlines',
      AdminBoundaryEditor: 'admin/outlines/:venueId',
      // Wager deep links are registered only while the feature is on - an
      // unregistered path must not resolve to an unregistered screen.
      ...(WAGERS_ENABLED ? { MyWagers: 'wagers' } : {}),
      // Same for Friends (?tab=find picks the tab).
      ...(FRIENDS_AT_COURTS_ENABLED ? { Friends: 'friends' } : {}),
      // And court discovery.
      ...(COURT_DISCOVERY_ENABLED ? COURT_LINKS : {}),
      // And routines.
      ...(ROUTINES_ENABLED ? { Routines: 'routines' } : {}),
      // And for the referral invite landing (?ref=CODE on any path is read by
      // ReferralHost, not by this table).
      ...(REFERRALS_ENABLED ? { InviteLanding: 'invite/:code' } : {}),
      Bookmarks: 'bookmarks',
    },
  },
};
