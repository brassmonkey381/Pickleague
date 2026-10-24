// "On my way" (supabase/migration_on_my_way.sql): the send, the remembered
// ETA, and which courts this device told friends about in the last 30
// minutes. Rules and copy: lib/onMyWay.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_ETA_MINUTES,
  normalizeOnMyWayResult,
  parseStoredEta,
  sentRecently,
  validEta,
  windowStartMs,
  type OnMyWayResult,
} from '../lib/onMyWay';

const ETA_KEY = 'pickleague:onMyWay:etaMinutes:v1';
const BOUND = { timeoutMs: 9_000 };

/**
 * Tell friends I'm on the way to a court. `recipients`: the friends ticked in
 * the sheet (null = the server's default, all my friends). Refusals (signed
 * out, a bad ETA, too many friends, a court that's gone) throw with their
 * 'pl:' code; "not sent" answers come back as a result with a reason.
 */
export async function sendOnMyWay(venueId: string, etaMinutes: number, recipients: string[] | null): Promise<OnMyWayResult> {
  const raw = await sbCall(
    () =>
      supabase.rpc('send_on_my_way', {
        p_venue: venueId,
        p_eta_minutes: etaMinutes,
        p_recipients: recipients,
      }),
    BOUND,
  );
  const res = normalizeOnMyWayResult(raw, etaMinutes);
  // The court's window started (sent) or is still running ('recent'): the
  // feed shows "Told friends" there, until the window ends. Under the
  // facility's id and the one tapped. A 'recent' answer keeps the server's
  // last send (lib/onMyWay windowStartMs), not the refused tap.
  const ms = windowStartMs(res, Date.now());
  if (ms != null) {
    sentAt.set(venueId, ms);
    if (res.venueId) sentAt.set(res.venueId, ms);
    onMyWaySent.emit(venueId);
  }
  return res;
}

// Memory only: the server's window is the rule; this just labels the pill.
const sentAt = new Map<string, number>();

/** Fires with the court id after a send (or a 'recent' answer), so cards re-label. */
export const onMyWaySent = createSignal<string>();

export function sentOnMyWayRecently(venueId: string, nowMs = Date.now()): boolean {
  return sentRecently(sentAt.get(venueId), nowMs);
}

// The remembered ETA once read (or saved) this session, so a later sheet
// starts on it at once.
let lastEta: number | null = null;

/** The remembered ETA when this session already knows it, else null (then loadLastEta). */
export function peekLastEta(): number | null {
  return lastEta;
}

/** The ETA this device last sent with (15 the first time, or when storage is unavailable). */
export async function loadLastEta(): Promise<number> {
  if (lastEta != null) return lastEta;
  let m = DEFAULT_ETA_MINUTES;
  try {
    m = parseStoredEta(await AsyncStorage.getItem(ETA_KEY));
  } catch {
    // Storage unavailable: 15.
  }
  lastEta ??= m;
  return lastEta;
}

export async function saveLastEta(minutes: number): Promise<void> {
  if (!validEta(minutes)) return;
  lastEta = minutes;
  try {
    await AsyncStorage.setItem(ETA_KEY, String(minutes));
  } catch {
    // A private window or blocked storage: the next sheet starts at 15 again.
  }
}
