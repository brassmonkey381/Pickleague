// The things other people are waiting on ME for (plan section 8, P3), and the
// notification-list rules that go with them.
//
//   1. REQUESTS for Home's UP NEXT (lib/agenda.ts orders them; each is a
//      needs-you item, so it is also what the Home bell counts):
//        - a match score waiting on my team's confirmation (matches pending,
//          my team's *_confirmed_by still null, inside its 1-hour window),
//          which opens MatchHistory at that match. NEVER confirmed inline:
//          confirm_match fires the ratings / payout cascade (decision 1).
//        - a drill request sent to me (drill_requests pending, to_user_id =
//          me, a proposed time still ahead), which opens DrillRequests on it.
//        - (not a request, a plain scheduled row) a drill request I sent that
//          is still waiting, when a proposed time falls inside the week.
//        - for a league I run (admin / co-admin), its pending join requests,
//          one row per league, which opens LeagueMembers (pending first).
//        - a doubles-partner or MLP-team invite to me (pending, direction
//          'invite', its pair / team still forming), which opens the
//          tournament, where its Pairs / Teams section answers it.
//      Tournament invites are requests too; they come from my registrations,
//      which Home already loads, so agenda.tournamentAgendaItems maps them.
//   2. NOTIFICATIONS: the filter chips (keyed on entity_type / category /
//      push_data.kind, never on the legacy `type` column, which says
//      'tournament' for every payout, badge and pickle notice), the day groups,
//      and the "target was deleted" check.
//
// The mapping is PURE (no React, no Supabase client, no clock: every function
// takes `now`), and lib/__tests__/inboxRequests.test.ts pins it down. The two
// loaders at the bottom take the client as an argument instead of importing
// it, so this module stays importable from a plain Node test.
//
// RLS: every read here is one existing policies allow. matches, leagues,
// tournaments, league_events: readable by everyone. drill_requests and
// drill_sessions: participants only (a notification about a drill goes to a
// participant). league_join_requests: "Admins can view league requests"
// (league_members role admin / co-admin). doubles_pairs,
// doubles_pair_join_requests, mlp_teams, mlp_team_join_requests: readable by
// everyone. notifications: own rows.
import type { sbCall } from '@just-messin-around/expo-foundation/supabase';
import type { supabase as SupabaseSingleton } from './supabase';
import { calendarDayDiff, type AgendaItem } from './agenda';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** drill_requests.proposed_slots: half-hour slots of a local day. */
const SLOT_MINUTES = 30;

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** PostgREST hands a to-one embed back as an object, or (for some FK shapes) a
 *  one-element array. */
