// The notices court arrival puts on the lock screen and takes down again.
//
// "At <court>? 🏓" is posted the moment the phone arrives at a starred court:
// the server checks the player in a minute later, and meanwhile the notice
// offers Check in now / Not here (catalog court_arriving). Each arrival gets
// its own id, because the response router dedupes presses by id; the notice
// is found again by its data (kind + venue_id), to take it down on Exit, on a
// press, or once it's stale (foundation createKindedNotice).
//
// For players the server can't push to (no token, or push off), the phone
// also schedules the server's "✅ Checked in at <court>" and "Still at
// <court>?" itself (decision D3), under the ids arrival_checkin:<checkin id>
// and arrival_extend:<checkin id>. Which court each belongs to, and when they
// go off, is kept here, so a take-back, a Not here, a check-in made another
// way or a sign-out can cancel them before they go off, and a check-in the
// server never made can be found out once the app reads the server again.
//
// Headless-safe (geofence wakes and notice buttons): no React, no screens.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cancelLocalNotification,
  createKindedNotice,
  dismissLocalNotices,
  scheduleLocalNotification,
} from '@just-messin-around/expo-foundation/platform/push';
import { catalog } from './notificationActions';
import {
  ARRIVAL_CHECKIN_KIND,
  ARRIVAL_EXPIRED_KIND,
  ARRIVAL_EXTEND_KIND,
  ARRIVAL_FAILED_KIND,
  ARRIVAL_NOTICE_KIND,
  arrivalCheckedInCopy,
  arrivalEntriesToSettle,
  arrivalStillAtCopy,
  COURT_PROMPT_KIND,
  DEPARTURE_NOTICE_KIND,
  reconcileArrivalEntries,
  waitingArrivalVenues,
  type ArrivalLocalEntry,
} from './courtArrivalRules';

/** The "At X?" buttons (lib/notificationCatalog.data.ts). */
export const COURT_ARRIVING_CATEGORY = 'court_arriving';

/** "At X?". post(venueId, title, body, { atMs: arrivedAtMs, data }) replaces that court's older one. */
export const arrivalNotice = createKindedNotice({
  kind: ARRIVAL_NOTICE_KIND,
  idPrefix: 'arrival',
  entityKey: 'venue_id',
  categoryId: COURT_ARRIVING_CATEGORY,
  // Registered before the first post: an Android geofence wake runs with no
  // app around it, and would otherwise post the notice without its buttons.
  registration: catalog.registrationMap[COURT_ARRIVING_CATEGORY],
});

// ── The phone's own "Checked in" / "Still at" (D3) ──────────────────────────
const LOCAL_KEY = 'pickleague_arrival_local_notices_v1';

const checkedInId = (checkinId: string) => `${ARRIVAL_CHECKIN_KIND}:${checkinId}`;
const stillAtId = (checkinId: string) => `${ARRIVAL_EXTEND_KIND}:${checkinId}`;

type LocalMap = Record<string, ArrivalLocalEntry>;

function isEntry(v: unknown): v is ArrivalLocalEntry {
  const e = v as ArrivalLocalEntry | null;
  return !!e && typeof e === 'object' && typeof e.id === 'string' && Number.isFinite(e.at) && Number.isFinite(e.until);
}

// venue id -> the check-in its scheduled notices are for, and when they go
// off. One write at a time, so an arrival and a cancel at once can't lose
// each other's entry. Resolves the map as it was before `fn`.
let chain: Promise<unknown> = Promise.resolve();
function update(fn: (map: LocalMap) => LocalMap): Promise<LocalMap> {
  const run = chain.then(async () => {
    const map: LocalMap = {};
    try {
      const raw = await AsyncStorage.getItem(LOCAL_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [venue, e] of Object.entries(parsed)) if (isEntry(e)) map[venue] = e;
      }
    } catch {
      // unreadable: start over
    }
    const next = fn({ ...map });
    try {
      if (Object.keys(next).length) await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(next));
      else await AsyncStorage.removeItem(LOCAL_KEY);
    } catch {
      // best-effort: at worst a cancel misses a notice it could have caught
    }
    return map;
  });
  chain = run.catch(() => undefined);
  return run.catch(() => ({}));
}

const cancelBoth = (checkinId: string) =>
  Promise.all([cancelLocalNotification(checkedInId(checkinId)), cancelLocalNotification(stillAtId(checkinId))]);

/** Drop the courts `pick` names from the list, and cancel what they scheduled. */
async function cancelVenues(pick: (map: LocalMap) => string[]): Promise<void> {
  let picked: string[] = [];
  const before = await update((m) => {
    picked = pick(m);
    for (const venue of picked) delete m[venue];
    return m;
  });
  await Promise.all(picked.map((venue) => (before[venue] ? cancelBoth(before[venue].id) : undefined)));
}

/**
 * Schedule the server's "Checked in" and "Still at" on this phone, for a
 * player it can't push to. Their buttons (Stay 1 more hour / Check out) need
 * the check-in's id and end, so the data is the server push's.
 */
