// Play > Leagues / Tournaments: the pure rules for what shows where (plan
// section 4). Screens hand in rows they already loaded; this module decides
// which rows land in MINE and which in DISCOVER, what each quick chip counts,
// when chips and sort appear, how Discover sorts, and what gets saved.
//
// PURE: no React, no Supabase, no react-native. Saving the choices is the
// foundation's usePersistedState; this module only decides WHAT is saved
// (`toggleChip` keeps route-param chips out of it), so the vitest suite can pin
// every rule without rendering a screen.
//
// The rules that matter most (each has a test):
//   - MINE is structural, not a filter. Discover-only chips (Open to join,
//     In season, Distance, ...) never hide a Mine row; only search narrows it.
//   - MINE is hidden at 0 (514 of 517 accounts today).
//   - Private leagues show by default (the "Show private" sheet group is ON).
//   - The Mine CHIP means "only Mine": it hides Discover.
//   - A chip that came from route params (Home's "All yours (N) >") applies
//     to that visit only and is never written to storage.
//   - Sort falls back: Nearest needs the device's location; without it a
//     member gets "Near my courts" (the average of their leagues'
//     home_court_lat/lng; venue_checkins is empty and home_court is free
//     text); everyone else gets Most active.
//   - Discover's search area (lib/searchArea, `area` + `areaLimited`): with
//     an area, Discover rows outside it are left out, a row with no location
//     included (it can't be placed); Mine never is. The area replaces the
//     sheet's Distance (ignored then) and Nearest measures from its centre.
//     Without an area yet nothing is limited.
import { isAvailableAt } from '@just-messin-around/expo-foundation/scheduling/availability';
import { withinSearchArea, type SearchArea } from './searchArea';

export type PlayListKind = 'leagues' | 'tournaments';

/** Rows per Discover page (onEndReached loads the next one). */
export const PAGE_SIZE = 25;
/** Mine shows this many rows, then "Show all (N)" (every match while searching). */
export const MINE_PREVIEW = 5;
/** Quick chips and sort appear only once Discover holds more rows than this. */
export const QUICK_CHIP_THRESHOLD = 6;

// ── Shared value shapes ──────────────────────────────────────────────────────

/** Filter-sheet values (the foundation's FilterValues shape, restated so this
 *  module stays free of the /ui barrel and its react-native imports). */
export type SheetValues = Record<string, string | string[] | null>;

/** What usePersistedState keeps under `play:<list>:<userId>` (version 1). */
export type PlayPersisted = {
  /** Quick chips the USER turned on (never route-param chips). */
  chips: string[];
  /** Filter-sheet values. */
  sheet: SheetValues;
  /** Requested sort key; 'auto' = the fallback chain. */
  sort: string;
};

export const PLAY_PERSIST_VERSION = 1;

export type LatLng = { lat: number; lng: number };

// ── Search ───────────────────────────────────────────────────────────────────

