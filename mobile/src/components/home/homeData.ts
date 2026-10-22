// Everything Home paints, fetched as one unit (plan section 3, data rule 1).
//
// Bundling it is what lets the screen tell "still loading / couldn't reach the
// server" apart from "you really have nothing going on", and what stops a
// failed pull-to-refresh from reporting a balance of 0 pickles as fact.
//
// Cache key `home:overview:v2` (rule 4): the persisted v1 blob (24h) has a
// different shape, and a new key means it is simply never read into this
// layout, offline start included. HomeScreen also spreads EMPTY_HOME under
// whatever it gets, so a missing field can never crash a render.
//
// Round trips: identity is a local session read; then one parallel wave; then
// one wave that needs my league ids / the candidate ids; then the slots, my
// votes and my declines for the events Home can still show. Events are bounded
// on the server (open votes; scheduled events whose confirmed time is recent
// or ahead), because a scheduled event stays 'scheduled' forever and an
// unbounded list grew with a league's whole history on every Home focus. Every query is a plain select that existing RLS allows:
// profiles (own), notifications (own: a count, plus the 50 newest unread for
// the bell's dot), league_members / leagues /
// league_events / event_slots / event_slot_votes / event_declines /
// league_seasons / tournaments (readable by everyone), tournament_registrations
// (own rows), league_join_requests (own rows), drill_sessions (own sessions),
// user_login_streaks (own row).
//
// P3 adds, in the second wave: the REQUESTS for Up next (lib/inboxRequests:
// pending matches I have to confirm, drill requests sent to me, join requests
// for leagues I run) and the deleted-target check behind the bell's dot (an
// unread notice whose league / tournament / event / match / drill is gone is
// not "something new"). Both are soft: a failed read is "none", never a blank
// Home. Their RLS is listed in lib/inboxRequests.ts.
//
// The LEAGUE SPOTLIGHT (it replaced YOURS) reads its header and "Next" line
// from here: each league's season name, its next event and soonest-closing open
// vote, and (in 2+ leagues, for picking the default league) its newest match
// (matches are readable by everyone), in parallel with the events wave and
// soft per league. Its standings load separately, for the selected league only
// (components/home/LeagueSpotlight.tsx), so they never slow this payload.
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../../lib/supabase';
import { isoDate } from '../../lib/drillTime';
import { FORMAT_META } from '../../lib/tournament';
import { EVENT_LIVE_WINDOW_MS } from '../../lib/agenda';
import { placeNamesMatch } from '@just-messin-around/expo-foundation/places/matchPlace';
import { COURT_GENERIC_WORDS } from '../../lib/pickleagueFeed';
import type {
  AgendaDrillInput,
  AgendaEventInput,
  AgendaMatchInput,
  AgendaPlace,
  AgendaTournamentInput,
  DrillRsvp,
  SeasonInput,
} from '../../lib/agenda';
import {
  EMPTY_INBOX,
  findMissingTargets,
  loadInboxRequests,
  type InboxRequestRows,
  type NotificationLite,
} from '../../lib/inboxRequests';
import type { SeasonInput as SummarySeason } from '../../lib/seasonSummary';
import type { Profile } from '../../types';

export const HOME_KEY = 'home:overview:v2';

export type HomeRole = 'admin' | 'co-admin' | 'member';

export type HomeLeague = {
  id: string;
  name: string;
  home_court: string | null;
  is_open: boolean | null;
  role: HomeRole;
  /** Open votes in this league that end in the future. */
  openVotes: number;
  /** Next confirmed event's start (ISO). */
  nextEventAt: string | null;
  /** Active season, else the upcoming one. */
  season: SeasonInput | null;
  /** The open vote closing soonest (the spotlight's "Next" line opens it).
   *  Absent in a payload persisted before it existed: read it as null. */
  openVote?: { id: string; title: string; endsAt: string | null } | null;
  /** The next confirmed event I haven't declined (nextEventAt's event). Absent
   *  in an older payload: read it as null. */
  nextEvent?: { id: string; title: string; startsAt: string } | null;
  /** The league's newest match (ISO), read only in 2+ leagues (the
   *  spotlight's default pick). Absent / null = unknown. */
  lastMatchAt?: string | null;
};

export type HomeTournament = AgendaTournamentInput & {
  location_name: string | null;
  formatLabel: string | null;
};

/** A league or tournament the viewer could join (JOIN A LEAGUE / OPEN NEAR YOU). */
export type HomeOpenLeague = {
  id: string;
  name: string;
  home_court: string | null;
  is_open: boolean | null;
  lat: number | null;
  lng: number | null;
  memberCount: number;
  requested: boolean;
  /** Has an active season (the row's "In season" fact, plan layout B). Absent
   *  in a payload persisted before it existed: read it as false. */
  inSeason: boolean;
};

