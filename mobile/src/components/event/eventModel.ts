// Pure event-state helpers shared by the Events list and EventDetail: which
// lifecycle bucket an event is in, what the viewer has answered, the status
// label, and the list's date order + filter chips. No React / React Native
// imports, so vitest can exercise it (components/event/__tests__).
import type { LeagueEvent } from '../../types';

/** Once a confirmed slot reaches its start time, the event stays "live" (open
 *  for recording matches) for this long before it rolls over to "past". */
export const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type EventCategory = 'voting_open' | 'vote_closed' | 'scheduled' | 'live' | 'past' | 'cancelled';

type EventCore = Pick<LeagueEvent, 'status' | 'vote_ends_at'>;

// Clock-based detection for any event with a confirmed slot. Applies regardless
// of `status`, so a confirmed event is always categorized by where "now" sits
// relative to its start time (and stale "voting" events that ended up confirmed
// don't get stuck reading "vote closed" forever):
//   • before start                  → scheduled (falls through below)
//   • start ≤ now < start + 24h      → live (open for recording matches)
//   • now ≥ start + 24h              → past
export function categorizeEvent(event: EventCore, confirmedStartsAt: string | null, now = Date.now()): EventCategory {
  if (event.status === 'cancelled') return 'cancelled';
  if (confirmedStartsAt) {
    const start = new Date(confirmedStartsAt).getTime();
    if (now >= start + LIVE_WINDOW_MS) return 'past';
    if (now >= start) return 'live';
  }
  if (event.status === 'scheduled') return 'scheduled';
  return new Date(event.vote_ends_at).getTime() > now ? 'voting_open' : 'vote_closed';
}

/**
 * The status pill text. One phrase per state — never "Voting closed · Voting
 * closed" (the old countdown said "Voting closed" again once it ran out), and a
 * cancelled event says Cancelled.
 */
export function eventStatusLabel(category: EventCategory): string {
  switch (category) {
    case 'voting_open': return 'Voting open';
    // status is still 'voting' but the deadline passed: the finalizer hasn't run yet.
    case 'vote_closed': return 'Picking a time';
    case 'scheduled': return 'Confirmed';
    case 'live': return 'Live now';
    case 'past': return 'Past';
    case 'cancelled': return 'Cancelled';
  }
}

export type EventChipTone = 'neutral' | 'brand' | 'success' | 'danger' | 'warning' | 'info';

export function eventStatusTone(category: EventCategory): EventChipTone {
  switch (category) {
    case 'voting_open': return 'brand';
    case 'vote_closed': return 'warning';
    case 'scheduled': return 'info';
    case 'live': return 'danger';
    case 'past': return 'neutral';
    case 'cancelled': return 'neutral';
  }
}

/** "1d 4h left" / "3h 12m left" / null once the deadline has passed. */
export function timeLeftLabel(endsAtIso: string, now = Date.now()): string | null {
  const diff = new Date(endsAtIso).getTime() - now;
  if (!(diff > 0)) return null;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  return `${h}h ${m}m left`;
}

/** What the viewer has answered for one event. */
export type MyEventAnswer = {
  /** Number of proposed times the viewer marked as available. */
  votes: number;
  /** The viewer voted for the confirmed time (= "I'm in"). */
  inConfirmed: boolean;
  /** The viewer said "Can't make it". */
  declined: boolean;
};

export type MyEventState =
  | 'needs_vote'   // voting open, no answer yet
  | 'voted'        // voting open, marked at least one time
  | 'rsvp_needed'  // confirmed + upcoming/live, no answer yet
  | 'in'           // confirmed, "I'm in"
  | 'out'          // said "Can't make it" (either phase)
  | null;          // nothing to say (past, cancelled, closed vote)

/** `rsvpOpen`: the confirmed time has not ended yet (EventDetail's rule). A
 *  live event past its end time no longer asks for an RSVP. */
export function myEventState(
  category: EventCategory,
  a: MyEventAnswer | null | undefined,
  rsvpOpen = true,
): MyEventState {
  const ans = a ?? { votes: 0, inConfirmed: false, declined: false };
  if (category === 'voting_open') {
    if (ans.declined) return 'out';
    return ans.votes > 0 ? 'voted' : 'needs_vote';
  }
  if (category === 'scheduled' || category === 'live') {
    if (ans.inConfirmed) return 'in';
    if (ans.declined) return 'out';
    return rsvpOpen ? 'rsvp_needed' : null;
  }
  return null;
}

/** The row chip for the viewer's own answer (null = no chip). */
export function myEventChip(state: MyEventState): { label: string; tone: EventChipTone } | null {
  switch (state) {
    case 'needs_vote': return { label: 'Vote needed', tone: 'warning' };
    case 'voted': return { label: 'Voted', tone: 'success' };
    case 'rsvp_needed': return { label: 'RSVP', tone: 'info' };
    case 'in': return { label: "You're in", tone: 'success' };
    case 'out': return { label: "Can't make it", tone: 'neutral' };
    default: return null;
  }
}

// ── Events list: date order + chips ─────────────────────────────────────────

export type EventListFilter = 'all' | 'needs_vote' | 'upcoming' | 'past';

export type EventListItem = {
  id: string;
  category: EventCategory;
  myState: MyEventState;
  /** The event's date: the confirmed start, else the earliest proposed time,
   *  else the vote deadline. Null only when nothing is known. */
  dateIso: string | null;
};

export function isUpcoming(category: EventCategory): boolean {
  return category === 'voting_open' || category === 'vote_closed' || category === 'scheduled' || category === 'live';
}

export function matchesEventFilter(item: Pick<EventListItem, 'category' | 'myState'>, f: EventListFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'needs_vote': return item.myState === 'needs_vote';
    case 'upcoming': return isUpcoming(item.category);
    // Ended either way: played, or cancelled.
    case 'past': return !isUpcoming(item.category);
  }
}

export function countEventFilters(items: ReadonlyArray<Pick<EventListItem, 'category' | 'myState'>>): Record<EventListFilter, number> {
  const out: Record<EventListFilter, number> = { all: items.length, needs_vote: 0, upcoming: 0, past: 0 };
  for (const it of items) {
    if (matchesEventFilter(it, 'needs_vote')) out.needs_vote++;
    if (matchesEventFilter(it, 'upcoming')) out.upcoming++;
    if (matchesEventFilter(it, 'past')) out.past++;
  }
  return out;
}

const ts = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

/**
 * Sorted by event date (plan section 5): live first (it's happening now), then
 * the rest of the upcoming events soonest first, then past and cancelled ones
 * newest first. Unknown dates sink to the end of their group. Stable.
 */
export function sortEventsByDate<T extends Pick<EventListItem, 'category' | 'dateIso'>>(items: readonly T[]): T[] {
  const group = (c: EventCategory) => (c === 'live' ? 0 : isUpcoming(c) ? 1 : 2);
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ga = group(a.it.category);
      const gb = group(b.it.category);
      if (ga !== gb) return ga - gb;
      const ta = ts(a.it.dateIso);
      const tb = ts(b.it.dateIso);
      const na = Number.isNaN(ta);
      const nb = Number.isNaN(tb);
      if (na !== nb) return na ? 1 : -1;
      if (!na && ta !== tb) return ga === 2 ? tb - ta : ta - tb;
      return a.i - b.i;
    })
    .map(x => x.it);
}
