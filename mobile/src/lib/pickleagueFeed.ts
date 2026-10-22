// The Pickleague Feed on Home (state/feed-discover-play-plan.md §3 with the
// user's 2026-10-22 decision "One feed, like Doggle"): one untabbed card with
// what needs you pinned on top, then day bands (Today / Tomorrow / Later this
// week). It replaces Home's Up next, Your leagues, Friends at the courts and
// Your courts.
//
// What may appear (the user: "Only show favorited courts, leagues, and friends
// activity there, as well as tournaments we've signed up for"):
//   - my leagues' events and votes, my drill sessions, and the requests that
//     wait on me (match scores to confirm, drill / join / team requests,
//     friend requests): the AgendaItems Home already builds;
//   - tournaments I signed up for (registered, requested, waitlisted) and
//     invites to one (a request of me). Never an open tournament I'm not in;
//   - my starred courts (every star gets a Today and a Tomorrow card, even
//     empty, as in Doggle) and my routine courts (on a day with a stop);
//   - accepted friends at a court (here now, or left earlier today), at any
//     court. Nobody who isn't my friend, and no court that is only "frequent"
//     or a league's home court.
//
// PURE: no React, no Supabase, no clock of its own. The vitest suite is
// lib/__tests__/pickleagueFeed.test.ts.
import { dayBandOf, DAY_BAND_TITLE, type DayBandKey } from '@just-messin-around/expo-foundation/scheduling/dayBands';
import { formatClockTime, formatWeekdayMask } from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import {
  buildAgenda,
  drillAgendaItems,
  eventAgendaItems,
  tournamentAgendaItems,
  type AgendaDrillInput,
  type AgendaEventInput,
  type AgendaItem,
  type AgendaRow,
  type AgendaTournamentInput,
} from './agenda';
import type { CrowdNumbers } from './courtCrowd';
import type { CourtRoutine, PlayMode } from './courtRoutineRules';
import type { AbsoluteTimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import type { FriendAtCourt, FriendsAtCourts } from './friendsAtCourts';

export type { DayBandKey };

/** Needs-you rows shown before "Show N more". */
export const NEEDS_YOU_PREVIEW = 3;
/** A day's league rows shown before "Show N more". */
export const BAND_ROWS_PREVIEW = 4;
/** Lines on one court card before "See all (N more)" (Doggle's cap). */
export const COURT_ROWS_CAP = 6;
/** Court cards in one day (stars and routine stops are never cut, so with 3
 *  stars a day can hold a few more): also the court_play_modes batch. */
export const MAX_FEED_COURTS = 6;
/** A routine stop stays on the feed this long after its time (Doggle's plan grace). */
export const STOP_GRACE_MS = 30 * 60_000;

const DEFAULT_STOP_MIN = 120;

// ── Shapes ───────────────────────────────────────────────────────────────────
export type FeedCourtRef = { venueId: string; venueName: string };

export type FeedPerson = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  avatarEmoji: string | null;
  avatarBgColor: string | null;
  isCloseFriend: boolean;
};

export type FeedRoutineStop = {
  planId: string;
  routineId: string;
  at: string;
  endAt: string;
  /** 'cancelled' = skipped today (shown faded, with Undo). */
  status: 'planned' | 'cancelled';
  windows: AbsoluteTimeWindow<PlayMode>[];
};

export type FeedCourtLine =
  | { kind: 'here'; key: string; person: FeedPerson; at: string; until: string | null; viaSession: boolean }
  | { kind: 'left'; key: string; person: FeedPerson; at: string; endedAt: string }
  | { kind: 'stop'; key: string; stop: FeedRoutineStop };

export type FeedCourtCard = {
  key: string;
  venueId: string;
  venueName: string;
  starred: boolean;
  /** One of my routines stops here (any day). */
  routine: boolean;
  /** In time order: who came and went, who is here, my stops. */
  lines: FeedCourtLine[];
  /** Everyone else checked in there now (anonymous to me). Today only. */
  othersHere: number;
  /** venue_crowd's numbers for my starred courts (friends_at_courts). Today only. */
  crowd: CrowdNumbers | null;
  /** Lines that count toward the band (not skipped stops). */
  count: number;
};

