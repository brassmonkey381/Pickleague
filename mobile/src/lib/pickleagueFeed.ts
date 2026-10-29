// The Pickleague Feed on Home (state/feed-discover-play-plan.md §3 with the
// user's 2026-10-22 decisions "One feed, like Doggle" and "court cards should
// kind of be like the top layer of the feed. They are the equivalent of places
// in Doggle"): one untabbed card with what needs you pinned on top, then day
// bands (Today / Tomorrow / Later this week). In each band the top layer is
// court cards; under each card, everything at that court that day.
//
//   Needs you (pinned)       votes, RSVPs, scores to confirm, invites, requests
//   Today
//     ★ Lakeside                         [On my way ▾] [Check in ▾]
//        my own check-in there now, league event, booked match, tournament,
//        drill, my routine stop, my one-off planned check-in, friends here
//        now / who came and went, a vote for an event there
//     ★ Star Park                                      [Check in ▾]
//        Nothing planned
//     Elsewhere              what is mine that day at no court of mine
//   Tomorrow ... Later this week ...
//
// What may appear (the user: "Only show favorited courts, leagues, and friends
// activity there, as well as tournaments we've signed up for"):
//   - my leagues' events and votes, my booked league matches, my drill
//     sessions, and the requests that wait on me: the AgendaItems Home builds;
//   - tournaments I signed up for (registered, requested, waitlisted) and
//     invites to one (a request of me). Never an open tournament I'm not in;
//   - court cards only for my starred courts (every star gets a Today and a
//     Tomorrow card, even empty, as in Doggle; Later only when something is
//     there), my routine courts (on a day with a stop or something there),
//     the courts of my one-off plans (on a day with a plan or something there) and,
//     today, the court I'm checked in at and the courts my accepted friends
//     are at. Nobody who isn't my friend, and no court that is only
//     "frequent" or a league's home court;
//   - my accepted friends' shared plans (plan sharing: a one-off they shared,
//     a routine stop they confirmed), "Sky · planned 6 PM · routine", under
//     the court in that day's band; a court with nothing of mine gets a card
//     of its own, which gives way first under the court cap;
//   - an item goes under the court it happens at (foundation matchPlace: the
//     catalog id, then coordinates, then a name that fits one court); one at
//     no court of mine goes to the band's "Elsewhere", never dropped.
//   - What needs me stays pinned on top. When it also happens at one of my
//     courts (an RSVP, a drill to confirm, a vote for an event there), the
//     court card shows it too, as a mirror that isn't counted twice.
//
// PURE: no React, no Supabase, no clock of its own. The vitest suite is
// lib/__tests__/pickleagueFeed.test.ts.
import { dayBandOf, DAY_BAND_TITLE, type DayBandKey } from '@just-messin-around/expo-foundation/scheduling/dayBands';
import { formatClockTime, formatWeekdayMask } from '@just-messin-around/expo-foundation/scheduling/weekdayMask';
import { matchPlace, placeNameWords, type KnownPlace } from '@just-messin-around/expo-foundation/places/matchPlace';
import {
  buildAgenda,
  drillAgendaItems,
  eventAgendaItems,
  matchAgendaItems,
  tournamentAgendaItems,
  type AgendaDrillInput,
  type AgendaEventInput,
  type AgendaItem,
  type AgendaMatchInput,
  type AgendaPlace,
  type AgendaRow,
  type AgendaTournamentInput,
} from './agenda';
import type { CrowdNumbers } from './courtCrowd';
import type { CourtRoutine, PlayMode } from './courtRoutineRules';
import { planInPlay, type CourtPlan } from './courtPlans';
import type { AbsoluteTimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import type { FriendAtCourt, FriendsAtCourts, FriendsCourtGroup } from './friendsAtCourts';
import { planIsShared, stopIsShared, type FriendCourtPlan } from './planSharing';

export type { DayBandKey };

/** Needs-you rows shown before "Show N more". */
export const NEEDS_YOU_PREVIEW = 3;
/** A day's Elsewhere rows shown before "Show N more". */
export const BAND_ROWS_PREVIEW = 4;
/** Lines on one court card before "See all (N more)" (Doggle's cap). */
export const COURT_ROWS_CAP = 6;
/** Court cards in one day (stars, routine stops and courts with something of
 *  mine are never cut, so a day can hold a few more): also the
 *  court_play_modes batch. */
export const MAX_FEED_COURTS = 6;
/** A routine stop stays on the feed this long after its time (Doggle's plan grace). */
export const STOP_GRACE_MS = 30 * 60_000;

/** Words in court names that say nothing about which court (matchPlace). */
export const COURT_GENERIC_WORDS = ['pickleball', 'pickle', 'ball', 'courts', 'court', 'tennis', 'pb'] as const;

const DEFAULT_STOP_MIN = 120;
/** A friend here now hides their plan there up to this far ahead (they came for it). */
export const FRIEND_PLAN_HERE_MS = 30 * 60_000;

// ── Shapes ───────────────────────────────────────────────────────────────────
export type FeedCourtRef = { venueId: string; venueName: string; lat?: number | null; lng?: number | null };

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
  /** Friends who can see my plans see it (lib/planSharing stopIsShared). */
  planShared: boolean;
};

