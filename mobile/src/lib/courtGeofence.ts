// Court arrival alerts (work order 7f): when the phone enters a fenced court,
// post a local "You're at <court>" notice with a Check in button. It never
// checks in on its own (lower App Store review risk, and no surprise presence).
// The button takes a fresh fix like every check-in (no manual check-ins), and
// the server confirms it. Leaving the court checks out only check-ins this
// feature opened.
//
// QR wallet (lib/qrWallet): a court with a saved front desk code gets
// "Tap to show your check-in QR code" instead, and the tap opens the code.
// Those courts are fenced before any other, so the 20 limit never drops one.
//
// Opt-in per device (Settings), because it needs "Always" location. Fences:
// QR wallet courts, then my starred courts (with FRIENDS_AT_COURTS_ENABLED; the same order as
// Home's YOUR COURTS), then my leagues' home courts (the stored
// leagues.home_venue_id, else the pickleball court at the league's
// coordinates), then the courts I check in at most; at most 20 (the iOS
// per-app limit). Starring or unstarring a court re-syncs them.
//
// defineCourtGeofenceTask() must run at the entry module's scope (index.ts):
// the OS can wake the app headless to deliver an event. Native only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { defineGeofenceTask, syncGeofences, type GeofenceRegion } from '@just-messin-around/expo-foundation/tracking';
import { postLocalNotice } from '@just-messin-around/expo-foundation/platform/push';
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { catalog, NeedsApp, refusalNeedsApp, registerActionHandler, requireUser } from './notificationActions';
import { checkInAt, checkOut, impreciseFixReason, peekCurrentCheckin, takeCheckinFix } from './courtCheckin';
import { offersUntrackedSession } from './courtCheckinRules';
import { FRIENDS_AT_COURTS_ENABLED } from './features';
import { presenceConsentState } from './presenceConsent';
import { checkedInVisibilityLine, DEFAULT_PRESENCE_SETTINGS } from './presencePrivacy';
import { noteRefusalNotice } from './refusalNotices';
import { queuedRefusalNotice, refusalCopy } from './refusals';
import { loadPresenceSettings } from '../data/presenceSettings';
import { getMyLeagueCourts, getVenuesByIds, resolveCourtAt } from '../data/venueCheckins';
import { listMyCourtFavorites } from '../data/courtFavorites';
import { listPasses, walletRegionId } from './qrWallet';

export const COURT_GEOFENCE_TASK = 'pickleague-court-geofence';
const ENABLED_KEY = 'pickleague_court_alerts_enabled_v1';
const NAMES_KEY = 'pickleague_court_fence_names_v1';
const LAST_NOTICE_KEY = 'pickleague_court_fence_last_notice_v1';
// region id -> QR wallet pass id. Saved at sync, because the headless task
// can't look the wallet up by user.
const WALLET_KEY = 'pickleague_court_fence_wallet_v1';
const RENOTIFY_MS = 3 * 3600_000;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function onEnter(regionId: string): Promise<void> {
  const passId = (await readJson<Record<string, string>>(WALLET_KEY, {}))[regionId];
  // A wallet spot picked by GPS has no court row: "qr:<pass id>".
  const venueId = regionId.startsWith('qr:') ? null : regionId;
  const current = await peekCurrentCheckin();
  const checkedIn = !!venueId && current?.venueId === venueId;
  if (checkedIn && !passId) return;
  const last = await readJson<Record<string, number>>(LAST_NOTICE_KEY, {});
  if (last[regionId] && Date.now() - last[regionId] < RENOTIFY_MS) return;
  last[regionId] = Date.now();
  await AsyncStorage.setItem(LAST_NOTICE_KEY, JSON.stringify(last)).catch(() => {});
  const names = await readJson<Record<string, string>>(NAMES_KEY, {});
  const name = names[regionId] ?? 'the courts';
  if (passId) {
    await postLocalNotice(`You're at ${name}`, 'Tap to show your check-in QR code.', {
      // Check in stays on the notice at a catalog court you aren't checked in at.
      ...(venueId && !checkedIn ? { categoryId: catalog.ids.court_checkin.id } : {}),
      data: { ...(venueId ? { venue_id: venueId } : {}), venue_name: name, deepLink: `wallet/${passId}` },
    });
    return;
  }
  await postLocalNotice(`You're at ${name}`, 'Check in so other players know you are here.', {
    categoryId: catalog.ids.court_checkin.id,
    // A tap opens Home's court card, where Check in lives.
    data: { venue_id: venueId, venue_name: name, deepLink: 'home/-' },
  });
}

async function onExit(venueId: string): Promise<void> {
  const current = await peekCurrentCheckin();
  if (current && current.venueId === venueId && current.source === 'geofence') {
    // No check-out fix: I've left the fence, so one taken here proves no stay.
    // No signal queues it; a refusal is said (the player isn't watching).
    const tapMs = Date.now();
    await checkOut(current.id, 'geofence', { fix: false }).catch((e: unknown) =>
      noteRefusalNotice({
        key: `checkout:${current.id}`,
        title: "Check-out didn't go through",
        body: queuedRefusalNotice({
          what: 'check_out',
          venueName: current.venueName,
          tapMs,
          error: e,
          untilMs: Date.parse(current.expiresAt),
        }),
        link: 'home/-',
      }),
    );
  }
}

/** Call once from index.ts at module scope. */
export function defineCourtGeofenceTask(): void {
  defineGeofenceTask(COURT_GEOFENCE_TASK, {
    onEnter: (e) => onEnter(e.id),
    onExit: (e) => onExit(e.id),
  });
}

