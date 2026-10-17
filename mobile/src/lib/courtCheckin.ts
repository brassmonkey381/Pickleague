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
// still counts); one that lands before its check-in makes that
// check-in land closed (the server remembers the id). Extend is NOT queued: an
// extension that lands after the check-in lapsed would be refused anyway, so
// it fails loudly instead. It sends a fix when it can: without one the server
// keeps a confirmed check-in at most 4 hours past its last confirming fix.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { registerMutationHandler, runOrQueue } from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { TimeoutError } from '@just-messin-around/expo-foundation/platform';
import {
  getCurrentCoords,
  getForegroundLocationStatus,
  requestForegroundLocationPermission,
} from '@just-messin-around/expo-foundation/platform/location';
import { cancelLocalNotification, scheduleLocalNotification } from '@just-messin-around/expo-foundation/platform/push';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { uuidv4 } from './analytics';
import { shortTime } from './agenda';
import { catalog, NeedsApp, refusalNeedsApp, registerActionHandler, requireUser } from './notificationActions';
import { titleWith } from './pushSubject';
import { isRetryLater, noteRefusalNotice } from './refusalNotices';
import {
  extendedNote,
  lapsedCheckinNotice,
  queuedCheckinRanOutNote,
  queuedRefusalNotice,
  refusalCode,
  whenLabel,
} from './refusals';
import { isEndPending } from './playEndPending';
import { readPendingEnds } from './playEndPendingStore';
import {
  CHECKOUT_FIX_WAIT_MS,
  checkoutPayload,
  fixFromCoords,
  fixWithin,
  impreciseFixMessage,
  isPreciseFix,
  isValidFix,
  needsCourtToExtend,
  noFixMessage,
  refusedForQueueWait,
  rejectedCheckinNotice,
  syncedAfterItEnded,
  type CheckinPayload,
  type CheckoutPayload,
  type DeviceFix,
} from './courtCheckinRules';
import {
  checkinVenue,
  checkoutVenue,
  extendCheckin,
  getMyOpenCheckin,
  getVenueName,
  type CheckinSource,
  type VenueCheckin,
} from '../data/venueCheckins';

export type CurrentCheckin = {
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  expiresAt: string;
  source: CheckinSource;
  /** Saved offline; not on the server yet. */
  queued?: boolean;
  /** Made by an older build without a fix: stored privately, nobody sees it (the card says so). */
  private?: boolean;
};

const STORAGE_KEY = 'pickleague_current_checkin_v1';
const REJECTED_KEY = 'pickleague_checkin_rejected_v1';
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
  checkinChanged.emit(c);
}

function scheduleReminder(c: CurrentCheckin): Promise<boolean> {
  return scheduleLocalNotification({
    id: REMINDER_ID,
    at: new Date(c.expiresAt).getTime() - 5 * 60_000,
    title: `Still at ${c.venueName}?`,
    body: 'Your check-in ends in 5 minutes.',
    categoryId: catalog.ids.checkin_extend.id,
    // A tap opens Home's court card (there is no court screen yet).
    data: { checkin_id: c.id, expires_at: c.expiresAt, venue_id: c.venueId, venue_name: c.venueName, deepLink: 'home/-' },
  });
}

const live = (c: CurrentCheckin | null) => (c && new Date(c.expiresAt).getTime() > Date.now() ? c : null);

/**
 * A queued check-in that landed: take the server's id and end time (it may be
 * a check-in I already had there). One that landed after it would have ended
 * is stored as a visit nobody saw: drop it from the card and say so once (the
 * card may have dropped it already when it ran out here).
 */