type Embed<T> = T | T[] | null | undefined;
function one<T>(e: Embed<T>): T | null {
  if (Array.isArray(e)) return e[0] ?? null;
  return e ?? null;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

/** "Sam Kim" -> "Sam". Rows name people by first name to stay one line. */
export function firstName(full: string | null | undefined): string | null {
  const t = (full ?? '').trim();
  if (!t) return null;
  return t.split(/\s+/)[0];
}

// ── 1. Requests ─────────────────────────────────────────────────────────────

type NameEmbed = Embed<{ full_name: string | null }>;

export type MatchConfirmRow = {
  id: string;
  status: string;
  match_type: string | null;
  player1_id: string;
  partner1_id: string | null;
  player2_id: string;
  partner2_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  team1_confirmed_by: string | null;
  team2_confirmed_by: string | null;
  confirm_deadline: string | null;
  created_at: string | null;
  league?: Embed<{ name: string | null }>;
  player1?: NameEmbed;
  partner1?: NameEmbed;
  player2?: NameEmbed;
  partner2?: NameEmbed;
};

function teamNames(a: NameEmbed, b: NameEmbed): string | null {
  const names = [firstName(one(a)?.full_name), firstName(one(b)?.full_name)].filter((n): n is string => !!n);
  return names.length ? names.join(' & ') : null;
}

/**
 * Pending matches -> "Confirm 11–7 vs Sam" rows, for the matches MY team
 * still has to confirm (MatchHistoryScreen's canCallerConfirm rule) and whose
 * window is still open (confirm_match refuses an expired one, and the cron
 * deletes it). Due at confirm_deadline, so it sorts to the top of needs-you.
 */
export function matchConfirmItems(rows: readonly MatchConfirmRow[], uid: string, now: number): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const m of rows) {
    if (m.status !== 'pending') continue;
    const due = ms(m.confirm_deadline);
    if (due != null && due <= now) continue;
    const onTeam1 = uid === m.player1_id || uid === m.partner1_id;
    const onTeam2 = uid === m.player2_id || uid === m.partner2_id;
    const mine = onTeam1 && !m.team1_confirmed_by ? 1 : onTeam2 && !m.team2_confirmed_by ? 2 : null;
    if (mine == null) continue;
    const opponents = mine === 1 ? teamNames(m.player2, m.partner2) : teamNames(m.player1, m.partner1);
    const myScore = mine === 1 ? m.player1_score : m.player2_score;
    const theirScore = mine === 1 ? m.player2_score : m.player1_score;
    const score = typeof myScore === 'number' && typeof theirScore === 'number' ? `${myScore}–${theirScore}` : null;
    const title = `Confirm ${score ?? 'match'}${opponents ? ` vs ${opponents}` : ''}`;
    const target = {
      screen: 'MatchHistory' as const,
      params: { title: 'Match History', initialMyMatchesOnly: true as const, highlightMatchId: m.id },
    };
    out.push({
      key: `confirm-${m.id}`,
      kind: 'match_confirm',
      title,
      leagueName: one(m.league)?.name ?? null,
      startsAt: null,
      endsAt: null,
      needsYou: true,
      deadline: m.confirm_deadline,
      status: 'confirm the score',
      requestedAt: m.created_at,
      target,
      action: { label: 'Review', target, slug: 'confirm_match' },
    });
  }
  return out;
}

export type DrillRequestRow = {
  id: string;
  status: string;
  proposed_slots: unknown;
  created_at: string | null;
  from_profile?: NameEmbed;
};

/** proposed_slots entries ({date: 'YYYY-MM-DD', slot: 0..47}) -> start times
 *  (ms, the device's zone, like every drill time in the app). Malformed
 *  entries drop out. */
export function proposedSlotStarts(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const s of raw) {
    const date = (s as { date?: unknown })?.date;
    const slot = (s as { slot?: unknown })?.slot;
    if (typeof date !== 'string' || typeof slot !== 'number' || !Number.isFinite(slot)) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) continue;
    // Minutes go through the Date constructor, not added as milliseconds to
    // midnight: on a DST day (23 or 25 hours) the latter lands an hour off
    // the wall clock for every slot after the change (homeData.drillStart
    // resolves it the same way).
    const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, slot * SLOT_MINUTES).getTime();
    if (Number.isFinite(start)) out.push(start);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Drill requests sent to me -> "Drill request from Sam" rows. Due at the
 * first proposed time still ahead; once every proposed time has passed the
 * request can't be accepted, so it isn't up next any more. A request with no
 * readable times stays (undated, ordered by age).
 */
export function drillRequestItems(rows: readonly DrillRequestRow[], now: number): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const r of rows) {
    if (r.status !== 'pending') continue;
    const starts = proposedSlotStarts(r.proposed_slots);
    const ahead = starts.filter((t) => t > now);
    if (starts.length > 0 && ahead.length === 0) continue;
    const who = firstName(one(r.from_profile)?.full_name) ?? 'a player';
    const target = { screen: 'DrillRequests' as const, params: { focusId: r.id } };
    out.push({
      key: `drill-request-${r.id}`,
      kind: 'drill_request',
      title: `Drill request from ${who}`,
      leagueName: null,
      startsAt: null,
      endsAt: null,
      needsYou: true,
      deadline: ahead.length ? new Date(ahead[0]).toISOString() : null,
      status: 'pick a time',
      requestedAt: r.created_at,
      target,
      action: { label: 'Respond', target, slug: 'drill_request' },
    });
  }
  return out;
}