export type HomeOpenTournament = {
  id: string;
  name: string;
  start_time: string | null;
  location_name: string | null;
  lat: number | null;
  lng: number | null;
  leagueName: string | null;
  formatLabel: string | null;
};

export type HomeData = {
  profile: Profile | null;
  unreadCount: number;
  /** Unread notices whose target still exists (of the newest UNREAD_PROBE;
   *  see loadHome). Drives the bell's dot; the bell's NUMBER is the needs-you
   *  count, computed on the screen. Absent in a payload cached before P3. */
  unreadLive: number;
  /** Request rows for Up next (mapped at render time). */
  inbox: InboxRequestRows;
  /** Any membership at all (FTUE's join step), active league or not. */
  inLeague: boolean;
  /** Days the login streak has run (0 = none), for the greeting. */
  streak: number;
  myLeagues: HomeLeague[];
  myTournaments: HomeTournament[];
  /** Agenda inputs for my leagues' events. */
  events: AgendaEventInput[];
  /** Today's drill sessions only (kept for a payload cached before `drills`). */
  drillsToday: AgendaDrillInput[];
  /** Drill sessions from yesterday through the next 7 days (not dismissed),
   *  with their court and both RSVPs: Up next's drill stages. Absent in a
   *  payload cached before it existed: read `drillsToday` instead. */
  drills?: AgendaDrillInput[];
  /** My booked league matches this week (the Pickleague Feed's court cards).
   *  Absent in a payload cached before it existed: none. */
  matches?: AgendaMatchInput[];
  openLeagues: HomeOpenLeague[];
  openTournaments: HomeOpenTournament[];
  /** A candidate fetch hit its row limit, so the open totals are a floor
   *  (OPEN NEAR YOU then says "See all" without a number). */
  openCapped: boolean;
};

export const EMPTY_HOME: HomeData = {
  profile: null,
  unreadCount: 0,
  unreadLive: 0,
  inbox: EMPTY_INBOX,
  inLeague: false,
  streak: 0,
  myLeagues: [],
  myTournaments: [],
  events: [],
  drillsToday: [],
  // `drills` stays absent here: its absence is how an old payload is told apart.
  openLeagues: [],
  openTournaments: [],
  openCapped: false,
};

/** Active leagues fetched as join candidates. ALL the non-mine ones come back
 *  (with counts), never a pre-cut slice: HomeScreen sorts them (nearest first
 *  when location is already granted, else open then busiest) and only then
 *  caps, so an older but nearer / busier league can still make the top 3. */
const LEAGUE_FETCH_LIMIT = 40;
/** Open tournaments fetched for OPEN NEAR YOU. */
const OPEN_TOURNAMENT_LIMIT = 25;
/** Newest unread notices checked for a live target (the bell's dot). */
const UNREAD_PROBE = 50;
/** Leagues whose newest match is read for the spotlight's default pick. */
const LAST_MATCH_LEAGUES = 12;

type EventRow = {
  id: string;
  title: string;
  league_id: string;
  status: string;
  vote_ends_at: string | null;
  confirmed_slot_id: string | null;
  location_name?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
};
/** league_events columns Home reads (with the event's own place). */
const EVENT_COLS = 'id, title, league_id, status, vote_ends_at, confirmed_slot_id, location_name, location_lat, location_lng';
type SlotRow = { id: string; event_id: string; starts_at: string; ends_at: string | null };
/** A league_seasons row (select *): the agenda's fields read from it. */
type SeasonRow = SummarySeason & { id: string; league_id: string };

/** Scheduled events in these leagues whose confirmed slot started at or after
 *  `cutoffIso` (agenda keeps an event live for EVENT_LIVE_WINDOW_MS after it
 *  starts; anything older can never show), with that slot. One request through
 *  the confirmed-slot FK, filtered on the server. If PostgREST refuses the
 *  embed (the FK migration not applied, say), it falls back to the old shape:
 *  every scheduled event, then their confirmed slots by id, cut here. */
