// Court arrival alerts (work order 7f): when the phone enters a fenced court,
// post a local "You're at <court>" notice with a Check in button. It never
// checks in on its own (lower App Store review risk, and no surprise presence).
// Leaving the court checks out only check-ins this feature opened.
//
// Opt-in per device (Settings), because it needs "Always" location. Fences:
// my leagues' home courts first, then the courts I check in at most; at most
// 20 (the iOS per-app limit).
//
// defineCourtGeofenceTask() must run at the entry module's scope (index.ts):
// the OS can wake the app headless to deliver an event. Native only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { defineGeofenceTask, syncGeofences, type GeofenceRegion } from '@just-messin-around/expo-foundation/tracking';
import { postLocalNotice } from '@just-messin-around/expo-foundation/platform/push';
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { catalog, registerActionHandler, requireUser } from './notificationActions';
import { checkInAt, checkOut, peekCurrentCheckin } from './courtCheckin';
import { resolveVenueAt } from '../data/venueCheckins';

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
    data: { venue_id: venueId, venue_name: name },
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
  queued: { title: 'Checked in', body: 'Saved. It syncs when you are back online.' },
  run: async (d) => {
    await requireUser();
    if (!d.venue_id) throw new Error('missing venue');
    const c = await checkInAt({ id: d.venue_id, name: d.venue_name ?? 'the courts' }, { source: 'geofence' });
    return c.queued ? { queued: true } : c;
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

  const leagues = ((await sbCall(
    () =>
      supabase
        .from('league_members')
        .select('leagues(home_court_lat, home_court_lng, is_active)')
        .eq('user_id', uid),
    { timeoutMs: 9_000 },
  )) ?? []) as unknown as { leagues: { home_court_lat: number | null; home_court_lng: number | null; is_active: boolean } | null }[];
  for (const m of leagues) {
    const l = m.leagues;
    if (!l?.is_active || l.home_court_lat == null || l.home_court_lng == null) continue;
    const v = await resolveVenueAt(l.home_court_lat, l.home_court_lng, 200).catch(() => null);
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
