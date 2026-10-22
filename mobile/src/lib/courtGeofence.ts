// Court geofences: which courts the phone watches in the background, and the
// task the OS wakes when it enters or leaves one (Doggle parity,
// state/court-arrival-doggle-parity.md B1). What an Enter or Exit then does
// is lib/courtArrival's.
//
// Watched, at most 20 (the iOS per-app limit), in this order:
//   0. Routine courts (ROUTINES_ENABLED), while "Check me in at my routine
//      courts" is on: a starred court with an active routine, the outline's
//      circle else 150 m (Doggle fences routine stops first). Whatever
//      "Notice me at starred courts" says: an arrival during a stop's window
//      checks in even with that Off (lib/courtArrivalRules decideArrival).
//   1. QR wallet courts (lib/qrWallet), while "Show these codes when I
//      arrive" is on for this phone: arriving shows the saved code.
//   2. Starred courts, while "Notice me at starred courts" is above Off:
//      arrival check-ins and prompts. A court with a mapped outline gets the
//      circle of the same area, else the chosen distance (100 m by default).
// One region per court: a starred QR court keeps its wallet place and code
// but takes the starred circle. League-home and most-used courts are no
// longer watched (they were in 1.0.4 build 13).
//
// Only an Enter after an Exit is an arrival: every registration makes the OS
// re-report the regions the phone is already inside (region state below).
//
// A sync never asks for location unless `interactive` (starring a court, the
// court card's offer, Settings' Allow, the QR wallet). If the starred courts
// can't be read (no signal, nothing saved), the courts already watched stay
// watched: syncing the rest would drop every starred court until the next
// good sync, which is exactly when the player is out.
//
// defineCourtGeofenceTask() must run at the entry module's scope (index.ts):
// the OS can wake the app headless to deliver an event. Native only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
  buildRegions,
  createRegionMetaStore,
  createRegionStateStore,
  defineGeofenceTask,
  syncGeofencesDetailed,
  type GeofenceSyncReason,
} from '@just-messin-around/expo-foundation/tracking';
import { resolveUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { track } from './analytics';
import { listPasses, walletRegionId, type WalletPass } from './qrWallet';
import { handleCourtArrival, handleCourtDeparture, WALLET_NOTICE_KEY } from './courtArrival';
import {
  buildCourtRegionList,
  MAX_COURT_REGIONS,
  MAX_REGION_RADIUS_M,
  mergeCourtRegion,
  MIN_REGION_RADIUS_M,
  ROUTINE_TIER,
  routineTierRegions,
  STARRED_TIER,
  starredTierRegions,
  WALLET_TIER,
  walletTierRegions,
  type CourtRegionInfo,
  type RoutineRegionSource,
  type StarredCourtGeofence,
  type WalletRegionSource,
} from './courtArrivalRules';
import { traceArrival } from './courtArrivalTrace';
import { ROUTINES_ENABLED } from './features';
import { loadCourtArrivalSettings, loadStarredCourtGeofences } from '../data/courtArrival';
import { getMyCourtRoutinesOffline, loadCourtRoutineSettings, loadMyCourtRoutines } from '../data/courtRoutines';
import type { CourtRoutine } from './courtRoutineRules';

/** My routines as region sources: one per routine (routineTierRegions keeps one per court). */
export function routineRegionSources(list: readonly CourtRoutine[]): RoutineRegionSource[] {
  return list.map((r) => ({
    venueId: r.venueId,
    name: r.venueName,
    lat: r.lat,
    lng: r.lng,
    radiusM: r.radiusM,
    autoCheckin: r.autoCheckin,
    live: r.active && r.starred,
  }));
}

/** The routine tier's courts: fresh when the network answers, else this phone's copy, else none. */
async function routineSourcesForSync(): Promise<RoutineRegionSource[]> {
  if (!ROUTINES_ENABLED) return [];
  const settings = await loadCourtRoutineSettings().catch(() => null);
  if (settings?.routine_auto_checkin === false) return [];
  const list = await loadMyCourtRoutines(true).catch(() => getMyCourtRoutinesOffline().catch(() => [] as CourtRoutine[]));
  return routineRegionSources(list);
}

/** Install-stable: the OS keeps the regions registered under this name across updates. */
export const COURT_GEOFENCE_TASK = 'pickleague-court-geofence';

// 1.0.4 build 13's "Court arrival alerts" switch. Nobody outside TestFlight
// has it, so it now means only "Show these codes when I arrive" (QR wallet
// notices on this phone): absent or true = on.
const WALLET_CODES_KEY = 'pickleague_court_alerts_enabled_v1';
// What build 13 saved at each sync: region id -> name, and -> QR wallet pass.
// Read only until the first sync of this build replaces the OS's regions,
// then deleted.
const LEGACY_NAMES_KEY = 'pickleague_court_fence_names_v1';
const LEGACY_WALLET_KEY = 'pickleague_court_fence_wallet_v1';

// Inside / outside per region, from the OS's own Enter and Exit events.
const regionState = createRegionStateStore({ storageKey: 'pickleague_court_region_state_v1' });

// What a wake needs to know about each watched court, saved at each sync.
// missingMeansMember false: until this build's first sync, the OS still
// watches build 13's league-home and most-used courts, which are not
// members now (they stay silent).
const regionMeta = createRegionMetaStore<CourtRegionInfo>({
  idsKey: 'pickleague_court_region_ids_v1',
  infoKey: 'pickleague_court_region_info_v1',
  missingMeansMember: false,
});

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * What the last sync saved about a region, or null for one this build
 * doesn't watch. Before this build's first sync, a QR wallet court that
 * build 13 watched still opens its code (from the old keys).
 */
export async function courtRegionInfo(id: string): Promise<CourtRegionInfo | null> {
  const info = await regionMeta.get(id).catch(() => null);
  if (info) return info;
  const passId = (await readJson<Record<string, string>>(LEGACY_WALLET_KEY, {}))[id];
  if (!passId) return null;
  const name = (await readJson<Record<string, string>>(LEGACY_NAMES_KEY, {}))[id];
  return { name: name ?? 'the courts', starred: false, autoCheckin: false, passId };
}

/** A starred court the phone watches (the foreground monitor leaves its arrivals to the geofence). */
export async function isStarredCourtRegion(id: string): Promise<boolean> {
  return (await regionMeta.get(id).catch(() => null))?.starred === true;
}

/**
 * A per-court switch changed in Settings: wakes see it before the next sync.
 * Does nothing for a court the phone doesn't watch.
 */
export function patchCourtRegionInfo(id: string, partial: Partial<CourtRegionInfo>): Promise<void> {
  return regionMeta.patch(id, partial).catch(() => undefined);
}

/** Call once from index.ts at module scope. */
export function defineCourtGeofenceTask(): void {
  defineGeofenceTask(
    COURT_GEOFENCE_TASK,
    {
      // The info read starts here and is awaited after the arrival is marked.
      onEnter: (e) => handleCourtArrival(e.id, { arrival: e.arrival === true, info: courtRegionInfo(e.id) }),
      onExit: (e) => handleCourtDeparture(e.id, { info: courtRegionInfo(e.id) }),
    },
    { regionState },
  );
}

// ── QR wallet codes on arrival (this phone) ─────────────────────────────────
/** "Show these codes when I arrive": absent or true = on. */
export async function getWalletArrivalCodesOn(): Promise<boolean> {
  return (await readJson<unknown>(WALLET_CODES_KEY, true)) !== false;
}

/**
 * Turn the QR wallet notices on or off for this phone, then resync.
 * `interactive` (the wallet screen turning it on) may ask for "Always"
 * location.
 */
export async function setWalletArrivalCodesOn(
  on: boolean,
  opts: { interactive?: boolean } = {},
): Promise<CourtGeofenceSyncResult> {
  await AsyncStorage.setItem(WALLET_CODES_KEY, JSON.stringify(on)).catch(() => {});
  return syncCourtGeofences({ interactive: on && opts.interactive === true });
}

// ── Sync ────────────────────────────────────────────────────────────────────
/**
 * The foundation's reasons (ok, stopped, unsupported, no-foreground,
 * no-background, error: the OS call threw), plus `offline`: the starred
 * courts or the settings couldn't be read, so the courts already watched
 * were kept.
 */
export type CourtGeofenceSyncReason = GeofenceSyncReason | 'offline';
export type CourtGeofenceSyncResult = { count: number; reason: CourtGeofenceSyncReason };

function walletSources(passes: WalletPass[]): WalletRegionSource[] {
  return passes.map((p) => ({ regionId: walletRegionId(p), passId: p.id, name: p.venueName, lat: p.lat, lng: p.lng }));
}

/**
 * The first sync that replaced build 13's regions: its saved names and wallet
 * map go, and the QR notice's 3-hour stamps keep only QR wallet courts.
 */
async function forgetLegacyRegions(wallet: WalletRegionSource[]): Promise<void> {
  try {
    const [[, names], [, old]] = await AsyncStorage.multiGet([LEGACY_NAMES_KEY, LEGACY_WALLET_KEY]);
    if (names == null && old == null) return;
    await AsyncStorage.multiRemove([LEGACY_NAMES_KEY, LEGACY_WALLET_KEY]);
    const stamps = await readJson<Record<string, unknown> | null>(WALLET_NOTICE_KEY, null);
    if (stamps && typeof stamps === 'object') {
      const keep = new Set(wallet.map((w) => w.regionId));
      const next = Object.fromEntries(Object.entries(stamps).filter(([id]) => keep.has(id)));
      await AsyncStorage.setItem(WALLET_NOTICE_KEY, JSON.stringify(next));
    }
  } catch {
    // best-effort: the stamps age out in 3 hours anyway
  }
}

async function runSync(interactive: boolean): Promise<CourtGeofenceSyncResult> {
  if (Platform.OS === 'web') return { count: 0, reason: 'unsupported' };
  try {
    const who = await resolveUserId(supabase);
    // Can't tell who is signed in right now (an access token that expired
    // with no signal to refresh it: opening the app at a park an hour after
    // last using it): keep what is watched, as for any read that fails.
    if (!who.resolved) {
      traceArrival('sync', { reason: 'offline', interactive, session: 'unresolved' });
      return { count: 0, reason: 'offline' };
    }
    // Signed out: watch nothing (the next account picks its own courts).
    if (!who.userId) return await syncGeofencesDetailed(COURT_GEOFENCE_TASK, []);
    // Unreadable with nothing saved: keep what is watched. (Doggle, with its
    // settings unreadable, dropped every favorite.)
    const settings = await loadCourtArrivalSettings().catch(() => null);
    if (!settings) return { count: 0, reason: 'offline' };
    const codesOn = await getWalletArrivalCodesOn();
    let wallet: WalletRegionSource[] = [];
    let starred: StarredCourtGeofence[] = [];
    let routine: RoutineRegionSource[] = [];
    const built = await buildRegions(
      [
        {
          // Never required: with no copy at all, the starred tier still
          // watches these courts (routines live only at starred courts).
          name: ROUTINE_TIER,
          load: async () => {
            routine = await routineSourcesForSync();
            return routineTierRegions(routine);
          },
        },
        {
          name: WALLET_TIER,
          load: async () => {
            wallet = codesOn ? walletSources(await listPasses()) : [];
            return walletTierRegions(wallet);
          },
        },
        {
          name: STARRED_TIER,
          // Read fresh at every sync (a star from another device); the saved
          // copy stands in when offline, and with none the sync is skipped.
          required: true,
          load: async () => {
            starred = settings.court_radius_m > 0 ? await loadStarredCourtGeofences(true) : [];
            return starredTierRegions(starred, settings.court_radius_m);
          },
        },
      ],
      { merge: mergeCourtRegion },
    );
    if (built.abort) {
      traceArrival('sync', { reason: 'offline', interactive });
      return { count: 0, reason: 'offline' };
    }
    const { regions, info } = buildCourtRegionList(built, { wallet, starred, routine });
    // Saved before registering: the OS re-reports every region at once, and
    // those wakes read it.
    await regionMeta.set(info);
    const res = await syncGeofencesDetailed(COURT_GEOFENCE_TASK, regions, {
      skipPermissionRequest: !interactive,
      minRadiusM: MIN_REGION_RADIUS_M,
      maxRadiusM: MAX_REGION_RADIUS_M,
      maxRegions: MAX_COURT_REGIONS,
      // Counted only when a sheet actually shows (the foundation calls these then).
      onPermissionAsked: (kind) => track('location.permission_asked', { kind, surface: 'court_arrival' }),
      onPermissionResult: (kind, granted) =>
        track('location.permission_result', { kind, granted, surface: 'court_arrival' }),
    });
    if (res.reason === 'ok' || res.reason === 'stopped') await forgetLegacyRegions(wallet);
    traceArrival('sync', { count: res.count, reason: res.reason, interactive });
    return res;
  } catch {
    return { count: 0, reason: 'error' };
  }
}

// One sync at a time, in order: a star, a Settings change and the app coming
// to the front often ask together. A request made while another waits joins
// it (asking for location if either did); the sign-out's stop queues behind.
let tail: Promise<unknown> = Promise.resolve();
let waiting: { interactive: boolean; promise: Promise<CourtGeofenceSyncResult> } | null = null;

/**
 * Re-pick the watched courts. Never shows a permission sheet unless
 * `interactive`. Resolves how many are watched and why; never throws.
 */
export function syncCourtGeofences(opts: { interactive?: boolean } = {}): Promise<CourtGeofenceSyncResult> {
  const interactive = opts.interactive === true;
  if (waiting) {
    waiting.interactive = waiting.interactive || interactive;
    return waiting.promise;
  }
  const req = { interactive } as { interactive: boolean; promise: Promise<CourtGeofenceSyncResult> };
  req.promise = tail.then(() => {
    if (waiting === req) waiting = null;
    return runSync(req.interactive);
  });
  tail = req.promise.catch(() => undefined);
  waiting = req;
  return req.promise;
}

/** A real sign-out: stop watching, and forget every court's state and info. */
export function stopCourtGeofencesForSignOut(): Promise<void> {
  const run = tail.then(async () => {
    if (Platform.OS !== 'web') await syncGeofencesDetailed(COURT_GEOFENCE_TASK, []).catch(() => null);
    await Promise.all([
      regionState.clear().catch(() => undefined),
      regionMeta.clear().catch(() => undefined),
      AsyncStorage.multiRemove([LEGACY_NAMES_KEY, LEGACY_WALLET_KEY]).catch(() => {}),
    ]);
  });
  tail = run.catch(() => undefined);
  return run.catch(() => undefined);
}
