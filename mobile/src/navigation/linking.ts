// The deep-link table for the root stack. Its own module (pure: no
// react-native import) so vitest can run getStateFromPath against the real
// config; AppNavigator passes it to NavigationContainer.
import type { LinkingOptions } from '@react-navigation/native';
import type { RootStackParamList } from '../types';
import { WAGERS_ENABLED } from '../lib/features';

export const linking: LinkingOptions<RootStackParamList> = {
  // Both origins are live and both are shared: ShareLinkButton builds
  // `https://www.pickleague.club/...` (so the Open Graph card unfurls from the
  // canonical origin, api/_lib/cards.tsx FALLBACK_ORIGIN) while invite and
  // guest-pass messages use the apex. A universal link that opens the app but
  // matches no prefix lands on Home instead of the screen the sender meant, so
  // both must be listed here AND in ios.associatedDomains.
  prefixes: ['https://pickleague.club', 'https://www.pickleague.club', 'pickleague://'],
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
      Settings: 'settings',
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
      // Wager deep links are registered only while the feature is on - an
      // unregistered path must not resolve to an unregistered screen.
      ...(WAGERS_ENABLED ? { MyWagers: 'wagers' } : {}),
      Bookmarks: 'bookmarks',
    },
  },
};
