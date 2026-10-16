import { describe, it, expect } from 'vitest';
import {
  EMPTY_FRIENDS_AT_COURTS,
  friendsCourtRow,
  isFriendsAtCourtsEmpty,
  liveOnly,
  normalizeFriendsAtCourts,
  peopleLine,
  sinceUntilLabel,
  yourCourtReasonLabel,
  yourCourtSubtitle,
  type FriendAtCourt,
  type FriendsCourtGroup,
} from '../friendsAtCourts';

// Local times in the device zone, as the RPC's timestamps read on the phone.
const at = (h: number, m: number, day = 15) => new Date(2026, 9, day, h, m).toISOString();

const person = (name: string, p: Partial<FriendAtCourt> = {}): FriendAtCourt => ({
  user_id: `u-${name}`,
  full_name: name,
  avatar_url: null,
  avatar_emoji: null,
  avatar_bg_color: null,
  is_close_friend: false,
  via_session: false,
  session_kind: null,
  checked_in_at: at(17, 40),
  expires_at: at(19, 30),
  ...p,
});

describe('peopleLine', () => {
  it('shows two first names and counts the rest', () => {
    const people = [person('Alex Kim'), person('Sam Lee'), person('Pat Ray'), person('Jo Doe')];
    expect(peopleLine(people)).toBe('Alex, Sam +2');
    expect(peopleLine(people.slice(0, 2))).toBe('Alex, Sam');
    expect(peopleLine(people.slice(0, 1))).toBe('Alex');
  });

  it('puts close friends first, then the earliest arrivals', () => {
    const people = [
      person('Late Comer', { checked_in_at: at(18, 10) }),
      person('Early Bird', { checked_in_at: at(17, 0) }),
      person('Best Friend', { is_close_friend: true, checked_in_at: at(18, 30) }),
    ];
    expect(peopleLine(people)).toBe('Best, Early +1');
  });

  it('falls back to "Player" for a missing name', () => {
    expect(peopleLine([person('', { full_name: null })])).toBe('Player');
  });
});

describe('sinceUntilLabel', () => {
  it('says the meridiem once when both ends share it', () => {
    expect(sinceUntilLabel(at(17, 40), at(19, 30))).toBe('since 5:40 · til 7:30 PM');
  });

  it('keeps both meridiems across noon', () => {
    expect(sinceUntilLabel(at(11, 30), at(13, 0))).toBe('since 11:30 AM · til 1 PM');
  });

  it('keeps both across midnight', () => {
    expect(sinceUntilLabel(at(21, 0), at(9, 0, 16))).toBe('since 9 PM · til 9 AM');
  });

  it('has no end without an until', () => {
    expect(sinceUntilLabel(at(17, 40), null)).toBe('since 5:40 PM');
    expect(sinceUntilLabel('bad', null)).toBe('');
  });
});

describe('friendsCourtRow', () => {
  it('builds the Home NOW row', () => {
    const g: FriendsCourtGroup = {
      venue_id: 'v1',
      venue_name: 'Lakeside',
      lat: 1,
      lng: 2,
      since: at(17, 40),
      until: at(19, 30),
      people: [person('Alex Kim'), person('Sam Lee'), person('Pat Ray'), person('Jo Doe')],
      others_here: 3,
    };
    expect(friendsCourtRow(g)).toEqual({
      title: 'Lakeside',
      subtitle: 'Alex, Sam +2 · since 5:40 · til 7:30 PM',
      trailing: '7 here',
    });
  });
});

describe('your courts', () => {
  it('shows the crowd line, or why the court is listed', () => {
    const base = { venue_id: 'v1', venue_name: 'Lakeside', band_low: null, band_high: null, friends_here: 0 };
    expect(yourCourtSubtitle({ ...base, reason: 'home', here_now: 6, band_low: 3.5, band_high: 4, friends_here: 2 })).toBe(
      '6 playing now · mostly 3.5–4.0 · 2 friends',
    );
    expect(yourCourtSubtitle({ ...base, reason: 'home', here_now: 0 })).toBe('League home court · No one checked in now');
    expect(yourCourtReasonLabel('favorite')).toBe('Your court');
    expect(yourCourtReasonLabel('frequent')).toBe('You play here often');
  });
});

