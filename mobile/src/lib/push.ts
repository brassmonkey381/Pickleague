// Push-notification client: token registration + response routing, composed
// from the foundation push kit (@just-messin-around/expo-foundation/platform/push):
//   - createAuthBoundPushTokens keeps this device's token bound to whoever is
//     signed in (registers on sign-in, re-points on an account switch,
//     unregisters before sign-out, bounded at 3 s)
//   - wireNotificationResponses sends a button press to the action handlers and
//     a plain tap to the router, never both, and runs each response once
//   - createDeepLinkRouter maps "<entity_type>/<id>" links to screens
// The Pickleague halves stay here: the push_tokens table, the routes, and the
// push preference gate.
//
// Web is a no-op (Expo push tokens are native-only).

import { Platform } from 'react-native';
import {
  configurePushNotificationHandler,
  createAuthBoundPushTokens,
  createDeepLinkRouter,
  registerForPushNotificationsAsync as requestPushToken,
  wireNotificationResponses,
} from '@just-messin-around/expo-foundation/platform/push';
import { withRetry } from '@just-messin-around/expo-foundation/platform';
import { sbCall, currentUserId, classifySbError } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { navigateWhenReady } from './navigationRef';
import { handleNotificationAction, isAppAction, registerNotificationCategories } from './notificationActions';
import { loadUserPreferencesResult } from './userPreferences';
import { RootStackParamList } from '../types';

// Show notifications while the app is foregrounded too.
configurePushNotificationHandler({ showAlertWhenForeground: true });

// MUST stay 'default': existing installs already have this channel, and
// Android channel settings are immutable once created.
const REGISTRATION = { androidChannelId: 'default', androidChannelName: 'Default' } as const;

/**
 * Persist a token for the signed-in user. Throws on any failure: supabase-js
 * RETURNS API/RLS errors instead of throwing, and a bare upsert once reported
 * success for a token that never reached the table, so the device silently got
 * nothing while Settings showed push on. sbCall throws (and retries once).
 */
async function upsertToken(token: string, platform: 'ios' | 'android'): Promise<void> {
  const userId = await currentUserId(supabase);
  if (!userId) throw new Error('push: no authenticated user');
  await sbCall(
    () =>
      supabase.from('push_tokens').upsert(
        { user_id: userId, token, platform, updated_at: new Date().toISOString() },
        { onConflict: 'token' },
      ),
    { retries: 1 },
  );
}

export const pushTokens = createAuthBoundPushTokens({
  // LOCAL session read, never getUser().
  getSessionUserId: () => currentUserId(supabase),
  onAuthChange: (fn) => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => fn(session?.user?.id ?? null));
    return () => data.subscription.unsubscribe();
  },
  // Push is opt-in. Only register on a prefs read we trust: a failed read used
  // to fall back to pushEnabled:false and quietly cost a whole session's pushes,
  // so a failed read now just skips (the existing token row keeps working).
  shouldRegister: async () => {
    const prefs = await loadUserPreferencesResult();
    return prefs.status === 'ok' && prefs.prefs.pushEnabled === true;
  },
  register: upsertToken,
  // Runs on the sign-out path while the session is still valid (RLS delete
  // needs auth.uid() = user_id); the kit bounds it at 3 s and swallows errors.
  unregister: async (token) => {
    await sbCall(() => supabase.from('push_tokens').delete().eq('token', token), { retries: 0, timeoutMs: 3_000 });
  },
  registrationOptions: REGISTRATION,
});

/**
 * Why registration didn't produce a token. `unavailable` means push can't work
 * here at all (web, simulator, OS permission denied, or no session) — the user
 * has to change something. `failed` means we couldn't complete the round trip
 * (offline, timeout, RLS/API error); callers must NOT tell the user to go fix
 * a permission.
 */
export type PushRegistrationOutcome =
  | { status: 'registered'; token: string }
  | { status: 'unavailable' }
  | { status: 'failed'; error: unknown };

function isRetryable(e: unknown): boolean {
  const kind = classifySbError(e);
  return kind === 'network' || kind === 'server' || kind === 'unknown';
}

/**
 * Settings toggle: prompt for permission, persist the token, and say WHY it
 * didn't work so "your OS denied this" and "we couldn't reach the server" get
 * different copy.
 */
