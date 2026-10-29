// Why a Start at a court didn't check me in there, as a pure rule (no React
// Native, no Supabase), so vitest covers every branch. lib/playSession calls it
// after a Start lands (live or replayed from the offline queue) and the
// session's own check-in isn't the one I'm checked in with; lib/refusals words
// the reason (untrackedStartNote).
//
// The server judges a Start's fix at the TAP (supabase/migration_checkin_tap_time
// .sql, decided 2026-10-16): taken within 2 minutes of the tap, and the tap
// under 12 hours old. A replay inside that checks me in from the tap, and is
// stored already over when that is past, or closed at the End when the End
// reached Pickleague first (synced_late: it still counts as at the court for
// the session, but nobody saw me there).
import {
  FIX_MAX_AGE_MS,
  fixAgeMs,
  isPreciseFix,
  isValidFix,
  syncedAfterItEnded,
  type CheckinTimes,
  type DeviceFix,
} from './courtCheckinRules';
import type { UntrackedStartReason } from './refusals';
import type { AgendaItem } from './agenda';

/** The server checks a Start in only within this long of its tap. */
export const START_CHECKIN_MAX_MS = 12 * 3600_000;

/** My check-in now, from the device's cache or the server. */
type CurrentLike = { id?: string; venueId: string; private?: boolean };

export type UntrackedStartInput = {
  /** What the Start sent. */
  payload: { venueId: string | null; at: string; fix?: DeviceFix | null; viaCheckin?: true };
  /** What came back (the server only returns the session row). */
  row: { venue_id: string | null } | null | undefined;
  /** My check-in now, from the device's cache or the server. */
  cur: CurrentLike | null;
  /** The session's own check-in (same id as the session), when the server has one. */
  sessionCheckin?: CheckinTimes | null;
  nowMs: number;
};

/** The reason, most specific first. */
export function untrackedReason(p: UntrackedStartInput): UntrackedStartReason {
  const { payload, row, cur } = p;
  if (row && payload.venueId && !row.venue_id) return 'court_gone';
  const fix = payload.fix;
  if (!fix || !isValidFix(fix)) {
    // No fix because the sheet relied on my check-in there: it had ended, or
    // it was a private one nobody sees.
    if (payload.viaCheckin) {
      const there = !!cur && [row?.venue_id, payload.venueId].some((v) => !!v && cur.venueId === v);
      return there && cur?.private ? 'checkin_private' : 'checkin_gone';
    }
    return 'no_fix';
  }
  if (!isPreciseFix(fix)) return 'imprecise';
  // The server stored the session's check-in, but it was over by the time
  // the Start synced: its own times say so (no clock offset can fake it).
  if (syncedAfterItEnded(p.sessionCheckin)) return 'synced_late';
  // Sent more than 12 hours after the tap (both on this device's clock).
  const tapMs = Date.parse(payload.at);
  if (Number.isFinite(tapMs) && p.nowMs - tapMs > START_CHECKIN_MAX_MS) return 'too_old';
  // Late, and nothing stored: the location didn't confirm the court at the
  // tap (an older server also refused any fix over 2 minutes old by then).
  if (fixAgeMs(fix, p.nowMs) > FIX_MAX_AGE_MS) return 'unconfirmed_late';
  return 'not_at_court';
}

/**
 * Is `cur` the check-in a session at `venueIds` gave me (its own, or the one
 * it adopted)? A private check-in (saved without a fix by an older build) is
 * never adopted and shows me to nobody, so it doesn't count.
 */
export function checkedInBySession(
  cur: CurrentLike | null,
  sessionId: string,
  venueIds: (string | null | undefined)[],
): boolean {
  return !!cur && !cur.private && (cur.id === sessionId || venueIds.some((v) => !!v && cur.venueId === v));
}

/**
 * The session's own check-in shows the Start checked me in: stored,
 * confirmed, and not only after it had ended. Needed once the session is
 * over on this device: the current check-in then hides a session check-in
 * whose End is still on its way.
 */