export type FeedDay = {
  key: DayBandKey;
  title: string;
  /** League side, in buildAgenda's order (live first, then by time). */
  rows: AgendaRow[];
  courts: FeedCourtCard[];
  count: number;
};

export type PickleagueFeed = {
  /** Pinned on top, by deadline. */
  needsYou: AgendaRow[];
  days: FeedDay[];
  /** needsYou + every band's count. 0 = nothing going on (the empty state). */
  total: number;
};

export type FeedInput = {
  now: number;
  events: readonly AgendaEventInput[];
  tournaments: readonly AgendaTournamentInput[];
  drills: readonly AgendaDrillInput[];
  /** Requests waiting on me (lib/inboxRequests inboxAgendaItems). */
  requests: readonly AgendaItem[];
  /** Agenda keys shown elsewhere on Home (a live league event's own card). */
  hideKeys?: ReadonlySet<string>;
  starred: readonly FeedCourtRef[];
  routines: readonly CourtRoutine[];
  friendsAtCourts: FriendsAtCourts | null;
  /** My accepted friends. null = not known yet: no friend lines at all. */
  friendIds: ReadonlySet<string> | null;
};

// ── Rules ────────────────────────────────────────────────────────────────────
const ms = (iso: string | null | undefined): number => {
  if (!iso) return NaN;
  return Date.parse(iso);
};

/** Tournaments I signed up for (or was invited to): registered, requested,
 *  waitlisted, an invite. Withdrawn, rejected, declined and finished ones never show. */
export function signedUpTournaments<T extends AgendaTournamentInput>(regs: readonly T[]): T[] {
  return regs.filter(
    (r) =>
      r.status !== 'completed' &&
      r.status !== 'cancelled' &&
      (r.myStatus === 'approved' || r.myStatus === 'pending' || r.myStatus === 'waitlisted'),
  );
}

function person(p: FriendAtCourt): FeedPerson {
  return {
    userId: p.user_id,
    name: p.full_name?.trim() || 'Player',
    avatarUrl: p.avatar_url,
    avatarEmoji: p.avatar_emoji,
    avatarBgColor: p.avatar_bg_color,
    isCloseFriend: p.is_close_friend,
  };
}

/** A routine's occurrence as a feed stop, or null once it is over (its end, or
 *  its time + the grace when it has no end) or checked in already. */
export function routineStopOf(r: CourtRoutine, o: CourtRoutine['occurrences'][number], now: number): FeedRoutineStop | null {
  if (o.status === 'completed') return null;
  const at = ms(o.plannedAt);
  if (!Number.isFinite(at)) return null;
  const endMs = Number.isFinite(ms(o.plannedEndAt)) ? ms(o.plannedEndAt) : at + (r.lengthMin || DEFAULT_STOP_MIN) * 60_000;
  if (Math.max(endMs, at + STOP_GRACE_MS) <= now) return null;
  return {
    planId: o.planId,
    routineId: r.id,
    at: o.plannedAt,
    endAt: new Date(endMs).toISOString(),
    status: o.status === 'cancelled' ? 'cancelled' : 'planned',
    windows: o.windows,
  };
}

const lineTime = (l: FeedCourtLine): number => (l.kind === 'stop' ? ms(l.stop.at) : ms(l.at));
const LINE_ORDER: Record<FeedCourtLine['kind'], number> = { left: 0, here: 1, stop: 2 };

/** Doggle's order: who came and went (by when they left), who is here (by
 *  arrival, close friends first), then what is coming. */
export function sortCourtLines(lines: readonly FeedCourtLine[]): FeedCourtLine[] {
  return [...lines].sort((a, b) => {
    if (a.kind !== b.kind) return LINE_ORDER[a.kind] - LINE_ORDER[b.kind];
    if (a.kind === 'left' && b.kind === 'left') return ms(a.endedAt) - ms(b.endedAt);
    if (a.kind === 'here' && b.kind === 'here' && a.person.isCloseFriend !== b.person.isCloseFriend) {
      return a.person.isCloseFriend ? -1 : 1;
    }
    return lineTime(a) - lineTime(b);
  });
}