/** My one-off planned check-in (lib/courtPlans; Doggle's "Plan a check-in for later"). */
export type FeedOneOffPlan = {
  planId: string;
  at: string;
  endAt: string;
  /** Friends who can see my plans see it. */
  planShared: boolean;
  /** Closed group / Open play / Drill (Edit plan); [] = nothing said. */
  windows: AbsoluteTimeWindow<PlayMode>[];
};

/** A friend's shared plan at a court (list_friend_court_plans). */
export type FeedFriendPlan = {
  planId: string;
  at: string;
  endAt: string | null;
  /** A routine stop they confirmed (or auto-shared), not a one-off. */
  routine: boolean;
};

/** My own check-in (Doggle's own "Here now" line). Today only. */
export type FeedMyCheckin = {
  id: string;
  venueId: string;
  venueName: string;
  /** When it began, as the server has it (none while it is still queued). */
  checkedInAt: string | null;
  expiresAt: string;
  /** Saved offline, not on the server yet. */
  queued: boolean;
  /** A play session is running (every check-in starts one). */
  playing: boolean;
};

export type FeedCourtLine =
  | { kind: 'mine'; key: string; checkin: FeedMyCheckin }
  | { kind: 'here'; key: string; person: FeedPerson; at: string; until: string | null; viaSession: boolean }
  | { kind: 'left'; key: string; person: FeedPerson; at: string; endedAt: string }
  | { kind: 'stop'; key: string; stop: FeedRoutineStop }
  | { kind: 'plan'; key: string; plan: FeedOneOffPlan }
  /** A friend's shared plan there (plan sharing). */
  | { kind: 'friendPlan'; key: string; person: FeedPerson; plan: FeedFriendPlan }
  /** A league event, booked match, tournament, drill or vote at this court.
   *  `mirror`: it needs me, so it is pinned in Needs you as well (not counted here). */
  | { kind: 'agenda'; key: string; row: AgendaRow; mirror: boolean };
/** A person, my check-in, a stop or a plan: the lines with a time chip and an action sheet. */
export type FeedSheetLine = Exclude<FeedCourtLine, { kind: 'agenda' }>;

export type FeedCourtCard = {
  key: string;
  venueId: string;
  venueName: string;
  starred: boolean;
  /** One of my routines stops here (any day). */
  routine: boolean;
  /** I'm checked in here now (its line is on the card). Today only. */
  hereMine: boolean;
  /** In time order: who came and went, who is here, then what is coming. */
  lines: FeedCourtLine[];
  /** Everyone else checked in there now (anonymous to me). Today only. */
  othersHere: number;
  /** venue_crowd's numbers for my starred courts (friends_at_courts). Today only. */
  crowd: CrowdNumbers | null;
  /** Lines that count toward the band (not skipped stops, not mirrors). */
  count: number;
};

