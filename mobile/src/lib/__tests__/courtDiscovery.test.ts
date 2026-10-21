import { describe, it, expect } from 'vitest';
import {
  courtCrowdText,
  courtDistanceLabel,
  courtFactChips,
  courtMatchesQuery,
  courtPathSegment,
  courtPrimaryAction,
  courtRowView,
  courtShareUrl,
  cityLabel,
  mergeCourtPages,
  nextCourtCursor,
  normalizeCourtDetail,
  normalizeCourtRow,
  normalizeCourtRows,
  showCourtStar,
  sortCourts,
  visibleCourts,
  type CourtRow,
} from '../courtDiscovery';
import { crowdLineText } from '../courtCrowd';

const RAW = {
  id: 'osm:way/123',
  name: '  Lakeside Park ',
  kind: 'court',
  sport: ['pickleball', 7],
  lat: '37.8',
  lng: -122.26,
  address: '',
  city: 'Oakland',
  surface: 'concrete',
  indoor: false,
  lit: true,
  covered: null,
  access: 'public',
  fee: false,
  court_count: '6',
  opening_hours: null,
  website: '  ',
  phone: null,
  attribution: '© OpenStreetMap contributors',
  source_url: null,
  unconfirmed: false,
  has_boundary: true,
  alias_count: 1,
  league_count: '3',
  distance_m: 1931.2,
};

function row(over: Partial<CourtRow> = {}): CourtRow {
  return { ...normalizeCourtRow(RAW)!, ...over };
}

const CROWD = { here_now: 6, band_low: 3.5, band_high: 4, friends_here: 2 };

describe('normalising rows', () => {
  it('trims text, blanks are null, numbers from strings, junk sports dropped', () => {
    const r = normalizeCourtRow(RAW)!;
    expect(r.name).toBe('Lakeside Park');
    expect(r.address).toBeNull();
    expect(r.website).toBeNull();
    expect(r.lat).toBe(37.8);
    expect(r.court_count).toBe(6);
    expect(r.league_count).toBe(3);
    expect(r.sport).toEqual(['pickleball']);
    expect(r.lit).toBe(true);
    expect(r.fee).toBe(false);
    expect(r.covered).toBeNull();
  });

  it('no id, name or point: no row; a malformed page keeps the good rows', () => {
    expect(normalizeCourtRow({ ...RAW, id: '' })).toBeNull();
    expect(normalizeCourtRow({ ...RAW, name: null })).toBeNull();
    expect(normalizeCourtRow({ ...RAW, lat: 'x' })).toBeNull();
    expect(normalizeCourtRow(null)).toBeNull();
    expect(normalizeCourtRows([RAW, { id: 'x' }, 5]).map((r) => r.id)).toEqual(['osm:way/123']);
    expect(normalizeCourtRows(null)).toEqual([]);
  });

  it('a zero or negative court count is unknown; counts never go negative', () => {
    expect(normalizeCourtRow({ ...RAW, court_count: 0 })!.court_count).toBeNull();
    expect(normalizeCourtRow({ ...RAW, alias_count: -2, league_count: null })!).toMatchObject({ alias_count: 0, league_count: 0 });
  });

  it('a court page: leagues, aliases, the fence and the asked-for id', () => {
    const d = normalizeCourtDetail({
      ...RAW,
      distance_m: null,
      requested_id: 'g:abc',
      aliases: [{ id: 'g:abc', name: 'Lakeside Pickleball', source: 'google' }, { name: 'no id' }],
      boundary: { type: 'Polygon', coordinates: [] },
      geofence_radius_m: 120,
      leagues: [{ id: 'l1', name: 'Tuesday Doubles' }, { id: '' }],
    })!;
    expect(d.requested_id).toBe('g:abc');
    expect(d.aliases).toEqual([{ id: 'g:abc', name: 'Lakeside Pickleball', source: 'google' }]);
    expect(d.leagues).toEqual([{ id: 'l1', name: 'Tuesday Doubles' }]);
    expect(d.geofence_radius_m).toBe(120);
    expect(d.distance_m).toBeNull();
    expect(normalizeCourtDetail({ ...RAW })!.requested_id).toBe('osm:way/123');
  });
});

describe('crowd: "N playing now · mostly 3.5–4.0" (decision 4)', () => {
  it('no friends part while the friends feature is off', () => {
    expect(courtCrowdText(CROWD, { friendsEnabled: false })).toBe('6 playing now · mostly 3.5–4.0');
    expect(courtCrowdText(CROWD, { friendsEnabled: true })).toBe('6 playing now · mostly 3.5–4.0 · 2 friends');
  });

  it('nothing before it loads, and nothing for an empty court', () => {
    expect(courtCrowdText(undefined, { friendsEnabled: true })).toBeNull();
    expect(courtCrowdText(null, { friendsEnabled: false })).toBeNull();
    expect(courtCrowdText({ ...CROWD, here_now: 0 }, { friendsEnabled: true })).toBeNull();
  });

  it('crowdLineText keeps its old default (friends shown)', () => {
    expect(crowdLineText(CROWD)).toBe('6 playing now · mostly 3.5–4.0 · 2 friends');
    expect(crowdLineText(CROWD, null, { showFriends: false })).toBe('6 playing now · mostly 3.5–4.0');
  });
});

