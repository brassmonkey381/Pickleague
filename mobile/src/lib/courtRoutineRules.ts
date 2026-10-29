// Routine check-ins, the pure side (state/routine-checkins-plan.md, Doggle's
// data/routines.ts helpers): the shapes list_my_court_routines and friends
// answer with, which routine stop is due at a court right now (an arrival
// keys off it, maybe inside a geofence wake with no signal), and the words
// for lengths, Closed group / Open play / Drill windows and play modes.
//
// PURE: no React Native, no Supabase. Only the foundation's scheduling
// modules (themselves pure), so vitest covers it
// (lib/__tests__/courtRoutineRules.test.ts).
//
// Copy rule (Doggle PlannedCheckinsSection): routines are "planned
// check-ins", never a "usual" anything or "<name>'s schedule".
import {
  formatClockTime,
  formatWeekdayMask,
  minutesToClock,
  wallClockIn,
} from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import { stopDueAt, type RecurringStop } from '@just-messin-around/expo-foundation/scheduling/recurringStops';
import type { PlanShareSource } from '@just-messin-around/expo-foundation/plans/rules';
import {
  KEEP_WINDOWS_APART,
  fitWindowsToLength,
  formatDurationMinutes,
  formatWindows,
  formatWindowsFrom,
  modeAt,
  normalizeWindows,
  parseAbsoluteWindows,
  parseWindows,
  singleWindow,
  splitAbsoluteAt,
  windowsToAbsolute,
  windowsToOffsets,
  type AbsoluteTimeWindow,
  type TimeWindow,
  type WindowRules,
  type WindowsCopy,
} from '@just-messin-around/expo-foundation/scheduling/timeWindows';

// ── Modes, hints, rules (the server's _pl_windows_problem mirrors these) ─────
export type PlayMode = 'closed' | 'open' | 'drill';
export const PLAY_MODES: readonly PlayMode[] = ['closed', 'open', 'drill'];

/** The plan's naming: "Closed group" (friends, or an equal-skill foursome),
 *  "Open play" and "Drill" (practice; like a closed group, not joinable). */
export const PLAY_MODE_LABEL: Record<PlayMode, string> = { closed: 'Closed group', open: 'Open play', drill: 'Drill' };
/** A window with nothing said. */
export const UNSAID_LABEL = 'Not set';

/** The fixed hint lists (no free text, so nothing to moderate). Drill takes no hint. */
export const PLAY_HINTS: Record<'open' | 'closed', { id: string; label: string }[]> = {
  open: [
    { id: 'all_levels', label: 'All levels' },
    { id: 'near_my_level', label: 'Near my level' },
    { id: '3.0+', label: '3.0+' },
    { id: '3.5+', label: '3.5+' },
    { id: '4.0+', label: '4.0+' },
    { id: '4.5+', label: '4.5+' },
  ],
  closed: [
    { id: 'friends', label: 'Friends' },
    { id: 'competitive', label: 'Competitive' },
  ],
};

/** foundation timeWindows rules, as the server checks them (migration_court_routines.sql). */
export const PLAY_WINDOW_RULES: WindowRules<PlayMode> = {
  stepMin: 15,
  minWindowMin: 15,
  maxWindows: 6,
  modes: PLAY_MODES,
  allowUnsaid: true,
  hints: { open: PLAY_HINTS.open.map((h) => h.id), closed: PLAY_HINTS.closed.map((h) => h.id) },
  maxGroup: 7,
};

/** "How long?" (30 min to 4 h on the server; these are the chips). */
export const PLAY_LENGTH_OPTIONS = [60, 90, 120, 180, 240] as const;
export const DEFAULT_PLAY_LENGTH_MIN = 120;
export const MIN_PLAY_LENGTH_MIN = 30;
export const MAX_PLAY_LENGTH_MIN = 240;
/** Doggle's cap. */
export const MAX_ROUTINES = 12;
/** A new routine's time, before the player picks one. */
export const DEFAULT_ROUTINE_TIME = '09:00';
/** Routine courts fenced with no mapped outline: Doggle's 150 m. */
export const ROUTINE_REGION_RADIUS_M = 150;

/** push_data.kind of the server's reminder at each stop's time. */
export const ROUTINE_REMINDER_KIND = 'routine_reminder';

// ── Shapes ────────────────────────────────────────────────────────────────────
export type RoutineOccurrence = {
  planId: string;
  plannedAt: string;
  plannedEndAt: string | null;
  /** 'cancelled' = skipped; 'completed' = checked in. */
  status: 'planned' | 'cancelled' | 'completed';
  windows: AbsoluteTimeWindow<PlayMode>[];
  /** Plan sharing (migration_plan_sharing.sql): null = only I see this stop. */
  sharedAt: string | null;
  /** Why it is shared ('confirm' / 'auto') or explicitly not ('hidden'); null = never shared. */
  shareSource: PlanShareSource | null;
};

export type CourtRoutine = {
  id: string;
  venueId: string;
  venueName: string;
  lat: number | null;
  lng: number | null;
  /** The outline's equal-area circle; null without one. */
  radiusM: number | null;
  /** Still one of my starred courts; false: dormant until it is starred again. */
  starred: boolean;
  /** The court's own "Check me in when I arrive" switch. */
  autoCheckin: boolean;
  /** Wall clock in `tz`, "HH:MM". */
  localTime: string;
  /** Mon = 1 ... Sun = 64. */
  days: number;
  tz: string;
  lengthMin: number;
  /** Offsets from the start (minutes). Empty: the whole length, nothing said. */
  windows: TimeWindow<PlayMode>[];
  active: boolean;
  next: RoutineOccurrence | null;
  /** Every occurrence still in play (today's and tomorrow's at most). */
  occurrences: RoutineOccurrence[];
};

export type RoutineSuggestion = {
  venueId: string;
  venueName: string;
  localTime: string;
  days: number;
  lengthMin: number;
  /** Distinct days seen in the last 6 weeks. */
  visits: number;
};

