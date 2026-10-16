// Home's "Friends at the courts" (docs/play-sessions-presence.md, Phase 1 step
// 8): the rows built from friends_at_courts().
//
//   NOW ......... Lakeside · Alex, Sam +2 · since 5:40 · til 7:30 PM     4 here
//   YOUR COURTS . Lakeside · 6 playing now · mostly 3.5–4.0 · 2 friends  ★
//
// PURE: no React, no Supabase. The RPC returns only the people this viewer may
// name (friends and closed-league mates, per each one's own setting), grouped
// by canonical court; everyone else at the court is `others_here`. Times are
// the device's zone (agenda.ts shortTime), the zone the viewer is standing in.
import { shortTime, calendarDayDiff } from './agenda';
import { crowdLineText, type CrowdNumbers } from './courtCrowd';
import { firstName } from './inboxRequests';

export type FriendAtCourt = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  is_close_friend: boolean;
  via_session: boolean;
  session_kind: string | null;
  checked_in_at: string;
  expires_at: string | null;
};

export type FriendsCourtGroup = {
  venue_id: string;
  venue_name: string;
  lat: number | null;
  lng: number | null;
  since: string;
  until: string | null;
  people: FriendAtCourt[];
  /** Everyone else checked in there (anonymous to this viewer). */
  others_here: number;
};

export type YourCourtReason = 'favorite' | 'home' | 'frequent';

export type YourCourt = CrowdNumbers & {
  venue_id: string;
  venue_name: string;
  reason: YourCourtReason;
};

export type FriendsAtCourts = { now: FriendsCourtGroup[]; courts: YourCourt[] };

export const EMPTY_FRIENDS_AT_COURTS: FriendsAtCourts = { now: [], courts: [] };

/** Names on a NOW row before the rest collapse into "+N". */
export const NAMES_SHOWN = 2;

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
// numeric columns can arrive as strings through jsonb
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Infinity : t;
};
const int = (v: unknown): number => Math.max(0, Math.floor(num(v) ?? 0));
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object') : []);

function normalizePerson(p: Obj): FriendAtCourt | null {
  const id = str(p.user_id);
  const at = str(p.checked_in_at);
  if (!id || !at) return null;
  return {
    user_id: id,
    full_name: str(p.full_name),
    avatar_url: str(p.avatar_url),
    avatar_emoji: str(p.avatar_emoji),
    avatar_bg_color: str(p.avatar_bg_color),
    is_close_friend: p.is_close_friend === true,
    via_session: p.via_session === true,
    session_kind: str(p.session_kind),
    checked_in_at: at,
    expires_at: str(p.expires_at),
  };
}

function isReason(v: unknown): v is YourCourtReason {
  return v === 'favorite' || v === 'home' || v === 'frequent';
}

/** The RPC's jsonb as a complete FriendsAtCourts: rows missing an id are
 *  dropped, a group with nobody left in it is dropped, counts are >= 0. */
export function normalizeFriendsAtCourts(raw: unknown): FriendsAtCourts {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Obj;
  const now: FriendsCourtGroup[] = [];
  for (const g of list(r.now)) {
    const venueId = str(g.venue_id);
    const people = list(g.people).map(normalizePerson).filter((p): p is FriendAtCourt => p != null);
    if (!venueId || people.length === 0) continue;
    const since =
      str(g.since) ?? people.reduce((m, p) => (ms(p.checked_in_at) < ms(m) ? p.checked_in_at : m), people[0].checked_in_at);
    now.push({
      venue_id: venueId,
      venue_name: str(g.venue_name) ?? 'A court',
      lat: num(g.lat),
      lng: num(g.lng),
      since,
      until: str(g.until),
      people,
      others_here: int(g.others_here),
    });
  }
  const courts: YourCourt[] = [];
  for (const c of list(r.courts)) {
    const venueId = str(c.venue_id);
    if (!venueId) continue;
    courts.push({
      venue_id: venueId,
      venue_name: str(c.venue_name) ?? 'A court',
      reason: isReason(c.reason) ? c.reason : 'frequent',
      here_now: int(c.here_now),
      band_low: num(c.band_low),
      band_high: num(c.band_high),
      friends_here: int(c.friends_here),
    });
  }
  return { now, courts };
}

export function isFriendsAtCourtsEmpty(d: FriendsAtCourts | null | undefined): boolean {
  return !d || (d.now.length === 0 && d.courts.length === 0);
}

/** Close friends first, then by arrival (earliest first). */
export function orderPeople(people: readonly FriendAtCourt[]): FriendAtCourt[] {
  return people
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      if (a.p.is_close_friend !== b.p.is_close_friend) return a.p.is_close_friend ? -1 : 1;
      return ms(a.p.checked_in_at) - ms(b.p.checked_in_at) || a.i - b.i;
    })
    .map((x) => x.p);
}

/** "Alex", "Alex, Sam", "Alex, Sam +2" (first names; close friends first). */
export function peopleLine(people: readonly FriendAtCourt[], shown = NAMES_SHOWN): string {
  const ordered = orderPeople(people);
  const names = ordered.slice(0, shown).map((p) => firstName(p.full_name) ?? 'Player');
  const rest = ordered.length - names.length;
  return rest > 0 ? `${names.join(', ')} +${rest}` : names.join(', ');
}

/** "since 5:40 · til 7:30 PM": the meridiem is said once when both ends share
 *  it on the same day. No end time: "since 5:40 PM". */
export function sinceUntilLabel(since: string, until: string | null | undefined): string {
  const s = new Date(since);
  if (Number.isNaN(s.getTime())) return '';
  const u = until ? new Date(until) : null;
  if (!u || Number.isNaN(u.getTime())) return `since ${shortTime(s)}`;
  const sameHalf = calendarDayDiff(s, u) === 0 && s.getHours() < 12 === u.getHours() < 12;
  const sinceText = sameHalf ? shortTime(s).replace(/ [AP]M$/, '') : shortTime(s);
  return `since ${sinceText} · til ${shortTime(u)}`;
}

/** A NOW row: "Lakeside" over "Alex, Sam +2 · since 5:40 · til 7:30 PM", and
 *  everyone checked in there on the right ("4 here"). */
export function friendsCourtRow(g: FriendsCourtGroup): { title: string; subtitle: string; trailing: string } {
  const when = sinceUntilLabel(g.since, g.until);
  return {
    title: g.venue_name,
    subtitle: when ? `${peopleLine(g.people)} · ${when}` : peopleLine(g.people),
    trailing: `${g.people.length + g.others_here} here`,
  };
}

export function yourCourtReasonLabel(reason: YourCourtReason): string {
  switch (reason) {
    case 'favorite':
      return 'Your court';
    case 'home':
      return 'League home court';
    case 'frequent':
      return 'You play here often';
  }
}

/** A YOUR COURTS row's subtitle: the crowd line, or why the court is listed
 *  when nobody is there ("League home court · No one checked in now"). */
export function yourCourtSubtitle(c: YourCourt): string {
  return crowdLineText(c) ?? `${yourCourtReasonLabel(c.reason)} · No one checked in now`;
}

/** Drops people whose check-in has ended by `now` (a cached payload read on a
 *  cold start can be hours old) and any court left with nobody. */
export function liveOnly(d: FriendsAtCourts, now: number): FriendsAtCourts {
  const groups = d.now
    .map((g) => ({ ...g, people: g.people.filter((p) => !p.expires_at || ms(p.expires_at) > now) }))
    .filter((g) => g.people.length > 0);
  return groups.length === d.now.length && groups.every((g, i) => g.people.length === d.now[i].people.length)
    ? d
    : { ...d, now: groups };
}
