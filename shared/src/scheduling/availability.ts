export const AVAIL_DAYS   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const SLOTS_PER_DAY = 48;
export const TOTAL_CELLS   = AVAIL_DAYS.length * SLOTS_PER_DAY; // 336

export function cellIdx(day: number, slot: number): number {
  return day * SLOTS_PER_DAY + slot;
}

/** slot 0 = 12:00am, slot 1 = 12:30am, ... slot 47 = 11:30pm */
export function slotLabel(slot: number): string {
  const h    = Math.floor(slot / 2);
  const half = slot % 2 !== 0;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return half ? `${h12}:30${ampm}` : `${h12}${ampm}`;
}

/** Convert a JS Date (local time) to (dayIndex 0=Mon, slotIndex) */
export function dateToSlot(date: Date): { day: number; slot: number } {
  const jsDay = date.getDay(); // 0=Sun..6=Sat
  const day   = (jsDay + 6) % 7; // shift to 0=Mon..6=Sun
  const slot  = Math.floor((date.getHours() * 60 + date.getMinutes()) / 30);
  return { day, slot };
}

/** True if the user is available starting at `date` for `durationSlots` half-hour blocks */
export function isAvailableAt(av: boolean[], date: Date, durationSlots = 1): boolean {
  if (av.length !== TOTAL_CELLS) return false;
  const { day, slot } = dateToSlot(date);
  for (let i = 0; i < durationSlots; i++) {
    const s = slot + i;
    if (s >= SLOTS_PER_DAY) break;
    if (!av[cellIdx(day, s)]) return false;
  }
  return true;
}

/** Number of half-hour slots available in both schedules */
export function availabilityOverlap(a: boolean[], b: boolean[]): number {
  if (a.length !== TOTAL_CELLS || b.length !== TOTAL_CELLS) return 0;
  let count = 0;
  for (let i = 0; i < TOTAL_CELLS; i++) if (a[i] && b[i]) count++;
  return count;
}

/** Total available half-hour slots */
export function totalAvailableSlots(av: boolean[]): number {
  return av.filter(Boolean).length;
}

/** Compact multi-line summary: "Mon: 9am–11am, 2pm–4pm\nFri: 6pm–9pm" */
export function formatAvailabilitySummary(av: boolean[]): string {
  if (av.length !== TOTAL_CELLS) return 'No availability set';
  const lines: string[] = [];
  for (let d = 0; d < 7; d++) {
    const ranges: string[] = [];
    let start: number | null = null;
    for (let s = 0; s <= SLOTS_PER_DAY; s++) {
      const on = s < SLOTS_PER_DAY && (av[cellIdx(d, s)] ?? false);
      if (on && start === null) {
        start = s;
      } else if (!on && start !== null) {
        ranges.push(`${slotLabel(start)}–${slotLabel(s)}`);
        start = null;
      }
    }
    if (ranges.length > 0) lines.push(`${AVAIL_DAYS[d]}: ${ranges.join(', ')}`);
  }
  const hrs = ((av.filter(Boolean).length) * 0.5).toFixed(1).replace(/\.0$/, '');
  return lines.length === 0 ? 'No availability set' : `${hrs}h/week\n${lines.join('\n')}`;
}
