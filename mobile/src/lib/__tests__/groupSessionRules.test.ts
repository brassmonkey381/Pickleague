import { describe, it, expect } from 'vitest';
import {
  groupJoinOpen,
  islandGroupLine,
  meFirst,
  parseGroupSession,
  playedLabel,
  playerStatus,
  playingLine,
  tournamentEndsAt,
  NO_GROUP,
  type GroupPlayer,
} from '../groupSessionRules';

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

describe('groupJoinOpen', () => {
  const start = at(2026, 10, 30, 18);
  const end = at(2026, 10, 30, 21);

  it('opens on the day it starts', () => {
    expect(groupJoinOpen({ startsAt: iso(start), endsAt: iso(end), nowMs: at(2026, 10, 30, 8) })).toBe(true);
  });
  it('is closed the day before', () => {
    expect(groupJoinOpen({ startsAt: iso(start), endsAt: iso(end), nowMs: at(2026, 10, 29, 20) })).toBe(false);
  });
  it('stays open 2 hours after the end, then closes', () => {
    expect(groupJoinOpen({ startsAt: iso(start), endsAt: iso(end), nowMs: at(2026, 10, 30, 22, 59) })).toBe(true);
    expect(groupJoinOpen({ startsAt: iso(start), endsAt: iso(end), nowMs: at(2026, 10, 30, 23, 1) })).toBe(false);
  });
  it('runs past midnight for a late event', () => {
    const late = at(2026, 10, 30, 22);
    const lateEnd = at(2026, 10, 31, 1);
    expect(groupJoinOpen({ startsAt: iso(late), endsAt: iso(lateEnd), nowMs: at(2026, 10, 31, 2) })).toBe(true);
    expect(groupJoinOpen({ startsAt: iso(late), endsAt: iso(lateEnd), nowMs: at(2026, 10, 31, 4) })).toBe(false);
  });
  it('opens 2 hours early across midnight', () => {
    const early = at(2026, 10, 31, 0, 30);
    expect(groupJoinOpen({ startsAt: iso(early), endsAt: null, nowMs: at(2026, 10, 30, 23) })).toBe(true);
  });
  it('without an end, assumes 4 hours', () => {
    expect(groupJoinOpen({ startsAt: iso(start), endsAt: null, nowMs: at(2026, 10, 30, 23, 30) })).toBe(true);
    expect(groupJoinOpen({ startsAt: iso(start), endsAt: null, nowMs: at(2026, 10, 31, 0, 30) })).toBe(false);
  });
  it('with no start, only while live', () => {
    expect(groupJoinOpen({ startsAt: null, nowMs: start })).toBe(false);
    expect(groupJoinOpen({ startsAt: null, nowMs: start, live: true })).toBe(true);
  });
});

describe('tournamentEndsAt', () => {
  it('adds the expected length, or 4 hours', () => {
    const s = '2026-10-30T18:00:00.000Z';
    expect(tournamentEndsAt(s, 6)).toBe('2026-10-31T00:00:00.000Z');
    expect(tournamentEndsAt(s, null)).toBe('2026-10-30T22:00:00.000Z');
    expect(tournamentEndsAt(null, 3)).toBeNull();
  });
});

describe('parseGroupSession', () => {
  it('reads the server answer', () => {
    const g = parseGroupSession({
      can_view: true,
      can_join: true,
      players: [
        { user_id: 'u1', full_name: ' Sam ', started_at: '2026-10-30T18:00:00Z', ended_at: null, played_s: 600, is_me: false },
        { user_id: 'u2', full_name: null, started_at: '2026-10-30T17:00:00Z', ended_at: '2026-10-30T18:00:00Z', played_s: 3600, is_me: true },
        { user_id: null, started_at: 'x' },
      ],
    });
    expect(g.canView).toBe(true);
    expect(g.players).toHaveLength(2);
    expect(g.players[0].name).toBe('Sam');
    expect(g.players[1].name).toBe('A player');
    expect(g.players[1].isMe).toBe(true);
  });
  it('anything else is not in it', () => {
    expect(parseGroupSession(null)).toEqual(NO_GROUP);
    expect(parseGroupSession('x')).toEqual(NO_GROUP);
  });
});

