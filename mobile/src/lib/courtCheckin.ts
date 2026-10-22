// Court check-in, app side: check in / extend / check out, the offline queue,
// the "5 minutes left" reminder and its lock-screen buttons.
//
// No manual check-ins: every check-in carries a fresh device fix (lat, lng,
// accuracy, fix time) and the server confirms it is inside the court's fence
// (docs/play-sessions-presence.md, rule 1). No fix, no check-in: callers offer
// an untracked play session instead. The pure rules live in ./courtCheckinRules.
//
// The current check-in is cached locally (per user) so a check-in made with no
// signal shows straight away and the reminder can be rescheduled. The server
// row is the truth once it lands; refreshCurrentCheckin() reconciles, and the
// id the server returns is adopted (it may hand back a check-in I already had
// at that court).
//
// Queued writes: a check-in is safe to apply late because it carries its real
// time (`at`), the fix taken at tap time, and a client id (replays land once).
// The server judges the fix at the tap (taken within 2 minutes of it) and
// takes the check-in up to 12 hours after the tap (migration_checkin_tap_time
// .sql, decided 2026-10-16). One that lands while it would still run is
// adopted as usual; one that lands after it would have ended is stored as a
// visit nobody saw, and the player is told once; one refused (over 12 hours,
// or a real refusal) is dropped and the player is told why. A check-out
// carries when I really left and the fix taken at the tap, if one came back
// within 3 s (the stay proof; the server dates it by its age, so a queued one
// still counts). A check-out of a check-in still in the queue is sent behind
// it when it can be (checkOut); one that lands first anyway makes that
// check-in land closed: the server remembers the id and stores the check-in
// closed at the check-out when its fix confirmed the court at the tap, or
// refuses it with why. Extend is NOT queued: an
// extension that lands after the check-in lapsed would be refused anyway, so
// it fails loudly instead. It sends a fix when it can: without one the server
// keeps a confirmed check-in at most 4 hours past its last confirming fix.
//
// Court arrival's lock-screen buttons live here too (state/court-arrival-
// doggle-parity.md rows 30-37): one check-in behind "✅ Check in" and
// "✅ Check in now", Not here on "At <court>?" with its offline queue, and
// no fix on Stay 1 more hour for a check-in the server made on arrival. The
// arrival itself is lib/courtArrival's.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import {
  flushMutationQueue,
  invalidateQueries,
  onMutationQueueEvent,
  registerMutationHandler,
  runOrQueue,
} from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { isProbablyOffline, TimeoutError, withTimeout } from '@just-messin-around/expo-foundation/platform';
import {
  getCurrentCoords,
  getForegroundLocationStatus,
  requestForegroundLocationPermission,
} from '@just-messin-around/expo-foundation/platform/location';
import { cancelLocalNotification, scheduleLocalNotification } from '@just-messin-around/expo-foundation/platform/push';
import { currentUserId, resolveUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { uuidv4 } from './analytics';
import { venueCrowdKey } from '../data/venueCrowd';
import {
  catalog,
  NeedsApp,
  refusalNeedsApp,
  registerActionHandler,
  requireUser,
  type ActionHandler,
  type ActionPushData,
} from './notificationActions';
import { titleWith } from './pushSubject';
import { explainRefusal, isRetryLater, noteRefusalNotice } from './refusalNotices';
import {
  extendedNote,
  lapsedCheckinNotice,
  QUEUED_CHECKIN_NOTE,
  queuedCheckinRanOutNote,
  queuedRefusalNotice,
  refusalCode,
  refusalCopy,
  whenLabel,
} from './refusals';
import { isEndPending } from './playEndPending';
import { readPendingEnds } from './playEndPendingStore';
import { presenceConsentState } from './presenceConsent';
import { checkedInVisibilityLine, DEFAULT_PRESENCE_SETTINGS } from './presencePrivacy';
import {
  CHECKOUT_FIX_WAIT_MS,
  checkoutPayload,
  fixFromCoords,
  fixWithin,
  impreciseFixMessage,
  isPreciseFix,
  isValidFix,
  lapsedCheckinFacts,
  needsCourtToExtend,
  noFixMessage,
  offersUntrackedSession,
  refusedForQueueWait,
  rejectedCheckinNotice,
  syncedAfterItEnded,
  waitUntilSent,
  type CheckinPayload,
  type CheckoutPayload,
  type DeviceFix,
} from './courtCheckinRules';
import {
  ARRIVAL_CANCEL_MAX_AGE_MS,
  ARRIVAL_NOTICE_KIND,
  arrivalCheckinUntouched,
  CHECK_IN_TIMED_OUT,
  CHECKIN_ACTION_FIX_MS,
  CHECKIN_ACTION_TIMEOUT_MS,
  checkInOutcome,
  checkInOutcomeCopy,
  CHECKINS_SETTINGS_LINK,
  isLocationRefusalCode,
  NOT_HERE_FAILED,
  NOT_HERE_TIMED_OUT,
  NOT_HERE_TIMEOUT_MS,
  notHereOutcome,
  type CancelCourtArrivalResult,
} from './courtArrivalRules';
import {
  arrivalNotice,
  cancelAllScheduledArrivalNotices,
  cancelArrivalLocalNotices,
  cancelScheduledArrivalNotices,
  dismissArrivalCheckinPushes,
  reconcileArrivalLocalNotices,
} from './courtArrivalNotice';
import {
  checkinVenue,
  checkoutVenue,
  extendCheckin,
  getMyOpenCheckin,
  getVenueName,
  type CheckinSource,
  type VenueCheckin,
} from '../data/venueCheckins';
import { loadPresenceSettings } from '../data/presenceSettings';
import { getCheckinPlan, getMyCourtRoutinesOffline, loadMyCourtRoutines, skipRoutineOccurrence } from '../data/courtRoutines';
import {
  buttonCheckinMinutes,
  DEFAULT_CHECKIN_MINUTES,
  routineDueWithoutOccurrence,
  type CourtRoutine,
} from './courtRoutineRules';
import { ROUTINES_ENABLED } from './features';
// Registers the base replay of a queued Exit / Not here; this file registers
// over it below (a module runs after the files it imports).
import {
  ARRIVAL_CANCEL_MUTATION,
  cancelCourtArrival,
  cancelCourtArrivalOrQueue,
  confirmCourtArrival,
  courtArrivalPending,
  type ArrivalCancelPayload,
} from '../data/courtArrival';

export type CurrentCheckin = {
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  expiresAt: string;
  source: CheckinSource;
  /** When it began, as the server has it (none while it is still queued). */
  checkedInAt?: string;
  /** Saved offline; not on the server yet. */
  queued?: boolean;
  /** Made by an older build without a fix: stored privately, nobody sees it (the card says so). */
  private?: boolean;
  /** Made by the server on arrival at a starred court, with no fix (court
   *  arrival): Stay 1 more hour sends none. Undefined: not known yet. */
  viaArrival?: boolean;
  /** An arrival check-in's first end, as the server's arrival job set it
   *  (routines can cut it short of 2 hours); read only with ROUTINES_ENABLED. */
  arrivalUntil?: string;
};

/** A check-in row, with the arrival flag the server adds (migration_court_arrival_queue.sql). */
type CheckinRow = VenueCheckin & { via_arrival?: boolean };

const STORAGE_KEY = 'pickleague_current_checkin_v1';
const REJECTED_KEY = 'pickleague_checkin_rejected_v1';
const LEFT_KEY = 'pickleague_checkin_left_v1';
const REMINDER_ID = 'checkin-extend';
const MUTATION_CHECKIN = 'venue:checkin';
const MUTATION_CHECKOUT = 'venue:checkout';
const HOUR_MS = 60 * 60_000;
// Long enough that a replay always reaches the handler (and so the "didn't go
// through" notice), instead of aging out silently after the default 24 h.
const QUEUED_CHECKIN_MAX_AGE_MS = 7 * 24 * HOUR_MS;
const REJECTED_KEEP_MS = 3 * 24 * HOUR_MS;

/** Emits whenever the current check-in changes (null = not checked in). */
export const checkinChanged = createSignal<CurrentCheckin | null>();
/** Emits the courts a check-in or check-out just changed (the old one and
 *  the new one), so a list of who's there refetches at once. */
export const courtPresenceTouched = createSignal<string[]>();
/** Emits the notice when a queued check-in is refused on replay. */
export const checkinRejected = createSignal<string>();

/**
 * No signal, or no signed-in session right now: keep the queued write for the
 * next pass instead of dropping it (the queue keeps only "network" failures,
 * so this rethrows one). Anything else is a real refusal.
 */
function retryLater(e: unknown): never {
  throw isRetryLater(e) && !(e instanceof TimeoutError) ? new TimeoutError('Waiting to send again') : e;
}

registerMutationHandler(MUTATION_CHECKIN, {
  maxAgeMs: QUEUED_CHECKIN_MAX_AGE_MS,
  run: async (p) => {
    const payload = p as CheckinPayload;
    // Queued by a build that sent no fix: it can't be confirmed, so it is
    // never sent (the throw makes the queue drop it). The player hears why.
    if (!isValidFix(payload.fix)) {
      await noteRejected(payload, null, { noFix: true });
      throw new Error('Queued check-in has no location fix');
    }
    let row: VenueCheckin;
    try {
      row = await checkinVenue(payload);
    } catch (e) {
      if (isRetryLater(e)) retryLater(e); // no signal / signed out: stays queued
      await noteRejected(payload, e);
      throw e; // refused: the queue drops it, and the player was told why
    }
    await adoptReplayed(payload, row);
  },
});
registerMutationHandler(MUTATION_CHECKOUT, {
  run: async (p) => {
    const payload = p as Partial<CheckoutPayload>;
    const { id, source, at, fix } = payload;
    // A check-out of a check-in the server refused: nothing to close, and the
    // server's "no such row" fallback must not close a later one instead.
    if (id && (await wasRejected(id))) return;
    try {
      // The fix taken at the tap (none when queued by an older build); its age
      // is measured at this send, so the server places it when it was taken.
      await checkoutVenue(id ?? null, source, at, isValidFix(fix) ? fix : null);
    } catch (e) {
      if (isRetryLater(e)) retryLater(e); // no signal / signed out: stays queued
      await noteCheckoutRefused(payload, e);
      throw e;
    }
  },
});

/**
 * A queued check-out the server refused: the check-in is still open there,
 * so friends may still see me at the court. Say so, bring the check-in back
 * on the card (with its Check out), and never drop it silently.
 */
async function noteCheckoutRefused(payload: Partial<CheckoutPayload>, error: unknown): Promise<void> {
  const tapMs = payload.at ? Date.parse(payload.at) : Date.now();
  const untilMs = payload.until ? Date.parse(payload.until) : null;
  await noteRefusalNotice({
    key: `checkout:${payload.id ?? payload.at ?? ''}`,
    title: "Check-out didn't go through",
    body: queuedRefusalNotice({
      what: 'check_out',
      venueName: payload.venueName ?? null,
      tapMs: Number.isFinite(tapMs) ? tapMs : Date.now(),
      error,
      untilMs: untilMs != null && Number.isFinite(untilMs) ? untilMs : null,
    }),
    link: 'home/-',
  });
  // The server's open check-in shows again, so Check out is one tap away.
  await refreshCurrentCheckin().catch(() => null);
}

async function readStored(): Promise<CurrentCheckin | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CurrentCheckin) : null;
  } catch {
    return null;
  }
}

