// The pure rules behind court check-ins (no React Native, no Supabase), so
// vitest covers them.
//
// No manual check-ins (docs/play-sessions-presence.md, decision 6 and rule 1):
// every check-in carries a fresh device fix, and checkin_venue on the server
// decides whether it is inside the court's fence. No fix, no check-in; an
// approximate fix (accuracy over 150 m) counts as none. A queued (offline)
// check-in carries the fix taken at tap time and sends its age at every try
// (measured on this device's clock), so the server's 2-minute freshness rule
// refuses one that sat in the queue too long, whatever the phone's clock says.
// Check-out sends a fresh fix only when one comes back within 3 s (never
// holding the check-out longer): the server reads it as proof the player
// stayed (Phase 1.5, stay_confirmed).
import type { CheckinSource } from '../data/venueCheckins';

/** A device location fix, as checkin_venue and start_play_session take it. */
export type DeviceFix = {
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres, when the platform reports it. */
  accuracyM: number | null;
  /** When the fix was taken (ISO). */
  fixAt: string;
};

/** checkin_venue refuses a fix older than this, or more than a minute in the future. */
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
   * How old the fix is at send time, on the device's own clock (so a phone
   * whose clock is off still passes the server's 2-minute rule). Recomputed on
   * every send, so a queued replay counts its time in the queue.
   */
  p_fix_age_ms: number | null;
};

/**
 * The fix arguments checkin_venue, start_play_session and extend_checkin share
 * (all null: no fix). `nowMs` is the moment of sending.
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
export type CheckoutPayload = { id: string | null; source?: CheckinSource; at: string; fix?: DeviceFix };

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
  return isNotAtCourtError(e) || isImpreciseFixError(e) || isStaleFixError(e);
}

/**
 * extend_checkin's refusal of an extension with no fix, 4 hours past the last
 * one that confirmed the court ("To stay checked in, open Pickleague at the
 * court ..."), or of a fix that doesn't confirm it.
 */
export function needsCourtToExtend(e: unknown): boolean {
  return /open Pickleague at the court/i.test(messageOf(e)) || offersUntrackedSession(e);
}

/** What to tell the player about a queued check-in the server refused on replay. */
export function rejectedCheckinNotice(p: {
  venueName: string;
  /** The tap time, in the device's zone ("5:40 PM"). */
  timeLabel: string;
  /** The fix was past the 2-minute rule when it was sent. */
  fixWasStale: boolean;
  error: unknown;
}): string {
  const head = `Your check-in at ${p.venueName} (${p.timeLabel}) didn't go through.`;
  if (p.fixWasStale) {
    return `${head} It was saved with no signal, and a check-in has to reach Pickleague within 2 minutes to confirm you were at the court.`;
  }
  const why = messageOf(p.error);
  return why ? `${head} ${why}` : head;
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