// The button's deadline: a 5 s fix, then the up-to-9 s write (the kit default
// of 10 s cut real refusals off as "May not have saved").
const COURT_CHECKIN_TIMEOUT_MS = 15_000;

/** Who sees me now, from the cached settings (defaults when unreadable within 1 s). */
async function visibilityNow(): Promise<string> {
  const s = await withTimeout(loadPresenceSettings(), 1_000).catch(() => DEFAULT_PRESENCE_SETTINGS);
  return checkedInVisibilityLine(s, Date.now());
}

registerActionHandler('court_checkin', {
  timeoutMs: COURT_CHECKIN_TIMEOUT_MS,
  success: (res) => ({
    title: 'Checked in',
    body: (res as { visibility?: string } | null)?.visibility ?? 'Other players can see you are here.',
  }),
  queued: { title: 'Checked in', body: 'Saved with no signal. It counts if it syncs within 2 minutes.' },
  run: async (d) => {
    const runStart = Date.now();
    await requireUser();
    if (!d.venue_id) {
      throw new NeedsApp("This alert didn't say which court you're at. Open Pickleague to check in.", 'home/-', 'Not checked in');
    }
    const court = d.venue_name ?? null;
    // The one-time "who sees you at the courts" sheet can't show on the lock
    // screen: until it was accepted, check in from the app. No connection is
    // its own reason (the answer may be on the server).
    const consent = await presenceConsentState();
    if (consent !== 'yes') {
      throw new NeedsApp(
        consent === 'unknown'
          ? refusalCopy('consent.unknown_offline')
          : 'First choose who sees you at the courts. Open Pickleague to choose, then check in.',
        'home/-',
        'Not checked in',
      );
    }
    // Arrival alerts run on "Always" location, so this reads a fix without a
    // dialog. 5 s leaves the write its share of the button's deadline.
    const fix = await takeCheckinFix(5_000);
    if (!fix) {
      // An approximate location (Precise Location off) says so; else no fix at all.
      throw new NeedsApp(
        impreciseFixReason() ??
          "Pickleague couldn't get your location to confirm you're at the court. Open Pickleague at the court to check in.",
        'home/-',
        'Not checked in',
      );
    }
    try {
      const c = await checkInAt({ id: d.venue_id, name: court ?? 'the courts' }, fix, { source: 'geofence' });
      return c.queued ? { queued: true } : { ...c, visibility: await visibilityNow() };
    } catch (e) {
      // A refusal that lands after the button's deadline (its "May not have
      // saved" notice is already up) still reaches the player.
      if (Date.now() - runStart >= COURT_CHECKIN_TIMEOUT_MS - 250) {
        void noteRefusalNotice({
          key: `court_checkin:${d.venue_id}:${runStart}`,
          title: "Check-in didn't go through",
          body: queuedRefusalNotice({ what: 'check_in', venueName: court, tapMs: runStart, error: e }),
          link: 'home/-',
        });
      }
      // Why, in words: how far from the court, too vague, out of date, the
      // court is gone, signed out (lib/refusals).
      const why = refusalNeedsApp(e, { venueName: court, action: 'check_in' }, 'home/-');
      if (why) throw why;
      if (offersUntrackedSession(e)) throw new NeedsApp((e as Error).message, 'home/-', 'Not checked in');
      throw e;
    }
  },
});

export async function getCourtAlertsEnabled(): Promise<boolean> {
  return (await readJson<boolean>(ENABLED_KEY, false)) === true;
}

/** Which courts to fence: QR wallet courts, starred courts, league home courts, then my most-used check-in courts. */
async function pickRegions(): Promise<{
  regions: GeofenceRegion[];
  names: Record<string, string>;
  wallet: Record<string, string>;
}> {
  const uid = await currentUserId(supabase);
  if (!uid) return { regions: [], names: {}, wallet: {} };
  const regions: GeofenceRegion[] = [];
  const names: Record<string, string> = {};
  const wallet: Record<string, string> = {};
  const add = (v: { id: string; name: string; lat: number; lng: number; radius?: number | null }) => {
    if (names[v.id] || regions.length >= 20) return;
    names[v.id] = v.name;
    regions.push({ id: v.id, lat: v.lat, lng: v.lng, radiusM: v.radius ?? 100 });
  };

  // One pass per court is enough to open the wallet; the first saved wins.
  for (const p of await listPasses()) {
    const id = walletRegionId(p);
    if (wallet[id]) continue;
    add({ id, name: p.venueName, lat: p.lat, lng: p.lng });
    if (names[id]) wallet[id] = p.id;
  }

  // Then starred courts, as in YOUR COURTS (ids are already canonical; the
  // RPC has no radius, so the default). A failed read never drops the rest.
  if (FRIENDS_AT_COURTS_ENABLED) {
    const favs = await listMyCourtFavorites().catch(() => []);
    for (const f of favs) {
      if (f.lat == null || f.lng == null) continue;
      add({ id: f.venue_id, name: f.venue_name, lat: f.lat, lng: f.lng });
    }
  }

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
  return { regions, names, wallet };
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
    const { regions, names, wallet } = await pickRegions();
    await AsyncStorage.multiSet([
      [NAMES_KEY, JSON.stringify(names)],
      [WALLET_KEY, JSON.stringify(wallet)],
    ]).catch(() => {});
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
  await AsyncStorage.multiRemove([NAMES_KEY, LAST_NOTICE_KEY, WALLET_KEY]).catch(() => {});
}
