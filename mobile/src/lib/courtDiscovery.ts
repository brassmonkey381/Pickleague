// Court discovery's rules (state/court-discovery-plan.md, Phase 1): the rows
// list_courts_nearby / get_court send, normalised; what a list row says and
// reads out; the name filter, quick chips and sorts; and whether a court's
// page offers Check in or Directions.
//
// PURE: no React Native, no Supabase, no kit UI imports, so vitest covers it
// (lib/__tests__/courtDiscovery.test.ts). data/courtDiscovery.ts does the
// reads; components/court/CourtListRow and the two screens draw it.
import { crowdLineText, type CrowdNumbers } from './courtCrowd';

/** One court as the catalog has it (no live numbers: those come from venue_crowd). */
export type CourtRow = {
  id: string;
  name: string;
  kind: string;
  sport: string[];
  lat: number;
  lng: number;
  address: string | null;
  city: string | null;
  surface: string | null;
  indoor: boolean | null;
  lit: boolean | null;
  covered: boolean | null;
  access: string | null;
  fee: boolean | null;
  court_count: number | null;
  opening_hours: string | null;
  website: string | null;
  phone: string | null;
  attribution: string | null;
  source_url: string | null;
  unconfirmed: boolean;
  has_boundary: boolean;
  alias_count: number;
  league_count: number;
  /** From the search centre; null on a court page. */
  distance_m: number | null;
};

export type CourtLeague = { id: string; name: string };
export type CourtAlias = { id: string; name: string; source: string | null };

/** A court's page: the row plus what only the page needs. */
export type CourtDetail = CourtRow & {
  /** The id that was asked for (an alias opens its facility). */
  requested_id: string;
  aliases: CourtAlias[];
  /** GeoJSON Polygon / MultiPolygon, or null. */
  boundary: unknown;
  geofence_radius_m: number | null;
  leagues: CourtLeague[];
};

/** Rows per page (the RPC's p_limit). */
export const COURTS_PAGE = 50;
export const METERS_PER_MILE = 1609.344;

/** The radius chips, in miles; the RPC defaults to 5 (8,047 m). */
export const COURT_RADIUS_MILES = [5, 10, 25, 50] as const;
export const DEFAULT_COURT_RADIUS_MILES = 5;
/** "Widen to 25 mi" from the empty state. */
export const WIDEN_COURT_RADIUS_MILES = 25;

export function milesToMeters(mi: number): number {
  return Math.round(mi * METERS_PER_MILE);
}

// ── Normalising ──────────────────────────────────────────────────────────────

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const count = (v: unknown): number => Math.max(0, Math.floor(num(v) ?? 0));

/** One RPC row as a CourtRow; null when it has no id, name or point. */
export function normalizeCourtRow(raw: unknown): CourtRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const name = text(r.name);
  const lat = num(r.lat);
  const lng = num(r.lng);
  if (!id || !name || lat == null || lng == null) return null;
  const courts = num(r.court_count);
  return {
    id,
    name,
    kind: text(r.kind) ?? 'court',
    sport: Array.isArray(r.sport) ? r.sport.filter((s): s is string => typeof s === 'string') : [],
    lat,
    lng,
    address: text(r.address),
    city: text(r.city),
    surface: text(r.surface),
    indoor: bool(r.indoor),
    lit: bool(r.lit),
    covered: bool(r.covered),
    access: text(r.access),
    fee: bool(r.fee),
    court_count: courts != null && courts > 0 ? Math.floor(courts) : null,
    opening_hours: text(r.opening_hours),
    website: text(r.website),
    phone: text(r.phone),
    attribution: text(r.attribution),
    source_url: text(r.source_url),
    unconfirmed: r.unconfirmed === true,
    has_boundary: r.has_boundary === true,
    alias_count: count(r.alias_count),
    league_count: count(r.league_count),
    distance_m: num(r.distance_m),
  };
}

