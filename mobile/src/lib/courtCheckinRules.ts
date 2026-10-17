// The pure rules behind court check-ins (no React Native, no Supabase), so
// vitest covers them.
//
// No manual check-ins (docs/play-sessions-presence.md, decision 6 and rule 1):
// every check-in carries a fresh device fix, and checkin_venue on the server
// decides whether it is inside the court's fence. No fix, no check-in; an
// approximate fix (accuracy over 150 m) counts as none. The fix is judged at
// the TAP (supabase/migration_checkin_tap_time.sql, decided 2026-10-16): it
// must be taken within 2 minutes of the tap. Every call sends the tap (`at`),
// the fix time and the fix's age at send, all on this device's clock, so the
// server works out how long ago the tap was without trusting the clock. A
// queued (offline) check-in carries the fix taken at tap time and counts when
// it syncs up to 12 hours after the tap; one that syncs after it would have
// ended is stored as a visit nobody saw (the app says so once).
// Check-out sends a fresh fix only when one comes back within 3 s (never
// holding the check-out longer): the server reads it as proof the player
// stayed (Phase 1.5, stay_confirmed).
import type { CheckinSource, VenueCheckin } from '../data/venueCheckins';
import { noFixQueuedCheckinReason, queuedRefusalNotice, refusalCode, staleQueuedCheckinReason } from './refusals';

/** A device location fix, as checkin_venue and start_play_session take it. */
export type DeviceFix = {
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres, when the platform reports it. */
  accuracyM: number | null;
  /** When the fix was taken (ISO). */
  fixAt: string;
};

/**
 * The fix must be taken within this long of the tap (checkin_venue,
 * start_play_session); a call with no tap (extend) counts from the send.
 */
export const FIX_MAX_AGE_MS = 2 * 60_000;
const FIX_MAX_FUTURE_MS = 60_000;
/** A fix this recent is reused for the next tap instead of waiting on the radio again. */
export const FIX_REUSE_MS = 60_000;
/**
 * checkin_venue confirms a court only with a fix accurate to this many metres
 * (the server's own rule). A normal GPS / Wi-Fi fix is 5-100 m.
 */
export const FIX_MAX_ACCURACY_M = 150;
/**
 * Above this the phone or browser is sharing an approximate location on
 * purpose (iOS Precise Location off, Android "approximate", a browser's IP
 * guess: about 1-3 km), not just a poor fix.
 */
export const APPROXIMATE_FIX_M = 500;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A fix the server can use: real coordinates, a sane accuracy, a readable time. */
export function isValidFix(f: unknown): f is DeviceFix {
  if (!f || typeof f !== 'object') return false;
  const x = f as Partial<DeviceFix>;
  return (
    finite(x.lat) &&
    finite(x.lng) &&
    Math.abs(x.lat) <= 90 &&
    Math.abs(x.lng) <= 180 &&
    // 0,0 is a failed read, not a court.
    !(x.lat === 0 && x.lng === 0) &&
    (x.accuracyM == null || (finite(x.accuracyM) && x.accuracyM >= 0)) &&
    typeof x.fixAt === 'string' &&
    Number.isFinite(Date.parse(x.fixAt))
  );
}

/** A fix from the platform's coords, taken at `atMs`; null when unusable. */
export function fixFromCoords(
  c: { lat: number; lng: number; accuracy?: number | null } | null | undefined,
  atMs: number,
): DeviceFix | null {
  if (!c) return null;
  const fix: DeviceFix = { lat: c.lat, lng: c.lng, accuracyM: c.accuracy ?? null, fixAt: new Date(atMs).toISOString() };
  return isValidFix(fix) ? fix : null;
}

export function fixAgeMs(f: DeviceFix, nowMs: number): number {
  return nowMs - Date.parse(f.fixAt);
}

/** Fresh enough for the server's rule; `maxAgeMs` asks for a tighter one (e.g. FIX_REUSE_MS). */
export function isFixFresh(f: DeviceFix | null | undefined, nowMs: number, maxAgeMs = FIX_MAX_AGE_MS): f is DeviceFix {
  if (!isValidFix(f)) return false;
  const age = fixAgeMs(f, nowMs);
  return age >= -FIX_MAX_FUTURE_MS && age <= maxAgeMs;
}

/** Accurate enough for the server to confirm a court with (FIX_MAX_ACCURACY_M); an unknown accuracy is not. */
export function isPreciseFix(f: DeviceFix): boolean {
  return f.accuracyM != null && f.accuracyM <= FIX_MAX_ACCURACY_M;
}

