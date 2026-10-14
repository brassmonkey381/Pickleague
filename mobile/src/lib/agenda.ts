// Home's UP NEXT list and the LEAGUE SPOTLIGHT's facts (plan section 3, data
// rule 2 and 3): which league the spotlight opens on, its header line and its
// one "Next: ... · 1 vote open" line.
//
// PURE: no React, no Supabase, no clock of its own (every function takes
// `now`). HomeScreen's loader turns rows from league_events / event_slots /
// event_slot_votes / event_declines / tournament_registrations / drill_sessions
// into the plain inputs below; this module decides what needs the viewer, in
// what order, and how each row's time reads. That split is what the vitest
// suite (lib/__tests__/agenda.test.ts) pins down.
//
// Ordering (rule 2): live first, then needs-you by deadline, then scheduled by
// time (today, then the rest of the next 7 days). The time math is the
// foundation's bucketByTime (DST-safe calendar days, live windows); this file
// only adds the Pickleague rules on top:
//   - a tournament in progress is live because of its STATUS, not its clock
//     (tournaments.start_time is the start of day one, and play runs for hours
//     or days after it), so those rows go ahead of the time buckets;
//   - a confirmed event is live for 24h from its start, the same window
//     EventDetailScreen uses for "open for recording matches";
//   - a vote has a deadline but no time of its own, so an open vote that is
//     still yours to cast is needs-you, and one you've cast is not "up next";
//   - "later" (8+ days out, or undated) is never on Home: the list is the week.
//
// Phase 3 adds the REQUESTS (lib/inboxRequests.ts maps them): match scores
// waiting on my confirmation, tournament invites (here, from my
// registrations), drill requests sent to me and, for leagues I run, pending
// join requests. A request has a deadline (or an age), not a time of its own,
// so like a vote it has no `startsAt` and is always needs-you. Every needs-you
// item is also what the Home bell counts (`needsYouCount`).
import { bucketByTime } from '@just-messin-around/expo-foundation/scheduling/bucketByTime';

/** Rows shown before "Show N more". */
export const AGENDA_PREVIEW = 3;
/** "Show N more" expands inline up to this many rows (no agenda screen). */
export const AGENDA_CAP = 10;
/** A confirmed event counts as live for this long after its slot starts
 *  (EventDetailScreen's LIVE_WINDOW_MS). */
export const EVENT_LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type AgendaKind =
  | 'vote'
  | 'event'
  | 'tournament'
  | 'drill'
  | 'match_confirm'
  | 'drill_request'
  | 'join_request'
  // A doubles-partner / MLP-team invite to me (lib/inboxRequests).
  | 'team_invite';

/** Needs-you kinds that are someone's request of me (the ones Notifications'
 *  Requests chip files). A vote or an RSVP needs me too, but nobody sent it. */
const REQUEST_AGENDA_KINDS: ReadonlySet<AgendaKind> = new Set<AgendaKind>([
  'tournament', 'match_confirm', 'drill_request', 'join_request', 'team_invite',
]);

/** Where a row (or its button) goes. Mirrors RootStackParamList's params. */
export type AgendaTarget =
  | { screen: 'EventDetail'; params: { eventId: string; title: string; focus?: 'vote' | 'rsvp' } }
  | { screen: 'TournamentDetail'; params: { tournamentId: string; tournamentName: string; focus?: 'invite' | 'next_match' } }
  | { screen: 'DrillRequests'; params: { focusId?: string } }
  // A match score waiting on me: MatchHistory scrolled to it, where its
  // Confirm button lives (the same landing as the 'match/' push). Confirming
  // is never inline: it fires the ratings / payout cascade (decision 1).
  | { screen: 'MatchHistory'; params: { title: string; initialMyMatchesOnly: true; highlightMatchId: string } }
  // Pending join requests for a league I run (the 'league_members/' landing).
  | { screen: 'LeagueMembers'; params: { leagueId: string; leagueName: string } };