async function setCurrent(c: CurrentCheckin | null): Promise<void> {
  try {
    if (c) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // cache only; the server row is the truth
  }
  if (c) void scheduleReminder(c);
  else void cancelLocalNotification(REMINDER_ID);
  touchCourts(c);
  checkinChanged.emit(c);
}

// The check-in the crowd numbers last saw (by id: a refresh that finds the
// same one changes nothing, a queued one that reached the server does).
let lastTouched: { id: string; venueId: string } | null = null;

/** A new check-in, a check-out or a replayed queued one: the crowd at the
 *  courts it left and joined is stale (venue:crowd:<id>, shared by CrowdLine
 *  and the Courts list), and so is who's there. */
function touchCourts(c: CurrentCheckin | null): void {
  const prev = lastTouched;
  if ((prev?.id ?? null) === (c?.id ?? null)) return;
  lastTouched = c ? { id: c.id, venueId: c.venueId } : null;
  const ids = [...new Set([prev?.venueId, c?.venueId].filter((v): v is string => !!v))];
  for (const id of ids) invalidateQueries(venueCrowdKey(id));
  if (ids.length > 0) courtPresenceTouched.emit(ids);
}

/**
 * An arrival check-in nobody has extended yet (still the length the server
 * gave it): the server's "Still at" (or this phone's own copy, for a player it
 * can't push to) already comes 5 minutes before the end, so a reminder from
 * here would be a second one. Once it is extended, the server sends no more
 * and this phone's reminder takes over.
 */
function arrivalStillAtCovers(c: CurrentCheckin): boolean {
  if (c.viaArrival !== true || !c.checkedInAt) return false;
  // A routine's arrival check-in may end at its planned end instead: the
  // server's own test is expires_at = arrival_until.
  if (c.arrivalUntil && Date.parse(c.arrivalUntil) === Date.parse(c.expiresAt)) return true;
  return arrivalCheckinUntouched(c.checkedInAt, c.expiresAt);
}

function scheduleReminder(c: CurrentCheckin): Promise<boolean> {
  if (arrivalStillAtCovers(c)) {
    void cancelLocalNotification(REMINDER_ID);
    return Promise.resolve(false);
  }
  return scheduleLocalNotification({
    id: REMINDER_ID,
    at: new Date(c.expiresAt).getTime() - 5 * 60_000,
    title: `Still at ${c.venueName}?`,
    body: 'Your check-in ends in 5 minutes.',
    categoryId: catalog.ids.checkin_extend.id,
    // A tap opens Home's court card (there is no court screen yet).
    data: {
      checkin_id: c.id,
      expires_at: c.expiresAt,
      venue_id: c.venueId,
      venue_name: c.venueName,
      // Stay 1 more hour then sends no fix (the checkin_extend handler).
      ...(c.viaArrival ? { via_arrival: true } : {}),
      deepLink: 'home/-',
    },
  });
}

/** The check-in's start and arrival flag, from a row the server returned. */
function rowFacts(row: CheckinRow): Pick<CurrentCheckin, 'checkedInAt' | 'viaArrival'> {
  return {
    ...(row.checked_in_at ? { checkedInAt: row.checked_in_at } : {}),
    ...(typeof row.via_arrival === 'boolean' ? { viaArrival: row.via_arrival } : {}),
  };
}

const live = (c: CurrentCheckin | null) => (c && new Date(c.expiresAt).getTime() > Date.now() ? c : null);

