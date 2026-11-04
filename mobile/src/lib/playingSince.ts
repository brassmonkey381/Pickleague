// When a player started playing pickleball (profiles.playing_since, the first
// of a month; migration_profile_playing_since.sql), as the Profile player
// card's "SINCE MAR 2021". Not when they joined Pickleague.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Pickleball was invented in 1965: the earliest year the server takes. */
export const FIRST_YEAR = 1965;

/** { year, month 0-11 } from a 'YYYY-MM-DD' date, or null. */
export function parseSince(raw: string | null | undefined): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})/.exec(raw ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return month >= 0 && month < 12 ? { year, month } : null;
}

/** "SINCE MAR 2021", or null when not set. */
export function sinceLabel(raw: string | null | undefined): string | null {
  const p = parseSince(raw);
  return p ? `SINCE ${MONTHS[p.month].toUpperCase()} ${p.year}` : null;
}

/** 'YYYY-MM-01' for the server. */
export function sinceDate(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** Years to pick from, newest first: this year down to 1965. */
export function sinceYears(now: Date = new Date()): number[] {
  const out: number[] = [];
  for (let y = now.getFullYear(); y >= FIRST_YEAR; y--) out.push(y);
  return out;
}

/** Whether a month is pickable: not after this month. */
export function monthAllowed(year: number, month: number, now: Date = new Date()): boolean {
  return year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth());
}
