import { describe, it, expect } from 'vitest';
import {
  drillCalledOff,
  AGENDA_CAP,
  agendaVisible,
  agendaWhen,
  buildAgenda,
  calendarDayDiff,
  dayLabel,
  drillAgendaItems,
  eventAgendaItems,
  needsYouCount,
  pickSpotlightLeague,
  shortTime,
  spotlightHeaderLine,
  spotlightNextLine,
  timeAgoShort,
  timeLeft,
  tournamentAgendaItems,
  type AgendaEventInput,
  type AgendaItem,
} from '../agenda';

// A Tuesday afternoon, built in the device zone so day labels are stable
// whatever zone the test machine runs in.
const NOW_DATE = new Date(2026, 9, 13, 14, 0, 0); // Tue Oct 13 2026, 2 PM
const NOW = NOW_DATE.getTime();
const at = (days: number, hour: number, minute = 0) =>
  new Date(2026, 9, 13 + days, hour, minute, 0).toISOString();
const H = 60 * 60 * 1000;

function ev(over: Partial<AgendaEventInput> & { id: string }): AgendaEventInput {
  return {
    title: `Event ${over.id}`,
    leagueName: 'Dinks',
    status: 'scheduled',
    voteEndsAt: null,
    slot: null,
    iVoted: false,
    iDeclined: false,
    ...over,
  };
}

describe('eventAgendaItems', () => {
  it('an open vote I have not cast needs me, with Vote opening EventDetail at the vote', () => {
    const [item] = eventAgendaItems([ev({ id: 'v1', title: 'Thu play day', status: 'voting', voteEndsAt: at(1, 14) })], NOW);
    expect(item.kind).toBe('vote');
    expect(item.title).toBe('Vote: Thu play day');
    expect(item.needsYou).toBe(true);
    expect(item.leagueName).toBe('Dinks');
    expect(item.target).toEqual({ screen: 'EventDetail', params: { eventId: 'v1', title: 'Thu play day' } });
    expect(item.action).toEqual({
      label: 'Vote',
      target: { screen: 'EventDetail', params: { eventId: 'v1', title: 'Thu play day', focus: 'vote' } },
      slug: 'vote',
    });
  });

  it('drops votes I cast or declined, and closed votes', () => {
    const items = eventAgendaItems([
      ev({ id: 'a', status: 'voting', voteEndsAt: at(1, 14), iVoted: true }),
      ev({ id: 'b', status: 'voting', voteEndsAt: at(1, 14), iDeclined: true }),
      ev({ id: 'c', status: 'voting', voteEndsAt: at(-1, 14) }),
      ev({ id: 'd', status: 'voting', voteEndsAt: null }),
    ], NOW);
    expect(items).toEqual([]);
  });

  it('a confirmed event I have not answered offers RSVP until the time ends', () => {
    const [item] = eventAgendaItems([ev({ id: 's', slot: { startsAt: at(2, 18), endsAt: at(2, 20) } })], NOW);
    expect(item.needsYou).toBe(true);
    expect(item.deadline).toBe(at(2, 18));
    expect(item.action?.label).toBe('RSVP');
    expect(item.action?.target).toEqual({ screen: 'EventDetail', params: { eventId: 's', title: 'Event s', focus: 'rsvp' } });
  });

  it("an event I'm in is scheduled, not needs-you; one I declined is gone", () => {
    const items = eventAgendaItems([
      ev({ id: 'in', slot: { startsAt: at(2, 18), endsAt: at(2, 20) }, iVoted: true }),
      ev({ id: 'out', slot: { startsAt: at(2, 18), endsAt: at(2, 20) }, iDeclined: true }),
    ], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].needsYou).toBe(false);
    expect(items[0].action).toBeNull();
    expect(items[0].status).toBe("you're in");
  });

  it('a confirmed event stays on the list for 24h after it starts, then drops', () => {
    const live = eventAgendaItems([ev({ id: 'l', slot: { startsAt: at(0, 10), endsAt: at(0, 12) }, iVoted: true })], NOW);
    expect(live).toHaveLength(1);
    const old = eventAgendaItems([ev({ id: 'o', slot: { startsAt: at(-2, 10), endsAt: at(-2, 12) } })], NOW);
    expect(old).toEqual([]);
  });

  it('skips cancelled events and scheduled events with no confirmed slot', () => {
    expect(eventAgendaItems([ev({ id: 'x', status: 'cancelled', slot: { startsAt: at(1, 9), endsAt: null } }), ev({ id: 'y' })], NOW)).toEqual([]);
  });
});

