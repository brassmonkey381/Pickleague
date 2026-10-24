// Invite suggestions (the user, 2026-10-24: "Suggest nearby, search all"):
// the pure half (data/inviteSuggestions has the reads).
//
//   suggestions  the players who play near the league's home court, or near
//                the tournament's venue (else its league's court), by the same
//                rule as Discover: their leagues' home courts only
//                (discover_players_near, lib/playersNear). No place, or no one
//                there: the players near the shared search area. Neither: the
//                old suggestions (similar PLUPR, anywhere).
//   search       typing a name searches everyone (discover_players, every page
//                past its 500-row cap), not just the suggestions.
//
// Used by the league roster's Suggest (screens/LeagueMembersScreen), a
// tournament's Invite players (screens/TournamentInvitePlayersScreen) and the
// invite picker (components/MultiUserPickerModal).
//
// PURE: no React, no Supabase.
import { circleAround, pointOf, searchAreaKey, type LatLng, type NearCircle } from './searchArea';

/** Where an invite is for: a league's home court, a tournament's venue. */
export type InvitePlace = { name: string | null; point: LatLng };

/** Which step the suggestions came from. */
export type SuggestionSource = 'place' | 'area' | 'anywhere';

export type SuggestionStep = {
  source: 'place' | 'area';
  circle: NearCircle;
  /** "Lakeside Park", "Alameda, CA"; null when there is no name to show. */
  label: string | null;
};

/** A place from a row's name and coordinates; null without a usable point (none, NaN, 0/0). */
export function invitePlaceOf(
  name: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): InvitePlace | null {
  const point = pointOf(lat, lng);
  if (!point) return null;
  const n = typeof name === 'string' ? name.trim() : '';
  return { name: n || null, point };
}

/**
 * Where to look, in order: around the place (at the shared area's radius),
 * then the shared area itself. The area is skipped when it is the same circle
 * as the place's (nothing new to find there).
 */
export function suggestionSteps(
  place: InvitePlace | null,
  area: (NearCircle & { label?: string | null }) | null,
  radiusMi: number,
): SuggestionStep[] {
  const steps: SuggestionStep[] = [];
  if (place) steps.push({ source: 'place', circle: circleAround(place.point, radiusMi), label: place.name });
  if (area && !(place && searchAreaKey(area) === searchAreaKey(steps[0].circle))) {
    steps.push({
      source: 'area',
      circle: { center: area.center, radiusMi: area.radiusMi, radiusM: area.radiusM },
      label: area.label ?? null,
    });
  }
  return steps;
}

/**
 * Runs the steps in order and keeps the first that leaves anyone (after
 * `keep`, e.g. the level band); null when none does, and the caller falls
 * back to the old suggestions. A failing step throws: an empty list must
 * never stand for a read that failed.
 */
export async function firstWithAnyone<S, T>(
  steps: readonly S[],
  run: (step: S) => Promise<T[]>,
  keep: (rows: T[]) => T[] = (rows) => rows,
): Promise<{ step: S; rows: T[] } | null> {
  for (const step of steps) {
    const rows = keep(await run(step));
    if (rows.length > 0) return { step, rows };
  }
  return null;
}

/** The rows within ±band of the level (a row with no rating is left out), in their order. */
export function withinLevel<P extends { rating: number | null | undefined }>(
  rows: readonly P[],
  level: number,
  band: number,
): P[] {
  return rows.filter((p) => typeof p.rating === 'number' && Number.isFinite(p.rating) && Math.abs(p.rating - level) <= band);
}

/** "Players near Lakeside Park · 5 mi", "Players near your search area · 10 mi"; null for the old suggestions. */
export function suggestionsHeading(source: SuggestionSource, label: string | null, radiusMi: number): string | null {
  if (source === 'anywhere') return null;
  const where = label?.trim() || (source === 'place' ? 'the court' : 'your search area');
  return `Players near ${where} · ${radiusMi} mi`;
}

/**
 * The invite picker's rows: the suggestions first (in their order: nearest
 * first), then everyone else by name; each player once. Searching filters
 * this whole list, so typing still finds anyone.
 */
export function suggestedFirst<P extends { id: string; full_name?: string | null }>(
  suggested: readonly P[],
  everyone: readonly P[],
): P[] {
  const seen = new Set<string>();
  const out: P[] = [];
  for (const p of suggested) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  const rest = everyone
    .filter((p) => !seen.has(p.id))
    .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '') || a.id.localeCompare(b.id));
  for (const p of rest) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Everyone, past the row cap of one discover_players call: each page leaves
 * out every id already read (p_exclude), until a short page or `maxPages`.
 */
export async function readAllPages<P extends { id: string }>(
  fetchPage: (exclude: readonly string[]) => Promise<P[]>,
  pageSize = 500,
  maxPages = 6,
): Promise<P[]> {
  const out: P[] = [];
  const ids = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchPage([...ids]);
    let added = 0;
    for (const r of rows) {
      if (ids.has(r.id)) continue;
      ids.add(r.id);
      out.push(r);
      added++;
    }
    // A short page is the last; a page with nothing new would repeat forever.
    if (rows.length < pageSize || added === 0) break;
  }
  return out;
}
