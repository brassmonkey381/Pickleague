// Mutual friendships (docs/play-sessions-presence.md, Phase 1 step 5): the
// rules the Friends screen, the profile's FriendButton and the lock-screen
// Accept / Decline share. The RPCs are in docs/play-sessions-presence-api.md
// ("Friends"); data/friends.ts wraps them.
//
// PURE: its imports (lib/pushSubject, and a type from lib/agenda) pull no
// Supabase client and no React, so lib/__tests__/friendship.test.ts runs it
// in plain Node.
//
// The server is the authority on every state. A request, an accept or a
// removal changes the cached lists at once (so a row moves the moment it is
// tapped) and then the 'friends' cache family is refetched.
import type { AgendaItem } from './agenda';
import { titleWith } from './pushSubject';

/** friendship_status_with(p_user).status, from the viewer's side. */
export type FriendshipStatus =
  | 'self'
  | 'friends'
  | 'pending_outgoing'
  | 'pending_incoming'
  | 'none'
  // Guests, unclaimed DUPR placeholders, deleted accounts and blocked pairs.
  | 'unavailable';

export type FriendStatus = { status: FriendshipStatus; is_close_friend: boolean };

/** The avatar fields every friend RPC returns with a person. */
type Person = {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  doubles_rating: number | null;
};

/** list_my_friends() */
export type FriendRow = Person & { is_close_friend: boolean; since: string | null };

/** list_friend_requests() */
export type FriendRequestRow = Person & { direction: 'incoming' | 'outgoing'; created_at: string | null };

/** What the request-list rules read from a row. */
type RequestKey = Pick<FriendRequestRow, 'user_id' | 'direction' | 'created_at'>;

/** suggest_friends(p_limit) */
export type FriendSuggestion = Person & { reason: string | null; score: number | null };

/** send_friend_request: 'accepted' when it crossed their pending request;
 *  'already' a request of mine is pending; 'already_friends' (since
 *  migration_refusal_messages.sql; an older server says 'already'). */
export type SendResult = 'pending' | 'accepted' | 'already' | 'already_friends';
/** respond_friend_request: 'gone' when nothing was pending any more;
 *  'already_declined' an Accept on a request I had declined. */
export type RespondResult = 'accepted' | 'declined' | 'gone' | 'already_declined';

// ── Cache keys (the foundation query cache) ─────────────────────────────────

/** Every friend query lives under this prefix: invalidateQueries(FRIENDS_KEY)
 *  after a write refetches them all. */
export const FRIENDS_KEY = 'friends';
export const FRIENDS_LIST_KEY = `${FRIENDS_KEY}:list`;
export const FRIEND_REQUESTS_KEY = `${FRIENDS_KEY}:requests`;
export const FRIEND_SUGGESTIONS_KEY = `${FRIENDS_KEY}:suggest`;
export const friendStatusKey = (userId: string) => `${FRIENDS_KEY}:status:${userId}`;

// ── Parsing ─────────────────────────────────────────────────────────────────

const STATUSES: ReadonlySet<string> = new Set<FriendshipStatus>([
  'self', 'friends', 'pending_outgoing', 'pending_incoming', 'none', 'unavailable',
]);

/** friendship_status_with's jsonb. Anything unreadable is 'unavailable', so a
 *  surprise from the server hides the button rather than offering a wrong one. */
export function parseFriendStatus(raw: unknown): FriendStatus {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { status?: unknown; is_close_friend?: unknown };
  const status = typeof o.status === 'string' && STATUSES.has(o.status) ? (o.status as FriendshipStatus) : 'unavailable';
  return { status, is_close_friend: status === 'friends' && o.is_close_friend === true };
}

export function parseSendResult(raw: unknown): SendResult {
  return raw === 'pending' || raw === 'accepted' || raw === 'already_friends' ? raw : 'already';
}

export function parseRespondResult(raw: unknown): RespondResult {
  return raw === 'accepted' || raw === 'declined' || raw === 'already_declined' ? raw : 'gone';
}

// ── The profile's FriendButton ──────────────────────────────────────────────

