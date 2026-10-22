import React, { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import SplashScreen from '../components/SplashScreen';
import ContinueInAppBanner from '../components/ContinueInAppBanner';
import { isUpdateRequired } from '../lib/minVersion';
import { useTheme } from '../lib/ThemeContext';
import { TourProvider } from '../lib/TourContext';
import SpotlightTour from '../components/SpotlightTour';
import ToastProvider from '../lib/ToastProvider';
import { resetStreakShown } from '../lib/loginStreak';
import { ensureCourtNicknamesLoaded } from '../lib/courtNickname';
import { navigationRef, flushPendingNavigation } from '../lib/navigationRef';
import { endSession, resetSessionUser, trackScreen } from '../lib/analytics';
import ErrorBoundary from '../components/ErrorBoundary';
import StartupRetryScreen from '../components/StartupRetryScreen';
import { useBootstrapSession, signOutSafely, useTimeZoneSync } from '@just-messin-around/expo-foundation/supabase';
import { getNativeBuild, startNetworkMonitor } from '@just-messin-around/expo-foundation/platform';
import { OfflineBanner, UpdateRequiredScreen } from '@just-messin-around/expo-foundation/ui';
import LaunchUpdateHost from '../components/LaunchUpdateHost';
import { APP_STORE_URL } from '../lib/appStore';
import { setupNotificationTapHandling } from '../lib/push';
import { clearCheckinForSignOut } from '../lib/courtCheckin';
import { clearPlayForSignOut } from '../lib/playSession';
import { endPresenceForSignOut } from '../lib/signOutPresence';
import { stopCourtGeofencesForSignOut } from '../lib/courtGeofence';
import { clearCourtArrivalForSignOut } from '../lib/courtArrival';
import CourtArrivalHost from '../components/CourtArrivalHost';
import PlayIsland from '../components/PlayIsland';
import PlayStartSheetHost from '../components/play/PlayStartSheet';
import PlayEndSheetHost from '../components/play/PlayEndSheet';
import RefusalNoticeHost from '../components/RefusalNoticeHost';
import { startOfflineWrites } from '../lib/offlineWrites';

import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import HomeScreen from '../screens/HomeScreen';
import PlayScreen from '../screens/PlayScreen';
import LeaguesScreen from '../screens/LeaguesScreen';
import LeagueDetailScreen from '../screens/LeagueDetailScreen';
import EventsScreen from '../screens/EventsScreen';
import CreateEventScreen from '../screens/CreateEventScreen';
import EventDetailScreen from '../screens/EventDetailScreen';
import LeagueMembersScreen from '../screens/LeagueMembersScreen';
import PlayerProfileScreen from '../screens/PlayerProfileScreen';
import ClaimAccountScreen from '../screens/ClaimAccountScreen';
import HeadToHeadScreen from '../screens/HeadToHeadScreen';
import TournamentsScreen from '../screens/TournamentsScreen';
import CreateTournamentScreen from '../screens/CreateTournamentScreen';
import TournamentDetailScreen from '../screens/TournamentDetailScreen';
import TournamentMembersScreen from '../screens/TournamentMembersScreen';
import TournamentMatchHistoryScreen from '../screens/TournamentMatchHistoryScreen';
import TournamentInfoScreen from '../screens/TournamentInfoScreen';
import LeagueInfoScreen from '../screens/LeagueInfoScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import InviteScreen from '../screens/InviteScreen';
import TournamentInviteScreen from '../screens/TournamentInviteScreen';
import MatchEntryScreen from '../screens/MatchEntryScreen';
import MatchHistoryScreen from '../screens/MatchHistoryScreen';
import CalendarAnalyticsScreen from '../screens/CalendarAnalyticsScreen';
import SeasonStandingsScreen from '../screens/SeasonStandingsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import UnlockProgressScreen from '../screens/UnlockProgressScreen';
import SettingsScreen from '../screens/SettingsScreen';
import UpgradeAccountScreen from '../screens/UpgradeAccountScreen';
import AboutScreen from '../screens/AboutScreen';
import DrillScreen from '../screens/DrillScreen';
import DrillSearchScreen from '../screens/DrillSearchScreen';
import DrillRequestsScreen from '../screens/DrillRequestsScreen';
import ShopScreen from '../screens/ShopScreen';
import ScoringAlgoScreen from '../screens/ScoringAlgoScreen';
import GiftPicklesScreen from '../screens/GiftPicklesScreen';
import GodmodeScreen from '../screens/GodmodeScreen';
import BlockedPlayersScreen from '../screens/BlockedPlayersScreen';
import ModerationQueueScreen from '../screens/ModerationQueueScreen';
import TournamentInvitePlayersScreen from '../screens/TournamentInvitePlayersScreen';
import MyWagersScreen from '../screens/MyWagersScreen';
import PlayerWagersScreen from '../screens/PlayerWagersScreen';
import FriendsScreen from '../screens/FriendsScreen';
import { COURT_DISCOVERY_ENABLED, FRIENDS_AT_COURTS_ENABLED, REFERRALS_ENABLED, ROUTINES_ENABLED, WAGERS_ENABLED } from '../lib/features';
import InviteLandingScreen from '../screens/InviteLandingScreen';
import ReferralHost from '../components/referrals/ReferralHost';
import { linking } from './linking';
import GuestJoinScreen from '../screens/GuestJoinScreen';
import BookmarksScreen from '../screens/BookmarksScreen';
import QrWalletScreen from '../screens/QrWalletScreen';
import QrPassScreen from '../screens/QrPassScreen';
import SubmitVenueScreen from '../screens/SubmitVenueScreen';
import AdminVenueReviewScreen from '../screens/AdminVenueReviewScreen';
import AdminBoundariesScreen from '../screens/AdminBoundariesScreen';
import AdminBoundaryEditorScreen from '../screens/AdminBoundaryEditorScreen';
import CourtsScreen from '../screens/CourtsScreen';
import CourtDetailScreen from '../screens/CourtDetailScreen';
import CourtRoutinesScreen from '../screens/CourtRoutinesScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

const MIN_MS = Platform.OS === 'web' ? 2200 : 1600;

// On web, constrain the app to a centered 720px column so screens don't
// stretch edge-to-edge on desktop. On native, this is a pass-through.
function WebMaxWidth({
  children,
  background,
}: {
  children: React.ReactNode;
  background: string;
}) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <View style={{ flex: 1, backgroundColor: background, alignItems: 'center' }}>
      <View style={{ flex: 1, width: '100%', maxWidth: 720 }}>
        {children}
      </View>
    </View>
  );
}