describe('tournamentAgendaItems', () => {
  const base = { leagueName: 'The League', startTime: at(4, 9), status: 'registration', myStatus: 'approved', invited: false };

  it('an approved registration is a scheduled row with no button', () => {
    const [t] = tournamentAgendaItems([{ id: 't', name: 'Fall Open', ...base }]);
    expect(t.status).toBe('registered');
    expect(t.action).toBeNull();
    expect(t.forceLive).toBe(false);
  });

  it('an active tournament I play in is live, with Next match focusing my next match', () => {
    const [t] = tournamentAgendaItems([{ id: 't', name: 'Fall Open', ...base, status: 'active' }]);
    expect(t.forceLive).toBe(true);
    expect(t.action?.target).toEqual({
      screen: 'TournamentDetail',
      params: { tournamentId: 't', tournamentName: 'Fall Open', focus: 'next_match' },
    });
  });

  it('an invite opens the detail at the invite; finished tournaments drop out', () => {
    const items = tournamentAgendaItems([
      { id: 'i', name: 'Invite Cup', ...base, myStatus: 'pending', invited: true },
      { id: 'r', name: 'Request Cup', ...base, myStatus: 'pending' },
      { id: 'c', name: 'Old Cup', ...base, status: 'completed' },
    ]);
    expect(items.map((i) => i.status)).toEqual(['invited', 'requested']);
    expect(items[0].action).toMatchObject({ label: 'Respond', slug: 'invite' });
    expect(items[0].action?.target.params).toMatchObject({ focus: 'invite' });
    expect(items[1].action).toBeNull();
  });

  it('an open invite is a request: needs-you, due when registration closes (else at the start)', () => {
    const [closes, starts, request] = tournamentAgendaItems([
      { id: 'a', name: 'A', ...base, myStatus: 'pending', invited: true, registrationClosesAt: at(2, 12) },
      { id: 'b', name: 'B', ...base, myStatus: 'pending', invited: true },
      { id: 'c', name: 'C', ...base, myStatus: 'pending' },
    ], NOW);
    expect(closes).toMatchObject({ needsYou: true, deadline: at(2, 12) });
    expect(starts).toMatchObject({ needsYou: true, deadline: base.startTime });
    // A request I sent waits on the admin, not on me.
    expect(request).toMatchObject({ needsYou: false, deadline: null });
  });

  it('a waitlisted registration is labelled waitlisted, with no button and nothing needed', () => {
    const [t] = tournamentAgendaItems([{ id: 'w', name: 'Full Cup', ...base, myStatus: 'waitlisted' }], NOW);
    expect(t.status).toBe('waitlisted');
    expect(t.action).toBeNull();
    expect(t.needsYou).toBe(false);
  });

  it('an invite whose registration has closed no longer needs you (still listed)', () => {
    const [t] = tournamentAgendaItems([
      { id: 'a', name: 'A', ...base, myStatus: 'pending', invited: true, registrationClosesAt: at(-1, 12) },
    ], NOW);
    expect(t.needsYou).toBe(false);
    expect(t.action?.label).toBe('Respond');
  });
});

