import { describe, it, expect } from 'vitest';
import {
  buildPickleagueFeed,
  capCourtLines,
  courtOfPlace,
  placeLabel,
  previewRows,
  routineHeaderLine,
  signedUpTournaments,
  COURT_ROWS_CAP,
  MAX_FEED_COURTS,
  type FeedCourtLine,
  type FeedInput,
  type FeedMyCheckin,
  type FeedPerson,
} from '../pickleagueFeed';
import type { AgendaEventInput, AgendaItem, AgendaTournamentInput } from '../agenda';
import type { CourtRoutine } from '../courtRoutineRules';
import type { CourtPlan } from '../courtPlans';
import type { FriendAtCourt, FriendsAtCourts } from '../friendsAtCourts';
import type { FriendCourtPlan } from '../planSharing';

// Thu Oct 22 2026, 3 PM local.
const NOW = new Date(2026, 9, 22, 15, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();

const base = (p: Partial<FeedInput> = {}): FeedInput => ({
  now: NOW,
  events: [],
  tournaments: [],
  drills: [],
  requests: [],
  starred: [],
  routines: [],
  friendsAtCourts: null,
  friendIds: new Set(),
  ...p,
});

const friend = (id: string, p: Partial<FriendAtCourt> = {}): FriendAtCourt => ({
  user_id: id,
  full_name: `Name ${id}`,
  avatar_url: null,
  avatar_emoji: null,
  avatar_bg_color: null,
  is_close_friend: false,
  via_session: false,
  session_kind: null,
  checked_in_at: at(22, 14),
  expires_at: at(22, 17),
  ...p,
});

const fac = (now: FriendsAtCourts['now'], courts: FriendsAtCourts['courts'] = []): FriendsAtCourts => ({ now, courts });

const group = (venue: string, people: FriendAtCourt[], others = 0) => ({
  venue_id: venue,
  venue_name: `Court ${venue}`,
  lat: null,
  lng: null,
  since: people[0]?.checked_in_at ?? at(22, 14),
  until: null,
  people,
  others_here: others,
});

const routine = (p: Partial<CourtRoutine> = {}): CourtRoutine => ({
  id: 'r1',
  venueId: 'v-routine',
  venueName: 'Lakeside',
  lat: null,
  lng: null,
  radiusM: null,
  starred: true,
  autoCheckin: true,
  localTime: '18:00',
  days: 1 | 4 | 8 | 16 | 32 | 64 | 2,
  tz: 'America/Los_Angeles',
  lengthMin: 120,
  windows: [],
  active: true,
  next: null,
  occurrences: [
    { planId: 'p-today', plannedAt: at(22, 18), plannedEndAt: at(22, 20), status: 'planned', windows: [], sharedAt: null, shareSource: null },
    { planId: 'p-tomorrow', plannedAt: at(23, 18), plannedEndAt: at(23, 20), status: 'planned', windows: [], sharedAt: null, shareSource: null },
  ],
  ...p,
});

const tournament = (id: string, myStatus: string, p: Partial<AgendaTournamentInput> = {}): AgendaTournamentInput => ({
  id,
  name: `T ${id}`,
  leagueName: null,
  startTime: at(24, 9),
  status: 'registration',
  myStatus,
  invited: false,
  ...p,
});

const request = (key: string): AgendaItem => ({
  key,
  kind: 'match_confirm',
  title: 'Confirm score',
  leagueName: 'Dinks',
  startsAt: null,
  endsAt: null,
  needsYou: true,
  deadline: null,
  status: 'waiting on you',
  requestedAt: at(22, 9),
  target: { screen: 'MatchHistory', params: { title: 'x', initialMyMatchesOnly: true, highlightMatchId: 'm' } },
  action: null,
});

describe('which items qualify', () => {
  it('is empty with nothing loaded', () => {
    const f = buildPickleagueFeed(base());
    expect(f.total).toBe(0);
    expect(f.days).toEqual([]);
    expect(f.needsYou).toEqual([]);
  });

  it('shows only tournaments I signed up for (or was invited to)', () => {
    const regs = [
      tournament('in', 'approved'),
      tournament('req', 'pending'),
      tournament('wait', 'waitlisted'),
      tournament('inv', 'pending', { invited: true }),
      tournament('out', 'withdrawn'),
      tournament('no', 'rejected'),
      tournament('done', 'approved', { status: 'completed' }),
    ];
    expect(signedUpTournaments(regs).map((t) => t.id)).toEqual(['in', 'req', 'wait', 'inv']);
    const f = buildPickleagueFeed(base({ tournaments: regs }));
    const keys = [...f.needsYou, ...f.days.flatMap((d) => d.elsewhere)].map((r) => r.key).sort();
    expect(keys).toEqual(['tournament-in', 'tournament-inv', 'tournament-req', 'tournament-wait']);
    // The invite waits on me: pinned on top.
    expect(f.needsYou.map((r) => r.key)).toEqual(['tournament-inv']);
  });

  it('leaves out non-starred courts: frequent and league home courts get no card', () => {
    const f = buildPickleagueFeed(
      base({
        starred: [{ venueId: 'v-star', venueName: 'Star Park' }],
        friendsAtCourts: fac([], [
          { venue_id: 'v-star', venue_name: 'Star Park', reason: 'favorite', here_now: 3, band_low: null, band_high: null, friends_here: 0 },
          { venue_id: 'v-freq', venue_name: 'Often', reason: 'frequent', here_now: 9, band_low: null, band_high: null, friends_here: 0 },
          { venue_id: 'v-home', venue_name: 'Home Ct', reason: 'home', here_now: 4, band_low: null, band_high: null, friends_here: 0 },
        ]),
      }),
    );
    const today = f.days.find((d) => d.key === 'today')!;
    expect(today.courts.map((c) => c.venueId)).toEqual(['v-star']);
    expect(today.courts[0].crowd?.here_now).toBe(3);
    // Every star has a Today and a Tomorrow card, even empty; neither counts.
    expect(f.days.map((d) => d.key)).toEqual(['today', 'tomorrow']);
    expect(f.total).toBe(0);
  });

  it('shows friends at any court, but never someone who is not my friend', () => {
    const f = buildPickleagueFeed(
      base({
        friendIds: new Set(['f1']),
        friendsAtCourts: fac([
          group('v1', [friend('f1'), friend('mate')], 2),
          group('v2', [friend('stranger')]),
        ]),
      }),
    );
    const today = f.days[0];
    expect(today.courts.map((c) => c.venueId)).toEqual(['v1']);
    const lines = today.courts[0].lines;
    expect(lines.map((l) => l.key)).toEqual(['here|v1|f1']);
    // The league mate the read named counts with the anonymous others.
    expect(today.courts[0].othersHere).toBe(3);
    expect(f.total).toBe(1);
  });

  it('shows no friend lines until the friends list is known', () => {
    const f = buildPickleagueFeed(base({ friendIds: null, friendsAtCourts: fac([group('v1', [friend('f1')])]) }));
    expect(f.days).toEqual([]);
  });

  it('keeps a friend who left earlier today as a Left line, drops one who left yesterday', () => {
    const f = buildPickleagueFeed(
      base({
        friendIds: new Set(['a', 'b']),
        friendsAtCourts: fac([
          group('v1', [
            friend('a', { checked_in_at: at(22, 9), expires_at: at(22, 11) }),
            friend('b', { checked_in_at: at(21, 20), expires_at: at(21, 23) }),
          ]),
        ]),
      }),
    );
    expect(f.days[0].courts[0].lines.map((l) => l.kind)).toEqual(['left']);
  });

  it('hides a live event Home shows on its own card', () => {
    const events = [
      { id: 'e1', title: 'Ladder', leagueName: 'Dinks', status: 'scheduled', voteEndsAt: null, slot: { startsAt: at(22, 14), endsAt: at(22, 16) }, iVoted: true, iDeclined: false },
    ];
    expect(buildPickleagueFeed(base({ events })).days[0].elsewhere.map((r) => r.key)).toEqual(['event-e1']);
    expect(buildPickleagueFeed(base({ events, hideKeys: new Set(['event-e1']) })).days).toEqual([]);
  });
});

describe('day bands and ordering', () => {
  it('puts each scheduled item in its day and requests on top', () => {
    const events = [
      { id: 'later', title: 'Sat', leagueName: 'Dinks', status: 'scheduled', voteEndsAt: null, slot: { startsAt: at(24, 10), endsAt: at(24, 12) }, iVoted: true, iDeclined: false },
      { id: 'tmrw', title: 'Fri', leagueName: 'Dinks', status: 'scheduled', voteEndsAt: null, slot: { startsAt: at(23, 18), endsAt: at(23, 20) }, iVoted: true, iDeclined: false },
      { id: 'today', title: 'Tonight', leagueName: 'Dinks', status: 'scheduled', voteEndsAt: null, slot: { startsAt: at(22, 19), endsAt: at(22, 21) }, iVoted: true, iDeclined: false },
      { id: 'next-week', title: 'Far', leagueName: 'Dinks', status: 'scheduled', voteEndsAt: null, slot: { startsAt: at(30, 10), endsAt: at(30, 12) }, iVoted: true, iDeclined: false },
      { id: 'vote', title: 'Pick a day', leagueName: 'Dinks', status: 'voting', voteEndsAt: at(23, 9), slot: null, iVoted: false, iDeclined: false },
    ];
    const f = buildPickleagueFeed(base({ events, requests: [request('req-1')] }));
    expect(f.needsYou.map((r) => r.key)).toEqual(['vote-vote', 'req-1']);
    expect(f.days.map((d) => [d.key, d.elsewhere.map((r) => r.key)])).toEqual([
      ['today', ['event-today']],
      ['tomorrow', ['event-tmrw']],
      ['later', ['event-later']],
    ]);
    expect(f.days.map((d) => d.title)).toEqual(['Today', 'Tomorrow', 'Later this week']);
    expect(f.total).toBe(5);
  });

  it('files my routine stops under their day, drops dormant routines and finished stops', () => {
    const f = buildPickleagueFeed(base({ routines: [routine()] }));
    expect(f.days.map((d) => [d.key, d.courts.map((c) => c.lines.map((l) => l.key))])).toEqual([
      ['today', [['stop|p-today']]],
      ['tomorrow', [['stop|p-tomorrow']]],
    ]);
    expect(f.days[0].courts[0].routine).toBe(true);

    const dormant = buildPickleagueFeed(base({ routines: [routine({ starred: false })] }));
    expect(dormant.days).toEqual([]);
    const paused = buildPickleagueFeed(base({ routines: [routine({ active: false })] }));
    expect(paused.days).toEqual([]);

    const over = routine({
      occurrences: [{ planId: 'p-am', plannedAt: at(22, 9), plannedEndAt: at(22, 11), status: 'planned', windows: [], sharedAt: null, shareSource: null }],
    });
    expect(buildPickleagueFeed(base({ routines: [over] })).days).toEqual([]);
  });

  it('shows a skipped stop (for Undo) without counting it', () => {
    const skipped = routine({
      occurrences: [{ planId: 'p-today', plannedAt: at(22, 18), plannedEndAt: at(22, 20), status: 'cancelled', windows: [], sharedAt: null, shareSource: null }],
    });
    const f = buildPickleagueFeed(base({ routines: [skipped] }));
    expect(f.days[0].courts[0].lines).toHaveLength(1);
    expect(f.days[0].count).toBe(0);
    expect(f.total).toBe(0);
  });

  it('orders a court card: left, here (close friends first), then stops', () => {
    const f = buildPickleagueFeed(
      base({
        friendIds: new Set(['a', 'b', 'c']),
        starred: [{ venueId: 'v-routine', venueName: 'Lakeside' }],
        routines: [routine()],
        friendsAtCourts: fac([
          group('v-routine', [
            friend('a', { checked_in_at: at(22, 13) }),
            friend('b', { checked_in_at: at(22, 14), is_close_friend: true }),
            friend('c', { checked_in_at: at(22, 8), expires_at: at(22, 10) }),
          ]),
        ]),
      }),
    );
    expect(f.days[0].courts[0].lines.map((l) => l.key)).toEqual([
      'left|v-routine|c',
      'here|v-routine|b',
      'here|v-routine|a',
      'stop|p-today',
    ]);
  });

  it('puts courts with friends first and caps the friends-only cards, never a star', () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(`v${i}`, Array.from({ length: i + 1 }, (_, j) => friend(`f${i}-${j}`))));
    const ids = new Set(groups.flatMap((g) => g.people.map((p) => p.user_id)));
    const f = buildPickleagueFeed(base({ friendIds: ids, starred: [{ venueId: 'quiet', venueName: 'Aaa' }], friendsAtCourts: fac(groups) }));
    const today = f.days[0];
    expect(today.courts).toHaveLength(MAX_FEED_COURTS);
    expect(today.courts.map((c) => c.venueId)).toEqual(['v7', 'v6', 'v5', 'v4', 'v3', 'quiet']);
  });

  it('keeps every quiet starred court and routine court when friends fill the cap', () => {
    const groups = Array.from({ length: 6 }, (_, i) => group(`v${i}`, [friend(`f${i}`)]));
    const ids = new Set(groups.flatMap((g) => g.people.map((p) => p.user_id)));
    const f = buildPickleagueFeed(
      base({
        friendIds: ids,
        starred: [
          { venueId: 's1', venueName: 'Star 1' },
          { venueId: 's2', venueName: 'Star 2' },
          { venueId: 's3', venueName: 'Star 3' },
        ],
        routines: [routine()],
        friendsAtCourts: fac(groups),
      }),
    );
    const today = f.days.find((d) => d.key === 'today')!;
    const ids2 = today.courts.map((c) => c.venueId);
    for (const id of ['s1', 's2', 's3', 'v-routine']) expect(ids2).toContain(id);
    expect(today.courts.filter((c) => c.venueId.startsWith('v') && c.venueId !== 'v-routine')).toHaveLength(MAX_FEED_COURTS - 4);
  });
});