export type AgendaItem = {
  key: string;
  kind: AgendaKind;
  title: string;
  /** Every row names its league (when it has one). */
  leagueName: string | null;
  /** When it happens (ISO). null for a vote: it has a deadline, not a time. */
  startsAt: string | null;
  endsAt: string | null;
  /** Live by status, whatever the clock says (a tournament in progress). */
  forceLive?: boolean;
  needsYou: boolean;
  /** When the viewer's action is due; orders the needs-you rows. */
  deadline: string | null;
  /** The short state after the league name: "you haven't voted", "RSVP open". */
  status: string | null;
  /** A request without a deadline: when it was made (ISO). The "when" column
   *  then shows its age ("2d ago") instead of a time. */
  requestedAt?: string | null;
  /** Row tap: plain navigation to the detail screen. */
  target: AgendaTarget;
  /** The row's button ([Vote] / [RSVP] / [Next match]); it opens the detail
   *  screen AT that control (a `focus` param). Never an inline write (plan
   *  decision 1). null = a chevron. */
  action: { label: string; target: AgendaTarget; /** home.tap target slug. */ slug?: string } | null;
  /** A drill session the viewer may hide from Home (its ✕). */
  dismissibleDrillId?: string;
};

export type AgendaBucket = 'live' | 'needsYou' | 'today' | 'thisWeek';
export type AgendaRow = AgendaItem & { bucket: AgendaBucket };

// ── Inputs ──────────────────────────────────────────────────────────────────

export type AgendaEventInput = {
  id: string;
  title: string;
  leagueName: string | null;
  status: 'voting' | 'scheduled' | string;
  voteEndsAt: string | null;
  /** The confirmed slot (scheduled events). */
  slot: { startsAt: string; endsAt: string | null } | null;
  /** Voting: I picked at least one time. Scheduled: I'm in for the confirmed time. */
  iVoted: boolean;
  /** "I can't make it" (event_declines). */
  iDeclined: boolean;
};

export type AgendaTournamentInput = {
  id: string;
  name: string;
  leagueName: string | null;
  startTime: string | null;
  /** tournaments.status */
  status: string;
  /** tournament_registrations.status */
  myStatus: 'approved' | 'pending' | 'waitlisted' | string;
  /** The pending registration is an invite (invited_by set). */
  invited: boolean;
  /** tournaments.registration_closes_at: an invite's deadline (else the
   *  start). Absent in a payload cached before P3. */
  registrationClosesAt?: string | null;
};

export type AgendaDrillInput = {
  id: string;
  partnerName: string;
  startsAt: string;
  lengthMinutes: number;
};

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

function eventTarget(id: string, title: string, focus?: 'vote' | 'rsvp'): AgendaTarget {
  return { screen: 'EventDetail', params: focus ? { eventId: id, title, focus } : { eventId: id, title } };
}

/** League events -> agenda items. Votes you still owe and confirmed events you
 *  haven't declined; everything else (a vote you've cast, a closed vote, an
 *  event you said you'd miss, one that ended) is not up next. */
export function eventAgendaItems(events: readonly AgendaEventInput[], now: number): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const e of events) {
    if (e.status === 'voting') {
      const ends = ms(e.voteEndsAt);
      if (ends == null || ends <= now) continue;
      if (e.iVoted || e.iDeclined) continue;
      out.push({
        key: `vote-${e.id}`,
        kind: 'vote',
        title: `Vote: ${e.title}`,
        leagueName: e.leagueName,
        startsAt: null,
        endsAt: null,
        needsYou: true,
        deadline: e.voteEndsAt,
        status: "you haven't voted",
        target: eventTarget(e.id, e.title),
        action: { label: 'Vote', target: eventTarget(e.id, e.title, 'vote'), slug: 'vote' },
      });
      continue;
    }
    if (e.status !== 'scheduled' || !e.slot) continue;
    if (e.iDeclined) continue;
    const start = ms(e.slot.startsAt);
    if (start == null) continue;
    const liveEnd = start + EVENT_LIVE_WINDOW_MS;
    if (liveEnd <= now) continue;
    // RSVP stays open until the confirmed time ENDS (EventDetail's rsvpOpen).
    const slotEnd = ms(e.slot.endsAt) ?? start + 2 * HOUR_MS;
    const rsvpOpen = !e.iVoted && now < slotEnd;
    out.push({
      key: `event-${e.id}`,
      kind: 'event',
      title: e.title,
      leagueName: e.leagueName,
      startsAt: e.slot.startsAt,
      endsAt: new Date(liveEnd).toISOString(),
      needsYou: rsvpOpen,
      deadline: rsvpOpen ? e.slot.startsAt : null,
      status: e.iVoted ? "you're in" : 'RSVP open',
      target: eventTarget(e.id, e.title),
      action: rsvpOpen ? { label: 'RSVP', target: eventTarget(e.id, e.title, 'rsvp'), slug: 'rsvp' } : null,
    });
  }
  return out;
}