/** Lower-cased, trimmed, inner whitespace collapsed. '' = no search. */
export function normalizeQuery(q: string | null | undefined): string {
  return (q ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Every word of the (normalized) query appears in at least one field. An
 *  empty query matches everything. "lake dinks" finds "Dinks" at "Lake Merritt". */
export function matchesQuery(fields: ReadonlyArray<string | null | undefined>, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const hay = fields.filter((f): f is string => typeof f === 'string' && f.length > 0).map((f) => f.toLowerCase());
  if (hay.length === 0) return false;
  return normalizedQuery.split(' ').every((word) => hay.some((h) => h.includes(word)));
}

// ── Distance ─────────────────────────────────────────────────────────────────

export const DISTANCE_OPTIONS = ['5', '10', '25', '50'] as const;
export type DistanceOption = typeof DISTANCE_OPTIONS[number];

/** Great-circle distance in miles (haversine). */
export function milesBetween(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pointOf(lat: number | null | undefined, lng: number | null | undefined): LatLng | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // (0, 0) is a missing value written as zeros, not a court in the Atlantic.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** A sheet value as a positive number ('25' -> 25); null for 'any', '' and the rest. */
export function positiveNumber(value: string | string[] | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The radius in miles a sheet's distance value asks for; null = Any. */
export function distanceMiles(value: string | string[] | null | undefined): number | null {
  return positiveNumber(value);
}

/** The next wider radius ("Widen to 50 mi"), or null at the widest. */
export function widerDistance(value: string | string[] | null | undefined): DistanceOption | null {
  const miles = distanceMiles(value);
  if (miles == null) return null;
  return DISTANCE_OPTIONS.find((o) => Number(o) > miles) ?? null;
}

/** "Within 25 mi". */
export function distanceLabel(value: string | string[] | null | undefined): string | null {
  const miles = distanceMiles(value);
  return miles == null ? null : `Within ${miles} mi`;
}

// ── Chips ────────────────────────────────────────────────────────────────────

/** Chips in effect for this visit: the saved ones plus the route-param ones. */
export function effectiveChips(saved: readonly string[], route: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of [...saved, ...route]) if (!out.includes(c)) out.push(c);
  return out;
}

/**
 * One chip tap. Turning a chip OFF removes it from both sets (the user turned
 * it off, whichever set it came from). Turning one ON adds it to `saved` only.
 * A route chip therefore never reaches `saved`, which is the only part that is
 * persisted.
 */
export function toggleChip(
  state: { saved: readonly string[]; route: readonly string[] },
  chip: string,
): { saved: string[]; route: string[]; on: boolean } {
  const on = !effectiveChips(state.saved, state.route).includes(chip);
  if (on) {
    return { saved: [...state.saved.filter((c) => c !== chip), chip], route: [...state.route], on };
  }
  return { saved: state.saved.filter((c) => c !== chip), route: state.route.filter((c) => c !== chip), on };
}

/** The chip toggled between two multi-select values arrays (FilterChipRow's
 *  onChangeValues hands back the whole new array). */
export function changedChip(prev: readonly string[], next: readonly string[]): string | null {
  return next.find((c) => !prev.includes(c)) ?? prev.find((c) => !next.includes(c)) ?? null;
}

/** Chips render only when Discover is long enough to need them, or when the
 *  user already has a filter on (so it can be turned off). */
export function quickChipsVisible(discoverRows: number, filtersOn: boolean): boolean {
  return discoverRows > QUICK_CHIP_THRESHOLD || filtersOn;
}

/** Sort is hidden while Discover has QUICK_CHIP_THRESHOLD rows or fewer. */
export function sortVisible(discoverRows: number): boolean {
  return discoverRows > QUICK_CHIP_THRESHOLD;
}

/** Whether a sheet value differs from its default (multi values compare as sets). */
function sheetValueDiffers(v: string | string[] | null | undefined, d: string | string[] | null | undefined): boolean {
  const norm = (x: typeof v) => (x == null || x === '' ? [] : Array.isArray(x) ? [...new Set(x)].sort() : [x]);
  const a = norm(v);
  const b = norm(d);
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

/** How many sheet groups differ from their defaults (the Filters button count). */
export function countSheetFilters(sheet: SheetValues, defaults: SheetValues): number {
  return Object.keys(defaults).filter((k) => sheetValueDiffers(sheet[k], defaults[k])).length;
}

/**
 * The sheet as it actually applies. A saved radius means nothing without a
 * device location (coords are never saved; they come only from a grant this
 * run), so while coords are null it reads as 'any': no "Within 25 mi" chip, no
 * count on Filters, no forced chip row for a filter that filters nothing. The
 * saved value itself is kept, so the radius is back once location is.
 */
export function sheetInEffect(sheet: SheetValues, coords: LatLng | null): SheetValues {
  return coords || distanceMiles(sheet.distance) == null ? sheet : { ...sheet, distance: 'any' };
}

// ── Paging + counts ──────────────────────────────────────────────────────────

/** Rows shown after `pages` pages of PAGE_SIZE. */
export function pagedCount(total: number, pages: number, pageSize = PAGE_SIZE): number {
  return Math.min(total, Math.max(1, pages) * pageSize);
}

/** "38 of 153" while rows are still unpaged, else just "153". */
export function countLabel(shown: number, total: number): string {
  return shown < total ? `${shown} of ${total}` : `${total}`;
}

// ══ Leagues ══════════════════════════════════════════════════════════════════

export type LeagueChip = 'mine' | 'open' | 'in_season' | 'has_tournaments' | 'saved';
export const LEAGUE_CHIPS: readonly LeagueChip[] = ['mine', 'open', 'in_season', 'has_tournaments', 'saved'];
export const LEAGUE_CHIP_LABELS: Record<LeagueChip, string> = {
  mine: 'Mine',
  open: 'Open to join',
  in_season: 'In season',
  has_tournaments: 'Has tournaments',
  saved: 'Saved',
};
/** Entry points that stay visible at a zero count. */
export const LEAGUE_PINNED_CHIPS: readonly LeagueChip[] = ['mine', 'saved'];

/** Sheet: Distance (needs "Use my location"), Show private (default ON), Min players. */
export const LEAGUE_SHEET_DEFAULTS: SheetValues = { distance: 'any', private: 'show', min_players: 'any' };
export const MIN_PLAYER_OPTIONS = ['5', '10', '20'] as const;

export type LeagueSortKey = 'nearest' | 'near_courts' | 'active' | 'newest' | 'name';
export type LeagueSort = 'auto' | LeagueSortKey;
export const LEAGUE_SORT_LABELS: Record<LeagueSortKey, string> = {
  nearest: 'Nearest',
  near_courts: 'Near my courts',
  active: 'Most active',
  newest: 'Newest',
  name: 'Name',
};

export const LEAGUE_PERSIST_DEFAULTS: PlayPersisted = { chips: [], sheet: LEAGUE_SHEET_DEFAULTS, sort: 'auto' };

/** The fields the league rules read. LeagueWithStats (+ saved / recentMatchCount)
 *  satisfies it structurally. */
export type PlayLeague = {
  id: string;
  name: string;
  home_court: string | null;
  home_court_lat?: number | null;
  home_court_lng?: number | null;
  /** false = private. Missing counts as open, as the list always did. */
  is_open?: boolean | null;
  created_at: string;
  myRole: 'admin' | 'co-admin' | 'member' | null;
  /** A pending join request: a PRIVATE league counts as Mine (see isMineLeague). */
  hasRequested?: boolean;
  memberCount: number;
  adminName?: string | null;
  /** Active seasons (an upcoming one is a row fact, not "In season"). */
  activeSeasonCount: number;
  /** Tournaments in registration or active. */
  activeTournamentCount: number;
  /** bookmarks(target_type='league'). */
  saved?: boolean;
  /** Matches in the last 30 days (Most active). */
  recentMatchCount?: number;
};

/** Member leagues, plus private leagues I've asked to join. A pending request
 *  to an OPEN league doesn't count: that league was private when I asked and
 *  has since opened, so it belongs in Discover with a plain [Join] (D8). */
export function isMineLeague(l: PlayLeague): boolean {
  return l.myRole != null || (!!l.hasRequested && l.is_open === false);
}

/** Search fields: name, raw court, the court's display nickname, admin name. */
export function leagueMatchesSearch(l: PlayLeague, q: string, courtLabel?: (raw: string | null) => string): boolean {
  return matchesQuery([l.name, l.home_court, courtLabel?.(l.home_court), l.adminName], q);
}

/** "Near my courts": the average of my (member) leagues' court coordinates.
 *  Null when I'm in no league with coordinates. */
export function myCourtsCenter(leagues: readonly PlayLeague[]): LatLng | null {
  const pts = leagues
    .filter((l) => l.myRole != null)
    .map((l) => pointOf(l.home_court_lat, l.home_court_lng))
    .filter((p): p is LatLng => p != null);
  if (pts.length === 0) return null;
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
  };
}

/** The sort actually used. Nearest needs coords; Near my courts needs a
 *  center; both fall back down the chain to Most active. */
export function resolveLeagueSort(
  requested: string | null | undefined,
  ctx: { coords: LatLng | null; center: LatLng | null },
): LeagueSortKey {
  const fallback: LeagueSortKey = ctx.coords ? 'nearest' : ctx.center ? 'near_courts' : 'active';
  switch (requested) {
    case 'nearest': return fallback;
    case 'near_courts': return ctx.center ? 'near_courts' : 'active';
    case 'active':
    case 'newest':
    case 'name':
      return requested;
    default:
      return fallback;
  }
}

/** The sorts that can be offered right now (Nearest only with location,
 *  Near my courts only for members with a court). */
export function leagueSortOptions(ctx: { coords: LatLng | null; center: LatLng | null }): LeagueSortKey[] {
  const out: LeagueSortKey[] = [];
  if (ctx.coords) out.push('nearest');
  if (ctx.center) out.push('near_courts');
  out.push('active', 'newest', 'name');
  return out;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Discover order. Rows without coordinates sort after every row with them
 *  under the distance sorts. Never mutates `list`. */
export function sortLeagues<L extends PlayLeague>(
  list: readonly L[],
  sort: LeagueSortKey,
  ctx: { coords: LatLng | null; center: LatLng | null },
): L[] {
  const out = [...list];
  const activity = (a: L, b: L) =>
    (b.recentMatchCount ?? 0) - (a.recentMatchCount ?? 0) || b.memberCount - a.memberCount || byName(a, b);
  if (sort === 'nearest' || sort === 'near_courts') {
    const origin = sort === 'nearest' ? ctx.coords : ctx.center;
    if (!origin) return out.sort(activity);
    const dist = new Map<string, number>();
    for (const l of out) {
      const p = pointOf(l.home_court_lat, l.home_court_lng);
      dist.set(l.id, p ? milesBetween(origin, p) : Number.POSITIVE_INFINITY);
    }
    return out.sort((a, b) => {
      const da = dist.get(a.id)!;
      const db = dist.get(b.id)!;
      if (da !== db) return da < db ? -1 : 1;
      return activity(a, b);
    });
  }
  if (sort === 'newest') return out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || byName(a, b));
  if (sort === 'name') return out.sort(byName);
  return out.sort(activity);
}

/** Mine order: admin, co-admin, member, then pending requests; by name within. */
export function sortMineLeagues<L extends PlayLeague>(list: readonly L[]): L[] {
  const rank = (l: L) => (l.myRole === 'admin' ? 0 : l.myRole === 'co-admin' ? 1 : l.myRole === 'member' ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

function leagueChipMatches(l: PlayLeague, chip: string): boolean {
  switch (chip) {
    case 'open': return l.is_open !== false;
    case 'in_season': return l.activeSeasonCount > 0;
    case 'has_tournaments': return l.activeTournamentCount > 0;
    case 'saved': return !!l.saved;
    default: return true; // 'mine' and unknown chips don't narrow Discover rows
  }
}

function leagueSheetMatches(l: PlayLeague, sheet: SheetValues, coords: LatLng | null): boolean {
  if (sheet.private === 'hide' && l.is_open === false) return false;
  const minPlayers = positiveNumber(sheet.min_players);
  if (minPlayers != null && l.memberCount < minPlayers) return false;
  const radius = distanceMiles(sheet.distance);
  // A radius with no device location yet can't be measured: it filters
  // nothing rather than emptying the list.
  if (radius != null && coords) {
    const p = pointOf(l.home_court_lat, l.home_court_lng);
    if (!p || milesBetween(coords, p) > radius) return false;
  }
  return true;
}

export type LeagueQuery = {
  /** Raw search text (normalized here). */
  query: string;
  /** Effective chips (saved + route). */
  chips: readonly string[];
  /** Sheet values (merged over LEAGUE_SHEET_DEFAULTS by the caller or here). */
  sheet: SheetValues;
  /** Requested sort ('auto' = fallback chain). */
  sort: string;
  /** Device location, only after "Use my location" or an existing grant. */
  coords: LatLng | null;
  /** The court's display name (nickname), so search finds what the row shows. */
  courtLabel?: (raw: string | null) => string;
  /** Discover's search area limits this list (the Distance sheet value is ignored). */
  areaLimited?: boolean;
  /** The area in effect; null = none yet (nothing is limited). */
  area?: SearchArea | null;
};

/** The sheet and origin a list really uses: under a search area its centre
 *  is the origin and the sheet's own Distance is off. */
function areaContext<S extends SheetValues>(
  sheet: S,
  coords: LatLng | null,
  q: { areaLimited?: boolean; area?: SearchArea | null },
): { sheet: S; coords: LatLng | null; area: SearchArea | null } {
  if (!q.areaLimited) return { sheet, coords, area: null };
  const area = q.area ?? null;
  return { sheet: { ...sheet, distance: 'any' }, coords: area ? area.center : null, area };
}

export type LeagueSplit<L> = {
  /** Mine rows, search-narrowed only, in Mine order. */
  mine: L[];
  /** Discover rows after search + chips + sheet, sorted. Empty when `hideDiscover`. */
  discover: L[];
  /** Non-member leagues before search / chips / sheet (drives chip visibility). */
  discoverBase: number;
  /** The Mine chip is on: Discover is hidden. */
  hideDiscover: boolean;
  /** Per-chip count: Mine = Mine rows; others = Discover rows the chip would leave. */
  chipCounts: Record<LeagueChip, number>;
  /** A chip or a sheet value is on (sort and search don't count). */
  filtersOn: boolean;
  /** The sort in effect. */
  sort: LeagueSortKey;
  /** "Near my courts" origin. */
  center: LatLng | null;
};

/** The whole Leagues list decision in one call. */
export function splitLeagues<L extends PlayLeague>(leagues: readonly L[], q: LeagueQuery): LeagueSplit<L> {
  const query = normalizeQuery(q.query);
  const ac = areaContext({ ...LEAGUE_SHEET_DEFAULTS, ...q.sheet }, q.coords, q);
  const sheet = ac.sheet;
  q = { ...q, coords: ac.coords };
  const chips = q.chips.filter((c) => (LEAGUE_CHIPS as readonly string[]).includes(c));
  const searchHit = (l: L) => leagueMatchesSearch(l, query, q.courtLabel);
  const inArea = (l: L) => withinSearchArea(pointOf(l.home_court_lat, l.home_court_lng), ac.area);

  const mineAll = leagues.filter(isMineLeague);
  const others = leagues.filter((l) => !isMineLeague(l));
  const mine = sortMineLeagues(mineAll.filter(searchHit));

  // Discover before chips: search + sheet. Chip counts are measured from here.
  const base = others.filter((l) => inArea(l) && searchHit(l) && leagueSheetMatches(l, sheet, q.coords));
  const discoverChips = chips.filter((c) => c !== 'mine');
  const passes = (l: L, except?: string) => discoverChips.every((c) => c === except || leagueChipMatches(l, c));

  const center = myCourtsCenter(leagues);
  const sort = resolveLeagueSort(q.sort, { coords: q.coords, center });
  const hideDiscover = chips.includes('mine');
  const discover = hideDiscover ? [] : sortLeagues(base.filter((l) => passes(l)), sort, { coords: q.coords, center });

  const chipCounts = {} as Record<LeagueChip, number>;
  for (const chip of LEAGUE_CHIPS) {
    chipCounts[chip] = chip === 'mine'
      ? mine.length
      : base.filter((l) => passes(l, chip) && leagueChipMatches(l, chip)).length;
  }

  return {
    mine,
    discover,
    discoverBase: others.length,
    hideDiscover,
    chipCounts,
    filtersOn: chips.length > 0 || countSheetFilters(sheetInEffect(sheet, q.coords), LEAGUE_SHEET_DEFAULTS) > 0,
    sort,
    center,
  };
}

// ══ Tournaments ══════════════════════════════════════════════════════════════

export type TournamentChip = 'mine' | 'open_now' | 'this_week' | 'in_my_leagues' | 'singles' | 'doubles' | 'fits_schedule';
export const TOURNAMENT_CHIPS: readonly TournamentChip[] = [
  'mine', 'open_now', 'this_week', 'in_my_leagues', 'singles', 'doubles', 'fits_schedule',
];
export const TOURNAMENT_CHIP_LABELS: Record<TournamentChip, string> = {
  mine: 'Mine',
  open_now: 'Open now',
  this_week: 'This week',
  in_my_leagues: 'In my leagues',
  singles: 'Singles',
  doubles: 'Doubles',
  fits_schedule: 'Fits my schedule',
};
export const TOURNAMENT_PINNED_CHIPS: readonly TournamentChip[] = ['mine'];

/** Sheet: Format (multi), Spots left, Entry, Distance, Ended (+ cancelled). */
export const TOURNAMENT_SHEET_DEFAULTS: SheetValues = {
  format: [], spots: 'any', entry: 'any', distance: 'any', ended: 'hidden',
};

export type TournamentSortKey = 'soonest' | 'nearest' | 'newest';
export const TOURNAMENT_SORT_LABELS: Record<TournamentSortKey, string> = {
  soonest: 'Starting soon',
  nearest: 'Nearest',
  newest: 'Newest',
};
export const TOURNAMENT_PERSIST_DEFAULTS: PlayPersisted = { chips: [], sheet: TOURNAMENT_SHEET_DEFAULTS, sort: 'soonest' };

export type PlayTournament = {
  id: string;
  name: string;
  league_id: string | null;
  status: 'registration' | 'active' | 'completed' | 'cancelled' | string;
  format: string;
  match_type: 'singles' | 'doubles' | string;
  start_time: string | null;
  registration_closes_at?: string | null;
  expected_length_hours?: number | null;
  max_players?: number | null;
  pickle_ante?: number | null;
  location_name?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  created_at: string;
};

export type MyTournamentReg = { status: string; invited_by: string | null };

export type TournamentCtx = {
  /** The viewer's own registration per tournament id. */
  myRegs: Readonly<Record<string, MyTournamentReg | undefined>>;
  /** League ids the viewer is a member of. */
  myLeagueIds: ReadonlySet<string>;
  /** profiles.availability (336 cells) or []. */
  availability: readonly boolean[];
  /** Approved registrations per tournament (capacity is decided on these). */
  approvedCounts: Readonly<Record<string, number>>;
  /** League name per league id (search + subtitle). */
  leagueNames: Readonly<Record<string, string>>;
  coords: LatLng | null;
  now: number;
  /** Discover's search area limits this list (the Distance sheet value is ignored). */
  areaLimited?: boolean;
  /** The area in effect; null = none yet (nothing is limited). */
  area?: SearchArea | null;
  /** A league's home court, for a tournament with no location of its own. */
  leaguePoints?: Readonly<Record<string, LatLng | undefined>>;
};

/** Where a tournament is: its venue, else its league's home court. */
export function tournamentPoint(
  t: Pick<PlayTournament, 'location_lat' | 'location_lng' | 'league_id'>,
  leaguePoints?: Readonly<Record<string, LatLng | undefined>>,
): LatLng | null {
  return pointOf(t.location_lat, t.location_lng) ?? (t.league_id ? leaguePoints?.[t.league_id] ?? null : null);
}

const ENDED = new Set(['completed', 'cancelled']);

export function isEndedTournament(t: PlayTournament): boolean {
  return ENDED.has(t.status);
}

/** An outstanding invite: pending with an inviter. */
export function isInvite(reg: MyTournamentReg | undefined | null): boolean {
  return !!reg && reg.status === 'pending' && reg.invited_by != null;
}

/** Mine = a live (not ended) tournament I'm registered / invited / waitlisted /
 *  requested in. A rejection is not Mine; an ended tournament goes to ENDED. */
export function isMineTournament(t: PlayTournament, ctx: Pick<TournamentCtx, 'myRegs'>): boolean {
  const reg = ctx.myRegs[t.id];
  return !!reg && reg.status !== 'rejected' && !isEndedTournament(t);
}

export function tournamentMatchesSearch(t: PlayTournament, q: string, ctx: Pick<TournamentCtx, 'leagueNames'>): boolean {
  return matchesQuery([t.name, t.location_name, t.league_id ? ctx.leagueNames[t.league_id] : null], q);
}

/** Registration is open right now: status 'registration' and the deadline
 *  (if any) not passed. */
export function registrationOpen(t: PlayTournament, now: number): boolean {
  if (t.status !== 'registration') return false;
  if (!t.registration_closes_at) return true;
  return now < new Date(t.registration_closes_at).getTime();
}

/** The whole tournament is inside my weekly availability (30-minute cells). */
export function fitsSchedule(t: PlayTournament, availability: readonly boolean[]): boolean {
  if (!t.start_time || availability.length === 0 || !availability.some(Boolean)) return false;
  const hours = t.expected_length_hours != null && t.expected_length_hours > 0 ? t.expected_length_hours : 0.5;
  return isAvailableAt([...availability], new Date(t.start_time), Math.max(1, Math.ceil(hours * 2)));
}

function tournamentChipMatches(t: PlayTournament, chip: string, ctx: TournamentCtx): boolean {
  switch (chip) {
    case 'open_now': return registrationOpen(t, ctx.now);
    case 'this_week': {
      if (!t.start_time) return false;
      const s = new Date(t.start_time).getTime();
      return s >= ctx.now - 12 * 3600_000 && s <= ctx.now + 7 * 86400_000;
    }
    case 'in_my_leagues': return t.league_id != null && ctx.myLeagueIds.has(t.league_id);
    case 'singles': return t.match_type === 'singles';
    case 'doubles': return t.match_type === 'doubles';
    case 'fits_schedule': return fitsSchedule(t, ctx.availability);
    default: return true;
  }
}

function tournamentSheetMatches(t: PlayTournament, sheet: SheetValues, ctx: TournamentCtx): boolean {
  const formats = Array.isArray(sheet.format) ? sheet.format : sheet.format ? [sheet.format] : [];
  if (formats.length > 0 && !formats.includes(t.format)) return false;
  if (sheet.spots === 'open' && t.max_players != null && (ctx.approvedCounts[t.id] ?? 0) >= t.max_players) return false;
  if (sheet.entry === 'free' && (t.pickle_ante ?? 0) > 0) return false;
  if (sheet.entry === 'ante' && !((t.pickle_ante ?? 0) > 0)) return false;
  const radius = distanceMiles(sheet.distance);
  if (radius != null && ctx.coords) {
    const p = tournamentPoint(t, ctx.leaguePoints);
    if (!p || milesBetween(ctx.coords, p) > radius) return false;
  }
  return true;
}

export function resolveTournamentSort(requested: string | null | undefined, coords: LatLng | null): TournamentSortKey {
  if (requested === 'nearest') return coords ? 'nearest' : 'soonest';
  if (requested === 'newest') return 'newest';
  return 'soonest';
}

export function tournamentSortOptions(coords: LatLng | null): TournamentSortKey[] {
  return coords ? ['soonest', 'nearest', 'newest'] : ['soonest', 'newest'];
}

const startMs = (t: PlayTournament) => (t.start_time ? new Date(t.start_time).getTime() : Number.POSITIVE_INFINITY);

/** Starting soon = start_time ascending (no start time last, newest first among
 *  those). Never mutates `list`. */
export function sortTournaments<T extends PlayTournament>(
  list: readonly T[],
  sort: TournamentSortKey,
  coords: LatLng | null,
  leaguePoints?: Readonly<Record<string, LatLng | undefined>>,
): T[] {
  const out = [...list];
  const newest = (a: T, b: T) => (b.created_at ?? '').localeCompare(a.created_at ?? '');
  const soonest = (a: T, b: T) => {
    const sa = startMs(a);
    const sb = startMs(b);
    return sa !== sb ? (sa < sb ? -1 : 1) : newest(a, b);
  };
  if (sort === 'newest') return out.sort(newest);
  if (sort === 'nearest' && coords) {
    const d = (t: T) => {
      const p = tournamentPoint(t, leaguePoints);
      return p ? milesBetween(coords, p) : Number.POSITIVE_INFINITY;
    };
    return out.sort((a, b) => d(a) - d(b) || soonest(a, b));
  }
  return out.sort(soonest);
}

/** Mine order: invites first, then by start (soonest first). */
export function sortMineTournaments<T extends PlayTournament>(list: readonly T[], ctx: Pick<TournamentCtx, 'myRegs'>): T[] {
  return sortTournaments(list, 'soonest', null).sort(
    (a, b) => Number(isInvite(ctx.myRegs[b.id])) - Number(isInvite(ctx.myRegs[a.id])),
  );
}

export type TournamentQuery = {
  query: string;
  chips: readonly string[];
  sheet: SheetValues;
  sort: string;
};

export type TournamentSplit<T> = {
  /** Live tournaments I'm in (invites first), search-narrowed only. */
  mine: T[];
  /** Discover: registration status, not mine. */
  open: T[];
  /** Discover: active, not mine. */
  inProgress: T[];
  /** Completed + cancelled (mine included), most recent first. */
  ended: T[];
  /** Live non-mine tournaments before search / chips / sheet. */
  discoverBase: number;
  hideDiscover: boolean;
  chipCounts: Record<TournamentChip, number>;
  filtersOn: boolean;
  sort: TournamentSortKey;
};

/** The whole Tournaments list decision. Search covers EVERY status (ended and
 *  cancelled included); the ENDED section is collapsed by the screen, not
 *  filtered out here. */
export function splitTournaments<T extends PlayTournament>(
  tournaments: readonly T[],
  q: TournamentQuery,
  ctx: TournamentCtx,
): TournamentSplit<T> {
  const query = normalizeQuery(q.query);
  const ac = areaContext({ ...TOURNAMENT_SHEET_DEFAULTS, ...q.sheet }, ctx.coords, ctx);
  const sheet = ac.sheet;
  ctx = { ...ctx, coords: ac.coords };
  const chips = q.chips.filter((c) => (TOURNAMENT_CHIPS as readonly string[]).includes(c));
  // My own registrations (ended ones too) are never limited by the area.
  const inArea = (t: T) => {
    if (!ac.area) return true;
    const reg = ctx.myRegs[t.id];
    if (reg && reg.status !== 'rejected') return true;
    return withinSearchArea(tournamentPoint(t, ctx.leaguePoints), ac.area);
  };
  const searchHit = (t: T) => tournamentMatchesSearch(t, query, ctx) && inArea(t);
  const discoverChips = chips.filter((c) => c !== 'mine');
  const passes = (t: T, except?: string) => discoverChips.every((c) => c === except || tournamentChipMatches(t, c, ctx));

  const mine = sortMineTournaments(tournaments.filter((t) => isMineTournament(t, ctx) && searchHit(t)), ctx);
  const live = tournaments.filter((t) => !isEndedTournament(t) && !isMineTournament(t, ctx));
  const base = live.filter((t) => searchHit(t) && tournamentSheetMatches(t, sheet, ctx));
  const hideDiscover = chips.includes('mine');
  const sort = resolveTournamentSort(q.sort, ctx.coords);
  const shown = hideDiscover ? [] : sortTournaments(base.filter((t) => passes(t)), sort, ctx.coords, ctx.leaguePoints);

  const ended = hideDiscover
    ? []
    : tournaments
        .filter((t) => isEndedTournament(t) && searchHit(t) && tournamentSheetMatches(t, sheet, ctx) && passes(t))
        .sort((a, b) => {
          const sa = a.start_time ? new Date(a.start_time).getTime() : 0;
          const sb = b.start_time ? new Date(b.start_time).getTime() : 0;
          return sb - sa || (b.created_at ?? '').localeCompare(a.created_at ?? '');
        });

  const chipCounts = {} as Record<TournamentChip, number>;
  for (const chip of TOURNAMENT_CHIPS) {
    chipCounts[chip] = chip === 'mine'
      ? mine.length
      : base.filter((t) => passes(t, chip) && tournamentChipMatches(t, chip, ctx)).length;
  }

  // "Show ended" is a display choice (the section opens), not a narrowing filter.
  // A radius without coords filters nothing, so it doesn't count either.
  const sheetFilters = countSheetFilters({ ...sheetInEffect(sheet, ctx.coords), ended: 'hidden' }, TOURNAMENT_SHEET_DEFAULTS);
  return {
    mine,
    open: shown.filter((t) => t.status === 'registration'),
    inProgress: shown.filter((t) => t.status !== 'registration'),
    ended,
    discoverBase: live.length,
    hideDiscover,
    chipCounts,
    filtersOn: chips.length > 0 || sheetFilters > 0,
    sort,
  };
}