/** A drill request I sent (drill_requests pending, from_user_id = me). */
export type SentDrillRequestRow = {
  id: string;
  status: string;
  proposed_slots: unknown;
  created_at: string | null;
  to_profile?: NameEmbed;
};

/**
 * Drill requests I sent that are still waiting -> "Waiting on Sam" rows: plain
 * scheduled rows (nothing for me to do) at the first proposed time still
 * ahead, shown only when that time is inside the week (7 calendar days). A
 * zero-length span so a proposed time that passes never reads as live.
 */
export function drillWaitingItems(rows: readonly SentDrillRequestRow[], now: number): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const r of rows) {
    if (r.status !== 'pending') continue;
    const next = proposedSlotStarts(r.proposed_slots).find((t) => t > now);
    if (next == null || calendarDayDiff(new Date(next), new Date(now)) >= 7) continue;
    const who = firstName(one(r.to_profile)?.full_name) ?? 'your partner';
    const startsAt = new Date(next).toISOString();
    out.push({
      key: `drill-waiting-${r.id}`,
      kind: 'drill_waiting',
      title: `Waiting on ${who}`,
      leagueName: null,
      startsAt,
      endsAt: startsAt,
      needsYou: false,
      deadline: null,
      status: 'drill request sent',
      requestedAt: r.created_at,
      target: { screen: 'DrillRequests', params: { focusId: r.id } },
      action: null,
    });
  }
  return out;
}

export type JoinRequestRow = {
  id: string;
  league_id: string;
  user_id: string;
  created_at: string | null;
  requester?: NameEmbed;
};

/**
 * Pending join requests -> one row per league I run: "Sam wants to join", or
 * "3 join requests". Approving happens on LeagueMembers (pending first), so
 * one row is one place to act. Requests for a league not in `leagues` (I'm
 * not its admin) are ignored. No deadline: ordered by the oldest request.
 */
export function joinRequestItems(
  rows: readonly JoinRequestRow[],
  leagues: ReadonlyArray<{ id: string; name: string }>,
): AgendaItem[] {
  const names = new Map(leagues.map((l) => [l.id, l.name]));
  const byLeague = new Map<string, JoinRequestRow[]>();
  for (const r of rows) {
    if (!names.has(r.league_id)) continue;
    const list = byLeague.get(r.league_id) ?? [];
    list.push(r);
    byLeague.set(r.league_id, list);
  }
  const out: AgendaItem[] = [];
  for (const [leagueId, list] of byLeague) {
    const leagueName = names.get(leagueId)!;
    const oldest = list
      .map((r) => r.created_at)
      .filter((c): c is string => ms(c) != null)
      .sort((a, b) => (ms(a)! - ms(b)!))[0] ?? null;
    const who = list.length === 1 ? firstName(one(list[0].requester)?.full_name) : null;
    const title = list.length === 1 ? `${who ?? 'A player'} wants to join` : `${list.length} join requests`;
    const target = { screen: 'LeagueMembers' as const, params: { leagueId, leagueName } };
    out.push({
      key: `join-${leagueId}`,
      kind: 'join_request',
      title,
      leagueName,
      startsAt: null,
      endsAt: null,
      needsYou: true,
      deadline: null,
      status: 'waiting on you',
      requestedAt: oldest,
      target,
      action: { label: 'Review', target, slug: 'join_request' },
    });
  }
  return out;
}

type TeamTournamentEmbed = Embed<{
  id: string;
  name: string | null;
  status: string | null;
  registration_closes_at: string | null;
  start_time: string | null;
}>;

