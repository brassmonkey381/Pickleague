// Push-notification client: token registration + tap routing.
//
// The mechanics (permission prompt, Expo token fetch, Android channel, tap
// listeners, cold-start replay) now live in
// @just-messin-around/expo-foundation/platform. This module composes those
// helpers with the Pickleague-specific halves that stay local:
//   - the push_tokens upsert/delete (Supabase + RLS)
//   - resolvePushTarget(): entity_type → concrete screen + typed params
// so consumers (`import { ... } from '../lib/push'`) are unchanged.
//
// Web is a no-op (Expo push tokens are native-only).

import { Platform } from 'react-native';
import {
  configurePushNotificationHandler,
  createPushTokenLifecycle,
  withRetry,
} from '@just-messin-around/expo-foundation/platform';
import { sbCall, currentUserId, classifySbError } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { navigateWhenReady } from './navigationRef';
import {
  handleNotificationAction,
  registerNotificationCategories,
  type ActionPushData,
} from './notificationActions';
import { RootStackParamList } from '../types';

// Show notifications while the app is foregrounded too (otherwise native only
// surfaces them when backgrounded). Module-level, as before — the kit just makes
// the setNotificationHandler call explicit instead of an import side effect.
configurePushNotificationHandler({ showAlertWhenForeground: true });

// The user the in-flight registration belongs to. Resolved by the exported
// wrapper below (which owns the "must be signed in" rule) and read by the
// lifecycle's register callback.
let pendingUserId: string | null = null;
// The user whose token is currently persisted, so an account switch on this
// device re-points the row instead of being deduped away by the lifecycle.
let lastUserId: string | null = null;

const pushTokens = createPushTokenLifecycle({
  register: async (token, platform) => {
    // Throwing (rather than returning) keeps the kit from remembering a token it
    // never actually persisted, so a later attempt isn't deduped into a no-op.
    // supabase-js RETURNS API/RLS/HTTP failures instead of throwing them, so a
    // bare `await ...upsert()` here reported success for a token that never
    // reached the table — the lifecycle then deduped every later attempt this
    // session and the device silently received nothing while Settings showed
    // the toggle on. sbCall throws (and retries transient network faults).
    if (!pendingUserId) throw new Error('push: no authenticated user');
    const userId = pendingUserId;
    await sbCall(() =>
      supabase.from('push_tokens').upsert(
        {
          user_id: userId,
          token,
          platform,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'token' },
      ),
      // One inner retry only — ensurePushRegistration retries the whole attempt
      // on top of this, and the two multiplying would hammer the API.
      { retries: 1 },
    );
  },
  unregister: async (token) => {
    // Bounded hard: this runs on the sign-out path, where a slow network must
    // not hold the user on a screen they're leaving.
    await sbCall(() => supabase.from('push_tokens').delete().eq('token', token), {
      retries: 1,
      timeoutMs: 5_000,
    });
  },
  // MUST stay 'default': existing installs already have this channel, and
  // Android channel settings are immutable once created.
  registerOptions: { androidChannelId: 'default', androidChannelName: 'Default' },
});

/**
 * Why registration didn't produce a token. `unavailable` means push can't work
 * here at all (web, simulator, OS permission denied, or no session) — the user
 * has to change something. `failed` means we couldn't complete the round trip
 * (offline, timeout, RLS/API error); the same attempt may well succeed later,
 * so callers must NOT tell the user to go fix a permission.
 */
export type PushRegistrationOutcome =
  | { status: 'registered'; token: string }
  | { status: 'unavailable' }
  | { status: 'failed'; error: unknown };