describe('drillAgendaItems', () => {
  it('names the partner, ends after its length, and carries its own dismiss', () => {
    const [d] = drillAgendaItems([{ id: 'd1', partnerName: 'Sam', startsAt: at(0, 17), lengthMinutes: 90 }]);
    expect(d.title).toBe('Drill with Sam');
    expect(d.endsAt).toBe(at(0, 18, 30));
    expect(d.dismissibleDrillId).toBe('d1');
    expect(d.target).toEqual({ screen: 'DrillRequests', params: { focusId: 'd1' } });
  });

  // Stage inputs: a session Thursday 6 PM (2 days out) on request r1.
  const stage = (over: Partial<Parameters<typeof drillAgendaItems>[0][number]> = {}) => ({
    id: 's1', partnerName: 'Sam Kim', startsAt: at(2, 18), lengthMinutes: 60,
    requestId: 'r1', court: 'Lake Merritt', myRsvp: null, partnerRsvp: null, ...over,
  });

  it('accepted with no court: "Drill with Sam" · pick a court, needs me, opens the request', () => {
    const [d] = drillAgendaItems([stage({ court: null })], NOW);
    expect(d).toMatchObject({ title: 'Drill with Sam', status: 'pick a court', needsYou: true, deadline: at(2, 18) });
    expect(d.target).toEqual({ screen: 'DrillRequests', params: { focusId: 'r1' } });
    expect(d.confirmDrillId).toBeUndefined();
    const [row] = buildAgenda([d], NOW).rows;
    expect(row.bucket).toBe('needsYou');
    expect(agendaWhen(row, NOW)).toEqual({ top: 'Thu', bottom: '6 PM' });
  });

  it('locked (court + time), unanswered: names the court and carries the inline Confirm', () => {
    const [d] = drillAgendaItems([stage()], NOW);
    expect(d).toMatchObject({ title: 'Drill with Sam at Lake Merritt', needsYou: true, deadline: at(2, 18), confirmDrillId: 's1', action: null });
    expect(d.target).toEqual({ screen: 'DrillRequests', params: { focusId: 's1' } });
    // Not today: no ✕, and never a ✕ next to Confirm.
    expect(d.dismissibleDrillId).toBeUndefined();
    const [partnerIn] = drillAgendaItems([stage({ partnerRsvp: 'on_my_way' })], NOW);
    expect(partnerIn.status).toBe('Sam confirmed');
    const [todayLocked] = drillAgendaItems([stage({ startsAt: at(0, 18) })], NOW);
    expect(todayLocked.dismissibleDrillId).toBeUndefined();
  });

  it('locked and I confirmed: Confirmed with a check-mark glyph, scheduled, no button', () => {
    const [d] = drillAgendaItems([stage({ myRsvp: 'on_my_way' })], NOW);
    expect(d).toMatchObject({ title: 'Drill with Sam at Lake Merritt', status: 'Confirmed', statusIcon: 'check-mark', needsYou: false, deadline: null });
    expect(d.confirmDrillId).toBeUndefined();
    expect(buildAgenda([d], NOW).rows[0].bucket).toBe('thisWeek');
    expect(needsYouCount([d], NOW)).toBe(0);
  });

  it("my partner can't make it: needs me, opens the request to reschedule", () => {
    for (const mine of [null, 'on_my_way'] as const) {
      const [d] = drillAgendaItems([stage({ myRsvp: mine, partnerRsvp: 'cant_make_it' })], NOW);
      expect(d).toMatchObject({ title: "Sam can't make it", status: 'reschedule', needsYou: true, deadline: at(2, 18) });
      expect(d.target).toEqual({ screen: 'DrillRequests', params: { focusId: 'r1' } });
      expect(d.confirmDrillId).toBeUndefined();
    }
  });

  it("today's scheduled session keeps its ✕; ended and 7+ day sessions drop", () => {
    const items = drillAgendaItems([
      stage({ id: 'today', startsAt: at(0, 18), myRsvp: 'on_my_way' }),
      stage({ id: 'ended', startsAt: at(0, 10) }),
      stage({ id: 'far', startsAt: at(7, 9) }),
      stage({ id: 'edge', startsAt: at(6, 21) }),
    ], NOW);
    expect(items.map((i) => i.key)).toEqual(['drill-today', 'drill-edge']);
    expect(items[0].dismissibleDrillId).toBe('today');
    expect(items[1].dismissibleDrillId).toBeUndefined();
  });

  it('a running session that needs an answer sorts live; needs-you drills order by start', () => {
    const items = drillAgendaItems([
      stage({ id: 'later', startsAt: at(3, 18) }),
      stage({ id: 'soon', startsAt: at(1, 9), court: null }),
      stage({ id: 'now', startsAt: at(0, 13, 30), myRsvp: 'on_my_way' }),
    ], NOW);
    expect(buildAgenda(items, NOW).rows.map((r) => [r.key, r.bucket])).toEqual([
      ['drill-now', 'live'],
      ['drill-soon', 'needsYou'],
      ['drill-later', 'needsYou'],
    ]);
  });
});

