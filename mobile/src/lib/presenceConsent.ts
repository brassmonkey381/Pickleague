// The one-time "who sees you at the courts" sheet, before a player's first
// check-in or play session (docs/play-sessions-presence.md, presence privacy).
//
//   if (!(await ensurePresenceConsent())) return;   // they chose Not now
//   ...check in / start the session...
//
// Accepted once per ACCOUNT, not per device: the flag is
// presence_settings.consent_seen_at, written by
// set_presence_settings(p_consent_seen => true). A per-user device flag is set
// at the same moment, so an offline "Got it" still counts and is not asked
// again; it is synced to the server on the next check.
//
// The sheet is PresenceConsentHost (components/presence/ConsentSheet.tsx),
// mounted once in App.tsx; this module asks it to open and waits for the
// answer. Callers:
//   - await it OUTSIDE any bounded busy state (it waits on the player);
//   - call it before opening a sheet of their own, or after that sheet has
//     fully closed (iOS drops a Modal presented while another is dismissing);
//   - from a path with no screen (a lock-screen action), use
//     hasPresenceConsent() and open the app instead when it is false.
//
// Not behind FRIENDS_AT_COURTS_ENABLED: check-ins name players to friends and
// closed-league mates as soon as the presence SQL is live, so the sheet, and
// the Settings > Privacy rows it points to, ship with them.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { loadPresenceSettings, setPresenceSettings } from '../data/presenceSettings';

const LOCAL_KEY = 'pickleague_presence_consent_v1';

/** What the host is asked to do: show the sheet, then answer once. */
export type ConsentRequest = { answer: (accepted: boolean) => void };

let host: ((req: ConsentRequest) => void) | null = null;
let inFlight: Promise<boolean> | null = null;

/** PresenceConsentHost registers here; returns the unregister. One host. */
export function registerConsentHost(show: (req: ConsentRequest) => void): () => void {
  host = show;
  return () => {
    if (host === show) host = null;
  };
}

async function readLocal(uid: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(`${LOCAL_KEY}:${uid}`)) === '1';
  } catch {
    return false;
  }
}

async function writeLocal(uid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(`${LOCAL_KEY}:${uid}`, '1');
  } catch {
    // the server flag is the durable one
  }
}

/** Has this account accepted the sheet? No UI. When the server can't be
 *  reached and this device has no record, false: asking twice is harmless,
 *  skipping the question is not. */
export async function hasPresenceConsent(): Promise<boolean> {
  return (await presenceConsentState()) === 'yes';
}

/**
 * The same, telling "not yet" from "couldn't ask the server" ('unknown': no
 * record on this device and no connection), so the lock screen can say which
 * (rule 11: a refusal says why).
 */
export async function presenceConsentState(): Promise<'yes' | 'no' | 'unknown'> {
  const uid = await currentUserId(supabase);
  if (!uid) return 'yes'; // signed out: nothing to share
  if (await readLocal(uid)) {
    // Accepted on this device; make sure the server heard (an offline "Got it").
    void loadPresenceSettings()
      .then((s) => (s.consent_seen_at ? undefined : setPresenceSettings({ consentSeen: true })))
      .catch(() => {});
    return 'yes';
  }
  try {
    // Fresh, not cached: it may have been accepted on another device since.
    const s = await loadPresenceSettings(true);
    if (s.consent_seen_at) void writeLocal(uid);
    return s.consent_seen_at ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

/** Record "Got it": on this device at once, on the server best-effort. */
export async function recordPresenceConsent(): Promise<void> {
  const uid = await currentUserId(supabase);
  if (uid) await writeLocal(uid);
  try {
    await setPresenceSettings({ consentSeen: true });
  } catch {
    // synced by the next hasPresenceConsent()
  }
}

/**
 * Resolves true when the player may be shown at a court: they accepted now or
 * before. False when they chose Not now. Concurrent calls share one sheet.
 */
export function ensurePresenceConsent(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (await hasPresenceConsent()) return true;
    const show = host;
    // No host mounted (it always is, from App.tsx): never block a check-in on a
    // sheet that can't appear.
    if (!show) return true;
    return new Promise<boolean>((resolve) => {
      let done = false;
      show({
        answer: (accepted) => {
          if (done) return;
          done = true;
          resolve(accepted);
        },
      });
    });
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