/**
 * A queued check-in that landed: take the server's id and end time (it may be
 * a check-in I already had there). One that landed after it had ended (its
 * time ran out, or its check-out reached Pickleague first) is stored as a
 * visit nobody saw: drop it from the card and say so once (the card may have
 * dropped it already when it ran out or was checked out here). The times are
 * the server's (lapsedCheckinFacts), and a check-out tapped here, even one
 * still queued behind it, is the end it names.
 */
async function adoptReplayed(payload: CheckinPayload, row: VenueCheckin): Promise<void> {
  const cached = await readStored();
  const mine = cached?.id === payload.id ? cached : null;
  const left = await takeLeft(payload.id);
  if (syncedAfterItEnded(row)) {
    if (mine) await setCurrent(null);
    const venueName = mine?.venueName ?? (await getVenueName(row.venue_id).catch(() => null)) ?? null;
    const facts = lapsedCheckinFacts({
      row,
      tapIso: payload.at,
      leftAtMs: left?.leftAtMs ?? null,
      // A newer check-in of mine is current: never "check in again".
      newerCheckin: !mine && !!live(cached),
    });
    await noteRefusalNotice({
      key: `checkin-late:${row.id}`,
      title: 'Check-in saved late',
      body: lapsedCheckinNotice({ venueName, ...facts }),
      link: 'home/-',
    });
    return;
  }
  if (!mine) return;
  await setCurrent({
    ...mine,
    id: row.id,
    venueId: row.venue_id,
    expiresAt: row.expires_at,
    source: row.source,
    // The server may have handed back its arrival check-in at this court.
    ...rowFacts(row),
    queued: undefined,
  });
}

// ── Check-outs tapped while their check-in was still queued ────────────────
// So the "saved late" notice can say I had checked out (and when) instead of
// "check in again", even while that check-out still waits behind its check-in.
type Left = { id: string; leftAtMs: number; atMs: number };

async function readLeft(): Promise<Left[]> {
  try {
    const raw = await AsyncStorage.getItem(LEFT_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v)
      ? (v as Left[]).filter(
          (r) => r && typeof r.id === 'string' && Number.isFinite(r.leftAtMs) && Date.now() - r.atMs < QUEUED_CHECKIN_MAX_AGE_MS,
        )
      : [];
  } catch {
    return [];
  }
}

async function noteLeft(id: string, leftAtMs: number): Promise<void> {
  const list = (await readLeft()).filter((r) => r.id !== id);
  await AsyncStorage.setItem(LEFT_KEY, JSON.stringify([...list, { id, leftAtMs, atMs: Date.now() }].slice(-20))).catch(() => {});
}

/** The check-out tapped here for this check-in, if any (forgotten once read). */
async function takeLeft(id: string): Promise<Left | null> {
  const list = await readLeft();
  const hit = list.find((r) => r.id === id) ?? null;
  if (hit) await AsyncStorage.setItem(LEFT_KEY, JSON.stringify(list.filter((r) => r !== hit))).catch(() => {});
  return hit;
}

// ── Queued check-ins the server refused ─────────────────────────────────────
type Rejected = { id: string; notice: string; atMs: number; shown?: boolean };

async function readRejected(): Promise<Rejected[]> {
  try {
    const raw = await AsyncStorage.getItem(REJECTED_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v)
      ? (v as Rejected[]).filter((r) => r && typeof r.id === 'string' && Date.now() - r.atMs < REJECTED_KEEP_MS)
      : [];
  } catch {
    return [];
  }
}

async function writeRejected(list: Rejected[]): Promise<void> {
  await AsyncStorage.setItem(REJECTED_KEY, JSON.stringify(list)).catch(() => {});
}

async function wasRejected(id: string): Promise<boolean> {
  return (await readRejected()).some((r) => r.id === id);
}

/**
 * Remember the refusal for the court card, tell the player on any screen (a
 * toast, or a notification when the app is in the background), and drop the
 * "saved offline" check-in it left behind.
 */
async function noteRejected(payload: CheckinPayload, error: unknown, opts: { noFix?: boolean } = {}): Promise<void> {
  const cached = await readStored();
  const venueName =
    cached?.id === payload.id ? cached.venueName : (await getVenueName(payload.venueId).catch(() => null)) ?? 'the court';
  await takeLeft(payload.id);
  const notice = rejectedCheckinNotice({
    venueName,
    // With its day when it wasn't today (a tap over 12 hours old never is).
    tapMs: Date.parse(payload.at),
    noFix: opts.noFix,
    // Only an older server refuses a fix that was fresh at its own tap (it
    // judged the age at send): then the 2-minute wait is the reason. The
    // current server's reasons (over 12 hours, the fix away from the tap, how
    // far from the court, too vague) are worded from its code.
    waitedTooLong: !opts.noFix && refusedForQueueWait(error, payload.fix, payload.at),
    error,
  });
  const list = (await readRejected()).filter((r) => r.id !== payload.id);
  await writeRejected([...list, { id: payload.id, notice, atMs: Date.now() }]);
  if (cached?.id === payload.id) await setCurrent(null);
  checkinRejected.emit(notice);
  await noteRefusalNotice({ key: `checkin:${payload.id}`, title: "Check-in didn't go through", body: notice, link: 'home/-' });
}

/** The oldest refusal not shown yet (now marked shown), or null. */
export async function takeRejectedCheckinNotice(): Promise<string | null> {
  const list = await readRejected();
  const next = list.find((r) => !r.shown);
  if (!next) return null;
  await writeRejected(list.map((r) => (r === next ? { ...r, shown: true } : r)));
  return next.notice;
}

// ── Device fix ──────────────────────────────────────────────────────────────
// Why the last takeCheckinFix came back empty although a reading arrived: it
// was too vague (accuracy in metres; null = none reported). noFixReason()
// names it.
let lastImpreciseFix: { accuracyM: number | null } | null = null;

/**
 * A fresh fix for a check-in, or null: no permission, no fix within
 * `timeoutMs`, an unusable reading, or one too vague to confirm a court
 * (accuracy over 150 m, e.g. Precise Location off: the server would refuse
 * it, and a blurred point would find the wrong court). Never the remembered
 * spot, which can't confirm I am at the court now. May show the OS / browser
 * permission prompt.
 */
export async function takeCheckinFix(timeoutMs = 6_000): Promise<DeviceFix | null> {
  lastImpreciseFix = null;
  const fix = fixFromCoords(await getCurrentCoords({ timeoutMs }), Date.now());
  if (fix && !isPreciseFix(fix)) {
    lastImpreciseFix = { accuracyM: fix.accuracyM };
    return null;
  }
  return fix;
}

/** When the last takeCheckinFix refused a vague reading: what to tell the player. Else null. */
export function impreciseFixReason(): string | null {
  return lastImpreciseFix ? impreciseFixMessage(lastImpreciseFix.accuracyM, Platform.OS) : null;
}

/**
 * Ask for location: the OS / browser sheet when it hasn't been answered, else
 * an instant answer. Not bounded (the player may take a while to read the
 * sheet), so callers ask first and bound only the fix after it.
 */
export async function askForLocation(): Promise<boolean> {
  return requestForegroundLocationPermission().catch(() => false);
}

/** Like takeCheckinFix, but only when location is already allowed (never prompts). */
export async function takeFixIfAllowed(timeoutMs = 6_000): Promise<DeviceFix | null> {
  // An earlier read's "too vague" is not why this one came back empty.
  lastImpreciseFix = null;
  if ((await getForegroundLocationStatus()) !== 'granted') return null;
  return takeCheckinFix(timeoutMs);
}

/** Why there is no check-in after takeCheckinFix came back empty. */
export async function noFixReason(): Promise<string> {
  return impreciseFixReason() ?? noFixMessage(await getForegroundLocationStatus(), Platform.OS);
}