describe('buildAgenda ordering', () => {
  const items: AgendaItem[] = [
    // scheduled later this week
    ...eventAgendaItems([ev({ id: 'sat', slot: { startsAt: at(4, 9), endsAt: at(4, 11) }, iVoted: true })], NOW),
    // scheduled today
    ...drillAgendaItems([{ id: 'd', partnerName: 'Sam', startsAt: at(0, 18), lengthMinutes: 60 }]),
    // needs-you, deadline in 3 days
    ...eventAgendaItems([ev({ id: 'rsvp', slot: { startsAt: at(3, 18), endsAt: at(3, 20) } })], NOW),
    // needs-you, deadline tomorrow
    ...eventAgendaItems([ev({ id: 'vote', status: 'voting', voteEndsAt: at(1, 12) })], NOW),
    // live by status (a tournament in progress)
    ...tournamentAgendaItems([{ id: 'live', name: 'Live Cup', leagueName: null, startTime: at(-1, 9), status: 'active', myStatus: 'approved', invited: false }]),
    // live by clock (started an hour ago)
    ...eventAgendaItems([ev({ id: 'now', slot: { startsAt: at(0, 13), endsAt: at(0, 15) }, iVoted: true })], NOW),
    // next month: never on Home
    ...eventAgendaItems([ev({ id: 'far', slot: { startsAt: at(30, 9), endsAt: at(30, 11) }, iVoted: true })], NOW),
  ];

  it('live first, then needs-you by deadline, then today, then the week; later is left out', () => {
    const { rows, total } = buildAgenda(items, NOW);
    expect(rows.map((r) => r.key)).toEqual([
      'tournament-live',
      'event-now',
      'vote-vote',
      'event-rsvp',
      'drill-d',
      'event-sat',
    ]);
    expect(rows.map((r) => r.bucket)).toEqual(['live', 'live', 'needsYou', 'needsYou', 'today', 'thisWeek']);
    expect(total).toBe(6);
  });

  it('a live event that still needs an RSVP is live (live wins)', () => {
    const [row] = buildAgenda(eventAgendaItems([ev({ id: 'x', slot: { startsAt: at(0, 13), endsAt: at(0, 15) } })], NOW), NOW).rows;
    expect(row.bucket).toBe('live');
  });

  it('an undated registration is not up next', () => {
    const r = buildAgenda(tournamentAgendaItems([{ id: 'u', name: 'Undated', leagueName: null, startTime: null, status: 'registration', myStatus: 'approved', invited: false }]), NOW);
    expect(r.rows).toEqual([]);
  });

  it('caps at AGENDA_CAP but reports the full total', () => {
    const many = drillAgendaItems(Array.from({ length: 14 }, (_, i) => ({ id: `d${i}`, partnerName: 'P', startsAt: at(1, 8 + (i % 10)), lengthMinutes: 30 })));
    const r = buildAgenda(many, NOW);
    expect(r.rows).toHaveLength(AGENDA_CAP);
    expect(r.total).toBe(14);
  });
});