describe('courtOfPlace (which of my courts an item is at)', () => {
  const courts = [
    { id: 'v-lake', name: 'Lakeside Park Pickleball Courts', lat: 37.8, lng: -122.26 },
    { id: 'v-hub', name: 'The HUB Alameda', lat: 37.77, lng: -122.25 },
    { id: 'v-rec', name: 'Lakeside Rec Center', lat: null, lng: null },
  ];
  it('matches a catalog id first', () => {
    expect(courtOfPlace({ venueId: 'v-hub', name: 'Somewhere else' }, courts)?.id).toBe('v-hub');
  });
  it('matches coordinates within a block', () => {
    expect(courtOfPlace({ name: 'Picked on the map', lat: 37.8004, lng: -122.2603 }, courts)?.id).toBe('v-lake');
  });
  it('matches a typed name, ignoring the address and words like "courts"', () => {
    expect(courtOfPlace({ name: 'Lakeside Park, 666 Bellevue Ave, Oakland' }, courts)?.id).toBe('v-lake');
    expect(courtOfPlace({ name: 'the hub alameda pickleball' }, courts)?.id).toBe('v-hub');
  });
  it('refuses a name that fits two courts, one far away, or nothing to go on', () => {
    expect(courtOfPlace({ name: 'Lakeside' }, courts)).toBeNull();
    expect(courtOfPlace({ name: 'Lakeside Park', lat: 40.7, lng: -74 }, courts)).toBeNull();
    expect(courtOfPlace({}, courts)).toBeNull();
    expect(courtOfPlace(null, courts)).toBeNull();
  });
  it('needs the exact court name when coordinates cannot rule a name out', () => {
    const near = [
      { id: 'v-pa', name: 'Palo Alto Tennis Center', lat: null, lng: null },
      { id: 'v-mitch', name: 'Mitchell Park', lat: 37.42, lng: -122.11 },
    ];
    expect(courtOfPlace({ name: 'Palo Alto, CA' }, near)).toBeNull();
    expect(courtOfPlace({ name: 'Mitchell' }, near)).toBeNull();
    expect(courtOfPlace({ name: 'Mitchell Park Pickleball Courts' }, near)?.id).toBe('v-mitch');
    expect(courtOfPlace({ name: 'Palo Alto Tennis Center, 3005 Middlefield' }, near)?.id).toBe('v-pa');
    // Coordinates near the court: the veto ran, so a looser name still fits.
    expect(courtOfPlace({ name: 'Mitchell', lat: 37.43, lng: -122.11 }, near)?.id).toBe('v-mitch');
  });
  it('labels an Elsewhere line by its place name before the comma', () => {
    expect(placeLabel({ place: { name: 'The HUB, 1 Main St' } })).toBe('The HUB');
    expect(placeLabel({ place: null })).toBeNull();
  });
});

