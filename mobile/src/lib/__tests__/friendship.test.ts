import { describe, it, expect } from 'vitest';
import { getStateFromPath } from '@react-navigation/core';
import {
  cancelResultMessage,
  findExcludeIds,
  friendActionNotice,
  friendActionOutcome,
  friendButtonState,
  friendsSinceLabel,
  friendStatusKey,
  FRIENDS_KEY,
  FRIEND_REQUESTS_KEY,
  incomingCount,
  parseFriendStatus,
  parseRespondResult,
  parseSendResult,
  requestAgoLabel,
  respondResultMessage,
  sendResultMessage,
  sortFriends,
  splitRequests,
  statusAfterRespond,
  statusAfterSend,
  visibleSuggestions,
  withCloseFriend,
  withOutgoingRequest,
  withoutRequest,
  type FriendRequestRow,
  type FriendRow,
  type FriendSuggestion,
} from '../friendship';
import { FRIENDS_AT_COURTS_ENABLED } from '../features';
import { linking } from '../../navigation/linking';

// A Tuesday afternoon in the device zone (same anchor as agenda.test.ts).
const NOW = new Date(2026, 9, 13, 14, 0, 0).getTime();
const H = 60 * 60 * 1000;
const D = 24 * H;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const person = (id: string, name: string | null = id) => ({
  user_id: id,
  full_name: name,
  avatar_url: null,
  avatar_emoji: null,
  avatar_bg_color: null,
  doubles_rating: null,
});
const req = (id: string, direction: 'incoming' | 'outgoing', ageMs: number): FriendRequestRow => ({
  ...person(id),
  direction,
  created_at: iso(-ageMs),
});
const friend = (id: string, name: string, close = false): FriendRow => ({
  ...person(id, name),
  is_close_friend: close,
  since: iso(-D),
});
const suggestion = (id: string, reason = '4 matches together'): FriendSuggestion => ({
  ...person(id),
  reason,
  score: 4,
});

describe('parsing the RPC answers', () => {
  it('reads friendship_status_with, and anything unknown hides the button', () => {
    expect(parseFriendStatus({ status: 'friends', is_close_friend: true })).toEqual({ status: 'friends', is_close_friend: true });
    expect(parseFriendStatus({ status: 'none' })).toEqual({ status: 'none', is_close_friend: false });
    // The star only means something on a friend.
    expect(parseFriendStatus({ status: 'pending_outgoing', is_close_friend: true }).is_close_friend).toBe(false);
    expect(parseFriendStatus({ status: 'blocked' }).status).toBe('unavailable');
    expect(parseFriendStatus(null).status).toBe('unavailable');
    expect(parseFriendStatus('friends').status).toBe('unavailable');
  });

  it('reads the write results, treating the unexpected as the safe case', () => {
    expect(parseSendResult('pending')).toBe('pending');
    expect(parseSendResult('accepted')).toBe('accepted');
    expect(parseSendResult('already')).toBe('already');
    expect(parseSendResult(null)).toBe('already');
    expect(parseRespondResult('accepted')).toBe('accepted');
    expect(parseRespondResult('declined')).toBe('declined');
    expect(parseRespondResult('gone')).toBe('gone');
    expect(parseRespondResult(undefined)).toBe('gone');
    // Since migration_refusal_messages.sql (an older server says 'already' / 'declined').
    expect(parseSendResult('already_friends')).toBe('already_friends');
    expect(parseRespondResult('already_declined')).toBe('already_declined');
    expect(statusAfterSend('already_friends')).toBe('friends');
    expect(statusAfterRespond('already_declined')).toBe('none');
  });
});

describe('FriendButton state', () => {
  it('maps each status to its button', () => {
    expect(friendButtonState('none')).toBe('add');
    expect(friendButtonState('pending_outgoing')).toBe('requested');
    expect(friendButtonState('pending_incoming')).toBe('respond');
    expect(friendButtonState('friends')).toBe('friends');
  });

  it('is hidden on yourself, the unreachable, and before the status is known', () => {
    expect(friendButtonState('self')).toBe('hidden');
    expect(friendButtonState('unavailable')).toBe('hidden');
    expect(friendButtonState(undefined)).toBe('hidden');
    expect(friendButtonState(null)).toBe('hidden');
  });

  it('the loaded profile hides it on placeholders, guests and deleted accounts whatever the status says', () => {
    expect(friendButtonState('none', { is_unclaimed: true })).toBe('hidden');
    expect(friendButtonState('none', { is_guest: true })).toBe('hidden');
    expect(friendButtonState('friends', { deleted_at: iso(-D) })).toBe('hidden');
    expect(friendButtonState('none', { is_unclaimed: false, is_guest: false, deleted_at: null })).toBe('add');
  });

  it('knows the state a write leaves, or says only a refetch can', () => {
    expect(statusAfterSend('pending')).toBe('pending_outgoing');
    expect(statusAfterSend('accepted')).toBe('friends');
    expect(statusAfterSend('already')).toBeNull();
    expect(statusAfterRespond('accepted')).toBe('friends');
    expect(statusAfterRespond('declined')).toBe('none');
    expect(statusAfterRespond('gone')).toBeNull();
  });
});