export default function AppNavigator() {
  const { colors, isDark } = useTheme();
  // Bounded startup session resolution: never gate the whole app on an
  // unbounded network call. `phase === 'error'` gets a retry screen instead of
  // the blank void this used to render.
  const { session, phase, retry } = useBootstrapSession(supabase);
  // Times in push bodies and drill start times use the player's zone
  // (supabase/migration_time_zones.sql). Checked against the stored zone on
  // sign-in and on every return to the foreground, so it heals after another
  // device or a UTC-reporting browser overwrote it.
  useTimeZoneSync(supabase, { prefix: 'pickleague', enabled: !!session, userId: session?.user.id });
  const [splashDone, setSplashDone] = useState(false);

  // Minimum-version gate. Starts false and only ever flips true, so startup is
  // never held on this read — the app renders normally while the check is in
  // flight, and swaps to the block screen only once the answer is a definite
  // yes. lib/minVersion fails open on every error path, so an offline or slow
  // read simply leaves this false forever, which is the outcome we want.
  const [updateRequired, setUpdateRequired] = useState(false);
  const nativeVersion = getNativeBuild().version;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const required = await isUpdateRequired();
      if (!cancelled && required) setUpdateRequired(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const navTheme = useMemo(() => {
    const base = isDark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: isDark,
      colors: {
        ...base.colors,
        primary:      colors.primary,
        background:   colors.bg,
        card:         colors.surface,
        text:         colors.text,
        border:       colors.border,
        notification: colors.danger,
      },
    };
  }, [colors, isDark]);

  useEffect(() => {
    // Session state itself is owned by useBootstrapSession; this subscription is
    // for side effects only. Analytics identity: INITIAL_SESSION settles the auth bootstrap (a
    // null session is a real anonymous visitor, recorded as such through the anon-role RLS);
    // SIGNED_IN mid-session claims the live anonymous session row (the QR-scan → signup join);
    // SIGNED_OUT drops the session so the next event starts a fresh anonymous one. Everything
    // resetSessionUser triggers is fire-and-forget — nothing awaits a supabase.auth call inside
    // this callback (deadlock).
    // Since foundation 1.17, SIGNED_OUT can re-fire every refresh tick (~30 s)
    // while offline, because the offline guard keeps the dead session on disk.
    // The sign-out side effects must run once per REAL sign-out: only when a
    // user was signed in before this event.
    let hadUser = false;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT') {
        if (!hadUser) return;
        hadUser = false;
        resetStreakShown();
        void clearCheckinForSignOut();
        void clearPlayForSignOut();
        // Stop watching courts, forget their state, arrivals and reminders,
        // and take down the notices naming them (the next account starts clean).
        void stopCourtGeofencesForSignOut();
        void clearCourtArrivalForSignOut();
        endSession();
        resetSessionUser(null);
        return;
      }
      hadUser = !!s?.user;
      resetSessionUser(s?.user ?? null);
    });
    // Warm the court-nickname cache so display helpers across screens have
    // data on first render.
    ensureCourtNicknamesLoaded();
    // Route taps on push notifications to the relevant screen (live + cold start),
    // and keep this device's push token bound to the signed-in user.
    const teardownTaps = setupNotificationTapHandling();
    // Track connectivity (feeds OfflineBanner + self-healing realtime channels).
    const stopNetworkMonitor = startNetworkMonitor();
    // Replay writes queued while offline (bookmarks, preferences, court
    // check-ins and play sessions — see lib/offlineWrites for which writes may
    // queue). Importing those modules is what registers the handlers, so this
    // must come after they are in the graph.
    const stopOfflineWrites = startOfflineWrites();
    return () => {
      subscription.unsubscribe();
      teardownTaps();
      stopNetworkMonitor();
      stopOfflineWrites();
    };
  }, []);

  // On sign-in: deliver any deep-link queued across the auth-stack swap (e.g. the
  // guest-join flow lands on the event vote) and enforce guest-pass expiry.
  // Push registration is owned by lib/push's auth-bound token lifecycle
  // (started in setupNotificationTapHandling), which re-runs on sign-in.
  useEffect(() => {
    if (!session) return;
    // Flush a pending guest-join destination once the logged-in stack mounts.
    flushPendingNavigation();
    (async () => {
      // Guest-pass expiry / revocation: sign out if this is a guest whose 7 days
      // have lapsed, or if the profile is gone entirely (the hourly cleanup
      // deletes expired anonymous users, leaving a stale token with no profile).
      // Only act on a definitive "no profile" (null data, no error) so a flaky
      // network read never signs out a legit user.
      const { data: prof, error: profErr } = await supabase
        .from('profiles')
        .select('is_guest, guest_expires_at')
        .eq('id', session.user.id)
        .maybeSingle();
      const expiredGuest = !!prof?.is_guest && !!prof.guest_expires_at
        && new Date(prof.guest_expires_at) < new Date();
      if (expiredGuest || (!profErr && !prof)) {
        // An expired guest still has a profile: end their court presence first,
        // under their session (3 s max, never throws).
        if (expiredGuest) await endPresenceForSignOut();
        // signOutSafely, not auth.signOut: the client now refuses session
        // removal while offline (so a captive portal can't log anyone out), and
        // a deliberate sign-out has to say so to get through that guard.
        await signOutSafely(supabase);
      }
    })();
  }, [session]);

  return (
    <ErrorBoundary>
    <ToastProvider>
      <TourProvider>
      {/* Hard stop: replaces the whole app, including the startup retry screen.
          A build too old to talk to the backend should not be offering to retry
          its way in. Nothing below this renders while it is true. */}
      {updateRequired && (
        <UpdateRequiredScreen
          title="Time to update"
          message="This version of Pickleague is too old to work with our servers. Grab the latest version and you will be right back where you left off. Nothing is lost."
          buttonLabel="Update on the App Store"
          // Android has no Play listing yet: copy only, no button that goes nowhere.
          storeUrl={Platform.OS === 'ios' ? APP_STORE_URL : undefined}
          footnote={nativeVersion ? `You have version ${nativeVersion}.` : undefined}
        />
      )}
      {!updateRequired && phase === 'error' && <StartupRetryScreen onRetry={retry} />}
      {!updateRequired && phase === 'ready' && (
        <WebMaxWidth background={colors.bg}>
          {/* Web-only; renders null on native and when nothing is pending. */}
          <ContinueInAppBanner />
          <NavigationContainer
            ref={navigationRef}
            theme={navTheme}
            linking={linking}
            fallback={<View />}
            onReady={() => {
              flushPendingNavigation();
              // First-party analytics: the landing screen (also records the session's
              // landing_route, campaign query included).
              trackScreen(navigationRef.getCurrentRoute()?.name);
            }}
            onStateChange={() => trackScreen(navigationRef.getCurrentRoute()?.name)}
          >
            <ErrorBoundary>
            <Stack.Navigator screenOptions={{ headerTitleStyle: { fontWeight: '700' } }}>
            {session ? (
              <>
                <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
                <Stack.Screen name="Play" component={PlayScreen} options={{ title: 'Play' }} />
                <Stack.Screen name="Leagues" component={LeaguesScreen} options={{ title: 'Leagues' }} />
                <Stack.Screen name="LeagueDetail" component={LeagueDetailScreen} options={({ route }) => ({ title: route.params.leagueName })} />
                <Stack.Screen name="LeagueMembers" component={LeagueMembersScreen} options={({ route }) => ({ title: route.params.leagueName + ' Members' })} />
                <Stack.Screen name="Invite" component={InviteScreen} options={{ title: 'Invite Players' }} />
                <Stack.Screen name="TournamentInvite" component={TournamentInviteScreen} options={({ route }) => ({ title: 'Invite to ' + route.params.tournamentName })} />
                <Stack.Screen name="Events" component={EventsScreen} options={({ route }) => ({ title: route.params.leagueName + ' Events' })} />
                <Stack.Screen name="CreateEvent" component={CreateEventScreen} options={{ title: 'New Event' }} />
                <Stack.Screen name="EventDetail" component={EventDetailScreen} options={({ route }) => ({ title: route.params.title })} />
                <Stack.Screen name="MatchEntry" component={MatchEntryScreen} options={{ title: 'Record Match' }} />
                <Stack.Screen name="MatchHistory" component={MatchHistoryScreen} options={({ route }) => ({ title: route.params.title })} />
                <Stack.Screen name="CalendarAnalytics" component={CalendarAnalyticsScreen} options={({ route }) => ({ title: route.params.title })} />
                <Stack.Screen name="SeasonStandings" component={SeasonStandingsScreen} options={({ route }) => ({ title: route.params.leagueName + ' Season' })} />
                <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
                <Stack.Screen name="UnlockProgress" component={UnlockProgressScreen} options={{ title: 'Unlock Progress' }} />
                <Stack.Screen name="PlayerProfile" component={PlayerProfileScreen} options={({ route }) => ({ title: route.params.userName })} />
                <Stack.Screen name="Claim" component={ClaimAccountScreen} options={{ title: 'Claim account' }} />
                <Stack.Screen name="HeadToHead" component={HeadToHeadScreen} options={({ route }) => ({ title: `You vs ${route.params.opponentName}` })} />
                <Stack.Screen name="Tournaments" component={TournamentsScreen} options={({ route }) => ({ title: route.params?.leagueName ? route.params.leagueName + ' Tournaments' : 'Tournaments' })} />
                <Stack.Screen name="CreateTournament" component={CreateTournamentScreen} options={{ title: 'New Tournament' }} />
                <Stack.Screen name="TournamentDetail" component={TournamentDetailScreen} options={({ route }) => ({ title: route.params.tournamentName })} />
                <Stack.Screen name="TournamentMembers" component={TournamentMembersScreen} options={({ route }) => ({ title: route.params.tournamentName + ' Members' })} />
                <Stack.Screen name="TournamentMatchHistory" component={TournamentMatchHistoryScreen} options={({ route }) => ({ title: route.params.title })} />
                <Stack.Screen name="TournamentInfo" component={TournamentInfoScreen} options={({ route }) => ({ title: 'How ' + route.params.tournamentName + ' works' })} />
                <Stack.Screen name="LeagueInfo" component={LeagueInfoScreen} options={({ route }) => ({ title: 'How ' + route.params.leagueName + ' works' })} />
                <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications' }} />
                <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
                <Stack.Screen name="UpgradeAccount" component={UpgradeAccountScreen} options={{ title: 'Save Your Account' }} />
                <Stack.Screen name="About" component={AboutScreen} options={{ title: 'About Pickleague' }} />
                <Stack.Screen name="Drill" component={DrillScreen} options={{ title: 'Drill Partners' }} />
                <Stack.Screen name="DrillSearch" component={DrillSearchScreen} options={{ title: 'Find Drillers' }} />
                <Stack.Screen name="DrillRequests" component={DrillRequestsScreen} options={{ title: 'Drill Requests' }} />
                <Stack.Screen name="Shop" component={ShopScreen} options={{ title: '🥒 Pickle Shop' }} />
                <Stack.Screen name="ScoringAlgo" component={ScoringAlgoScreen} options={{ title: 'Scoring Algo' }} />
                <Stack.Screen name="GiftPickles" component={GiftPicklesScreen} options={{ title: '🎁 Gift Pickles' }} />
                <Stack.Screen name="Godmode" component={GodmodeScreen} options={{ title: '🛠️ Godmode' }} />
                <Stack.Screen name="BlockedPlayers" component={BlockedPlayersScreen} options={{ title: 'Blocked Players' }} />
                <Stack.Screen name="ModerationQueue" component={ModerationQueueScreen} options={{ title: '🛡️ Reports' }} />
                <Stack.Screen name="TournamentInvitePlayers" component={TournamentInvitePlayersScreen} options={{ title: 'Invite Players' }} />
                {/* Wager screens stay unregistered while WAGERS_ENABLED is
                    false (lib/features.ts): their backend RPCs do not exist
                    in production, so nothing may route here. */}
                {WAGERS_ENABLED && (
                  <>
                    <Stack.Screen name="MyWagers" component={MyWagersScreen} options={{ title: '🎲 My Wagers' }} />
                    <Stack.Screen name="PlayerWagers" component={PlayerWagersScreen} options={{ title: 'Wagers' }} />
                  </>
                )}
                {/* Friends stays unregistered while FRIENDS_AT_COURTS_ENABLED is
                    false: its RPCs ship with the presence SQL. */}
                {FRIENDS_AT_COURTS_ENABLED && (
                  <Stack.Screen name="Friends" component={FriendsScreen} options={{ title: 'Friends' }} />
                )}
                {/* Reachable while signed in so a member tapping a guest link
                    resolves; the screen short-circuits to the event. */}
                <Stack.Screen name="GuestJoin" component={GuestJoinScreen} options={{ headerShown: false }} />
                {/* Referral invite landing: registered only while REFERRALS_ENABLED. */}
                {REFERRALS_ENABLED && (
                  <Stack.Screen name="InviteLanding" component={InviteLandingScreen} options={{ title: 'Invite' }} />
                )}
                <Stack.Screen name="Bookmarks" component={BookmarksScreen} options={{ title: '🔖 Bookmarks' }} />
                <Stack.Screen name="QrWallet" component={QrWalletScreen} options={{ title: '🎟️ QR Wallet' }} />
                <Stack.Screen name="QrPass" component={QrPassScreen} options={{ title: 'QR code' }} />
                <Stack.Screen name="SubmitVenue" component={SubmitVenueScreen} options={{ title: 'Add a Court' }} />
                <Stack.Screen name="AdminVenueReview" component={AdminVenueReviewScreen} options={{ title: '🛠️ Venue Review' }} />
                <Stack.Screen name="AdminBoundaries" component={AdminBoundariesScreen} options={{ title: '🛠️ Court Outlines' }} />
                <Stack.Screen name="AdminBoundaryEditor" component={AdminBoundaryEditorScreen} options={{ title: 'Court outline' }} />
                {/* Court discovery stays unregistered while COURT_DISCOVERY_ENABLED
                    is false: its RPCs ship with migration_court_discovery_p1.sql. */}
                {COURT_DISCOVERY_ENABLED && (
                  <>
                    {/* Discover, as in Doggle: the courts near you, list or map. */}
                    <Stack.Screen name="Courts" component={CourtsScreen} options={{ title: 'Discover' }} />
                    <Stack.Screen name="CourtDetail" component={CourtDetailScreen} options={{ title: 'Court' }} />
                  </>
                )}
                {/* Routines stay unregistered while ROUTINES_ENABLED is false:
                    their RPCs ship with migration_court_routines.sql. */}
                {ROUTINES_ENABLED && (
                  <Stack.Screen name="Routines" component={CourtRoutinesScreen} options={{ title: 'My routine' }} />
                )}
              </>
            ) : (
              <>
                <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
                <Stack.Screen name="Register" component={RegisterScreen} options={{ title: 'Create Account' }} />
                <Stack.Screen name="GuestJoin" component={GuestJoinScreen} options={{ title: 'Join the vote' }} />
                {REFERRALS_ENABLED && (
                  <Stack.Screen name="InviteLanding" component={InviteLandingScreen} options={{ headerShown: false }} />
                )}
              </>
            )}
            </Stack.Navigator>
            </ErrorBoundary>
          </NavigationContainer>
        </WebMaxWidth>
      )}
      {/* Spotlight onboarding tour overlay — renders above the navigator so it
          can dim/highlight any screen. No-op unless a tour is active. */}
      <SpotlightTour />
      </TourProvider>
      {/* Connectivity banner — renders null while online, so it can sit
          unconditionally next to the toast stack. */}
      <OfflineBanner />
      {/* Applies over-the-air updates on its own: checks behind the splash at
          launch and after 30+ min away (never mid-session). Null when there's
          nothing to apply, on web and in dev. */}
      <LaunchUpdateHost />
      {/* Court arrival: watched courts, stale "At X?" notices and the
          once-a-minute check-in prompt monitor (renders nothing). */}
      {!updateRequired && phase === 'ready' && <CourtArrivalHost userId={session?.user.id ?? null} />}
      {/* Referrals: stash a link's code, claim it after sign-in (renders nothing). */}
      {REFERRALS_ENABLED && !updateRequired && phase === 'ready' && <ReferralHost />}
      {/* Floating play-session island (renders null when no session runs). */}
      {!updateRequired && phase === 'ready' && <PlayIsland signedIn={!!session} />}
      {/* "Where are you playing?" (opened by openPlayStart; hidden otherwise). */}
      {!updateRequired && phase === 'ready' && <PlayStartSheetHost signedIn={!!session} />}
      {/* "Record a match or drill?" after End (hidden otherwise). */}
      {!updateRequired && phase === 'ready' && <PlayEndSheetHost signedIn={!!session} />}
      {/* Refusals the player wasn't looking at (a queued write refused later): a card
          that stays until OK. After the splash, so it never opens behind it. */}
      {!updateRequired && phase === 'ready' && splashDone && <RefusalNoticeHost />}
      {!splashDone && (
        <SplashScreen onDone={() => setSplashDone(true)} minMs={MIN_MS} />
      )}
    </ToastProvider>
    </ErrorBoundary>
  );
}