/** An RPC page as rows, dropping anything malformed. */
export function normalizeCourtRows(raw: unknown): CourtRow[] {
  if (!Array.isArray(raw)) return [];
  const out: CourtRow[] = [];
  for (const r of raw) {
    const row = normalizeCourtRow(r);
    if (row) out.push(row);
  }
  return out;
}

/** get_court's answer as a CourtDetail; null when it isn't one. */
export function normalizeCourtDetail(raw: unknown): CourtDetail | null {
  const row = normalizeCourtRow(raw);
  if (!row) return null;
  const r = raw as Record<string, unknown>;
  const leagues = Array.isArray(r.leagues)
    ? r.leagues.flatMap((l) => {
        const o = (l ?? {}) as Record<string, unknown>;
        const id = text(o.id);
        return id ? [{ id, name: text(o.name) ?? 'League' }] : [];
      })
    : [];
  const aliases = Array.isArray(r.aliases)
    ? r.aliases.flatMap((a) => {
        const o = (a ?? {}) as Record<string, unknown>;
        const id = text(o.id);
        return id ? [{ id, name: text(o.name) ?? '', source: text(o.source) }] : [];
      })
    : [];
  const fence = num(r.geofence_radius_m);
  return {
    ...row,
    requested_id: text(r.requested_id) ?? row.id,
    aliases,
    boundary: r.boundary ?? null,
    geofence_radius_m: fence != null && fence > 0 ? fence : null,
    leagues,
  };
}

/** The keyset cursor for the page after `rows` (null: that was the last page). */
export function nextCourtCursor(
  rows: readonly CourtRow[],
  pageSize: number = COURTS_PAGE,
): { afterM: number; afterId: string } | null {
  if (rows.length < pageSize) return null;
  const last = rows[rows.length - 1];
  return last && last.distance_m != null ? { afterM: last.distance_m, afterId: last.id } : null;
}

