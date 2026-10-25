// Routine check-ins (supabase/migration_court_routines.sql, Doggle's
// data/routines.ts): "Tue/Thu 9 AM at Lakeside, 3 h, closed group until
// 10:30 then open play". The server turns each routine into planned
// occurrences for today and tomorrow; arriving during one's window checks the
// player in with its length and windows, and a check-in made there keeps it.
//
// This module is the only path to the routine RPCs. Every routine write
// returns the full list, which is stored straight into the cache. The cached
// list doubles as the device's copy for arrival check-ins (lib/courtArrival,
// lib/courtGeofence): a geofence wake may have no signal, so it is kept on
// disk for a week (Doggle's rule).
//
// Headless-safe like data/courtArrival: no React, screens or components.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { cachedFetch, invalidateQueries, peekQuery, setQueryData, WEEK_MS, DAY_MS, HOUR_MS } from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { deviceTimeZone, validTimeZone } from '@just-messin-around/expo-foundation/push/optionVote';
import {
  absoluteWindowsToRows,
  parseAbsoluteWindows,
  windowsToRows,
  type AbsoluteTimeWindow,
  type TimeWindow,
} from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { supabase } from '../lib/supabase';
import {
  parseCourtPlayModes,
  parseProfileRoutines,
  parseRoutineList,
  parseSuggestions,
  PLAY_MODES,
  type CourtPlayModes,
  type CourtRoutine,
  type PlayMode,
  type ProfileRoutine,
  type RoutineOccurrence,
  type RoutineSuggestion,
} from '../lib/courtRoutineRules';
import { courtArrivalResync } from './courtArrival';

export type { CourtRoutine, ProfileRoutine, RoutineOccurrence, RoutineSuggestion, CourtPlayModes };

export const MY_COURT_ROUTINES_KEY = 'me:courtRoutines:v1';
export const COURT_ROUTINE_SETTINGS_KEY = 'me:courtRoutineSettings:v1';
const SUGGESTIONS_KEY = 'me:courtRoutineSuggestions:v1';
export const profileRoutinesKey = (profileId: string) => `profile:${profileId}:courtRoutines`;
export const venueOpenToPlayKey = (venueId: string) => `venue:openToPlay:${venueId}`;
export const courtPlayModesKey = (venueId: string) => `venue:playModes:${venueId}`;

/** Doggle's 5 minutes fresh, a week on disk (geofence wakes read it offline). */
export const MY_COURT_ROUTINES_TTL_MS = 5 * 60_000;
export const MY_COURT_ROUTINES_PERSIST_MS = WEEK_MS;

const BOUND = { timeoutMs: 9_000 };

/** Fires after my routines change. The geofences resync on it (routine courts are fenced first). */
export const courtRoutinesChanged = createSignal<void>();

// ── My routines ─────────────────────────────────────────────────────────────
/** Raw fetcher: bind screens to this with useCachedQuery (never to loadMyCourtRoutines). */
export async function fetchMyCourtRoutines(): Promise<CourtRoutine[]> {
  return parseRoutineList(await sbCall(() => supabase.rpc('list_my_court_routines'), BOUND));
}

/** Cached list (5 min, a week on disk); `force` reads the server now. */
export function loadMyCourtRoutines(force = false): Promise<CourtRoutine[]> {
  return cachedFetch(MY_COURT_ROUTINES_KEY, fetchMyCourtRoutines, {
    ttlMs: force ? 0 : MY_COURT_ROUTINES_TTL_MS,
    persistMs: MY_COURT_ROUTINES_PERSIST_MS,
  });
}

/**
 * For background wakes: the copy in memory or restored from disk, without
 * waiting on the network; a fetch only when there is none. Every foreground
 * sync refreshes it (lib/courtGeofence), so it is at most as old as the last
 * time the app was open.
 */
