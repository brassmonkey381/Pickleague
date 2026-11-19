// What each match calendar shows (PKL-051, Brian 2026-11-19: "calendar can
// show everything" ... "think of the appropriate calendar surface for each
// thing ... or have filters").
//
// The match calendar (CalendarAnalyticsView) appears in three places:
//   - Me > Play history > Calendar (my own, every league): everything I do, so
//     completed matches, upcoming matches, league events, drills and court
//     check-ins (play sessions), with a filter chip per kind.
//   - A league's History > Calendar: that league's life, so its completed and
//     upcoming matches and its events. Drills and check-ins are personal and
//     not league business.
//   - Someone else's match history > Calendar: their match results only; their
//     drills, check-ins and plans are theirs.
// Home's Up next stays the week agenda and the Pickle calendar stays pickles.
//
// PURE: no React, no Supabase. The screen loads rows and maps them to CalItem.

export type CalKind = 'matches' | 'upcoming' | 'events' | 'drills' | 'play';

export const CAL_KIND_LABEL: Record<CalKind, string> = {
  matches: 'Results',
  upcoming: 'Upcoming',
  events: 'Events',
  drills: 'Drills',
  play: 'Check-ins',
};

/** The kinds a calendar offers, in chip order. */
export function calendarKinds(opts: { own: boolean; leagueId?: string | null }): CalKind[] {
  if (opts.leagueId) return ['matches', 'upcoming', 'events'];
  if (opts.own) return ['matches', 'upcoming', 'events', 'drills', 'play'];
  return ['matches'];
}

/** One non-result entry on a calendar day. */
export type CalItem = {
  id: string;
  kind: Exclude<CalKind, 'matches'>;
  /** ISO start time. */
  at: string;
  title: string;
  /** Second line: court, league, length. */
  sub?: string | null;
  /** League events open their page. */
  eventId?: string;
};

/** Items by the device's calendar day (YYYY-MM-DD), each day in time order. */
export function itemsByDay(items: readonly CalItem[], dayOf: (d: Date) => string): Record<string, CalItem[]> {
  const out: Record<string, CalItem[]> = {};
  for (const it of items) {
    const t = new Date(it.at);
    if (Number.isNaN(t.getTime())) continue;
    (out[dayOf(t)] ??= []).push(it);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  return out;
}

/** "45 min", "1 h", "1 h 30 min" between two ISO times, or null. */
export function lengthText(startIso: string, endIso: string | null | undefined): string | null {
  if (!endIso) return null;
  const mins = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}
