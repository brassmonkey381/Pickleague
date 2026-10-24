// One-off planned check-ins (supabase/migration_court_oneoff_plans.sql;
// Doggle's "Plan a check-in for later", schedule_dog_place_checkin): the
// shape list_my_court_plans answers with, the time pickers' slots and the
// words the app says. A plan is kept by a check-in at that court within 30
// minutes either side of its time (as a routine stop), gets the routine
// stop's reminder, and is seen by nobody else.
//
//   Check in ▾ > Plan a check-in for later   today's slots, from the next
//                                            quarter hour to 11:45 PM
//   Tomorrow's Plan ▾                        tomorrow, 6 AM to 11:45 PM
//   The court page's Plan a check-in         any day and time (AppDateTimePicker)
//   A plan's line > Change time              its day, from the next quarter hour
//
// PURE: no React Native, no Supabase. The vitest suite is
// lib/__tests__/courtPlans.test.ts.
import { dayLabel, shortTime } from './agenda';

/** The pickers' step (Doggle's 15-minute slots). */
export const PLAN_SLOT_MS = 15 * 60_000;
/** A plan is still in play this long after its time (_pl_routine_plan_at's window). */
export const PLAN_IN_PLAY_MS = 30 * 60_000;
/** Tomorrow's first slot (Doggle: 6 AM). */
export const TOMORROW_FIRST_HOUR = 6;
/** plan_court_checkin's furthest day (Doggle's 60). */
export const PLAN_MAX_DAYS = 60;
/** The court page's picker starts this far ahead (Doggle: now + 45 min). */
export const PLAN_DEFAULT_AHEAD_MS = 45 * 60_000;

export type CourtPlan = {
  planId: string;
  venueId: string;
  venueName: string;
  lat: number | null;
  lng: number | null;
  plannedAt: string;
  plannedEndAt: string;
  /** 'completed' = a check-in kept it. */
  status: 'planned' | 'completed';
  /** At one of my starred courts (an arrival there keeps it too). */
  starred: boolean;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** list_my_court_plans' jsonb, defensively: rows without an id, court or time are dropped. */
export function parseCourtPlans(data: unknown): CourtPlan[] {
  if (!Array.isArray(data)) return [];
  const out: CourtPlan[] = [];
  for (const raw of data) {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const planId = str(r?.plan_id);
    const venueId = str(r?.venue_id);
    const plannedAt = str(r?.planned_at);
    if (!r || !planId || !venueId || !plannedAt || !Number.isFinite(Date.parse(plannedAt))) continue;
    const end = str(r.planned_end_at);
    out.push({
      planId,
      venueId,
      venueName: str(r.venue_name) ?? 'A court',
      lat: num(r.lat),
      lng: num(r.lng),
      plannedAt,
      plannedEndAt: end && Number.isFinite(Date.parse(end)) ? end : new Date(Date.parse(plannedAt) + 2 * 3_600_000).toISOString(),
      status: r.status === 'completed' ? 'completed' : 'planned',
      starred: r.starred === true,
    });
  }
  return out.sort((a, b) => Date.parse(a.plannedAt) - Date.parse(b.plannedAt));
}

/** Not kept yet and still in play (its time no more than 30 minutes ago): the feed shows it. */
export function planInPlay(p: Pick<CourtPlan, 'status' | 'plannedAt'>, nowMs: number): boolean {
  return p.status === 'planned' && Date.parse(p.plannedAt) > nowMs - PLAN_IN_PLAY_MS;
}

export type PlanSlot = { id: string; name: string };

/** The next quarter hour at least a minute from now (Doggle's next slot). */
export function nextSlotMs(nowMs: number): number {
  return Math.ceil((nowMs + 60_000) / PLAN_SLOT_MS) * PLAN_SLOT_MS;
}

function slotsBetween(fromMs: number, toMs: number): PlanSlot[] {
  const out: PlanSlot[] = [];
  for (let t = fromMs; t <= toMs; t += PLAN_SLOT_MS) {
    const d = new Date(t);
    out.push({ id: d.toISOString(), name: shortTime(d) });
  }
  return out;
}

/** 11:45 PM on the day of `ms` (device zone). */
function lastSlotOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 45, 0, 0);
  return d.getTime();
}