async function loadScheduledEvents(leagueIds: string[], cutoffIso: string): Promise<{ events: EventRow[]; slots: SlotRow[] }> {
  try {
    const rows = await sbCall(() => supabase
      .from('league_events')
      .select(`${EVENT_COLS}, event_slots!league_events_confirmed_slot_id_fkey!inner(id, event_id, starts_at, ends_at)`)
      .in('league_id', leagueIds)
      .eq('status', 'scheduled')
      .gte('event_slots.starts_at', cutoffIso));
    const events: EventRow[] = [];
    const slots: SlotRow[] = [];
    for (const r of (rows ?? []) as unknown as (EventRow & { event_slots: SlotRow | SlotRow[] | null })[]) {
      const slot = Array.isArray(r.event_slots) ? r.event_slots[0] : r.event_slots;
      if (!slot) continue;
      events.push({
        id: r.id,
        title: r.title,
        league_id: r.league_id,
        status: r.status,
        vote_ends_at: r.vote_ends_at,
        confirmed_slot_id: r.confirmed_slot_id,
        location_name: r.location_name ?? null,
        location_lat: r.location_lat ?? null,
        location_lng: r.location_lng ?? null,
      });
      slots.push(slot);
    }
    return { events, slots };
  } catch {
    const rows = ((await sbCall(() => supabase
      .from('league_events')
      .select(EVENT_COLS)
      .in('league_id', leagueIds)
      .eq('status', 'scheduled'))) ?? []) as EventRow[];
    const slotIds = rows.map(e => e.confirmed_slot_id).filter((id): id is string => !!id);
    if (!slotIds.length) return { events: [], slots: [] };
    const slotRows = ((await sbCall(() => supabase
      .from('event_slots')
      .select('id, event_id, starts_at, ends_at')
      .in('id', slotIds))) ?? []) as SlotRow[];
    // Same instant format both sides (timestamptz from PostgREST vs toISOString
    // differ), so compare as times, not strings.
    const cutoff = Date.parse(cutoffIso);
    const slots = slotRows.filter(x => Date.parse(x.starts_at) >= cutoff);
    const live = new Set(slots.map(x => x.id));
    return { events: rows.filter(e => !!e.confirmed_slot_id && live.has(e.confirmed_slot_id)), slots };
  }
}

function formatLabelOf(format: string | null | undefined, matchType: string | null | undefined): string | null {
  const meta = format ? (FORMAT_META as Record<string, { label: string }>)[format] : undefined;
  if (!meta) return null;
  return matchType === 'doubles' ? `Doubles ${meta.label}` : meta.label;
}

/** Start of a drill session: its starts_at, else its date + half-hour slot. */
function drillStart(r: { starts_at: string | null; session_date: string; session_slot: number }): string | null {
  if (r.starts_at) return r.starts_at;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.session_date ?? '');
  if (!m || !Number.isFinite(r.session_slot)) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, r.session_slot * 30);
  return d.toISOString();
}

/** Newest match per league (the spotlight's last tie-break), at most
 *  LAST_MATCH_LEAGUES leagues, one limit-1 read each. Soft per league: a
 *  failed read leaves it unknown. */
async function loadLastMatches(leagueIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(leagueIds.slice(0, LAST_MATCH_LEAGUES).map(async (id) => {
    try {
      const rows = (await sbCall(() => supabase
        .from('matches')
        .select('played_at')
        .eq('league_id', id)
        .eq('status', 'completed')
        .order('played_at', { ascending: false })
        .limit(1))) as { played_at: string | null }[] | null;
      const at = rows?.[0]?.played_at;
      if (at) out.set(id, at);
    } catch {
      // Unknown for this league.
    }
  }));
  return out;
}

/** My votes on these events' slots. Filtered through the slot's event with an
 *  inner embed, so it doesn't wait for the slot ids; if PostgREST ever refuses
 *  the embedded filter, it falls back to the slot ids once they land (one more
 *  round trip, never a blank Home). */
async function loadMyVotes(uid: string, eventIds: string[], slotsP: Promise<unknown>): Promise<{ slot_id: string }[]> {
  try {
    const rows = await sbCall(() => supabase
      .from('event_slot_votes')
      .select('slot_id, event_slots!inner(event_id)')
      .eq('user_id', uid)
      .in('event_slots.event_id', eventIds));
    return (rows ?? []) as { slot_id: string }[];
  } catch {
    const slots = ((await slotsP.catch(() => [])) ?? []) as { id: string }[];
    if (!slots.length) return [];
    const rows = await sbCall(() => supabase
      .from('event_slot_votes')
      .select('slot_id')
      .eq('user_id', uid)
      .in('slot_id', slots.map(x => x.id)));
    return (rows ?? []) as { slot_id: string }[];
  }
}

/** A drill_sessions row as Home reads it (select below). */
type DrillSessionRow = {
  id: string;
  player1_id: string;
  player2_id: string;
  session_date: string;
  session_slot: number;
  starts_at: string | null;
  length_minutes: number | null;
  reminder_dismissed_by: string[] | null;
  p1?: { full_name: string | null } | { full_name: string | null }[] | null;
  p2?: { full_name: string | null } | { full_name: string | null }[] | null;
  drill_session_rsvps?: { user_id: string; status: string }[] | null;
  req?: DrillReqRow | DrillReqRow[] | null;
};
type DrillLocRow = { venue_id: string | null; lat: number | null; lng: number | null };
type DrillReqRow = {
  id: string;
  status: string | null;
  location_name: string | null;
  /** The picked court_locations row (absent when the embed was refused). */
  loc?: DrillLocRow | DrillLocRow[] | null;
};