describe('a list row', () => {
  it('the star follows COURT_STARS_ENABLED', () => {
    expect(showCourtStar({ starsEnabled: true })).toBe(true);
    expect(showCourtStar({ starsEnabled: false })).toBe(false);
    expect(courtRowView(row(), CROWD, { friendsEnabled: false, starsEnabled: false, starred: true }).showStar).toBe(false);
    expect(courtRowView(row(), CROWD, { friendsEnabled: false, starsEnabled: true }).showStar).toBe(true);
  });

  it('reads out name, distance, crowd, leagues (and the star only when shown)', () => {
    const v = courtRowView(row(), CROWD, { friendsEnabled: false, starsEnabled: true, starred: true });
    expect(v.a11yLabel).toBe('Lakeside Park, 1.2 miles, 6 playing now · mostly 3.5–4.0, 3 leagues, one of your courts');
    expect(v.distanceLabel).toBe('1.2 mi');
    expect(v.meta).toEqual(['Oakland', '3 leagues']);
    expect(v.chips).toEqual(['6 courts', 'Lights', 'Free']);
    const off = courtRowView(row({ unconfirmed: true }), undefined, { friendsEnabled: false, starsEnabled: false, starred: true });
    expect(off.a11yLabel).toBe('Lakeside Park, 1.2 miles, 3 leagues, not confirmed yet');
    expect(off.crowdText).toBeNull();
  });

  it('distance labels', () => {
    expect(courtDistanceLabel(30)).toBe('100 ft');
    expect(courtDistanceLabel(1609.344 * 12.4)).toBe('12 mi');
    expect(courtDistanceLabel(null)).toBeNull();
    expect(courtFactChips({ court_count: 1, indoor: true, lit: null, fee: true, access: 'private' })).toEqual([
      '1 court',
      'Indoor',
      'Fee',
      'Members only',
    ]);
  });
});

describe('filter, chips, sort', () => {
  const a = row({ id: 'a', name: 'Alder Grove', distance_m: 300, league_count: 0, city: 'Alameda' });
  const b = row({ id: 'b', name: 'Beacon Hill Courts', distance_m: 100, league_count: 2, city: 'Oakland' });
  const c = row({ id: 'c', name: 'Café Courts', distance_m: 200, league_count: 2, city: null, address: '1 Main St' });

  it('the name filter matches every word in name, city or address, ignoring accents and case', () => {
    expect(courtMatchesQuery(c, 'cafe')).toBe(true);
    expect(courtMatchesQuery(b, 'beacon oakland')).toBe(true);
    expect(courtMatchesQuery(c, 'main')).toBe(true);
    expect(courtMatchesQuery(a, 'beacon')).toBe(false);
    expect(courtMatchesQuery(a, '  ')).toBe(true);
  });

  it('sorts: nearest, name, most leagues (ties nearest first)', () => {
    expect(sortCourts([a, b, c], 'nearest').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortCourts([b, c, a], 'name').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortCourts([a, c, b], 'leagues').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('chips: my courts and with leagues', () => {
    const starred = new Set(['a']);
    expect(visibleCourts([a, b, c], { query: '', chips: ['starred'], starredIds: starred, sort: 'nearest' }).map((r) => r.id)).toEqual(['a']);
    expect(visibleCourts([a, b, c], { query: '', chips: ['leagues'], starredIds: starred, sort: 'nearest' }).map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('keyset paging: a full page has a cursor at its last row; pages merge once each', () => {
    expect(nextCourtCursor([a, b], 2)).toEqual({ afterM: b.distance_m, afterId: 'b' });
    expect(nextCourtCursor([a], 2)).toBeNull();
    expect(mergeCourtPages([a, b], [b, c]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('Check in or Directions', () => {
  const court = { lat: 37.8, lng: -122.26, geofence_radius_m: 100, boundary: null };
  const north = (m: number) => ({ lat: 37.8 + m / 111_195, lng: -122.26 });

  it('no fix yet: Check in (the tap takes one)', () => {
    expect(courtPrimaryAction(court, null)).toBe('check_in');
  });

  it('within the fence + 150 m: Check in; farther: Directions', () => {
    expect(courtPrimaryAction(court, north(240))).toBe('check_in');
    expect(courtPrimaryAction(court, north(260))).toBe('directions');
    expect(courtPrimaryAction({ ...court, geofence_radius_m: null }, north(240))).toBe('check_in');
  });

  it('inside the outline counts, however far from the pin', () => {
    const lng0 = -122.27;
    const lng1 = -122.25;
    const boundary = {
      type: 'Polygon',
      coordinates: [[[lng0, 37.79], [lng1, 37.79], [lng1, 37.81], [lng0, 37.81], [lng0, 37.79]]],
    };
    // 1 km north of the pin, still inside a 2 km-tall outline.
    expect(courtPrimaryAction({ ...court, boundary }, north(1000))).toBe('check_in');
    expect(courtPrimaryAction({ ...court, boundary }, north(3000))).toBe('directions');
  });
});

describe('links', () => {
  it("a venue id is one path segment ('/' encoded, ':' kept), as React Navigation writes it", () => {
    expect(courtPathSegment('osm:way/123')).toBe('osm:way%2F123');
    expect(courtShareUrl('osm:way/123')).toBe('https://www.pickleague.club/courts/osm:way%2F123');
    expect(courtShareUrl('g:ChIJ-abc_9')).toBe('https://www.pickleague.club/courts/g:ChIJ-abc_9');
    expect(decodeURIComponent(courtPathSegment('user:a b/c?d#e'))).toBe('user:a b/c?d#e');
  });

  it('city labels', () => {
    expect(cityLabel({ city: 'Alameda', state: 'CA' })).toBe('Alameda, CA');
    expect(cityLabel({ city: 'Alameda', state_code: 'CA' })).toBe('Alameda, CA');
    expect(cityLabel({ city: '' })).toBeNull();
    expect(cityLabel(null)).toBeNull();
  });
});