/** A pending invite addressed to me from a doubles pair's or an MLP team's
 *  captain (doubles_pair_join_requests / mlp_team_join_requests, direction
 *  'invite'). The loader puts each under one shape: `team` is the pair or
 *  the team. These are separate from my registration: pair_invite only
 *  reaches a player already approved in the tournament. */
export type TeamInviteRow = {
  id: string;
  status: string;
  created_at: string | null;
  team?: Embed<{ id: string; name: string | null; status: string | null; tournament?: TeamTournamentEmbed }>;
};

/**
 * Pending pair / team invites -> "Partner invite · Fall Open" rows. Answering
 * happens in the tournament's Pairs / Teams section (pair_respond_to_join /
 * mlp_respond_to_join), so the row opens the tournament. Those RPCs refuse
 * once the pair or team is locked, so a locked one (or a finished or
 * cancelled tournament) drops out. Due at registration close, else the start,
 * whichever is still ahead; with neither ahead it stays undated (the server
 * still takes an answer while the pair is forming).
 */
export function teamInviteItems(
  rows: readonly TeamInviteRow[],
  kind: 'pair' | 'team',
  now: number,
): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const r of rows) {
    if (r.status !== 'pending') continue;
    const team = one(r.team);
    if (!team || team.status !== 'forming') continue;
    const tour = one(team.tournament);
    if (!tour || tour.status === 'completed' || tour.status === 'cancelled') continue;
    const ahead = [tour.registration_closes_at, tour.start_time].find((iso) => {
      const v = ms(iso);
      return v != null && v > now;
    }) ?? null;
    const tournamentName = tour.name ?? 'Tournament';
    const target = { screen: 'TournamentDetail' as const, params: { tournamentId: tour.id, tournamentName } };
    out.push({
      key: `${kind}-invite-${r.id}`,
      kind: 'team_invite',
      title: `${kind === 'pair' ? 'Partner' : 'Team'} invite · ${tournamentName}`,
      leagueName: null,
      startsAt: null,
      endsAt: null,
      needsYou: true,
      deadline: ahead,
      status: team.name ? `from ${team.name}` : 'invited',
      requestedAt: r.created_at,
      target,
      action: { label: 'Respond', target, slug: `${kind}_invite` },
    });
  }
  return out;
}

/** What the inbox loader returns: the raw rows (cached by Home as-is; the
 *  mappers above run at render time, against the current `now`). */
export type InboxRequestRows = {
  matches: MatchConfirmRow[];
  drills: DrillRequestRow[];
  joins: JoinRequestRow[];
  /** Doubles-pair invites to me (absent in a payload cached before them). */
  pairInvites?: TeamInviteRow[];
  /** MLP team invites to me (same). */
  teamInvites?: TeamInviteRow[];
  /** Drill requests I sent, still pending (same). */
  sentDrills?: SentDrillRequestRow[];
};

export const EMPTY_INBOX: InboxRequestRows = { matches: [], drills: [], joins: [], pairInvites: [], teamInvites: [], sentDrills: [] };

/** All the request rows for Up next, mapped (tournament invites aside). */
export function inboxAgendaItems(
  inbox: Partial<InboxRequestRows> | null | undefined,
  uid: string | null,
  adminLeagues: ReadonlyArray<{ id: string; name: string }>,
  now: number,
): AgendaItem[] {
  if (!inbox) return [];
  return [
    ...(uid ? matchConfirmItems(inbox.matches ?? [], uid, now) : []),
    ...drillRequestItems(inbox.drills ?? [], now),
    ...joinRequestItems(inbox.joins ?? [], adminLeagues),
    ...teamInviteItems(inbox.pairInvites ?? [], 'pair', now),
    ...teamInviteItems(inbox.teamInvites ?? [], 'team', now),
    ...drillWaitingItems(inbox.sentDrills ?? [], now),
  ];
}

// ── 2. Notifications ────────────────────────────────────────────────────────

export type NotificationLite = {
  id: string;
  title?: string | null;
  entity_type: string | null;
  entity_id: string | null;
  category?: string | null;
  push_data?: { kind?: unknown; deep_link?: unknown } | null;
  is_read?: boolean;
  created_at?: string | null;
};