// ── Reads ───────────────────────────────────────────────────────────────────
// A check-in this device showed that ended without the player's Check out
// here (its time ran out, or the server closed it: checked out elsewhere, a
// check-in at another court, its session's End). The court card says so once,
// so the card going back to "At the courts?" is never silent. Kept with its
// owner, so another account signed in on this device never sees it.
let endedNote: { userId: string; text: string } | null = null;

function noteCheckinEnded(c: CurrentCheckin, how: 'expired' | 'closed' | 'queued'): void {
  endedNote = {
    userId: c.userId,
    text:
      how === 'queued'
        ? // Still waiting for a signal: it goes when the phone is back online.
          queuedCheckinRanOutNote({ venueName: c.venueName, endedMs: Date.parse(c.expiresAt) })
        : how === 'expired'
          ? `Your check-in at ${c.venueName} ended at ${whenLabel(new Date(c.expiresAt))}. Check in again if you're still there.`
          : `Your check-in at ${c.venueName} has ended. Check in again if you're still there.`,
  };
}

/** The "your check-in ended" line for the signed-in player, once (null when there is none). */
export async function takeEndedCheckinNote(): Promise<string | null> {
  const n = endedNote;
  endedNote = null;
  if (!n) return null;
  const uid = await currentUserId(supabase).catch(() => null);
  return uid && uid === n.userId ? n.text : null;
}

/** The signed-in player's current check-in from the local cache (no network). */
export async function peekCurrentCheckin(): Promise<CurrentCheckin | null> {
  const [c, uid] = await Promise.all([readStored(), currentUserId(supabase)]);
  if (!c || !uid || c.userId !== uid) return null;
  if (!live(c)) {
    // Ran out on its own: forget it, and say so once (a queued one that ran
    // out before it could be sent still goes, within 12 hours of the tap).
    noteCheckinEnded(c, c.queued ? 'queued' : 'expired');
    await setCurrent(null);
    return null;
  }
  return c;
}

/**
 * Reconcile the cache with the server. Keeps a queued (not yet sent) check-in;
 * otherwise the server wins. Throws on a network failure so the caller can
 * keep showing the cached value.
 */
export async function refreshCurrentCheckin(): Promise<CurrentCheckin | null> {
  const uid = await currentUserId(supabase);
  if (!uid) return null;
  const cached = await peekCurrentCheckin();
  const open = await getMyOpenCheckin(uid);
  // The phone's own "Checked in" / "Still at" (D3) for an arrival the server
  // never made a check-in of, or one that's over, go now: this read is fresh.
  void reconcileArrivalLocalNotices(open).catch(() => undefined);
  // A play session's check-in whose End is still queued is over already.
  const ended = open?.source === 'session' && isEndPending(await readPendingEnds(), open.id, Date.now());
  const row = ended ? null : open;
  if (!row) {
    if (cached?.queued) return cached;
    if (cached) {
      // Closed on the server, not by a Check out here (those clear the cache):
      // a session's own check-in ends with its End, which says so itself.
      if (cached.source !== 'session') noteCheckinEnded(cached, 'closed');
      await setCurrent(null);
    }
    return null;
  }
  const venueName =
    cached?.venueId === row.venue_id ? cached.venueName : (await getVenueName(row.venue_id)) ?? 'this court';
  // Only the server makes arrival check-ins, always as 'geofence'; once
  // known, the flag stays with the check-in.
  const known = cached?.id === row.id ? cached.viaArrival : undefined;
  const viaArrival = known ?? (row.source === 'geofence' ? await madeOnArrival(row.id) : false);
  // Routines: an arrival check-in's first end (it may be the planned end,
  // under 2 hours), so this phone's "Still at" stays quiet while the
  // server's covers it. Kept once known.
  const arrivalUntil =
    ROUTINES_ENABLED && viaArrival === true
      ? cached?.id === row.id && cached.arrivalUntil
        ? cached.arrivalUntil
        : ((await withTimeout(getCheckinPlan(row.id), 3_000).catch(() => null))?.arrivalUntil ?? undefined)
      : undefined;
  const next: CurrentCheckin = {
    id: row.id,
    userId: uid,
    venueId: row.venue_id,
    venueName,
    expiresAt: row.expires_at,
    source: row.source,
    checkedInAt: row.checked_in_at,
    ...(row.location_confirmed === false ? { private: true } : {}),
    ...(viaArrival !== undefined ? { viaArrival } : {}),
    ...(arrivalUntil ? { arrivalUntil } : {}),
  };
  if (
    !cached ||
    cached.arrivalUntil !== next.arrivalUntil ||
    cached.id !== next.id ||
    cached.expiresAt !== next.expiresAt ||
    cached.queued ||
    !!cached.private !== !!next.private ||
    cached.viaArrival !== next.viaArrival ||
    cached.checkedInAt !== next.checkedInAt
  ) {
    await setCurrent(next);
  }
  return next;
}

/**
 * Whether my open check-in `id` was made by the server on arrival, from the
 * cached read that has the flag (the reconcile read above doesn't ask for
 * it). Undefined when that can't be told now (no signal, an older server).
 */
async function madeOnArrival(id: string): Promise<boolean | undefined> {
  const open = await withTimeout(getMyOpenCheckin(), 3_000).catch(() => null);
  return open?.id === id && typeof open.via_arrival === 'boolean' ? open.via_arrival : undefined;
}

// ── Writes ──────────────────────────────────────────────────────────────────
/** What a check-in asks checkin_venue for when nothing else says, and the least it asks (D1). */
export { DEFAULT_CHECKIN_MINUTES };
/** How long a check-in waits for my routines when this device has no copy, or reads it fresh. */
const ROUTINES_READ_MS = 2_000;

/**
 * My routines, for how long a check-in at `venueId` asks: the copy on this
 * device, a fetch only when there is none (2 s at most). When a stop is due
 * there by its weekly time but the copy has no occurrence for it
 * (routineDueWithoutOccurrence), the copy is read fresh first
 * (loadMyCourtRoutines: kept 5 minutes, else a read, 2 s at most; the copy as
 * it was when that fails): the server may have made it since (today's during
 * its window, on a save or an edit, or on another phone), and only a stop
 * with an occurrence runs a check-in to its end (routineOccurrenceEndAt).
 * Null with ROUTINES_ENABLED off, or when they can't be read.
 */
export async function readRoutinesForCheckin(
  venueId?: string | null,
  at: Date = new Date(),
): Promise<CourtRoutine[] | null> {
  if (!ROUTINES_ENABLED) return null;
  const copy = await withTimeout(getMyCourtRoutinesOffline(), ROUTINES_READ_MS).catch(() => null);
  if (!venueId || !copy || !routineDueWithoutOccurrence(copy, venueId, at)) return copy;
  return withTimeout(loadMyCourtRoutines(), ROUTINES_READ_MS).catch(() => copy);
}

/**
 * How long a check-in at `venueId` asks for (by hand, or a notification's
 * Check in): to the planned end of a routine stop due there now with the
 * occurrence the server will link, 2 to 4 hours (D1: never under 2 hours),
 * else 2 hours. A tapped routine reminder's own occurrence (`reminder`: its
 * push's planned_at / planned_end_at) needs no read; else my routines
 * (readRoutinesForCheckin), 2 hours when they can't be read. The server links
 * such a check-in to the occurrence and takes its closed / open windows and
 * planned end, but keeps the length asked (Doggle's ordinary check-in), so 2
 * hours ended a 3-hour routine split closed 2 h / open 1 h while still
 * closed. A stop with no occurrence links nothing, so it asks 2 hours (probe
 * X4, a routine saved after its time on the old server, asked 170 minutes).
 */
