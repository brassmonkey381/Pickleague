// Court arrival alerts (work order 7f): when the phone enters a fenced court,
// post a local "You're at <court>" notice with a Check in button. It never
// checks in on its own (lower App Store review risk, and no surprise presence).
// The button takes a fresh fix like every check-in (no manual check-ins), and
// the server confirms it. Leaving the court checks out only check-ins this
// feature opened.
//
// Opt-in per device (Settings), because it needs "Always" location. Fences:
// my leagues' home courts first (the stored leagues.home_venue_id, else the
// pickleball court at the league's coordinates), then the courts I check in at
// most; at most 20 (the iOS per-app limit).
//
// defineCourtGeofenceTask() must run at the entry module's scope (index.ts):
// the OS can wake the app headless to deliver an event. Native only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { defineGeofenceTask, syncGeofences, type GeofenceRegion } from '@just-messin-around/expo-foundation/tracking';
import { postLocalNotice } from '@just-messin-around/expo-foundation/platform/push';
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { catalog, NeedsApp, registerActionHandler, requireUser } from './notificationActions';
import { checkInAt, checkOut, peekCurrentCheckin, takeCheckinFix } from './courtCheckin';
import { isNotAtCourtError } from './courtCheckinRules';
import { getMyLeagueCourts, getVenuesByIds, resolveCourtAt } from '../data/venueCheckins';

export const COURT_GEOFENCE_TASK = 'pickleague-court-geofence';
const ENABLED_KEY = 'pickleague_court_alerts_enabled_v1';
const NAMES_KEY = 'pickleague_court_fence_names_v1';
const LAST_NOTICE_KEY = 'pickleague_court_fence_last_notice_v1';
const RENOTIFY_MS = 3 * 3600_000;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function onEnter(venueId: string): Promise<void> {
  const current = await peekCurrentCheckin();
  if (current?.venueId === venueId) return;
  const last = await readJson<Record<string, number>>(LAST_NOTICE_KEY, {});
  if (last[venueId] && Date.now() - last[venueId] < RENOTIFY_MS) return;
  last[venueId] = Date.now();
  await AsyncStorage.setItem(LAST_NOTICE_KEY, JSON.stringify(last)).catch(() => {});
  const names = await readJson<Record<string, string>>(NAMES_KEY, {});
  const name = names[venueId] ?? 'the courts';
  await postLocalNotice(`You're at ${name}`, 'Check in so other players know you are here.', {
    categoryId: catalog.ids.court_checkin.id,
    // A tap opens Home's court card, where Check in lives.
    data: { venue_id: venueId, venue_name: name, deepLink: 'home/-' },
  });
}

async function onExit(venueId: string): Promise<void> {
  const current = await peekCurrentCheckin();
  if (current && current.venueId === venueId && current.source === 'geofence') {
    await checkOut(current.id, 'geofence').catch(() => {});
  }
}

/** Call once from index.ts at module scope. */
export function defineCourtGeofenceTask(): void {
  defineGeofenceTask(COURT_GEOFENCE_TASK, {
    onEnter: (e) => onEnter(e.id),
    onExit: (e) => onExit(e.id),
  });
}

registerActionHandler('court_checkin', {
  success: { title: 'Checked in', body: 'Other players can see you are here.' },
  queued: { title: 'Checked in', body: 'Saved. It counts if it syncs within 2 minutes.' },
  run: async (d) => {
    await requireUser();
    if (!d.venue_id) throw new Error('missing venue');
    // Arrival alerts run on "Always" location, so this reads a fix without a
    // dialog. 5 s leaves the write its share of the 10 s the button gets.
    const fix = await takeCheckinFix(5_000);
    if (!fix) throw new NeedsApp("Open Pickleague to check in. It couldn't get your location to confirm you're at the court.");
    try {
      const c = await checkInAt({ id: d.venue_id, name: d.venue_name ?? 'the courts' }, fix, { source: 'geofence' });
      return c.queued ? { queued: true } : c;
    } catch (e) {
      // "You need to be at the court to check in (about N m away)." as the notice.
      if (isNotAtCourtError(e)) throw new NeedsApp((e as Error).message);
      throw e;
    }
  },
});

