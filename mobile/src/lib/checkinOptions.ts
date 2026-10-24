// One "Check in ▾" for a court, as Doggle's park card has it (the user,
// 2026-10-24: "A simple 'Check In' button covers all the bases, with options
// to plan a check in, make it a routine, etc. Please match with parity").
// Which controls a feed court card's header shows, what its Check in options
// sheet lists, and what each line's time chip offers: Doggle's
// components/doggleFeed/rowActions.ts and DoggleFeedSection's park sheet,
// with Pickleague's words where play differs (Stay 1 more hour; Check out,
// which ends the session too).
//
//   Today, not checked in here .. [On my way ▾] (a friend here, none sent
//                                  in 30 min) or "On the way ✓", then [Check in ▾]
//   Today, checked in here ...... nothing: my own "Here now ▾" line has it
//   Tomorrow .................... [Plan ▾] (Make this a routine)
//   Later this week ............. nothing
//
//   Check in ▾  ->  Check in now · On my way · Make this a routine
//
// Doggle's "Check in and tell friends" and "Plan a check-in for later" need
// server work Pickleague doesn't have yet (send_on_my_way has no p_here, and
// court_plans holds routine stops only), so they are not offered here.
//
// PURE: no React, no Supabase. The vitest suite is
// lib/__tests__/checkinOptions.test.ts.
import type { DayBandKey } from '@just-messin-around/expo-foundation/scheduling/dayBands';
import type { FeedSheetLine } from './pickleagueFeed';

/** A planned stop stays "On my way"-able this long after its time (Doggle's PLAN_OVER_MS). */
export const ON_MY_WAY_PLAN_OVER_MS = 30 * 60_000;

// ── The court card's header ─────────────────────────────────────────────────
export type CourtHeaderAction =
  /** "On my way ▾": tell friends there now. */
  | 'onMyWay'
  /** "On the way ✓": told them in the last 30 minutes (plain text). */
  | 'onMyWaySent'
  /** "Check in ▾": the options sheet. */
  | 'checkIn'
  /** "Plan ▾" (tomorrow). */
  | 'plan';

export type CourtHeaderState = {
  day: DayBandKey;
  /** I'm checked in at this court. */
  hereMine: boolean;
  /** A friend's "here now" line is on the card. */
  friendHere: boolean;
  /** Friends at the courts is on and I have a friend to tell. */
  canOnMyWay: boolean;
  /** This device told friends about this court in the last 30 minutes. */
  onMyWaySent: boolean;
  /** Tomorrow's Plan sheet would list something. */
  canPlan: boolean;
};

/** The header's controls, left to right. */
export function courtHeaderActions(s: CourtHeaderState): CourtHeaderAction[] {
  if (s.day === 'today') {
    if (s.hereMine) return [];
    const omw: CourtHeaderAction[] = s.canOnMyWay && s.friendHere ? [s.onMyWaySent ? 'onMyWaySent' : 'onMyWay'] : [];
    return [...omw, 'checkIn'];
  }
  if (s.day === 'tomorrow' && s.canPlan) return ['plan'];
  return [];
}

// ── The Check in ▾ sheet ────────────────────────────────────────────────────
export type CheckinOptionId = 'checkInNow' | 'onMyWay' | 'makeRoutine';

export type CheckinOptionsState = {
  canOnMyWay: boolean;
  /** Routines are on and the court is starred (make_court_routine refuses an unstarred court). */
  canRoutine: boolean;
};

/** The Check in sheet's items, in Doggle's order. Check in now is always there. */
export function checkinOptionIds(s: CheckinOptionsState): CheckinOptionId[] {
  const out: CheckinOptionId[] = ['checkInNow'];
  if (s.canOnMyWay) out.push('onMyWay');
  if (s.canRoutine) out.push('makeRoutine');
  return out;
}

/** Tomorrow's Plan sheet (no one-off plans yet: a routine only). */
export function planOptionIds(s: Pick<CheckinOptionsState, 'canRoutine'>): CheckinOptionId[] {
  return s.canRoutine ? ['makeRoutine'] : [];
}

/** The sheet's note when I'm checked in somewhere else: a check-in here closes
 *  that one (and its session). A check-in whose time has run out is no longer
 *  one (this device's copy can outlive it). */
export function movesCheckinNote(
  current: { venueId: string; venueName: string; expiresAt: string } | null,
  venueId: string,
  nowMs: number,
): string | undefined {
  if (!current || current.venueId === venueId || !(Date.parse(current.expiresAt) > nowMs)) return undefined;
  return `You're checked in at ${current.venueName}. Checking in here moves you.`;
}

// ── A line's time chip ──────────────────────────────────────────────────────
export type LineActionId =
  // My check-in there now
  | 'extend'
  | 'checkOut'
  // My routine stop
  | 'checkInNow'
  | 'onMyWay'
  | 'changeTime'
  | 'editRoutine'
  | 'skipStop'
  | 'undoSkip'
  // A friend's
  | 'checkInHere'
  | 'profile';

export type LineActionContext = {
  day: DayBandKey;
  nowMs: number;
  /** I'm checked in at this card's court. */
  hereMine: boolean;
  canOnMyWay: boolean;
  /** "On my way" sent to this court from here in the last 30 minutes. */
  onMyWaySent: boolean;
};

export type SheetLineFacts =
  | { kind: 'mine'; queued: boolean }
  | { kind: 'stop'; status: 'planned' | 'cancelled'; at: string }
  | { kind: 'here' | 'left' };

/** What the rules need from a feed line. */
export function sheetLineFacts(line: FeedSheetLine): SheetLineFacts {
  if (line.kind === 'mine') return { kind: 'mine', queued: line.checkin.queued };
  if (line.kind === 'stop') return { kind: 'stop', status: line.stop.status, at: line.stop.at };
  return { kind: line.kind };
}

/** Already over, so the line is faded (Doggle's isPast): a visit that ended,
 *  a skipped stop, or a stop whose time has passed. */
export function lineIsPast(l: SheetLineFacts, nowMs: number): boolean {
  if (l.kind === 'left') return true;
  if (l.kind === 'stop') return l.status === 'cancelled' || !(Date.parse(l.at) > nowMs);
  return false;
}

/** The sheet's items for one line, in display order (Doggle's rowActions). */
export function lineActionIds(l: SheetLineFacts, ctx: LineActionContext): LineActionId[] {
  const today = ctx.day === 'today';
  const out: LineActionId[] = [];
  const add = (id: LineActionId, when: boolean) => {
    if (when) out.push(id);
  };
  if (l.kind === 'mine') {
    // A check-in still in the offline queue can't be extended yet.
    add('extend', !l.queued);
    add('checkOut', true);
    return out;
  }
  if (l.kind === 'stop') {
    if (l.status === 'cancelled') return ['undoSkip', 'editRoutine'];
    add('checkInNow', today && !ctx.hereMine);
    // Always on my own stop today (I pick who to tell), until 30 min past its time.
    add('onMyWay', today && !ctx.hereMine && ctx.canOnMyWay && Date.parse(l.at) > ctx.nowMs - ON_MY_WAY_PLAN_OVER_MS);
    // Once its time has passed it can't move or be skipped (Doggle: while
    // the plan is still ahead).
    const ahead = Date.parse(l.at) > ctx.nowMs;
    add('changeTime', ahead);
    add('editRoutine', true);
    add('skipStop', ahead);
    return out;
  }
  if (l.kind === 'here') {
    add('onMyWay', today && !ctx.hereMine && ctx.canOnMyWay && !ctx.onMyWaySent);
    add('checkInHere', today && !ctx.hereMine);
  }
  add('profile', true);
  return out;
}
