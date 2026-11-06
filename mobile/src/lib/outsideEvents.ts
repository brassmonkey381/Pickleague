// Outside events (supabase/migration_outside_events.sql; kit 1.108
// /outsideEvents): real pickleball events other people organize, shown "via
// <source>" with a link to the original. PURE: the row shape, its normalizer,
// Pickleague's copy and the court badges. The kit's rules are bound here with
// Pickleague's name, so screens import from one place.
//
//   Saturday open play                              (Interested)
//   Sat, 9 AM to 11 AM, Ocean View Park
//   via City of Albany   Open play, Social
//
// A row carries source: 'external' (the server's rows don't: every row is
// outside), so the kit's isOutsideEvent / viaLabel work on it unchanged.
import {
  createOutsideSeenStore,
  hiddenReasonCopy as kitHiddenReasonCopy,
  outsideEventNote,
  outsideHiddenReasons,
  type OutsideReportReason,
} from '@just-messin-around/expo-foundation/outsideEvents/rules';
import { dayLabel } from './agenda';
import { clockLabel } from './courtRoutineRules';

export const APP_NAME = 'Pickleague';

export const OUTSIDE_EVENT_KINDS = ['open_play', 'round_robin', 'clinic', 'ladder', 'tournament', 'social'] as const;
export type OutsideEventKind = (typeof OUTSIDE_EVENT_KINDS)[number];

const KIND_LABELS: Record<OutsideEventKind, string> = {
  open_play: 'Open play',
  round_robin: 'Round robin',
  clinic: 'Clinic',
  ladder: 'Ladder',
  tournament: 'Tournament',
  social: 'Social',
};

export function kindLabel(k: string): string {
  return KIND_LABELS[k as OutsideEventKind] ?? k.replace(/_/g, ' ');
}

/** The Events screen's kind chips, in this order. */
export const KIND_FILTERS: { key: OutsideEventKind; label: string }[] = OUTSIDE_EVENT_KINDS.map((k) => ({
  key: k,
  label: KIND_LABELS[k],
}));

export type RsvpStatus = 'going' | 'maybe';

export type OutsideEvent = {
  id: string;
  /** Always 'external' (for the kit's isOutsideEvent / viaLabel). */
  source: 'external';
  title: string;
  starts_at: string;
  ends_at: string | null;
  kinds: OutsideEventKind[];
  summary: string | null;
  organizer_name: string | null;
  source_name: string;
  source_url: string;
  place_name: string | null;
  place_address: string | null;
  venue_id: string | null;
  venue_name: string | null;
  lat: number | null;
  lng: number | null;
  last_verified_at: string | null;
  going_count: number;
  interested_count: number;
  my_status: RsvpStatus | null;
  my_report: OutsideReportReason | null;
  seen: boolean;
  hidden_reason: string | null;
  past: boolean;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const REPORTS: readonly string[] = ['cancelled', 'wrong_time', 'wrong_place'];

/** One server row, or null when it lacks what every screen needs. */
export function outsideEventFromRpc(raw: unknown): OutsideEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  const startsAt = str(r.starts_at);
  const url = str(r.source_url);
  if (!id || !title || !startsAt || !url) return null;
  const kinds = (Array.isArray(r.kinds) ? r.kinds : []).filter((k): k is OutsideEventKind =>
    (OUTSIDE_EVENT_KINDS as readonly unknown[]).includes(k),
  );
  const my = r.my_status === 'going' || r.my_status === 'maybe' ? r.my_status : null;
  const report = typeof r.my_report === 'string' && REPORTS.includes(r.my_report) ? (r.my_report as OutsideReportReason) : null;
  return {
    id,
    source: 'external',
    title,
    starts_at: startsAt,
    ends_at: str(r.ends_at),
    kinds,
    summary: str(r.summary),
    organizer_name: str(r.organizer_name),
    source_name: str(r.source_name) ?? 'another organizer',
    source_url: url,
    place_name: str(r.place_name),
    place_address: str(r.place_address),
    venue_id: str(r.venue_id),
    venue_name: str(r.venue_name),
    lat: num(r.lat),
    lng: num(r.lng),
    last_verified_at: str(r.last_verified_at),
    going_count: num(r.going_count) ?? 0,
    interested_count: num(r.interested_count) ?? 0,
    my_status: my,
    my_report: report,
    seen: r.seen === true,
    hidden_reason: str(r.hidden_reason),
    past: r.past === true,
  };
}

export function outsideEventsFromRpc(raw: unknown): OutsideEvent[] {
  return (Array.isArray(raw) ? raw : []).map(outsideEventFromRpc).filter((e): e is OutsideEvent => e !== null);
}

