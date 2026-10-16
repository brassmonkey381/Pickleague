// The pure rules behind court check-ins (no React Native, no Supabase), so
// vitest covers them.
//
// No manual check-ins (docs/play-sessions-presence.md, decision 6 and rule 1):
// every check-in carries a fresh device fix, and checkin_venue on the server
// decides whether it is inside the court's fence. No fix, no check-in. A
// queued (offline) check-in carries the fix taken at tap time, so the server's
// 2-minute freshness rule refuses one that sat in the queue too long.
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

export type FixArgs = {
  p_lat: number | null;
  p_lng: number | null;
  p_accuracy_m: number | null;
  p_fix_at: string | null;
};

/** The four fix arguments checkin_venue and start_play_session share (all null: no fix). */
export function fixArgs(f: DeviceFix | null | undefined): FixArgs {
  return f
    ? { p_lat: f.lat, p_lng: f.lng, p_accuracy_m: f.accuracyM ?? null, p_fix_at: f.fixAt }
    : { p_lat: null, p_lng: null, p_accuracy_m: null, p_fix_at: null };
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
 */
export type CheckoutPayload = { id: string | null; source?: CheckinSource; at: string };

export function checkoutPayload(id: string | null, source: CheckinSource | undefined, nowMs: number): CheckoutPayload {
  return { id, ...(source ? { source } : {}), at: new Date(nowMs).toISOString() };
}

const messageOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m.trim() : '';
};

/** checkin_venue's refusal of a fix outside the fence ("You need to be at the court to check in (about 240 m away)."). */
export function isNotAtCourtError(e: unknown): boolean {
  return /need to be at the court/i.test(messageOf(e));
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