export type FriendButtonState =
  | 'hidden'
  // "Add friend"
  | 'add'
  // "Requested" (tap to cancel)
  | 'requested'
  // "Accept" + "Decline"
  | 'respond'
  // "Friends ✓" (menu: close friend, remove)
  | 'friends';

/**
 * What the button on someone's profile shows. Hidden until the status is
 * known (no "Add friend" flash on a friend's profile), on yourself, and on
 * anyone a request can't reach: an unclaimed DUPR placeholder (its claim
 * deletes the row, and the request with it), a guest, a deleted account, a
 * blocked pair. `profile` is the profile row the screen already loaded: it
 * hides the button before the status round trip returns.
 */
export function friendButtonState(
  status: FriendshipStatus | null | undefined,
  profile?: { is_unclaimed?: boolean | null; is_guest?: boolean | null; deleted_at?: string | null } | null,
): FriendButtonState {
  if (profile?.is_unclaimed || profile?.is_guest || profile?.deleted_at) return 'hidden';
  switch (status) {
    case 'none': return 'add';
    case 'pending_outgoing': return 'requested';
    case 'pending_incoming': return 'respond';
    case 'friends': return 'friends';
    default: return 'hidden';
  }
}

/** The status a write leaves behind, or null when only a refetch can say
 *  ('already' could be pending or friends; 'gone' could be anything). */
export function statusAfterSend(result: SendResult): FriendshipStatus | null {
  if (result === 'pending') return 'pending_outgoing';
  if (result === 'accepted' || result === 'already_friends') return 'friends';
  return null;
}

export function statusAfterRespond(result: RespondResult): FriendshipStatus | null {
  if (result === 'accepted') return 'friends';
  if (result === 'declined' || result === 'already_declined') return 'none';
  return null;
}

// ── Lists ───────────────────────────────────────────────────────────────────

function ms(iso: string | null | undefined): number {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : 0;
}

/**
 * The Requests tab: incoming (waiting on me) and outgoing (waiting on them),
 * newest first. One row per person: the unique pair index makes two rows
 * impossible on the server, but a list cached across a crossing request (I
 * send while theirs is in flight) could briefly hold both, and the incoming
 * one wins (answering it is the action).
 */
export function splitRequests<R extends RequestKey = FriendRequestRow>(rows: readonly R[] | null | undefined): {
  incoming: R[];
  outgoing: R[];
} {
  const byUser = new Map<string, R>();
  for (const r of rows ?? []) {
    const prev = byUser.get(r.user_id);
    if (!prev || (prev.direction === 'outgoing' && r.direction === 'incoming')) byUser.set(r.user_id, r);
  }
  const all = [...byUser.values()].sort((a, b) => ms(b.created_at) - ms(a.created_at));
  return {
    incoming: all.filter((r) => r.direction === 'incoming'),
    outgoing: all.filter((r) => r.direction === 'outgoing'),
  };
}

/** How many requests wait on me (the Requests tab count, FriendsLink's badge). */
export function incomingCount(rows: readonly RequestKey[] | null | undefined): number {
  return splitRequests(rows).incoming.length;
}

/** The cached request list after a write about `userId`: every write
 *  (accept, decline, cancel, a send that crossed theirs) settles that
 *  person's request, so their row goes. */
export function withoutRequest(
  rows: readonly FriendRequestRow[] | null | undefined,
  userId: string,
): FriendRequestRow[] {
  return (rows ?? []).filter((r) => r.user_id !== userId);
}

/** The cached request list after a send that is now pending: an outgoing row
 *  for them at the top (replacing any row they already had). */
export function withOutgoingRequest(
  rows: readonly FriendRequestRow[] | null | undefined,
  person: Omit<FriendRequestRow, 'direction' | 'created_at'>,
  nowIso: string,
): FriendRequestRow[] {
  return [{ ...person, direction: 'outgoing', created_at: nowIso }, ...withoutRequest(rows, person.user_id)];
}

/**
 * Home's Up next (lib/inboxRequests): friend requests to me -> ONE row, "Sam
 * wants to be friends" or "3 friend requests". Answering happens on Friends >
 * Requests, so one row is one place to act, like league join requests. A
 * needs-you item (so the bell counts it) with no deadline: it ages from the
 * oldest request.
 */