export async function getCourtAlertsEnabled(): Promise<boolean> {
  return (await readJson<boolean>(ENABLED_KEY, false)) === true;
}

/** Which courts to fence: league home courts, then my most-used check-in courts. */
async function pickRegions(): Promise<{ regions: GeofenceRegion[]; names: Record<string, string> }> {
  const uid = await currentUserId(supabase);
  if (!uid) return { regions: [], names: {} };
  const regions: GeofenceRegion[] = [];
  const names: Record<string, string> = {};
  const add = (v: { id: string; name: string; lat: number; lng: number; radius?: number | null }) => {
    if (names[v.id] || regions.length >= 20) return;
    names[v.id] = v.name;
    regions.push({ id: v.id, lat: v.lat, lng: v.lng, radiusM: v.radius ?? 100 });
  };

  const leagues = await getMyLeagueCourts(uid);
  const stored = await getVenuesByIds([
    ...new Set(leagues.map((l) => l.home_venue_id).filter((id): id is string => !!id)),
  ]).catch(() => []);
  for (const l of leagues) {
    const home = l.home_venue_id ? stored.find((v) => v.id === l.home_venue_id) : null;
    if (home) {
      add({ id: home.id, name: home.name, lat: home.lat, lng: home.lng, radius: home.geofence_radius_m });
      continue;
    }
    if (l.home_court_lat == null || l.home_court_lng == null) continue;
    const v = await resolveCourtAt(l.home_court_lat, l.home_court_lng, 200).catch(() => null);
    if (v) add({ id: v.id, name: v.name, lat: v.lat, lng: v.lng });
  }

  const recent = ((await sbCall(
    () =>
      supabase
        .from('venue_checkins')
        .select('venue_id, venues(name, lat, lng, geofence_radius_m)')
        .eq('user_id', uid)
        .order('checked_in_at', { ascending: false })
        .limit(60),
    { timeoutMs: 9_000 },
  )) ?? []) as unknown as {
    venue_id: string;
    venues: { name: string; lat: number; lng: number; geofence_radius_m: number | null } | null;
  }[];
  const counts = new Map<string, { n: number; v: NonNullable<(typeof recent)[number]['venues']> }>();
  for (const r of recent) {
    if (!r.venues) continue;
    const cur = counts.get(r.venue_id);
    counts.set(r.venue_id, { n: (cur?.n ?? 0) + 1, v: r.venues });
  }
  for (const [id, { v }] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
    add({ id, name: v.name, lat: v.lat, lng: v.lng, radius: v.geofence_radius_m });
  }
  return { regions, names };
}

/**
 * Turn arrival alerts on or off for this device. Turning on asks for Always
 * location (the OS sheet), so only call it with `interactive` from the
 * Settings toggle. Returns how many courts are fenced (0 = off / not allowed).
 */
export async function setCourtAlertsEnabled(on: boolean): Promise<number> {
  if (Platform.OS === 'web') return 0;
  await AsyncStorage.setItem(ENABLED_KEY, JSON.stringify(on)).catch(() => {});
  if (!on) {
    await syncGeofences(COURT_GEOFENCE_TASK, []);
    return 0;
  }
  return syncCourtGeofences(true);
}

/** Re-sync the fenced courts (startup: never shows a permission sheet). Never throws. */
export async function syncCourtGeofences(interactive = false): Promise<number> {
  if (Platform.OS === 'web') return 0;
  try {
    if (!(await getCourtAlertsEnabled())) return 0;
    const { regions, names } = await pickRegions();
    await AsyncStorage.setItem(NAMES_KEY, JSON.stringify(names)).catch(() => {});
    return await syncGeofences(COURT_GEOFENCE_TASK, regions, {
      skipPermissionRequest: !interactive,
      minRadiusM: 75,
      maxRadiusM: 300,
    });
  } catch {
    return 0;
  }
}

/** Sign-out: stop fencing (the next account picks its own courts). */
export async function stopCourtGeofencesForSignOut(): Promise<void> {
  if (Platform.OS === 'web') return;
  await syncGeofences(COURT_GEOFENCE_TASK, []).catch(() => 0);
  await AsyncStorage.multiRemove([NAMES_KEY, LAST_NOTICE_KEY]).catch(() => {});
}
