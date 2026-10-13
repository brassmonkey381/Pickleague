import { describe, it, expect } from 'vitest';
import {
  categorizeEvent, eventStatusLabel, timeLeftLabel, myEventState, myEventChip,
  countEventFilters, matchesEventFilter, sortEventsByDate, LIVE_WINDOW_MS,
  type EventCategory,
} from '../eventModel';

const NOW = new Date('2026-10-13T12:00:00Z').getTime();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 3600000;

describe('categorizeEvent', () => {
  it('reads cancelled, live, past and scheduled from the confirmed slot clock', () => {
    expect(categorizeEvent({ status: 'cancelled', vote_ends_at: iso(H) }, null, NOW)).toBe('cancelled');
    expect(categorizeEvent({ status: 'scheduled', vote_ends_at: iso(-H) }, iso(H), NOW)).toBe('scheduled');
    expect(categorizeEvent({ status: 'scheduled', vote_ends_at: iso(-H) }, iso(-H), NOW)).toBe('live');
    expect(categorizeEvent({ status: 'scheduled', vote_ends_at: iso(-H) }, iso(-LIVE_WINDOW_MS - H), NOW)).toBe('past');
  });
  it('splits a voting event on its deadline', () => {
    expect(categorizeEvent({ status: 'voting', vote_ends_at: iso(H) }, null, NOW)).toBe('voting_open');
    expect(categorizeEvent({ status: 'voting', vote_ends_at: iso(-H) }, null, NOW)).toBe('vote_closed');
  });
});

describe('labels', () => {
  it('never repeats "Voting closed" and says Cancelled for a cancelled event', () => {
    const all: EventCategory[] = ['voting_open', 'vote_closed', 'scheduled', 'live', 'past', 'cancelled'];
    for (const c of all) expect(eventStatusLabel(c)).not.toMatch(/Voting closed.*Voting closed/);
    expect(eventStatusLabel('cancelled')).toBe('Cancelled');
    expect(eventStatusLabel('vote_closed')).not.toBe('Voting closed · Voting closed');
  });
  it('time left is null once the deadline passed', () => {
    expect(timeLeftLabel(iso(26 * H), NOW)).toBe('1d 2h left');
    expect(timeLeftLabel(iso(90 * 60000), NOW)).toBe('1h 30m left');
    expect(timeLeftLabel(iso(-H), NOW)).toBeNull();
  });
});

describe('myEventState', () => {
  const none = { votes: 0, inConfirmed: false, declined: false };
  it('voting: needs a vote until the viewer answers', () => {
    expect(myEventState('voting_open', none)).toBe('needs_vote');
    expect(myEventState('voting_open', { ...none, votes: 2 })).toBe('voted');
    expect(myEventState('voting_open', { ...none, declined: true })).toBe('out');
  });
  it('confirmed: RSVP until answered, and not once the time is over', () => {
    expect(myEventState('scheduled', none)).toBe('rsvp_needed');
    expect(myEventState('scheduled', { ...none, inConfirmed: true })).toBe('in');
    expect(myEventState('live', none, false)).toBeNull();
    expect(myEventState('past', { ...none, inConfirmed: true })).toBeNull();
  });
  it('maps states to chips', () => {
    expect(myEventChip('needs_vote')?.label).toBe('Vote needed');
    expect(myEventChip(null)).toBeNull();
  });
});

describe('list filters + order', () => {
  const items = [
    { id: 'past', category: 'past' as const, myState: null, dateIso: iso(-48 * H) },
    { id: 'cancel', category: 'cancelled' as const, myState: null, dateIso: iso(-2 * H) },
    { id: 'vote', category: 'voting_open' as const, myState: 'needs_vote' as const, dateIso: iso(72 * H) },
    { id: 'soon', category: 'scheduled' as const, myState: 'in' as const, dateIso: iso(24 * H) },
    { id: 'live', category: 'live' as const, myState: 'in' as const, dateIso: iso(-H) },
    { id: 'nodate', category: 'scheduled' as const, myState: null, dateIso: null },
  ];
  it('counts each chip; Past includes cancelled', () => {
    expect(countEventFilters(items)).toEqual({ all: 6, needs_vote: 1, upcoming: 4, past: 2 });
    expect(matchesEventFilter(items[1], 'past')).toBe(true);
  });
  it('live first, upcoming soonest first, ended newest first, unknown dates last in group', () => {
    expect(sortEventsByDate(items).map(i => i.id)).toEqual(['live', 'soon', 'vote', 'nodate', 'cancel', 'past']);
  });
});