export async function manualCheckinMinutes(
  venueId: string,
  at: Date = new Date(),
  reminder?: { plannedAt?: string | null; plannedEndAt?: string | null } | null,
): Promise<number> {
  if (!ROUTINES_ENABLED) return DEFAULT_CHECKIN_MINUTES;
  const pushed = buttonCheckinMinutes(null, venueId, at, reminder);
  if (pushed != null) return pushed;
  return buttonCheckinMinutes(await readRoutinesForCheckin(venueId, at), venueId, at) ?? DEFAULT_CHECKIN_MINUTES;
}

/**
 * Check in now with the fix just taken. Queues when offline (the result has
 * `queued: true`). Rejects with the server's "You need to be at the court to
 * check in (about N m away)." when the fix is outside the fence. Without
 * `minutes`, a check-in (by hand or a notification's button; not a
 * session's) runs to the end of a routine stop due there
 * (manualCheckinMinutes), else 2 hours.
 */
export async function checkInAt(
  venue: { id: string; name: string },
  fix: DeviceFix,
  opts: { source?: CheckinSource; minutes?: number } = {},
): Promise<CurrentCheckin> {
  const uid = await requireUser();
  const at = new Date();
  const source = opts.source ?? 'manual';
  const minutes =
    opts.minutes ?? (source === 'session' ? DEFAULT_CHECKIN_MINUTES : await manualCheckinMinutes(venue.id, at));
  const payload: CheckinPayload = {
    id: uuidv4(),
    venueId: venue.id,
    minutes,
    source,
    at: at.toISOString(),
    fix,
  };
  const { queued, result } = await runOrQueue(MUTATION_CHECKIN, payload, () => checkinVenue(payload));
  const c: CurrentCheckin = {
    // The server may hand back a check-in I already had at this court (and
    // the canonical court id when this one is a duplicate).
    id: result?.id ?? payload.id,
    userId: uid,
    venueId: result?.venue_id ?? venue.id,
    venueName: venue.name,
    expiresAt: result?.expires_at ?? new Date(Date.now() + minutes * 60_000).toISOString(),
    source: result?.source ?? payload.source,
    // Handed back the server's arrival check-in here: viaArrival says so.
    ...(result ? rowFacts(result as CheckinRow) : {}),
    ...(queued ? { queued: true } : {}),
  };
  await setCurrent(c);
  // Checked in with a fix (the court card or a notice button): an arrival
  // still waiting anywhere is skipped by the server now (this check-in is
  // open), and one that landed was closed or extended by it, so the phone's
  // own "Checked in" / "Still at" (D3) would be wrong. Queued: the server
  // doesn't know of it yet, so the arrival may still land as announced.
  if (!queued) void cancelAllScheduledArrivalNotices();
  return c;
}

/**
 * Another hour from the current end (absolute, so a replay can't add two).
 * Pass a fresh fix when there is one: it keeps a confirmed check-in confirmed
 * (without one the server stops 4 hours after the last confirming fix).
 */
export async function extendCheckinByHour(
  c: Pick<CurrentCheckin, 'id' | 'expiresAt'> & { venueName?: string | null },
  fix?: DeviceFix | null,
): Promise<{ next: CurrentCheckin | null; note: { full: boolean; message: string } }> {
  const requested = Math.max(new Date(c.expiresAt).getTime(), Date.now()) + HOUR_MS;
  let row: VenueCheckin;
  try {
    row = await extendCheckin(c.id, new Date(requested).toISOString(), fix);
  } catch (e) {
    // The check-in already ended on the server (checked out elsewhere, closed
    // by a check-in at another court or its session's End): stop showing it.
    // Not awaited: the refusal must reach the player inside the caller's
    // bound (the lock screen's 15 s, the card's), and the card refreshes on
    // its own after a refusal.
    const code = refusalCode(e);
    if (code === 'checkin.closed' || code === 'checkin.none') void refreshCurrentCheckin().catch(() => null);
    throw e;
  }
  // The phone's own "Still at" for an arrival check-in (D3) named the old end.
  void cancelArrivalLocalNotices(c.id);
  const cached = await readStored();
  // The server may give less than an hour (4 hours ahead at most, and
  // without a confirming fix 4 hours past the last one): say which.
  const note = extendedNote({
    requestedUntilMs: requested,
    gotUntilMs: Date.parse(row.expires_at),
    fixSent: !!fix,
    venueName: c.venueName ?? (cached?.id === c.id ? cached.venueName : null),
  });
  if (cached?.id !== c.id) return { next: null, note };
  const next = { ...cached, expiresAt: row.expires_at };
  await setCurrent(next);
  return { next, note };
}

/**
 * "Stay until 12 PM" on "Staying until 12 PM?" (an arrival check-in at a
 * routine court): extend_checkin to the routine's planned end, as one
 * absolute time, so a replay can't add more. No fix: the arrival came from a
 * circle whose edge can be far from the court's pin (as Stay 1 more hour on
 * an arrival check-in). The server caps it at 4 hours (extendedNote says so).
 */
export async function extendCheckinUntil(
  c: Pick<CurrentCheckin, 'id'> & { venueName?: string | null },
  untilIso: string,
): Promise<{ next: CurrentCheckin | null; note: { full: boolean; message: string } }> {
  const requested = Date.parse(untilIso);
  let row: VenueCheckin;
  try {
    row = await extendCheckin(c.id, new Date(requested).toISOString(), null);
  } catch (e) {
    const code = refusalCode(e);
    if (code === 'checkin.closed' || code === 'checkin.none') void refreshCurrentCheckin().catch(() => null);
    throw e;
  }
  void cancelArrivalLocalNotices(c.id);
  const cached = await readStored();
  const note = extendedNote({
    requestedUntilMs: requested,
    gotUntilMs: Date.parse(row.expires_at),
    fixSent: false,
    venueName: c.venueName ?? (cached?.id === c.id ? cached.venueName : null),
  });
  if (cached?.id !== c.id) return { next: null, note };
  const next = { ...cached, expiresAt: row.expires_at };
  await setCurrent(next);
  return { next, note };
}

/**
 * Check out (one check-in, or all of mine). Queues when offline, with the real
 * leave time. Sends a fresh fix only when one comes back within 3 s and
 * location is already allowed (never a prompt): proof I stayed at the court
 * (Phase 1.5). Without one it checks out exactly as before. `fix: false` skips
 * it (a geofence exit: I've left, so a fix there proves nothing).
 *
 * A check-in still in the offline queue: the tap is remembered (the "saved
 * late" notice names it), and with a signal the queue is asked to send the
 * check-in first, within the same 3 s, so the check-out (and its stay fix)
 * lands behind it. Offline, the check-out queues behind it anyway. If the
 * check-out still lands first, the server stores the check-in closed at it
 * (migration_checkin_tap_time.sql); one the server refused meanwhile has
 * nothing to close, and its refusal was said.
 */