export async function getMyCourtRoutinesOffline(): Promise<CourtRoutine[]> {
  return peekQuery<CourtRoutine[]>(MY_COURT_ROUTINES_KEY) ?? loadMyCourtRoutines();
}

function stored(data: unknown): CourtRoutine[] {
  const list = parseRoutineList(data);
  setQueryData(MY_COURT_ROUTINES_KEY, list);
  invalidateQueries(SUGGESTIONS_KEY);
  courtRoutinesChanged.emit();
  // Routine courts are fenced first: re-pick the watched courts.
  courtArrivalResync.emit();
  return list;
}

export type CourtRoutineInput = {
  id?: string | null;
  venueId: string;
  /** "HH:MM" in `tz` (this device's zone when omitted). */
  localTime: string;
  days: number;
  lengthMin: number;
  /** Offsets from the start; empty = the whole length, nothing said. */
  windows: TimeWindow<PlayMode>[];
  /** The routine's own zone. An edit keeps it; a new one leaves it unset. */
  tz?: string | null;
};

export async function saveCourtRoutine(input: CourtRoutineInput): Promise<CourtRoutine[]> {
  const data = await sbCall(
    () =>
      supabase.rpc('save_court_routine', {
        p_routine_id: input.id ?? null,
        p_venue: input.venueId,
        p_local_time: input.localTime,
        p_days: input.days,
        p_tz: validTimeZone(input.tz) ?? deviceTimeZone(),
        p_length_min: input.lengthMin,
        p_windows: input.windows.length ? windowsToRows(input.windows) : null,
      }),
    BOUND,
  );
  return stored(data);
}

export async function setCourtRoutineActive(id: string, active: boolean): Promise<CourtRoutine[]> {
  return stored(await sbCall(() => supabase.rpc('set_court_routine_active', { p_routine_id: id, p_active: active }), BOUND));
}

export async function deleteCourtRoutine(id: string): Promise<CourtRoutine[]> {
  return stored(await sbCall(() => supabase.rpc('delete_court_routine', { p_routine_id: id }), BOUND));
}

/** "Skip today": that one occurrence; the routine carries on. Also the reminder's Skip today. */
export async function skipRoutineOccurrence(planId: string): Promise<CourtRoutine[]> {
  return stored(await sbCall(() => supabase.rpc('skip_court_routine_occurrence', { p_plan_id: planId }), BOUND));
}

export async function unskipRoutineOccurrence(planId: string): Promise<CourtRoutine[]> {
  return stored(await sbCall(() => supabase.rpc('unskip_court_routine_occurrence', { p_plan_id: planId }), BOUND));
}

/** "Change today's time": that one occurrence moves (later today, in the routine's zone). */
export async function moveRoutineOccurrence(planId: string, at: Date): Promise<CourtRoutine[]> {
  return stored(
    await sbCall(() => supabase.rpc('move_court_routine_occurrence', { p_plan_id: planId, p_at: at.toISOString() }), BOUND),
  );
}

/** The occurrence a reminder push names, from this phone's copy (null when it isn't there). */
export async function routineForPlan(planId: string): Promise<{ routine: CourtRoutine; occurrence: RoutineOccurrence } | null> {
  const list = await getMyCourtRoutinesOffline().catch(() => [] as CourtRoutine[]);
  for (const r of list) {
    const o = r.occurrences.find((x) => x.planId === planId) ?? (r.next?.planId === planId ? r.next : null);
    if (o) return { routine: r, occurrence: o };
  }
  return null;
}

// ── Suggestions and friends' routines ───────────────────────────────────────
export function loadRoutineSuggestions(): Promise<RoutineSuggestion[]> {
  return cachedFetch(
    SUGGESTIONS_KEY,
    async () => parseSuggestions(await sbCall(() => supabase.rpc('suggest_court_routines', { p_tz: deviceTimeZone() }), BOUND)),
    { ttlMs: HOUR_MS, persistMs: DAY_MS },
  );
}