function tournamentTarget(id: string, name: string, focus?: 'invite' | 'next_match'): AgendaTarget {
  return {
    screen: 'TournamentDetail',
    params: focus ? { tournamentId: id, tournamentName: name, focus } : { tournamentId: id, tournamentName: name },
  };
}

/** My live tournament registrations -> agenda items. A pending invite is a
 *  request (needs-you, due when registration closes, else at the start) until
 *  that deadline passes; with `now` omitted the deadline isn't checked. An
 *  undated registration that needs nothing is "later" and so only shows under
 *  the spotlight's "My tournaments (N)". */
export function tournamentAgendaItems(regs: readonly AgendaTournamentInput[], now?: number): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const r of regs) {
    if (r.status === 'completed' || r.status === 'cancelled') continue;
    const inProgress = r.status === 'active' && r.myStatus === 'approved';
    const invited = r.myStatus === 'pending' && r.invited;
    const inviteDue = invited ? (r.registrationClosesAt || r.startTime || null) : null;
    const dueMs = ms(inviteDue);
    const inviteOpen = invited && (now == null || dueMs == null || dueMs > now);
    const status = inProgress
      ? 'in progress'
      : invited
        ? 'invited'
        : r.myStatus === 'pending'
          ? 'requested'
          : r.myStatus === 'waitlisted'
            ? 'waitlisted'
            : 'registered';
    out.push({
      key: `tournament-${r.id}`,
      kind: 'tournament',
      title: r.name,
      leagueName: r.leagueName,
      startsAt: r.startTime,
      endsAt: null,
      forceLive: inProgress,
      needsYou: inviteOpen,
      deadline: inviteOpen ? inviteDue : null,
      status,
      target: tournamentTarget(r.id, r.name),
      // Accept charges the entry fee, so it opens the screen at the invite
      // (inline Accept waits for P4's useTournamentInvite, decision 1).
      action: inProgress
        ? { label: 'Next match', target: tournamentTarget(r.id, r.name, 'next_match'), slug: 'next_match' }
        : invited
          ? { label: 'Respond', target: tournamentTarget(r.id, r.name, 'invite'), slug: 'invite' }
          : null,
    });
  }
  return out;
}

/** Today's drill sessions -> agenda items, each with its own ✕ (the old
 *  duplicate drill banners are gone; their dismiss lives on the row). */
export function drillAgendaItems(drills: readonly AgendaDrillInput[]): AgendaItem[] {
  return drills.map((d) => {
    const start = ms(d.startsAt);
    const len = Number.isFinite(d.lengthMinutes) && d.lengthMinutes > 0 ? d.lengthMinutes : 60;
    return {
      key: `drill-${d.id}`,
      kind: 'drill' as const,
      title: `Drill with ${d.partnerName}`,
      leagueName: null,
      startsAt: d.startsAt,
      endsAt: start != null ? new Date(start + len * 60_000).toISOString() : null,
      needsYou: false,
      deadline: null,
      status: null,
      target: { screen: 'DrillRequests' as const, params: { focusId: d.id } },
      action: null,
      dismissibleDrillId: d.id,
    };
  });
}

// ── Ordering ────────────────────────────────────────────────────────────────

export type AgendaResult = {
  /** In display order, capped at `cap`. */
  rows: AgendaRow[];
  /** Every row that qualified, before the cap (so "N more" is honest). */
  total: number;
  /** How many of the rows past the cap are requests (REQUEST_AGENDA_KINDS),
   *  so Up next's "+N more" can open the inbox on its Requests chip.
   *  Optional: an AgendaResult built by hand (tests, older callers) is 0. */
  hiddenRequests?: number;
};

/** Live first, then needs-you by deadline, then today and the rest of the week
 *  by start. Anything later than the week never makes the list. */
