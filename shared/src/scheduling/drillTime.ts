// Slot-based scheduling stored as { 'YYYY-MM-DD': boolean[48] }
// The grid renders 7 days starting from today (local time).

export const DRILL_SLOTS_PER_DAY = 48;
export const DRILL_DAYS_VISIBLE  = 7;

export type DrillAvailability = Record<string, boolean[]>;
export type DrillSlot = { date: string; slot: number };

/** Returns 'YYYY-MM-DD' for a JS Date in local time. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today + next 6 days as ISO date strings, oldest first. */
export function rollingDates(now: Date = new Date()): string[] {
  const out: string[] = [];
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < DRILL_DAYS_VISIBLE; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push(isoDate(d));
  }
  return out;
}

/** Short label for a date column, e.g. "Tue 5/7". Today shows "Today". */
export function dateLabel(iso: string, now: Date = new Date()): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (date.getTime() === today.getTime())    return 'Today';
  if (date.getTime() === tomorrow.getTime()) return 'Tmrw';
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

/** Sub-label like "5/7" for the secondary line. */
export function dateSubLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
}

/** slot 0 = 12:00am, slot 1 = 12:30am, ... slot 47 = 11:30pm */
export function slotLabel(slot: number): string {
  const h    = Math.floor(slot / 2);
  const half = slot % 2 !== 0;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return half ? `${h12}:30${ampm}` : `${h12}${ampm}`;
}

/** Full label including date + time, e.g. "Tue 5/7 · 6:30pm". */
export function slotFullLabel(s: DrillSlot): string {
  return `${dateLabel(s.date)} ${dateSubLabel(s.date)} · ${slotLabel(s.slot)}`;
}

/** "6:00pm – 7:00pm" given a starting slot and a length in minutes. */
export function slotRangeLabel(startSlot: number, lengthMinutes: number): string {
  const endSlot = Math.min(48, startSlot + Math.ceil(lengthMinutes / 30));
  // slotLabel(48) would say "12pm" wrongly — special-case midnight wrap.
  const endLabel = endSlot >= 48 ? '12am' : slotLabel(endSlot);
  return `${slotLabel(startSlot)} – ${endLabel}`;
}

/** Human label for a duration in minutes, e.g. "1h" or "1h 30m". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Convert a JS Date + length in hours into one or more `{date, slot, length_minutes}`
 *  overlays — splitting at midnight so multi-day events paint each day correctly. */
export function spanToDailyOverlays(
  start: Date,
  lengthHours: number,
): { date: string; slot: number; length_minutes: number }[] {
  const out: { date: string; slot: number; length_minutes: number }[] = [];
  let remainingMin = Math.max(30, Math.round(lengthHours * 60));
  let cur = new Date(start);

  while (remainingMin > 0) {
    const date = isoDate(cur);
    const slot = cur.getHours() * 2 + (cur.getMinutes() >= 30 ? 1 : 0);
    const minutesAvailableToday = (DRILL_SLOTS_PER_DAY - slot) * 30;
    if (minutesAvailableToday <= 0) break;
    const chunk = Math.min(remainingMin, minutesAvailableToday);
    out.push({ date, slot, length_minutes: chunk });
    remainingMin -= chunk;
    // Jump to next day at midnight, local time.
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, 0, 0, 0);
  }
  return out;
}

/** Strip stale dates (anything before today). */
export function pruneStale(av: DrillAvailability, now: Date = new Date()): DrillAvailability {
  const today = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const out: DrillAvailability = {};
  for (const [date, slots] of Object.entries(av)) {
    if (date >= today) out[date] = slots;
  }
  return out;
}

/** Empty 48-slot row. */
export function emptyDay(): boolean[] {
  return Array(DRILL_SLOTS_PER_DAY).fill(false);
}

/** Get slots for a date (returns empty array if missing). */
export function slotsFor(av: DrillAvailability, date: string): boolean[] {
  const arr = av[date];
  if (Array.isArray(arr) && arr.length === DRILL_SLOTS_PER_DAY) return arr;
  return emptyDay();
}

/** Mutate a date's slot — returns a new availability object. */
export function setSlot(
  av: DrillAvailability, date: string, slot: number, value: boolean
): DrillAvailability {
  const day = slotsFor(av, date).slice();
  day[slot] = value;
  return { ...av, [date]: day };
}