const player = (over: Partial<GroupPlayer>): GroupPlayer => ({
  userId: 'u',
  name: 'Sam',
  avatarUrl: null,
  avatarEmoji: null,
  avatarBg: null,
  startedAt: '2026-10-30T18:00:00Z',
  endedAt: null,
  playedS: 0,
  isMe: false,
  ...over,
});

describe('lines', () => {
  it('counts who is playing now', () => {
    expect(playingLine([])).toBe('No one playing right now');
    expect(playingLine([player({}), player({ endedAt: '2026-10-30T19:00:00Z' })])).toBe('1 playing now');
  });
  it('says each row', () => {
    expect(playerStatus(player({}), () => '6 PM')).toBe('Playing · since 6 PM');
    expect(playerStatus(player({ endedAt: 'x', playedS: 80 * 60 + 30 }), () => '')).toBe('Played 1 h 20 min');
    expect(playedLabel(59)).toBe('0 min');
  });
  it('names the group on the island', () => {
    expect(islandGroupLine('Ladder Night', 1)).toBe('Ladder Night');
    expect(islandGroupLine('Ladder Night', 4)).toBe('Ladder Night · 4 playing');
  });
  it('puts me first', () => {
    const out = meFirst([player({ userId: 'a' }), player({ userId: 'me', isMe: true }), player({ userId: 'b' })]);
    expect(out.map((p) => p.userId)).toEqual(['me', 'a', 'b']);
  });
});

describe('pickGroupOffer', () => {
  const now = Date.parse('2026-10-30T18:30:00Z');
  it('offers the event I am in that is around now', async () => {
    const { pickGroupOffer } = await import('../playStartRules');
    expect(
      pickGroupOffer(
        [
          { kind: 'event', startsAt: '2026-10-30T18:00:00Z', endsAt: '2026-10-30T20:00:00Z', title: 'Ladder Night', groupId: 'e1' },
          { kind: 'drill', startsAt: '2026-10-30T18:30:00Z', title: 'Drill' },
        ],
        now,
      ),
    ).toEqual({ kind: 'event', id: 'e1', title: 'Ladder Night' });
  });
  it('nothing for one without an id, or far off', async () => {
    const { pickGroupOffer } = await import('../playStartRules');
    expect(pickGroupOffer([{ kind: 'tournament', startsAt: '2026-10-30T18:00:00Z', title: 'Open' }], now)).toBeNull();
    expect(pickGroupOffer([{ kind: 'event', startsAt: '2026-10-31T18:00:00Z', title: 'X', groupId: 'e' }], now)).toBeNull();
  });
});

describe('groupCardModel', () => {
  it('leads with how many played, me first in the tags', async () => {
    const { groupCardModel, shareDefaultDetails } = await import('../shareCards');
    const m = groupCardModel({
      title: 'Ladder Night', over: 'Alameda League', court: 'Lakeside', date: 'Today', myMinutes: 95,
      people: [{ name: 'Me M.', initials: 'MM' }, { name: 'Sam L.', initials: 'SL' }, { name: 'Pat D.', initials: 'PD' }],
    });
    expect(m.kind).toBe('group');
    expect(m.hero.big).toBe('3');
    expect(m.rows[0].items[0].people?.[0].name).toBe('Me M.');
    expect(m.stats.find((s) => s.id === 'mine')?.value).toBe('I played 1 h 35 min');
    expect(m.showsScores).toBe(false);
    expect(shareDefaultDetails(m).court).toBe(false);
  });
  it('alone, it leads with my time', async () => {
    const { groupCardModel } = await import('../shareCards');
    const m = groupCardModel({ title: 'X', over: null, court: null, date: 'Today', myMinutes: 40, people: [{ name: 'Me', initials: 'M' }] });
    expect(m.hero.big).toBe('40 min');
    expect(m.message).toBe('I played "X" on Pickleague 🥒');
  });
});
