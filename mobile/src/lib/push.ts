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

import { AppState, Platform } from 'react-native';
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
import { navigationRef, navigateWhenReady } from './navigationRef';
import {
  catalog,
  handleNotificationAction,
  isAppAction,
  openWhenActiveLink,
  registerNotificationCategories,
} from './notificationActions';
import { linkForAction, linkOf, pushRoutes } from './pushLinks';
import { DISCOVER_ENABLED, FRIENDS_AT_COURTS_ENABLED, PLAY_NAV_ENABLED, WAGERS_ENABLED } from './features';
import { redeemLeagueInvite } from '../data/leagueInvites';
import { refreshMyOpenCheckin } from '../data/venueCheckins';
import { loadUserPreferencesResult } from './userPreferences';
import { ARRIVAL_CHECKIN_KIND, ARRIVAL_EXPIRED_KIND, showWhileAppActive } from './courtArrivalRules';
// Side effect: registers the check-in / play-session buttons' handlers and
// queued writes, so they exist wherever responses are wired. ./courtCheckin
// also has court arrival's Check in, Check in now and Not here, and the
// queued Exit / Not here replay (with ../data/courtArrival). ./courtArrival
// is the engine that posts those notices (index.ts loads it too, through
// ./courtGeofence, for the geofence task).
import { refreshCurrentCheckin } from './courtCheckin';
import './playSession';
import './friendActions';
import { RootStackParamList } from '../types';

// While Pickleague is open, court arrival's own notices stay quiet except
// "At X?" (it's the only way to say Not here before the check-in lands):
// "Check in nearby?", "Checked in", "Still at", "Leaving X?" and the expiry
// push, as in Doggle. The player is looking at the app, and the resync on
// opening makes the OS re-report every watched court, whose prompts would
// land now (lib/courtArrivalRules showWhileAppActive). That includes the
// prompts from the once-a-minute scan while the app is open, as in Doggle.
// Every other notification shows as before, and so does everything handled
// while the app is in the background.
configurePushNotificationHandler({
  showAlertWhenForeground: false,
  showWhenForeground: (n) =>
    AppState.currentState !== 'active' || showWhileAppActive(n.data),
});

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
    // Deferred: the kit's sync reads the session, and an auth call made from
    // inside this callback can deadlock supabase-js's auth lock.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const uid = session?.user?.id ?? null;
      setTimeout(() => fn(uid), 0);
    });
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

type PushData = Record<string, unknown> & {
  type?: string;
  entity_type?: string | null;
  entity_id?: string | null;
  title?: string;
  deepLink?: string;
  kind?: string;
  invite_code?: string;
};

const go = (name: string, params?: Record<string, unknown>) => {
  // Home is always the bottom of the stack (first screen + linking
  // initialRouteName). A plain navigate('Home') from another screen pushes a
  // second Home under routers 7.x, so pop back to the existing one instead.
  if (name === 'Home') {
    if (navigationRef.isReady()) navigationRef.navigate('Home', undefined, { pop: true });
    // Not ready = cold start: the navigator mounts on Home anyway.
    return;
  }
  navigateWhenReady(name as keyof RootStackParamList, params as never);
};

// The route table lives in lib/pushLinks.ts (pure, tested). Mirrors
// NotificationsScreen.handleTap, which routes through routeNotification too.
const router = createDeepLinkRouter(
  pushRoutes({
    wagersEnabled: WAGERS_ENABLED,
    friendsEnabled: FRIENDS_AT_COURTS_ENABLED,
    discoverEnabled: DISCOVER_ENABLED,
    checkinIsland: PLAY_NAV_ENABLED,
  }),
  go,
);

/** A league invite push: tapping it joins, the same auto-redeem as the in-app
 *  list. Anything short of a join opens Join-with-Code with the code filled in. */
async function openLeagueInvite(code: string): Promise<void> {
  try {
    const res = await redeemLeagueInvite(code);
    if (res.joined) {
      go('LeagueDetail', { leagueId: res.leagueId, leagueName: res.leagueName ?? 'League' });
      return;
    }
  } catch {
    // offline or timed out: the manual page can retry
  }
  // Join with code, filled in: Discover's Leagues tab (else the Leagues list).
  if (DISCOVER_ENABLED) go('Discover', { tab: 'leagues', prefillInviteCode: code });
  else go('Leagues', { prefillInviteCode: code });
}

/** Route an in-app link ("<prefix><id>"); false when nothing matches. */
export function routeLink(link: string): boolean {
  return router(link);
}

/**
 * Deep-links a tapped push. Uses the link send-push puts on the push, or builds
 * one from entity_type/entity_id (older pushes still in the shade). Anything
 * unknown opens the Notifications list. navigateWhenReady queues a cold-start
 * tap until the navigator mounts.
 */
export function routeNotification(data: PushData | undefined | null): void {
  if (!data) return;
  const link = linkOf(data);
  if (data.kind === 'league_invite' && typeof data.invite_code === 'string' && data.invite_code && link.startsWith('league/')) {
    void openLeagueInvite(data.invite_code);
    return;
  }
  const routed = link ? router(link) : false;
  if (!routed) navigateWhenReady('Notifications');
}

type ReceivedNotification = { request?: { content?: { data?: unknown } } };
type ReceivedListenerModule = {
  addNotificationReceivedListener(cb: (n: ReceivedNotification) => void): { remove(): void };
};

/**
 * Court arrival changed my open check-in on the server while the app is open
 * ("✅ Checked in at X", "👋 Checked out", or the phone's own "Checked in" for
 * a player the server can't push to): read it again, for the court card and
 * for "Leaving X?" later. Returns the unsubscribe; nothing on a build without
 * expo-notifications.
 */
function refreshOnArrivalPushes(): () => void {
  try {
    const N = require('expo-notifications') as ReceivedListenerModule;
    const sub = N.addNotificationReceivedListener((n) => {
      const data = n?.request?.content?.data as { kind?: unknown } | undefined;
      if (data?.kind !== ARRIVAL_CHECKIN_KIND && data?.kind !== ARRIVAL_EXPIRED_KIND) return;
      void refreshMyOpenCheckin();
      void refreshCurrentCheckin().catch(() => null);
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
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
    // Link buttons (Record result, Text group, Open chat, ...) navigate like a
    // tap and write nothing.
    linkFor: (r) => (catalog.isLinkAction(r.action) ? linkForAction(r.action, r.data) : null),
    onAction: async (r) => {
      // Pressed with Pickleague open (the shade pulled down over it): once
      // the write is done, open what it changed (Check in: Home's court
      // card). Its notice shows as a banner meanwhile.
      const open = AppState.currentState === 'active' ? openWhenActiveLink(r) : null;
      await handleNotificationAction(r);
      if (open) routeLink(open);
    },
    onTap: (data) => routeNotification(data as PushData),
    storageKey: 'pickleague_push_handled_v1',
  });
  const stopArrivalRefresh = refreshOnArrivalPushes();
  return () => {
    stopResponses();
    stopTokens();
    stopArrivalRefresh();
  };
}
