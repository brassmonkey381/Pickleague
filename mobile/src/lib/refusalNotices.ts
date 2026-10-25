// Showing refusals (the copy lives in ./refusals): the app-side half of rule
// 11, "every refusal says why and what to do".
//
//   - explainRefusal(e, fallback, ctx): the copy for an error a screen is
//     waiting on. A known refusal gets its own words; no signal / signed out
//     / not allowed get the kit's fixed copy, with the app's no-connection
//     line (no em dash); anything else gets the caller's fallback, never the
//     server's raw text.
//   - isRetryLater(e): no signal, or no signed-in session right now. Queued
//     writes keep these and send them again instead of dropping them.
//   - noteRefusalNotice(): a write the player is NOT looking at was refused
//     (an offline-queued check-in, check-out, Start or End replayed later, or
//     a sign-out that couldn't close a check-in). Kept until the player
//     dismisses it: a card that stays until OK the next time the app is open
//     (components/RefusalNoticeHost), or right away as a local notification
//     when the app is in the background AND notifications are allowed
//     (without permission the OS drops it silently, so it waits for the app
//     instead). Never dropped silently.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { isNetworkError } from '@just-messin-around/expo-foundation/platform';
import { postLocalNotice } from '@just-messin-around/expo-foundation/platform/push';
import { classifySbError, friendlySbMessage, type SbErrorKind } from '@just-messin-around/expo-foundation/supabase';
import { NO_CONNECTION, isServerRefusal, refusalCode, refusalMessage, type RefusalContext } from './refusals';

/**
 * The copy for an error the player is waiting on. `network` replaces the
 * no-connection line.
 *   1. A refusal this build knows (pl:<code>, or a known text: an older
 *      server's, a trigger's raised without a code, the app's own signed-out
 *      errors): its own words.
 *   2. A pl:* refusal this build has no code for yet (a newer server): the
 *      server's own message, which migration_refusal_messages.sql writes for people.
 *   3. No signal, signed out, not allowed: the kit's fixed plain copy
 *      (friendlySbMessage), with the app's no-connection line.
 *   4. Anything else (a function the server doesn't have yet, PGRST202
 *      "Could not find the function ... in the schema cache"; a constraint; a
 *      crash): the caller's `fallback`, never the server's or the runtime's raw text.
 */
export function explainRefusal(
  e: unknown,
  fallback: string,
  ctx: RefusalContext = {},
  opts: { network?: string } = {},
): string {
  const known = refusalMessage(e, ctx);
  if (known) return known;
  if (isServerRefusal(e)) return String((e as { message: string }).message).trim();
  return FRIENDLY_KINDS.has(classifySbError(e))
    ? friendlySbMessage(e, fallback, { network: opts.network ?? NO_CONNECTION })
    : fallback;
}

/** The kinds friendlySbMessage words itself, in fixed plain copy (no server text). */
const FRIENDLY_KINDS: ReadonlySet<SbErrorKind> = new Set<SbErrorKind>(['network', 'auth', 'permission']);

/** No signal, or no signed-in session right now: a queued write should wait, not be dropped. */
export function isRetryLater(e: unknown): boolean {
  return isNetworkError(e) || classifySbError(e) === 'auth' || refusalCode(e) === 'auth.signed_out';
}

export type RefusalNotice = {
  /** Dedupes: the same write refused twice is one notice. */
  key: string;
  title: string;
  body: string;
  /** Where a tap on the local notification goes (pushLinks), e.g. 'home/-'. */
  link?: string;
};

type Stored = RefusalNotice & { atMs: number; shown?: boolean };

const KEY = 'pickleague_refusal_notices_v1';
const KEEP_MS = 3 * 24 * 3600_000;

/** Emits when a new notice is stored (the host shows it). */
export const refusalNoticed = createSignal<void>();

/** A notice waiting for the player, as the host shows it. */
export type PendingNotice = RefusalNotice & { atMs: number };

async function read(): Promise<Stored[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v)
      ? (v as Stored[]).filter((n) => n && typeof n.key === 'string' && Date.now() - n.atMs < KEEP_MS)
      : [];
  } catch {
    return [];
  }
}

async function write(list: Stored[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(list)).catch(() => {});
}

/** Notification permission is granted (native). Never throws: unknown reads as no. */
async function notificationsAllowed(): Promise<boolean> {
  try {
    const N = await import('expo-notifications');
    return (await N.getPermissionsAsync()).granted === true;
  } catch {
    return false;
  }
}

/**
 * Keep a notice until the player has dismissed it. In the background (native)
 * with notifications allowed, it goes out now as a local notification (and
 * counts as seen). Otherwise it waits for the host, which shows it the next
 * time the app is open.
 */
export async function noteRefusalNotice(n: RefusalNotice): Promise<void> {
  const background = Platform.OS !== 'web' && AppState.currentState !== 'active';
  // postLocalNotice never throws and posts nothing the OS will show without
  // permission, so only a permitted one may stand in for the in-app notice.
  const posted = background && (await notificationsAllowed());
  const list = (await read()).filter((x) => x.key !== n.key);
  await write([...list, { ...n, atMs: Date.now(), shown: posted }]);
  if (posted) {
    await postLocalNotice(n.title, n.body, n.link ? { data: { deepLink: n.link } } : undefined);
    return;
  }
  refusalNoticed.emit();
}

/** The notices the player hasn't dismissed yet, oldest first (nothing is marked). */
export async function peekRefusalNotices(): Promise<PendingNotice[]> {
  return (await read())
    .filter((n) => !n.shown)
    .map(({ key, title, body, link, atMs }) => ({ key, title, body, link, atMs }));
}

/** The player dismissed this notice. A newer one stored under the same key since stays. */
export async function markRefusalNoticeShown(key: string, atMs: number): Promise<void> {
  const list = await read();
  await write(list.map((n) => (n.key === key && n.atMs <= atMs ? { ...n, shown: true } : n)));
}