/** A player's routine, as their profile shows it (others never see a group). */
export type ProfileRoutine = {
  venueId: string;
  venueName: string;
  localTime: string;
  days: number;
  tz: string;
  lengthMin: number;
  windows: TimeWindow<PlayMode>[];
};

/** court_play_modes' row for one check-in. */
export type PlayModeRow = {
  checkinId: string;
  userId: string | null;
  modeNow: PlayMode | null;
  modeUntil: string | null;
  nextOpenAt: string | null;
  plannedEndAt: string | null;
  /** Closed-group members this viewer may see named (decision 4). */
  closedGroup: { userId: string; fullName: string | null }[];
};

export type CourtPlayModes = {
  openNow: number;
  closedNow: number;
  unsaidNow: number;
  players: PlayModeRow[];
};

// ── Parsing (untrusted JSON from the RPCs) ───────────────────────────────────
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asMode = (v: unknown): PlayMode | null => (v === 'open' || v === 'closed' || v === 'drill' ? v : null);
const STATUSES = new Set(['planned', 'cancelled', 'completed']);
const SHARE_SOURCES = new Set<string>(['plan', 'confirm', 'auto', 'hidden']);
/** court_plans.share_source; anything else (or absent, before migration_plan_sharing.sql) is null. */
export const asShareSource = (v: unknown): PlanShareSource | null =>
  typeof v === 'string' && SHARE_SOURCES.has(v) ? (v as PlanShareSource) : null;

function parseOccurrence(raw: unknown): RoutineOccurrence | null {
  const n = raw as Record<string, unknown> | null | undefined;
  if (!n || !n.plan_id) return null;
  const status = str(n.status);
  return {
    planId: str(n.plan_id),
    plannedAt: str(n.planned_at),
    plannedEndAt: strOrNull(n.planned_end_at),
    status: (STATUSES.has(status) ? status : 'planned') as RoutineOccurrence['status'],
    windows: parseAbsoluteWindows(n.windows, PLAY_MODES),
    sharedAt: strOrNull(n.shared_at),
    shareSource: asShareSource(n.share_source),
  };
}

export function parseCourtRoutine(raw: unknown): CourtRoutine {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(r.id),
    venueId: str(r.venue_id),
    venueName: str(r.venue_name) || 'A court',
    lat: numOrNull(r.lat),
    lng: numOrNull(r.lng),
    radiusM: numOrNull(r.radius_m),
    starred: r.starred !== false,
    autoCheckin: r.auto_checkin !== false,
    localTime: str(r.local_time),
    days: Number(r.days ?? 0),
    tz: str(r.tz) || 'America/Los_Angeles',
    lengthMin: Number(r.length_min ?? DEFAULT_PLAY_LENGTH_MIN),
    windows: parseWindows(r.windows, PLAY_MODES),
    active: r.active !== false,
    next: parseOccurrence(r.next),
    occurrences: Array.isArray(r.occurrences)
      ? (r.occurrences as unknown[]).map(parseOccurrence).filter((o): o is RoutineOccurrence => o != null)
      : [],
  };
}

export function parseRoutineList(data: unknown): CourtRoutine[] {
  return Array.isArray(data) ? data.map(parseCourtRoutine) : [];
}

export function parseSuggestions(data: unknown): RoutineSuggestion[] {
  return (Array.isArray(data) ? data : []).map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      venueId: str(r.venue_id),
      venueName: str(r.venue_name) || 'A court',
      localTime: str(r.local_time),
      days: Number(r.days ?? 0),
      lengthMin: Number(r.length_min ?? DEFAULT_PLAY_LENGTH_MIN),
      visits: Number(r.visits ?? 0),
    };
  });
}

export function parseProfileRoutines(data: unknown): ProfileRoutine[] {
  return (Array.isArray(data) ? data : []).map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      venueId: str(r.venue_id),
      venueName: str(r.venue_name) || 'A court',
      localTime: str(r.local_time),
      days: Number(r.days ?? 0),
      tz: str(r.tz),
      lengthMin: Number(r.length_min ?? DEFAULT_PLAY_LENGTH_MIN),
      windows: parseWindows(r.windows, PLAY_MODES),
    };
  });
}

export function parseCourtPlayModes(raw: unknown): CourtPlayModes {
  const r = (raw ?? {}) as Record<string, unknown>;
  const players = (Array.isArray(r.players) ? r.players : []).map((p): PlayModeRow => {
    const x = (p ?? {}) as Record<string, unknown>;
    return {
      checkinId: str(x.checkin_id),
      userId: strOrNull(x.user_id),
      modeNow: asMode(x.mode_now),
      modeUntil: strOrNull(x.mode_until),
      nextOpenAt: strOrNull(x.next_open_at),
      plannedEndAt: strOrNull(x.planned_end_at),
      closedGroup: (Array.isArray(x.closed_group) ? x.closed_group : []).map((m) => {
        const g = (m ?? {}) as Record<string, unknown>;
        return { userId: str(g.user_id), fullName: strOrNull(g.full_name) };
      }),
    };
  });
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  return { openNow: n(r.open_now), closedNow: n(r.closed_now), unsaidNow: n(r.unsaid_now), players };
}

// ── Which stop is due (Doggle routineStopDueAt, on the foundation's stopDueAt) ─
/** A routine as a foundation recurring stop; a dormant one (court unstarred) never falls due. */
export function routineStops(routines: readonly CourtRoutine[]): (RecurringStop & { routine: CourtRoutine })[] {
  return routines.map((r) => ({
    routine: r,
    placeId: r.venueId,
    localTime: r.localTime,
    days: r.days,
    tz: r.tz,
    active: r.active && r.starred,
    occurrences: [...r.occurrences, ...(r.next ? [r.next] : [])].map((o) => ({
      id: o.planId,
      plannedAt: o.plannedAt,
      status: o.status,
    })),
  }));
}