export type NotificationChip = 'all' | 'requests' | 'unread' | 'leagues' | 'tournaments' | 'rewards';

export const NOTIFICATION_CHIPS: ReadonlyArray<{ value: NotificationChip; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'requests', label: 'Requests' },
  { value: 'unread', label: 'Unread' },
  { value: 'leagues', label: 'Leagues' },
  { value: 'tournaments', label: 'Tournaments' },
  { value: 'rewards', label: 'Rewards' },
];

/** entity_type values per chip, from the generators in supabase/:
 *  - 'league' (announcements, join requests, refunds) and 'event' (votes,
 *    confirmations, reminders: migration_push_actions_events.sql) -> Leagues;
 *  - 'tournament' (invites, waitlist, start reminders, payout summaries) ->
 *    Tournaments;
 *  - the payout split's 'shop' (pickles) / 'profile' (badge) /
 *    'plupr_history' (bonus) rows, badge and court bonuses ('shop'), refunds
 *    repointed by _repoint_deleted_scope_pushes ('shop'), and gifted items
 *    ('shop_item') -> Rewards.
 *  'match', 'drill', 'wager' and 'wager_on_me' only show under All (and
 *  Requests / Unread when they qualify). */
export const LEAGUE_ENTITY_TYPES = ['league', 'event'] as const;
export const TOURNAMENT_ENTITY_TYPES = ['tournament'] as const;
export const REWARD_ENTITY_TYPES = ['shop', 'shop_item', 'profile', 'plupr_history'] as const;

/** push_data.kind values that ask the recipient for something. */
const REQUEST_KINDS = ['league_join_request', 'drill_request'] as const;
/** notifications.category of the match-confirm notice
 *  (migration_match_confirm_notify_category.sql). */
const MATCH_CONFIRM_CATEGORY = 'notifyMatchConfirms';
/** Title fragments of request notices written before push_data / category
 *  existed (lower case): match confirm, drill request, join request, and the
 *  tournament / code invites ("Tournament invite", "🎟️ Invite: X"). */
const REQUEST_TITLE_FRAGMENTS = ['to confirm', 'wants to drill', 'join request', 'invite'] as const;
/** ...minus the replies, which carry a fragment but ask nothing: "Invite
 *  accepted", "Partner invite accepted" (migration_add_doubles_pairs.sql),
 *  "Join request accepted" (migration_mlp_captain_slot_and_notifs.sql and
 *  later). Matched anywhere in the title: no request title says either word. */
const NOT_REQUEST_WORDS = ['accepted', 'declined'] as const;

/** A notice that asks the viewer to do something: confirm a score, answer a
 *  drill request or an invite, review a join request. */
export function isRequestNotification(n: NotificationLite): boolean {
  const kind = typeof n.push_data?.kind === 'string' ? n.push_data.kind : '';
  if ((REQUEST_KINDS as readonly string[]).includes(kind)) return true;
  if (n.category === MATCH_CONFIRM_CATEGORY) return true;
  const title = (n.title ?? '').toLowerCase();
  if (NOT_REQUEST_WORDS.some((w) => title.includes(w))) return false;
  return REQUEST_TITLE_FRAGMENTS.some((f) => title.includes(f));
}

/** Whether a notification belongs under a chip (the client-side rule; the
 *  server filter below returns a superset of it, never less). */
export function matchesNotificationChip(n: NotificationLite, chip: NotificationChip): boolean {
  const type = n.entity_type ?? '';
  switch (chip) {
    case 'all': return true;
    case 'unread': return n.is_read === false;
    case 'requests': return isRequestNotification(n);
    case 'leagues': return (LEAGUE_ENTITY_TYPES as readonly string[]).includes(type);
    case 'tournaments': return (TOURNAMENT_ENTITY_TYPES as readonly string[]).includes(type);
    case 'rewards': return (REWARD_ENTITY_TYPES as readonly string[]).includes(type);
  }
}