export async function checkOut(
  id: string | null,
  source?: CheckinSource,
  opts: { fix?: boolean } = {},
): Promise<{ queued: boolean }> {
  const tapMs = Date.now();
  const cached = await readStored();
  const mine = cached && (id === null || cached.id === id) && (!source || cached.source === source) ? cached : null;
  const queuedCheckin = mine?.queued ? mine : null;
  if (queuedCheckin) await noteLeft(queuedCheckin.id, tapMs);
  const sendFirst =
    queuedCheckin && opts.fix !== false && !isProbablyOffline()
      ? waitUntilSent({
          kick: () => void flushMutationQueue().catch(() => {}),
          stillQueued: async () => {
            const c = await readStored();
            return !!c && c.id === queuedCheckin.id && !!c.queued;
          },
          ms: CHECKOUT_FIX_WAIT_MS,
        })
      : Promise.resolve(true);
  const [fix] = await Promise.all([
    opts.fix === false ? Promise.resolve(null) : fixWithin(() => takeFixIfAllowed(CHECKOUT_FIX_WAIT_MS), CHECKOUT_FIX_WAIT_MS),
    sendFirst,
  ]);
  // Refused while we waited: nothing to close (and the server's "no such
  // row" fallback must not close another check-in instead).
  if (queuedCheckin && (await wasRejected(queuedCheckin.id))) {
    await takeLeft(queuedCheckin.id);
    return { queued: false };
  }
  // Where and until when, for the notice if a queued check-out is refused later.
  const payload: CheckoutPayload = {
    ...checkoutPayload(id, source, tapMs, fix),
    ...(mine ? { venueName: mine.venueName, until: mine.expiresAt } : {}),
  };
  let queued: boolean;
  try {
    ({ queued } = await runOrQueue(MUTATION_CHECKOUT, payload, () =>
      checkoutVenue(id, source, payload.at, payload.fix ?? null),
    ));
  } catch (e) {
    // Refused: not checked out, so the "saved late" notice mustn't say so.
    if (queuedCheckin) await takeLeft(queuedCheckin.id);
    throw e;
  }
  // The phone's own "Still at" for an arrival check-in (D3) must not go off.
  const closedId = id ?? mine?.id;
  if (closedId) void cancelArrivalLocalNotices(closedId);
  if (mine) await setCurrent(null);
  return { queued };
}

/** Forget a check-in the server closes on its own (a play session's, which End closes). Local only. */
export async function forgetCheckin(id: string): Promise<void> {
  const cached = await readStored();
  if (cached?.id === id) await setCurrent(null);
}

/** Sign-out: forget the local check-in, its reminder and any refusal notices (lib/signOutPresence closes the server row). */
export async function clearCheckinForSignOut(): Promise<void> {
  // The outgoing account's "your check-in ended" line goes with it.
  endedNote = null;
  await setCurrent(null);
  await AsyncStorage.removeItem(REJECTED_KEY).catch(() => {});
  await AsyncStorage.removeItem(LEFT_KEY).catch(() => {});
}

// ── Stay 1 more hour / Check out ────────────────────────────────────────────
// On the "5 minutes left" reminder, the server's "Checked in at X" and "Still
// at X?" (and the phone's own copies of them), and "Leaving X?".
registerActionHandler('checkin_extend', {
  // The reminder carries venue_name, so the notice names the court.
  // Waits up to 5 s for a fix, then the 9 s write.
  timeoutMs: 15_000,
  // The full hour, or less and why (no confirming fix: 4 hours past the last one).
  success: (res, d) => {
    const note = (res as { note?: { full: boolean; message: string } } | null)?.note;
    return {
      title: titleWith(note && !note.full ? 'Extended, not a full hour' : 'Extended', d.venue_name),
      body: note?.message ?? 'Checked in for another hour.',
    };
  },
  run: async (d) => {
    await requireUser();
    if (!d.checkin_id || !d.expires_at) {
      throw new NeedsApp("This reminder didn't say which check-in to extend. Open Pickleague to extend it.");
    }
    // A fix confirms I am still there (it works in the background only with
    // "Always" location). Without one the server extends only so far past the
    // last confirming fix, then the app has to be opened at the court.
    // Not for a check-in the server made on arrival (via_arrival): it came
    // from a circle whose edge can be far from the court's pin, so a fix there
    // would be refused; without one the server extends it up to 4 hours past
    // its check-in.
    const fix = d.via_arrival === true ? null : await takeFixIfAllowed(5_000);
    try {
      return await extendCheckinByHour({ id: d.checkin_id, expiresAt: d.expires_at, venueName: d.venue_name }, fix);
    } catch (e) {
      // Why, in words: not at the court (how far), no fix for 4 hours, the
      // check-in already ended, signed out (lib/refusals).
      const why = refusalNeedsApp(e, { venueName: d.venue_name, action: 'extend' });
      if (why) throw why;
      if (needsCourtToExtend(e)) throw new NeedsApp('Open Pickleague at the court to stay checked in.');
      throw e;
    }
  },
});
// "Staying until 12 PM?": Stay until then (push_data.planned_end_at).
registerActionHandler('checkin_stay_until', {
  timeoutMs: 12_000,
  success: (res, d) => {
    const note = (res as { note?: { full: boolean; message: string } } | null)?.note;
    return {
      title: titleWith(note && !note.full ? 'Extended, not all the way' : 'Extended', d.venue_name),
      body: note?.message ?? "You're checked in until you planned.",
    };
  },
  run: async (d) => {
    await requireUser();
    if (!d.checkin_id || !d.planned_end_at) {
      throw new NeedsApp("This reminder didn't say which check-in to extend. Open Pickleague to extend it.");
    }
    try {
      return await extendCheckinUntil({ id: d.checkin_id, venueName: d.venue_name }, d.planned_end_at);
    } catch (e) {
      const why = refusalNeedsApp(e, { venueName: d.venue_name, action: 'extend' });
      if (why) throw why;
      throw e;
    }
  },
});
// The routine reminder's Skip today: that one occurrence (the routine carries on).
registerActionHandler('routine_skip', {
  success: (_res, d) => ({
    title: titleWith('Skipped today', d.venue_name),
    body: "We won't check you in there for this one. Your routine carries on.",
  }),
  run: async (d) => {
    await requireUser();
    if (!d.plan_id) throw new NeedsApp("This reminder didn't say which routine check-in to skip. Open Pickleague to skip it.");
    try {
      return await skipRoutineOccurrence(d.plan_id);
    } catch (e) {
      const why = refusalNeedsApp(e, { venueName: d.venue_name });
      if (why) throw why;
      throw e;
    }
  },
});
registerActionHandler('checkin_out', {
  // Waits up to CHECKOUT_FIX_WAIT_MS for the stay-proof fix, then the 9 s write.
  timeoutMs: 10_000 + CHECKOUT_FIX_WAIT_MS,
  success: (_res, d) => ({ title: titleWith('Checked out', d.venue_name), body: 'See you next time.' }),
  queued: { title: 'Checked out', body: 'Saved. It syncs when you are back online.' },
  run: async (d) => {
    await requireUser();
    // An arrival check-in is a 'geofence' row. The phone makes this notice
    // itself for a player without push, so its id may be one the server
    // never stored (it skipped the arrival); the source keeps the server's
    // "no such row" fallback from closing a check-in at another court.
    return checkOut(d.checkin_id ?? null, d.via_arrival === true ? 'geofence' : undefined);
  },
});

// ── Check in / Check in now (court arrival) ─────────────────────────────────
// One check-in behind "✅ Check in" ("Check in nearby?", the QR wallet notice)
// and "✅ Check in now" ("At <court>?"), as in Doggle's performCheckIn. It
// takes a fresh fix without ever asking for location (the lock screen can't
// show the sheet) and checks in with it. "At X?" has a check-in of its own
// coming a minute after the arrival, so a press there still has an answer
// without a usable fix: that check-in already landed (confirm it, so leaving
// no longer takes it back), or it is still waiting out its minute ("Checking
// you in"). A location refusal while it is still coming says the same: that
// check-in carries no fix, so it earns nothing until a real one arrives.