/**
 * The routine stop at `venueId` whose window is open at `at` (30 minutes
 * before to 30 minutes after its time, the server's _pl_routine_plan_at), or
 * null. A moved day opens at its new time; a skipped or kept one opens none.
 */
export function routineDueAt(
  routines: readonly CourtRoutine[],
  venueId: string,
  at: Date = new Date(),
): { routine: CourtRoutine; dueAt: Date; planId: string | null } | null {
  const due = stopDueAt(routineStops(routines), venueId, at);
  return due ? { routine: due.stop.routine, dueAt: due.dueAt, planId: due.occurrence?.id ?? null } : null;
}

/**
 * When the stop due at `venueId` is planned to end: its occurrence's planned
 * end, else its time plus the routine's length. Null when none is due. An
 * arrival's guess (lib/courtArrival: a background wake may have only an old
 * copy, and the weekly time is Doggle's fallback); how long a check-in asks
 * uses routineOccurrenceEndAt.
 */
export function routinePlannedEndAt(
  routines: readonly CourtRoutine[],
  venueId: string,
  at: Date = new Date(),
): string | null {
  const due = routineDueAt(routines, venueId, at);
  if (!due) return null;
  const occ = due.planId
    ? [...due.routine.occurrences, ...(due.routine.next ? [due.routine.next] : [])].find((o) => o.planId === due.planId)
    : null;
  if (occ?.plannedEndAt) return occ.plannedEndAt;
  return new Date(due.dueAt.getTime() + due.routine.lengthMin * 60_000).toISOString();
}

/**
 * The occurrence a check-in at `venueId` at `at` keeps, from this copy: the
 * server's _pl_routine_plan_at, a planned one at that court whose window (30
 * minutes either side of its time) holds `at`, the nearest when two do.
 * Null when there is none here.
 */