export function buildAgenda(
  items: readonly AgendaItem[],
  now: number,
  opts: { cap?: number; weekDays?: number; timeZone?: string } = {},
): AgendaResult {
  const cap = opts.cap ?? AGENDA_CAP;
  const forced = items.filter((i) => i.forceLive);
  const rest = items.filter((i) => !i.forceLive);
  const b = bucketByTime(rest, {
    now,
    getStart: (i) => i.startsAt,
    getEnd: (i) => i.endsAt,
    isNeedsYou: (i) => i.needsYou,
    getDeadline: (i) => i.deadline,
    weekDays: opts.weekDays ?? 7,
    timeZone: opts.timeZone,
  });
  const tag = (bucket: AgendaBucket) => (i: AgendaItem): AgendaRow => ({ ...i, bucket });
  const all: AgendaRow[] = [
    ...forced.map(tag('live')),
    ...b.live.map(tag('live')),
    ...b.needsYou.map(tag('needsYou')),
    ...b.today.map(tag('today')),
    ...b.thisWeek.map(tag('thisWeek')),
  ];
  const capped = Math.max(0, cap);
  const hiddenRequests = all.slice(capped).filter((r) => r.needsYou && REQUEST_AGENDA_KINDS.has(r.kind)).length;
  return { rows: all.slice(0, capped), total: all.length, hiddenRequests };
}

/** What the Home bell counts: every needs-you item that is still current
 *  (live, upcoming or undated, i.e. anything buildAgenda keeps), uncapped.
 *  Built from the source rows, so a request whose target was deleted can
 *  never be counted; plain unread notifications are only the bell's dot. */
export function needsYouCount(items: readonly AgendaItem[], now: number): number {
  return buildAgenda(items, now, { cap: Infinity }).rows.filter((r) => r.needsYou).length;
}

/** How many rows a capped list shows and what its "Show N more" says.
 *  `expanded` = the user tapped "Show N more" (inline, up to the cap). */
export function agendaVisible(
  result: AgendaResult,
  expanded: boolean,
  preview: number = AGENDA_PREVIEW,
): { shown: AgendaRow[]; moreInline: number; beyondCap: number } {
  const shown = expanded ? result.rows : result.rows.slice(0, preview);
  return {
    shown,
    moreInline: expanded ? 0 : Math.max(0, result.rows.length - shown.length),
    beyondCap: Math.max(0, result.total - result.rows.length),
  };
}

// ── Time labels (deterministic: no Intl, the device's zone) ─────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "6 PM", "6:30 PM", "12 AM". */
export function shortTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Calendar days from `now`'s day to `d`'s day, in the device zone (DST-safe:
 *  counted on y/m/d, never ms / 86400000). */
export function calendarDayDiff(d: Date, now: Date): number {
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / DAY_MS);
}