/** A player's planned check-ins; the server applies their plans_level, blocks and hide-froms. */
export function loadProfileRoutines(profileId: string): Promise<ProfileRoutine[]> {
  return cachedFetch(
    profileRoutinesKey(profileId),
    async () => parseProfileRoutines(await sbCall(() => supabase.rpc('list_profile_court_routines', { p_profile: profileId }), BOUND)),
    { ttlMs: 5 * 60_000, persistMs: DAY_MS },
  );
}

// ── "Check me in at my routine courts" ──────────────────────────────────────
export type CourtRoutineSettings = {
  routine_auto_checkin: boolean;
  /**
   * "Share my routine stops automatically" (migration_plan_sharing.sql;
   * default off, and off before that file is live). A copy cached by an older
   * build has no such key: read it with autoShareOf, which says null then.
   */
  auto_share_routines: boolean;
};

function parseSettings(raw: unknown): CourtRoutineSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CourtRoutineSettings>;
  return { routine_auto_checkin: r.routine_auto_checkin !== false, auto_share_routines: r.auto_share_routines === true };
}

/** The auto-share setting from a (maybe older) cached copy: null when it isn't known. */
export function autoShareOf(s: Partial<CourtRoutineSettings> | null | undefined): boolean | null {
  return typeof s?.auto_share_routines === 'boolean' ? s.auto_share_routines : null;
}

export async function getCourtRoutineSettings(): Promise<CourtRoutineSettings> {
  return parseSettings(await sbCall(() => supabase.rpc('get_court_routine_settings'), BOUND));
}

export function loadCourtRoutineSettings(force = false): Promise<CourtRoutineSettings> {
  return cachedFetch(COURT_ROUTINE_SETTINGS_KEY, getCourtRoutineSettings, {
    ttlMs: force ? 0 : HOUR_MS,
    persistMs: WEEK_MS,
  });
}

export async function setRoutineAutoCheckin(on: boolean): Promise<CourtRoutineSettings> {
  const s = parseSettings(await sbCall(() => supabase.rpc('set_routine_auto_checkin', { p_on: on }), BOUND));
  setQueryData(COURT_ROUTINE_SETTINGS_KEY, s);
  return s;
}

/**
 * "Share my routine stops automatically" (set_auto_share_routines). On
 * shares my routine stops still in play that I never shared nor hid; off
 * un-shares only the ones it shared. My routines' share columns change, so
 * their list is re-read (a forced read that replaces the cached copy, not an
 * invalidate: geofence wakes read that copy from disk).
 */
export async function setAutoShareRoutines(on: boolean): Promise<CourtRoutineSettings> {
  const s = parseSettings(await sbCall(() => supabase.rpc('set_auto_share_routines', { p_on: on }), BOUND));
  setQueryData(COURT_ROUTINE_SETTINGS_KEY, s);
  void loadMyCourtRoutines(true)
    .then(() => courtRoutinesChanged.emit())
    .catch(() => undefined);
  return s;
}

/** Share these routine stops (the daily sheet's Confirm / Confirm all). Refusals: plan.gone, request.bad. */
export async function confirmCourtPlans(planIds: readonly string[]): Promise<CourtRoutine[]> {
  return stored(await sbCall(() => supabase.rpc('confirm_court_plans', { p_plan_ids: [...planIds] }), BOUND));
}

// ── A check-in's plan ───────────────────────────────────────────────────────
export type CheckinPlan = {
  checkinId: string;
  venueId: string;
  checkedInAt: string;
  expiresAt: string;
  plannedEndAt: string | null;
  windows: AbsoluteTimeWindow<PlayMode>[];
  planId: string | null;
  modeNow: PlayMode | null;
  /** The end the arrival job gave an arrival check-in (`expires_at = arrival_until`: not extended yet). */
  arrivalUntil: string | null;
  /**
   * The last confirming fix (null: none, as on an arrival check-in) and
   * whether the check-in is location-confirmed (null: not read, as in
   * set_checkin_plan's answer): extend_checkin without a fix stops 4 hours
   * past the fix, else past the check-in (stayUntilOffer).
   */
  fixAt: string | null;
  locationConfirmed: boolean | null;
};

