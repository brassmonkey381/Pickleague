// Why something was refused, and what to do, in plain words: the ONE place the
// app turns a refusal into copy (docs/play-sessions-presence.md, rule 11:
// "every refusal says why and what to do").
//
// The server (supabase/migration_refusal_messages.sql) raises every refusal
// with SQLSTATE P0001, a readable message (what 1.0.4 and older bundles show
// as is) and a stable code in HINT as 'pl:<code>'; DETAIL, where set, is a
// small JSON object with the numbers to word (distance_m, ended_at,
// last_fix_at, deadline). This module reads the code (or, from a server
// without that file, the old message) and words it with what the app knows
// and the server doesn't: the court's and the person's name, and times in the
// device's own zone. A few codes are the app's own (a 42501 on a match insert,
// the consent sheet, a queued write the server refused later), so their copy
// lives here too.
//
// PURE (no React Native, no kit imports), so vitest covers it
// (lib/__tests__/refusals.test.ts). lib/refusalNotices.ts is the side that
// shows them; callers fall back to friendlySbMessage for anything this
// doesn't know (explainRefusal there).
import { shortTime } from './agenda';

export const REFUSAL_CODES = [
  // From the server (HINT 'pl:<code>').
  'auth.signed_out',
  'request.bad',
  'court.gone',
  'court.favorites_full',
  'fix.stale',
  'fix.stale_clock',
  'fix.imprecise',
  'fix.not_at_court',
  'fix.malformed',
  // migration_checkin_tap_time.sql: the fix is judged at the tap.
  'fix.after_tap',
  'checkin.none',
  'checkin.closed',
  'checkin.needs_fix',
  'checkin.too_old',
  'session.not_yours',
  'membership.locked',
  'match.removed',
  'match.already_confirmed',
  'match.scheduled',
  'match.confirm_expired',
  'match.not_player',
  'player.gone',
  'presence.pick_someone',
  'friend.self',
  'friend.guest_caller',
  'friend.unclaimed',
  'friend.guest',
  'friend.unavailable',
  'friend.daily_cap',
  'friend.not_friends',
  // migration_schedule_match_rpc.sql: schedule_league_match.
  'schedule.not_member',
  'schedule.player_not_member',
  'schedule.same_player',
  'schedule.in_past',
  'schedule.too_far',
  'schedule.use_rpc',
  // Only from an older server's message (it couldn't tell these apart).
  'match.not_pending',
  // The app's own.
  'match.not_member',
  'match.score_invalid',
  'consent.declined',
  'consent.unknown_offline',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(REFUSAL_CODES);

/** Which action was refused, where the same code reads differently. */
export type RefusalAction = 'check_in' | 'extend' | 'start' | 'favorite' | 'hide' | 'friend' | 'confirm';

export type RefusalContext = {
  action?: RefusalAction;
  /** The court ("Lakeside"), when the caller knows it. */
  venueName?: string | null;
  /** The other person's name (first name is enough). */
  personName?: string | null;
  leagueName?: string | null;
  /** 'lock': a lock-screen notice (the app isn't open); default 'app'. */
  surface?: 'app' | 'lock';
  /** Formats a time in the device's zone. Default: "5:40 PM" today, "Thu 5:40 PM" another day. */
  timeLabel?: (d: Date) => string;
  /** For the default timeLabel and tests. */
  nowMs?: number;
};

type ErrorLike = { message?: unknown; hint?: unknown; details?: unknown; detail?: unknown; code?: unknown };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const messageOf = (e: unknown): string => str((e as ErrorLike | null)?.message);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "5:40 PM" today, "Thu 5:40 PM" on another day (device zone). */
export function whenLabel(d: Date, nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? shortTime(d) : `${WEEKDAYS[d.getDay()]} ${shortTime(d)}`;
}

// Messages from a server without migration_refusal_messages.sql (the texts
// before 2026-10-16), and the new texts when a hint got lost on the way.
const LEGACY: ReadonlyArray<[RegExp, RefusalCode]> = [
  [/^Not authenticated$|signed out\. Sign in to Pickleague/i, 'auth.signed_out'],
  [/need to be at the court/i, 'fix.not_at_court'],
  [/precise enough/i, 'fix.imprecise'],
  [/location is out of date\. Check that your phone/i, 'fix.stale_clock'],
  [/location is out of date/i, 'fix.stale'],
  [/location didn.t come through/i, 'fix.malformed'],
  [/^Court not found$|court isn.t in Pickleague any more/i, 'court.gone'],
  [/^Check-in is no longer open$/i, 'checkin.closed'],
  [/open Pickleague at the court/i, 'checkin.needs_fix'],
  [/^Missing (check-in|session) id$|^Bad source$|^Not your check-in$|incomplete request/i, 'request.bad'],
  [/^Not your session$/i, 'session.not_yours'],
  [/^Match not found$/i, 'match.removed'],
  [/^Confirmation window has expired$/i, 'match.confirm_expired'],
  [/^Match is no longer pending$/i, 'match.not_pending'],
  [/^Only players on this match can confirm/i, 'match.not_player'],
  [/^Player not found$/i, 'player.gone'],
  [/^Pick someone else$/i, 'presence.pick_someone'],
  [/^You can.t add yourself as a friend/i, 'friend.self'],
  [/^Create an account to add friends$/i, 'friend.guest_caller'],
  [/^This player isn.t available/i, 'friend.unavailable'],
  [/^You.ve sent 20 friend requests today/i, 'friend.daily_cap'],
  [/^Only friends can be close friends/i, 'friend.not_friends'],
  [/^You can star up to 5 courts/i, 'court.favorites_full'],
];

/** The refusal's code: the server's HINT 'pl:<code>', else a known message. Null for anything else. */
export function refusalCode(e: unknown): RefusalCode | null {
  if (!e || typeof e !== 'object') return null;
  const hint = str((e as ErrorLike).hint).match(/^pl:([a-z_.]+)$/);
  if (hint && CODE_SET.has(hint[1])) return hint[1] as RefusalCode;
  const m = messageOf(e);
  if (!m) return null;
  for (const [re, code] of LEGACY) if (re.test(m)) return code;
  return null;
}

/** The DETAIL JSON object, when there is one. */
export function refusalDetail(e: unknown): Record<string, unknown> {
  const raw = (e as ErrorLike | null)?.details ?? (e as ErrorLike | null)?.detail;
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function dateOf(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** "about 330 m": from DETAIL, else the old "(about 328 m away)" text. */
function distanceOf(detail: Record<string, unknown>, message: string): number | null {
  const d = detail.distance_m;
  if (typeof d === 'number' && Number.isFinite(d)) return Math.round(d);
  const m = message.match(/about (\d+) m/i);
  return m ? Number(m[1]) : null;
}

/**
 * The copy for a code. `detail` is the refusal's DETAIL object ({} when none),
 * `message` the server's text (some old texts carry a number).
 */
export function refusalCopy(
  code: RefusalCode,
  ctx: RefusalContext = {},
  detail: Record<string, unknown> = {},
  message = '',
): string {
  const at = (d: Date) => (ctx.timeLabel ? ctx.timeLabel(d) : whenLabel(d, ctx.nowMs));
  const court = ctx.venueName?.trim() || null;
  const person = ctx.personName?.trim() || null;
  const lock = ctx.surface === 'lock';
  switch (code) {
    case 'auth.signed_out':
      return "You're signed out. Sign in to Pickleague and try again.";
    case 'request.bad':
      return ctx.action === 'start'
        ? "Couldn't save your play session because this version of Pickleague sent an incomplete request. Update Pickleague, then start again."
        : "That didn't go through because this version of Pickleague sent an incomplete request. Update Pickleague, then try again.";
    case 'court.gone':
      return ctx.action === 'favorite'
        ? "That court isn't in Pickleague any more, so it can't be starred."
        : `${court ?? 'That court'} isn't in Pickleague any more, so you can't check in there. Find your court again.`;
    case 'court.favorites_full':
      return 'You can star up to 5 courts. Unstar one to add this one.';
    case 'fix.stale':
      // True from an older server too: a live call's tap is its send.
      return 'Your location is out of date: it was taken more than 2 minutes before you tapped. Try again at the court.';
    case 'fix.after_tap':
      return "Your location was taken more than 2 minutes after you tapped, so it can't show you were at the court then. Check in again when you're at the court.";
    case 'fix.stale_clock':
      return "Your location is out of date. Check that your phone's date and time are set automatically, then try again at the court.";
    case 'fix.imprecise':
      return "Your location isn't precise enough to confirm you're at the court. Turn on Precise Location for Pickleague, then try again.";
    case 'fix.not_at_court': {
      const d = distanceOf(detail, message);
      const where = court ?? 'the court';
      const away = d != null ? `You're about ${d} m from ${where}` : `You're not at ${where}`;
      return ctx.action === 'extend'
        ? `${away}, so your check-in can't be extended. Check in again when you're back at the court.`
        : `${away}. You need to be at the court to check in, so try again when you get there.`;
    }
    case 'fix.malformed':
      return "Your location didn't come through, so Pickleague couldn't confirm you're at the court. Try again.";
    case 'checkin.none':
      return "You're not checked in anywhere, so there's nothing to extend. Check in when you're at a court.";
    case 'checkin.closed': {
      const ended = dateOf(detail.ended_at);
      return `Your check-in at ${court ?? 'the court'} already ended${ended ? ` at ${at(ended)}` : ''}. Check in again when you're at the court.`;
    }
    case 'checkin.needs_fix': {
      const last = dateOf(detail.last_fix_at);
      const since = last ? `Pickleague last confirmed you at ${court ?? 'the court'} at ${at(last)}` : `Pickleague couldn't confirm you're still at ${court ?? 'the court'}`;
      return lock
        ? `${since}, and a check-in lasts at most 4 hours past that. Open Pickleague at the court to stay checked in.`
        : `${since}, and a check-in lasts at most 4 hours past that. Turn on location for Pickleague, then try again at the court.`;
    }
    case 'checkin.too_old':
      // No time here: queuedRefusalNotice already names the tap.
      return "It reached Pickleague more than 12 hours after you tapped, too late to count. Check in again when you're at the court.";
    case 'membership.locked':
      return "A league membership can't be moved to another league or player. Leave the league, then join the one you want.";
    case 'session.not_yours':
      return "That play session belongs to another account, so it wasn't saved. Start a new session.";
    case 'match.removed':
      // True whoever recorded it (the recorder's own team is confirmed at insert).
      return "This match was removed: it wasn't confirmed by both teams within an hour, or it was deleted. Ask whoever recorded it to enter it again.";
    case 'match.already_confirmed':
      return "This match is already confirmed, so there's nothing more to do.";
    case 'match.scheduled':
      return 'This match is scheduled and has no score yet. Record the score after you play it.';
    case 'match.confirm_expired': {
      const by = dateOf(detail.deadline);
      return `Too late to confirm: the hour to confirm this match ended${by ? ` at ${at(by)}` : ''}. Ask whoever recorded it to enter it again.`;
    }
    case 'match.not_pending':
      return "This match isn't waiting for a confirmation any more. Refresh to see where it stands.";
    case 'match.not_player':
      return 'Only players in this match can confirm it.';
    case 'match.not_member':
      // Left, removed, or never joined: the same RLS refusal.
      return `You're not a member of ${ctx.leagueName?.trim() || 'this league'}, so you can't record matches there. Pick a league you're in.`;
    case 'match.score_invalid':
      return 'Each game needs a winner with at least 11 points and a 2-point lead. Check the scores, then record it again.';
    case 'schedule.not_member':
      return `You're not a member of ${ctx.leagueName?.trim() || 'this league'}, so you can't schedule matches in it.`;
    case 'schedule.player_not_member':
      return 'Both players need to be members of this league. Pick players from the league.';
    case 'schedule.same_player':
      return 'Pick two different players for the match.';
    case 'schedule.in_past':
      return 'That time has already passed. Pick a time in the future.';
    case 'schedule.too_far':
      return "That's more than a year away. Pick a time within the next year.";
    case 'schedule.use_rpc':
      return "Couldn't schedule the match because this version of Pickleague sent an outdated request. Update Pickleague, then try again.";
    case 'player.gone':
      return ctx.action === 'hide'
        ? "We couldn't find that player, so there's nothing to hide from."
        : "We couldn't find that player. Open their profile and try again.";
    case 'presence.pick_someone':
      return "You can't hide from yourself. Pick another player.";
    case 'friend.self':
      return "You can't add yourself as a friend.";
    case 'friend.guest_caller':
      return "Guest passes can't add friends. Create an account to add friends.";
    case 'friend.unclaimed':
      return `${person ?? 'This player'} hasn't joined Pickleague yet, so you can't add them as a friend.`;
    case 'friend.guest':
      return `${person ?? 'This player'} is on a guest pass, so you can't add them as a friend until they create an account.`;
    case 'friend.unavailable':
      // Vague on purpose: it must never single out a block (decision 1).
      return "This player isn't available, so you can't add them as a friend.";
    case 'friend.daily_cap':
      return "You've sent 20 friend requests today. Try again tomorrow.";
    case 'friend.not_friends':
      return `You and ${person ?? 'this player'} aren't friends any more, so they can't be a close friend.`;
    case 'consent.declined':
      return "Not checked in: first choose who sees you at the courts. Tap Check in when you're ready.";
    case 'consent.unknown_offline':
      return "No connection, so Pickleague couldn't check who you chose to see you at the courts. Open Pickleague at the court to check in.";
  }
}

/** The copy for an error when its code is known; null otherwise (the caller falls back). */
export function refusalMessage(e: unknown, ctx: RefusalContext = {}): string | null {
  const code = refusalCode(e);
  return code ? refusalCopy(code, ctx, refusalDetail(e), messageOf(e)) : null;
}

/**
 * A lock-screen notice title for a code (the body is refusalCopy with surface
 * 'lock'). `action`: a refused Extend leaves the check-in running until its
 * end, so it reads "Not extended", never "Not checked in".
 */
export function refusalTitle(code: RefusalCode, action?: RefusalAction): string {
  switch (code) {
    case 'auth.signed_out':
      return 'Signed out';
    case 'fix.not_at_court':
    case 'fix.stale':
    case 'fix.stale_clock':
    case 'fix.imprecise':
    case 'fix.malformed':
    case 'court.gone':
      return action === 'extend' ? 'Not extended' : 'Not checked in';
    case 'fix.after_tap':
    case 'checkin.too_old':
    case 'consent.declined':
    case 'consent.unknown_offline':
      return 'Not checked in';
    case 'checkin.none':
    case 'checkin.closed':
      return 'Check-in ended';
    case 'checkin.needs_fix':
      return 'Not extended';
    case 'match.removed':
      return 'Match removed';
    case 'match.confirm_expired':
      return 'Too late to confirm';
    case 'match.already_confirmed':
      return 'Already confirmed';
    case 'match.scheduled':
    case 'match.not_pending':
    case 'match.not_player':
      return 'Nothing to confirm';
    default:
      return "That didn't go through";
  }
}

// ── Things that went through but don't do what the player might think ───────

/** The app's no-connection line (the kit's has an em dash). */
export const NO_CONNECTION = 'No connection. Check your signal and try again.';
/** The island's "still working" toast, without the kit's em dash. */
export const STILL_WORKING = 'Still working on it. Check back in a moment.';

/** extend_checkin never sets an end further than this from now, fix or no fix. */
export const CHECKIN_AHEAD_MAX_MS = 4 * 3_600_000;

/**
 * What +1 h got, and why when it was less than an hour. extend_checkin caps
 * two ways: never more than 4 hours from now (even with a confirming fix),
 * and without a confirming fix, 4 hours past the last one. `fixSent`: the
 * request carried a fix (the second cap can't be why).
 */
export function extendedNote(p: {
  requestedUntilMs: number;
  gotUntilMs: number;
  fixSent: boolean;
  venueName?: string | null;
  timeLabel?: (d: Date) => string;
  nowMs?: number;
}): { full: boolean; message: string } {
  const now = p.nowMs ?? Date.now();
  const at = (d: Date) => (p.timeLabel ? p.timeLabel(d) : whenLabel(d, now));
  const until = at(new Date(p.gotUntilMs));
  // A minute of slack: the server and the device clocks differ a little.
  if (p.gotUntilMs >= p.requestedUntilMs - 60_000) return { full: true, message: `Checked in until ${until}.` };
  // At the 4-hour ceiling (2 minutes of slack for the clocks).
  if (p.gotUntilMs >= now + CHECKIN_AHEAD_MAX_MS - 2 * 60_000) {
    return {
      full: false,
      message: `A check-in can run at most 4 hours ahead, so you're checked in until ${until}. Extend it again later to stay longer.`,
    };
  }
  if (!p.fixSent) {
    return {
      full: false,
      message: `Checked in until ${until}, not a full hour: Pickleague couldn't confirm you're still at ${p.venueName?.trim() || 'the court'}. Open Pickleague at the court to stay later.`,
    };
  }
  return { full: false, message: `Checked in until ${until}.` };
}

// submit_drill_review answers success=false with a message (it can't carry a
// code: its return table is fixed). Since migration_refusal_messages.sql the
// messages are final copy; these are the older ones.
const OLD_DRILL_REVIEW: Record<string, string> = {
  'Already reviewed': 'You already reviewed this drill. Each drill gets one review.',
  'You can review after the session starts': "This drill hasn't started yet. You can review it after it starts.",
  'Not a participant': 'Only the two players in this drill can review it.',
  'Drill session not found': "This drill was cancelled or removed, so it can't be reviewed.",
  'Rate at least one aspect': 'Rate at least one thing to send your review.',
};

/** submit_drill_review's "you already reviewed it" answer, new text or old. */
export function isAlreadyReviewedMessage(message: string | null | undefined): boolean {
  const m = (message ?? '').trim();
  return m === 'Already reviewed' || m === OLD_DRILL_REVIEW['Already reviewed'];
}

/** The line for a drill review the server didn't take. */
export function drillReviewRefusal(message: string | null | undefined): string {
  const m = (message ?? '').trim();
  return OLD_DRILL_REVIEW[m] ?? (m || "Your review wasn't saved. Try again.");
}

/**
 * In-app line after Confirm on a match: settled, or the other team still has
 * to (by when), or my team had already. `deadline` is the match's
 * confirm_deadline (device zone).
 */
export function confirmResultMessage(
  result: string,
  deadline: string | null | undefined,
  o: { timeLabel?: (d: Date) => string; nowMs?: number } = {},
): string {
  const d = deadline ? Date.parse(deadline) : NaN;
  const by = Number.isFinite(d) ? (o.timeLabel ? o.timeLabel(new Date(d)) : whenLabel(new Date(d), o.nowMs)) : null;
  if (result === 'one_team_confirmed') {
    return `Confirmed for your team. The other team has ${by ? `until ${by}` : 'an hour'} to confirm, then ratings update.`;
  }
  if (result === 'already_your_team') {
    return `Your team already confirmed this match. It's waiting on the other team${by ? ` until ${by}` : ''}.`;
  }
  return 'Match confirmed. Ratings update shortly.';
}

/** What a queued write the server refused later was, for the "didn't go through" notice. */
export type QueuedWhat = 'check_in' | 'check_out' | 'start' | 'end';

/**
 * The notice for a write saved with no signal that the server refused when it
 * was sent: what, when (`tapMs`, device zone), why, and what to do now.
 */
export function queuedRefusalNotice(p: {
  what: QueuedWhat;
  venueName?: string | null;
  tapMs: number;
  /** The refusal (null: it was dropped without being sent). */
  error?: unknown;
  /** The check-in's own end, for "you may still show there until". */
  untilMs?: number | null;
  /** Why, when the app knows better than the error (see the callers). */
  reason?: string | null;
  timeLabel?: (d: Date) => string;
  nowMs?: number;
}): string {
  const at = (d: Date) => (p.timeLabel ? p.timeLabel(d) : whenLabel(d, p.nowMs));
  const when = at(new Date(p.tapMs));
  const court = p.venueName?.trim() || null;
  const code = p.error ? refusalCode(p.error) : null;
  const why =
    p.reason ??
    (code
      ? refusalCopy(code, { venueName: court, action: p.what === 'start' ? 'start' : 'check_in' }, refusalDetail(p.error), messageOf(p.error))
      : humanMessage(p.error));
  switch (p.what) {
    case 'check_in':
      return `Your check-in${court ? ` at ${court}` : ''} (${when}) didn't go through. ${why ?? "Check in again when you're at the court."}`;
    case 'check_out': {
      const still = p.untilMs && p.untilMs > (p.nowMs ?? Date.now()) ? ` You may still show there until ${at(new Date(p.untilMs))}.` : '';
      return `Your check-out${court ? ` at ${court}` : ''} (${when}) didn't reach Pickleague.${why ? ` ${why}` : ''}${still} Tap Check out to try again.`;
    }
    case 'start':
      return `Your play session from ${when} wasn't saved, so it won't count. ${why ?? 'Start a new one when you play.'}`;
    case 'end':
      return `Your End (${when}) didn't reach Pickleague, so your play session may still be running.${why ? ` ${why}` : ''} Tap End again.`;
  }
}

/** A server message written for people (a P0001 raise), never a raw Postgres one. */
function humanMessage(e: unknown): string | null {
  const o = e as ErrorLike | null;
  return o && o.code === 'P0001' ? messageOf(o) || null : null;
}

/**
 * Why a Start at a court didn't check me in there (the server starts it
 * untracked, no error), or checked me in only for a time already over.
 *   'checkin_gone' / 'checkin_private': the start sheet sent no fix because I
 *     looked checked in there, and that check-in had ended or was a private
 *     one (saved without a fix), so it couldn't be adopted.
 *   'too_old': the Start reached Pickleague more than 12 hours after its tap
 *     (the server checks in only within 12 hours of the tap).
 *   'synced_late': the server checked me in from the tap, but that check-in
 *     had already ended when the Start synced (stored, shown to nobody).
 *   'unconfirmed_late': a Start that synced late, whose location didn't
 *     confirm the court at its tap. True from an older server too, which
 *     judged the fix by its age when sent.
 */
export type UntrackedStartReason =
  | 'court_gone'
  | 'no_fix'
  | 'imprecise'
  | 'too_old'
  | 'synced_late'
  | 'unconfirmed_late'
  | 'not_at_court'
  | 'checkin_gone'
  | 'checkin_private';

/**
 * The island's note when a Start at a court didn't check me in: why, and what
 * to do. `endedAtMs`: for 'synced_late', when the session's check-in ended.
 * `over`: the session already ended on this device (a card after its End),
 * so 'synced_late' doesn't ask to check in "if you're still there".
 */
export function untrackedStartNote(
  venueName: string | null | undefined,
  reason: UntrackedStartReason,
  o: { endedAtMs?: number | null; over?: boolean; timeLabel?: (d: Date) => string; nowMs?: number } = {},
): string {
  const at = venueName?.trim() ? ` at ${venueName.trim()}` : '';
  const when = (ms: number) => (o.timeLabel ? o.timeLabel(new Date(ms)) : whenLabel(new Date(ms), o.nowMs));
  switch (reason) {
    case 'court_gone':
      return "Not checked in: that court isn't in Pickleague any more, so only you see this session. Pick another court next time.";
    case 'no_fix':
      return `Not checked in${at}: Pickleague couldn't get your location, so only you see this session. Check in from Home if you're at the court.`;
    case 'imprecise':
      return `Not checked in${at}: your location wasn't precise enough to confirm the court, so only you see this session. Turn on Precise Location for Pickleague to be seen there.`;
    case 'too_old':
      return `Not checked in${at}: the session reached Pickleague more than 12 hours after you started it, too late to check you in there, so only you see it. Check in from Home if you're at a court.`;
    case 'synced_late': {
      const ran = o.endedAtMs != null && Number.isFinite(o.endedAtMs) ? `ran until ${when(o.endedAtMs)}` : 'had already ended';
      const still = o.over ? '' : " Check in from Home if you're still there.";
      return `Your check-in${at} for this session ${ran}, but the session reached Pickleague after that, so nobody saw you there. Pickleague still counts you as at the court for it.${still}`;
    }
    case 'unconfirmed_late':
      return `Not checked in${at}: Pickleague couldn't confirm from your location that you were at the court when you tapped Start, so only you see this session. Check in from Home if you're at the court.`;
    case 'not_at_court':
      return `Not checked in${at}: you're not at the court, so only you see this session. Check in from Home when you get there.`;
    case 'checkin_gone':
      return `Not checked in${at}: your check-in there had ended, so only you see this session. Check in from Home to be seen there.`;
    case 'checkin_private':
      return `Not checked in${at}: your check-in there was saved without your location, so nobody sees it or this session. Check in from Home to be seen there.`;
  }
}

/**
 * The notice after a sign-out that couldn't close what this device knew was
 * open (lib/signOutPresence): what stays open and until when, then the action
 * that ends each one. Null when everything closed.
 */
export function signOutNotice(p: {
  /** The check-out didn't land: the court and the check-in's own end. */
  checkin?: { venueName: string; untilMs: number } | null;
  /** The End didn't land: when the server ends the session on its own. */
  sessionEndsAtMs?: number | null;
  timeLabel?: (d: Date) => string;
  nowMs?: number;
}): string | null {
  const at = (d: Date) => (p.timeLabel ? p.timeLabel(d) : whenLabel(d, p.nowMs));
  const lines: string[] = [];
  if (p.checkin) {
    lines.push(
      `Pickleague couldn't check you out of ${p.checkin.venueName}, so you may still show there until ${at(new Date(p.checkin.untilMs))}.`,
    );
  }
  const session = p.sessionEndsAtMs != null;
  if (session) lines.push(`Your play session couldn't be ended, so it ends on its own at ${at(new Date(p.sessionEndsAtMs as number))}.`);
  if (lines.length === 0) return null;
  const action =
    p.checkin && session
      ? 'Sign in again, then tap Check out and End to end them sooner.'
      : p.checkin
        ? 'Sign in again and tap Check out to end it sooner.'
        : 'Sign in again and tap End on your play session to end it sooner.';
  return `Signed out. ${lines.join(' ')} ${action}`;
}

/** The check-in notice when the saved check-in had no location (an older build saved it). */
export function noFixQueuedCheckinReason(): string {
  return "It was saved by an older version of Pickleague without your location. Check in again at the court.";
}

/**
 * The check-in notice when an OLDER server (before
 * migration_checkin_tap_time.sql) refused a queued check-in because its fix
 * was over 2 minutes old when finally sent. The current server judges the fix
 * at the tap and takes a replay up to 12 hours later (courtCheckinRules
 * refusedForQueueWait tells the two apart).
 */
export function staleQueuedCheckinReason(): string {
  return "It reached Pickleague more than 2 minutes after you tapped, too late to confirm you were there. Check in again when you're at the court.";
}

/**
 * Under Check in when it was saved with no signal (the court card and the
 * lock-screen notice): the server takes it up to 12 hours after the tap,
 * counted when it ARRIVES, and the queue sends only while Pickleague runs
 * (a lock-screen check-in waits for the app), so the note names the action.
 */
export const QUEUED_CHECKIN_NOTE =
  'Saved with no signal. It counts if it reaches Pickleague within 12 hours, so open Pickleague once you have a signal.';

/**
 * A check-in saved with no signal that reached Pickleague after it had
 * already ended (the server stores it, already over, and shows it to nobody).
 * Times in the device's zone: the tap, when it landed, when it ended (all on
 * the server's clock: courtCheckinRules.lapsedCheckinFacts).
 *   checkedOut: it ended at the player's own check-out, not at its expiry;
 *   checkInAgain (default true): offer "Check in again" (false once the
 *     player checked out, or is checked in again already).
 */
export function lapsedCheckinNotice(p: {
  venueName?: string | null;
  tapMs: number;
  endedMs: number;
  syncedMs: number;
  checkedOut?: boolean;
  checkInAgain?: boolean;
  timeLabel?: (d: Date) => string;
  nowMs?: number;
}): string {
  const at = (ms: number) => (p.timeLabel ? p.timeLabel(new Date(ms)) : whenLabel(new Date(ms), p.nowMs));
  const court = p.venueName?.trim() ? ` at ${p.venueName.trim()}` : '';
  const when = p.checkedOut ? `after you had checked out (${at(p.endedMs)})` : `after it had ended at ${at(p.endedMs)}`;
  const again = !p.checkedOut && p.checkInAgain !== false ? " Check in again if you're still at the court." : '';
  return `Your check-in${court} (${at(p.tapMs)}) reached Pickleague at ${at(p.syncedMs)}, ${when}, so nobody saw you there. Pickleague still saved it as your visit.${again}`;
}

/**
 * The court card's line when a check-in saved with no signal runs out on the
 * device before it could be sent: it still goes, if it reaches Pickleague
 * within 12 hours of the tap (sent while Pickleague is open with a signal).
 */
export function queuedCheckinRanOutNote(p: {
  venueName: string;
  endedMs: number;
  timeLabel?: (d: Date) => string;
  nowMs?: number;
}): string {
  const at = p.timeLabel ? p.timeLabel(new Date(p.endedMs)) : whenLabel(new Date(p.endedMs), p.nowMs);
  return `Your check-in at ${p.venueName} ended at ${at} before your phone had a signal to send it. It's sent the next time Pickleague is open with a signal, if that's within 12 hours of when you tapped. Check in again if you're still at the court.`;
}