export function sessionCheckinCounts(ci: CheckinTimes | null | undefined): boolean {
  return !!ci && ci.location_confirmed !== false && !syncedAfterItEnded(ci);
}

/**
 * After a Start at a court lands: whether to say why it didn't check me in,
 * and where. Null: it did (my current check-in is the session's, or one it
 * adopted; or its own check-in counts). On the island only for a live Start
 * the island still shows; a replay from the offline queue, or a session
 * already over on this device, gets a card (rule 11: never silent).
 */
export function untrackedStartNotice(
  p: UntrackedStartInput & { sessionId: string; showing: boolean; queued: boolean },
): { onIsland: boolean; reason: UntrackedStartReason } | null {
  if (checkedInBySession(p.cur, p.sessionId, [p.row?.venue_id, p.payload.venueId])) return null;
  if (sessionCheckinCounts(p.sessionCheckin)) return null;
  return { onIsland: p.showing && !p.queued, reason: untrackedReason(p) };
}

// ── "How are you playing?": the chip the ▶ Play sheet opens on ─────────────
// The user's decision 4 (2026-10-22): Open play · Closed group · Drill,
// picked from what I have scheduled around now, and changeable before Start.
// In order: a routine occurrence (a planned check-in) at this court now takes
// its current window's mode, with its planned length and windows; a drill
// session or drill request within 60 minutes either side picks Drill; a
// league event, a scheduled match or a tournament match around now picks Open
// play; else the chip I used last; else Open play.

/** The sheet's chips. */
export type PlayChip = 'open' | 'closed' | 'drill';

/** What the sheet sends for each chip: the session's kind and the plan's mode (null: none, a drill). */
export const PLAY_CHIP_KIND: Record<PlayChip, { kind: 'open_play' | 'drill'; mode: 'open' | 'closed' | null }> = {
  open: { kind: 'open_play', mode: 'open' },
  closed: { kind: 'open_play', mode: 'closed' },
  drill: { kind: 'drill', mode: null },
};

export const PLAY_CHIP_LABEL: Record<PlayChip, string> = { open: 'Open play', closed: 'Closed group', drill: 'Drill' };

/** "Around now" for drills and events: 60 minutes either side of the start. */
export const AROUND_NOW_MS = 60 * 60_000;

/** A window's mode (lib/courtRoutineRules PlayMode), null when not said. */
export type WindowMode = 'open' | 'closed' | 'drill' | null;

/** A play window from a routine, absolute (the occurrence's own). */
export type ChipWindow = { startsAt: string; endsAt: string; mode: WindowMode };

/** The routine occurrence due at this court now (lib/courtRoutineRules routineOccurrenceAt). */
export type ChipRoutine = {
  plannedAt: string;
  /** Null: its time plus the routine's length. */
  plannedEndAt: string | null;
  lengthMin: number;
  windows: readonly ChipWindow[];
};

/** Something on my calendar: a drill session or request, an event, a match, a tournament match. */
export type ChipScheduleItem = {
  kind: 'drill' | 'drill_request' | 'event' | 'match' | 'tournament';
  startsAt: string;
  /** When it ends, if known (an event runs to its end). */
  endsAt?: string | null;
  title: string;
};

export type ChipDraftWindow = { startMin: number; endMin: number; mode: WindowMode };

export type ChipPick = {
  chip: PlayChip;
  why: 'routine' | 'drill' | 'event' | 'last_used' | 'default';
  /** "From your 6 PM routine": why it was picked; null for the default. */
  hint: string | null;
  /** From a routine: how long, from now (minutes, 30 to 240). */
  lengthMin?: number;
  /** From a routine: its windows from now, as offsets in minutes (the sheet's draft). */
  windows?: ChipDraftWindow[];
};