export async function enablePushNotifications(): Promise<PushRegistrationOutcome> {
  if (Platform.OS === 'web') return { status: 'unavailable' };
  if (!(await currentUserId(supabase))) return { status: 'unavailable' };
  let reg: Awaited<ReturnType<typeof requestPushToken>>;
  try {
    reg = await requestPushToken(REGISTRATION);
  } catch (error) {
    return { status: 'failed', error };
  }
  if (!reg) return { status: 'unavailable' };
  const { expoPushToken, platform } = reg;
  try {
    await withRetry(() => upsertToken(expoPushToken, platform), { retries: 2, retryOn: isRetryable, timeoutMs: null });
  } catch (error) {
    return { status: 'failed', error };
  }
  // Let the auth-bound lifecycle learn the token, so sign-out unregisters it.
  void pushTokens.sync();
  return { status: 'registered', token: expoPushToken };
}

/** Before sign-out, while still authenticated. Bounded (3 s), never throws. */
export async function unregisterPushTokenAsync(): Promise<void> {
  await pushTokens.beforeSignOut();
}

type PushData = {
  type?: string;
  entity_type?: string | null;
  entity_id?: string | null;
  title?: string;
  deepLink?: string;
};

type Route = [string, Record<string, unknown>?];
const NO_ID = '-';
const has = (id: string) => (id && id !== NO_ID ? id : undefined);

// "<entity_type>/<entity_id or ->". Mirrors NotificationsScreen.handleTap
// (minus invite auto-accept, which stays on the in-app list).
function routesFor(title: string | undefined): Record<string, (id: string) => Route | null> {
  return {
    'tournament/': (id) =>
      has(id) ? ['TournamentDetail', { tournamentId: id, tournamentName: (title ?? '').replace('🏆 ', '') || 'Tournament' }] : null,
    'league/': (id) => (has(id) ? ['LeagueDetail', { leagueId: id, leagueName: title ?? 'League' }] : null),
    'event/': (id) => (has(id) ? ['EventDetail', { eventId: id, title: title ?? 'Event' }] : null),
    'match/': (id) => ['MatchHistory', { title: 'Match History', initialMyMatchesOnly: true, highlightMatchId: has(id) }],
    'drill/': () => ['DrillRequests'],
    'shop/': () => ['Shop'],
    'profile/': (id) => ['Profile', { userId: has(id) }],
    'plupr_history/': (id) => ['CalendarAnalytics', { userId: has(id), title: 'My PLUPR History' }],
    'wager_on_me/': (id) => (has(id) ? ['PlayerWagers', { userId: id, userName: 'You' }] : ['MyWagers']),
    'wager/': () => ['MyWagers'],
  };
}

/**
 * Deep-links a tapped push. Uses the link send-push puts on the push, or builds
 * one from entity_type/entity_id (older pushes still in the shade). Anything
 * unknown opens the Notifications list. navigateWhenReady queues a cold-start
 * tap until the navigator mounts.
 */
export function routeNotification(data: PushData | undefined | null): void {
  if (!data) return;
  const link =
    typeof data.deepLink === 'string' && data.deepLink
      ? data.deepLink
      : data.entity_type
        ? `${data.entity_type}/${data.entity_id || NO_ID}`
        : '';
  const go = (name: string, params?: Record<string, unknown>) =>
    navigateWhenReady(name as keyof RootStackParamList, params as never);
  const routed = link ? createDeepLinkRouter(routesFor(data.title), go)(link) : false;
  if (!routed) navigateWhenReady('Notifications');
}

/**
 * Wires up notification responses: button presses, plain taps while the app
 * runs, and the cold-start tap that launched it. Returns an unsubscribe. A
 * no-op on web. Also starts the auth-bound token lifecycle.
 */
export function setupNotificationTapHandling(): () => void {
  if (Platform.OS === 'web') return () => {};
  // Categories must be registered before a push arrives, or it renders with no
  // buttons and no error.
  void registerNotificationCategories();
  const stopTokens = pushTokens.start();
  const stopResponses = wireNotificationResponses({
    isAction: isAppAction,
    onAction: handleNotificationAction,
    onTap: (data) => routeNotification(data as PushData),
    storageKey: 'pickleague_push_handled_v1',
  });
  return () => {
    stopResponses();
    stopTokens();
  };
}