/** Who sees me now, from the cached settings (defaults when unreadable within 1 s). */
async function visibilityNow(): Promise<string> {
  const s = await withTimeout(loadPresenceSettings(), 1_000).catch(() => DEFAULT_PRESENCE_SETTINGS);
  return checkedInVisibilityLine(s, Date.now());
}

type CourtCheckinResult =
  | { queued: true }
  | { outcome: 'done'; visibility: string }
  | { outcome: 'already' | 'arriving' };

const NOT_CHECKED_IN = 'Not checked in';

async function courtCheckin(d: ActionPushData, onArrivalNotice: boolean): Promise<CourtCheckinResult> {
  const runStart = Date.now();
  await requireUser();
  const venueId = d.venue_id;
  if (!venueId) {
    throw new NeedsApp("This alert didn't say which court you're at. Open Pickleague to check in.", 'home/-', NOT_CHECKED_IN);
  }
  // "At X?" has done its job (Android leaves a pressed notice up).
  if (onArrivalNotice) void arrivalNotice.dismiss(venueId);
  const court = d.venue_name ?? null;
  // The fix is read while consent and the length are looked up: the button's
  // 22 s also have to hold the write. The length runs to the end of a routine
  // stop due here, as a check-in by hand does (the routine reminder's push
  // says which one); it asked 2 hours before, so a 3-hour split ended closed.
  const [consent, fix, minutes] = await Promise.all([
    presenceConsentState().catch(() => 'unknown' as const),
    takeFixIfAllowed(CHECKIN_ACTION_FIX_MS),
    manualCheckinMinutes(
      venueId,
      new Date(runStart),
      d.kind === 'routine_reminder' ? { plannedAt: d.planned_at, plannedEndAt: d.planned_end_at } : null,
    ).catch(() => DEFAULT_CHECKIN_MINUTES),
  ]);
  // The one-time "who sees you at the courts" sheet can't show on the lock
  // screen: until it was accepted, check in from the app. No connection is
  // its own reason (the answer may be on the server). Not on "At X?": the
  // server took that arrival only because the answer is already there.
  if (consent === 'no' || (consent === 'unknown' && !onArrivalNotice)) {
    throw new NeedsApp(
      consent === 'unknown'
        ? refusalCopy('consent.unknown_offline')
        : 'First choose who sees you at the courts. Open Pickleague to choose, then check in.',
      'home/-',
      NOT_CHECKED_IN,
    );
  }
  if (!fix) {
    // "At X?": its check-in may have landed (confirming needs no fix) or be
    // on its way. Each read is bounded (4 s, then 3 s), and an unanswered
    // "still on its way?" counts as yes, as in Doggle.
    const confirmed = onArrivalNotice ? await confirmCourtArrival(venueId).catch(() => null) : null;
    const pending =
      onArrivalNotice && confirmed !== true ? await courtArrivalPending(venueId).catch(() => null) : null;
    const outcome = checkInOutcome({ onArrivalNotice, hasFix: false, confirmed, pending });
    if (outcome === 'already' || outcome === 'arriving') return { outcome };
    // An approximate location (Precise Location off) says so; else no fix at all.
    throw new NeedsApp(
      impreciseFixReason() ??
        "Pickleague couldn't get your location to confirm you're at the court. Open Pickleague at the court to check in.",
      'home/-',
      NOT_CHECKED_IN,
    );
  }
  let c: CurrentCheckin;
  try {
    c = await checkInAt({ id: venueId, name: court ?? 'the courts' }, fix, { source: 'geofence', minutes });
  } catch (e) {
    const code = refusalCode(e);
    if (onArrivalNotice && isLocationRefusalCode(code)) {
      const pending = await courtArrivalPending(venueId).catch(() => null);
      if (checkInOutcome({ onArrivalNotice, hasFix: true, pending, refusalCode: code }) === 'arriving') {
        return { outcome: 'arriving' };
      }
    }
    // A refusal that lands after the button's deadline (its "may not have
    // saved" notice is already up) still reaches the player.
    if (Date.now() - runStart >= CHECKIN_ACTION_TIMEOUT_MS - 250) {
      void noteRefusalNotice({
        key: `court_checkin:${venueId}:${runStart}`,
        title: "Check-in didn't go through",
        body: queuedRefusalNotice({ what: 'check_in', venueName: court, tapMs: runStart, error: e }),
        link: 'home/-',
      });
    }
    // Why, in words: how far from the court, too vague, out of date, the
    // court is gone, signed out (lib/refusals).
    const why = refusalNeedsApp(e, { venueName: court, action: 'check_in' }, 'home/-');
    if (why) throw why;
    if (offersUntrackedSession(e)) throw new NeedsApp((e as Error).message, 'home/-', NOT_CHECKED_IN);
    throw e;
  }
  if (c.queued) return { queued: true };
  // (checkInAt cancelled the phone's own "Checked in" / "Still at" for arrivals.)
  // The server handed back its arrival check-in (this fix now backs it):
  // confirm it, so leaving within 5 minutes no longer takes it back.
  if (c.viaArrival) await confirmCourtArrival(venueId).catch(() => false);
  const outcome = checkInOutcome({
    onArrivalNotice,
    hasFix: true,
    checkin: { queued: false, viaArrival: c.viaArrival === true },
  });
  if (outcome === 'already') return { outcome };
  return { outcome: 'done', visibility: await visibilityNow() };
}

const courtCheckinButton: ActionHandler = {
  timeoutMs: CHECKIN_ACTION_TIMEOUT_MS,
  timedOut: CHECK_IN_TIMED_OUT,
  success: (res, d) => {
    const r = res as CourtCheckinResult | null;
    if (r && 'outcome' in r && r.outcome !== 'done') return checkInOutcomeCopy(r.outcome, d.venue_name);
    return {
      title: 'Checked in',
      body: (r && 'visibility' in r ? r.visibility : null) ?? 'Other players can see you are here.',
    };
  },
  // The server takes it up to 12 hours after the tap (migration_checkin_tap_time.sql).
  queued: { title: 'Checked in', body: QUEUED_CHECKIN_NOTE },
  // Pressed with Pickleague open: Home's court card shows what happened.
  openWhenActive: () => 'home/-',
  run: (d, _key, r) => courtCheckin(d, d.kind === ARRIVAL_NOTICE_KIND || r.action === 'court_checkin_now'),
};
registerActionHandler('court_checkin', courtCheckinButton);
registerActionHandler('court_checkin_now', courtCheckinButton);

// ── Not here (court arrival) ────────────────────────────────────────────────
// On "At <court>?": don't check me in here this time, or take back the
// check-in it already became (within 5 minutes of arriving, unless it was
// confirmed); later than that, check me out. With no signal it waits in the
// queue and the server acts on the press time (Doggle's performNotHere and
// its arrival-cancel replay). The notice says what the server actually did.

/** What a cancel did to the arrival's other notices. */
function afterArrivalCancel(venueId: string, res: { queued: boolean; result?: CancelCourtArrivalResult | null }): void {
  // Taken back or checked out: its "Checked in" / "Still at" (the server's,
  // or this phone's own) describe a visit that is over.
  if (res.result?.removed || res.result?.closed) void dismissArrivalCheckinPushes(venueId);
  // Stopped before it became a check-in (or it will be, once sent): the
  // phone's own "Checked in" must not go off.
  else if (res.queued || res.result?.dropped) void cancelScheduledArrivalNotices(venueId);
}