async function attemptRegistration(): Promise<PushRegistrationOutcome> {
  if (Platform.OS === 'web') return { status: 'unavailable' };
  // LOCAL session read — getUser() is a network round trip, so on flaky WiFi it
  // returned no user and startup registration gave up as if signed out.
  const userId = await currentUserId(supabase);
  if (!userId) return { status: 'unavailable' };
  try {
    // Signed in as someone else on this device (e.g. a sign-out that couldn't
    // run the RLS delete): forget the remembered token so the row is re-upserted
    // under the new user_id rather than skipped as "already registered".
    if (lastUserId && lastUserId !== userId) {
      // A failed cleanup of the OLD row must not block registering the new one.
      await pushTokens.unregister().catch(() => {});
    }
    pendingUserId = userId;
    const token = await pushTokens.register();
    // The kit returns null only for "push can't work here" (no device, no
    // permission, no token); every failure path throws.
    if (!token) {
      lastUserId = null;
      return { status: 'unavailable' };
    }
    lastUserId = userId;
    return { status: 'registered', token };
  } catch (error) {
    lastUserId = null;
    return { status: 'failed', error };
  }
}

/** Transient enough to be worth another attempt (vs. a rejection that will keep rejecting). */
function isRetryableRegistrationError(e: unknown): boolean {
  const kind = classifySbError(e);
  return kind === 'network' || kind === 'server' || kind === 'unknown';
}

/**
 * Register this device, retrying transient failures. `waitForReconnectMs` lets
 * a launch that begins offline wait for the connection instead of burning the
 * only attempt of the session.
 */
async function ensurePushRegistration(
  opts: { retries: number; waitForReconnectMs?: number },
): Promise<PushRegistrationOutcome> {
  try {
    return await withRetry(
      async () => {
        const outcome = await attemptRegistration();
        // Only `failed` is worth another pass; throwing is how withRetry sees it.
        if (outcome.status === 'failed') throw outcome.error;
        return outcome;
      },
      {
        retries: opts.retries,
        waitForReconnectMs: opts.waitForReconnectMs,
        retryOn: isRetryableRegistrationError,
        // attemptRegistration already bounds its own network calls; an outer
        // timeout here would cut off a legitimately slow OS permission prompt.
        timeoutMs: null,
      },
    );
  } catch (error) {
    return { status: 'failed', error };
  }
}

/**
 * Requests notification permission, fetches the Expo push token, and upserts it
 * into public.push_tokens for the signed-in user. Returns the token, or null if
 * it couldn't be registered.
 *
 * Startup shape: this is fire-and-forget and runs once per session, so a single
 * bad moment at launch used to cost the whole session's pushes. It now retries,
 * and waits out a launch that begins with no connection.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  const outcome = await ensurePushRegistration({ retries: 3, waitForReconnectMs: 20_000 });
  return outcome.status === 'registered' ? outcome.token : null;
}

/**
 * Interactive variant for the Settings toggle: same registration, but the
 * caller learns WHY it didn't work so it can tell "your OS denied this" apart
 * from "we couldn't reach the server" — telling a user to fix a permission that
 * was granted is worse than saying nothing.
 */
export async function enablePushNotifications(): Promise<PushRegistrationOutcome> {
  return ensurePushRegistration({ retries: 2 });
}

/**
 * Removes this device's push token so a signed-out (or switched) account stops
 * receiving pushes here. MUST be called while still authenticated — the RLS
 * delete policy requires auth.uid() = user_id.
 *
 * Never throws: this runs immediately before sign-out, and a stale token row is
 * a far smaller problem than a sign-out that appears to hang or fail.
 */
export async function unregisterPushTokenAsync(): Promise<void> {
  lastUserId = null;
  try {
    await pushTokens.unregister();
  } catch {
    // Swallowed deliberately — see above.
  }
}

type PushData = {
  type?: string;
  entity_type?: string | null;
  entity_id?: string | null;
  title?: string;
};

