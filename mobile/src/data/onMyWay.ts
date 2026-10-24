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
  type OnMyWayResult,
} from '../lib/onMyWay';

const ETA_KEY = 'pickleague:onMyWay:etaMinutes:v1';
const BOUND = { timeoutMs: 9_000 };

/**
 * Tell friends I'm on the way to a court. `recipients`: the friends ticked in
 * the sheet (null = the server's default, my close friends). Refusals (signed
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
  // feed shows "Told friends" there. Under the facility's id and the one tapped.
  // The device's clock, not the server's sent_at: the label is read against
  // the device's clock too.
  if (res.sent || res.reason === 'recent') {
    const ms = Date.now();
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

/** The ETA this device last sent with (15 the first time, or when storage is unavailable). */
export async function loadLastEta(): Promise<number> {
  try {
    return parseStoredEta(await AsyncStorage.getItem(ETA_KEY));
  } catch {
    return DEFAULT_ETA_MINUTES;
  }
}

export async function saveLastEta(minutes: number): Promise<void> {
  if (!validEta(minutes)) return;
  try {
    await AsyncStorage.setItem(ETA_KEY, String(minutes));
  } catch {
    // A private window or blocked storage: the next sheet starts at 15 again.
  }
}