/** What to tell the player about a fix too vague to confirm a court. */
export function impreciseFixMessage(accuracyM: number | null, platform: string): string {
  if (accuracyM != null && accuracyM <= APPROXIMATE_FIX_M) {
    return `Your location is only accurate to about ${Math.round(accuracyM)} m right now, not enough to confirm you're at the court. Try again in the open, or start without a court.`;
  }
  if (platform === 'web') {
    return "Your browser only shared an approximate location, so it can't confirm you're at the court. Try again, or start without a court.";
  }
  return platform === 'android'
    ? "Pickleague only got your approximate location, so it can't confirm you're at the court. Allow precise location for Pickleague in Settings, or start without a court."
    : "Pickleague only got your approximate location, so it can't confirm you're at the court. Turn on Precise Location for Pickleague in Settings, or start without a court.";
}

export type FixArgs = {
  p_lat: number | null;
  p_lng: number | null;
  p_accuracy_m: number | null;
  p_fix_at: string | null;
  /**
   * How old the fix is at send time, on the device's own clock. Recomputed on
   * every send. With the tap (p_at) and p_fix_at, both on the same clock, the
   * server dates the fix (now - age) and the tap (the fix + (tap - fix time))
   * on its own clock, so a phone whose clock is off is judged exactly.
   */
  p_fix_age_ms: number | null;
};

/**
 * The fix arguments checkin_venue, start_play_session and extend_checkin share
 * (all null: no fix). `nowMs` is the moment of sending. The callers send the
 * tap as p_at alongside (extend sends none: its tap is the send).
 */
export function fixArgs(f: DeviceFix | null | undefined, nowMs: number): FixArgs {
  return f
    ? {
        p_lat: f.lat,
        p_lng: f.lng,
        p_accuracy_m: f.accuracyM ?? null,
        p_fix_at: f.fixAt,
        p_fix_age_ms: Math.max(0, Math.round(nowMs - Date.parse(f.fixAt))),
      }
    : { p_lat: null, p_lng: null, p_accuracy_m: null, p_fix_at: null, p_fix_age_ms: null };
}

/** A check-in as sent, or as it sits in the offline queue. */
export type CheckinPayload = {
  id: string;
  venueId: string;
  minutes: number;
  source: CheckinSource;
  /** Tap time. */
  at: string;
  fix: DeviceFix;
};

/**
 * A check-out as sent or queued. `at` is when you really left, so a replay an
 * hour later doesn't stretch a 20-minute visit to the check-in's expiry.
 * `fix`, when one came back in time, was taken at the tap: the server reads
 * it as proof the player stayed (docs/play-sessions-presence.md, Phase 1.5),
 * placed in time by its age, so a queued check-out still counts.
 */
export type CheckoutPayload = {
  id: string | null;
  source?: CheckinSource;
  at: string;
  fix?: DeviceFix;
  /** The court and the check-in's own end, so a refusal on replay can say where and until when. */
  venueName?: string;
  until?: string;
};

export function checkoutPayload(
  id: string | null,
  source: CheckinSource | undefined,
  nowMs: number,
  fix?: DeviceFix | null,
): CheckoutPayload {
  return {
    id,
    ...(source ? { source } : {}),
    at: new Date(nowMs).toISOString(),
    ...(fix && isValidFix(fix) ? { fix } : {}),
  };
}

/** Check-out waits at most this long for a fresh fix, then goes without one. */
export const CHECKOUT_FIX_WAIT_MS = 3_000;

export type CheckoutFixArgs = {
  p_lat: number;
  p_lng: number;
  p_accuracy_m: number | null;
  /** Measured on this device at send time, as for a check-in (fixArgs). */
  p_fix_age_ms: number;
};

/**
 * checkout_venue's optional fix arguments. Without a fix: none at all, so the
 * call keeps the Phase 1 shape ({p_id, p_source, p_at}). checkout_venue takes
 * no p_fix_at.
 */
export function checkoutFixArgs(f: DeviceFix | null | undefined, nowMs: number): CheckoutFixArgs | Record<string, never> {
  if (!isValidFix(f)) return {};
  const a = fixArgs(f, nowMs);
  return { p_lat: f.lat, p_lng: f.lng, p_accuracy_m: a.p_accuracy_m, p_fix_age_ms: a.p_fix_age_ms ?? 0 };
}

/**
 * The fix `take` comes back with within `ms`, else null (also when it fails or
 * returns an unusable reading). Check-out never waits longer than this.
 */
export async function fixWithin(take: () => Promise<DeviceFix | null>, ms: number): Promise<DeviceFix | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fix = await Promise.race([
      Promise.resolve()
        .then(take)
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    return isValidFix(fix) ? fix : null;
  } finally {
    clearTimeout(timer);
  }
}

const messageOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m.trim() : '';
};

/** checkin_venue's refusal of a fix outside the fence ("You need to be at the court to check in (about 240 m away)."). */
export function isNotAtCourtError(e: unknown): boolean {
  return /need to be at the court/i.test(messageOf(e));
}

/** The server's refusal of a fix too vague to confirm a court ("Your location isn't precise enough ..."). */
export function isImpreciseFixError(e: unknown): boolean {
  return /precise enough/i.test(messageOf(e));
}

/** The server's refusal of a fix past the 2-minute rule ("Your location is out of date. ..."). */
export function isStaleFixError(e: unknown): boolean {
  return /location is out of date/i.test(messageOf(e));
}

/** A refusal after which an untracked session (no court) is the way on. */
export function offersUntrackedSession(e: unknown): boolean {
  const code = refusalCode(e);
  return (
    isNotAtCourtError(e) ||
    isImpreciseFixError(e) ||
    isStaleFixError(e) ||
    code === 'fix.after_tap' ||
    code === 'checkin.too_old'
  );
}

/** A stored check-in's times, as the server returns them (its own clock). */
export type CheckinTimes = Pick<VenueCheckin, 'expires_at' | 'created_at' | 'location_confirmed'> & {
  checked_in_at?: string;
  checked_out_at?: string | null;
};

/** When a stored check-in ended (or ends): its check-out when it has one before its expiry, else its expiry. */
export function checkinEndMs(row: Pick<CheckinTimes, 'expires_at' | 'checked_out_at'>): number {
  const expires = Date.parse(row.expires_at);
  const out = row.checked_out_at ? Date.parse(row.checked_out_at) : NaN;
  return Number.isFinite(out) && !(out > expires) ? out : expires;
}

/**
 * A confirmed check-in the server stored after it had already ended: saved
 * with no signal and synced later than tap + its minutes, or after its
 * check-out (a check-out that reached Pickleague first: the current server
 * stores it closed, migration_checkin_tap_time.sql; an older one sent back an
 * unconfirmed row, never one). Read from the server's own times (its end,
 * created_at), so no clock offset can fake it.
 */
export function syncedAfterItEnded(row: CheckinTimes | null | undefined): boolean {
  if (!row || row.location_confirmed === false || !row.created_at) return false;
  const ended = checkinEndMs(row);
  const stored = Date.parse(row.created_at);
  return Number.isFinite(ended) && Number.isFinite(stored) && ended <= stored;
}

/**
 * What the "Check-in saved late" notice says about a replay stored after it
 * had ended (syncedAfterItEnded), every time on the server's clock so the
 * three agree on a phone whose clock is off: the tap is the server's
 * checked_in_at (the device's `tapIso` only when the row lacks it); a
 * check-out tapped on this device (`leftAtMs`, device clock) is moved onto the
 * server's clock by the time that passed on the phone since the tap.
 *   checkedOut: the visit ended at the player's own check-out (the server's,
 *     when it landed first; else the one tapped here), not at its expiry;
 *   checkInAgain: offer "Check in again" only when nothing says the player
 *     left (no check-out) and no newer check-in of theirs is current.
 */
export function lapsedCheckinFacts(p: {
  row: Pick<CheckinTimes, 'expires_at' | 'created_at' | 'checked_in_at' | 'checked_out_at'>;
  tapIso: string;
  leftAtMs?: number | null;
  newerCheckin?: boolean;
}): { tapMs: number; endedMs: number; syncedMs: number; checkedOut: boolean; checkInAgain: boolean } {
  const deviceTap = Date.parse(p.tapIso);
  const serverTap = p.row.checked_in_at ? Date.parse(p.row.checked_in_at) : NaN;
  const tapMs = Number.isFinite(serverTap) ? serverTap : deviceTap;
  const expires = Date.parse(p.row.expires_at);
  const syncedMs = p.row.created_at ? Date.parse(p.row.created_at) : NaN;
  const serverOut = p.row.checked_out_at ? Date.parse(p.row.checked_out_at) : NaN;
  const left = p.leftAtMs != null && Number.isFinite(p.leftAtMs) ? p.leftAtMs : null;
  let endedMs = checkinEndMs(p.row);
  let checkedOut = false;
  if (Number.isFinite(serverOut) && serverOut < expires) {
    checkedOut = true;
  } else if (left != null && !Number.isFinite(serverOut)) {
    const leftServer =
      Number.isFinite(deviceTap) && Number.isFinite(tapMs) ? tapMs + Math.max(0, left - deviceTap) : left;
    if (leftServer < expires) {
      checkedOut = true;
      endedMs = leftServer;
    }
  }
  // A check-out tapped here after the check-in had ended still means I left.
  // (A server check-out AT the expiry can't be told from the expiry job's.)
  const leftAtAll = checkedOut || left != null;
  return { tapMs, endedMs, syncedMs, checkedOut, checkInAgain: !leftAtAll && !p.newerCheckin };
}