function parsePlan(raw: unknown): CheckinPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const mode = r.mode_now === 'open' || r.mode_now === 'closed' ? r.mode_now : null;
  return {
    checkinId: s(r.checkin_id ?? r.id),
    venueId: s(r.venue_id),
    checkedInAt: s(r.checked_in_at),
    expiresAt: s(r.expires_at),
    plannedEndAt: typeof r.planned_end_at === 'string' ? r.planned_end_at : null,
    windows: parseAbsoluteWindows(r.play_windows, PLAY_MODES),
    planId: typeof r.plan_id === 'string' ? r.plan_id : null,
    modeNow: mode,
    arrivalUntil: typeof r.arrival_until === 'string' ? r.arrival_until : null,
    fixAt: typeof r.fix_at === 'string' ? r.fix_at : null,
    locationConfirmed: typeof r.location_confirmed === 'boolean' ? r.location_confirmed : null,
  };
}

/**
 * My open check-in's planned end and windows (owner-only columns of
 * venue_checkins). Only read with ROUTINES_ENABLED: the columns exist once
 * migration_court_routines.sql is live.
 */
export async function getCheckinPlan(checkinId: string): Promise<CheckinPlan | null> {
  const row = await sbCall(
    () =>
      supabase
        .from('venue_checkins')
        .select('id, venue_id, checked_in_at, expires_at, planned_end_at, play_windows, plan_id, arrival_until, fix_at, location_confirmed')
        .eq('id', checkinId)
        .maybeSingle(),
    BOUND,
  );
  return row ? parsePlan(row) : null;
}

/**
 * set_checkin_plan: a planned end (null keeps it) and windows (null keeps
 * them, fitted to the end; [] clears them). "Switch to open play now" sends
 * the split windows. Refusals: plan.bad_end, windows.bad, checkin.none,
 * checkin.closed (lib/refusals).
 */
export async function setCheckinPlan(
  checkinId: string,
  plannedEnd: Date | null,
  windows: AbsoluteTimeWindow<PlayMode>[] | null,
): Promise<CheckinPlan> {
  const plan = parsePlan(
    await sbCall(
      () =>
        supabase.rpc('set_checkin_plan', {
          p_checkin: checkinId,
          p_planned_end: plannedEnd ? plannedEnd.toISOString() : null,
          p_windows: windows ? absoluteWindowsToRows(windows) : null,
        }),
      BOUND,
    ),
  );
  if (plan.venueId) {
    invalidateQueries(courtPlayModesKey(plan.venueId));
    invalidateQueries(venueOpenToPlayKey(plan.venueId));
  }
  checkinPlanChanged.emit(plan);
  return plan;
}

/** Fires after my check-in's plan changes (the card, the island and the court page reread). */
export const checkinPlanChanged = createSignal<CheckinPlan>();

// ── Others' view ────────────────────────────────────────────────────────────
/** "· 4 open to play" for one court (venue_open_to_play). */
export async function getOpenToPlay(venueId: string): Promise<number> {
  const rows = ((await sbCall(() => supabase.rpc('venue_open_to_play', { p_venue_ids: [venueId] }), BOUND)) ?? []) as {
    venue_id: string;
    open_now: number;
  }[];
  const row = rows.find((r) => r.venue_id === venueId) ?? rows[0];
  return Math.max(0, Math.floor(Number(row?.open_now) || 0));
}

/** One court's play modes: counts, and a mode line per row I see by name (and my own). */
export async function getCourtPlayModes(venueId: string): Promise<CourtPlayModes> {
  return parseCourtPlayModes(await sbCall(() => supabase.rpc('court_play_modes', { p_venue: venueId }), BOUND));
}