export function routineOccurrenceAt(
  routines: readonly CourtRoutine[],
  venueId: string,
  at: Date = new Date(),
): { routine: CourtRoutine; occurrence: RoutineOccurrence } | null {
  let best: { routine: CourtRoutine; occurrence: RoutineOccurrence } | null = null;
  let bestGap = Infinity;
  for (const routine of routines) {
    if (routine.venueId !== venueId) continue;
    for (const occurrence of [...routine.occurrences, ...(routine.next ? [routine.next] : [])]) {
      const t = Date.parse(occurrence.plannedAt);
      const gap = Math.abs(at.getTime() - t);
      if (occurrence.status !== 'planned' || !Number.isFinite(t) || gap > ROUTINE_DUE_MS || gap >= bestGap) continue;
      best = { routine, occurrence };
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The planned end of the routine occurrence a check-in at `venueId` at `at`
 * keeps (routineOccurrenceAt), else null. Only an occurrence counts: the
 * server links a check-in to nothing else, so a stop due by its weekly time
 * alone (a routine saved after its time today on a server before round 3, or
 * a copy older than the occurrence) takes nothing there. Counting it made
 * Home say "Check in at X until 12:34 PM?" and the tap ask 170 minutes for a
 * check-in with no windows and no planned end (probe X4).
 * readRoutinesForCheckin reads the copy fresh first in that case
 * (routineDueWithoutOccurrence).
 */
export function routineOccurrenceEndAt(
  routines: readonly CourtRoutine[],
  venueId: string,
  at: Date = new Date(),
): string | null {
  const hit = routineOccurrenceAt(routines, venueId, at);
  if (!hit) return null;
  return (
    hit.occurrence.plannedEndAt ??
    new Date(Date.parse(hit.occurrence.plannedAt) + hit.routine.lengthMin * 60_000).toISOString()
  );
}

/**
 * A routine stop is due at `venueId` at `at` by its weekly time, but this
 * copy has no occurrence for it: the copy may predate the one the server
 * made (it makes today's while its window is open, and re-makes it on an
 * edit), so read it fresh before deciding how long a check-in asks.
 */
export function routineDueWithoutOccurrence(
  routines: readonly CourtRoutine[],
  venueId: string,
  at: Date = new Date(),
): boolean {
  return routineDueAt(routines, venueId, at) != null && routineOccurrenceAt(routines, venueId, at) == null;
}

/**
 * What a check-in asks checkin_venue for when nothing else says, and the
 * least it ever asks (D1, the user's rule: "pickleball sessions should start
 * at 2 hours"): a check-in by hand or from a notification's button never ends
 * before 2 hours, a routine stop's or not.
 */
export const DEFAULT_CHECKIN_MINUTES = 120;

/**
 * How long a check-in made by hand at `venueId` at `at` asks checkin_venue
 * for when a routine stop with an occurrence is due there: to the stop's
 * planned end, in whole minutes rounded up, at least 2 hours (D1) and at most
 * 240 (checkin_venue's cap). Null when none is due, or it has no occurrence
 * in this copy (routineOccurrenceEndAt): the caller's 2 hours. The server
 * links the check-in to the occurrence and takes its closed / open windows
 * and planned end, but keeps the length asked (as Doggle does), so the
 * default 2 hours would end a 3-hour split before its open part.
 */
export function routineCheckinMinutes(
  routines: readonly CourtRoutine[],
  venueId: string,
  at: Date = new Date(),
): number | null {
  return atLeastDefault(minutesToPlannedEnd(routineOccurrenceEndAt(routines, venueId, at), at));
}

/** D1's floor on minutes to a routine's end (null stays null: the caller's default). */
function atLeastDefault(minutes: number | null): number | null {
  return minutes == null ? null : Math.max(DEFAULT_CHECKIN_MINUTES, minutes);
}

/**
 * Minutes from `at` to a routine stop's planned end, rounded up, 30 to 240
 * (the server's floor on a routine check-in's planned end, checkin_venue's
 * cap). Null when the end doesn't parse.
 */
export function minutesToPlannedEnd(endIso: string | null | undefined, at: Date = new Date()): number | null {
  const end = endIso ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(end)) return null;
  return Math.min(MAX_PLAY_LENGTH_MIN, Math.max(MIN_PLAY_LENGTH_MIN, Math.ceil((end - at.getTime()) / 60_000)));
}

/**
 * Until when Check in here runs at `venueId` at `at` when a routine stop with
 * an occurrence is due there: its planned end, or `at` + 4 hours when that
 * comes first (what the tap asks for: routineCheckinMinutes). Null when none
 * is due, it has no occurrence in this copy, or its end is 2 hours away or
 * less (the tap asks the default 2 hours then, D1: the card says "for 2
 * hours"). Home's card works it out on each render, on a minute tick, so its
 * "until" never drifts and follows a stop's window opening or closing (it
 * kept minutes read once and added them to the clock on every render).
 */
export function routineCheckinUntil(
  routines: readonly CourtRoutine[],
  venueId: string,
  at: Date = new Date(),
): string | null {
  const end = routineOccurrenceEndAt(routines, venueId, at);
  const minutes = routineCheckinMinutes(routines, venueId, at);
  if (!end || minutes == null) return null;
  const raw = (Date.parse(end) - at.getTime()) / 60_000;
  if (raw <= DEFAULT_CHECKIN_MINUTES) return null;
  return raw <= MAX_PLAY_LENGTH_MIN ? end : new Date(at.getTime() + minutes * 60_000).toISOString();
}

/** A routine stop's window around its time (the server's _pl_routine_plan_at): 30 minutes either side. */
const ROUTINE_DUE_MS = 30 * 60_000;

/**
 * How long a check-in from a notification's Check in asks for (the routine
 * reminder's "Check in", "At X? Check in now", "Check in nearby?": lib/
 * courtCheckin courtCheckin): to the planned end of the routine stop due at
 * that court, as a check-in by hand does. The tapped routine reminder's own
 * occurrence first (its push carries planned_at and planned_end_at: no read,
 * and a moved day is right) while `at` is inside its window, else my
 * routines (routineCheckinMinutes; null: not read). Never under 2 hours
 * (D1). Null when no stop with an occurrence is due (the caller's 2 hours).
 * Every button asked 2 hours before, so a 3-hour split closed 2 h / open 1 h
 * ended still closed.
 */
export function buttonCheckinMinutes(
  routines: readonly CourtRoutine[] | null,
  venueId: string,
  at: Date = new Date(),
  reminder?: { plannedAt?: string | null; plannedEndAt?: string | null } | null,
): number | null {
  const planned = reminder?.plannedAt ? Date.parse(reminder.plannedAt) : NaN;
  if (Number.isFinite(planned) && Math.abs(at.getTime() - planned) <= ROUTINE_DUE_MS) {
    const m = atLeastDefault(minutesToPlannedEnd(reminder?.plannedEndAt, at));
    if (m != null) return m;
  }
  return routines ? routineCheckinMinutes(routines, venueId, at) : null;
}

/**
 * The fact decideArrival reads: a routine stop is due at this court and
 * "Check me in at my routine courts" is on (null: unreadable, which is the
 * default, on).
 */
export function routineArrivalDue(
  routines: readonly CourtRoutine[] | null,
  venueId: string,
  routineAutoCheckin: boolean | null,
  at: Date = new Date(),
): boolean {
  if (routineAutoCheckin === false || !routines) return false;
  return routineDueAt(routines, venueId, at) != null;
}

// ── Words ─────────────────────────────────────────────────────────────────────
export function playModeLabel(mode: PlayMode | null): string {
  return mode ? PLAY_MODE_LABEL[mode] : UNSAID_LABEL;
}

export const WINDOWS_COPY: WindowsCopy<PlayMode> = { mode: playModeLabel };

/** Windows that say something (a single unsaid window says nothing). */
export function windowsSaySomething(windows: readonly { mode: PlayMode | null }[]): boolean {
  return windows.some((w) => w.mode != null);
}

/** "Weekdays · 9 AM · 3 h". */
export function routineTimeLine(r: { days: number; localTime: string; lengthMin: number }): string {
  return `${formatWeekdayMask(r.days)} · ${formatClockTime(r.localTime)} · ${formatDurationMinutes(r.lengthMin)}`;
}

/** "9 AM–10:30 AM Closed group · 10:30 AM–12 PM Open play"; '' when nothing is said. */
export function routineWindowsLine(r: { localTime: string; windows: readonly TimeWindow<PlayMode>[] }): string {
  if (!windowsSaySomething(r.windows)) return '';
  return formatWindows(r.windows, WINDOWS_COPY, { startClock: r.localTime });
}

/**
 * A routine's windows as save_court_routine takes them: fitted to its
 * length, neighbours of the same mode joined (the editor keeps a fresh split
 * apart until a mode is picked: foundation 1.58), and [] when nothing is
 * said (the server stores that as one window, not said).
 */
export function routineWindowsToSave(windows: readonly TimeWindow<PlayMode>[], lengthMin: number): TimeWindow<PlayMode>[] {
  if (!windowsSaySomething(windows)) return [];
  const list = normalizeWindows(fitWindowsToLength(windows, lengthMin, PLAY_WINDOW_RULES), lengthMin, PLAY_WINDOW_RULES);
  return windowsSaySomething(list) ? list : [];
}

/** "Closed group until 10:30 AM, then open play", or "Open play from 10:30 AM" with nothing said until then, at `at` (the server's _pl_windows_summary); '' after the last. */
export function playModeNowLine(
  windows: readonly AbsoluteTimeWindow<PlayMode>[],
  at: Date = new Date(),
  timeZone?: string | null,
): string {
  if (!windowsSaySomething(windows)) return '';
  return formatWindowsFrom(windows, at, WINDOWS_COPY, { timeZone });
}

/** "12 PM" for an instant, on this device's clock. */
export function clockLabel(iso: string | Date, timeZone?: string | null): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return formatClockTime(minutesToClock(wallClockIn(timeZone, d).minutes));
}

/**
 * A roster row's play mode: "Open to play until 12 PM", "Closed group with
 * Ann, Bob", "Closed group · open from 10:30 AM", "Drilling until 6 PM".
 * '' when nothing is said.
 */
export function playerModeLine(row: Pick<PlayModeRow, 'modeNow' | 'modeUntil' | 'nextOpenAt' | 'closedGroup'>, timeZone?: string | null): string {
  if (row.modeNow === 'open') {
    return row.modeUntil ? `Open to play until ${clockLabel(row.modeUntil, timeZone)}` : 'Open to play';
  }
  if (row.modeNow === 'drill') {
    const base = row.modeUntil ? `Drilling until ${clockLabel(row.modeUntil, timeZone)}` : 'Drilling';
    return row.nextOpenAt ? `${base} · open from ${clockLabel(row.nextOpenAt, timeZone)}` : base;
  }
  if (row.modeNow === 'closed') {
    const names = row.closedGroup.map((m) => m.fullName?.trim().split(/\s+/)[0]).filter((n): n is string => !!n);
    const base = names.length ? `Closed group with ${names.join(', ')}` : 'Closed group';
    return row.nextOpenAt ? `${base} · open from ${clockLabel(row.nextOpenAt, timeZone)}` : base;
  }
  // Nothing said now, open play later (a split that starts Not set).
  return row.nextOpenAt ? `Open to play from ${clockLabel(row.nextOpenAt, timeZone)}` : '';
}

/** "Stay until 12 PM" (the arrival_extend_until push's button means this). */
export function stayUntilLabel(plannedEndAt: string, timeZone?: string | null): string {
  return `Stay until ${clockLabel(plannedEndAt, timeZone)}`;
}

/** extend_checkin's reach: 4 hours from now, and without a fix 4 hours past the last one. */
const EXTEND_CAP_MS = 4 * 60 * 60_000;

/**
 * What the line under my check-in offers "Stay until" for: its planned end,
 * cut to what extend_checkin gives without a fix (4 hours from now, and for a
 * location-confirmed check-in 4 hours past its last fix, else past the
 * check-in; `locationConfirmed` unknown counts as confirmed, the lower
 * reach). Offered while that is more than a minute past the check-in's end
 * and the planned end is still ahead; null otherwise. A routine check-in made
 * by hand keeps the length asked (an older build asked 2 hours) while its
 * planned end is the routine's, and the web gets no "Staying until" push, so
 * this is the web's way to the open part. It asked for the planned end
 * itself before, so a 4-hour routine checked in early (ends 12:50, planned
 * 1 PM), or an arrival check-in once extended to its cap, failed every tap
 * with pl:checkin.needs_fix and the button never went away.
 */
export function stayUntilOffer(
  plan: {
    checkedInAt: string;
    expiresAt: string;
    plannedEndAt: string | null;
    fixAt?: string | null;
    locationConfirmed?: boolean | null;
  },
  now: Date = new Date(),
): string | null {
  if (!plan.plannedEndAt) return null;
  const end = Date.parse(plan.plannedEndAt);
  const exp = Date.parse(plan.expiresAt);
  if (!Number.isFinite(end) || !Number.isFinite(exp) || end <= now.getTime()) return null;
  let reach = Math.min(end, now.getTime() + EXTEND_CAP_MS);
  if (plan.locationConfirmed !== false) {
    const last = Date.parse(plan.fixAt || plan.checkedInAt);
    if (Number.isFinite(last)) reach = Math.min(reach, last + EXTEND_CAP_MS);
  }
  if (reach <= exp + 60_000) return null;
  return reach === end ? plan.plannedEndAt : new Date(reach).toISOString();
}

/**
 * The line under my check-in: its mode now ("Closed group until 10:30 AM,
 * then open play"), else "Planned until 12 PM" while that is still ahead,
 * else ''. A check-in can run past its planned end (a session check-in, the
 * 2 hours a button asked on a short routine, Stay 1 more hour), and the line
 * kept saying "Planned until 10 AM" after 10.
 */
export function checkinPlanLine(
  plan: { plannedEndAt: string | null; windows: readonly AbsoluteTimeWindow<PlayMode>[] },
  now: Date = new Date(),
  timeZone?: string | null,
): string {
  const line = playModeNowLine(plan.windows, now, timeZone);
  if (line) return line;
  const end = plan.plannedEndAt ? Date.parse(plan.plannedEndAt) : NaN;
  return Number.isFinite(end) && end > now.getTime() ? `Planned until ${clockLabel(plan.plannedEndAt!, timeZone)}` : '';
}

// ── A check-in's plan (set_checkin_plan) ──────────────────────────────────────
/**
 * Lengths a check-in that began at `checkedInAt` can still be planned to:
 * the chips whose end is at least 15 minutes from now.
 */
export function checkinLengthOptions(checkedInAt: string, nowMs: number = Date.now()): number[] {
  const start = Date.parse(checkedInAt);
  if (!Number.isFinite(start)) return [...PLAY_LENGTH_OPTIONS];
  return PLAY_LENGTH_OPTIONS.filter((m) => start + m * 60_000 >= nowMs + 15 * 60_000);
}

/**
 * Absolute windows cut to run from `startIso` to `endIso`, as the server
 * keeps a check-in's (set_checkin_plan sets the first start to the check-in
 * and the last end to the planned end): a window over before the start or
 * starting at or after the end is dropped, the first kept starts at the
 * start, the last kept ends at the end. A routine's windows start at its
 * time, so an arrival 20 minutes late, or 15 early, needs this before any
 * window maths. [] when none is left, or the span is empty.
 */
export function spanCheckinWindows(
  windows: readonly AbsoluteTimeWindow<PlayMode>[],
  startIso: string,
  endIso: string,
): AbsoluteTimeWindow<PlayMode>[] {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];
  const kept = [...windows]
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .filter((w) => Date.parse(w.endsAt) > s && Date.parse(w.startsAt) < e)
    .map((w) => ({ ...w, group: [...(w.group ?? [])] }));
  if (kept.length === 0) return [];
  kept[0].startsAt = new Date(s).toISOString();
  kept[kept.length - 1].endsAt = new Date(e).toISOString();
  return kept;
}