/** The server-side filter for a chip, applied to the notifications select so
 *  paging walks that chip's rows (not 50 of everything, filtered down).
 *  'requests' is an `or` over the same rules as isRequestNotification; the
 *  title fragments can over-match ("Invite accepted", "Join request
 *  accepted", "Partner invite accepted"), so the screen runs
 *  matchesNotificationChip over what comes back. */
export type ChipServerFilter =
  | { kind: 'none' }
  | { kind: 'eq'; column: string; value: string | boolean }
  | { kind: 'in'; column: string; values: readonly string[] }
  | { kind: 'or'; filter: string };

export function chipServerFilter(chip: NotificationChip): ChipServerFilter {
  switch (chip) {
    case 'all': return { kind: 'none' };
    case 'unread': return { kind: 'eq', column: 'is_read', value: false };
    case 'leagues': return { kind: 'in', column: 'entity_type', values: LEAGUE_ENTITY_TYPES };
    case 'tournaments': return { kind: 'in', column: 'entity_type', values: TOURNAMENT_ENTITY_TYPES };
    case 'rewards': return { kind: 'in', column: 'entity_type', values: REWARD_ENTITY_TYPES };
    case 'requests':
      return {
        kind: 'or',
        filter: [
          `push_data->>kind.in.(${REQUEST_KINDS.join(',')})`,
          `category.eq.${MATCH_CONFIRM_CATEGORY}`,
          // Quoted: a value with a space (or any reserved character) must be
          // double-quoted inside a PostgREST logic tree.
          ...REQUEST_TITLE_FRAGMENTS.map((f) => `title.ilike."*${f}*"`),
        ].join(','),
      };
  }
}

// ── Deleted targets ──

/** Tables whose row a notification's entity_id points at, per entity_type.
 *  Only types whose rows the RECIPIENT can always read are checked (a row RLS
 *  hides would look deleted): leagues, tournaments, league_events and matches
 *  are readable by everyone; a drill notice goes to a participant, and its id
 *  is a request or a session (pushLinks 'drill/'), so it is gone only when it
 *  is in neither. Everything else (shop / profile / plupr_history point at the
 *  recipient, wagers are owner-only, unknown types) is never called deleted. */
