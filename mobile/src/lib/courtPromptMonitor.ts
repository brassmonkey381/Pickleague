// The foreground check-in monitor (Doggle's passiveFavoriteService tick,
// state/court-arrival-doggle-parity.md B5): once a minute while the app is
// open, on phone and web, prompt "Check in nearby?"
//   * inside any court's mapped outline,
//   * near a starred court with no outline, within "Notice me at starred courts",
//   * near any other court with no outline, within "Prompt me near other
//     courts" (Off by default).
// One prompt per court per 2 hours from here. A starred court the geofence
// saw me arrive at in the last 2 hours is left to it (native, automatic
// check-in on), so that arrival doesn't also get a prompt. Its prompts show
// while the app is open (lib/push), unlike Doggle's: this scan runs only then,
// so hidden they would never be seen.
//
// It never asks for location: it reads a position only when foreground
// permission is already granted (Doggle's raised the sheet). The coordinates
// go to court_prompt_scan and nowhere else: never logged, stored or traced.
// CourtArrivalHost runs the tick (usePollWhileActive) and clears the
// cooldowns when the signed-in player changes.
import { AppState, Platform } from 'react-native';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { getForegroundLocationStatus } from '@just-messin-around/expo-foundation/platform/location';
import { playSession } from './playSession';
import { arrivedRecently, promptCourtCheckin } from './courtArrival';
import { isStarredCourtRegion } from './courtGeofence';
import { MONITOR_COOLDOWN_MS } from './courtArrivalRules';
import { traceArrival } from './courtArrivalTrace';
import { courtPromptScan, loadCourtArrivalSettings } from '../data/courtArrival';

// When each court was last prompted from here (ms), in memory only.
const cooldown = new Map<string, number>();

/** The signed-in player changed (or signed out): the next one starts fresh. */
export function resetCourtPromptCooldowns(): void {
  cooldown.clear();
}

/** The OS's own last fix is used when it's this fresh (else a new one is read). */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
const FIX_TIMEOUT_MS = 10_000;

type Position = { coords: { latitude: number; longitude: number } };
type LocationModule = {
  Accuracy: { Balanced: number };
  getLastKnownPositionAsync(opts?: { maxAge?: number }): Promise<Position | null>;
  getCurrentPositionAsync(opts: { accuracy: number }): Promise<Position>;
};

/**
 * A position, read only with permission already granted; null otherwise.
 * expo-location directly rather than the foundation's coords helpers: those
 * remember every fix on the device, and this one is used once and dropped.
 */
async function readPosition(): Promise<{ lat: number; lng: number } | null> {
  if ((await getForegroundLocationStatus()) !== 'granted') return null;
  if (Platform.OS === 'web') {
    // Doggle's browser options: coarse is enough, and a minute-old fix will do.
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: FIX_TIMEOUT_MS, maximumAge: 60_000 },
      );
    });
  }
  let Location: LocationModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Location = require('expo-location') as LocationModule;
  } catch {
    return null;
  }
  // The OS's last fix first (no radio), else a balanced one, bounded.
  const pos =
    (await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }).catch(() => null)) ??
    (await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), FIX_TIMEOUT_MS).catch(
      () => null,
    ));
  return pos?.coords ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : null;
}

/** One tick. Never throws. */
export async function courtPromptTick(): Promise<void> {
  try {
    // Prompts while the app is in the background are the geofence's.
    if (AppState.currentState !== 'active') return;
    // A play session already has me at a court.
    if (playSession.get().status !== 'idle') return;
    const settings = await loadCourtArrivalSettings().catch(() => null);
    if (!settings) return;
    const starRadius = settings.court_radius_m || 0;
    const otherRadius = settings.other_court_radius_m || 0;
    // A starred court the geofence just handled (native, automatic check-in on).
    const autoStar = Platform.OS !== 'web' && starRadius > 0 && settings.auto_checkin !== false;
    const leftToGeofence = async (id: string) =>
      autoStar && (await isStarredCourtRegion(id)) && (await arrivedRecently(id));

    const loc = await readPosition();
    if (!loc) return;
    const scanM = Math.max(starRadius, otherRadius);
    // One read answers both: the outline I'm inside, and the courts nearby
    // (only asked for when a distance is set; the server clamps to 10-500 m).
    const scan = await courtPromptScan(loc.lat, loc.lng, scanM > 0 ? scanM : 10);
    const now = Date.now();
    let prompted = 0;

    const inside = scan.inside;
    if (inside && now - (cooldown.get(inside.venue_id) ?? 0) >= MONITOR_COOLDOWN_MS && !(await leftToGeofence(inside.venue_id))) {
      cooldown.set(inside.venue_id, now);
      await promptCourtCheckin(inside.venue_id, inside.name, undefined, { fromMonitor: true });
      prompted += 1;
    }

    if (scanM > 0) {
      for (const court of scan.nearby) {
        // An outline replaces the circle: handled above.
        if (court.has_outline) continue;
        if (await leftToGeofence(court.venue_id)) continue;
        const radius = court.starred ? starRadius : otherRadius;
        if (radius <= 0 || court.distance_m > radius) continue;
        if (now - (cooldown.get(court.venue_id) ?? 0) < MONITOR_COOLDOWN_MS) continue;
        cooldown.set(court.venue_id, now);
        await promptCourtCheckin(court.venue_id, court.name, undefined, { fromMonitor: true });
        prompted += 1;
      }
    }
    traceArrival('monitor_tick', {
      inside: inside?.venue_id ?? null,
      nearby: scan.nearby.length,
      prompted,
      star_radius_m: starRadius,
      other_radius_m: otherRadius,
    });
  } catch {
    // best-effort
  }
}