/**
 * The plan sheet's starting windows (offsets from the check-in, `lengthMin`
 * long, 15-minute grid): the check-in's windows cut to it (a routine's start
 * at its time, not at the arrival), else all Open play (decision 5).
 */
export function checkinPlanEditorWindows(
  windows: readonly AbsoluteTimeWindow<PlayMode>[],
  checkedInAt: string,
  lengthMin: number,
): TimeWindow<PlayMode>[] {
  const start = Date.parse(checkedInAt);
  const spanned = Number.isFinite(start)
    ? spanCheckinWindows(windows, checkedInAt, new Date(start + lengthMin * 60_000).toISOString())
    : [];
  if (spanned.length === 0) return singleWindow<PlayMode>(lengthMin, 'open');
  return normalizeWindows(windowsToOffsets(spanned, checkedInAt), lengthMin, PLAY_WINDOW_RULES, 'open', KEEP_WINDOWS_APART);
}

/**
 * The plan sheet's windows after "How long?" changes: fitted, a fresh split
 * kept apart. Pass the windows the player last left (the sheet's opening
 * ones, or their last edit), not the last fit: a split stays as long as its
 * point is inside the length (longer stretches the last window, shorter drops
 * a window starting less than 15 minutes before the end), so going shorter
 * and back never collapses it into one mode.
 */