/** "Plan a check-in for later" from Check in ▾: the rest of today, from the next quarter hour. */
export function todayPlanSlots(nowMs: number): PlanSlot[] {
  return slotsBetween(nextSlotMs(nowMs), lastSlotOfDay(nowMs));
}

/** Whether today has a slot left (Check in ▾ only offers to plan then). */
export function canPlanLaterToday(nowMs: number): boolean {
  return nextSlotMs(nowMs) <= lastSlotOfDay(nowMs);
}

/** Tomorrow's Plan ▾: 6 AM to 11:45 PM tomorrow (Doggle). */
export function tomorrowPlanSlots(nowMs: number): PlanSlot[] {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(TOMORROW_FIRST_HOUR, 0, 0, 0);
  return slotsBetween(d.getTime(), lastSlotOfDay(d.getTime()));
}

/** A plan's Change time: its own day, from the next quarter hour (or that
 *  day's start), to 11:45 PM, with its own time in the list. */
export function moveSlots(atIso: string, nowMs: number): PlanSlot[] {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return [];
  const dayStart = new Date(at);
  dayStart.setHours(0, 0, 0, 0);
  const out = slotsBetween(Math.max(dayStart.getTime(), nextSlotMs(nowMs)), lastSlotOfDay(at));
  if (!out.some((s) => Date.parse(s.id) === at)) {
    out.push({ id: new Date(at).toISOString(), name: shortTime(new Date(at)) });
    out.sort((a, b) => Date.parse(a.id) - Date.parse(b.id));
  }
  return out;
}

/** The court page's picker: now + 45 minutes, up to the next quarter hour. */
export function defaultPlanAt(nowMs: number): Date {
  return new Date(Math.ceil((nowMs + PLAN_DEFAULT_AHEAD_MS) / PLAN_SLOT_MS) * PLAN_SLOT_MS);
}

/** Why a picked time can't be planned, in words (the server says the same), or null. */
export function planTimeProblem(at: Date, nowMs: number): string | null {
  const t = at.getTime();
  if (!Number.isFinite(t) || t < nowMs - 60_000) return 'Pick a time later than now for your check-in.';
  if (t > nowMs + PLAN_MAX_DAYS * 24 * 3_600_000) return `You can plan a check-in up to ${PLAN_MAX_DAYS} days ahead. Pick an earlier day.`;
  return null;
}

/** "5:30 PM" today, "tomorrow 5:30 PM", "Sat 5:30 PM", "Nov 2 5:30 PM". */
export function planWhen(atIso: string, nowMs: number): string {
  const d = new Date(Date.parse(atIso));
  const day = dayLabel(d, new Date(nowMs));
  if (day === 'Today') return shortTime(d);
  return `${day === 'Tmrw' ? 'tomorrow' : day} ${shortTime(d)}`;
}

/** The toast after a plan (Doggle's words, no emoji): "Planned a check-in at Lakeside for 5:30 PM." */
export function plannedMessage(venueName: string, atIso: string, nowMs: number): string {
  return `Planned a check-in at ${venueName} for ${planWhen(atIso, nowMs)}.`;
}

/** The toast after Change time. */
export function movedMessage(venueName: string, atIso: string, nowMs: number): string {
  return `Moved your check-in at ${venueName} to ${planWhen(atIso, nowMs)}.`;
}

/** The toast after Cancel this visit. */
export function cancelledMessage(venueName: string): string {
  return `Cancelled your check-in at ${venueName}.`;
}

/** The pickers' titles (Doggle's). */
export function planPickerTitle(venueName: string, day: 'today' | 'tomorrow'): string {
  return day === 'tomorrow' ? `Check in at ${venueName} tomorrow at` : `Check in at ${venueName} at`;
}