describe('court cards are the top layer', () => {
  const lake = { venueId: 'v-lake', venueName: 'Lakeside Park', lat: 37.8, lng: -122.26 };
  const star = { venueId: 'v-star', venueName: 'Star Park', lat: null, lng: null };
  const ev = (id: string, startsAt: string, place: AgendaEventInput['place'], p: Partial<AgendaEventInput> = {}): AgendaEventInput => ({
    id,
    title: `E ${id}`,
    leagueName: 'Dinks',
    status: 'scheduled',
    voteEndsAt: null,
    slot: { startsAt, endsAt: startsAt },
    iVoted: true,
    iDeclined: false,
    place,
    ...p,
  });
  const agendaKeys = (c: { lines: FeedCourtLine[] }) => c.lines.flatMap((l) => (l.kind === 'agenda' ? [l.row.key] : []));

  it('nests each item under its court in its day, and the rest under Elsewhere', () => {
    const f = buildPickleagueFeed(
      base({
        starred: [lake, star],
        routines: [routine({ venueId: 'v-routine', venueName: 'Routine Ct', lat: 37.5, lng: -122.1 })],
        events: [
          ev('tonight', at(22, 19), { name: 'Lakeside Park, Oakland' }),
          ev('nowhere', at(22, 20), null),
          ev('sat', at(24, 10), { lat: 37.8003, lng: -122.2601, name: 'Map pin' }),
        ],
        matches: [{ id: 'm1', opponentName: 'Sam Lee', leagueName: 'Dinks', scheduledAt: at(23, 17), place: { venueId: 'v-routine' } }],
        tournaments: [tournament('far', 'approved', { startTime: at(25, 9), place: { name: 'The HUB' } })],
      }),
    );
    const day = (k: string) => f.days.find((d) => d.key === k)!;
    const card = (k: string, v: string) => day(k).courts.find((c) => c.venueId === v)!;

    expect(agendaKeys(card('today', 'v-lake'))).toEqual(['event-tonight']);
    expect(day('today').elsewhere.map((r) => r.key)).toEqual(['event-nowhere']);
    expect(agendaKeys(card('tomorrow', 'v-routine'))).toEqual(['match-m1']);
    expect(card('tomorrow', 'v-routine').lines.map((l) => l.key)).toEqual(['agenda|match-m1', 'stop|p-tomorrow']);
    expect(agendaKeys(card('later', 'v-lake'))).toEqual(['event-sat']);
    expect(day('later').elsewhere.map((r) => r.key)).toEqual(['tournament-far']);
    // Counted once each: 3 events + 1 match + 1 tournament + 2 routine stops.
    expect(f.total).toBe(7);
  });

  it('gives every star a Today and a Tomorrow card, and a Later card only with something there', () => {
    const f = buildPickleagueFeed(base({ starred: [lake, star], events: [ev('sat', at(24, 10), { venueId: 'v-star' })] }));
    expect(f.days.map((d) => [d.key, d.courts.map((c) => c.venueId).sort()])).toEqual([
      ['today', ['v-lake', 'v-star']],
      ['tomorrow', ['v-lake', 'v-star']],
      ['later', ['v-star']],
    ]);
    const today = f.days[0];
    expect(today.courts.every((c) => c.lines.length === 0 && c.count === 0)).toBe(true);
  });

  it("never makes a card for a court that isn't mine: its item goes to Elsewhere", () => {
    const f = buildPickleagueFeed(base({ starred: [star], events: [ev('x', at(23, 18), { venueId: 'v-other', name: 'Other Park' })] }));
    const tmrw = f.days.find((d) => d.key === 'tomorrow')!;
    expect(tmrw.courts.map((c) => c.venueId)).toEqual(['v-star']);
    expect(tmrw.elsewhere.map((r) => r.key)).toEqual(['event-x']);
  });

  it("matches today's items to a court my friends are at", () => {
    const f = buildPickleagueFeed(
      base({
        friendIds: new Set(['f1']),
        friendsAtCourts: fac([{ ...group('v9', [friend('f1')]), venue_name: 'Bayview Courts' }]),
        drills: [{ id: 'd1', partnerName: 'Ann B', startsAt: at(22, 17), lengthMinutes: 60, place: { name: 'Bayview' }, court: 'Bayview', myRsvp: 'on_my_way' }],
      }),
    );
    expect(f.days[0].courts.map((c) => [c.venueId, c.venueName, c.lines.map((l) => l.kind)])).toEqual([['v9', 'Bayview Courts', ['here', 'agenda']]]);
    expect(f.days[0].elsewhere).toEqual([]);
  });

  it('keeps what needs me pinned, and mirrors it on its court without counting it twice', () => {
    const f = buildPickleagueFeed(
      base({
        starred: [lake],
        events: [
          ev('rsvp', at(22, 19), { name: 'Lakeside Park' }, { iVoted: false }),
          ev('vote', at(22, 19), { venueId: 'v-lake' }, { status: 'voting', voteEndsAt: at(24, 9), slot: null, iVoted: false }),
          ev('vote-nowhere', at(22, 19), null, { status: 'voting', voteEndsAt: at(24, 9), slot: null, iVoted: false }),
        ],
      }),
    );
    expect(f.needsYou.map((r) => r.key).sort()).toEqual(['event-rsvp', 'vote-vote', 'vote-vote-nowhere']);
    const lakeToday = f.days[0].courts[0];
    expect(lakeToday.lines.map((l) => (l.kind === 'agenda' ? [l.row.key, l.mirror] : l.kind))).toEqual([
      ['event-rsvp', true],
      ['vote-vote', true],
    ]);
    expect(lakeToday.count).toBe(0);
    expect(f.days[0].elsewhere).toEqual([]);
    expect(f.total).toBe(3);
  });

  it('never cuts a court with something of mine, only friends-only courts', () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(`v${i}`, [friend(`f${i}`)]));
    const ids = new Set(groups.flatMap((g) => g.people.map((p) => p.user_id)));
    const f = buildPickleagueFeed(
      base({
        friendIds: ids,
        starred: [lake],
        routines: [routine({ venueId: 'v-r2', venueName: 'Second', occurrences: [] })],
        events: [ev('e', at(22, 19), { venueId: 'v-r2' })],
        friendsAtCourts: fac(groups),
      }),
    );
    const today = f.days[0];
    expect(today.courts.map((c) => c.venueId)).toEqual(expect.arrayContaining(['v-lake', 'v-r2']));
    expect(today.courts).toHaveLength(MAX_FEED_COURTS);
  });

  it('drops a booked match 2 hours after its time', () => {
    const m = { id: 'old', opponentName: 'Sam', leagueName: null, scheduledAt: at(22, 12, 30) };
    expect(buildPickleagueFeed(base({ matches: [m] })).days).toEqual([]);
    const live = { ...m, id: 'now', scheduledAt: at(22, 14) };
    expect(buildPickleagueFeed(base({ matches: [live] })).days[0].elsewhere[0].title).toBe('Match vs Sam');
  });
});