export function fitCheckinPlanWindows(windows: readonly TimeWindow<PlayMode>[], lengthMin: number): TimeWindow<PlayMode>[] {
  return fitWindowsToLength(windows, lengthMin, PLAY_WINDOW_RULES, KEEP_WINDOWS_APART);
}

type CheckinPlanFacts = {
  checkedInAt: string;
  expiresAt: string;
  plannedEndAt: string | null;
  windows: readonly AbsoluteTimeWindow<PlayMode>[];
  /** The last confirming fix and whether the check-in is location-confirmed (set_checkin_plan's reach; unknown: confirmed). */
  fixAt?: string | null;
  locationConfirmed?: boolean | null;
};

/**
 * The latest of a check-in's planned end, its end and its last window's end
 * (ms), at least 30 minutes after the check-in. NaN when the check-in time
 * doesn't parse or nothing does.
 */
function checkinPlanLatestRawMs(plan: CheckinPlanFacts): number {
  const start = Date.parse(plan.checkedInAt);
  if (!Number.isFinite(start)) return NaN;
  const ends = [plan.plannedEndAt, plan.expiresAt, ...plan.windows.map((w) => w.endsAt)]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((v) => Number.isFinite(v));
  if (ends.length === 0) return NaN;
  return Math.max(start + MIN_PLAY_LENGTH_MIN * 60_000, Math.max(...ends));
}

/**
 * checkinPlanLatestRawMs, at most 4 hours after the check-in: the longest
 * "How long?" the sheet shows. NaN as there.
 */
function checkinPlanLatestEndMs(plan: CheckinPlanFacts): number {
  const start = Date.parse(plan.checkedInAt);
  return Math.min(start + MAX_PLAY_LENGTH_MIN * 60_000, checkinPlanLatestRawMs(plan));
}

/**
 * The latest planned end set_checkin_plan keeps for this check-in at `now`:
 * its own end, or later up to 4 hours from now and, location-confirmed (or
 * unknown), 4 hours past its last fix (else past the check-in). The server
 * cuts a later one to this.
 */
function checkinPlanReachMs(plan: CheckinPlanFacts, now: Date): number {
  let reach = now.getTime() + EXTEND_CAP_MS;
  if (plan.locationConfirmed !== false) {
    const last = Date.parse(plan.fixAt || plan.checkedInAt);
    if (Number.isFinite(last)) reach = Math.min(reach, last + EXTEND_CAP_MS);
  }
  const exp = Date.parse(plan.expiresAt);
  return Number.isFinite(exp) ? Math.max(reach, exp) : reach;
}

/**
 * The plan sheet's starting "How long?" for a check-in: from the check-in to
 * the latest of its planned end, its end and its last window's end, on the
 * 15-minute grid (whole minutes first, so a few seconds never add a step), 30
 * minutes to 4 hours. Up to 7 minutes past a step it stays on that step (a
 * check-in at 9:29 planned to 12:00 opens at 2 h 30 min, not 2 h 45 min),
 * unless a window would go (one starting in those minutes, as "Switch to
 * open play now" just before the end leaves); else the next step up, so no
 * window is cut before a length is picked. Taking only the planned end, else
 * the end, cut a routine's windows that run past a check-in made by hand (2
 * hours asked, no planned end on an older server): the sheet opened at 2
 * hours without the open part, and saved all closed.
 */
export function checkinPlanStartLength(plan: CheckinPlanFacts): number {
  const start = Date.parse(plan.checkedInAt);
  const latest = checkinPlanLatestEndMs(plan);
  if (!Number.isFinite(start) || !Number.isFinite(latest)) return DEFAULT_PLAY_LENGTH_MIN;
  const minutes = Math.round((latest - start) / 60_000);
  const step = PLAY_WINDOW_RULES.stepMin ?? 15;
  const clamp = (m: number) => Math.min(MAX_PLAY_LENGTH_MIN, Math.max(MIN_PLAY_LENGTH_MIN, m));
  const up = clamp(Math.ceil(minutes / step) * step);
  const down = clamp(Math.floor(minutes / step) * step);
  if (down === up || minutes - down > 7) return up;
  const kept = (m: number) => checkinPlanEditorWindows(plan.windows, plan.checkedInAt, m).length;
  return kept(down) === kept(up) ? down : up;
}

