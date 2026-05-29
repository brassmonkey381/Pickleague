import React, { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme, LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import SplashScreen from '../components/SplashScreen';
import { useTheme } from '../lib/ThemeContext';
import { TourProvider } from '../lib/TourContext';
import SpotlightTour from '../components/SpotlightTour';
import ToastProvider from '../lib/ToastProvider';
import { resetStreakShown } from '../lib/loginStreak';
import { ensureCourtNicknamesLoaded } from '../lib/courtNickname';

import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import HomeScreen from '../screens/HomeScreen';
import LeaguesScreen from '../screens/LeaguesScreen';
import LeagueDetailScreen from '../screens/LeagueDetailScreen';
import EventsScreen from '../screens/EventsScreen';
import CreateEventScreen from '../screens/CreateEventScreen';
import EventDetailScreen from '../screens/EventDetailScreen';
import LeagueMembersScreen from '../screens/LeagueMembersScreen';
import PlayerProfileScreen from '../screens/PlayerProfileScreen';
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
import AboutScreen from '../screens/AboutScreen';
import DrillScreen from '../screens/DrillScreen';
import DrillSearchScreen from '../screens/DrillSearchScreen';
import DrillRequestsScreen from '../screens/DrillRequestsScreen';
import ShopScreen from '../screens/ShopScreen';
import ScoringAlgoScreen from '../screens/ScoringAlgoScreen';
import GiftPicklesScreen from '../screens/GiftPicklesScreen';
import GodmodeScreen from '../screens/GodmodeScreen';
import TournamentInvitePlayersScreen from '../screens/TournamentInvitePlayersScreen';
import MyWagersScreen from '../screens/MyWagersScreen';

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

const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['https://pickleague.club', 'pickleague://'],
  config: {
    screens: {
      Login: 'login',
      Register: 'register',
      Home: '',
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
      MyWagers: 'wagers',
    },
  },
};

export default function AppNavigator() {
  const { colors, isDark } = useTheme();
  const [session, setSession]     = useState<Session | null>(null);
  const [loading, setLoading]     = useState(true);
  const [splashDone, setSplashDone] = useState(false);

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
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (event === 'SIGNED_OUT') resetStreakShown();
    });
    // Warm the court-nickname cache so display helpers across screens have
    // data on first render.
    ensureCourtNicknamesLoaded();
    return () => subscription.unsubscribe();
  }, []);

  return (
    <ToastProvider>
      <TourProvider>
      {!loading && (
        <WebMaxWidth background={colors.bg}>
          <NavigationContainer theme={navTheme} linking={linking} fallback={<View />}>
            <Stack.Navigator screenOptions={{ headerTitleStyle: { fontWeight: '700' } }}>
            {session ? (
              <>
                <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
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
                <Stack.Screen name="Tournaments" component={TournamentsScreen} options={({ route }) => ({ title: route.params?.leagueName ? route.params.leagueName + ' Tournaments' : 'Tournaments' })} />
                <Stack.Screen name="CreateTournament" component={CreateTournamentScreen} options={{ title: 'New Tournament' }} />
                <Stack.Screen name="TournamentDetail" component={TournamentDetailScreen} options={({ route }) => ({ title: route.params.tournamentName })} />
                <Stack.Screen name="TournamentMembers" component={TournamentMembersScreen} options={({ route }) => ({ title: route.params.tournamentName + ' Members' })} />
                <Stack.Screen name="TournamentMatchHistory" component={TournamentMatchHistoryScreen} options={({ route }) => ({ title: route.params.title })} />
                <Stack.Screen name="TournamentInfo" component={TournamentInfoScreen} options={({ route }) => ({ title: 'How ' + route.params.tournamentName + ' works' })} />
                <Stack.Screen name="LeagueInfo" component={LeagueInfoScreen} options={({ route }) => ({ title: 'How ' + route.params.leagueName + ' works' })} />
                <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications' }} />
                <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
                <Stack.Screen name="About" component={AboutScreen} options={{ title: 'About Pickleague' }} />
                <Stack.Screen name="Drill" component={DrillScreen} options={{ title: 'Drill Partners' }} />
                <Stack.Screen name="DrillSearch" component={DrillSearchScreen} options={{ title: 'Find Drillers' }} />
                <Stack.Screen name="DrillRequests" component={DrillRequestsScreen} options={{ title: 'Drill Requests' }} />
                <Stack.Screen name="Shop" component={ShopScreen} options={{ title: '🥒 Pickle Shop' }} />
                <Stack.Screen name="ScoringAlgo" component={ScoringAlgoScreen} options={{ title: 'Scoring Algo' }} />
                <Stack.Screen name="GiftPickles" component={GiftPicklesScreen} options={{ title: '🎁 Gift Pickles' }} />
                <Stack.Screen name="Godmode" component={GodmodeScreen} options={{ title: '🛠️ Godmode' }} />
                <Stack.Screen name="TournamentInvitePlayers" component={TournamentInvitePlayersScreen} options={{ title: 'Invite Players' }} />
                <Stack.Screen name="MyWagers" component={MyWagersScreen} options={{ title: '🎲 My Wagers' }} />
              </>
            ) : (
              <>
                <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
                <Stack.Screen name="Register" component={RegisterScreen} options={{ title: 'Create Account' }} />
              </>
            )}
            </Stack.Navigator>
          </NavigationContainer>
        </WebMaxWidth>
      )}
      {/* Spotlight onboarding tour overlay — renders above the navigator so it
          can dim/highlight any screen. No-op unless a tour is active. */}
      <SpotlightTour />
      </TourProvider>
      {!splashDone && (
        <SplashScreen onDone={() => setSplashDone(true)} minMs={MIN_MS} />
      )}
    </ToastProvider>
  );
}