export type FeedDay = {
  key: DayBandKey;
  title: string;
  /** The top layer: one card per court. */
  courts: FeedCourtCard[];
  /** Mine that day at no court of mine (or at no court at all), in
   *  buildAgenda's order (live first, then by time). */
  elsewhere: AgendaRow[];
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
  /** My booked league matches (absent = none). */
  matches?: readonly AgendaMatchInput[];
  /** Requests waiting on me (lib/inboxRequests inboxAgendaItems). */
  requests: readonly AgendaItem[];
  /** Agenda keys shown elsewhere on Home (a live league event's own card). */
  hideKeys?: ReadonlySet<string>;
  starred: readonly FeedCourtRef[];
  routines: readonly CourtRoutine[];
  friendsAtCourts: FriendsAtCourts | null;
  /** My accepted friends. null = not known yet: no friend lines at all. */
  friendIds: ReadonlySet<string> | null;
  /** My check-in now (lib/courtCheckin's current one), or none. */
  mine?: FeedMyCheckin | null;
  /** My one-off planned check-ins (list_my_court_plans; absent = none). */
  plans?: readonly CourtPlan[];
  /** My friends' shared plans (list_friend_court_plans; absent = none). Only
   *  accepted friends in `friendIds` show (no league mate who isn't one). */
  friendPlans?: readonly FriendCourtPlan[];
  /** My "Share my routine stops automatically" (null / absent = not known):
   *  a stop's Shared chip predicts what the server does with it on. */
  autoShareRoutines?: boolean | null;
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
export function routineStopOf(
  r: CourtRoutine,
  o: CourtRoutine['occurrences'][number],
  now: number,
  autoShare: boolean | null = null,
): FeedRoutineStop | null {
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
    planShared: stopIsShared(o, autoShare),
  };
}

/** When a line happens (NaN = undated: a vote). */
const lineTime = (l: FeedCourtLine): number => {
  if (l.kind === 'mine') return ms(l.checkin.checkedInAt);
  if (l.kind === 'stop') return ms(l.stop.at);
  if (l.kind === 'plan' || l.kind === 'friendPlan') return ms(l.plan.at);
  if (l.kind === 'agenda') return l.row.bucket === 'live' && !l.row.startsAt ? -Infinity : ms(l.row.startsAt);
  return ms(l.at);
};
const LINE_ORDER: Record<FeedCourtLine['kind'], number> = { left: 0, mine: 1, here: 1, stop: 2, plan: 2, friendPlan: 2, agenda: 2 };

/** Doggle's order: who came and went (by when they left), who is here (me
 *  first, then by arrival, close friends first), then what is coming, in
 *  time order (my stops and the league side together), undated votes last. */
export function sortCourtLines(lines: readonly FeedCourtLine[]): FeedCourtLine[] {
  return [...lines].sort((a, b) => {
    if (LINE_ORDER[a.kind] !== LINE_ORDER[b.kind]) return LINE_ORDER[a.kind] - LINE_ORDER[b.kind];
    if ((a.kind === 'mine') !== (b.kind === 'mine')) return a.kind === 'mine' ? -1 : 1;
    if (a.kind === 'left' && b.kind === 'left') return ms(a.endedAt) - ms(b.endedAt);
    if (a.kind === 'here' && b.kind === 'here' && a.person.isCloseFriend !== b.person.isCloseFriend) {
      return a.person.isCloseFriend ? -1 : 1;
    }
    const ta = lineTime(a);
    const tb = lineTime(b);
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na || nb) return na === nb ? 0 : na ? 1 : -1;
    return ta - tb;
  });
}

/** Over the cap, the oldest finished visits give way first, then friends'
 *  plans (the furthest off first), then the latest arrivals among friends
 *  here now: my own stops and agenda lines stay (what's next for me matters
 *  more). "See all" shows the rest. */