// Resolve a tapped push to a concrete screen target. Mirrors the entity_type
// routing in NotificationsScreen.handleTap (minus invite auto-accept, which
// stays on the in-app notification list). Returns null when there's nothing to
// open (e.g. a tournament/league push with no entity_id).
function resolvePushTarget(
  data: PushData,
): { name: keyof RootStackParamList; params?: object } | null {
  const { entity_type, entity_id, title } = data;
  switch (entity_type) {
    case 'tournament':
      return entity_id
        ? { name: 'TournamentDetail', params: { tournamentId: entity_id, tournamentName: (title ?? '').replace('🏆 ', '') || 'Tournament' } }
        : null;
    case 'league':
      return entity_id
        ? { name: 'LeagueDetail', params: { leagueId: entity_id, leagueName: title ?? 'League' } }
        : null;
    case 'event':
      return entity_id
        ? { name: 'EventDetail', params: { eventId: entity_id, title: title ?? 'Event' } }
        : null;
    case 'match':
      return { name: 'MatchHistory', params: { title: 'Match History', initialMyMatchesOnly: true, highlightMatchId: entity_id ?? undefined } };
    case 'drill':
      return { name: 'DrillRequests' };
    case 'shop':
      return { name: 'Shop' };
    case 'profile':
      return { name: 'Profile', params: { userId: entity_id ?? undefined } };
    case 'plupr_history':
      return { name: 'CalendarAnalytics', params: { userId: entity_id ?? undefined, title: 'My PLUPR History' } };
    case 'wager_on_me':
      return entity_id ? { name: 'PlayerWagers', params: { userId: entity_id, userName: 'You' } } : { name: 'MyWagers' };
    case 'wager':
      return { name: 'MyWagers' };
    default:
      return { name: 'Notifications' };
  }
}

/**
 * Deep-links a tapped push to the relevant screen. Uses the shared
 * navigateWhenReady queue so a cold-start tap (navigator not yet mounted) is
 * delivered once it is.
 */
export function routeNotification(data: PushData | undefined | null): void {
  if (!data) return;
  const target = resolvePushTarget(data);
  if (target) navigateWhenReady(target.name, target.params);
}

/**
 * Wires up notification responses: action-button presses, plain taps while the
 * app runs, and the cold-start case where a tap launched the app. Returns an
 * unsubscribe function. No-op on web.
 *
 * Why this uses expo-notifications directly instead of the foundation's
 * `wirePushResponseRouting`: that helper hands the callback only
 * `notification.request.content.data` and drops `response.actionIdentifier`,
 * which is precisely the field that distinguishes "pressed Can't make it" from
 * "tapped the notification". Both cannot be wired at once either — two
 * listeners would each fire, so pressing a button would ALSO deep-link, which
 * is the one behaviour action buttons exist to avoid.
 *
 * The right long-term home for exposing actionIdentifier is the foundation
 * (per the foundation-first rule in CLAUDE.md), and it should be hoisted there
 * when the 1.15.1 -> 1.27.x bump happens. Doing it now would drag twelve minor
 * versions of unrelated change into an over-the-air update, which is a bad
 * trade for one extra field.
 */
export function setupNotificationTapHandling(): () => void {
  if (Platform.OS === 'web') return () => {};

  let Notifications: typeof import('expo-notifications');
  try {
    Notifications = require('expo-notifications');
  } catch {
    return () => {};
  }

  // Categories must be registered before a push arrives, or it renders with no
  // buttons and no error. Fire-and-forget at startup.
  void registerNotificationCategories();

  const handle = (response: {
    actionIdentifier: string;
    notification: { request: { content: { data: unknown } } };
  }) => {
    const data = (response.notification.request.content.data ?? {}) as PushData & ActionPushData;
    void (async () => {
      // An action press must never also navigate — handled returns true so the
      // deep link is skipped.
      const handled = await handleNotificationAction(response.actionIdentifier, data);
      if (!handled) routeNotification(data);
    })();
  };

  const sub = Notifications.addNotificationResponseReceivedListener(handle);

  // Cold start: a tap (or a button press) launched the app.
  Notifications.getLastNotificationResponseAsync()
    .then((response) => { if (response) handle(response); })
    .catch(() => {});

  return () => sub.remove();
}