describe('request lists', () => {
  it('splits incoming from outgoing, newest first', () => {
    const { incoming, outgoing } = splitRequests([
      req('a', 'incoming', 3 * H),
      req('b', 'outgoing', H),
      req('c', 'incoming', H),
      req('d', 'outgoing', 2 * D),
    ]);
    expect(incoming.map((r) => r.user_id)).toEqual(['c', 'a']);
    expect(outgoing.map((r) => r.user_id)).toEqual(['b', 'd']);
    expect(incomingCount([req('a', 'incoming', H), req('b', 'outgoing', H)])).toBe(1);
    expect(splitRequests(undefined)).toEqual({ incoming: [], outgoing: [] });
  });

  it('one row per person: a crossing request keeps the one to answer', () => {
    const { incoming, outgoing } = splitRequests([req('sam', 'outgoing', H), req('sam', 'incoming', 2 * H)]);
    expect(incoming.map((r) => r.user_id)).toEqual(['sam']);
    expect(outgoing).toEqual([]);
    // Either order.
    expect(splitRequests([req('sam', 'incoming', 2 * H), req('sam', 'outgoing', H)]).incoming).toHaveLength(1);
  });

  it('an answered, cancelled or crossed request leaves the list; a new one goes on top', () => {
    const rows = [req('a', 'incoming', H), req('b', 'outgoing', 2 * H)];
    expect(withoutRequest(rows, 'a').map((r) => r.user_id)).toEqual(['b']);
    expect(withoutRequest(undefined, 'a')).toEqual([]);
    const sent = withOutgoingRequest(rows, person('c', 'Cat'), iso(0));
    expect(sent.map((r) => [r.user_id, r.direction])).toEqual([['c', 'outgoing'], ['a', 'incoming'], ['b', 'outgoing']]);
    expect(sent[0].created_at).toBe(iso(0));
    // Re-sending to someone already listed replaces their row.
    expect(withOutgoingRequest(rows, person('b'), iso(0)).filter((r) => r.user_id === 'b')).toHaveLength(1);
  });
});

describe('friends list', () => {
  it('close friends first, then by name, case-insensitively', () => {
    const sorted = sortFriends([friend('1', 'zoe'), friend('2', 'Ana'), friend('3', 'Mo', true), friend('4', 'bea')]);
    expect(sorted.map((f) => f.full_name)).toEqual(['Mo', 'Ana', 'bea', 'zoe']);
    expect(sortFriends(null)).toEqual([]);
  });

  it('a star toggle changes only that friend', () => {
    const rows = [friend('1', 'Ana'), friend('2', 'Bea')];
    expect(withCloseFriend(rows, '2', true).map((f) => f.is_close_friend)).toEqual([false, true]);
    expect(withCloseFriend(rows, '2', true)).not.toBe(rows);
  });
});

describe('suggestions and the Find search', () => {
  it('drops friends, anyone in a request, me, and repeats', () => {
    const out = visibleSuggestions(
      [suggestion('me'), suggestion('f1'), suggestion('r1'), suggestion('s1'), suggestion('s1'), suggestion('s2', 'Drilled 2x')],
      { meId: 'me', friends: [friend('f1', 'F')], requests: [req('r1', 'outgoing', H)] },
    );
    expect(out.map((s) => s.user_id)).toEqual(['s1', 's2']);
    expect(visibleSuggestions(undefined, { meId: null })).toEqual([]);
  });

  it('search leaves out me, friends and people I asked; someone who asked me stays', () => {
    const ids = findExcludeIds('me', [friend('f1', 'F')], [req('out', 'outgoing', H), req('in', 'incoming', H)]);
    expect(ids.sort()).toEqual(['f1', 'me', 'out']);
    expect(findExcludeIds(null, null, null)).toEqual([]);
  });
});