/** Over the cap, the oldest finished visits give way first (what's next
 *  matters more); "See all" shows the rest. */
export function capCourtLines(lines: readonly FeedCourtLine[], cap = COURT_ROWS_CAP): { shown: FeedCourtLine[]; more: number } {
  if (lines.length <= cap) return { shown: [...lines], more: 0 };
  let drop = lines.length - cap;
  const kept = lines.filter((l) => {
    if (drop > 0 && l.kind === 'left') {
      drop -= 1;
      return false;
    }
    return true;
  });
  const shown = kept.slice(0, cap);
  return { shown, more: lines.length - shown.length };
}

/** The first `n` rows, or all of them once expanded, and how many wait. */
export function previewRows<T>(rows: readonly T[], n: number, expanded: boolean): { shown: T[]; more: number } {
  const shown = expanded ? [...rows] : rows.slice(0, n);
  return { shown, more: rows.length - shown.length };
}

/** "My routine: Tue, Thu 9 AM at Lakeside, +1 more", or the way to set one up. */
export function routineHeaderLine(routines: readonly CourtRoutine[]): string {
  const on = routines.filter((r) => r.active && r.starred);
  if (on.length === 0) return 'Set up a routine';
  const first = `${formatWeekdayMask(on[0].days)} ${formatClockTime(on[0].localTime)} at ${on[0].venueName}`;
  return on.length === 1 ? `My routine: ${first}` : `My routine: ${first}, +${on.length - 1} more`;
}

type CardDraft = Omit<FeedCourtCard, 'count' | 'lines'> & { lines: FeedCourtLine[] };

/** Court cards for one band. */
function courtCards(day: DayBandKey, input: FeedInput, stopsByVenue: Map<string, FeedRoutineStop[]>, routineVenues: Map<string, string>): FeedCourtCard[] {
  const { now } = input;
  const starred = new Map(input.starred.map((s) => [s.venueId, s.venueName]));
  const drafts = new Map<string, CardDraft>();
  const draft = (venueId: string, venueName: string): CardDraft => {
    let d = drafts.get(venueId);
    if (!d) {
      d = {
        key: `${day}|${venueId}`,
        venueId,
        venueName: starred.get(venueId) || routineVenues.get(venueId) || venueName,
        starred: starred.has(venueId),
        routine: routineVenues.has(venueId),
        lines: [],
        othersHere: 0,
        crowd: null,
      };
      drafts.set(venueId, d);
    }
    return d;
  };

  // Every star: a Today and a Tomorrow card, even empty (Doggle).
  if (day !== 'later') for (const [id, name] of starred) draft(id, name);

  // My routine stops that day.
  for (const [venueId, stops] of stopsByVenue) {
    const mine = stops.filter((s) => dayBandOf(ms(s.at), now) === day);
    if (mine.length === 0) continue;
    const d = draft(venueId, routineVenues.get(venueId) ?? 'A court');
    for (const s of mine) d.lines.push({ kind: 'stop', key: `stop|${s.planId}`, stop: s });
  }

  // Friends: who is at a court now, or left it earlier today. Today only.
  if (day === 'today' && input.friendsAtCourts && input.friendIds) {
    const friends = input.friendIds;
    for (const g of input.friendsAtCourts.now) {
      const lines: FeedCourtLine[] = [];
      for (const p of g.people) {
        if (!friends.has(p.user_id)) continue;
        const ended = p.expires_at != null && ms(p.expires_at) <= now;
        if (ended) {
          // Left: only today's visits (the read reaches back 12 hours).
          if (dayBandOf(ms(p.expires_at as string), now) !== 'today') continue;
          lines.push({ kind: 'left', key: `left|${g.venue_id}|${p.user_id}`, person: person(p), at: p.checked_in_at, endedAt: p.expires_at as string });
        } else {
          lines.push({ kind: 'here', key: `here|${g.venue_id}|${p.user_id}`, person: person(p), at: p.checked_in_at, until: p.expires_at, viaSession: p.via_session });
        }
      }
      if (lines.length === 0) continue;
      const d = draft(g.venue_id, g.venue_name);
      d.lines.push(...lines);
      // Everyone else there, friends not counted twice (league mates the read
      // names but who aren't my friends are "others" too).
      const herePeople = g.people.filter((p) => !(p.expires_at != null && ms(p.expires_at) <= now)).length;
      const hereFriends = lines.filter((l) => l.kind === 'here').length;
      d.othersHere = g.others_here + (herePeople - hereFriends);
    }
  }

  if (day === 'today' && input.friendsAtCourts) {
    for (const c of input.friendsAtCourts.courts) {
      const d = drafts.get(c.venue_id);
      if (d) d.crowd = { here_now: c.here_now, band_low: c.band_low, band_high: c.band_high, friends_here: c.friends_here };
    }
  }

  const cards: FeedCourtCard[] = [...drafts.values()].map((d) => {
    const lines = sortCourtLines(d.lines);
    const count = lines.filter((l) => l.kind !== 'stop' || l.stop.status === 'planned').length;
    return { ...d, lines, count };
  });
  // Friends there now first, then my stops, then the quiet stars; by name.
  const rank = (c: FeedCourtCard) => [
    -c.lines.filter((l) => l.kind === 'here').length,
    c.lines.some((l) => l.kind === 'stop') ? 0 : 1,
    -c.count,
  ];
  cards.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.venueName.localeCompare(b.venueName);
  });
  // A star or a routine stop never gives way (the user: "show favorited
  // courts"); only courts that are there for friends alone share what room
  // is left under the cap.
  const kept = (ct: FeedCourtCard) => ct.starred || ct.lines.some((l) => l.kind === 'stop');
  let room = Math.max(0, MAX_FEED_COURTS - cards.filter(kept).length);
  return cards.filter((ct) => {
    if (kept(ct)) return true;
    if (room <= 0) return false;
    room -= 1;
    return true;
  });
}

