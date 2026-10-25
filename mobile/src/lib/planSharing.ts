// Plan sharing, Pickleague's thin side of the foundation's `/plans` module
// (1.70; supabase/migration_plan_sharing.sql is the server half). The
// foundation owns the rules (isShared, needsConfirm, friendPlanLabel), the
// once-a-day gate, the confirm sheet, the Shared / Only you chip and the
// auto-share row; this file maps Pickleague's rows into its shapes and holds
// the words that say "court".
//
//   routineOccurrences   my routines -> PlanOccurrence[] (the daily sheet's list)
//   parseFriendCourtPlans list_friend_court_plans' jsonb -> FriendCourtPlan[]
//   friendPlanLine       "Sky" / "planned 6 PM · routine"
//   PL_*_COPY            the sheet's, the setting's and the plan sheet's words
//
// The user, 2026-10-24: "we never show routines automatically, since people
// may often change their schedules ad hoc, and forget to." A routine stop is
// shared once I confirm it that day (or with "Share my routine stops
// automatically" on); a one-off plan when I make it (Shared by default, the
// plan sheet's chip makes it Only you).
//
// PURE: no React Native, no Supabase. The vitest suite is
// lib/__tests__/planSharing.test.ts.
import {
  friendPlanLabel,
  isShared,
  type AutoShareCopy,
  type DailyPlanConfirmCopy,
  type FriendPlan,
  type PlanOccurrence,
} from '@just-messin-around/expo-foundation/plans/rules';
import type { AbsoluteTimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import type { CourtRoutine, PlayMode } from './courtRoutineRules';
import type { CourtPlan } from './courtPlans';

/** What a routine stop carries besides the foundation's shape (the sheet's row detail reads `windows`). */
export type CourtStopExtras = { venueId: string; routineId: string; windows: AbsoluteTimeWindow<PlayMode>[] };
export type CourtStopOccurrence = PlanOccurrence<CourtStopExtras>;

/**
 * Every occurrence of my routines (`occurrences` and `next`, each once), as
 * the foundation's PlanOccurrence: kind 'routine', the routine's zone, the
 * status as the server has it. The daily sheet's rules pick today's
 * unconfirmed ones (needsConfirm); a dormant routine (its court unstarred)
 * is left out, since friends can't see its stops (contract rule 8).
 */
export function routineOccurrences(routines: readonly CourtRoutine[]): CourtStopOccurrence[] {
  const out: CourtStopOccurrence[] = [];
  const seen = new Set<string>();
  for (const r of routines) {
    if (!r.starred) continue;
    for (const o of [...r.occurrences, ...(r.next ? [r.next] : [])]) {
      if (!o.planId || seen.has(o.planId) || !Number.isFinite(Date.parse(o.plannedAt))) continue;
      seen.add(o.planId);
      out.push({
        id: o.planId,
        placeId: r.venueId,
        placeName: r.venueName,
        at: o.plannedAt,
        endAt: o.plannedEndAt,
        kind: 'routine',
        status: o.status,
        sharedAt: o.sharedAt,
        shareSource: o.shareSource,
        tz: r.tz || null,
        routineId: r.id,
        venueId: r.venueId,
        windows: o.windows,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether a routine stop of mine is shared, or will be once the server
 *  answers (auto-share on predicts it: foundation isShared). */
export function stopIsShared(
  o: Pick<CourtRoutine['occurrences'][number], 'status' | 'sharedAt' | 'shareSource'>,
  autoShare: boolean | null | undefined,
): boolean {
  return isShared({ kind: 'routine', status: o.status, sharedAt: o.sharedAt, shareSource: o.shareSource }, { autoShare: autoShare ?? null });
}

/** Whether a one-off plan of mine is shared. */
export function planIsShared(p: Pick<CourtPlan, 'status' | 'sharedAt' | 'shareSource'>): boolean {
  return isShared({ kind: 'once', status: p.status, sharedAt: p.sharedAt, shareSource: p.shareSource });
}

// ── Friends' plans ─────────────────────────────────────────────────────────
export type FriendCourtPlanExtras = {
  avatarUrl: string | null;
  avatarEmoji: string | null;
  avatarBgColor: string | null;
  /** An accepted friend (a closed-league mate the owner lets see plans is not). */
  isFriend: boolean;
  isCloseFriend: boolean;
  lat: number | null;
  lng: number | null;
};
export type FriendCourtPlan = FriendPlan<FriendCourtPlanExtras>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** list_friend_court_plans' jsonb, defensively: rows without an id, owner, court or time are dropped. */
export function parseFriendCourtPlans(data: unknown): FriendCourtPlan[] {
  if (!Array.isArray(data)) return [];
  const out: FriendCourtPlan[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const planId = str(r?.plan_id);
    const ownerId = str(r?.user_id);
    const placeId = str(r?.venue_id);
    const at = str(r?.planned_at);
    if (!r || !planId || !ownerId || !placeId || !at || !Number.isFinite(Date.parse(at)) || seen.has(planId)) continue;
    seen.add(planId);
    const end = str(r.planned_end_at);
    out.push({
      planId,
      ownerId,
      ownerName: str(r.full_name)?.trim() || 'Player',
      placeId,
      placeName: str(r.venue_name)?.trim() || 'A court',
      at,
      endAt: end && Number.isFinite(Date.parse(end)) ? end : null,
      kind: r.kind === 'routine' ? 'routine' : 'once',
      avatarUrl: str(r.avatar_url),
      avatarEmoji: str(r.avatar_emoji),
      avatarBgColor: str(r.avatar_bg_color),
      isFriend: r.is_friend === true,
      isCloseFriend: r.is_close_friend === true,
      lat: num(r.lat),
      lng: num(r.lng),
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.planId < b.planId ? -1 : 1));
}

/** A friend's plan as a feed line says it: title "Sky", meta "planned 6 PM · routine". */
export function friendPlanLine(p: Pick<FriendCourtPlan, 'ownerName' | 'at' | 'kind'>, now: number): { title: string; meta: string; a11y: string } {
  const label = friendPlanLabel(p, now);
  return {
    title: p.ownerName,
    meta: label.routineTag ? `${label.text} · ${label.routineTag}` : label.text,
    a11y: `${p.ownerName}, ${label.a11y}`,
  };
}

// ── Copy ────────────────────────────────────────────────────────────────────
/** The daily confirm sheet on Home (foundation defaults for the rest). */
export const PL_DAILY_CONFIRM_COPY: Partial<DailyPlanConfirmCopy> = {
  placeNoun: 'court',
  title: "Today's routine",
  intro: (n) =>
    n === 1 ? 'Your friends see this stop once you confirm it.' : 'Your friends see these stops once you confirm them.',
  skippedLine: 'Skipped today',
  footnote: 'Turn on "Share my routine stops automatically" in Settings to skip this.',
};

/** Settings > Check-in automation and My routine. */
export const PL_AUTO_SHARE_COPY: AutoShareCopy = {
  label: 'Share my routine stops automatically',
  hint:
    "On: friends who can see your plans see each routine stop as soon as it's planned. Off: you confirm each day's stops first, the first time you open Pickleague that day.",
};

/** The plan sheet's line under the time (plans shared or not). */
export function planSheetShareHint(shared: boolean): string {
  return shared ? 'Friends who can see your plans see it.' : 'Only you see this planned check-in.';
}

/** The toast after a Shared / Only you change. */
export function shareToggledMessage(shared: boolean, kind: 'once' | 'routine'): string {
  if (shared) return kind === 'routine' ? 'Shared this stop with your friends.' : 'Shared this check-in with your friends.';
  return kind === 'routine' ? 'Only you see this stop now.' : 'Only you see this check-in now.';
}

/** The toast after the auto-share switch. */
export function autoShareToggledMessage(on: boolean): string {
  return on ? 'Routine stops shared automatically' : "You'll confirm each day's stops";
}
