// Court outlines on the phone, for check-ins by the outline (Doggle's engine,
// expo-foundation 1.104; state/court-arrival-doggle-parity.md "2026-11-04").
// A geofence circle only wakes the phone; whether it is ON the court is
// judged here, against the court's mapped outline:
//
//   - the outlines of the courts the phone watches, saved at each geofence
//     sync (list_starred_court_geofences / list_nearby_wake_courts send them),
//     so a background wake with no signal can still judge;
//   - for any other court (a manual check-in at a court nobody starred), one
//     read of get_court, kept here after;
//   - one location reading, used once and dropped (expo-location directly:
//     the foundation's coords helpers remember every fix on the device).
//
// Runs in background wakes (no React). Nothing here throws.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import type { BoundaryGeometry } from '@just-messin-around/expo-foundation/ui';
import type { OutlineFix } from '@just-messin-around/expo-foundation/tracking';
import { isOutlineGeometry } from './courtArrivalRules';

const OUTLINES_KEY = 'pickleague_court_outlines_v1';

// The saved map, read once per process; writes keep it in step.
let mem: Record<string, BoundaryGeometry> | null = null;

async function readAll(): Promise<Record<string, BoundaryGeometry>> {
  if (mem) return mem;
  try {
    const raw = await AsyncStorage.getItem(OUTLINES_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    mem = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, BoundaryGeometry>) : {};
  } catch {
    mem = {};
  }
  return mem;
}

async function writeAll(next: Record<string, BoundaryGeometry>): Promise<void> {
  mem = next;
  await AsyncStorage.setItem(OUTLINES_KEY, JSON.stringify(next)).catch(() => {});
}

/**
 * The watched courts' outlines, at a sync: replaces the saved set (a court
 * no longer watched is dropped). A court with none is left out.
 */
export async function setWatchedCourtOutlines(outlines: Record<string, unknown>): Promise<void> {
  const next: Record<string, BoundaryGeometry> = {};
  for (const [id, g] of Object.entries(outlines)) if (isOutlineGeometry(g)) next[id] = g;
  await writeAll(next);
}

/** How long a get_court read may take in a wake. */
const COURT_READ_TIMEOUT_MS = 5_000;

/**
 * A court's outline: the saved one, else get_court's (saved for next time),
 * else null (no outline, or no signal). `fetch: false` reads only what is saved.
 */
export async function getCourtOutline(venueId: string, opts: { fetch?: boolean } = {}): Promise<BoundaryGeometry | null> {
  const saved = (await readAll())[venueId];
  if (saved) return saved;
  if (opts.fetch === false || venueId.startsWith('qr:')) return null;
  try {
    // Lazy: data/courtDiscovery pulls in screens' helpers a wake doesn't need.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getCourt } = require('../data/courtDiscovery') as typeof import('../data/courtDiscovery');
    const court = await withTimeout(getCourt(venueId), COURT_READ_TIMEOUT_MS);
    if (!isOutlineGeometry(court.boundary)) return null;
    await writeAll({ ...(await readAll()), [venueId]: court.boundary });
    return court.boundary;
  } catch {
    return null;
  }
}

/** Forget every saved outline (a real sign-out). */
export async function clearCourtOutlines(): Promise<void> {
  mem = {};
  await AsyncStorage.removeItem(OUTLINES_KEY).catch(() => {});
}

// ── One reading ─────────────────────────────────────────────────────────────
type Position = {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  timestamp?: number;
};
type LocationModule = {
  Accuracy: { High: number; Balanced: number };
  getForegroundPermissionsAsync(): Promise<{ status: string }>;
  getLastKnownPositionAsync(opts?: { maxAge?: number; requiredAccuracy?: number }): Promise<Position | null>;
  getCurrentPositionAsync(opts: { accuracy: number }): Promise<Position>;
};

/**
 * Where the phone is now, for judging an outline: the OS's last reading when
 * it is under `recentMs` old, else a new one within `timeoutMs`. Null with no
 * permission (never asks), on web, or with no reading in time.
 */
export async function readCourtFix(
  opts: { recentMs?: number; timeoutMs?: number; balanced?: boolean } = {},
): Promise<OutlineFix | null> {
  if (Platform.OS === 'web') return null;
  let Location: LocationModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Location = require('expo-location') as LocationModule;
  } catch {
    return null;
  }
  try {
    if ((await Location.getForegroundPermissionsAsync()).status !== 'granted') return null;
    const pos =
      (await Location.getLastKnownPositionAsync({ maxAge: opts.recentMs ?? 15_000 }).catch(() => null)) ??
      (await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: opts.balanced ? Location.Accuracy.Balanced : Location.Accuracy.High }),
        opts.timeoutMs ?? 8_000,
      ).catch(() => null));
    if (!pos?.coords) return null;
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, accuracyM: accuracy ?? null, atMs: pos.timestamp ?? Date.now() };
  } catch {
    return null;
  }
}