export function friendRequestItems(
  rows: readonly (RequestKey & Pick<FriendRequestRow, 'full_name'>)[],
): AgendaItem[] {
  const { incoming } = splitRequests(rows);
  if (!incoming.length) return [];
  const dated = incoming.filter((r) => ms(r.created_at) > 0);
  const oldest = dated.length ? dated[dated.length - 1].created_at : null;
  const title = incoming.length === 1
    ? `${firstNameOf(incoming[0].full_name) ?? 'A player'} wants to be friends`
    : `${incoming.length} friend requests`;
  const target = { screen: 'Friends' as const, params: { tab: 'requests' as const } };
  return [{
    key: 'friend-requests',
    kind: 'friend_request',
    title,
    leagueName: null,
    startsAt: null,
    endsAt: null,
    needsYou: true,
    deadline: null,
    status: 'waiting on you',
    requestedAt: oldest,
    target,
    action: { label: 'Respond', target, slug: 'friend_request' },
  }];
}

/** Close friends first, then by name (case-insensitive), then by id so the
 *  order is total. */
export function sortFriends(rows: readonly FriendRow[] | null | undefined): FriendRow[] {
  return [...(rows ?? [])].sort((a, b) => {
    if (a.is_close_friend !== b.is_close_friend) return a.is_close_friend ? -1 : 1;
    const n = (a.full_name ?? '').localeCompare(b.full_name ?? '', undefined, { sensitivity: 'base' });
    return n !== 0 ? n : a.user_id.localeCompare(b.user_id);
  });
}

/** The cached friends list after a close-friend toggle. */
export function withCloseFriend(rows: readonly FriendRow[] | null | undefined, userId: string, on: boolean): FriendRow[] {
  return (rows ?? []).map((r) => (r.user_id === userId ? { ...r, is_close_friend: on } : r));
}

/**
 * "People you've played with", minus anyone already a friend, already in a
 * request either way, or me. suggest_friends excludes them too; this covers
 * the rows a tap just moved (Add), until the refetch lands.
 */
export function visibleSuggestions(
  suggestions: readonly FriendSuggestion[] | null | undefined,
  ctx: { meId: string | null; friends?: readonly FriendRow[] | null; requests?: readonly FriendRequestRow[] | null },
): FriendSuggestion[] {
  const taken = new Set<string>([
    ...(ctx.friends ?? []).map((f) => f.user_id),
    ...(ctx.requests ?? []).map((r) => r.user_id),
  ]);
  if (ctx.meId) taken.add(ctx.meId);
  const seen = new Set<string>();
  const out: FriendSuggestion[] = [];
  for (const s of suggestions ?? []) {
    if (taken.has(s.user_id) || seen.has(s.user_id)) continue;
    seen.add(s.user_id);
    out.push(s);
  }
  return out;
}

/** Who the Find search leaves out: me, my friends, and people I already
 *  asked. Someone who asked me stays: adding them accepts theirs. */
export function findExcludeIds(
  meId: string | null,
  friends: readonly FriendRow[] | null | undefined,
  requests: readonly FriendRequestRow[] | null | undefined,
): string[] {
  const ids = new Set<string>();
  if (meId) ids.add(meId);
  for (const f of friends ?? []) ids.add(f.user_id);
  for (const r of requests ?? []) if (r.direction === 'outgoing') ids.add(r.user_id);
  return [...ids];
}