// ── Copy ────────────────────────────────────────────────────────────────────
export const OUTSIDE_EVENT_NOTE = outsideEventNote(APP_NAME);
export const HIDDEN_REASONS = outsideHiddenReasons(APP_NAME);
export const hiddenReasonCopy = (reason: string | null | undefined) => kitHiddenReasonCopy(reason, { appName: APP_NAME });
export const EVENTS_TITLE = 'Events';
export const EVENTS_INTRO = 'Pickleball events near you, run by clubs, rec centers and other organizers.';
export const EVENTS_EMPTY = {
  title: 'No events near you yet',
  subtitle: 'Events other organizers run near your home location show up here.',
};
export const EVENTS_EMPTY_FILTERED = {
  title: 'No events of that kind',
  subtitle: 'Try another kind, or clear the chips.',
};

/** "Open play, Social". */
export function kindsLine(e: Pick<OutsideEvent, 'kinds'>): string {
  return e.kinds.map(kindLabel).join(', ');
}

/** "Sat, 9 AM to 11 AM" / "Today, 6 PM" / "Nov 22, 9 AM". */
export function whenLine(e: Pick<OutsideEvent, 'starts_at' | 'ends_at'>, nowMs: number = Date.now()): string {
  const start = new Date(e.starts_at);
  if (!Number.isFinite(start.getTime())) return '';
  const day = dayLabel(start, new Date(nowMs));
  const from = clockLabel(start);
  const end = e.ends_at ? new Date(e.ends_at) : null;
  const sameDay = end && Number.isFinite(end.getTime()) && end.toDateString() === start.toDateString();
  return sameDay ? `${day}, ${from} to ${clockLabel(end)}` : `${day}, ${from}`;
}

/** The court's name when pinned, else the organizer's place name. */
export function placeLine(e: Pick<OutsideEvent, 'venue_name' | 'place_name'>): string | null {
  return e.place_name ?? e.venue_name ?? null;
}

/** "3 going, 5 interested" (or null when nobody yet). */
export function countsLine(e: Pick<OutsideEvent, 'going_count' | 'interested_count'>): string | null {
  const parts = [
    e.going_count > 0 ? `${e.going_count} going` : null,
    e.interested_count > 0 ? `${e.interested_count} interested` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Still listed: the server's rule (_pl_outside_event_past), which is stricter
 * than the kit's isOutsideEventCurrent: with an end, until the end; with
 * none, until an hour after the start.
 */
export function isCurrent(e: Pick<OutsideEvent, 'starts_at' | 'ends_at'>, nowMs: number = Date.now()): boolean {
  const start = Date.parse(e.starts_at);
  if (!Number.isFinite(start)) return false;
  if (e.ends_at) {
    const end = Date.parse(e.ends_at);
    return Number.isFinite(end) && end > nowMs;
  }
  return start > nowMs - 60 * 60 * 1000;
}

/** On now: started, not over. */
export function isOnNow(e: Pick<OutsideEvent, 'starts_at' | 'ends_at'>, nowMs: number = Date.now()): boolean {
  return Date.parse(e.starts_at) <= nowMs && isCurrent(e, nowMs);
}

/**
 * A court's events badge: "Event on now", "Event today", "Event Sat" (this
 * week), or null (none in the next 7 days). `events`: that court's listed
 * events, any order.
 */
export function courtEventBadge(
  events: readonly Pick<OutsideEvent, 'starts_at' | 'ends_at'>[],
  nowMs: number = Date.now(),
): { label: string; live: boolean } | null {
  const current = events.filter((e) => isCurrent(e, nowMs));
  if (current.some((e) => isOnNow(e, nowMs))) return { label: 'Event on now', live: true };
  const next = current
    .map((e) => Date.parse(e.starts_at))
    .filter((t) => Number.isFinite(t) && t > nowMs && t < nowMs + 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => a - b)[0];
  if (next == null) return null;
  const day = dayLabel(new Date(next), new Date(nowMs));
  return { label: day === 'Today' ? 'Event today' : day === 'Tmrw' ? 'Event tomorrow' : `Event ${day}`, live: false };
}

/** Listed events grouped by court id (unpinned ones left out). */
export function eventsByCourt(events: readonly OutsideEvent[]): Map<string, OutsideEvent[]> {
  const m = new Map<string, OutsideEvent[]>();
  for (const e of events) {
    if (!e.venue_id) continue;
    const list = m.get(e.venue_id);
    if (list) list.push(e);
    else m.set(e.venue_id, [e]);
  }
  return m;
}

/** The Interested chip's status (the kit says 'interested' for an RSVP maybe). */
export function chipStatus(s: RsvpStatus | null): 'going' | 'interested' | null {
  return s === 'maybe' ? 'interested' : s;
}

export { createOutsideSeenStore };
