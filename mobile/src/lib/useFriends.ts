// Friend data for screens: cached reads (the foundation query cache, so the
// Friends screen, a profile's FriendButton and FriendsLink's badge share one
// copy) and the writes that keep those copies honest.
//
// Every write patches the cached values it can predict (a row leaves the
// Requests list the moment Accept is tapped, a star fills at once), then
// invalidates the whole 'friends' family so the server's answer replaces the
// guess. A failed write puts the patched values back before it rethrows.
//
// Everything is off while FRIENDS_AT_COURTS_ENABLED is false: the hooks never
// fetch (the RPCs may not exist yet) and return no data.
import {
  invalidateQueries,
  peekQuery,
  setQueryData,
  useCachedQuery,
} from '@just-messin-around/expo-foundation/cache';
import { FRIENDS_AT_COURTS_ENABLED } from './features';
import {
  cancelFriendRequest,
  getFriendStatus,
  listFriendRequests,
  listMyFriends,
  removeFriend,
  respondFriendRequest,
  sendFriendRequest,
  setCloseFriend,
  suggestFriends,
} from '../data/friends';
import {
  FRIENDS_KEY,
  FRIENDS_LIST_KEY,
  FRIEND_REQUESTS_KEY,
  FRIEND_SUGGESTIONS_KEY,
  friendStatusKey,
  statusAfterRespond,
  statusAfterSend,
  withCloseFriend,
  withOutgoingRequest,
  withoutRequest,
  type FriendRequestRow,
  type FriendRow,
  type FriendStatus,
  type FriendSuggestion,
  type RespondResult,
  type SendResult,
} from './friendship';

const TTL_MS = 30_000;
const PERSIST_MS = 24 * 60 * 60 * 1000;

const opts = (enabled = true) => ({ ttlMs: TTL_MS, persistMs: PERSIST_MS, enabled: FRIENDS_AT_COURTS_ENABLED && enabled });

/** Pending requests both ways. */
export function useFriendRequests(enabled = true) {
  return useCachedQuery<FriendRequestRow[]>(FRIEND_REQUESTS_KEY, listFriendRequests, opts(enabled));
}

export function useMyFriends(enabled = true) {
  return useCachedQuery<FriendRow[]>(FRIENDS_LIST_KEY, listMyFriends, opts(enabled));
}

export function useFriendSuggestions(enabled = true) {
  return useCachedQuery<FriendSuggestion[]>(FRIEND_SUGGESTIONS_KEY, () => suggestFriends(10), opts(enabled));
}

/** Where I stand with one player (the profile's FriendButton). */
export function useFriendStatus(userId: string, enabled = true) {
  return useCachedQuery<FriendStatus>(friendStatusKey(userId), () => getFriendStatus(userId), opts(enabled));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** A cached value's replacement; undefined leaves the key alone. */
type Patch = { key: string; next: (prev: unknown) => unknown };

function apply(patches: readonly Patch[]): void {
  for (const p of patches) {
    const v = p.next(peekQuery(p.key));
    if (v !== undefined) setQueryData(p.key, v);
  }
}

/** Refetch the family once React has drawn the patched values. A mounted
 *  hook keeps showing its LAST RENDERED value through an invalidation, so
 *  invalidating in the same tick as the patch would show the pre-write value
 *  until the refetch lands ("Add friend" flashing back after the tap). */
function refetchSoon(): void {
  setTimeout(() => invalidateQueries(FRIENDS_KEY), 0);
}

/**
 * Run a friend write: `before` patches go on first (optimistic), `after`
 * patches once the server answered, then the family refetches. On failure the
 * `before` keys get their old values back (or refetch, when nothing was
 * cached) and the error is rethrown for the caller's toast.
 */
async function write<T>(run: () => Promise<T>, before: Patch[] = [], after?: (res: T) => Patch[]): Promise<T> {
  const saved = before.map((p) => [p.key, peekQuery(p.key)] as const);
  apply(before);
  let res: T;
  try {
    res = await run();
  } catch (e) {
    for (const [key, value] of saved) if (value !== undefined) setQueryData(key, value);
    refetchSoon();
    throw e;
  }
  apply(after?.(res) ?? []);
  refetchSoon();
  return res;
}

const status = (userId: string, s: FriendStatus['status'] | null, closeFriend = false): Patch => ({
  key: friendStatusKey(userId),
  next: () => (s ? ({ status: s, is_close_friend: closeFriend } satisfies FriendStatus) : undefined),
});

const requests = (fn: (rows: FriendRequestRow[]) => FriendRequestRow[]): Patch => ({
  key: FRIEND_REQUESTS_KEY,
  next: (prev) => (Array.isArray(prev) ? fn(prev as FriendRequestRow[]) : undefined),
});

const friends = (fn: (rows: FriendRow[]) => FriendRow[]): Patch => ({
  key: FRIENDS_LIST_KEY,
  next: (prev) => (Array.isArray(prev) ? fn(prev as FriendRow[]) : undefined),
});

const suggestions = (fn: (rows: FriendSuggestion[]) => FriendSuggestion[]): Patch => ({
  key: FRIEND_SUGGESTIONS_KEY,
  next: (prev) => (Array.isArray(prev) ? fn(prev as FriendSuggestion[]) : undefined),
});

/** The person fields a pending row needs (any friend RPC row has them). */
export type FriendPerson = Pick<
  FriendRequestRow,
  'user_id' | 'full_name' | 'avatar_url' | 'avatar_emoji' | 'avatar_bg_color' | 'doubles_rating'
>;

/** Add friend. A send that crossed their request comes back 'accepted'. */
export function addFriend(person: FriendPerson): Promise<SendResult> {
  const id = person.user_id;
  return write(
    () => sendFriendRequest(id),
    [suggestions((rows) => rows.filter((r) => r.user_id !== id))],
    (res) => [
      status(id, statusAfterSend(res)),
      requests((rows) =>
        res === 'pending' ? withOutgoingRequest(rows, person, new Date().toISOString())
          : res === 'accepted' ? withoutRequest(rows, id)
            : rows,
      ),
    ],
  );
}

/** Accept / Decline their request. */
export function answerFriendRequest(userId: string, accept: boolean): Promise<RespondResult> {
  return write(
    () => respondFriendRequest(userId, accept),
    [requests((rows) => withoutRequest(rows, userId))],
    (res) => [status(userId, statusAfterRespond(res))],
  );
}

/** Withdraw my request. */
export function withdrawFriendRequest(userId: string): Promise<boolean> {
  return write(
    () => cancelFriendRequest(userId),
    [requests((rows) => withoutRequest(rows, userId)), status(userId, 'none')],
  );
}

/** Unfriend (silent). */
export function unfriend(userId: string): Promise<boolean> {
  return write(
    () => removeFriend(userId),
    [friends((rows) => rows.filter((r) => r.user_id !== userId)), status(userId, 'none')],
  );
}

/** The ⭐ on a friend. */
export function markCloseFriend(userId: string, on: boolean): Promise<boolean> {
  return write(
    () => setCloseFriend(userId, on),
    [friends((rows) => withCloseFriend(rows, userId, on)), status(userId, 'friends', on)],
  );
}

/** After a write that happened elsewhere (a lock-screen Accept): refetch. */
export function refreshFriends(): void {
  invalidateQueries(FRIENDS_KEY);
}