export function capCourtLines(lines: readonly FeedCourtLine[], cap = COURT_ROWS_CAP): { shown: FeedCourtLine[]; more: number } {
  if (lines.length <= cap) return { shown: [...lines], more: 0 };
  let drop = lines.length - cap;
  const hidden = new Set<number>();
  lines.forEach((l, i) => {
    if (drop > 0 && l.kind === 'left') { hidden.add(i); drop -= 1; }
  });
  for (let i = lines.length - 1; i >= 0 && drop > 0; i -= 1) {
    if (lines[i].kind === 'friendPlan') { hidden.add(i); drop -= 1; }
  }
  for (let i = lines.length - 1; i >= 0 && drop > 0; i -= 1) {
    if (lines[i].kind === 'here') { hidden.add(i); drop -= 1; }
  }
  const shown = lines.filter((_, i) => !hidden.has(i)).slice(0, cap);
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

/** The court of mine an item happens at (id, then coordinates, then a name
 *  that fits one court), or null. */
export function courtOfPlace<C extends KnownPlace>(place: AgendaPlace | null | undefined, courts: readonly C[]): C | null {
  if (!place) return null;
  const m = matchPlace(
    { id: place.venueId ?? null, name: place.name ?? null, lat: place.lat ?? null, lng: place.lng ?? null },
    courts,
    { genericWords: COURT_GENERIC_WORDS },
  );
  if (!m) return null;
  // A name-only match the distance veto could not check (no coordinates on
  // one side) must name the court exactly: "Palo Alto" is not "Palo Alto
  // Tennis Center", "Mitchell" is not "Mitchell Park".
  if (m.by === 'name') {
    const vetoChecked = place.lat != null && place.lng != null && m.place.lat != null && m.place.lng != null;
    if (!vetoChecked) {
      const a = new Set(placeNameWords(place.name, COURT_GENERIC_WORDS));
      const b = new Set(placeNameWords(m.place.name, COURT_GENERIC_WORDS));
      if (a.size !== b.size || [...a].some((w) => !b.has(w))) return null;
    }
  }
  return m.place;
}

/** Where a row is, for an Elsewhere line: its place's name, else nothing. */
export function placeLabel(row: Pick<AgendaItem, 'place'>): string | null {
  const name = row.place?.name?.split(',')[0]?.trim();
  return name || null;
}

/** My friends' lines at one court group (here now, or left earlier today). */
function friendLines(g: FriendsCourtGroup, friends: ReadonlySet<string>, now: number): FeedCourtLine[] {
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
  return lines;
}

type KnownCourt = KnownPlace & { starred: boolean; routine: boolean };
type FriendPlanLine = Extract<FeedCourtLine, { kind: 'friendPlan' }>;
type CardDraft = Omit<FeedCourtCard, 'count' | 'lines' | 'hereMine'> & { lines: FeedCourtLine[] };
type BandAgenda = { atCourt: Map<string, FeedCourtLine[]>; elsewhere: AgendaRow[] };

/** Court cards for one band. */
function courtCards(
  day: DayBandKey,
  input: FeedInput,
  courts: Map<string, KnownCourt>,
  stopsByVenue: Map<string, FeedRoutineStop[]>,
  plansByVenue: Map<string, { venueName: string; plans: FeedOneOffPlan[] }>,
  friendPlansByVenue: Map<string, { venueName: string; lines: FriendPlanLine[] }>,
  agenda: BandAgenda,
  friendGroups: Map<string, { group: FriendsCourtGroup; lines: FeedCourtLine[] }>,
  mine: FeedMyCheckin | null,
): FeedCourtCard[] {
  const { now } = input;
  const drafts = new Map<string, CardDraft>();
  const draft = (venueId: string, fallbackName: string): CardDraft => {
    let d = drafts.get(venueId);
    if (!d) {
      const known = courts.get(venueId);
      d = {
        key: `${day}|${venueId}`,
        venueId,
        venueName: known?.name || fallbackName,
        starred: known?.starred ?? false,
        routine: known?.routine ?? false,
        lines: [],
        othersHere: 0,
        crowd: null,
      };
      drafts.set(venueId, d);
    }
    return d;
  };

  // Every star: a Today and a Tomorrow card, even empty (Doggle).
  if (day !== 'later') for (const c of courts.values()) if (c.starred) draft(c.id, c.name);

  // My routine stops that day.
  for (const [venueId, stops] of stopsByVenue) {
    const mine = stops.filter((s) => dayBandOf(ms(s.at), now) === day);
    if (mine.length === 0) continue;
    const d = draft(venueId, 'A court');
    for (const s of mine) d.lines.push({ kind: 'stop', key: `stop|${s.planId}`, stop: s });
  }

  // My one-off plans that day.
  for (const [venueId, { venueName, plans }] of plansByVenue) {
    const mine = plans.filter((p) => dayBandOf(ms(p.at), now) === day);
    if (mine.length === 0) continue;
    const d = draft(venueId, venueName);
    for (const p of mine) d.lines.push({ kind: 'plan', key: `plan|${p.planId}`, plan: p });
  }

  // My friends' shared plans that day (a court with nothing of mine gets a
  // card of its own, which gives way first under the cap below).
  for (const [venueId, { venueName, lines }] of friendPlansByVenue) {
    const that = lines.filter((l) => dayBandOf(ms(l.plan.at), now) === day);
    if (that.length === 0) continue;
    draft(venueId, venueName).lines.push(...that);
  }

  // My own check-in, then friends: who is at a court now, or left it
  // earlier today. Today only.
  if (day === 'today' && mine) {
    draft(mine.venueId, mine.venueName).lines.push({ kind: 'mine', key: `mine|${mine.id}`, checkin: mine });
  }
  if (day === 'today') {
    for (const { group: g, lines } of friendGroups.values()) {
      const d = draft(g.venue_id, g.venue_name);
      d.lines.push(...lines);
      // Everyone else there, friends not counted twice (league mates the read
      // names but who aren't my friends are "others" too).
      const herePeople = g.people.filter((p) => !(p.expires_at != null && ms(p.expires_at) <= now)).length;
      const hereFriends = lines.filter((l) => l.kind === 'here').length;
      d.othersHere = g.others_here + (herePeople - hereFriends);
    }
    for (const c of input.friendsAtCourts?.courts ?? []) {
      const d = drafts.get(c.venue_id);
      if (d) d.crowd = { here_now: c.here_now, band_low: c.band_low, band_high: c.band_high, friends_here: c.friends_here };
    }
  }

  // The league side: what happens at each court that day (after the courts
  // that come with their own name, my check-in's and friends', so a court
  // only an item names keeps the right one).
  for (const [venueId, lines] of agenda.atCourt) draft(venueId, 'A court').lines.push(...lines);

  const counts = (l: FeedCourtLine) =>
    l.kind === 'stop' ? l.stop.status === 'planned' : l.kind === 'agenda' ? !l.mirror : true;
  const mineThere = (c: { lines: FeedCourtLine[] }) =>
    c.lines.some((l) => l.kind === 'mine' || l.kind === 'stop' || l.kind === 'plan' || l.kind === 'agenda');
  // A friend here now needs no "planned 6 PM" line for a plan of theirs
  // there that is under way or about to be (they came for it).
  const cameForIt = (d: CardDraft, l: FeedCourtLine) =>
    l.kind === 'friendPlan' &&
    ms(l.plan.at) <= now + FRIEND_PLAN_HERE_MS &&
    d.lines.some((h) => h.kind === 'here' && h.person.userId === l.person.userId);
  const cards: FeedCourtCard[] = [...drafts.values()].map((d) => {
    const lines = sortCourtLines(d.lines.filter((l) => !cameForIt(d, l)));
    return { ...d, lines, hereMine: lines.some((l) => l.kind === 'mine'), count: lines.filter(counts).length };
  });
  // Something live or people there now (me or friends) first, then my plans,
  // then the quiet stars; by name.
  const rank = (c: FeedCourtCard) => [
    -c.lines.filter((l) => l.kind === 'mine' || l.kind === 'here' || (l.kind === 'agenda' && l.row.bucket === 'live')).length,
    mineThere(c) ? 0 : 1,
    -c.count,
  ];
  cards.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.venueName.localeCompare(b.venueName);
  });
  // A star, a routine stop or anything of mine never gives way (the user:
  // "show favorited courts"); only courts that are there for friends alone
  // share what room is left under the cap.
  const kept = (ct: FeedCourtCard) => ct.starred || mineThere(ct);
  let room = Math.max(0, MAX_FEED_COURTS - cards.filter(kept).length);
  return cards.filter((ct) => {
    if (kept(ct)) return true;
    if (room <= 0) return false;
    room -= 1;
    return true;
  });
}