/** The whole feed from what Home already loaded. */
export function buildPickleagueFeed(input: FeedInput): PickleagueFeed {
  const { now } = input;
  const hide = input.hideKeys ?? new Set<string>();
  const items: AgendaItem[] = [
    ...eventAgendaItems(input.events, now),
    ...tournamentAgendaItems(signedUpTournaments(input.tournaments), now),
    ...drillAgendaItems(input.drills, now),
    ...input.requests,
  ].filter((i) => !hide.has(i.key));
  const agenda = buildAgenda(items, now, { cap: Infinity });

  const needsYou: AgendaRow[] = [];
  const rowsByDay: Record<DayBandKey, AgendaRow[]> = { today: [], tomorrow: [], later: [] };
  for (const r of agenda.rows) {
    if (r.bucket === 'needsYou') needsYou.push(r);
    else if (r.bucket === 'live' || r.bucket === 'today') rowsByDay.today.push(r);
    else rowsByDay[dayBandOf(ms(r.startsAt), now) ?? 'later'].push(r);
  }

  // My live routines (a dormant one, its court unstarred, stays off).
  const stopsByVenue = new Map<string, FeedRoutineStop[]>();
  const routineVenues = new Map<string, string>();
  for (const r of input.routines) {
    if (!r.active || !r.starred) continue;
    routineVenues.set(r.venueId, r.venueName);
    const seen = new Set<string>();
    for (const o of [...r.occurrences, ...(r.next ? [r.next] : [])]) {
      if (seen.has(o.planId)) continue;
      seen.add(o.planId);
      const s = routineStopOf(r, o, now);
      if (!s) continue;
      const list = stopsByVenue.get(r.venueId) ?? [];
      list.push(s);
      stopsByVenue.set(r.venueId, list);
    }
  }

  const days: FeedDay[] = [];
  for (const key of ['today', 'tomorrow', 'later'] as const) {
    const rows = rowsByDay[key];
    const courts = courtCards(key, input, stopsByVenue, routineVenues);
    if (rows.length === 0 && courts.length === 0) continue;
    const count = rows.length + courts.reduce((n, c) => n + c.count, 0);
    days.push({ key, title: DAY_BAND_TITLE[key], rows, courts, count });
  }
  return { needsYou, days, total: needsYou.length + days.reduce((n, d) => n + d.count, 0) };
}