/** Pages joined in order, each court once (a court moved between pages keeps its first place). */
export function mergeCourtPages(...pages: readonly (readonly CourtRow[])[]): CourtRow[] {
  const seen = new Set<string>();
  const out: CourtRow[] = [];
  for (const page of pages) {
    for (const r of page) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** "0.3 mi", "12 mi", "800 ft" (players here think in miles). */
export function courtDistanceLabel(meters: number | null | undefined): string | null {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return null;
  const mi = meters / METERS_PER_MILE;
  if (mi < 0.1) return `${Math.max(1, Math.round((meters * 3.28084) / 10) * 10)} ft`;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/** "1.2 miles" for a screen reader. */
export function courtDistanceSpoken(meters: number | null | undefined): string | null {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return null;
  const mi = meters / METERS_PER_MILE;
  if (mi < 0.1) return 'less than a tenth of a mile';
  const n = mi < 10 ? Number(mi.toFixed(1)) : Math.round(mi);
  return `${n} ${n === 1 ? 'mile' : 'miles'}`;
}

/** "6 courts", "Indoor", "Lights", "Free": the short facts a list row shows. */
export function courtFactChips(r: Pick<CourtRow, 'court_count' | 'indoor' | 'lit' | 'fee' | 'access'>): string[] {
  const out: string[] = [];
  if (r.court_count != null) out.push(`${r.court_count} ${r.court_count === 1 ? 'court' : 'courts'}`);
  if (r.indoor === true) out.push('Indoor');
  if (r.lit === true) out.push('Lights');
  if (r.fee === false) out.push('Free');
  else if (r.fee === true) out.push('Fee');
  if (r.access === 'private' || r.access === 'customers' || r.access === 'members') out.push('Members only');
  return out;
}

/** "3 leagues" (null for none). */
export function leagueCountLabel(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? 'league' : 'leagues'}` : null;
}

/**
 * The crowd line a court shows: "6 playing now · mostly 3.5–4.0", plus
 * "· 2 friends" only while the friends feature is on (decision 4). null
 * while not loaded, or nobody is there.
 */
export function courtCrowdText(
  crowd: CrowdNumbers | null | undefined,
  flags: { friendsEnabled: boolean },
): string | null {
  return crowdLineText(crowd, null, { showFriends: flags.friendsEnabled });
}

/** Whether a court row / page draws the ☆ star (and offers its screen-reader action). */
export function showCourtStar(flags: { starsEnabled: boolean }): boolean {
  return flags.starsEnabled;
}

export type CourtRowView = {
  /** Meta-line parts after the distance: the city, then the league count. */
  meta: string[];
  distanceLabel: string | null;
  chips: string[];
  crowdText: string | null;
  showStar: boolean;
  /** The whole row as read out: "Lakeside Park, 1.2 miles, 6 playing now". */
  a11yLabel: string;
};

/** Everything a list row says, from the catalog row, its crowd and the flags. */
export function courtRowView(
  row: CourtRow,
  crowd: CrowdNumbers | null | undefined,
  flags: { friendsEnabled: boolean; starsEnabled: boolean; starred?: boolean },
): CourtRowView {
  const crowdText = courtCrowdText(crowd, flags);
  const leagues = leagueCountLabel(row.league_count);
  const meta = [row.city, leagues].filter((s): s is string => !!s);
  const spoken = [
    row.name,
    courtDistanceSpoken(row.distance_m),
    crowdText,
    leagues,
    row.unconfirmed ? 'not confirmed yet' : null,
    flags.starsEnabled && flags.starred ? 'one of your courts' : null,
  ].filter((s): s is string => !!s);
  return {
    meta,
    distanceLabel: courtDistanceLabel(row.distance_m),
    chips: courtFactChips(row),
    crowdText,
    showStar: showCourtStar(flags),
    a11yLabel: spoken.join(', '),
  };
}

// ── Filter, chips, sort ──────────────────────────────────────────────────────

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The name filter: every word of the query in the name, city or address. */
export function courtMatchesQuery(r: Pick<CourtRow, 'name' | 'city' | 'address'>, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  const hay = fold([r.name, r.city, r.address].filter(Boolean).join(' '));
  return q.split(' ').every((w) => hay.includes(w));
}

/** Quick chips: ★ My courts (starred), With leagues. */
export type CourtChip = 'starred' | 'leagues';

export function courtMatchesChips(r: CourtRow, chips: readonly string[], starredIds: ReadonlySet<string>): boolean {
  if (chips.includes('starred') && !starredIds.has(r.id)) return false;
  if (chips.includes('leagues') && r.league_count <= 0) return false;
  return true;
}

export type CourtSort = 'nearest' | 'name' | 'leagues';
export const COURT_SORT_LABELS: Record<CourtSort, string> = {
  nearest: 'Nearest',
  name: 'Name A–Z',
  leagues: 'Most leagues',
};
export const COURT_SORTS: readonly CourtSort[] = ['nearest', 'name', 'leagues'];

/** A sorted copy. Ties (and missing distances) fall back to nearest, then name. */
export function sortCourts(rows: readonly CourtRow[], sort: CourtSort): CourtRow[] {
  const dist = (r: CourtRow) => r.distance_m ?? Number.POSITIVE_INFINITY;
  const byNearest = (a: CourtRow, b: CourtRow) => dist(a) - dist(b) || a.name.localeCompare(b.name);
  const cmp =
    sort === 'name'
      ? (a: CourtRow, b: CourtRow) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byNearest(a, b)
      : sort === 'leagues'
        ? (a: CourtRow, b: CourtRow) => b.league_count - a.league_count || byNearest(a, b)
        : byNearest;
  return [...rows].sort(cmp);
}

/** Visible rows: filtered by name and chips, then sorted. */
export function visibleCourts(
  rows: readonly CourtRow[],
  opts: { query: string; chips: readonly string[]; starredIds: ReadonlySet<string>; sort: CourtSort },
): CourtRow[] {
  return sortCourts(
    rows.filter((r) => courtMatchesQuery(r, opts.query) && courtMatchesChips(r, opts.chips, opts.starredIds)),
    opts.sort,
  );
}

// ── Check in or Directions ───────────────────────────────────────────────────

export type LatLngLike = { lat: number; lng: number };

/** How far past the fence a fix may be and still offer Check in. */
export const CHECKIN_SLACK_M = 150;
/** The fence when a court has none stored (the check-in default). */
export const DEFAULT_FENCE_M = 100;

export function metersBetween(a: LatLngLike, b: LatLngLike): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** GeoJSON Polygon / MultiPolygon rings as [lng, lat] lists; [] for anything else. */
function boundaryPolygons(boundary: unknown): number[][][][] {
  const g = boundary as { type?: unknown; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) return [];
  if (g.type === 'Polygon') return [g.coordinates as number[][][]];
  if (g.type === 'MultiPolygon') return g.coordinates as number[][][][];
  return [];
}

function inRing(p: LatLngLike, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] ?? [];
    const [xj, yj] = ring[j] ?? [];
    if (![xi, yi, xj, yj].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The court's outline for its page map (PlaceMap `boundary`): every ring of a
 * Polygon / MultiPolygon as {lat, lng} points, skipping malformed positions
 * and rings left with under 3 points. [] for no outline or anything else.
 */
export function courtOutlineRings(boundary: unknown): LatLngLike[][] {
  const rings: LatLngLike[][] = [];
  for (const poly of boundaryPolygons(boundary)) {
    if (!Array.isArray(poly)) continue;
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      const pts = ring
        .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([lng, lat]) => ({ lat, lng }));
      if (pts.length >= 3) rings.push(pts);
    }
  }
  return rings;
}

/** Inside a GeoJSON outline (an outer ring, not in one of its holes). */
export function pointInBoundary(p: LatLngLike, boundary: unknown): boolean {
  return boundaryPolygons(boundary).some(
    (poly) => poly.length > 0 && inRing(p, poly[0]) && !poly.slice(1).some((hole) => inRing(p, hole)),
  );
}

/**
 * The court page's main button. Check in when there is no fix yet (the tap
 * takes one, and the server judges it), or the last fix is within the fence +
 * 150 m or inside the outline. Otherwise Directions: the player isn't there.
 */
export function courtPrimaryAction(
  court: { lat: number; lng: number; geofence_radius_m: number | null; boundary: unknown },
  fix: LatLngLike | null | undefined,
): 'check_in' | 'directions' {
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return 'check_in';
  if (pointInBoundary(fix, court.boundary)) return 'check_in';
  const fence = court.geofence_radius_m ?? DEFAULT_FENCE_M;
  return metersBetween(fix, court) <= fence + CHECKIN_SLACK_M ? 'check_in' : 'directions';
}

// ── Links ────────────────────────────────────────────────────────────────────

/**
 * A venue id as one URL path segment, encoded exactly as React Navigation
 * encodes a path param (anything outside RFC 3986's pchar, so '/' but not
 * ':'): 'osm:way/123' -> 'osm:way%2F123'. The address bar and a shared link
 * then read the same.
 */
export function courtPathSegment(venueId: string): string {
  return Array.from(venueId)
    .map((ch) => (/[^A-Za-z0-9\-._~!$&'()*+,;=:@]/.test(ch) ? encodeURIComponent(ch) : ch))
    .join('');
}

/** The court's share URL (the canonical origin, like ShareLinkButton's other links). */
export function courtShareUrl(venueId: string): string {
  return `https://www.pickleague.club/courts/${courtPathSegment(venueId)}`;
}

/** "Alameda, CA" from nearest_us_city / us_cities; null without a city. */
export function cityLabel(c: { city?: unknown; state?: unknown; state_code?: unknown } | null | undefined): string | null {
  const city = text(c?.city);
  if (!city) return null;
  const st = text(c?.state) ?? text(c?.state_code);
  return st ? `${city}, ${st}` : city;
}