/** The band a row belongs to: live and today's in Today, the rest by start.
 *  A needs-you row with a time goes by its time too; one without (a vote)
 *  counts as today's. null = none (8+ days out). */
function bandOfRow(r: AgendaRow, now: number): DayBandKey | null {
  if (r.bucket === 'live' || r.bucket === 'today') return 'today';
  const start = ms(r.startsAt);
  if (!Number.isFinite(start)) return r.bucket === 'needsYou' ? 'today' : 'later';
  if (start <= now) return 'today';
  return dayBandOf(start, now);
}

/** The whole feed from what Home already loaded. */
export function buildPickleagueFeed(input: FeedInput): PickleagueFeed {
  const { now } = input;
  const hide = input.hideKeys ?? new Set<string>();
  const items: AgendaItem[] = [
    ...eventAgendaItems(input.events, now),
    ...matchAgendaItems(input.matches ?? [], now),
    ...tournamentAgendaItems(signedUpTournaments(input.tournaments), now),
    ...drillAgendaItems(input.drills, now),
    ...input.requests,
  ].filter((i) => !hide.has(i.key));
  const rows = buildAgenda(items, now, { cap: Infinity }).rows;

  // My live routines (a dormant one, its court unstarred, stays off).
  const stopsByVenue = new Map<string, FeedRoutineStop[]>();
  const courts = new Map<string, KnownCourt>();
  for (const s of input.starred) {
    courts.set(s.venueId, { id: s.venueId, name: s.venueName, lat: s.lat ?? null, lng: s.lng ?? null, starred: true, routine: false });
  }
  for (const r of input.routines) {
    if (!r.active || !r.starred) continue;
    const known = courts.get(r.venueId);
    courts.set(r.venueId, {
      id: r.venueId,
      name: known?.name || r.venueName,
      lat: known?.lat ?? r.lat,
      lng: known?.lng ?? r.lng,
      starred: known?.starred ?? false,
      routine: true,
    });
    const seen = new Set<string>();
    for (const o of [...r.occurrences, ...(r.next ? [r.next] : [])]) {
      if (seen.has(o.planId)) continue;
      seen.add(o.planId);
      const s = routineStopOf(r, o, now, input.autoShareRoutines ?? null);
      if (!s) continue;
      const list = stopsByVenue.get(r.venueId) ?? [];
      list.push(s);
      stopsByVenue.set(r.venueId, list);
    }
  }

  // My one-off plans not kept yet, still in play (lib/courtPlans planInPlay).
  // Their courts count as mine (as a routine's), so an item there finds them.
  const plansByVenue = new Map<string, { venueName: string; plans: FeedOneOffPlan[] }>();
  for (const p of input.plans ?? []) {
    if (!planInPlay(p, now)) continue;
    const known = courts.get(p.venueId);
    if (!known) {
      courts.set(p.venueId, { id: p.venueId, name: p.venueName, lat: p.lat, lng: p.lng, starred: false, routine: false });
    }
    const entry = plansByVenue.get(p.venueId) ?? { venueName: known?.name || p.venueName, plans: [] };
    entry.plans.push({ planId: p.planId, at: p.plannedAt, endAt: p.plannedEndAt, planShared: planIsShared(p), windows: p.windows });
    plansByVenue.set(p.venueId, entry);
  }

  // My check-in, while it runs (the copy on this device can outlive it).
  const mine = input.mine && ms(input.mine.expiresAt) > now ? input.mine : null;

  // Today's friends' courts (only courts with a friend line).
  const friendGroups = new Map<string, { group: FriendsCourtGroup; lines: FeedCourtLine[] }>();
  if (input.friendsAtCourts && input.friendIds) {
    for (const g of input.friendsAtCourts.now) {
      const lines = friendLines(g, input.friendIds, now);
      if (lines.length > 0) friendGroups.set(g.venue_id, { group: g, lines });
    }
  }
  const myCourts = [...courts.values()];
  const todayCourts: KnownCourt[] = [
    ...myCourts,
    ...[...friendGroups.values()]
      .filter(({ group: g }) => !courts.has(g.venue_id))
      .map(({ group: g }) => ({ id: g.venue_id, name: g.venue_name, lat: g.lat, lng: g.lng, starred: false, routine: false })),
  ];
  if (mine && !todayCourts.some((ct) => ct.id === mine.venueId)) {
    todayCourts.push({ id: mine.venueId, name: mine.venueName, lat: null, lng: null, starred: false, routine: false });
  }

  // My friends' shared plans (the server already applied each owner's plan
  // privacy): only accepted friends I know as such, each under the court of
  // mine it is at (id, then coordinates, then name), else a court of its own.
  const friendPlansByVenue = new Map<string, { venueName: string; lines: FriendPlanLine[] }>();
  if (input.friendIds) {
    for (const p of input.friendPlans ?? []) {
      if (!p.isFriend || !input.friendIds.has(p.ownerId)) continue;
      const atMs = ms(p.at);
      if (!Number.isFinite(atMs) || atMs <= now - STOP_GRACE_MS) continue;
      const court = todayCourts.some((ct) => ct.id === p.placeId)
        ? null
        : courtOfPlace({ venueId: p.placeId, name: p.placeName, lat: p.lat, lng: p.lng }, todayCourts);
      const venueId = court?.id ?? p.placeId;
      const entry = friendPlansByVenue.get(venueId) ?? { venueName: court?.name || p.placeName, lines: [] };
      entry.lines.push({
        kind: 'friendPlan',
        key: `fplan|${p.planId}`,
        person: {
          userId: p.ownerId,
          name: p.ownerName,
          avatarUrl: p.avatarUrl,
          avatarEmoji: p.avatarEmoji,
          avatarBgColor: p.avatarBgColor,
          isCloseFriend: p.isCloseFriend,
        },
        plan: { planId: p.planId, at: p.at, endAt: p.endAt ?? null, routine: p.kind === 'routine' },
      });
      friendPlansByVenue.set(venueId, entry);
    }
  }

  // Each row to its band, then to its court there (or Elsewhere).
  const needsYou: AgendaRow[] = [];
  const bands: Record<DayBandKey, BandAgenda> = {
    today: { atCourt: new Map(), elsewhere: [] },
    tomorrow: { atCourt: new Map(), elsewhere: [] },
    later: { atCourt: new Map(), elsewhere: [] },
  };
  for (const r of rows) {
    const mirror = r.bucket === 'needsYou';
    if (mirror) needsYou.push(r);
    const band = bandOfRow(r, now);
    if (!band) continue;
    const court = courtOfPlace(r.place, band === 'today' ? todayCourts : myCourts);
    if (court) {
      const list = bands[band].atCourt.get(court.id) ?? [];
      list.push({ kind: 'agenda', key: `agenda|${r.key}`, row: r, mirror });
      bands[band].atCourt.set(court.id, list);
    } else if (!mirror) {
      bands[band].elsewhere.push(r);
    }
  }

  const days: FeedDay[] = [];
  for (const key of ['today', 'tomorrow', 'later'] as const) {
    const elsewhere = bands[key].elsewhere;
    const cards = courtCards(key, input, courts, stopsByVenue, plansByVenue, friendPlansByVenue, bands[key], key === 'today' ? friendGroups : new Map(), mine);
    if (elsewhere.length === 0 && cards.length === 0) continue;
    const count = elsewhere.length + cards.reduce((n, c) => n + c.count, 0);
    days.push({ key, title: DAY_BAND_TITLE[key], courts: cards, elsewhere, count });
  }
  return { needsYou, days, total: needsYou.length + days.reduce((n, d) => n + d.count, 0) };
}