async function adoptReplayed(payload: CheckinPayload, row: VenueCheckin): Promise<void> {
  const cached = await readStored();
  const mine = cached?.id === payload.id ? cached : null;
  if (syncedAfterItEnded(row)) {
    if (mine) await setCurrent(null);
    const venueName = mine?.venueName ?? (await getVenueName(row.venue_id).catch(() => null)) ?? null;
    const tapMs = Date.parse(payload.at);
    await noteRefusalNotice({
      key: `checkin-late:${row.id}`,
      title: 'Check-in saved late',
      body: lapsedCheckinNotice({
        venueName,
        tapMs: Number.isFinite(tapMs) ? tapMs : Date.parse(row.checked_in_at),
        endedMs: Date.parse(row.expires_at),
        syncedMs: Date.parse(row.created_at as string),
      }),
      link: 'home/-',
    });
    return;
  }
  if (!mine) return;
  await setCurrent({ ...mine, id: row.id, venueId: row.venue_id, expiresAt: row.expires_at, source: row.source, queued: undefined });
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
  const notice = rejectedCheckinNotice({
    venueName,
    timeLabel: shortTime(new Date(payload.at)),
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
  const next: CurrentCheckin = {
    id: row.id,
    userId: uid,
    venueId: row.venue_id,
    venueName,
    expiresAt: row.expires_at,
    source: row.source,
    ...(row.location_confirmed === false ? { private: true } : {}),
  };
  if (
    !cached ||
    cached.id !== next.id ||
    cached.expiresAt !== next.expiresAt ||
    cached.queued ||
    !!cached.private !== !!next.private
  ) {
    await setCurrent(next);
  }
  return next;
}

// ── Writes ──────────────────────────────────────────────────────────────────
/**
 * Check in now with the fix just taken. Queues when offline (the result has
 * `queued: true`). Rejects with the server's "You need to be at the court to
 * check in (about N m away)." when the fix is outside the fence.
 */
export async function checkInAt(
  venue: { id: string; name: string },
  fix: DeviceFix,
  opts: { source?: CheckinSource; minutes?: number } = {},
): Promise<CurrentCheckin> {
  const uid = await requireUser();
  const minutes = opts.minutes ?? 120;
  const payload: CheckinPayload = {
    id: uuidv4(),
    venueId: venue.id,
    minutes,
    source: opts.source ?? 'manual',
    at: new Date().toISOString(),
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
    ...(queued ? { queued: true } : {}),
  };
  await setCurrent(c);
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
 * Check out (one check-in, or all of mine). Queues when offline, with the real
 * leave time. Sends a fresh fix only when one comes back within 3 s and
 * location is already allowed (never a prompt): proof I stayed at the court
 * (Phase 1.5). Without one it checks out exactly as before. `fix: false` skips
 * it (a geofence exit: I've left, so a fix there proves nothing).
 */
export async function checkOut(
  id: string | null,
  source?: CheckinSource,
  opts: { fix?: boolean } = {},
): Promise<{ queued: boolean }> {
  const fix =
    opts.fix === false ? null : await fixWithin(() => takeFixIfAllowed(CHECKOUT_FIX_WAIT_MS), CHECKOUT_FIX_WAIT_MS);
  const cached = await readStored();
  const mine = cached && (id === null || cached.id === id) && (!source || cached.source === source) ? cached : null;
  // Where and until when, for the notice if a queued check-out is refused later.
  const payload: CheckoutPayload = {
    ...checkoutPayload(id, source, Date.now(), fix),
    ...(mine ? { venueName: mine.venueName, until: mine.expiresAt } : {}),
  };
  const { queued } = await runOrQueue(MUTATION_CHECKOUT, payload, () =>
    checkoutVenue(id, source, payload.at, payload.fix ?? null),
  );
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
}

// ── Lock-screen buttons on the "5 minutes left" reminder ────────────────────
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
    const fix = await takeFixIfAllowed(5_000);
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
registerActionHandler('checkin_out', {
  // Waits up to CHECKOUT_FIX_WAIT_MS for the stay-proof fix, then the 9 s write.
  timeoutMs: 10_000 + CHECKOUT_FIX_WAIT_MS,
  success: (_res, d) => ({ title: titleWith('Checked out', d.venue_name), body: 'See you next time.' }),
  queued: { title: 'Checked out', body: 'Saved. It syncs when you are back online.' },
  run: async (d) => {
    await requireUser();
    return checkOut(d.checkin_id ?? null);
  },
});
