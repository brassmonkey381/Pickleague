import { describe, expect, it } from 'vitest';
import {
  chipStatus,
  countsLine,
  courtEventBadge,
  eventsByCourt,
  hiddenReasonCopy,
  isCurrent,
  kindsLine,
  outsideEventFromRpc,
  outsideEventsFromRpc,
  OUTSIDE_EVENT_NOTE,
} from '../outsideEvents';
import { pushRoutes } from '../pushLinks';

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime(); // Fri Nov 6, noon (device zone)

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  title: 'Saturday open play',
  starts_at: new Date(NOW + 21 * HOUR).toISOString(),
  ends_at: null,
  kinds: ['open_play', 'social'],
  source_name: 'City of Albany',
  source_url: 'https://albany.example/open-play',
  venue_id: 'osm:way/1',
  going_count: 1,
  interested_count: 2,
  my_status: 'maybe',
  ...over,
});

describe('outsideEventFromRpc', () => {
  it('keeps a full row and marks it outside', () => {
    const e = outsideEventFromRpc(row())!;
    expect(e.source).toBe('external');
    expect(e.kinds).toEqual(['open_play', 'social']);
    expect(e.my_status).toBe('maybe');
    expect(e.seen).toBe(false);
  });
  it('drops a row with no link, and unknown kinds', () => {
    expect(outsideEventFromRpc(row({ source_url: null }))).toBeNull();
    expect(outsideEventFromRpc(row({ kinds: ['clinic', 'pickleparty'] }))!.kinds).toEqual(['clinic']);
    expect(outsideEventsFromRpc([row(), null, 7])).toHaveLength(1);
  });
});

describe('copy', () => {
  it('names Pickleague, never as the organizer', () => {
    expect(OUTSIDE_EVENT_NOTE).toContain("Pickleague doesn't run this event");
    expect(hiddenReasonCopy('removed by Pickleague')?.body).toContain('Pickleague');
  });
  it('kinds and counts', () => {
    const e = outsideEventFromRpc(row())!;
    expect(kindsLine(e)).toBe('Open play, Social');
    expect(countsLine(e)).toBe('1 going, 2 interested');
    expect(countsLine({ going_count: 0, interested_count: 0 })).toBeNull();
    expect(chipStatus('maybe')).toBe('interested');
    expect(chipStatus('going')).toBe('going');
  });
});

describe('isCurrent (the server rule)', () => {
  it('with an end: until the end', () => {
    expect(isCurrent({ starts_at: new Date(NOW - 3 * HOUR).toISOString(), ends_at: new Date(NOW + 60_000).toISOString() }, NOW)).toBe(true);
    expect(isCurrent({ starts_at: new Date(NOW - 30 * 60_000).toISOString(), ends_at: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(false);
  });
  it('with none: until an hour after the start', () => {
    expect(isCurrent({ starts_at: new Date(NOW - 30 * 60_000).toISOString(), ends_at: null }, NOW)).toBe(true);
    expect(isCurrent({ starts_at: new Date(NOW - 2 * HOUR).toISOString(), ends_at: null }, NOW)).toBe(false);
  });
});

describe('courtEventBadge', () => {
  it('on now wins', () => {
    const live = { starts_at: new Date(NOW - HOUR).toISOString(), ends_at: new Date(NOW + HOUR).toISOString() };
    const later = { starts_at: new Date(NOW + 3 * HOUR).toISOString(), ends_at: null };
    expect(courtEventBadge([later, live], NOW)).toEqual({ label: 'Event on now', live: true });
  });
  it('the next one this week names its day', () => {
    expect(courtEventBadge([{ starts_at: new Date(NOW + 3 * HOUR).toISOString(), ends_at: null }], NOW)?.label).toBe('Event today');
    expect(courtEventBadge([{ starts_at: new Date(NOW + 24 * HOUR).toISOString(), ends_at: null }], NOW)?.label).toBe('Event tomorrow');
    expect(courtEventBadge([{ starts_at: new Date(NOW + 3 * 24 * HOUR).toISOString(), ends_at: null }], NOW)?.label).toBe('Event Mon');
  });
  it('nothing past or past a week', () => {
    expect(courtEventBadge([{ starts_at: new Date(NOW + 8 * 24 * HOUR).toISOString(), ends_at: null }], NOW)).toBeNull();
    expect(courtEventBadge([{ starts_at: new Date(NOW - 2 * HOUR).toISOString(), ends_at: null }], NOW)).toBeNull();
    expect(courtEventBadge([], NOW)).toBeNull();
  });
});

describe('eventsByCourt', () => {
  it('groups pinned events, leaves the rest out', () => {
    const m = eventsByCourt(outsideEventsFromRpc([row(), row({ id: 'e2' }), row({ id: 'e3', venue_id: null })]));
    expect(m.get('osm:way/1')?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(m.size).toBe(1);
  });
});

describe('push link', () => {
  it('outside_event/<id> opens the event', () => {
    const r = pushRoutes({ wagersEnabled: false });
    expect(r['outside_event/']('abc', '')).toEqual(['PublicEvent', { eventId: 'abc' }]);
    expect(r['outside_event/']('-', '')).toEqual(['PublicEvents']);
  });
});
