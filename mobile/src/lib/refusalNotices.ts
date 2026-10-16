// Showing refusals (the copy lives in ./refusals): the app-side half of rule
// 11, "every refusal says why and what to do".
//
//   - explainRefusal(e, fallback, ctx): the copy for an error a screen is
//     waiting on. A known refusal gets its own words; anything else gets the
//     kit's friendly text, with the app's no-connection line (no em dash).
//   - isRetryLater(e): no signal, or no signed-in session right now. Queued
//     writes keep these and send them again instead of dropping them.
//   - noteRefusalNotice(): a write the player is NOT looking at was refused
//     (an offline-queued check-in, check-out, Start or End replayed later, or
//     a sign-out that couldn't close a check-in). Kept until shown: a toast
//     the next time the app is open (components/RefusalNoticeHost), or right
//     away as a local notification when the app is in the background. Never
//     dropped silently.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { isNetworkError } from '@just-messin-around/expo-foundation/platform';
import { postLocalNotice } from '@just-messin-around/expo-foundation/platform/push';
import { classifySbError, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { NO_CONNECTION, refusalCode, refusalMessage, type RefusalContext } from './refusals';

/** The copy for an error the player is waiting on. `network` replaces the no-connection line. */
export function explainRefusal(
  e: unknown,
  fallback: string,
  ctx: RefusalContext = {},
  opts: { network?: string } = {},
): string {
  return refusalMessage(e, ctx) ?? friendlySbMessage(e, fallback, { network: opts.network ?? NO_CONNECTION });
}

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

/** Emits when a new notice is stored (the host toasts it). */
export const refusalNoticed = createSignal<void>();

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

/**
 * Keep a notice until the player has seen it. In the background (native) it
 * goes out now as a local notification; otherwise the host toasts it.
 */
export async function noteRefusalNotice(n: RefusalNotice): Promise<void> {
  const background = Platform.OS !== 'web' && AppState.currentState !== 'active';
  const list = (await read()).filter((x) => x.key !== n.key);
  await write([...list, { ...n, atMs: Date.now(), shown: background }]);
  if (background) {
    await postLocalNotice(n.title, n.body, n.link ? { data: { deepLink: n.link } } : undefined);
    return;
  }
  refusalNoticed.emit();
}

/** The notices not shown yet, oldest first (now marked shown). */
export async function takeRefusalNotices(): Promise<RefusalNotice[]> {
  const list = await read();
  const fresh = list.filter((n) => !n.shown);
  if (fresh.length === 0) return [];
  await write(list.map((n) => (n.shown ? n : { ...n, shown: true })));
  return fresh.map(({ key, title, body, link }) => ({ key, title, body, link }));
}
