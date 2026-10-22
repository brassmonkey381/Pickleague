// Court arrival: what the phone does when the OS says it entered or left a
// watched court (Doggle's favoriteProximity, minus routines and the home rule;
// state/court-arrival-doggle-parity.md B2 and B4). The rules and their order
// live in lib/courtArrivalRules; this file gathers the facts and acts.
//
// Arriving at a STARRED court (an Enter after an Exit) tells the server, which
// checks the player in if they are still there a minute later and pushes
// "✅ Checked in at <court>" (supabase/migration_court_arrival_queue.sql).
// Meanwhile the phone shows "At <court>? 🏓" with Check in now / Not here.
// Leaving within 5 minutes takes the check-in back, so driving past checks
// nobody in. It asks first instead ("Check in nearby?") when "Check me in
// when I arrive" is off (everywhere or for that court), a play session is
// running, who-sees-me isn't chosen yet, or there's no signal. A QR wallet
// court shows its code instead.
//
// Leaving while still checked in gets "Leaving <court>?" (Check out / Stay 1
// more hour), never an automatic check-out: background Exits can be late or
// spurious.
//
// For a player the server can't push to, the phone posts the server's
// "Checked in" and "Still at" itself (D3, lib/courtArrivalNotice), and its own
// "Check in nearby?". Not for a type the player switched off in Settings >
// Notification types: the server can't push that either, and muted means
// muted.
//
// Runs inside geofence wakes (lib/courtGeofence, possibly headless) and from
// the foreground monitor (lib/courtPromptMonitor): no React, no screens.
// Best-effort throughout: nothing here throws.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { createTimestampStore } from '@just-messin-around/expo-foundation/cache';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { postLocalNotice, promptWithFallback } from '@just-messin-around/expo-foundation/platform/push';
import { resolveUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { uuidv4 } from './analytics';
import { catalog } from './notificationActions';
import { loadUserPreferencesResult } from './userPreferences';
// Also registers the check-in buttons and the queued arrival-cancel replay, so
// a geofence wake that posts a notice has the handlers its buttons need.
import { peekCurrentCheckin, PENDING_NOT_HERE_KEY } from './courtCheckin';
import { playSession } from './playSession';
import { presenceConsentState } from './presenceConsent';
import {
  arrivalNotice,
  cancelScheduledArrivalNotices,
  clearArrivalNoticesForSignOut,
  dismissArrivalCheckinPushes,
  scheduleArrivalLocalNotices,
} from './courtArrivalNotice';
import {
  ARRIVAL_QUIET_MS,
  arrivalLocalSchedule,
  arrivalNoticeCopy,
  CANCEL_WINDOW_MS,
  checkinRemovedCopy,
  COURT_PROMPT_KIND,
  decideArrival,
  decideDeparture,
  decideLeaving,
  decidePromptDelivery,
  decideQueueAnswer,
  DEPARTURE_COOLDOWN_MS,
  exitCancels,
  NAME_LOOKUP_TIMEOUT_MS,
  NEARBY_PROMPT_TITLE,
  nearbyPromptBody,
  PREFS_LOOKUP_TIMEOUT_MS,
  PROMPT_COVERS_ARRIVAL_MS,
  promptRoute,
  STALE_ON_WAKE_MS,
  WALLET_RENOTIFY_MS,
  walletNoticeCopy,
  type CourtArrivalSettings,
  type CourtRegionInfo,
  type NearbyPromptReason,
  type QueueCourtArrivalAnswer,
} from './courtArrivalRules';
import { clearArrivalTrace, traceArrival } from './courtArrivalTrace';
import {
  cancelCourtArrivalOrQueue,
  enqueueCourtCheckinPrompt,
  loadCourtArrivalSettings,
  queueCourtArrival as queueCourtArrivalRpc,
  type EnqueueCourtPromptAnswer,
} from '../data/courtArrival';
import { getMyOpenCheckin, getVenueName } from '../data/venueCheckins';
import { peekQuery } from '@just-messin-around/expo-foundation/cache';
import { ROUTINES_ENABLED } from './features';
import { routineArrivalDue, routinePlannedEndAt } from './courtRoutineRules';
import {
  COURT_ROUTINE_SETTINGS_KEY,
  getMyCourtRoutinesOffline,
  loadCourtRoutineSettings,
  type CourtRoutineSettings,
} from '../data/courtRoutines';

// ── What this phone remembers ───────────────────────────────────────────────
// Arrivals it saw, by region (ms). Within 2 hours a re-report of the region
// (every geofence sync makes one) and the foreground monitor stay quiet: the
// arrival already queued the check-in or prompted. Marked in memory before
// any await, so a re-report handled just after the arrival sees it.
const arrivals = createTimestampStore({ storageKey: 'pickleague_court_arrivals_v1', keepMs: ARRIVAL_QUIET_MS });
// "Leaving X?" posted, by court: once per 30 minutes.
const departures = createTimestampStore({
  storageKey: 'pickleague_court_departure_prompts_v1',
  keepMs: DEPARTURE_COOLDOWN_MS,
});
/** The QR wallet notice's 3-hour throttle, on the key (and layout) it always used. */
export const WALLET_NOTICE_KEY = 'pickleague_court_fence_last_notice_v1';
const walletNotices = createTimestampStore({ storageKey: WALLET_NOTICE_KEY, keepMs: WALLET_RENOTIFY_MS });
// Not here presses waiting for signal: lib/courtCheckin keeps that list
// (PENDING_NOT_HERE_KEY); this file clears it on sign-out.

// When each court was last prompted from the background in this process. An
// arrival right after it there doesn't also queue: that prompt is on screen.
// Set only while the app isn't active: a prompt made with the app open is
// hidden (lib/push's foreground rule), so it must not silence the arrival;
// the foreground monitor's, which shows, doesn't either (the automatic
// check-in is worth more than one prompt fewer).
const promptedAt = new Map<string, number>();
// Exits by region (ms), written before any await: an Enter still in flight
// (geofence events aren't serialized) must not post "At X?" after its Exit.
const exitsMem = new Map<string, number>();
const leftSince = (regionId: string, atMs: number) => (exitsMem.get(regionId) ?? 0) >= atMs;

/**
 * Signed out for sure. A session that can't be read right now (an access
 * token that expired with no signal to refresh it, which is usual for a wake
 * an hour after the app was last used) is not: the calls below then fail as
 * network errors and take their offline paths (the queued cancel, the local
 * prompt), instead of the wake doing nothing.
 */
async function signedOut(): Promise<boolean> {
  const who = await resolveUserId(supabase);
  return who.resolved && !who.userId;
}

/**
 * The player switched this type off in Settings > Notification types. The
 * server then answers "can't push" for it, and the phone's own copy must not
 * stand in: that copy is for players the server can't reach (no token, push
 * off), not for a type they muted. Unreadable (no signal, 1.5 s): not muted.
 */
async function typeMuted(key: 'notifyAutoCheckins' | 'notifyCheckinPrompts'): Promise<boolean> {
  const r = await withTimeout(loadUserPreferencesResult(), PREFS_LOOKUP_TIMEOUT_MS).catch(() => null);
  return r?.status === 'ok' && r.prefs[key] === false;
}

/** The last arrival at this region was under `withinMs` ago (default 2 h). */
export function arrivedRecently(regionId: string, withinMs = ARRIVAL_QUIET_MS): Promise<boolean> {
  return arrivals.within(regionId, withinMs).catch(() => false);
}

/** A play session is running: the one in memory, or the saved one a fresh wake hasn't loaded. */
async function playSessionRunning(): Promise<boolean> {
  try {
    if (playSession.get().status !== 'idle') return true;
    return (await playSession.restore()).status !== 'idle';
  } catch {
    return false;
  }
}

/** Settings as cached; null when unreadable (the rules then use the defaults). */
function settingsOrNull(): Promise<CourtArrivalSettings | null> {
  return loadCourtArrivalSettings().catch(() => null);
}

/** The court's name: the one given, else a 1.5 s lookup (a wake may have no signal). */
async function courtName(venueId: string, name: string | null | undefined): Promise<string | null> {
  if (name) return name;
  return withTimeout(getVenueName(venueId), NAME_LOOKUP_TIMEOUT_MS).catch(() => null);
}

// ── Prompts ─────────────────────────────────────────────────────────────────
/**
 * "Check in nearby?" at a court: the server's push first (it holds it back
 * when I'm checked in there or was prompted in the last 30 minutes), the
 * phone's own copy only when the server can't be reached or can't push to
 * me (and "Check-in prompts" isn't switched off). Used by arrivals that ask
 * first and by the foreground monitor (hidden while the app is open, as in
 * Doggle: lib/push).
 */
export async function promptCourtCheckin(
  venueId: string,
  name?: string | null,
  reason?: NearbyPromptReason,
): Promise<void> {
  const mark = Date.now();
  if (AppState.currentState !== 'active') promptedAt.set(venueId, mark);
  let answer: EnqueueCourtPromptAnswer | null = null;
  let muted = false;
  try {
    const res = await promptWithFallback({
      enqueue: async () => {
        answer = await enqueueCourtCheckinPrompt(venueId, name, reason);
        return answer;
      },
      postLocal: async () => {
        if (await typeMuted('notifyCheckinPrompts')) {
          muted = true;
          return;
        }
        await postLocalNotice(NEARBY_PROMPT_TITLE, nearbyPromptBody(name, reason), {
          categoryId: catalog.ids.court_checkin.id,
          // Same data as the server's push: Check in reads the court from it.
          data: { kind: COURT_PROMPT_KIND, venue_id: venueId, venue_name: name ?? null, deepLink: 'home/-' },
        });
      },
    });
    const a = answer as EnqueueCourtPromptAnswer | null;
    const delivery = muted
      ? 'muted'
      : decidePromptDelivery({ unreachable: res.unreachable, enqueued: a?.enqueued, pushable: a?.pushable });
    // Held back on purpose, or muted: nothing was shown, so nothing covers an arrival.
    if (delivery === 'held' || delivery === 'muted') {
      if (promptedAt.get(venueId) === mark) promptedAt.delete(venueId);
    }
    traceArrival('prompt', { id: venueId, delivery, reason: reason ?? null, held: a?.reason ?? null });
  } catch {
    // best-effort
  }
}

/**
 * The QR wallet notice: a tap opens the code; Check in stays on it at a
 * catalog court I'm not checked in at. `standIn`: it replaces "Check in
 * nearby?" (it may come from a re-report the app-open resync made), so it
 * carries that prompt's kind and stays as quiet as it while the app is open.
 */
async function postWalletNotice(regionId: string, info: CourtRegionInfo, opts: { standIn?: boolean } = {}): Promise<void> {
  if (!info.passId) return;
  void walletNotices.mark(regionId);
  const venueId = regionId.startsWith('qr:') ? null : regionId;
  const current = venueId ? await peekCurrentCheckin().catch(() => null) : null;
  const checkedIn = !!venueId && current?.venueId === venueId;
  const copy = walletNoticeCopy(info.name);
  await postLocalNotice(copy.title, copy.body, {
    ...(venueId && !checkedIn ? { categoryId: catalog.ids.court_checkin.id } : {}),
    data: {
      ...(opts.standIn ? { kind: COURT_PROMPT_KIND } : {}),
      ...(venueId ? { venue_id: venueId } : {}),
      venue_name: info.name || null,
      deepLink: `wallet/${info.passId}`,
    },
  });
  traceArrival('notice', { id: regionId, notice: 'wallet', check_in_button: !!venueId && !checkedIn, stand_in: !!opts.standIn });
}

/** Ask first: the QR notice at a wallet court (3 h apart), else "Check in nearby?". */
async function askFirst(regionId: string, info: CourtRegionInfo | null, reason?: NearbyPromptReason): Promise<void> {
  const route = promptRoute(info, !!info?.passId && (await walletNotices.within(regionId).catch(() => false)));
  if (route === 'wallet' && info) return postWalletNotice(regionId, info, { standIn: true });
  if (route === 'quiet') return;
  await promptCourtCheckin(regionId, info?.name || null, reason);
}

// ── Arrival ─────────────────────────────────────────────────────────────────
/**
 * Tell the server I arrived at this starred court; it checks me in if I'm
 * still here in a minute, and the phone says so now ("At X?"). `handled` when
 * that's done (queued, or nothing to do); otherwise the caller asks first,
 * and `reason` says why it didn't check in by itself when I expected it to.
 */
export async function queueCourtArrival(
  venueId: string,
  info: CourtRegionInfo | null,
  arrivedAtMs: number,
  /** A routine stop's planned end, when one is due here (its check-in may end there). */
  routineEndIso: string | null = null,
): Promise<{ handled: boolean; reason?: NearbyPromptReason }> {
  let answer: QueueCourtArrivalAnswer | null = null;
  try {
    answer = await queueCourtArrivalRpc(venueId, new Date(arrivedAtMs).toISOString(), uuidv4());
  } catch {
    answer = null; // unreachable: ask first (the prompt falls back to the phone's own)
  }
  const d = decideQueueAnswer(answer);
  traceArrival('queue', {
    id: venueId,
    queued: answer?.queued ?? null,
    reason: answer ? (answer.reason ?? null) : 'unreachable',
    pushable: answer?.pushable ?? null,
  });
  if (d.action === 'quiet') return { handled: true };
  if (d.action === 'prompt') return { handled: false, ...(d.reason ? { reason: d.reason } : {}) };

  // The server can't push "Checked in" / "Still at" to me: the phone does
  // (D3), unless I switched "Auto check-ins" off (then that's why it can't).
  const [name, muted] = await Promise.all([
    courtName(venueId, info?.name),
    answer?.pushable === false ? typeMuted('notifyAutoCheckins') : Promise.resolve(false),
  ]);
  // Left while this was in flight: the Exit already cancelled it.
  if (leftSince(venueId, arrivedAtMs)) return { handled: true };
  const when = answer?.due_at ? arrivalLocalSchedule(answer.due_at, routineEndIso) : null;
  const checkinId = answer?.checkin_id;
  const local = answer?.pushable === false && !muted && !!when && !!checkinId;
  if (local && when && checkinId) {
    await scheduleArrivalLocalNotices({ venueId, venueName: name, checkinId, ...when });
    traceArrival('local_checkin', { id: venueId, checkin_id: checkinId });
  }
  const copy = arrivalNoticeCopy(name, info?.passId);
  await arrivalNotice.post(venueId, copy.title, copy.body, {
    atMs: arrivedAtMs,
    data: { deepLink: copy.deepLink, venue_name: name },
  });
  traceArrival('notice', { id: venueId, notice: 'arriving', wallet: !!info?.passId });
  // The Exit's dismiss may have run before the notice (or the schedule) was up.
  if (leftSince(venueId, arrivedAtMs)) {
    await arrivalNotice.dismiss(venueId);
    if (local) await cancelScheduledArrivalNotices(venueId);
  }
  return { handled: true };
}

/**
 * A routine stop of mine is due at this court now and "Check me in at my
 * routine courts" is on, from the copies on this phone (a week on disk; the
 * settings unreadable count as on, the default). Never waits on the network
 * when a copy exists.
 */
async function routineDueHere(venueId: string, atMs: number): Promise<{ due: boolean; plannedEndAt: string | null }> {
  const cachedSettings = peekQuery<CourtRoutineSettings>(COURT_ROUTINE_SETTINGS_KEY);
  const [routines, settings] = await Promise.all([
    getMyCourtRoutinesOffline().catch(() => null),
    cachedSettings ? Promise.resolve(cachedSettings) : loadCourtRoutineSettings().catch(() => null),
  ]);
  const at = new Date(atMs);
  if (!routineArrivalDue(routines, venueId, settings ? settings.routine_auto_checkin : null, at)) {
    return { due: false, plannedEndAt: null };
  }
  return { due: true, plannedEndAt: routines ? routinePlannedEndAt(routines, venueId, at) : null };
}

const NOT_DUE = { due: false, plannedEndAt: null } as const;

/**
 * The geofence Enter. `arrival`: the region was last seen outside
 * (geofenceRegionState), not the re-report every sync makes. `info`: what
 * the last sync saved about the region (may still be loading: the arrival is
 * marked first, before any await).
 */
export async function handleCourtArrival(
  regionId: string,
  opts: { arrival: boolean; info: CourtRegionInfo | null | Promise<CourtRegionInfo | null> },
): Promise<void> {
  const arrivedAtMs = Date.now();
  // Before any await, so the re-report a sync makes right after sees it.
  if (opts.arrival) void arrivals.mark(regionId, arrivedAtMs);
  traceArrival('enter', { id: regionId, arrival: opts.arrival });
  try {
    void arrivalNotice.dismissStale(STALE_ON_WAKE_MS);
    const info = await Promise.resolve(opts.info).catch(() => null);
    // Signed out (the session went without a sign-out): nothing here is mine.
    if (await signedOut()) return;
    // Only a starred court needs the rest; the rules don't read them otherwise.
    const starred = info?.starred === true;
    const [settings, recently, session, consent, walletThrottled, routine] = await Promise.all([
      starred ? settingsOrNull() : Promise.resolve(null),
      starred && !opts.arrival ? arrivedRecently(regionId) : Promise.resolve(false),
      starred && opts.arrival ? playSessionRunning() : Promise.resolve(false),
      starred && opts.arrival
        ? withTimeout(presenceConsentState(), NAME_LOOKUP_TIMEOUT_MS).catch(() => 'unknown' as const)
        : Promise.resolve('unknown' as const),
      info?.passId ? walletNotices.within(regionId).catch(() => false) : Promise.resolve(false),
      // A routine stop due here, from this phone's copy (no network wait).
      ROUTINES_ENABLED && info?.routine && opts.arrival
        ? withTimeout(routineDueHere(regionId, arrivedAtMs), NAME_LOOKUP_TIMEOUT_MS).catch(() => NOT_DUE)
        : Promise.resolve(NOT_DUE),
    ]);
    const d = decideArrival({
      routineDue: routine.due,
      arrival: opts.arrival,
      info,
      settings,
      arrivedRecently: recently,
      promptedRecently: arrivedAtMs - (promptedAt.get(regionId) ?? 0) < PROMPT_COVERS_ARRIVAL_MS,
      playSessionActive: session,
      consent,
      walletThrottled,
    });
    traceArrival('decision', {
      id: regionId,
      action: d.action,
      why: d.action === 'quiet' ? d.why : d.action === 'prompt' ? (d.reason ?? null) : null,
    });
    if (d.action === 'quiet') return;
    if (d.action === 'wallet') {
      if (info) await postWalletNotice(regionId, info, { standIn: d.standIn === true });
      return;
    }
    if (d.action === 'prompt') {
      await promptCourtCheckin(regionId, info?.name || null, d.reason);
      return;
    }
    const res = await queueCourtArrival(regionId, info, arrivedAtMs, routine.plannedEndAt);
    if (!res.handled) await askFirst(regionId, info, res.reason);
  } catch {
    // best-effort
  }
}

// ── Departure ───────────────────────────────────────────────────────────────
/**
 * The geofence Exit: take "At X?" down, and drop a waiting arrival (left
 * within the minute: no check-in) or take back the check-in it became (left
 * within 5 minutes: a drive-by). Then, if I'm still checked in there, post
 * "Leaving <court>?" with Check out / Stay 1 more hour. Skipped while a play
 * session runs and when "Remind me to check out when I leave" is off.
 */
export async function handleCourtDeparture(
  regionId: string,
  opts: { info?: CourtRegionInfo | null | Promise<CourtRegionInfo | null> } = {},
): Promise<void> {
  // A prompt from this visit doesn't cover the next one.
  promptedAt.delete(regionId);
  exitsMem.set(regionId, Date.now());
  traceArrival('exit', { id: regionId });
  try {
    void arrivalNotice.dismiss(regionId);
    void arrivalNotice.dismissStale(STALE_ON_WAKE_MS);
    const infoP = Promise.resolve(opts.info ?? null).catch(() => null);
    if (await signedOut()) return;

    let cancel: Awaited<ReturnType<typeof cancelCourtArrivalOrQueue>> | null = null;
    if (exitCancels(regionId, await arrivedRecently(regionId, CANCEL_WINDOW_MS))) {
      cancel = await cancelCourtArrivalOrQueue(regionId).catch(() => null);
      traceArrival('cancel', {
        id: regionId,
        queued: cancel?.queued ?? null,
        dropped: cancel?.result?.dropped ?? null,
        removed: cancel?.result?.removed ?? null,
        closed: cancel?.result?.closed ?? null,
      });
      // Stopped before it became a check-in (or it will be, once sent): the
      // phone's own "Checked in" must not go off.
      if (cancel?.queued || cancel?.result?.dropped) void cancelScheduledArrivalNotices(regionId);
    }
    const [session, settings] = await Promise.all([playSessionRunning(), settingsOrNull()]);
    const d = decideDeparture({ cancel, playSessionActive: session, settings });
    traceArrival('departure', { id: regionId, action: d.action, why: d.action === 'quiet' ? d.why : null });
    if (d.action === 'took_back') {
      // Its "Checked in" / "Still at" now describe a visit that didn't count.
      const shown = await dismissArrivalCheckinPushes(regionId).catch(() => 0);
      // Said only when one was on screen: never told, nothing to correct.
      if (shown > 0) {
        const copy = checkinRemovedCopy((await infoP)?.name);
        await postLocalNotice(copy.title, copy.body, { data: { deepLink: 'home/-' } });
        traceArrival('notice', { id: regionId, notice: 'removed' });
      }
      return;
    }
    if (d.action === 'quiet') return;

    // From the server (cached with stale-if-error), so a check-in the server
    // made on arrival while the app was closed counts too.
    const open = await getMyOpenCheckin().catch(() => null);
    const leaving = decideLeaving({
      regionId,
      open: open ? { ...open, id: open.id ?? null } : null,
      lastPromptAtMs: await departures.at(regionId).catch(() => undefined),
      nowMs: Date.now(),
      regionName: (await infoP)?.name,
    });
    if (leaving.action === 'quiet') {
      traceArrival('departure', { id: regionId, action: 'quiet', why: leaving.why });
      return;
    }
    void departures.mark(regionId);
    await postLocalNotice(leaving.title, leaving.body, {
      categoryId: catalog.ids.checkin_extend.id,
      data: leaving.data,
    });
    traceArrival('notice', { id: regionId, notice: 'leaving', via_arrival: leaving.data.via_arrival });
  } catch {
    // best-effort
  }
}

// ── Sign-out ────────────────────────────────────────────────────────────────
/**
 * A real sign-out: forget this account's arrivals, reminders, waiting Not
 * here presses and trace, and take its court notices down (they name its
 * courts). Doggle kept them; the next account must not inherit them.
 */
export async function clearCourtArrivalForSignOut(): Promise<void> {
  promptedAt.clear();
  exitsMem.clear();
  await Promise.all([
    arrivals.clear(),
    departures.clear(),
    walletNotices.clear(),
    AsyncStorage.removeItem(PENDING_NOT_HERE_KEY).catch(() => {}),
    clearArrivalNoticesForSignOut().catch(() => {}),
    clearArrivalTrace(),
  ]);
  // After the clear (one queue), so the trace starts at this sign-out.
  traceArrival('signout');
}
