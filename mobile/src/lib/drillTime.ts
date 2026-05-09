// Drill availability is stored as { 'YYYY-MM-DD': boolean[48] }
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
