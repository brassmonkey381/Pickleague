// Mutual friendships: thin wrappers over the friend RPCs (contract:
// docs/play-sessions-presence-api.md, "Friends"). Every RPC is SECURITY
// DEFINER and does its own checks (no self, guests, unclaimed placeholders,
// deleted accounts or blocked pairs; 20 requests a day), raising a readable
// message the caller shows through friendlySbMessage. Every write is
// idempotent server-side: a replay answers 'already' / 'gone' / false rather
// than failing, so callers may retry.
//
// The pure rules (states, list edits, copy) are in lib/friendship.ts; the
// cached hooks and the cache-updating writes in lib/useFriends.ts.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import {
  parseFriendStatus,
  parseRespondResult,
  parseSendResult,
  type FriendRequestRow,
  type FriendRow,
  type FriendStatus,
  type FriendSuggestion,
  type RespondResult,
  type SendResult,
} from '../lib/friendship';

export type {
  FriendRequestRow,
  FriendRow,
  FriendStatus,
  FriendSuggestion,
  FriendshipStatus,
  RespondResult,
  SendResult,
} from '../lib/friendship';

const BOUND = { timeoutMs: 9_000 };
/** Writes are idempotent, so one retry is safe. */
const WRITE = { retries: 1, timeoutMs: 9_000 };

/** 'pending', or 'accepted' when it crossed their pending request to me. */
export async function sendFriendRequest(userId: string): Promise<SendResult> {
  return parseSendResult(await sbCall(() => supabase.rpc('send_friend_request', { p_user: userId }), WRITE));
}

/** Accept or decline THEIR request to me. 'gone' when nothing was pending. */
export async function respondFriendRequest(userId: string, accept: boolean): Promise<RespondResult> {
  return parseRespondResult(
    await sbCall(() => supabase.rpc('respond_friend_request', { p_user: userId, p_accept: accept }), WRITE),
  );
}

/** Withdraw MY pending request to them. False when there was none. */
export async function cancelFriendRequest(userId: string): Promise<boolean> {
  return (await sbCall(() => supabase.rpc('cancel_friend_request', { p_user: userId }), WRITE)) === true;
}

/** Unfriend (silent: nobody is notified). Clears the close-friend star both ways. */
export async function removeFriend(userId: string): Promise<boolean> {
  return (await sbCall(() => supabase.rpc('remove_friend', { p_user: userId }), WRITE)) === true;
}

/** The ⭐ on a friend. Raises unless the friendship is accepted. */
export async function setCloseFriend(userId: string, on: boolean): Promise<boolean> {
  return (await sbCall(() => supabase.rpc('set_close_friend', { p_user: userId, p_on: on }), WRITE)) === true;
}

/** Where I stand with this player. */
export async function getFriendStatus(userId: string): Promise<FriendStatus> {
  return parseFriendStatus(await sbCall(() => supabase.rpc('friendship_status_with', { p_user: userId }), BOUND));
}

export async function listMyFriends(): Promise<FriendRow[]> {
  return ((await sbCall(() => supabase.rpc('list_my_friends'), BOUND)) ?? []) as FriendRow[];
}

/** Pending requests both ways (`direction`). */
export async function listFriendRequests(): Promise<FriendRequestRow[]> {
  return ((await sbCall(() => supabase.rpc('list_friend_requests'), BOUND)) ?? []) as FriendRequestRow[];
}

/** People I have really played with ("4 matches together", "Drilled 2x",
 *  "Both in Lunch League"), best first; never friends, pending or blocked. */
export async function suggestFriends(limit = 10): Promise<FriendSuggestion[]> {
  return ((await sbCall(() => supabase.rpc('suggest_friends', { p_limit: limit }), BOUND)) ?? []) as FriendSuggestion[];
}