/** What the plan sheet opens with (checkinPlanSheetStart), and what Save keeps exact. */
export type CheckinPlanSheetStart = {
  lengthMin: number;
  windows: TimeWindow<PlayMode>[];
  /**
   * The check-in's latest end (its planned end, its end or its last
   * window's end), as far as set_checkin_plan keeps it (checkinPlanReachMs):
   * the planned end Save sends while "How long?" is still `lengthMin`. Past
   * the 4 hours the sheet shows when the server takes it (a check-in kept
   * going with fixes), so Save never cuts it to the check-in + 4 h. Null when
   * the check-in time doesn't parse.
   */
  endAt: string | null;
  /**
   * The check-in's inner window boundaries at their own minute, keyed by the
   * editor offset they open at (the 15-minute grid from the check-in): Save
   * puts a boundary still at that offset back on its own minute.
   */
  boundaries: Record<number, string>;
  /**
   * The check-in's windows from the check-in to `endAt`, at their own
   * minutes: Save sends them as they are when the player changed nothing
   * (length and windows as opened). [] when they say nothing.
   */
  original: AbsoluteTimeWindow<PlayMode>[];
  /**
   * Leading windows the 15-minute grid can't show: they end less than half a
   * step after the check-in (9:23 in on a routine closed until 9:30). Save
   * puts them back in front while the first window keeps the kind it opened
   * with. [] when there are none.
   */
  lead: AbsoluteTimeWindow<PlayMode>[];
};

/**
 * What the plan sheet opens with at `now`: the starting length
 * (checkinPlanStartLength) and the check-in's windows at that length, none
 * cut before the player picks a length, plus the exact end, boundaries, the
 * windows as they are and any leading sliver (checkinPlanToSave).
 */
export function checkinPlanSheetStart(plan: CheckinPlanFacts, now: Date = new Date()): CheckinPlanSheetStart {
  const lengthMin = checkinPlanStartLength(plan);
  const windows = checkinPlanEditorWindows(plan.windows, plan.checkedInAt, lengthMin);
  const start = Date.parse(plan.checkedInAt);
  const latest = checkinPlanLatestRawMs(plan);
  const endMs = Number.isFinite(latest) ? Math.min(latest, checkinPlanReachMs(plan, now)) : start + lengthMin * 60_000;
  const step = PLAY_WINDOW_RULES.stepMin ?? 15;
  const boundaries: Record<number, string> = {};
  let original: AbsoluteTimeWindow<PlayMode>[] = [];
  const lead: AbsoluteTimeWindow<PlayMode>[] = [];
  if (Number.isFinite(endMs)) {
    const endIso = new Date(endMs).toISOString();
    const spanned = spanCheckinWindows(plan.windows, plan.checkedInAt, endIso);
    for (const w of spanned.slice(1)) {
      const key = Math.round(Math.round((Date.parse(w.startsAt) - start) / 60_000) / step) * step;
      if (!(key in boundaries)) boundaries[key] = w.startsAt;
    }
    if (windowsSaySomething(spanned)) original = spanned;
    // The windows the editor was given (to `lengthMin`): those whose end
    // rounds to the check-in on the grid are dropped there.
    const shown = spanCheckinWindows(plan.windows, plan.checkedInAt, new Date(start + lengthMin * 60_000).toISOString());
    for (let i = 0; i < shown.length - 1; i++) {
      if (Math.round(Math.round((Date.parse(shown[i].endsAt) - start) / 60_000) / step) !== 0) break;
      lead.push(shown[i]);
    }
    // Nothing lost when the first window shown is of the same kind.
    if (lead.length && sameKind(lead[lead.length - 1], shown[lead.length])) lead.length = 0;
  }
  return {
    lengthMin,
    windows,
    endAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    boundaries,
    original,
    lead,
  };
}

/** Same mode, hint and group (foundation sameWindowKind, for either window shape). */
function sameKind(a: { mode: PlayMode | null; hint?: string | null; group?: string[] }, b: { mode: PlayMode | null; hint?: string | null; group?: string[] }): boolean {
  const g = (x?: string[]) => [...(x ?? [])].sort().join(',');
  return (a.mode ?? null) === (b.mode ?? null) && (a.hint ?? null) === (b.hint ?? null) && g(a.group) === g(b.group);
}

/** The editor's windows are the ones the sheet opened with (bounds and kinds). */
function sameEditorWindows(a: readonly TimeWindow<PlayMode>[], b: readonly TimeWindow<PlayMode>[]): boolean {
  return a.length === b.length && a.every((w, i) => w.startMin === b[i].startMin && w.endMin === b[i].endMin && sameKind(w, b[i]));
}

const copyAbsolute = (w: AbsoluteTimeWindow<PlayMode>): AbsoluteTimeWindow<PlayMode> => ({ ...w, group: [...(w.group ?? [])] });

/**
 * What the plan sheet's Save sends set_checkin_plan: the windows it shows for
 * `lengthMin` (checkinPlanWindowsToSave), with the planned end and every
 * boundary the player left where it was at its own minute, not the grid's.
 * While "How long?" is still the opening length the planned end is the
 * check-in's own (`start.endAt`), else the check-in + `lengthMin`. Before, an
 * open and save moved both onto the 15-minute grid from the check-in: a 9:29
 * check-in planned to 12:00, closed until 11:00, saved until 12:14 with the
 * split at 10:59.
 *
 * Nothing changed (the opening length and windows): the check-in's own
 * windows and end, exactly (`start.original`), so an open and save changes
 * nothing the grid can't show: minutes, a sliver, a part past 4 hours. A
 * leading sliver the grid dropped (`start.lead`) goes back in front while the
 * first window keeps the kind it opened with: 9:23 in on a routine closed
 * until 9:30 saved open from 9:23 before.
 */
