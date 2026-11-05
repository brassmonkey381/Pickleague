// The two background watches that judge a court by its outline (Doggle's
// arrivalWatch + visitWatch; the engine is expo-foundation 1.104's
// createArrivalWatch / createVisitWatch). This file keeps Pickleague's task
// names, storage keys, copy and callbacks.
//
//   Arrival watch: a starred, routine or nearby court's circle woke the phone,
//     but the phone isn't on the court's outline yet (a big park's circle
//     holds the lot and the street). Short background location updates run
//     until a reading is on it (then the arrival goes on as usual,
//     lib/courtArrival), the circle's Exit stops it, or 20 minutes pass.
//
//   Visit watch: while I'm checked in at a court with an outline, readings run
//     until 2 in a row are off it ("Leaving X?", lib/courtArrival), the
//     check-in closes (re-read every 5 minutes), or 4 hours pass. It replaces
//     the circle's Exit for that reminder; a court without an outline keeps
//     the circle. The 5-minute take-back stays on the Exit.
//
// Both need "Always" location and never ask for it. Android shows a
// notification while one runs (the OS requires it); iPhone shows the blue
// location pill. Created at module load: lib/courtGeofence imports this file,
// and index.ts loads that at startup, so the OS can deliver to the tasks on a
// background wake. No-ops on web.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { stopBackgroundLocationUpdates } from '@just-messin-around/expo-foundation/platform/location';
import { createArrivalWatch, createVisitWatch } from '@just-messin-around/expo-foundation/tracking';
import { subscribeQueryKey } from '@just-messin-around/expo-foundation/cache';
import { arrivalWatchNotice, PL_OUTLINE_RULE, visitWatchNotice } from './courtArrivalRules';
import { getCourtOutline } from './courtOutline';
import { traceArrival } from './courtArrivalTrace';
import { getMyOpenCheckin, MY_OPEN_CHECKIN_KEY } from '../data/venueCheckins';

/** Install-stable: the OS keeps delivering to these names across app updates. */
export const COURT_ARRIVAL_WATCH_TASK = 'pickleague-court-arrival-watch';
export const COURT_VISIT_WATCH_TASK = 'pickleague-court-visit-watch';

// Required lazily, not imported: lib/courtArrival imports this file.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const arrival = () => require('./courtArrival') as typeof import('./courtArrival');

const ARRIVAL_WATCHES_KEY = 'pickleague_court_arrival_watches_v1';

const arrivalWatch = createArrivalWatch({
  taskName: COURT_ARRIVAL_WATCH_TASK,
  storageKey: ARRIVAL_WATCHES_KEY,
  // Only the outlines saved at the last sync: a wake shouldn't wait on the network.
  getOutline: (id) => getCourtOutline(id, { fetch: false }),
  rule: PL_OUTLINE_RULE,
  notification: (name) => arrivalWatchNotice(name),
  // Event names and verdicts only: no coordinates in the trace.
  log: (event, d) => traceArrival(event, { id: d.id, started: d.started ?? null, verdict: d.verdict ?? null }),
  onInside: async (id) => {
    await arrival().handleCourtArrivalOnOutline(id);
  },
});

const visitWatch = createVisitWatch({
  taskName: COURT_VISIT_WATCH_TASK,
  storageKey: 'pickleague_court_visit_watches_v1',
  // A manual check-in at a court nobody starred: its outline from get_court, once.
  getOutline: (id) => getCourtOutline(id),
  rule: PL_OUTLINE_RULE,
  // One open check-in per player (S11). Unreadable: keep watching.
  listOpenIds: async () => {
    const open = await getMyOpenCheckin().catch(() => undefined);
    if (open === undefined) return null;
    return open?.id ? [open.venue_id] : [];
  },
  notification: (names) => visitWatchNotice(names),
  log: (event, d) => traceArrival(event, { id: d.id, started: d.started ?? null }),
  onLeft: async (id, { name }) => {
    await arrival().remindCourtDeparture(id, { name: name ?? null });
  },
});

/** Watch this court until the phone is on its outline. False when the OS won't run updates (no "Always"). */
export const startCourtArrivalWatch = (venueId: string, name?: string | null) =>
  arrivalWatch.start(venueId, name ?? undefined).catch(() => false);
/** Stop looking for this court (its Exit, or the arrival ran). */
export const stopCourtArrivalWatch = (venueId: string) => arrivalWatch.stop(venueId).catch(() => undefined);

/** Watch this visit until I leave the court. False when it can't run (web, no outline, no "Always"). */
export const startCourtVisitWatch = (venueId: string, name?: string | null) =>
  visitWatch.start(venueId, name ?? undefined).catch(() => false);
export const stopCourtVisitWatch = (venueId: string) => visitWatch.stop(venueId).catch(() => undefined);
export const stopAllCourtVisitWatches = () => visitWatch.stopAll().catch(() => undefined);

/** This court's "Leaving X?" is the visit watch's (it has an outline and is watching), not the circle's Exit. */
export async function visitWatchOwnsDeparture(venueId: string): Promise<boolean> {
  try {
    return (await visitWatch.hasOutline(venueId)) && (await visitWatch.isWatching(venueId));
  } catch {
    return false;
  }
}

/**
 * Match the visit watch to my open check-in: start it at a court with an
 * outline, drop it when the check-in closed. On app open and whenever my open
 * check-in changes in the app.
 */
export const syncCourtVisitWatches = () => visitWatch.sync().catch(() => undefined);

let unsubscribe: (() => void) | null = null;
/** Follow my open check-in (every check-in write in data/venueCheckins drops it). Once per process. */
export function followMyOpenCheckin(): void {
  if (Platform.OS === 'web' || unsubscribe) return;
  unsubscribe = subscribeQueryKey(MY_OPEN_CHECKIN_KEY, () => void syncCourtVisitWatches());
}

/** A real sign-out: every watch stops and is forgotten (they name this account's courts). */
export async function stopAllCourtWatches(): Promise<void> {
  if (Platform.OS === 'web') return;
  await visitWatch.stopAll().catch(() => undefined);
  await AsyncStorage.removeItem(ARRIVAL_WATCHES_KEY).catch(() => {});
  await stopBackgroundLocationUpdates(COURT_ARRIVAL_WATCH_TASK).catch(() => undefined);
}