export const TARGET_TABLES: Readonly<Record<string, readonly string[]>> = {
  tournament: ['tournaments'],
  league: ['leagues'],
  event: ['league_events'],
  match: ['matches'],
  drill: ['drill_requests', 'drill_sessions'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids to look up, per table (deduped; non-uuid ids skipped, so a stray
 *  value can't break the `in` filter). */
export function targetLookups(rows: readonly NotificationLite[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const n of rows) {
    const tables = n.entity_type ? TARGET_TABLES[n.entity_type] : undefined;
    if (!tables || !n.entity_id || !UUID_RE.test(n.entity_id)) continue;
    for (const t of tables) {
      const set = out.get(t) ?? new Set<string>();
      set.add(n.entity_id);
      out.set(t, set);
    }
  }
  return new Map([...out].map(([t, s]) => [t, [...s]]));
}

/**
 * Notification ids whose target is gone. `found` holds, per table that was
 * checked successfully, the ids that came back. A table missing from `found`
 * (its read failed) never marks anything deleted: unknown is not gone.
 */
export function missingTargetIds(
  rows: readonly NotificationLite[],
  found: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const missing = new Set<string>();
  for (const n of rows) {
    const tables = n.entity_type ? TARGET_TABLES[n.entity_type] : undefined;
    if (!tables || !n.entity_id || !UUID_RE.test(n.entity_id)) continue;
    if (!tables.every((t) => found.has(t))) continue;
    if (tables.some((t) => found.get(t)!.has(n.entity_id!))) continue;
    missing.add(n.id);
  }
  return missing;
}

// ── Day groups ──

/** "Today", "Yesterday", "Monday" (this week), "Oct 2", "Oct 2, 2025". */
export function notificationDayLabel(iso: string | null | undefined, now: number): string {
  const t = ms(iso);
  if (t == null) return 'Earlier';
  const d = new Date(t);
  const nowDate = new Date(now);
  const diff = calendarDayDiff(nowDate, d);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return WEEKDAYS_LONG[d.getDay()];
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === nowDate.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

export type DayGroupItem<T> =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'row'; key: string; row: T };

/** Rows (newest first) with a header before each new day. */
export function groupByDay<T extends { id: string; created_at?: string | null }>(
  rows: readonly T[],
  now: number,
): DayGroupItem<T>[] {
  const out: DayGroupItem<T>[] = [];
  let last: string | null = null;
  for (const r of rows) {
    const label = notificationDayLabel(r.created_at, now);
    if (label !== last) {
      out.push({ kind: 'header', key: `day-${label}-${r.id}`, label });
      last = label;
    }
    out.push({ kind: 'row', key: r.id, row: r });
  }
  return out;
}

/** A row's time under its day header: "Just now", "5m ago", "3h ago" for
 *  today, else the clock time ("6:05 PM"; the header already says the day). */
export function notificationTime(iso: string | null | undefined, now: number): string {
  const t = ms(iso);
  if (t == null) return '';
  const ago = now - t;
  if (ago < 60_000) return 'Just now';
  if (ago < HOUR_MS) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < DAY_MS && calendarDayDiff(new Date(now), new Date(t)) === 0) return `${Math.floor(ago / HOUR_MS)}h ago`;
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// ── Loaders (the client is passed in; see the file header) ──────────────────

export type InboxDb = { client: typeof SupabaseSingleton; call: typeof sbCall };

/** Requests never fail Home: a read that errors counts as "none of these". */
async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return (await p) ?? fallback; } catch { return fallback; }
}

/** At most this many of each request kind (a row list, not an archive). */
const REQUEST_LIMIT = 20;
/** The tournament embed under a pair / team (TeamInviteRow). */
const TEAM_TOURNAMENT = 'tournament:tournaments(id, name, status, registration_closes_at, start_time)';

/**
 * Pending join requests to the leagues I run, minus requesters who are
 * already members. Nothing resolves a request when the requester joins
 * another way (redeeming an invite code leaves the row 'pending' forever),
 * so without this a stale request would sit in Up next and on the bell for
 * good -- the same rule as LeagueDetailScreen.loadRequests. If the members
 * read fails, keep the raw list.
 */
async function loadOpenJoinRequests(db: InboxDb, adminLeagueIds: readonly string[]): Promise<JoinRequestRow[]> {
  if (!adminLeagueIds.length) return [];
  const { client, call } = db;
  const rows = await soft<JoinRequestRow[]>(call(() => client
    .from('league_join_requests')
    .select('id, league_id, user_id, created_at, requester:profiles(full_name)')
    .in('league_id', [...adminLeagueIds])
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(50)) as unknown as Promise<JoinRequestRow[]>, []);
  if (!rows.length) return rows;
  type MemberKey = { league_id: string; user_id: string };
  const members = await soft<MemberKey[] | null>(call(() => client
    .from('league_members')
    .select('league_id, user_id')
    .in('league_id', [...new Set(rows.map((r) => r.league_id))])
    .in('user_id', [...new Set(rows.map((r) => r.user_id))])) as unknown as Promise<MemberKey[]>, null);
  if (!members) return rows;
  const joined = new Set(members.map((m) => `${m.league_id}:${m.user_id}`));
  return rows.filter((r) => !joined.has(`${r.league_id}:${r.user_id}`));
}

/**
 * The request rows for Up next. `adminLeagues`: active leagues where I'm admin
 * or co-admin (the only ones whose join requests RLS shows me anyway; passing
 * them keeps the query to those leagues).
 */
export async function loadInboxRequests(
  db: InboxDb,
  uid: string,
  adminLeagueIds: readonly string[],
): Promise<InboxRequestRows> {
  const { client, call } = db;
  const [matches, drills, joins, pairInvites, teamInvites, sentDrills] = await Promise.all([
    soft<MatchConfirmRow[]>(call(() => client
      .from('matches')
      .select(`
        id, status, match_type, player1_id, partner1_id, player2_id, partner2_id,
        player1_score, player2_score, team1_confirmed_by, team2_confirmed_by,
        confirm_deadline, created_at,
        league:leagues(name),
        player1:profiles!matches_player1_id_fkey(full_name),
        partner1:profiles!matches_partner1_id_fkey(full_name),
        player2:profiles!matches_player2_id_fkey(full_name),
        partner2:profiles!matches_partner2_id_fkey(full_name)
      `)
      .eq('status', 'pending')
      .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)
      .order('created_at', { ascending: false })
      .limit(REQUEST_LIMIT)) as unknown as Promise<MatchConfirmRow[]>, []),
    soft<DrillRequestRow[]>(call(() => client
      .from('drill_requests')
      .select('id, status, proposed_slots, created_at, from_profile:profiles!drill_requests_from_user_id_fkey(full_name)')
      .eq('to_user_id', uid)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(REQUEST_LIMIT)) as unknown as Promise<DrillRequestRow[]>, []),
    loadOpenJoinRequests(db, adminLeagueIds),
    // Pair / team invites to me. The pair (team) and its tournament ride
    // along so the mapper can drop locked or finished ones without another
    // round trip. Each table has a single FK to the next, so the embeds are
    // unambiguous.
    soft<TeamInviteRow[]>(call(() => client
      .from('doubles_pair_join_requests')
      .select(`id, status, created_at, team:doubles_pairs(id, name, status, ${TEAM_TOURNAMENT})`)
      .eq('user_id', uid)
      .eq('direction', 'invite')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(REQUEST_LIMIT)) as unknown as Promise<TeamInviteRow[]>, []),
    soft<TeamInviteRow[]>(call(() => client
      .from('mlp_team_join_requests')
      .select(`id, status, created_at, team:mlp_teams(id, name, status, ${TEAM_TOURNAMENT})`)
      .eq('user_id', uid)
      .eq('direction', 'invite')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(REQUEST_LIMIT)) as unknown as Promise<TeamInviteRow[]>, []),
    // Drill requests I sent that are still waiting ("Waiting on Sam").
    soft<SentDrillRequestRow[]>(call(() => client
      .from('drill_requests')
      .select('id, status, proposed_slots, created_at, to_profile:profiles!drill_requests_to_user_id_fkey(full_name)')
      .eq('from_user_id', uid)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(REQUEST_LIMIT)) as unknown as Promise<SentDrillRequestRow[]>, []),
  ]);
  return { matches, drills, joins, pairInvites, teamInvites, sentDrills };
}

/** Ids per `in` filter: keeps the request URL short. */
const LOOKUP_CHUNK = 100;

/**
 * Which of these notifications point at a row that no longer exists. One
 * `select id` per table (chunked), in parallel. A failed read leaves its
 * table unchecked, so its rows read as fine (see missingTargetIds).
 */
export async function findMissingTargets(db: InboxDb, rows: readonly NotificationLite[]): Promise<Set<string>> {
  const { client, call } = db;
  const lookups = targetLookups(rows);
  const found = new Map<string, Set<string>>();
  await Promise.all([...lookups].map(async ([table, ids]) => {
    try {
      const seen = new Set<string>();
      for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
        const chunk = ids.slice(i, i + LOOKUP_CHUNK);
        const res = (await call(() => client.from(table).select('id').in('id', chunk))) as { id: string }[] | null;
        for (const r of res ?? []) seen.add(r.id);
      }
      found.set(table, seen);
    } catch {
      // Unchecked: never called deleted.
    }
  }));
  return missingTargetIds(rows, found);
}
