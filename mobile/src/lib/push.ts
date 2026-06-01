// Push-notification client: token registration + tap routing.
//
// The server side (DB trigger → send-push Edge Function) mirrors every in-app
// notification to a phone push. This module handles the device half:
//   - registerForPushNotificationsAsync(): permission → Expo token → DB upsert
//   - foreground display handler
//   - routeNotification(data): deep-link a tapped push to the right screen,
//     mirroring handleTap() in NotificationsScreen.
//
// Web is a no-op (Expo push tokens are native-only).

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabase';
import { navigationRef } from './navigationRef';

// Show notifications while the app is foregrounded too (otherwise native only
// surfaces them when backgrounded).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function getProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId
  );
}

/**
 * Requests notification permission, fetches the Expo push token, and upserts it
 * into public.push_tokens for the signed-in user. Returns the token, or null if
 * unavailable (web, simulator, permission denied, or no session).
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  // Push tokens require physical hardware; simulators/emulators can't get them.
  if (!Device.isDevice) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return null;

  let token: string;
  try {
    const projectId = getProjectId();
    const resp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    token = resp.data;
  } catch {
    return null;
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  await supabase.from('push_tokens').upsert(
    {
      user_id: user.id,
      token,
      platform: Platform.OS,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'token' },
  );
  lastRegisteredToken = token;
  return token;
}

// Remembered so we can delete exactly this device's row on sign-out.
let lastRegisteredToken: string | null = null;

/**
 * Removes this device's push token so a signed-out (or switched) account stops
 * receiving pushes here. MUST be called while still authenticated — the RLS
 * delete policy requires auth.uid() = user_id.
 */
export async function unregisterPushTokenAsync(): Promise<void> {
  if (!lastRegisteredToken) return;
  const token = lastRegisteredToken;
  lastRegisteredToken = null;
  await supabase.from('push_tokens').delete().eq('token', token);
}

type PushData = {
  type?: string;
  entity_type?: string | null;
  entity_id?: string | null;
  title?: string;
};

// A cold-start tap can resolve before <NavigationContainer> mounts (it's gated
// behind the auth-loading splash), so navigationRef isn't ready yet. We stash
// the route and flush it from NavigationContainer's onReady.
let pendingRoute: PushData | null = null;

/** Called from NavigationContainer onReady to deliver any queued cold-start tap. */
export function flushPendingNotificationRoute(): void {
  if (pendingRoute) {
    const data = pendingRoute;
    pendingRoute = null;
    routeNotification(data);
  }
}

/**
 * Deep-links a tapped push to the relevant screen. Mirrors the entity_type
 * routing in NotificationsScreen.handleTap (minus invite auto-accept, which
 * stays on the in-app notification list).
 */
export function routeNotification(data: PushData | undefined | null): void {
  if (!data) return;
  if (!navigationRef.isReady()) {
    // Nav not mounted yet (cold start) — queue and flush on onReady.
    pendingRoute = data;
    return;
  }
  const { entity_type, entity_id, title } = data;

  switch (entity_type) {
    case 'tournament':
      if (entity_id) {
        navigationRef.navigate('TournamentDetail', {
          tournamentId: entity_id,
          tournamentName: (title ?? '').replace('🏆 ', '') || 'Tournament',
        });
      }
      break;
    case 'league':
      if (entity_id) {
        navigationRef.navigate('LeagueDetail', {
          leagueId: entity_id,
          leagueName: title ?? 'League',
        });
      }
      break;
    case 'match':
      navigationRef.navigate('MatchHistory', {
        title: 'Match History',
        initialMyMatchesOnly: true,
        highlightMatchId: entity_id ?? undefined,
      });
      break;
    case 'drill':
      navigationRef.navigate('DrillRequests');
      break;
    case 'shop':
      navigationRef.navigate('Shop');
      break;
    case 'profile':
      navigationRef.navigate('Profile', { userId: entity_id ?? undefined });
      break;
    case 'plupr_history':
      navigationRef.navigate('CalendarAnalytics', {
        userId: entity_id ?? undefined,
        title: 'My PLUPR History',
      });
      break;
    default:
      navigationRef.navigate('Notifications');
  }
}

/**
 * Wires up tap handling: live taps while the app runs, plus the cold-start case
 * where a tap launched the app. Returns an unsubscribe function.
 */
export function setupNotificationTapHandling(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    routeNotification(response.notification.request.content.data as PushData);
  });

  // Cold start: app was launched by tapping a push.
  Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) {
      routeNotification(response.notification.request.content.data as PushData);
    }
  });

  return () => sub.remove();
}