/** "Today", "Tmrw", "Thu" (this week), "Nov 2" (further). */
export function dayLabel(d: Date, now: Date): string {
  const diff = calendarDayDiff(d, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tmrw';
  if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Thu 6 PM" / "today 6 PM" / "Nov 2 6 PM", for a subtitle. */
export function whenPhrase(iso: string, now: number): string | null {
  const t = ms(iso);
  if (t == null) return null;
  const d = new Date(t);
  const day = dayLabel(d, new Date(now));
  return `${day === 'Today' ? 'today' : day === 'Tmrw' ? 'tomorrow' : day} ${shortTime(d)}`;
}

/** Time left until a deadline: "45m", "5h", "1d". "now" once it has passed. */
export function timeLeft(iso: string | null, now: number): string | null {
  const t = ms(iso);
  if (t == null) return null;
  const left = t - now;
  if (left <= 0) return 'now';
  if (left < HOUR_MS) return `${Math.max(1, Math.floor(left / 60_000))}m`;
  if (left < DAY_MS) return `${Math.floor(left / HOUR_MS)}h`;
  return `${Math.floor(left / DAY_MS)}d`;
}

/** How long ago: "5m", "3h", "2d". "now" under a minute (or in the future). */
export function timeAgoShort(iso: string | null | undefined, now: number): string | null {
  const t = ms(iso);
  if (t == null) return null;
  const ago = now - t;
  if (ago < 60_000) return 'now';
  if (ago < HOUR_MS) return `${Math.floor(ago / 60_000)}m`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)}h`;
  return `${Math.floor(ago / DAY_MS)}d`;
}

/** The two-line "when" column at the start of an Up next row. */
export function agendaWhen(row: AgendaRow, now: number): { top: string; bottom: string | null } {
  if (row.bucket === 'live') return { top: 'Now', bottom: null };
  if (row.kind === 'vote') return { top: timeLeft(row.deadline, now) ?? '', bottom: 'left' };
  const t = ms(row.startsAt);
  if (t == null) {
    // A request: its time left, else its age.
    const left = timeLeft(row.deadline, now);
    if (left) return { top: left, bottom: 'left' };
    const age = timeAgoShort(row.requestedAt, now);
    if (age) return age === 'now' ? { top: 'New', bottom: null } : { top: age, bottom: 'ago' };
    return { top: '', bottom: null };
  }
  const d = new Date(t);
  return { top: dayLabel(d, new Date(now)), bottom: shortTime(d) };
}

// ── LEAGUE SPOTLIGHT: which league, and its one-line facts ──────────────────

export type SeasonInput = {
  status: 'active' | 'upcoming' | string;
  /** league_seasons.start_date (a Postgres date, "YYYY-MM-DD"). */
  startDate: string;
  totalWeeks: number;
  /** league_seasons.name ("Fall"). Absent in a payload cached before it existed. */
  name?: string | null;
};

function dateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The active season's week, 1-based and clamped to the season: {7, 12}. */
export function seasonWeek(season: SeasonInput, now: number): { week: number; total: number } | null {
  if (season.status !== 'active') return null;
  const start = dateOnly(season.startDate);
  const total = Math.floor(season.totalWeeks);
  if (!start || !Number.isFinite(total) || total < 1) return null;
  const days = calendarDayDiff(new Date(now), start);
  const week = Math.min(total, Math.max(1, Math.floor(days / 7) + 1));
  return { week, total };
}

export type SpotlightLeagueInput = {
  id: string;
  /** Open votes in this league that end in the future. */
  openVotes: number;
  /** When the soonest-ending open vote closes (ISO). */
  openVoteEndsAt?: string | null;
  /** The next confirmed event's start (ISO), if any. */
  nextEventAt: string | null;
  /** The league's active season, else its upcoming one. */
  season: SeasonInput | null;
  /** The league's newest match (ISO). Absent = unknown. */
  lastMatchAt?: string | null;
};

/** Ascending, unknowns last. */
function ascNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

/**
 * The league the spotlight opens on when the user hasn't picked one: the most
 * active. An open vote first (the one closing soonest), else the soonest next
 * event, else an active season, else the most recent match; ties go to the
 * newest match, then to list order. null only for no leagues.
 */
export function pickSpotlightLeague(leagues: readonly SpotlightLeagueInput[], now: number): string | null {
  if (leagues.length === 0) return null;
  const ranked = leagues.map((l, i) => {
    const next = ms(l.nextEventAt);
    const upcoming = next != null && next > now ? next : null;
    const tier = l.openVotes > 0 ? 0 : upcoming != null ? 1 : l.season?.status === 'active' ? 2 : 3;
    return { l, i, tier, upcoming, voteEnds: ms(l.openVoteEndsAt), last: ms(l.lastMatchAt) };
  });
  ranked.sort((a, b) =>
    a.tier - b.tier
    || (a.tier === 0 ? ascNullsLast(a.voteEnds, b.voteEnds) : 0)
    || (a.tier <= 1 ? ascNullsLast(a.upcoming, b.upcoming) : 0)
    // Newest match first: negate so "ascending" means latest.
    || ascNullsLast(a.last == null ? null : -a.last, b.last == null ? null : -b.last)
    || a.i - b.i);
  return ranked[0].l.id;
}

/** The card's header line: "Dinks · Fall · Wk 7/12", "Dinks · Spring · starts
 *  Nov 2", or just the league's name with no season. */
export function spotlightHeaderLine(l: { name: string; season: SeasonInput | null }, now: number): string {
  const parts = [l.name];
  const s = l.season;
  if (s) {
    if (s.name && s.name.trim()) parts.push(s.name.trim());
    const wk = seasonWeek(s, now);
    if (wk) parts.push(`Wk ${wk.week}/${wk.total}`);
    else if (s.status === 'upcoming') {
      const start = dateOnly(s.startDate);
      if (start) parts.push(`starts ${MONTHS[start.getMonth()]} ${start.getDate()}`);
    }
  }
  return parts.join(' · ');
}

/** The card's one "what's next" line: "Next: Thu 6 PM · 1 vote open", "Next:
 *  today 6 PM", "2 votes open", or null with neither. */
export function spotlightNextLine(f: { openVotes: number; nextEventAt: string | null }, now: number): string | null {
  const t = ms(f.nextEventAt);
  const next = t != null && t > now ? whenPhrase(f.nextEventAt as string, now) : null;
  const votes = f.openVotes > 0 ? (f.openVotes === 1 ? '1 vote open' : `${f.openVotes} votes open`) : null;
  if (next) return votes ? `Next: ${next} · ${votes}` : `Next: ${next}`;
  return votes;
}