describe('agendaVisible', () => {
  const r = buildAgenda(
    drillAgendaItems(Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, partnerName: 'P', startsAt: at(1, 8 + (i % 10)), lengthMinutes: 30 }))),
    NOW,
  );

  it('shows 3, then "Show 7 more" inline up to 10, then says how many are beyond', () => {
    const collapsed = agendaVisible(r, false);
    expect(collapsed.shown).toHaveLength(3);
    expect(collapsed.moreInline).toBe(7);
    expect(collapsed.beyondCap).toBe(2);
    const open = agendaVisible(r, true);
    expect(open.shown).toHaveLength(10);
    expect(open.moreInline).toBe(0);
    expect(open.beyondCap).toBe(2);
  });

  it('counts the requests among the rows past the cap (for "+N more" -> Requests)', () => {
    // 12 drill sessions today: the 2 cut ones are scheduled, not requests.
    expect(r.hiddenRequests).toBe(0);
    const request = (i: number): AgendaItem => ({
      key: `req-${i}`, kind: 'join_request', title: 'x', leagueName: null, startsAt: null, endsAt: null,
      needsYou: true, deadline: null, status: null, requestedAt: null, target: { screen: 'DrillRequests', params: {} }, action: null,
    });
    const vote = (i: number): AgendaItem => ({ ...request(i), key: `vote-${i}`, kind: 'vote', deadline: at(1, 12) });
    // 10 votes (dated) fill the cap; the 2 undated requests sort after them and are cut.
    const mixed = buildAgenda([...Array.from({ length: 10 }, (_, i) => vote(i)), request(1), request(2)], NOW);
    expect(mixed.rows).toHaveLength(AGENDA_CAP);
    expect(mixed.hiddenRequests).toBe(2);
  });

  it('nothing to show more of when the list is short', () => {
    const short = buildAgenda(drillAgendaItems([{ id: 'a', partnerName: 'P', startsAt: at(0, 18), lengthMinutes: 30 }]), NOW);
    expect(agendaVisible(short, false)).toMatchObject({ moreInline: 0, beyondCap: 0 });
  });
});