describe('normalizeFriendsAtCourts', () => {
  it('reads an empty or broken payload as empty', () => {
    expect(normalizeFriendsAtCourts(null)).toEqual(EMPTY_FRIENDS_AT_COURTS);
    expect(normalizeFriendsAtCourts([])).toEqual(EMPTY_FRIENDS_AT_COURTS);
    expect(normalizeFriendsAtCourts({ now: 'x', courts: 3 })).toEqual(EMPTY_FRIENDS_AT_COURTS);
    expect(isFriendsAtCourtsEmpty(EMPTY_FRIENDS_AT_COURTS)).toBe(true);
    expect(isFriendsAtCourtsEmpty(undefined)).toBe(true);
  });

  it('drops people without ids and groups left empty, and coerces numbers', () => {
    const d = normalizeFriendsAtCourts({
      now: [
        { venue_id: 'v1', venue_name: 'Lakeside', since: at(17, 0), until: null, others_here: '2', people: [{ user_id: 'a', checked_in_at: at(17, 0) }, { full_name: 'No id' }] },
        { venue_id: 'v2', venue_name: 'Empty', people: [{ full_name: 'No id' }] },
      ],
      courts: [
        { venue_id: 'v3', venue_name: 'Park', reason: 'favorite', here_now: '4', band_low: '3.25', band_high: 3.75, friends_here: null },
        { venue_name: 'No id' },
        { venue_id: 'v4', reason: 'weird' },
      ],
    });
    expect(d.now).toHaveLength(1);
    expect(d.now[0].people.map((p) => p.user_id)).toEqual(['a']);
    expect(d.now[0].others_here).toBe(2);
    expect(d.courts).toEqual([
      { venue_id: 'v3', venue_name: 'Park', reason: 'favorite', here_now: 4, band_low: 3.25, band_high: 3.75, friends_here: 0 },
      { venue_id: 'v4', venue_name: 'A court', reason: 'frequent', here_now: 0, band_low: null, band_high: null, friends_here: 0 },
    ]);
    expect(isFriendsAtCourtsEmpty(d)).toBe(false);
  });

  it('takes the earliest arrival when the group has no since', () => {
    const d = normalizeFriendsAtCourts({
      now: [{ venue_id: 'v1', people: [{ user_id: 'a', checked_in_at: at(18, 0) }, { user_id: 'b', checked_in_at: at(17, 15) }] }],
    });
    expect(d.now[0].since).toBe(at(17, 15));
  });
});

describe('liveOnly', () => {
  it('drops ended check-ins and courts left empty, keeping the same object when nothing changed', () => {
    const g = (id: string, people: FriendAtCourt[]): FriendsCourtGroup => ({
      venue_id: id,
      venue_name: id,
      lat: null,
      lng: null,
      since: at(17, 0),
      until: at(19, 0),
      people,
      others_here: 0,
    });
    const d = {
      now: [
        g('a', [person('Alex', { expires_at: at(18, 0) }), person('Sam', { expires_at: at(19, 0) })]),
        g('b', [person('Pat', { expires_at: at(18, 0) })]),
      ],
      courts: [],
    };
    const later = new Date(2026, 9, 15, 18, 30).getTime();
    const live = liveOnly(d, later);
    expect(live.now.map((x) => x.venue_id)).toEqual(['a']);
    expect(live.now[0].people.map((p) => p.full_name)).toEqual(['Sam']);
    const early = new Date(2026, 9, 15, 17, 30).getTime();
    expect(liveOnly(d, early)).toBe(d);
  });
});