describe('caps', () => {
  const p = (id: string): FeedPerson => ({ userId: id, name: id, avatarUrl: null, avatarEmoji: null, avatarBgColor: null, isCloseFriend: false });
  const left = (id: string): FeedCourtLine => ({ kind: 'left', key: `l${id}`, person: p(id), at: at(22, 8), endedAt: at(22, 9) });
  const here = (id: string): FeedCourtLine => ({ kind: 'here', key: `h${id}`, person: p(id), at: at(22, 14), until: null, viaSession: false });

  it('keeps every line under the cap', () => {
    expect(capCourtLines([left('1'), here('2')])).toEqual({ shown: [left('1'), here('2')], more: 0 });
  });

  it('drops the oldest finished visits first, then cuts at the cap', () => {
    const lines = [left('1'), left('2'), here('3'), here('4'), here('5'), here('6'), here('7')];
    const { shown, more } = capCourtLines(lines);
    expect(shown).toHaveLength(COURT_ROWS_CAP);
    expect(shown.map((l) => l.key)).toEqual(['l2', 'h3', 'h4', 'h5', 'h6', 'h7']);
    expect(more).toBe(1);
    const many = Array.from({ length: 9 }, (_, i) => here(String(i)));
    expect(capCourtLines(many).more).toBe(3);
  });

  it('drops friends here before my own agenda and stops', () => {
    const mine = { kind: 'agenda', key: 'a1', row: { id: 'e1' }, mirror: false } as unknown as FeedCourtLine;
    const lines = [here('1'), here('2'), here('3'), here('4'), here('5'), here('6'), mine];
    const { shown, more } = capCourtLines(lines);
    expect(shown.map((l) => l.key)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'a1']);
    expect(more).toBe(1);
  });

  it('previews rows until expanded', () => {
    expect(previewRows([1, 2, 3, 4, 5], 3, false)).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(previewRows([1, 2, 3, 4, 5], 3, true)).toEqual({ shown: [1, 2, 3, 4, 5], more: 0 });
    expect(previewRows([1], 3, false)).toEqual({ shown: [1], more: 0 });
  });
});