describe('time labels', () => {
  it('shortTime drops :00 and uses 12-hour time', () => {
    expect(shortTime(new Date(2026, 0, 1, 18, 0))).toBe('6 PM');
    expect(shortTime(new Date(2026, 0, 1, 18, 30))).toBe('6:30 PM');
    expect(shortTime(new Date(2026, 0, 1, 0, 5))).toBe('12:05 AM');
    expect(shortTime(new Date(2026, 0, 1, 12, 0))).toBe('12 PM');
  });

  it('dayLabel: Today, Tmrw, weekday within the week, else a date', () => {
    expect(dayLabel(new Date(2026, 9, 13, 20), NOW_DATE)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 14, 8), NOW_DATE)).toBe('Tmrw');
    expect(dayLabel(new Date(2026, 9, 15, 8), NOW_DATE)).toBe('Thu');
    expect(dayLabel(new Date(2026, 10, 2, 8), NOW_DATE)).toBe('Nov 2');
  });

  it('calendarDayDiff counts calendar days, not 24h blocks', () => {
    expect(calendarDayDiff(new Date(2026, 9, 14, 0, 30), new Date(2026, 9, 13, 23, 30))).toBe(1);
    // Across the US DST change (Nov 1 2026): still 1 day.
    expect(calendarDayDiff(new Date(2026, 10, 2, 0, 30), new Date(2026, 10, 1, 0, 30))).toBe(1);
  });

  it('timeLeft reads minutes, hours, then days', () => {
    expect(timeLeft(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe('30m');
    expect(timeLeft(new Date(NOW + 5 * H).toISOString(), NOW)).toBe('5h');
    expect(timeLeft(new Date(NOW + 30 * H).toISOString(), NOW)).toBe('1d');
    expect(timeLeft(new Date(NOW - H).toISOString(), NOW)).toBe('now');
    expect(timeLeft(null, NOW)).toBeNull();
  });

  it('agendaWhen: Now for live, time left for a vote, day + time otherwise', () => {
    const rows = buildAgenda([
      ...eventAgendaItems([ev({ id: 'v', status: 'voting', voteEndsAt: new Date(NOW + 30 * H).toISOString() })], NOW),
      ...eventAgendaItems([ev({ id: 'l', slot: { startsAt: at(0, 13), endsAt: at(0, 15) }, iVoted: true })], NOW),
      ...eventAgendaItems([ev({ id: 's', slot: { startsAt: at(2, 18), endsAt: at(2, 20) }, iVoted: true })], NOW),
    ], NOW).rows;
    const byKey = Object.fromEntries(rows.map((r) => [r.key, agendaWhen(r, NOW)]));
    expect(byKey['event-l']).toEqual({ top: 'Now', bottom: null });
    expect(byKey['vote-v']).toEqual({ top: '1d', bottom: 'left' });
    expect(byKey['event-s']).toEqual({ top: 'Thu', bottom: '6 PM' });
  });

  it('agendaWhen for a request: time left to its deadline, else its age', () => {
    const req = (over: Partial<AgendaItem>): AgendaItem => ({
      key: 'r', kind: 'join_request', title: 'R', leagueName: null, startsAt: null, endsAt: null,
      needsYou: true, deadline: null, status: null, target: { screen: 'DrillRequests', params: {} }, action: null, ...over,
    });
    const when = (i: AgendaItem) => agendaWhen(buildAgenda([i], NOW).rows[0], NOW);
    expect(when(req({ deadline: new Date(NOW + 45 * 60_000).toISOString() }))).toEqual({ top: '45m', bottom: 'left' });
    expect(when(req({ requestedAt: new Date(NOW - 2 * 24 * H).toISOString() }))).toEqual({ top: '2d', bottom: 'ago' });
    expect(when(req({ requestedAt: new Date(NOW - 10_000).toISOString() }))).toEqual({ top: 'New', bottom: null });
    expect(when(req({}))).toEqual({ top: '', bottom: null });
  });

  it('timeAgoShort', () => {
    expect(timeAgoShort(new Date(NOW - 30_000).toISOString(), NOW)).toBe('now');
    expect(timeAgoShort(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(timeAgoShort(new Date(NOW - 3 * H).toISOString(), NOW)).toBe('3h');
    expect(timeAgoShort(new Date(NOW - 50 * H).toISOString(), NOW)).toBe('2d');
    expect(timeAgoShort(null, NOW)).toBeNull();
  });
});

describe('needsYouCount (the Home bell)', () => {
  it('counts every needs-you item, uncapped, live ones included; scheduled rows do not count', () => {
    const items: AgendaItem[] = [
      // a vote I owe + an RSVP that is live right now (both need me)
      ...eventAgendaItems([ev({ id: 'v', status: 'voting', voteEndsAt: at(1, 12) })], NOW),
      ...eventAgendaItems([ev({ id: 'live', slot: { startsAt: at(0, 13), endsAt: at(0, 15) } })], NOW),
      // scheduled, already in: not counted
      ...eventAgendaItems([ev({ id: 'in', slot: { startsAt: at(2, 18), endsAt: at(2, 20) }, iVoted: true })], NOW),
      // an open invite
      ...tournamentAgendaItems([{ id: 'i', name: 'I', leagueName: null, startTime: at(5, 9), status: 'registration', myStatus: 'pending', invited: true }], NOW),
    ];
    expect(needsYouCount(items, NOW)).toBe(3);
    // Past the 10-row cap, the count stays honest.
    const many = eventAgendaItems(
      Array.from({ length: 12 }, (_, i) => ev({ id: `v${i}`, status: 'voting', voteEndsAt: at(1, 8 + i) })),
      NOW,
    );
    expect(needsYouCount(many, NOW)).toBe(12);
    expect(needsYouCount([], NOW)).toBe(0);
  });
});

describe('league spotlight', () => {
  const active = { status: 'active', startDate: '2026-08-25' };
  const lg = (id: string, over: Partial<Parameters<typeof pickSpotlightLeague>[0][number]> = {}) =>
    ({ id, openVotes: 0, nextEventAt: null, season: null, ...over });

  it('picks an open vote first (closing soonest), then the soonest event, then a season, then the newest match', () => {
    expect(pickSpotlightLeague([], NOW)).toBeNull();
    expect(pickSpotlightLeague([
      lg('event', { nextEventAt: at(1, 18) }),
      lg('vote-late', { openVotes: 1, openVoteEndsAt: at(3, 9) }),
      lg('vote-soon', { openVotes: 1, openVoteEndsAt: at(1, 9) }),
    ], NOW)).toBe('vote-soon');
    expect(pickSpotlightLeague([
      lg('season', { season: active }),
      lg('later', { nextEventAt: at(4, 18) }),
      lg('sooner', { nextEventAt: at(2, 18) }),
    ], NOW)).toBe('sooner');
    // An event that already started is not "next".
    expect(pickSpotlightLeague([
      lg('started', { nextEventAt: at(0, 9) }),
      lg('season', { season: active }),
    ], NOW)).toBe('season');
    expect(pickSpotlightLeague([
      lg('old', { lastMatchAt: at(-9, 18) }),
      lg('recent', { lastMatchAt: at(-1, 18) }),
      lg('never'),
    ], NOW)).toBe('recent');
    // Two active seasons: the newer match wins; no facts at all: list order.
    expect(pickSpotlightLeague([
      lg('a', { season: active, lastMatchAt: at(-5, 18) }),
      lg('b', { season: active, lastMatchAt: at(-2, 18) }),
    ], NOW)).toBe('b');
    expect(pickSpotlightLeague([lg('first'), lg('second')], NOW)).toBe('first');
  });

  it('header line: league, then the season name (no week count)', () => {
    expect(spotlightHeaderLine('Dinks', 'Fall')).toBe('Dinks · Fall');
    expect(spotlightHeaderLine('Dinks', '  ')).toBe('Dinks');
    expect(spotlightHeaderLine('Dinks', null)).toBe('Dinks');
    expect(spotlightHeaderLine('Dinks', undefined)).toBe('Dinks');
  });

  it('next line: the next event, then the open votes', () => {
    expect(spotlightNextLine({ openVotes: 1, nextEventAt: at(2, 18) }, NOW)).toBe('Next: Thu 6 PM · 1 vote open');
    expect(spotlightNextLine({ openVotes: 0, nextEventAt: at(0, 18) }, NOW)).toBe('Next: today 6 PM');
    expect(spotlightNextLine({ openVotes: 2, nextEventAt: null }, NOW)).toBe('2 votes open');
    // Started already (it lives in NOW), and nothing at all.
    expect(spotlightNextLine({ openVotes: 0, nextEventAt: at(0, 9) }, NOW)).toBeNull();
    expect(spotlightNextLine({ openVotes: 0, nextEventAt: null }, NOW)).toBeNull();
  });
});

describe('drillCalledOff', () => {
  it('is true when either player answered cant_make_it', () => {
    expect(drillCalledOff([{ status: 'on_my_way' }, { status: 'cant_make_it' }])).toBe(true);
  });
  it('is false with no answers or only on_my_way', () => {
    expect(drillCalledOff(null)).toBe(false);
    expect(drillCalledOff([])).toBe(false);
    expect(drillCalledOff([{ status: 'on_my_way' }])).toBe(false);
  });
});