export async function scheduleArrivalLocalNotices(p: {
  venueId: string;
  venueName: string | null;
  checkinId: string;
  checkedInAtMs: number;
  stillAtAtMs: number;
  expiresAtIso: string;
}): Promise<void> {
  const data = {
    venue_id: p.venueId,
    venue_name: p.venueName,
    checkin_id: p.checkinId,
    expires_at: p.expiresAtIso,
    via_arrival: true,
    deepLink: 'home/-',
  };
  const categoryId = catalog.ids.checkin_extend.id;
  // A newer arrival here replaces the older one's notices.
  const before = await update((m) => ({
    ...m,
    [p.venueId]: { id: p.checkinId, at: p.checkedInAtMs, until: p.stillAtAtMs },
  }));
  const old = before[p.venueId]?.id;
  if (old && old !== p.checkinId) await cancelBoth(old);
  const checkedIn = arrivalCheckedInCopy(p.venueName);
  const stillAt = arrivalStillAtCopy(p.venueName);
  await Promise.all([
    scheduleLocalNotification({
      id: checkedInId(p.checkinId),
      at: p.checkedInAtMs,
      ...checkedIn,
      categoryId,
      data: { ...data, kind: ARRIVAL_CHECKIN_KIND },
    }),
    scheduleLocalNotification({
      id: stillAtId(p.checkinId),
      at: p.stillAtAtMs,
      ...stillAt,
      categoryId,
      data: { ...data, kind: ARRIVAL_EXTEND_KIND },
    }),
  ]);
}

/**
 * Cancel one check-in's scheduled "Checked in" / "Still at": it was
 * extended (Stay 1 more hour sends its own reminder) or checked out.
 * Notices already on screen stay (dismissArrivalCheckinPushes).
 */
export async function cancelArrivalLocalNotices(checkinId: string): Promise<void> {
  await cancelBoth(checkinId);
  await update((m) => {
    for (const [venue, e] of Object.entries(m)) if (e.id === checkinId) delete m[venue];
    return m;
  });
}

/** Cancel this court's scheduled ones (the arrival was cancelled before it became a check-in). */
export function cancelScheduledArrivalNotices(venueId: string): Promise<void> {
  return cancelVenues((m) => (m[venueId] ? [venueId] : []));
}

/**
 * Cancel every court's scheduled ones: I checked in with a fix, or a play
 * session of mine started. The server then skips an arrival still waiting
 * (a check-in or a session of mine is open), and one that already landed was
 * closed or extended by it, so its "Checked in" / "Still at" would be wrong.
 */
export function cancelAllScheduledArrivalNotices(): Promise<void> {
  return cancelVenues((m) => Object.keys(m));
}

/**
 * Automatic check-in was switched off at this court (its switch, its star),
 * or everywhere (no `venueId`: "Check me in when I arrive" off, "Notice me"
 * Off): take down "At X?", and the phone's own notices for an arrival still
 * waiting out its minute (the server skips it now). A check-in that already
 * landed stays open, and so do its notices.
 */
export async function dropWaitingArrivalNotices(venueId?: string): Promise<void> {
  await Promise.all([
    venueId ? arrivalNotice.dismiss(venueId) : arrivalNotice.dismissAll(),
    cancelVenues((m) => waitingArrivalVenues(m, Date.now(), venueId)),
  ]);
}

/** Phone-made notices old enough for reconcileArrivalLocalNotices to settle (no server read otherwise). */
export async function arrivalLocalNoticesToSettle(): Promise<boolean> {
  return arrivalEntriesToSettle(await update((m) => m), Date.now());
}

/**
 * Check the phone's own notices against my open check-in, just read from the
 * server (lib/courtCheckin refreshCurrentCheckin): those for a check-in that
 * never happened or is over are cancelled, and taken down if on screen.
 */
export async function reconcileArrivalLocalNotices(open: { id: string | null } | null): Promise<void> {
  const ids: string[] = [];
  await update((m) => {
    const r = reconcileArrivalEntries(m, open, Date.now());
    for (const venue of r.cancel) ids.push(m[venue].id);
    for (const venue of [...r.cancel, ...r.forget]) delete m[venue];
    return m;
  });
  if (!ids.length) return;
  await Promise.all(ids.map(cancelBoth));
  await dismissLocalNotices(
    (n) =>
      (n.data.kind === ARRIVAL_CHECKIN_KIND || n.data.kind === ARRIVAL_EXTEND_KIND) &&
      typeof n.data.checkin_id === 'string' &&
      ids.includes(n.data.checkin_id),
  );
}

/**
 * The arrival check-in at this court was taken back or checked out: its
 * "Checked in" and "Still at" (the server's pushes and the phone's own,
 * shown or still scheduled) would point at a visit that is over. Resolves
 * how many were on screen (the player may have read one).
 */
export async function dismissArrivalCheckinPushes(venueId: string): Promise<number> {
  await cancelScheduledArrivalNotices(venueId);
  return dismissLocalNotices(
    (n) =>
      (n.data.kind === ARRIVAL_CHECKIN_KIND || n.data.kind === ARRIVAL_EXTEND_KIND) && n.data.venue_id === venueId,
  );
}

const COURT_ARRIVAL_KINDS = new Set<string>([
  ARRIVAL_NOTICE_KIND,
  ARRIVAL_CHECKIN_KIND,
  ARRIVAL_EXTEND_KIND,
  ARRIVAL_FAILED_KIND,
  ARRIVAL_EXPIRED_KIND,
  COURT_PROMPT_KIND,
  DEPARTURE_NOTICE_KIND,
]);

/** A real sign-out: every court arrival notice names the last account's courts. */
export async function clearArrivalNoticesForSignOut(): Promise<void> {
  await cancelAllScheduledArrivalNotices();
  await dismissLocalNotices((n) => typeof n.data.kind === 'string' && COURT_ARRIVAL_KINDS.has(n.data.kind));
}
