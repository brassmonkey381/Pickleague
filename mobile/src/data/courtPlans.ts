// One-off planned check-ins (supabase/migration_court_oneoff_plans.sql): the
// only path to plan_court_checkin, move_court_plan, cancel_court_plan and
// list_my_court_plans. Every write answers with the full list, which goes
// straight into the cache (the feed's court cards read it). Rules and copy:
// lib/courtPlans.ts.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { DAY_MS, cachedFetch, setQueryData } from '@just-messin-around/expo-foundation/cache';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import { supabase } from '../lib/supabase';
import { parseCourtPlans, type CourtPlan } from '../lib/courtPlans';
import { PLAN_SHARING_ENABLED } from '../lib/features';

export type { CourtPlan };

export const MY_COURT_PLANS_KEY = 'me:courtPlans:v1';
/** Doggle's 5 minutes fresh; a day on disk (the feed shows them offline). */
export const MY_COURT_PLANS_TTL_MS = 5 * 60_000;
export const MY_COURT_PLANS_PERSIST_MS = DAY_MS;

const BOUND = { timeoutMs: 9_000 };

/** Fires after my plans change (a plan, a move, a cancel). */
export const courtPlansChanged = createSignal<CourtPlan[]>();

/** Raw fetcher: bind screens to this with useCachedQuery. */
export async function fetchMyCourtPlans(): Promise<CourtPlan[]> {
  return parseCourtPlans(await sbCall(() => supabase.rpc('list_my_court_plans'), BOUND));
}

/** Cached list; `force` reads the server now. */
export function loadMyCourtPlans(force = false): Promise<CourtPlan[]> {
  return cachedFetch(MY_COURT_PLANS_KEY, fetchMyCourtPlans, {
    ttlMs: force ? 0 : MY_COURT_PLANS_TTL_MS,
    persistMs: MY_COURT_PLANS_PERSIST_MS,
  });
}

function stored(data: unknown): CourtPlan[] {
  const list = parseCourtPlans(data);
  setQueryData(MY_COURT_PLANS_KEY, list);
  courtPlansChanged.emit(list);
  return list;
}

/**
 * "Plan a check-in for later" at a court (any court; the server takes the
 * facility). Refusals (lib/refusals): court.gone, visit.bad_time,
 * visit.too_far, visit.bad_length, visit.limit, visit.taken.
 *
 * Plan sharing: `share` (default true: Shared) goes as p_share only with
 * PLAN_SHARING_ENABLED, so with it off the key is absent and the server
 * keeps the plan private (migration_plan_sharing.sql's default).
 */
export async function planCourtCheckin(venueId: string, at: Date, opts?: { share?: boolean }): Promise<CourtPlan[]> {
  const args: Record<string, unknown> = { p_venue: venueId, p_at: at.toISOString() };
  if (PLAN_SHARING_ENABLED) args.p_share = opts?.share ?? true;
  return stored(await sbCall(() => supabase.rpc('plan_court_checkin', args), BOUND));
}

/** "Change time". Refusals: visit.gone, visit.bad_time, visit.too_far, visit.taken. */
export async function moveCourtPlan(planId: string, at: Date): Promise<CourtPlan[]> {
  return stored(await sbCall(() => supabase.rpc('move_court_plan', { p_plan_id: planId, p_at: at.toISOString() }), BOUND));
}

/** "Cancel this visit". Refusal: visit.gone. */
export async function cancelCourtPlan(planId: string): Promise<CourtPlan[]> {
  return stored(await sbCall(() => supabase.rpc('cancel_court_plan', { p_plan_id: planId }), BOUND));
}