// Not here presses waiting in the queue, kept on this phone so one that ages
// out unsent is told, not lost: the queue drops it after 2 hours without
// calling the replay below. Each entry's `at` is taken after the queue stored
// it, so once it is 2 hours old the queue can only drop it, never send it.
// Cleared on sign-out (lib/courtArrival clearCourtArrivalForSignOut).
export const PENDING_NOT_HERE_KEY = 'pickleague_pending_not_here_v1';
type PendingNotHere = { id: string; venueId: string; venueName?: string; at: number };
/** Entries a replay is sending right now (never told as aged out mid-send). */
const notHereRunning = new Set<string>();
/** Entries a replay already sent or had refused, so one that ran before the
 *  press was remembered isn't remembered after. */
const notHereDone = new Set<string>();
/** Entries already told in this run of the app. */
const notHereTold = new Set<string>();

async function readNotHere(): Promise<PendingNotHere[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_NOT_HERE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(v)
      ? (v as PendingNotHere[]).filter((e) => e && typeof e.id === 'string' && typeof e.venueId === 'string' && typeof e.at === 'number')
      : [];
  } catch {
    return [];
  }
}

async function writeNotHere(list: PendingNotHere[]): Promise<void> {
  try {
    if (list.length) await AsyncStorage.setItem(PENDING_NOT_HERE_KEY, JSON.stringify(list));
    else await AsyncStorage.removeItem(PENDING_NOT_HERE_KEY);
  } catch {
    // best-effort: at worst an aged-out press isn't told
  }
}

async function rememberNotHere(e: Omit<PendingNotHere, 'at'>): Promise<void> {
  if (notHereDone.has(e.id)) return;
  const list = await readNotHere();
  await writeNotHere([...list.filter((x) => x.id !== e.id), { ...e, at: Date.now() }]);
}

async function settleNotHere(id: string): Promise<void> {
  notHereDone.add(id);
  const list = await readNotHere();
  if (list.some((e) => e.id === id)) await writeNotHere(list.filter((e) => e.id !== id));
}

/** The court's name for these notices: the one saved, else a 2 s lookup. */
async function notHerePlace(venueId: string, name: string | null | undefined): Promise<string> {
  return name || (await withTimeout(getVenueName(venueId), 2_000).catch(() => null)) || 'the court';
}

/** Tell each Not here that aged out unsent, once, and forget it. */
async function reapNotHere(): Promise<void> {
  const now = Date.now();
  const list = await readNotHere();
  const aged = list.filter((e) => now - e.at >= ARRIVAL_CANCEL_MAX_AGE_MS && !notHereRunning.has(e.id));
  if (aged.length === 0) return;
  await writeNotHere(list.filter((e) => !aged.includes(e)));
  for (const e of aged) {
    if (notHereTold.has(e.id)) continue;
    notHereTold.add(e.id);
    const place = await notHerePlace(e.venueId, e.venueName);
    await noteRefusalNotice({
      key: `not-here-aged:${e.venueId}:${e.id}`,
      title: `"Not here" for ${place} wasn't sent`,
      body:
        'It waited over 2 hours for signal. If you were checked in there, that check-in stays. To stop automatic check-ins there, turn that court off in Settings, under Check-in automation.',
      link: CHECKINS_SETTINGS_LINK,
    });
  }
}

registerActionHandler('court_not_here', {
  timeoutMs: NOT_HERE_TIMEOUT_MS,
  // Home's court card shows the visit (the push's own link may open a QR code).
  timedOut: { ...NOT_HERE_TIMED_OUT, data: { deepLink: 'home/-' } },
  failure: { ...NOT_HERE_FAILED, data: { deepLink: 'home/-' } },
  success: (res, d) => {
    const r = res as { queued?: boolean; result?: CancelCourtArrivalResult } | null;
    const copy = notHereOutcome({ queued: r?.queued === true, result: r?.result ?? null }, d.venue_name);
    return { title: copy.title, body: copy.body, data: { deepLink: copy.link } };
  },
  run: async (d) => {
    // Signed out for sure, not just a session that can't be read right now (an
    // expired token with no signal to refresh it): that press queues below
    // and is sent once there's signal, like any other offline Not here.
    const who = await resolveUserId(supabase);
    if (who.resolved && !who.userId) await requireUser();
    const venueId = d.venue_id;
    if (!venueId) {
      throw new NeedsApp("This alert didn't say which court it was about. Open Pickleague to check your visit.", 'home/-');
    }
    void arrivalNotice.dismiss(venueId);
    // Its entry in the pending list below: the press time.
    const notHereId = new Date().toISOString();
    const venueName = d.venue_name ?? undefined;
    const res = await cancelCourtArrivalOrQueue(venueId, { notHere: true, venueName, notHereId });
    afterArrivalCancel(venueId, res);
    if (res.queued) await rememberNotHere({ id: notHereId, venueId, ...(venueName ? { venueName } : {}) });
    return res;
  },
});

// A queued Exit or Not here, sent once there is signal. The queue time is the
// Exit or the press, which the server acts on (within 2 hours; the queue
// keeps it no longer). An Exit is automatic, so nothing is said about it. A
// Not here was told "We'll stop the check-in here once you're back online":
// one refused says so, and one that lands after the check-in counted, so the
// server checked the player out instead, says that.
registerMutationHandler(ARRIVAL_CANCEL_MUTATION, {
  maxAgeMs: ARRIVAL_CANCEL_MAX_AGE_MS,
  run: async (payload, meta) => {
    const p = payload as Partial<ArrivalCancelPayload> | null;
    if (!p || typeof p.venueId !== 'string') return;
    const venueId = p.venueId;
    const notHere = p.notHere === true;
    const pendingId = typeof p.notHereId === 'string' ? p.notHereId : null;
    if (pendingId) notHereRunning.add(pendingId);
    let result: CancelCourtArrivalResult;
    try {
      result = await cancelCourtArrival(venueId, meta.queuedAt, notHere);
    } catch (e) {
      if (isRetryLater(e)) retryLater(e); // no signal / signed out: stays queued
      if (pendingId) await settleNotHere(pendingId);
      if (notHere) {
        const place = await notHerePlace(venueId, p.venueName);
        await noteRefusalNotice({
          key: `not-here:${venueId}:${pendingId ?? meta.queuedAt}`,
          title: `"Not here" for ${place} wasn't sent`,
          body: `${explainRefusal(e, 'Something went wrong on our side.')} Open Pickleague to check out.`,
          link: 'home/-',
        });
      }
      throw e; // refused: the queue drops it
    } finally {
      if (pendingId) notHereRunning.delete(pendingId);
    }
    if (pendingId) await settleNotHere(pendingId);
    afterArrivalCancel(venueId, { queued: false, result });
    if (notHere && result.closed && !result.removed) {
      const place = await notHerePlace(venueId, p.venueName);
      await noteRefusalNotice({
        key: `not-here-late:${venueId}:${pendingId ?? meta.queuedAt}`,
        title: `Checked out of ${place}`,
        body: 'Your "Not here" reached us after the check-in counted, so we checked you out instead.',
        link: 'home/-',
      });
    }
  },
});

// After any pass, and when the queue drops one (aged out), tell the ones that
// aged out. Also when the app comes to the front, and at start: the queue may
// have dropped one while Pickleague was closed.
onMutationQueueEvent((e) => {
  if (e.type === 'flushed' || (e.type === 'dropped' && e.mutationType === ARRIVAL_CANCEL_MUTATION)) void reapNotHere();
});
AppState.addEventListener('change', (s) => {
  if (s === 'active') void reapNotHere();
});
void reapNotHere();