/** Total available half-hour slots across the rolling window. */
export function totalSlots(av: DrillAvailability): number {
  let n = 0;
  for (const arr of Object.values(av)) n += arr.filter(Boolean).length;
  return n;
}

/** Half-hour slots in common between two drill schedules within the rolling window. */
export function overlapSlots(
  a: DrillAvailability, b: DrillAvailability, dates?: string[]
): DrillSlot[] {
  const ds = dates ?? rollingDates();
  const out: DrillSlot[] = [];
  for (const date of ds) {
    const aDay = slotsFor(a, date);
    const bDay = slotsFor(b, date);
    for (let s = 0; s < DRILL_SLOTS_PER_DAY; s++) {
      if (aDay[s] && bDay[s]) out.push({ date, slot: s });
    }
  }
  return out;
}

// ── Recurring weekly template ─────────────────────────────────────────
// Drill availability is stored as a recurring weekly template: boolean[336]
// (7 weekdays × 48 half-hour slots, weekday 0=Mon..6=Sun — matching the
// profile availability grid). Specific calendar dates are derived on demand
// by expanding the template over the rolling 7-day window, so the request /
// session / matching flow stays date-specific while the user only edits a
// single repeating weekly schedule.

export const DRILL_WEEKLY_CELLS = 7 * DRILL_SLOTS_PER_DAY; // 336

/** Weekday index for an ISO 'YYYY-MM-DD' string: 0=Mon .. 6=Sun. */
export function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const js = new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat (local)
  return (js + 6) % 7;                        // shift to 0=Mon..6=Sun
}

/** Flat index into a weekly template for (weekday 0=Mon..6=Sun, slot 0..47). */
export function weeklyIdx(day: number, slot: number): number {
  return day * DRILL_SLOTS_PER_DAY + slot;
}

/** Expand a recurring weekly template into a date-keyed DrillAvailability over
 *  the given dates (default: rolling next-7-days). Used so partner matching and
 *  drill-request proposals stay keyed to concrete calendar dates. */
export function expandWeeklyToDates(
  weekly: boolean[], dates: string[] = rollingDates(),
): DrillAvailability {
  const out: DrillAvailability = {};
  if (!Array.isArray(weekly) || weekly.length !== DRILL_WEEKLY_CELLS) return out;
  for (const date of dates) {
    const wd  = isoWeekday(date);
    const day = emptyDay();
    for (let s = 0; s < DRILL_SLOTS_PER_DAY; s++) day[s] = !!weekly[weeklyIdx(wd, s)];
    out[date] = day;
  }
  return out;
}

/** Best-effort convert legacy date-keyed availability into a recurring weekly
 *  template by OR-merging each date's slots onto its weekday. */
export function dateKeyedToWeekly(av: DrillAvailability): boolean[] {
  const weekly = Array(DRILL_WEEKLY_CELLS).fill(false) as boolean[];
  for (const [date, slots] of Object.entries(av ?? {})) {
    if (!Array.isArray(slots)) continue;
    const wd = isoWeekday(date);
    for (let s = 0; s < DRILL_SLOTS_PER_DAY && s < slots.length; s++) {
      if (slots[s]) weekly[weeklyIdx(wd, s)] = true;
    }
  }
  return weekly;
}

/** Normalize a raw stored value into a weekly boolean[336] template.
 *    - boolean[336]             → used as-is (copied)
 *    - legacy date-keyed object → best-effort converted (OR-merged by weekday)
 *    - anything else            → empty template */
export function toWeeklyDrill(raw: unknown): boolean[] {
  if (Array.isArray(raw) && raw.length === DRILL_WEEKLY_CELLS) return raw.map(Boolean);
  if (raw && typeof raw === 'object') return dateKeyedToWeekly(raw as DrillAvailability);
  return Array(DRILL_WEEKLY_CELLS).fill(false);
}

/** Total available half-hour slots in a weekly template. */
export function totalWeeklySlots(weekly: boolean[]): number {
  return Array.isArray(weekly) ? weekly.filter(Boolean).length : 0;
}

/** Group consecutive slots into ranges for display. */
export function rangesFor(slots: number[]): string[] {
  if (slots.length === 0) return [];
  const sorted = [...slots].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev  = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
    ranges.push(`${slotLabel(start)}–${slotLabel(prev + 1)}`);
    start = sorted[i];
    prev  = sorted[i];
  }
  ranges.push(`${slotLabel(start)}–${slotLabel(prev + 1)}`);
  return ranges;
}