describe('copy', () => {
  it('names the person by first name', () => {
    // Never promises a notification: a quiet re-request would make that untrue.
    expect(sendResultMessage('pending', 'Sam Kim')).toBe('Request sent. Sam can accept it in Pickleague.');
    expect(sendResultMessage('pending', null)).toBe('Request sent.');
    expect(sendResultMessage('accepted', 'Sam Kim')).toBe('You and Sam are friends now.');
    expect(sendResultMessage('already', 'Sam Kim')).toBe('You already sent Sam a request.');
    expect(sendResultMessage('already_friends', 'Sam Kim')).toBe('You and Sam are already friends.');
    expect(respondResultMessage('accepted', 'Sam Kim')).toBe('You and Sam are friends now.');
    expect(respondResultMessage('accepted', '')).toBe('You are friends now.');
    expect(respondResultMessage('declined', 'Sam Kim')).toBe("Declined. We won't tell them.");
    expect(respondResultMessage('already_declined', 'Sam Kim')).toBe(
      "You declined Sam's request earlier. Send Sam a request if you'd like to be friends.",
    );
    expect(respondResultMessage('gone', 'Sam Kim')).toBe('That request is no longer waiting on you.');
  });

  it('says why a Cancel cancelled nothing', () => {
    expect(cancelResultMessage(true, null, 'Sam Kim')).toBe('Request cancelled.');
    expect(cancelResultMessage(false, 'friends', 'Sam Kim')).toBe(
      "Sam already accepted, so you're friends now. Remove Sam from your friends if you'd rather not be.",
    );
    expect(cancelResultMessage(false, 'none', 'Sam Kim')).toBe('That request was already withdrawn.');
    expect(cancelResultMessage(false, null, null)).toBe('That request was already withdrawn.');
  });

  it('ages a request and dates a friendship in the device zone', () => {
    expect(requestAgoLabel(iso(-30_000), NOW)).toBe('just now');
    expect(requestAgoLabel(iso(-5 * 60_000), NOW)).toBe('5m ago');
    expect(requestAgoLabel(iso(-3 * H), NOW)).toBe('3h ago');
    expect(requestAgoLabel(iso(-2 * D), NOW)).toBe('2d ago');
    expect(requestAgoLabel(iso(-15 * D), NOW)).toBe('2w ago');
    expect(requestAgoLabel(null, NOW)).toBeNull();
    expect(friendsSinceLabel(iso(-H), NOW)).toBe('Friends since today');
    expect(friendsSinceLabel(new Date(2026, 9, 2, 9).toISOString(), NOW)).toBe('Friends since Oct 2');
    expect(friendsSinceLabel(new Date(2025, 11, 30, 9).toISOString(), NOW)).toBe('Friends since Dec 30, 2025');
    expect(friendsSinceLabel('nope', NOW)).toBeNull();
  });
});

describe('lock-screen Accept / Decline', () => {
  it('tells a replay apart from a real answer', () => {
    expect(friendActionOutcome(true, 'accepted', null)).toBe('accepted');
    expect(friendActionOutcome(false, 'declined', null)).toBe('declined');
    // Accepted in the app (or the first press landed), then pressed again.
    expect(friendActionOutcome(true, 'gone', 'friends')).toBe('already_friends');
    expect(friendActionOutcome(false, 'gone', 'friends')).toBe('already_friends');
    // They cancelled, or the status read failed.
    expect(friendActionOutcome(true, 'gone', 'none')).toBe('gone');
    expect(friendActionOutcome(true, 'gone', null)).toBe('gone');
    // A second Decline: nothing waits on me, which is what it asked for.
    expect(friendActionOutcome(false, 'gone', 'none')).toBe('declined');
  });

  it('names the requester when the push title did', () => {
    expect(friendActionNotice('accepted', 'Sam')).toEqual({ title: "You're friends: Sam", body: "You'll see each other at the courts now." });
    expect(friendActionNotice('accepted', null).title).toBe("You're friends");
    expect(friendActionNotice('already_friends', 'Sam').title).toBe('Already friends: Sam');
    expect(friendActionNotice('declined', 'Sam')).toEqual({ title: 'Declined: Sam', body: "We won't tell them." });
    expect(friendActionNotice('gone', 'Sam').title).toBe('Nothing to answer');
    // An Accept on a request I declined earlier: never "Declined".
    expect(friendActionOutcome(true, 'already_declined', null)).toBe('already_declined');
    expect(friendActionNotice('already_declined', 'Sam')).toEqual({
      title: 'Already declined: Sam',
      body: "You declined this request earlier. Send them a request from their profile if you'd like to be friends.",
    });
  });
});

describe('cache keys and the route', () => {
  it('every friend key sits under one prefix (one invalidate refetches them all)', () => {
    expect(FRIEND_REQUESTS_KEY.startsWith(`${FRIENDS_KEY}:`)).toBe(true);
    expect(friendStatusKey('u1')).toBe('friends:status:u1');
  });

  it('the friends path resolves only while the flag is on', () => {
    const last = getStateFromPath('friends', linking.config)?.routes.at(-1)?.name;
    if (FRIENDS_AT_COURTS_ENABLED) expect(last).toBe('Friends');
    else expect(last).not.toBe('Friends');
    if (FRIENDS_AT_COURTS_ENABLED) {
      expect(getStateFromPath('friends?tab=find', linking.config)?.routes.at(-1)?.params).toEqual({ tab: 'find' });
    }
  });
});