describe('routineHeaderLine', () => {
  it('names the first live routine and counts the rest', () => {
    expect(routineHeaderLine([])).toBe('Set up a routine');
    expect(routineHeaderLine([routine({ active: false })])).toBe('Set up a routine');
    const one = routineHeaderLine([routine({ days: 2 | 8 })]);
    expect(one.startsWith('My routine: ')).toBe(true);
    expect(one.endsWith(' at Lakeside')).toBe(true);
    expect(routineHeaderLine([routine(), routine({ id: 'r2' })]).endsWith(', +1 more')).toBe(true);
  });
});

describe('my own check-in (Doggle\'s own "Here now" line)', () => {
  const mine = (p: Partial<FeedMyCheckin> = {}): FeedMyCheckin => ({
    id: 'ci1',
    venueId: 'v-routine',
    venueName: 'Lakeside',
    checkedInAt: at(22, 14, 30),
    expiresAt: at(22, 16, 30),
    queued: false,
    playing: true,
    ...p,
  });

  it("shows on its court today, first among who's here, and marks the card", () => {
    const f = buildPickleagueFeed(
      base({
        friendIds: new Set(['a']),
        starred: [{ venueId: 'v-routine', venueName: 'Lakeside' }],
        routines: [routine()],
        friendsAtCourts: fac([group('v-routine', [friend('a', { checked_in_at: at(22, 13) })])]),
        mine: mine(),
      }),
    );
    const card = f.days[0].courts[0];
    expect(card.lines.map((l) => l.key)).toEqual(['mine|ci1', 'here|v-routine|a', 'stop|p-today']);
    expect(card.hereMine).toBe(true);
    expect(card.count).toBe(3);
    // Tomorrow's card for the same court is not "here".
    expect(f.days.find((d) => d.key === 'tomorrow')!.courts[0].hereMine).toBe(false);
  });

  it("makes a card for the court I'm at even when it isn't starred, and files today's items there", () => {
    const f = buildPickleagueFeed(
      base({
        mine: mine({ venueId: 'v-x', venueName: 'Court X' }),
        drills: [{ id: 'd1', partnerName: 'Ann B', startsAt: at(22, 17), lengthMinutes: 60, place: { venueId: 'v-x' }, court: 'Court X', myRsvp: 'on_my_way' }],
      }),
    );
    expect(f.days.map((d) => d.key)).toEqual(['today']);
    expect(f.days[0].courts.map((c) => [c.venueId, c.venueName, c.hereMine, c.lines.map((l) => l.kind)])).toEqual([
      ['v-x', 'Court X', true, ['mine', 'agenda']],
    ]);
    expect(f.days[0].elsewhere).toEqual([]);
  });

  it('drops a check-in that has run out (the copy on this device can outlive it)', () => {
    const f = buildPickleagueFeed(base({ mine: mine({ venueId: 'v-x', expiresAt: at(22, 14) }) }));
    expect(f.days).toEqual([]);
  });

  it("never cuts my check-in's court when friends fill the cap, and puts it first", () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(`v${i}`, [friend(`f${i}`)]));
    const ids = new Set(groups.flatMap((g) => g.people.map((p) => p.user_id)));
    const f = buildPickleagueFeed(
      base({ friendIds: ids, friendsAtCourts: fac(groups), mine: mine({ venueId: 'v-x', venueName: 'Aaa', playing: false }) }),
    );
    const courts = f.days[0].courts;
    expect(courts).toHaveLength(MAX_FEED_COURTS);
    expect(courts[0].venueId).toBe('v-x');
  });

  it('is never what gives way over the line cap', () => {
    const lines: FeedCourtLine[] = [
      { kind: 'mine', key: 'mine|ci1', checkin: mine() },
      ...Array.from({ length: COURT_ROWS_CAP + 2 }, (_, i): FeedCourtLine => ({
        kind: 'here',
        key: `here|${i}`,
        person: { userId: `u${i}`, name: `P${i}`, avatarUrl: null, avatarEmoji: null, avatarBgColor: null, isCloseFriend: false },
        at: at(22, 14),
        until: null,
        viaSession: false,
      })),
    ];
    const { shown } = capCourtLines(lines);
    expect(shown[0].key).toBe('mine|ci1');
    expect(shown).toHaveLength(COURT_ROWS_CAP);
  });
});