const DRILL_SESSION_LIMIT = 30;

/** My drill sessions from yesterday (one still running past midnight) through
 *  the next week (drill dates are local calendar days; agenda trims to the
 *  exact window), with both players' answers and the request's court in the
 *  same request (drill_sessions and drill_session_rsvps: the two players
 *  read both rows; drill_requests: participants). If PostgREST refuses the
 *  embeds (the RSVP table not applied, say), it falls back to the bare
 *  sessions: plain rows, the pre-stage behaviour. */
async function loadDrillSessions(uid: string): Promise<DrillSessionRow[]> {
  const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return isoDate(d); };
  const base = 'id, player1_id, player2_id, session_date, session_slot, starts_at, length_minutes, reminder_dismissed_by,'
    + ' p1:profiles!drill_sessions_player1_id_fkey(full_name),'
    + ' p2:profiles!drill_sessions_player2_id_fkey(full_name)';
  const run = (select: string) => sbCall(() => supabase
    .from('drill_sessions')
    .select(select)
    .gte('session_date', day(-1))
    .lte('session_date', day(7))
    .or(`player1_id.eq.${uid},player2_id.eq.${uid}`)
    .order('session_date')
    .order('session_slot')
    .limit(DRILL_SESSION_LIMIT));
  // Richest first: the request's court with its catalog venue (the feed's
  // court cards), then without it, then the bare sessions.
  const selects = [
    `${base}, drill_session_rsvps(user_id, status), req:drill_requests(id, status, location_name, loc:court_locations(venue_id, lat, lng))`,
    `${base}, drill_session_rsvps(user_id, status), req:drill_requests(id, status, location_name)`,
    base,
  ];
  for (let i = 0; ; i++) {
    try {
      return ((await run(selects[i])) ?? []) as unknown as DrillSessionRow[];
    } catch (e) {
      if (i === selects.length - 1) throw e;
    }
  }
}