export function checkinPlanToSave(
  start: Pick<CheckinPlanSheetStart, 'lengthMin' | 'endAt' | 'boundaries'> &
    Partial<Pick<CheckinPlanSheetStart, 'windows' | 'original' | 'lead'>>,
  windows: readonly TimeWindow<PlayMode>[],
  lengthMin: number,
  checkedInAt: string,
): { plannedEnd: Date; windows: AbsoluteTimeWindow<PlayMode>[] } {
  const s = Date.parse(checkedInAt);
  const gridEnd = s + lengthMin * 60_000;
  const exactEnd = lengthMin === start.lengthMin && start.endAt ? Date.parse(start.endAt) : NaN;
  if (
    Number.isFinite(exactEnd) &&
    start.original?.length &&
    start.windows &&
    sameEditorWindows(windows, start.windows)
  ) {
    return { plannedEnd: new Date(exactEnd), windows: start.original.map(copyAbsolute) };
  }
  let list = checkinPlanWindowsToSave(windows, lengthMin, checkedInAt);
  let end = Number.isFinite(exactEnd) ? exactEnd : gridEnd;
  for (let i = 1; i < list.length; i++) {
    const exact = start.boundaries[Math.round((Date.parse(list[i].startsAt) - s) / 60_000)];
    const t = exact ? Date.parse(exact) : NaN;
    if (Number.isFinite(t) && t > Date.parse(list[i - 1].startsAt) && t < end) {
      const iso = new Date(t).toISOString();
      list[i].startsAt = iso;
      list[i - 1].endsAt = iso;
    }
  }
  if (list.length > 0) {
    if (Date.parse(list[list.length - 1].startsAt) >= end) end = gridEnd;
    list[list.length - 1].endsAt = new Date(end).toISOString();
  }
  const lead = start.lead ?? [];
  const opened = start.windows?.[0];
  if (
    lead.length > 0 &&
    list.length > 0 &&
    windows.length > 0 &&
    opened &&
    sameKind(windows[0], opened) &&
    list.length + lead.length <= (PLAY_WINDOW_RULES.maxWindows ?? 6)
  ) {
    const cut = lead[lead.length - 1].endsAt;
    if (Date.parse(cut) < Date.parse(list[0].endsAt)) {
      list[0].startsAt = cut;
      list = [...lead.map(copyAbsolute), ...list];
    }
  }
  return { plannedEnd: new Date(end), windows: list };
}

/**
 * What the plan sheet sends set_checkin_plan: exactly the windows it shows
 * for `lengthMin` (fitted, same modes joined), absolute from the check-in.
 * [] (clear) when nothing is said. Before, the sheet sent its last edit's
 * windows even after "How long?" changed, and a shorter length was refused.
 */
export function checkinPlanWindowsToSave(
  windows: readonly TimeWindow<PlayMode>[],
  lengthMin: number,
  checkedInAt: string,
): AbsoluteTimeWindow<PlayMode>[] {
  const list = normalizeWindows(fitWindowsToLength(windows, lengthMin, PLAY_WINDOW_RULES), lengthMin, PLAY_WINDOW_RULES);
  return windowsSaySomething(list) ? windowsToAbsolute(list, checkedInAt) : [];
}

/**
 * "Switch to open play now": the check-in's windows cut at `now`, the rest of
 * the current one open (later windows stay). With no windows, closed or not
 * said until now and open after. Null when it is open already.
 *
 * The windows are first cut to run from the check-in to `endAt` (what the
 * server keeps), so a routine arrival's windows switch too when `now` is
 * before their first start (an early arrival: nothing changed before) or
 * after the end of a window that ended before the check-in (refused before).
 */
export function switchToOpenWindows(
  current: readonly AbsoluteTimeWindow<PlayMode>[],
  checkedInAt: string,
  endAt: string,
  now: Date = new Date(),
): AbsoluteTimeWindow<PlayMode>[] | null {
  const spanned = current.length > 0 ? spanCheckinWindows(current, checkedInAt, endAt) : [];
  if (current.length > 0 && spanned.length > 0) {
    const at = modeAt(spanned, now);
    if (at?.mode === 'open') return null;
    // Past the end, the last mode carries on: open from now to the end is all there is to do.
    if (now.getTime() >= Date.parse(endAt)) return null;
    return splitAbsoluteAt(spanned, now, 'open');
  }
  if (modeAt(current, now)?.mode === 'open') return null;
  const start = Date.parse(checkedInAt);
  const nowIso = now.toISOString();
  const list: AbsoluteTimeWindow<PlayMode>[] = [];
  // A minute in, there's a "before" worth keeping.
  if (Number.isFinite(start) && now.getTime() - start >= 60_000) {
    list.push({ startsAt: new Date(start).toISOString(), endsAt: nowIso, mode: null, hint: null, group: [] });
  }
  list.push({ startsAt: list.length ? nowIso : new Date(Number.isFinite(start) ? start : now.getTime()).toISOString(), endsAt: endAt, mode: 'open', hint: null, group: [] });
  return list;
}

/**
 * "Switch to open play now" for my check-in (the plan line and the island):
 * the windows to send set_checkin_plan, and the planned end to send with
 * them. That end is null (keep it) unless the planned end has passed (the
 * check-in was extended past it): the server runs windows to the planned
 * end, so a switch then could only open a window in the past; the plan moves
 * to the check-in's own end instead. Null when it is open already.
 */
export function switchToOpenPlan(
  plan: { checkedInAt: string; plannedEndAt: string | null; expiresAt: string; windows: readonly AbsoluteTimeWindow<PlayMode>[] },
  now: Date = new Date(),
): { windows: AbsoluteTimeWindow<PlayMode>[]; plannedEnd: Date | null } | null {
  const plannedEnd = plan.plannedEndAt ? Date.parse(plan.plannedEndAt) : NaN;
  const passed = Number.isFinite(plannedEnd) && plannedEnd <= now.getTime();
  const endAt = plan.plannedEndAt && !passed ? plan.plannedEndAt : plan.expiresAt;
  const windows = switchToOpenWindows(plan.windows, plan.checkedInAt, endAt, now);
  if (!windows) return null;
  return { windows, plannedEnd: passed ? new Date(plan.expiresAt) : null };
}