describe('my one-off planned check-ins (Doggle\'s "Plan a check-in for later")', () => {
  const plan = (p: Partial<CourtPlan> = {}): CourtPlan => ({
    planId: 'op1',
    venueId: 'v-away',
    venueName: 'Away Park',
    lat: null,
    lng: null,
    plannedAt: at(22, 18),
    plannedEndAt: at(22, 20),
    status: 'planned',
    starred: false,
    sharedAt: null,
    shareSource: null,
    lengthMin: 120,
    windows: [],
    ...p,
  });

  it('files each plan under its court in its day, at any court (no star needed)', () => {
    const f = buildPickleagueFeed(
      base({
        plans: [plan(), plan({ planId: 'op2', plannedAt: at(23, 9), plannedEndAt: at(23, 11) }), plan({ planId: 'op3', plannedAt: at(25, 9), plannedEndAt: at(25, 11) })],
      }),
    );
    expect(f.days.map((d) => [d.key, d.courts.map((c) => [c.venueId, c.venueName, c.lines.map((l) => l.key)])])).toEqual([
      ['today', [['v-away', 'Away Park', ['plan|op1']]]],
      ['tomorrow', [['v-away', 'Away Park', ['plan|op2']]]],
      ['later', [['v-away', 'Away Park', ['plan|op3']]]],
    ]);
    expect(f.total).toBe(3);
  });

  it("sits with a starred court's other lines in time order, after who's here", () => {
    const f = buildPickleagueFeed(
      base({
        friendIds: new Set(['a']),
        starred: [{ venueId: 'v-routine', venueName: 'Lakeside' }],
        routines: [routine()],
        friendsAtCourts: fac([group('v-routine', [friend('a')])]),
        plans: [plan({ venueId: 'v-routine', venueName: 'Lakeside', plannedAt: at(22, 16), plannedEndAt: at(22, 18) })],
      }),
    );
    expect(f.days[0].courts[0].lines.map((l) => l.key)).toEqual(['here|v-routine|a', 'plan|op1', 'stop|p-today']);
  });

  it('drops a kept plan and one more than 30 minutes past its time; keeps one 10 minutes past', () => {
    const f = buildPickleagueFeed(
      base({
        plans: [
          plan({ planId: 'kept', status: 'completed', plannedAt: at(22, 15, 10) }),
          plan({ planId: 'old', plannedAt: at(22, 14, 20), plannedEndAt: at(22, 16, 20) }),
          plan({ planId: 'late', plannedAt: at(22, 14, 50), plannedEndAt: at(22, 16, 50) }),
        ],
      }),
    );
    expect(f.days[0].courts[0].lines.map((l) => l.key)).toEqual(['plan|late']);
  });

  it("files today's items at a plan's court under its card", () => {
    const f = buildPickleagueFeed(
      base({
        plans: [plan()],
        drills: [{ id: 'd1', partnerName: 'Ann B', startsAt: at(22, 17), lengthMinutes: 60, place: { venueId: 'v-away' }, court: 'Away Park', myRsvp: 'on_my_way' }],
      }),
    );
    expect(f.days[0].courts[0].lines.map((l) => l.kind)).toEqual(['agenda', 'plan']);
    expect(f.days[0].elsewhere).toEqual([]);
  });

  it("never cuts a plan's court when friends fill the cap", () => {
    const groups = Array.from({ length: 8 }, (_, i) => group(`v${i}`, [friend(`f${i}`)]));
    const ids = new Set(groups.flatMap((g) => g.people.map((p) => p.user_id)));
    const f = buildPickleagueFeed(base({ friendIds: ids, friendsAtCourts: fac(groups), plans: [plan()] }));
    expect(f.days[0].courts.some((c) => c.venueId === 'v-away')).toBe(true);
  });
});

