// "On my way": tell friends you're heading to a court, about N minutes out
// (supabase/migration_on_my_way.sql, ported from Doggle's 0425 / 0437).
//
// The sheet (components/OnMyWaySheet) sends with the ETA already picked (15
// minutes, or the last one this device used), so one tap on its button does
// it; the chips change it. Friends at the court and close friends start
// ticked. The server keeps it from being spam: one send per court per 30
// minutes, and each friend told at most once per 30 minutes; every "not sent"
// answer comes back with a reason this module words (rule 11: say why and
// what to do).
//
// PURE (no React Native, no kit imports), so vitest covers it
// (lib/__tests__/onMyWay.test.ts).
import { whenLabel } from './refusals';

/** The ETA chips, in minutes. */
export const ETA_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;
export const DEFAULT_ETA_MINUTES = 15;
/** What the server accepts (send_on_my_way refuses anything else with pl:omw.bad_eta). */
export const MIN_ETA_MINUTES = 1;
export const MAX_ETA_MINUTES = 180;
/** send_on_my_way's cap (pl:omw.too_many past it). */
export const MAX_RECIPIENTS = 50;
/** The server's window: one send per court, and one push per friend, per 30 minutes. */
export const ON_MY_WAY_WINDOW_MS = 30 * 60_000;

export function validEta(m: unknown): m is number {
  return typeof m === 'number' && Number.isInteger(m) && m >= MIN_ETA_MINUTES && m <= MAX_ETA_MINUTES;
}

/** A stored ETA ("20"), or the default when it is missing, garbled or out of range. */
export function parseStoredEta(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_ETA_MINUTES;
  const n = Number(raw.trim());
  return validEta(n) ? n : DEFAULT_ETA_MINUTES;
}

/** "15 min", "1 hr", "1 hr 30 min": the server's _pl_eta_label. */
export function etaLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export type OnMyWayReason = 'recent' | 'recent_friends' | 'nobody';

export type OnMyWayResult = {
  sent: boolean;
  /** Friends told (a friend whose phone can't get it counts too: the reply never reveals settings). */
  count: number;
  /** Friends picked but skipped: told by me (about any court) in the last 30 minutes. */
  skippedRecent: number;
  reason: OnMyWayReason | null;
  etaMinutes: number;
  venueId: string | null;
  venueName: string | null;
  /** The send (sent), or the last send at this court ('recent'). */
  sentAt: string | null;
  /** When another send can go out ('recent', 'recent_friends'). */
  retryAt: string | null;
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const text = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

/** send_on_my_way's jsonb, defensively: an unknown reason on a "not sent" reads as nobody. */
export function normalizeOnMyWayResult(raw: unknown, etaSent: number): OnMyWayResult {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sent = r.sent === true;
  const reason = r.reason === 'recent' || r.reason === 'recent_friends' || r.reason === 'nobody' ? r.reason : null;
  return {
    sent,
    count: num(r.count),
    skippedRecent: num(r.skipped_recent),
    reason: sent ? null : reason ?? 'nobody',
    etaMinutes: validEta(r.eta_minutes) ? r.eta_minutes : etaSent,
    venueId: text(r.venue_id),
    venueName: text(r.venue_name),
    sentAt: text(r.sent_at),
    retryAt: text(r.retry_at),
  };
}

/** "8 min ago", "just now", "1 hr ago". */
export function agoLabel(atIso: string | null, nowMs: number): string | null {
  if (!atIso) return null;
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (mins < 1) return 'just now';
  return `${etaLabel(mins)} ago`;
}

/**
 * The toast for an answer. `picked`: the friends were chosen in the sheet
 * (false: the server's default, close friends). `timeLabel` formats a time in
 * the device's zone (default "6:42 PM", or "Thu 6:42 PM" another day).
 */
export function onMyWayMessage(
  res: OnMyWayResult,
  ctx: { venueName: string; nowMs: number; picked?: boolean; timeLabel?: (d: Date) => string },
): string {
  const court = res.venueName ?? ctx.venueName;
  const at = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return null;
    return ctx.timeLabel ? ctx.timeLabel(new Date(t)) : whenLabel(new Date(t), ctx.nowMs);
  };
  const friends = (n: number) => (n === 1 ? '1 friend' : `${n} friends`);
  if (res.sent) {
    const told = `Told ${friends(res.count)} you're about ${etaLabel(res.etaMinutes)} from ${court}.`;
    if (res.skippedRecent > 0) {
      return `${told} ${friends(res.skippedRecent)} you told in the last 30 minutes ${res.skippedRecent === 1 ? "wasn't" : "weren't"} told again.`;
    }
    return told;
  }
  switch (res.reason) {
    case 'recent': {
      const ago = agoLabel(res.sentAt, ctx.nowMs);
      const next = at(res.retryAt);
      return `You already told your friends you're on the way to ${court}${ago ? ` ${ago}` : ''}, so nobody was told again. ${
        next ? `You can send another after ${next}.` : 'You can send another 30 minutes after the last one.'
      }`;
    }
    case 'recent_friends': {
      const next = at(res.retryAt);
      return `You told ${ctx.picked === false ? 'your close friends' : 'those friends'} you were on the way less than 30 minutes ago, so they weren't told again. Pick other friends${
        next ? `, or try again after ${next}` : ''
      }.`;
    }
    case 'nobody':
    default:
      return ctx.picked === false
        ? "You don't have any close friends to tell yet. Pick the friends to tell instead."
        : "None of the friends you picked could be told: they're no longer on your friends list. Pick other friends.";
  }
}

export type OnMyWayFriend = {
  userId: string;
  name: string;
  isCloseFriend: boolean;
  /** "Here now" when the feed shows them at this court. */
  note: string | null;
};

/** Who starts ticked: friends at that court, then close friends (the presence
 *  rule: pushes go to close friends). Never more than the server's cap. */
export function defaultRecipients(friends: readonly OnMyWayFriend[]): string[] {
  const out: string[] = [];
  for (const f of friends) if (f.note != null) out.push(f.userId);
  for (const f of friends) if (f.note == null && f.isCloseFriend) out.push(f.userId);
  return out.slice(0, MAX_RECIPIENTS);
}

/** The list order: friends at the court, then close friends, then everyone by name. */
export function sortRecipients<T extends OnMyWayFriend>(friends: readonly T[]): T[] {
  const rank = (f: OnMyWayFriend) => (f.note != null ? 0 : f.isCloseFriend ? 1 : 2);
  return [...friends].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The sheet's button: "Tell 3 friends · about 15 min". */
export function sendLabel(count: number, etaMinutes: number): string {
  if (count === 0) return 'Pick friends to tell';
  return `Tell ${count === 1 ? '1 friend' : `${count} friends`} · about ${etaLabel(etaMinutes)}`;
}

/** Why the button is off, in words (rule 11), or null when it can send. */
export function sendBlockedReason(count: number): string | null {
  if (count === 0) return 'Pick at least one friend to tell.';
  if (count > MAX_RECIPIENTS) return `You can tell up to ${MAX_RECIPIENTS} friends at once. Untick ${count - MAX_RECIPIENTS} to send.`;
  return null;
}

/** Whether this device sent one for that court in the last 30 minutes (the feed's "Told friends"). */
export function sentRecently(sentAtMs: number | undefined, nowMs: number): boolean {
  // A minute-tick clock may read a little before the send: still recent.
  return sentAtMs != null && nowMs - sentAtMs < ON_MY_WAY_WINDOW_MS;
}