/**
 * Give a write still in the offline queue (a check-in, a Start) the chance to
 * land before the write that closes it (its check-out, its End), so it isn't
 * the closing write that reaches Pickleague first: ask the queue to send
 * (`kick`), then wait until `stillQueued()` is false, at most `ms`. True when
 * it left the queue in time (or can't be read). Never throws.
 *
 * Not an enqueue behind it: the kit's flush writes its own snapshot of the
 * queue back when it ends, so an entry added while a flush runs can be lost
 * (a check-out gone with no word). The server copes with either order anyway
 * (migration_checkin_tap_time.sql stores a late check-in or Start closed at
 * the check-out or End that landed first); waiting keeps the stay fix.
 */
export async function waitUntilSent(p: {
  kick: () => void;
  stillQueued: () => Promise<boolean>;
  ms: number;
  stepMs?: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const now = p.nowMs ?? Date.now;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + p.ms;
  try {
    p.kick();
  } catch {
    // the wait below still bounds it
  }
  for (;;) {
    let queued: boolean;
    try {
      queued = await p.stillQueued();
    } catch {
      return true;
    }
    if (!queued) return true;
    const left = until - now();
    if (left <= 0) return false;
    await sleep(Math.min(p.stepMs ?? 200, left));
  }
}

/**
 * A queued check-in an OLDER server refused for waiting in the queue: it
 * judged the fix by its age when sent, so its "out of date" (fix.stale) on a
 * fix that was fresh at its own tap means "it synced over 2 minutes late".
 * The current server judges the fix at the tap, so it says fix.stale only for
 * a fix taken over 2 minutes before the tap, and words its other reasons.
 */
export function refusedForQueueWait(error: unknown, fix: DeviceFix | null | undefined, tapIso: string): boolean {
  if (refusalCode(error) !== 'fix.stale' || !isValidFix(fix)) return false;
  const tapMs = Date.parse(tapIso);
  return Number.isFinite(tapMs) && fixAgeMs(fix, tapMs) <= FIX_MAX_AGE_MS;
}

/**
 * extend_checkin's refusal of an extension with no fix, 4 hours past the last
 * one that confirmed the court ("To stay checked in, open Pickleague at the
 * court ..."), or of a fix that doesn't confirm it.
 */
export function needsCourtToExtend(e: unknown): boolean {
  return /open Pickleague at the court/i.test(messageOf(e)) || offersUntrackedSession(e);
}

/**
 * What to tell the player about a queued check-in the server refused on
 * replay (or dropped unsent): why, then what to do (lib/refusals words it).
 */
export function rejectedCheckinNotice(p: {
  venueName: string;
  /**
   * The tap. Worded in the device's zone with its day when it wasn't today
   * ("Tue 5:40 PM"): a refusal for being over 12 hours late is always
   * another day's tap.
   */
  tapMs?: number;
  /** A fixed label for the tap instead (tests). */
  timeLabel?: string;
  nowMs?: number;
  /** An older server refused it for syncing over 2 minutes late (refusedForQueueWait). */
  waitedTooLong: boolean;
  /** Saved by an older build with no fix at all: never sent. */
  noFix?: boolean;
  error: unknown;
}): string {
  const label = p.timeLabel;
  return queuedRefusalNotice({
    what: 'check_in',
    venueName: p.venueName,
    tapMs: p.tapMs != null && Number.isFinite(p.tapMs) ? p.tapMs : Date.now(),
    ...(label != null ? { timeLabel: () => label } : {}),
    nowMs: p.nowMs,
    error: p.error,
    // Otherwise the server's own reason: too old, the fix away from the tap,
    // how far from the court, too vague.
    reason: p.noFix ? noFixQueuedCheckinReason() : p.waitedTooLong ? staleQueuedCheckinReason() : null,
  });
}

/** Why there is no check-in when no fix came back. */
export function noFixMessage(status: 'granted' | 'denied' | 'undetermined', platform: string): string {
  if (status === 'denied') {
    return platform === 'web'
      ? "Check-ins need your location to confirm you're at the court. Allow location for this site in your browser, or start without a court."
      : "Check-ins need your location to confirm you're at the court. Turn on location for Pickleague in Settings, or start without a court.";
  }
  return "Couldn't get your location. Check-ins need it to confirm you're at the court. Try again, or start without a court.";
}
