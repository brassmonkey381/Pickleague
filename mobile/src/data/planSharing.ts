// Plan sharing (supabase/migration_plan_sharing.sql, foundation `/plans`):
// the only path to set_court_plan_shared and list_friend_court_plans, the
// daily gate, and the adapter the foundation's daily confirm sheet drives
// over my routine RPCs (data/courtRoutines). Confirm and set_auto_share_routines
// live in data/courtRoutines (they answer with my routines / their settings).
// Rules and copy: lib/planSharing.ts.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { DAY_MS, cachedFetch, peekQuery, setQueryData } from '@just-messin-around/expo-foundation/cache';
import { createDailyGate } from '@just-messin-around/expo-foundation/plans';
import type { PlanConfirmAdapter, PlanShareSource } from '@just-messin-around/expo-foundation/plans/rules';
import { supabase } from '../lib/supabase';
import { asShareSource, type CourtRoutine } from '../lib/courtRoutineRules';
import type { CourtPlan } from '../lib/courtPlans';
import {
  parseFriendCourtPlans,
  routineOccurrences,
  type CourtStopExtras,
  type FriendCourtPlan,
} from '../lib/planSharing';
import {
  MY_COURT_ROUTINES_KEY,
  confirmCourtPlans,
  courtRoutinesChanged,
  loadMyCourtRoutines,
  moveRoutineOccurrence,
  skipRoutineOccurrence,
  unskipRoutineOccurrence,
} from './courtRoutines';
import { MY_COURT_PLANS_KEY, courtPlansChanged } from './courtPlans';

export type { FriendCourtPlan };

const BOUND = { timeoutMs: 9_000 };

/** "Shown today" for Home's daily prompts (the foundation writes only under this key). */
export const PL_DAILY_GATE = createDailyGate({ storageKey: 'pickleague.dailyPrompts' });

/** The daily confirm sheet's adapter: every write answers with my routines. */
export const plConfirmAdapter: PlanConfirmAdapter<CourtStopExtras> = {
  listMine: async ({ force }) => routineOccurrences(await loadMyCourtRoutines(force)),
  confirm: async (ids) => routineOccurrences(await confirmCourtPlans(ids)),
  skip: async (id) => routineOccurrences(await skipRoutineOccurrence(id)),
  move: async (id, at) => routineOccurrences(await moveRoutineOccurrence(id, at)),
  unskip: async (id) => routineOccurrences(await unskipRoutineOccurrence(id)),
};

// ── Shared / Only you on one of my plans ────────────────────────────────────
export type PlanShareAnswer = { planId: string; kind: 'once' | 'routine'; sharedAt: string | null; shareSource: PlanShareSource | null };

function patchRoutines(a: PlanShareAnswer): boolean {
  const list = peekQuery<CourtRoutine[]>(MY_COURT_ROUTINES_KEY);
  if (!list) return false;
  let hit = false;
  const patch = <O extends { planId: string }>(o: O): O => {
    if (o.planId !== a.planId) return o;
    hit = true;
    return { ...o, sharedAt: a.sharedAt, shareSource: a.shareSource };
  };
  const next = list.map((r) => ({ ...r, next: r.next ? patch(r.next) : null, occurrences: r.occurrences.map(patch) }));
  if (hit) {
    setQueryData(MY_COURT_ROUTINES_KEY, next);
    courtRoutinesChanged.emit();
  }
  return hit;
}

function patchPlans(a: PlanShareAnswer): boolean {
  const list = peekQuery<CourtPlan[]>(MY_COURT_PLANS_KEY);
  if (!list || !list.some((p) => p.planId === a.planId)) return false;
  const next = list.map((p) => (p.planId === a.planId ? { ...p, sharedAt: a.sharedAt, shareSource: a.shareSource } : p));
  setQueryData(MY_COURT_PLANS_KEY, next);
  courtPlansChanged.emit(next);
  return true;
}

/**
 * A plan's Shared / Only you (set_court_plan_shared), then the cached row of
 * mine it names is patched (my routines or my one-off plans). Refusals:
 * plan.gone (a routine stop that is over), visit.gone (a one-off), request.bad.
 */
export async function setCourtPlanShared(planId: string, shared: boolean): Promise<PlanShareAnswer> {
  const r = (await sbCall(() => supabase.rpc('set_court_plan_shared', { p_plan_id: planId, p_shared: shared }), BOUND)) as
    | Record<string, unknown>
    | null;
  const a: PlanShareAnswer = {
    planId: typeof r?.plan_id === 'string' ? r.plan_id : planId,
    kind: r?.kind === 'once' ? 'once' : 'routine',
    sharedAt: typeof r?.shared_at === 'string' ? r.shared_at : null,
    shareSource: asShareSource(r?.share_source),
  };
  if (a.kind === 'once') patchPlans(a) || patchRoutines(a);
  else patchRoutines(a) || patchPlans(a);
  return a;
}

// ── Friends' plans ──────────────────────────────────────────────────────────
/** The feed's: every court, 7 days ahead. */
export const FRIEND_PLANS_KEY = 'friends:courtPlans:v1';
/** One court's page (any row of the facility). */
export const friendPlansAtKey = (venueId: string) => `${FRIEND_PLANS_KEY}:${venueId}`;
export const FRIEND_PLANS_TTL_MS = 2 * 60_000;
export const FRIEND_PLANS_PERSIST_MS = DAY_MS;

/** Raw fetcher: bind screens to this with useCachedQuery. The server applies
 *  each owner's plans level, pause, hide-froms and blocks (contract rule 8). */
export async function fetchFriendCourtPlans(venueId?: string | null): Promise<FriendCourtPlan[]> {
  return parseFriendCourtPlans(
    await sbCall(() => supabase.rpc('list_friend_court_plans', { p_venue: venueId ?? null, p_days: 7 }), BOUND),
  );
}

/** Cached; `force` reads the server now. */
export function loadFriendCourtPlans(venueId?: string | null, force = false): Promise<FriendCourtPlan[]> {
  return cachedFetch(venueId ? friendPlansAtKey(venueId) : FRIEND_PLANS_KEY, () => fetchFriendCourtPlans(venueId), {
    ttlMs: force ? 0 : FRIEND_PLANS_TTL_MS,
    persistMs: FRIEND_PLANS_PERSIST_MS,
  });
}
