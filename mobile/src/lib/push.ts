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
  wirePushResponseRouting,
} from '@just-messin-around/expo-foundation/platform';
import { supabase } from './supabase';
import { navigateWhenReady } from './navigationRef';
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
    if (!pendingUserId) throw new Error('push: no authenticated user');
    await supabase.from('push_tokens').upsert(
      {
        user_id: pendingUserId,
        token,
        platform,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
  },
  unregister: async (token) => {
    await supabase.from('push_tokens').delete().eq('token', token);
  },
  // MUST stay 'default': existing installs already have this channel, and
  // Android channel settings are immutable once created.
  registerOptions: { androidChannelId: 'default', androidChannelName: 'Default' },
});

/**
 * Requests notification permission, fetches the Expo push token, and upserts it
 * into public.push_tokens for the signed-in user. Returns the token, or null if
 * unavailable (web, simulator, permission denied, or no session).
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    // Signed in as someone else on this device (e.g. a sign-out that couldn't
    // run the RLS delete): forget the remembered token so the row is re-upserted
    // under the new user_id rather than skipped as "already registered".
    if (lastUserId && lastUserId !== user.id) await pushTokens.unregister();
    pendingUserId = user.id;
    const token = await pushTokens.register();
    lastUserId = token ? user.id : null;
    return token;
  } catch {
    return null;
  }
}

/**
 * Removes this device's push token so a signed-out (or switched) account stops
 * receiving pushes here. MUST be called while still authenticated — the RLS
 * delete policy requires auth.uid() = user_id.
 */
export async function unregisterPushTokenAsync(): Promise<void> {
  lastUserId = null;
  await pushTokens.unregister();
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
 * Wires up tap handling: live taps while the app runs, plus the cold-start case
 * where a tap launched the app. Returns an unsubscribe function. No-op on web.
 */
export function setupNotificationTapHandling(): () => void {
  return wirePushResponseRouting((data) => routeNotification(data as PushData));
}