// ── Copy ────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A request's age: "just now", "5m ago", "3h ago", "2d ago", "3w ago". */
export function requestAgoLabel(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const ago = now - t;
  if (ago < 60_000) return 'just now';
  if (ago < HOUR_MS) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)}h ago`;
  if (ago < 7 * DAY_MS) return `${Math.floor(ago / DAY_MS)}d ago`;
  return `${Math.floor(ago / (7 * DAY_MS))}w ago`;
}

/** "Friends since today" / "Friends since Oct 2" / "Friends since Oct 2,
 *  2025", in the device's zone. */
export function friendsSinceLabel(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return 'Friends since today';
  }
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `Friends since ${d.getFullYear() === n.getFullYear() ? base : `${base}, ${d.getFullYear()}`}`;
}

/** "Sam Kim" -> "Sam"; null for a blank name. */
export function firstNameOf(full: string | null | undefined): string | null {
  const t = (full ?? '').trim();
  return t ? t.split(/\s+/)[0] : null;
}

const friendsNow = (who: string | null) => (who ? `You and ${who} are friends now.` : 'You are friends now.');

/** The toast after Add friend. 'already' is a replay or a stale button (the
 *  caller refetches the real state). A sent request never promises a
 *  notification: a re-request soon after a decline or a cancel is stored
 *  quietly, and saying so would reveal the decline. */
export function sendResultMessage(result: SendResult, name: string | null | undefined): string {
  const who = firstNameOf(name);
  if (result === 'accepted') return friendsNow(who);
  if (result === 'already_friends') return who ? `You and ${who} are already friends.` : "You're already friends.";
  if (result === 'already') return who ? `You already sent ${who} a request.` : 'You already sent a request.';
  return who ? `Request sent. ${who} can accept it in Pickleague.` : 'Request sent.';
}

/** The toast after Accept / Decline. Declining notifies nobody. */
export function respondResultMessage(result: RespondResult, name: string | null | undefined): string {
  if (result === 'accepted') return friendsNow(firstNameOf(name));
  if (result === 'declined') return "Declined. We won't tell them.";
  if (result === 'already_declined') {
    const who = firstNameOf(name);
    return `You declined ${who ? `${who}'s` : 'this'} request earlier. Send ${who ?? 'them'} a request if you'd like to be friends.`;
  }
  // Vague on purpose: a cancel, a block and a deleted account read the same.
  return 'That request is no longer waiting on you.';
}

/** The toast after Cancel on my request. `statusNow`: read after a false (nothing was pending). */
export function cancelResultMessage(
  cancelled: boolean,
  statusNow: FriendshipStatus | null,
  name: string | null | undefined,
): string {
  if (cancelled) return 'Request cancelled.';
  const who = firstNameOf(name);
  if (statusNow === 'friends') {
    return `${who ?? 'They'} already accepted, so you're friends now. Remove ${who ?? 'them'} from your friends if you'd rather not be.`;
  }
  // True for a decline (never revealed), a cancel on another device, a block,
  // a deleted account, and a status read that failed.
  return "That request isn't waiting any more, so there's nothing to cancel.";
}

// ── Lock-screen Accept / Decline (lib/friendActions.ts) ─────────────────────

/** What a press did. A replay (delivery is at-least-once) or a request
 *  already answered in the app comes back 'gone' from the RPC; the status
 *  read after it tells "already friends" apart from "nothing to answer". */
export type FriendActionOutcome = 'accepted' | 'declined' | 'already_friends' | 'already_declined' | 'gone';

export function friendActionOutcome(
  accept: boolean,
  result: RespondResult,
  statusNow: FriendshipStatus | null,
): FriendActionOutcome {
  if (result === 'accepted') return 'accepted';
  if (result === 'declined') return 'declined';
  if (result === 'already_declined') return 'already_declined';
  if (statusNow === 'friends') return 'already_friends';
  // A second Decline finds nothing pending: the first one landed, and so did
  // a requester's cancel. Either way nothing waits on me, as the press asked.
  return accept ? 'gone' : 'declined';
}

/** The notice for a press, naming the requester when the push title did
 *  ("🤝 Sam wants to be friends"). */
export function friendActionNotice(outcome: FriendActionOutcome, subject: string | null): { title: string; body: string } {
  switch (outcome) {
    case 'accepted':
      return { title: titleWith("You're friends", subject), body: "You'll see each other at the courts now." };
    case 'already_friends':
      return { title: titleWith('Already friends', subject), body: 'You accepted this request already.' };
    case 'declined':
      return { title: titleWith('Declined', subject), body: "We won't tell them." };
    case 'already_declined':
      return {
        title: titleWith('Already declined', subject),
        body: "You declined this request earlier. Send them a request from their profile if you'd like to be friends.",
      };
    case 'gone':
      return { title: 'Nothing to answer', body: 'That request is no longer waiting on you.' };
  }
}