/** A coordinate (numeric columns can arrive as strings), else null. */
function numOr(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A place from a row's location columns, or null when it has none. */
function placeOf(name: unknown, lat: unknown, lng: unknown, venueId?: string | null): AgendaPlace | null {
  const n = typeof name === 'string' && name.trim() ? name.trim() : null;
  const la = numOr(lat);
  const ln = numOr(lng);
  if (!n && (la == null || ln == null) && !venueId) return null;
  return { venueId: venueId ?? null, name: n, lat: la, lng: ln };
}

/** An event's place: its own, else its league's home court. An event that
 *  names the home court but has no coordinates borrows the home court's
 *  catalog id and coordinates, so it nests under that court. */
function eventPlace(
  e: { location_name?: unknown; location_lat?: unknown; location_lng?: unknown },
  home: AgendaPlace | null,
): AgendaPlace | null {
  const own = placeOf(e.location_name, e.location_lat, e.location_lng);
  if (!own) return home;
  const hasCoords = own.lat != null && own.lng != null;
  if (!hasCoords && home && placeNamesMatch(own.name, home.name, COURT_GENERIC_WORDS)) {
    return { ...own, venueId: home.venueId ?? null, lat: home.lat ?? null, lng: home.lng ?? null };
  }
  return own;
}

/** A scheduled league match as Home reads it. */
type ScheduledMatchRow = {
  id: string;
  league_id: string | null;
  scheduled_at: string | null;
  player1_id: string;
  player2_id: string;
  partner1_id: string | null;
  partner2_id: string | null;
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  p1?: { full_name: string | null } | { full_name: string | null }[] | null;
  p2?: { full_name: string | null } | { full_name: string | null }[] | null;
};

/** My league matches booked from 2 hours ago through the next 8 days. Soft:
 *  a refused read is no matches (Home never waits on it to fail). */
async function loadScheduledMatches(uid: string): Promise<ScheduledMatchRow[]> {
  try {
    const rows = await sbCall(() => supabase
      .from('matches')
      .select('id, league_id, scheduled_at, player1_id, player2_id, partner1_id, partner2_id, location_name, location_lat, location_lng,'
        + ' p1:profiles!matches_player1_id_fkey(full_name), p2:profiles!matches_player2_id_fkey(full_name)')
      .eq('status', 'scheduled')
      .or(`player1_id.eq.${uid},player2_id.eq.${uid},partner1_id.eq.${uid},partner2_id.eq.${uid}`)
      .gte('scheduled_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
      .lte('scheduled_at', new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString())
      .order('scheduled_at')
      .limit(20));
    return (rows ?? []) as unknown as ScheduledMatchRow[];
  } catch {
    return [];
  }
}

function asRsvp(v: string | null | undefined): DrillRsvp | null {
  return v === 'on_my_way' || v === 'cant_make_it' ? v : null;
}

export async function loadHome(): Promise<HomeData> {
  const uid = await currentUserId(supabase);
  if (!uid) return EMPTY_HOME;

  const today = isoDate(new Date());
  const [profile, unreadRes, unreadRows, memberRows, drillRows, regRows, openTourRows, streakRow, leagueRows, matchRows] = await Promise.all([
    sbCall(() => supabase.from('profiles').select('*').eq('id', uid).single()),
    supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('is_read', false),
    // The newest unread, for the deleted-target check (second wave). Soft.
    sbCall(() => supabase
      .from('notifications')
      .select('id, entity_type, entity_id')
      .eq('user_id', uid)
      .eq('is_read', false)
      .order('created_at', { ascending: false })
      .limit(UNREAD_PROBE))
      .catch(() => null),
    // Doubles as FtueChecklistCard's membership check (Home passes it down),
    // the spotlight (name, role, chips) and the league filter for events.
    sbCall(() => supabase
      .from('league_members')
      .select('league_id, role, league:leagues(id, name, home_court, home_venue_id, home_court_lat, home_court_lng, is_active, is_open)')
      .eq('user_id', uid)),
    loadDrillSessions(uid),
    // Tournaments I'm registered for, invited to or waitlisted on (still live).
    sbCall(() => supabase
      .from('tournament_registrations')
      .select('status, invited_by, tournament:tournaments(id, name, start_time, registration_closes_at, status, league_id, format, match_type, location_name, location_lat, location_lng)')
      .eq('user_id', uid)
      .in('status', ['approved', 'pending', 'waitlisted'])),
    sbCall(() => supabase
      .from('tournaments')
      .select('id, name, start_time, status, league_id, format, match_type, location_name, location_lat, location_lng')
      .eq('status', 'registration')
      .order('start_time', { ascending: true, nullsFirst: false })
      .limit(OPEN_TOURNAMENT_LIMIT)),
    // The greeting's streak count. Non-fatal: a missing row is "no streak".
    sbCall(() => supabase.from('user_login_streaks').select('current_streak').eq('user_id', uid).maybeSingle())
      .catch(() => null),
    sbCall(() => supabase
      .from('leagues')
      .select('id, name, home_court, home_court_lat, home_court_lng, is_open')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(LEAGUE_FETCH_LIMIT)),
    loadScheduledMatches(uid),
  ]);

  // ── My leagues ──
  type MemberLeague = {
    id: string;
    name: string;
    home_court: string | null;
    home_venue_id?: string | null;
    home_court_lat?: number | null;
    home_court_lng?: number | null;
    is_active: boolean | null;
    is_open: boolean | null;
  };
  type MemberRow = { league_id: string; role: string | null; league: MemberLeague | MemberLeague[] | null };
  const members = (memberRows ?? []) as MemberRow[];
  const allMyLeagueIds = new Set(members.map(m => m.league_id));
  const myLeagues: HomeLeague[] = [];
  // Each league's home court: where an event without a place of its own is.
  const homePlace = new Map<string, AgendaPlace | null>();
  for (const m of members) {
    const l = Array.isArray(m.league) ? m.league[0] : m.league;
    if (!l || l.is_active === false) continue;
    homePlace.set(l.id, placeOf(l.home_court, l.home_court_lat, l.home_court_lng, l.home_venue_id ?? null));
    const role: HomeRole = m.role === 'admin' ? 'admin' : m.role === 'co-admin' ? 'co-admin' : 'member';
    myLeagues.push({
      id: l.id, name: l.name, home_court: l.home_court ?? null, is_open: l.is_open ?? null, role,
      openVotes: 0, nextEventAt: null, season: null, openVote: null, nextEvent: null, lastMatchAt: null,
    });
  }
  const leagueById = new Map(myLeagues.map(l => [l.id, l]));
  const myLeagueIds = myLeagues.map(l => l.id);

  // ── Drill sessions this week (hide ones I've dismissed) ──
  const drills: AgendaDrillInput[] = [];
  const drillsToday: AgendaDrillInput[] = [];
  for (const r of (drillRows ?? []) as DrillSessionRow[]) {
    if ((r.reminder_dismissed_by ?? []).includes(uid)) continue;
    const req = Array.isArray(r.req) ? r.req[0] ?? null : r.req ?? null;
    // A request that was cancelled or declined after it was accepted.
    if (req && req.status && req.status !== 'accepted') continue;
    const startsAt = drillStart(r);
    if (!startsAt) continue;
    const iAmP1 = r.player1_id === uid;
    const partner = iAmP1 ? r.p2 : r.p1;
    const partnerName = (Array.isArray(partner) ? partner[0] : partner)?.full_name ?? 'your partner';
    const partnerId = iAmP1 ? r.player2_id : r.player1_id;
    const rsvps = r.drill_session_rsvps;
    const row: AgendaDrillInput = {
      id: r.id,
      partnerName,
      startsAt,
      lengthMinutes: r.length_minutes ?? 60,
    };
    // Only when the embeds came back: otherwise the row stays a plain one.
    if (rsvps !== undefined || r.req !== undefined) {
      row.requestId = req?.id ?? null;
      row.court = req ? (req.location_name?.trim() || null) : undefined;
      const loc = req ? (Array.isArray(req.loc) ? req.loc[0] ?? null : req.loc ?? null) : null;
      if (row.court || loc) {
        row.place = { venueId: loc?.venue_id ?? null, name: row.court ?? null, lat: numOr(loc?.lat), lng: numOr(loc?.lng) };
      }
      row.myRsvp = asRsvp((rsvps ?? []).find(x => x.user_id === uid)?.status);
      row.partnerRsvp = asRsvp((rsvps ?? []).find(x => x.user_id === partnerId)?.status);
    }
    drills.push(row);
    if (r.session_date === today) drillsToday.push(row);
  }

  // ── My tournaments ──
  type RegRow = {
    status: string;
    invited_by: string | null;
    tournament: any;
  };
  const regs: { reg: RegRow; t: any }[] = [];
  for (const r of (regRows ?? []) as RegRow[]) {
    const t = Array.isArray(r.tournament) ? r.tournament[0] : r.tournament;
    if (!t || t.status === 'completed' || t.status === 'cancelled') continue;
    regs.push({ reg: r, t });
  }
  const myTournamentIds = new Set(regs.map(x => x.t.id as string));

  // ── Joinable leagues (not mine) ──
  const candidates = ((leagueRows ?? []) as any[]).filter(l => !allMyLeagueIds.has(l.id));
  const candidateIds = candidates.map(l => l.id as string);

  // League names for tournaments (mine or open) whose league I'm not in.
  const openTours = ((openTourRows ?? []) as any[]).filter(t => !myTournamentIds.has(t.id));
  const knownNames = new Map<string, string>();
  for (const l of myLeagues) knownNames.set(l.id, l.name);
  for (const l of (leagueRows ?? []) as any[]) knownNames.set(l.id, l.name);
  const missingLeagueIds = Array.from(new Set(
    [...regs.map(x => x.t.league_id), ...openTours.map(t => t.league_id)]
      .filter((id): id is string => !!id && !knownNames.has(id)),
  ));

  // ── Second wave: needs my league ids / candidate ids ──
  const nowIso = new Date().toISOString();
  const liveCutoffIso = new Date(Date.now() - EVENT_LIVE_WINDOW_MS).toISOString();
  const adminLeagueIds = myLeagues.filter(l => l.role === 'admin' || l.role === 'co-admin').map(l => l.id);
  const unreadProbe = (unreadRows ?? null) as NotificationLite[] | null;
  const db = { client: supabase, call: sbCall };
  const [votingRows, scheduled, seasonRows, candidateMemberRows, requestRows, extraLeagueRows, candidateSeasonRows, inbox, missingUnread] = await Promise.all([
    // Open votes only: an expired vote never shows.
    myLeagueIds.length
      ? sbCall(() => supabase
          .from('league_events')
          .select(EVENT_COLS)
          .in('league_id', myLeagueIds)
          .eq('status', 'voting')
          .gt('vote_ends_at', nowIso))
      : Promise.resolve([]),
    myLeagueIds.length
      ? loadScheduledEvents(myLeagueIds, liveCutoffIso)
      : Promise.resolve({ events: [] as EventRow[], slots: [] as SlotRow[] }),
    myLeagueIds.length
      ? sbCall(() => supabase
          .from('league_seasons')
          .select('*')
          .in('league_id', myLeagueIds)
          .in('status', ['active', 'upcoming']))
      : Promise.resolve([]),
    candidateIds.length
      ? sbCall(() => supabase.from('league_members').select('league_id').in('league_id', candidateIds))
      : Promise.resolve([]),
    candidateIds.length
      ? sbCall(() => supabase
          .from('league_join_requests')
          .select('league_id')
          .eq('user_id', uid)
          .eq('status', 'pending')
          .in('league_id', candidateIds))
      : Promise.resolve([]),
    missingLeagueIds.length
      ? sbCall(() => supabase.from('leagues').select('id, name').in('id', missingLeagueIds))
      : Promise.resolve([]),
    // Candidates in an active season ("In season"). Seasons are readable by
    // everyone (migration_add_seasons.sql).
    candidateIds.length
      ? sbCall(() => supabase
          .from('league_seasons')
          .select('league_id')
          .in('league_id', candidateIds)
          .eq('status', 'active'))
      : Promise.resolve([]),
    loadInboxRequests(db, uid, adminLeagueIds).catch(() => EMPTY_INBOX),
    unreadProbe && unreadProbe.length
      ? findMissingTargets(db, unreadProbe).catch(() => new Set<string>())
      : Promise.resolve(new Set<string>()),
  ]);
  for (const l of (extraLeagueRows ?? []) as { id: string; name: string }[]) knownNames.set(l.id, l.name);

  // Seasons: active wins over upcoming (the earliest upcoming otherwise).
  for (const s of (seasonRows ?? []) as SeasonRow[]) {
    const l = leagueById.get(s.league_id);
    if (!l) continue;
    const next: SeasonInput = { status: s.status, startDate: s.start_date, name: s.name ?? null };
    if (!l.season || (l.season.status !== 'active' && (s.status === 'active' || s.start_date < l.season.startDate))) {
      l.season = next;
    }
  }
  // Newest matches, only when there is a default to pick (2+ leagues), in
  // parallel with the events wave below. Never rejects.
  const lastMatchesP = myLeagueIds.length >= 2 ? loadLastMatches(myLeagueIds) : Promise.resolve(new Map<string, string>());

  // ── Events: slots, my votes, my declines ──
  // Open votes need every slot (a vote on any of them counts); scheduled events
  // only their confirmed slot, which came with them.
  const votingEvents = (votingRows ?? []) as EventRow[];
  const events: EventRow[] = [...votingEvents, ...scheduled.events];
  const eventIds = events.map(e => e.id);
  const votingIds = votingEvents.map(e => e.id);
  let slotRows: SlotRow[] = scheduled.slots;
  let voteRows: unknown = [];
  let declineRows: unknown = [];
  if (eventIds.length) {
    const votingSlotsP: Promise<SlotRow[]> = votingIds.length
      ? sbCall(() => supabase.from('event_slots').select('id, event_id, starts_at, ends_at').in('event_id', votingIds))
          .then(rows => (rows ?? []) as SlotRow[])
      : Promise.resolve([]);
    // loadMyVotes' fallback keys on slot ids: hand it every slot we hold.
    const allSlotsP = votingSlotsP.then(v => [...v, ...scheduled.slots]);
    let votingSlots: SlotRow[];
    [votingSlots, voteRows, declineRows] = await Promise.all([
      votingSlotsP,
      loadMyVotes(uid, eventIds, allSlotsP),
      sbCall(() => supabase.from('event_declines').select('event_id').eq('user_id', uid).in('event_id', eventIds)),
    ]);
    slotRows = [...votingSlots, ...scheduled.slots];
  }

  const lastMatches = await lastMatchesP;
  for (const l of myLeagues) l.lastMatchAt = lastMatches.get(l.id) ?? null;

  const slotById = new Map<string, SlotRow>();
  for (const s of slotRows) slotById.set(s.id, s);
  const myVotedSlots = new Set(((voteRows ?? []) as { slot_id: string }[]).map(v => v.slot_id));
  const votedEvents = new Set<string>();
  for (const id of myVotedSlots) {
    const s = slotById.get(id);
    if (s) votedEvents.add(s.event_id);
  }
  const declined = new Set(((declineRows ?? []) as { event_id: string }[]).map(d => d.event_id));

  const agendaEvents: AgendaEventInput[] = [];
  for (const e of events) {
    const league = leagueById.get(e.league_id);
    const slot = e.confirmed_slot_id ? slotById.get(e.confirmed_slot_id) ?? null : null;
    agendaEvents.push({
      id: e.id,
      title: e.title,
      leagueName: league?.name ?? null,
      status: e.status,
      voteEndsAt: e.vote_ends_at,
      slot: slot ? { startsAt: slot.starts_at, endsAt: slot.ends_at } : null,
      // Voting: any slot. Scheduled: the confirmed one (that's the RSVP).
      iVoted: e.status === 'voting' ? votedEvents.has(e.id) : !!e.confirmed_slot_id && myVotedSlots.has(e.confirmed_slot_id),
      iDeclined: declined.has(e.id),
      place: eventPlace(e, homePlace.get(e.league_id) ?? null),
    });
    // Spotlight facts.
    if (!league) continue;
    if (e.status === 'voting') {
      league.openVotes += 1;
      const cur = league.openVote;
      if (!cur || (e.vote_ends_at != null && (cur.endsAt == null || e.vote_ends_at < cur.endsAt))) {
        league.openVote = { id: e.id, title: e.title, endsAt: e.vote_ends_at };
      }
    } else if (slot && slot.starts_at > nowIso && !declined.has(e.id)) {
      if (!league.nextEventAt || slot.starts_at < league.nextEventAt) {
        league.nextEventAt = slot.starts_at;
        league.nextEvent = { id: e.id, title: e.title, startsAt: slot.starts_at };
      }
    }
  }

  const myTournaments: HomeTournament[] = regs
    .map(({ reg, t }) => ({
      id: t.id,
      name: t.name,
      leagueName: t.league_id ? knownNames.get(t.league_id) ?? null : null,
      startTime: t.start_time ?? null,
      status: t.status,
      myStatus: reg.status,
      invited: reg.status === 'pending' && !!reg.invited_by,
      registrationClosesAt: t.registration_closes_at ?? null,
      location_name: t.location_name ?? null,
      formatLabel: formatLabelOf(t.format, t.match_type),
      place: placeOf(t.location_name, t.location_lat, t.location_lng),
    }))
    .sort((a, b) => (a.startTime ?? '9999').localeCompare(b.startTime ?? '9999'));

  // My booked league matches: their own place, else the league's home court.
  const matches: AgendaMatchInput[] = [];
  for (const m of matchRows) {
    if (!m.scheduled_at) continue;
    // Team 1 is player1 + partner1; the other side's lead player names the match.
    const onTeam1 = m.player1_id === uid || m.partner1_id === uid;
    const opp = onTeam1 ? m.p2 : m.p1;
    matches.push({
      id: m.id,
      opponentName: (Array.isArray(opp) ? opp[0] : opp)?.full_name ?? 'your opponent',
      leagueName: m.league_id ? knownNames.get(m.league_id) ?? null : null,
      scheduledAt: m.scheduled_at,
      place: placeOf(m.location_name, m.location_lat, m.location_lng) ?? (m.league_id ? homePlace.get(m.league_id) ?? null : null),
    });
  }

  const counts = new Map<string, number>();
  for (const r of (candidateMemberRows ?? []) as { league_id: string }[]) {
    counts.set(r.league_id, (counts.get(r.league_id) ?? 0) + 1);
  }
  const requested = new Set(((requestRows ?? []) as { league_id: string }[]).map(r => r.league_id));
  const inSeason = new Set(((candidateSeasonRows ?? []) as { league_id: string }[]).map(r => r.league_id));
  const openLeagues: HomeOpenLeague[] = candidates.map(l => ({
    id: l.id,
    name: l.name,
    home_court: l.home_court ?? null,
    is_open: l.is_open ?? null,
    lat: typeof l.home_court_lat === 'number' ? l.home_court_lat : null,
    lng: typeof l.home_court_lng === 'number' ? l.home_court_lng : null,
    memberCount: counts.get(l.id) ?? 0,
    requested: requested.has(l.id),
    inSeason: inSeason.has(l.id),
  }));

  const openTournaments: HomeOpenTournament[] = openTours.map(t => ({
    id: t.id,
    name: t.name,
    start_time: t.start_time ?? null,
    location_name: t.location_name ?? null,
    lat: typeof t.location_lat === 'number' ? t.location_lat : null,
    lng: typeof t.location_lng === 'number' ? t.location_lng : null,
    leagueName: t.league_id ? knownNames.get(t.league_id) ?? null : null,
    formatLabel: formatLabelOf(t.format, t.match_type),
  }));

  // The bell's dot: unread notices whose target still exists. Only the newest
  // UNREAD_PROBE are checked; past that, the unchecked rest count as live
  // (unknown is not gone). If the probe read failed, fall back to the count.
  const unreadCount = unreadRes.count ?? 0;
  const unreadLive = unreadProbe
    ? unreadProbe.filter(n => !missingUnread.has(n.id)).length + Math.max(0, unreadCount - unreadProbe.length)
    : unreadCount;

  return {
    profile: (profile ?? null) as Profile | null,
    unreadCount,
    unreadLive,
    inbox,
    inLeague: members.length > 0,
    streak: Math.max(0, Number((streakRow as { current_streak?: number } | null)?.current_streak ?? 0)),
    myLeagues,
    myTournaments,
    events: agendaEvents,
    drillsToday,
    drills,
    matches,
    openLeagues,
    openTournaments,
    openCapped: ((openTourRows ?? []) as unknown[]).length >= OPEN_TOURNAMENT_LIMIT
      || ((leagueRows ?? []) as unknown[]).length >= LEAGUE_FETCH_LIMIT,
  };
}