/** The mode in force at `nowMs` (before the first window, the first's; after the last, the last's). */
function modeNow(windows: readonly ChipWindow[], nowMs: number): WindowMode {
  const sorted = [...windows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  if (sorted.length === 0) return null;
  let m = sorted[0].mode;
  for (const w of sorted) if (Date.parse(w.startsAt) <= nowMs) m = w.mode;
  return m;
}

/** A routine's windows from now as minute offsets, the past cut away, to its planned end. */
export function routineWindowsFromNow(r: ChipRoutine, nowMs: number): { lengthMin: number; windows: ChipDraftWindow[] } {
  const endMs = r.plannedEndAt ? Date.parse(r.plannedEndAt) : Date.parse(r.plannedAt) + r.lengthMin * 60_000;
  const raw = Math.ceil((endMs - nowMs) / 60_000);
  const lengthMin = Math.min(240, Math.max(30, Number.isFinite(raw) ? raw : 120));
  const windows: ChipDraftWindow[] = [];
  for (const w of [...r.windows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
    const s = Math.max(0, Math.round((Date.parse(w.startsAt) - nowMs) / 60_000));
    const e = Math.min(lengthMin, Math.round((Date.parse(w.endsAt) - nowMs) / 60_000));
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    windows.push({ startMin: s, endMin: e, mode: w.mode });
  }
  // The past cut away, the first window starts now; the windows end before
  // the planned end, the last mode runs on to it.
  if (windows.length > 0) {
    windows[0].startMin = 0;
    windows[windows.length - 1].endMin = lengthMin;
  }
  return { lengthMin, windows };
}

/** Is `item` around now: from 60 minutes before its start to 60 minutes after (or its end, if later)? */
export function aroundNow(item: { startsAt: string; endsAt?: string | null }, nowMs: number): boolean {
  const s = Date.parse(item.startsAt);
  if (!Number.isFinite(s)) return false;
  const e = item.endsAt ? Date.parse(item.endsAt) : NaN;
  const until = Math.max(s + AROUND_NOW_MS, Number.isFinite(e) ? e : -Infinity);
  return nowMs >= s - AROUND_NOW_MS && nowMs <= until;
}

/**
 * The chip the sheet opens on, and why. `clock` words a time ("6 PM") for the
 * hint. Inside each rule the item nearest now wins.
 */
export function pickPlayChip(p: {
  nowMs: number;
  routine: ChipRoutine | null;
  schedule: readonly ChipScheduleItem[];
  lastUsed: PlayChip | null;
  clock: (iso: string) => string;
}): ChipPick {
  const { nowMs, routine, schedule, lastUsed, clock } = p;
  if (routine) {
    const from = routineWindowsFromNow(routine, nowMs);
    const mode = modeNow(routine.windows, nowMs);
    return {
      chip: mode === 'closed' ? 'closed' : mode === 'drill' ? 'drill' : 'open',
      why: 'routine',
      hint: `From your ${clock(routine.plannedAt)} routine`,
      lengthMin: from.lengthMin,
      windows: from.windows,
    };
  }
  const near = (kinds: ChipScheduleItem['kind'][]) =>
    schedule
      .filter((i) => kinds.includes(i.kind) && aroundNow(i, nowMs))
      .sort((a, b) => Math.abs(Date.parse(a.startsAt) - nowMs) - Math.abs(Date.parse(b.startsAt) - nowMs))[0];
  const drill = near(['drill', 'drill_request']);
  if (drill) {
    return {
      chip: 'drill',
      why: 'drill',
      hint: `From your ${clock(drill.startsAt)} ${drill.kind === 'drill_request' ? 'drill request' : 'drill session'}`,
    };
  }
  const event = near(['event', 'match', 'tournament']);
  if (event) return { chip: 'open', why: 'event', hint: `From ${event.title} at ${clock(event.startsAt)}` };
  if (lastUsed) return { chip: lastUsed, why: 'last_used', hint: 'What you picked last time' };
  return { chip: 'open', why: 'default', hint: null };
}

/** The windows Start sends for a chip with no routine: one window the whole length (none for a drill). */
export function chipWindows(chip: PlayChip, lengthMin: number): ChipDraftWindow[] {
  const mode = PLAY_CHIP_KIND[chip].mode;
  return mode ? [{ startMin: 0, endMin: lengthMin, mode }] : [];
}

/**
 * The chip changed by hand: a routine's windows keep their split only while
 * the chip is the routine's own; any other chip is one window the whole length.
 */
export function windowsForChip(chip: PlayChip, lengthMin: number, pick: ChipPick | null): ChipDraftWindow[] {
  if (pick?.why === 'routine' && pick.chip === chip && pick.windows && pick.windows.length > 0) {
    const list = pick.windows
      .map((w) => ({ ...w, endMin: Math.min(w.endMin, lengthMin) }))
      .filter((w) => w.endMin > w.startMin);
    // A longer length: the last mode runs on to it.
    if (list.length > 0) {
      list[list.length - 1].endMin = lengthMin;
      return list;
    }
  }
  return chipWindows(chip, lengthMin);
}

/**
 * The sheet's plan line: "Open play until 7:30 PM", "Closed group until
 * 6 PM, then open play until 7:30 PM", or "Until 7:30 PM" with nothing said
 * (a drill). Neighbours with the same mode read as one.
 */
export function draftPlanLine(
  windows: readonly ChipDraftWindow[],
  lengthMin: number,
  startMs: number,
  clock: (iso: string) => string,
): string {
  const at = (min: number) => clock(new Date(startMs + min * 60_000).toISOString());
  const said = windows.filter((w) => w.mode != null);
  if (said.length === 0) return `Until ${at(lengthMin)}`;
  const runs: { mode: WindowMode; endMin: number }[] = [];
  for (const w of [...windows].sort((a, b) => a.startMin - b.startMin)) {
    const last = runs[runs.length - 1];
    if (last && last.mode === w.mode) last.endMin = w.endMin;
    else runs.push({ mode: w.mode, endMin: w.endMin });
  }
  runs[runs.length - 1].endMin = lengthMin;
  const label = (m: WindowMode) => (m === 'open' ? 'Open play' : m === 'closed' ? 'Closed group' : m === 'drill' ? 'Drill' : 'Not set');
  return runs
    .map((r, i) => (i === 0 ? `${label(r.mode)} until ${at(r.endMin)}` : `then ${label(r.mode).toLowerCase()} until ${at(r.endMin)}`))
    .join(', ');
}

/** Calendar rows from Home's payload as chip inputs. */
export function scheduleFromAgenda(items: readonly AgendaItem[]): ChipScheduleItem[] {
  const out: ChipScheduleItem[] = [];
  for (const i of items) {
    switch (i.kind) {
      case 'event':
        if (i.startsAt) out.push({ kind: 'event', startsAt: i.startsAt, endsAt: i.endsAt, title: i.title });
        break;
      case 'tournament':
        if (i.startsAt) out.push({ kind: 'tournament', startsAt: i.startsAt, endsAt: i.endsAt, title: i.title });
        break;
      case 'drill':
        if (i.startsAt) out.push({ kind: 'drill', startsAt: i.startsAt, endsAt: i.endsAt, title: i.title });
        break;
      // A request to me has no time yet: its next proposed slot (`deadline`).
      case 'drill_request':
        if (i.deadline) out.push({ kind: 'drill_request', startsAt: i.deadline, title: i.title });
        break;
      case 'drill_waiting':
        if (i.startsAt) out.push({ kind: 'drill_request', startsAt: i.startsAt, title: i.title });
        break;
      default:
        break;
    }
  }
  return out;
}

/** "1h 42m", "42m", "1h". */
export function playedFor(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The end sheet's header line: "Play complete · 1h 42m at Riverside". */
export function playCompleteLine(p: { startedAtMs: number; endedAtMs: number; venueName?: string | null }): string {
  const where = p.venueName ? ` at ${p.venueName}` : '';
  return `Play complete · ${playedFor(p.endedAtMs - p.startedAtMs)}${where}`;
}