describe("friends' shared plans (plan sharing)", () => {
  const fplan = (id: string, owner: string, venue: string, when: string, p: Partial<FriendCourtPlan> = {}): FriendCourtPlan => ({
    planId: id,
    ownerId: owner,
    ownerName: `Name ${owner}`,
    placeId: venue,
    placeName: `Court ${venue}`,
    at: when,
    endAt: null,
    kind: 'once',
    avatarUrl: null,
    avatarEmoji: null,
    avatarBgColor: null,
    isFriend: true,
    isCloseFriend: false,
    lat: null,
    lng: null,
    ...p,
  });
  const star = (id: string) => ({ venueId: id, venueName: `Court ${id}`, lat: null, lng: null });
  const kinds = (c: { lines: FeedCourtLine[] }) => c.lines.map((l) => l.kind);
  const who = (id: string): FeedPerson => ({ userId: id, name: id, avatarUrl: null, avatarEmoji: null, avatarBgColor: null, isCloseFriend: false });

  it('files a plan under my court in its day band, and counts it', () => {
    const f = buildPickleagueFeed(
      base({
        starred: [star('v1')],
        friendIds: new Set(['a']),
        friendPlans: [fplan('fp1', 'a', 'v1', at(22, 18)), fplan('fp2', 'a', 'v1', at(23, 9), { kind: 'routine' })],
      }),
    );
    const today = f.days.find((d) => d.key === 'today')!;
    const tomorrow = f.days.find((d) => d.key === 'tomorrow')!;
    expect(kinds(today.courts[0])).toEqual(['friendPlan']);
    expect(today.count).toBe(1);
    const line = tomorrow.courts[0].lines[0];
    expect(line.kind === 'friendPlan' && line.plan.routine).toBe(true);
    expect(line.kind === 'friendPlan' && line.person.name).toBe('Name a');
  });

  it('leaves out anyone who is not my accepted friend, and everything while friends are unknown', () => {
    const plans = [fplan('fp1', 'a', 'v1', at(22, 18)), fplan('fp2', 'm', 'v1', at(22, 19), { isFriend: false })];
    const f = buildPickleagueFeed(base({ starred: [star('v1')], friendIds: new Set(['a', 'm']), friendPlans: plans }));
    expect(f.days[0].courts[0].lines.map((l) => l.key)).toEqual(['fplan|fp1']);
    expect(buildPickleagueFeed(base({ friendIds: new Set(['z']), friendPlans: plans })).days).toEqual([]);
    expect(buildPickleagueFeed(base({ friendIds: null, friendPlans: plans })).days).toEqual([]);
  });

  it('gives a court with nothing of mine its own card, which gives way first under the cap', () => {
    const stars = Array.from({ length: MAX_FEED_COURTS }, (_, i) => star(`s${i}`));
    const full = buildPickleagueFeed(
      base({ starred: stars, friendIds: new Set(['a']), friendPlans: [fplan('fp1', 'a', 'elsewhere', at(22, 18))] }),
    );
    expect(full.days[0].courts.map((c) => c.venueId)).not.toContain('elsewhere');
    const roomy = buildPickleagueFeed(
      base({ starred: [star('s0')], friendIds: new Set(['a']), friendPlans: [fplan('fp1', 'a', 'elsewhere', at(22, 18))] }),
    );
    const own = roomy.days[0].courts.find((c) => c.venueId === 'elsewhere')!;
    expect(own.venueName).toBe('Court elsewhere');
    expect(own.starred).toBe(false);
  });

  it('finds my court by name when the plan names another row of it', () => {
    const f = buildPickleagueFeed(
      base({
        starred: [{ venueId: 'v1', venueName: 'Lakeside Park', lat: 37.8, lng: -122.26 }],
        friendIds: new Set(['a']),
        friendPlans: [fplan('fp1', 'a', 'v1-dup', at(22, 18), { placeName: 'Lakeside Park', lat: 37.8, lng: -122.26 })],
      }),
    );
    expect(f.days[0].courts.map((c) => c.venueId)).toEqual(['v1']);
  });

  it('drops a plan once it is over, and one a friend here now came for', () => {
    const here = fac([group('v1', [friend('a', { expires_at: at(22, 18) })])]);
    const f = buildPickleagueFeed(
      base({
        starred: [star('v1')],
        friendIds: new Set(['a', 'b']),
        friendsAtCourts: here,
        friendPlans: [fplan('old', 'b', 'v1', at(22, 14)), fplan('soon', 'a', 'v1', at(22, 15, 15)), fplan('later', 'a', 'v1', at(22, 19))],
      }),
    );
    expect(f.days[0].courts[0].lines.map((l) => l.key)).toEqual(['here|v1|a', 'fplan|later']);
  });

  it('says whether my own stops and plans are shared', () => {
    const r = routine({
      occurrences: [
        { planId: 'p1', plannedAt: at(22, 18), plannedEndAt: at(22, 20), status: 'planned', windows: [], sharedAt: null, shareSource: null },
        { planId: 'p2', plannedAt: at(23, 18), plannedEndAt: at(23, 20), status: 'planned', windows: [], sharedAt: at(22, 9), shareSource: 'confirm' },
        { planId: 'p3', plannedAt: at(24, 18), plannedEndAt: at(24, 20), status: 'planned', windows: [], sharedAt: null, shareSource: 'hidden' },
      ],
    });
    const shared = (f: ReturnType<typeof buildPickleagueFeed>) =>
      f.days.flatMap((d) => d.courts.flatMap((c) => c.lines)).flatMap((l) => (l.kind === 'stop' ? [`${l.stop.planId}:${l.stop.planShared}`] : []));
    expect(shared(buildPickleagueFeed(base({ routines: [r] })))).toEqual(['p1:false', 'p2:true', 'p3:false']);
    // Auto-share on predicts the server: p1 reads Shared, "Only you" stays.
    expect(shared(buildPickleagueFeed(base({ routines: [r], autoShareRoutines: true })))).toEqual(['p1:true', 'p2:true', 'p3:false']);
    const plans = buildPickleagueFeed(
      base({
        plans: [
          { planId: 'o1', venueId: 'v9', venueName: 'Nine', lat: null, lng: null, plannedAt: at(22, 18), plannedEndAt: at(22, 20), status: 'planned', starred: false, sharedAt: at(22, 9), shareSource: 'plan', lengthMin: 120, windows: [] },
        ],
      }),
    );
    const line = plans.days[0].courts[0].lines[0];
    expect(line.kind === 'plan' && line.plan.planShared).toBe(true);
  });

  it("caps a busy card by hiding friends' furthest plans before friends here", () => {
    const lines: FeedCourtLine[] = [
      ...['a', 'b', 'c', 'd'].map((id): FeedCourtLine => ({ kind: 'here', key: `here|${id}`, person: who(id), at: at(22, 14), until: null, viaSession: false })),
      ...['p1', 'p2', 'p3'].map((id, i): FeedCourtLine => ({
        kind: 'friendPlan',
        key: `fplan|${id}`,
        person: who(id),
        plan: { planId: id, at: at(22, 17 + i), endAt: null, routine: false },
      })),
    ];
    const { shown, more } = capCourtLines(lines);
    expect(more).toBe(1);
    expect(shown.map((l) => l.key)).toEqual(['here|a', 'here|b', 'here|c', 'here|d', 'fplan|p1', 'fplan|p2']);
  });
});
