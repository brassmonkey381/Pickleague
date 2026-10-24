// Court discovery reads (state/court-discovery-plan.md, Phase 1): wrappers
// over list_courts_nearby / get_court (supabase/migration_court_discovery_p1.sql)
// and the live numbers a list overlays on them.
//
// Catalog and live numbers are kept apart, so the catalog can be cached long:
//   - the nearby list: useRadiusQuery under 'courts:radius:…' (fresh 1 day,
//     kept 3 days), keyed by the snapped centre, radius and sports;
//   - one court: 'court:<id>' (fresh 1 day, kept 1 week);
//   - the crowd: one venue_crowd call per page through useIdBatchQuery, each
//     court stored under 'venue:crowd:<id>' (the key CrowdLine and every other
//     surface share), polled once a minute while the screen is focused;
//   - the star: useCourtFavoriteIds (data/courtFavorites).
// Sports come from the sport config: pickleball only (decision 2), but the
// RPC keeps p_sports text[] for a later multi-sport list.
import { useCallback } from 'react';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { DAY_MS, WEEK_MS, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { useIdBatchQuery, useRadiusQuery } from '@just-messin-around/expo-foundation/places';
import { supabase } from '../lib/supabase';
import { getSport } from '../sports/registry';
import {
  COURTS_PAGE,
  cityLabel,
  normalizeCourtDetail,
  normalizeCourtRows,
  type CourtDetail,
  type CourtRow,
  type LatLngLike,
} from '../lib/courtDiscovery';
import { getVenueCrowd, VENUE_CROWD_MAX_IDS, type VenueCrowd } from './venueCrowd';

const BOUND = { timeoutMs: 9_000 };

export const COURTS_NS = 'courts';
export const VENUE_CROWD_NS = 'venue:crowd';
const LIST_TTL_MS = DAY_MS;
const LIST_PERSIST_MS = 3 * DAY_MS;
const COURT_TTL_MS = DAY_MS;
const COURT_PERSIST_MS = WEEK_MS;
const CROWD_TTL_MS = 30_000;
const CROWD_POLL_MS = 60_000;

/** One court's page, shared by every surface that opens it. */
export function courtKey(venueId: string): string {
  return `court:${venueId}`;
}

/** The sports a court list asks for: the app's court sport only. */
export function courtSports(): string[] {
  return [getSport().courtSport];
}

/** One page of courts near a point, nearest first. `after`: the previous page's last row. */
export async function listCourtsNearby(
  center: LatLngLike,
  radiusM: number,
  opts: { after?: { afterM: number; afterId: string } | null; limit?: number } = {},
): Promise<CourtRow[]> {
  const raw = await sbCall(
    () =>
      supabase.rpc('list_courts_nearby', {
        p_lat: center.lat,
        p_lng: center.lng,
        p_radius_m: radiusM,
        p_sports: courtSports(),
        p_limit: opts.limit ?? COURTS_PAGE,
        p_after_m: opts.after?.afterM ?? null,
        p_after_id: opts.after?.afterId ?? null,
      }),
    BOUND,
  );
  return normalizeCourtRows(raw);
}

/** One court (an alias id opens its facility). Throws the server's refusal (pl:court.gone). */
export async function getCourt(venueId: string): Promise<CourtDetail> {
  const raw = await sbCall(() => supabase.rpc('get_court', { p_venue: venueId }), BOUND);
  const court = normalizeCourtDetail(raw);
  if (!court) throw new Error("Couldn't read that court. Try again.");
  return court;
}

/** The first page near `center` (null: nothing fetched until a centre is known). */
export function useCourtsNearby(center: LatLngLike | null, radiusM: number, enabled = true) {
  return useRadiusQuery<CourtRow[]>({
    ns: COURTS_NS,
    center,
    radiusM,
    extras: { sports: courtSports(), limit: COURTS_PAGE },
    fetch: ({ center: c, radiusM: r }) => listCourtsNearby(c, r),
    ttlMs: LIST_TTL_MS,
    persistMs: LIST_PERSIST_MS,
    enabled,
  });
}

export function useCourt(venueId: string, enabled = true) {
  const fetcher = useCallback(() => getCourt(venueId), [venueId]);
  return useCachedQuery<CourtDetail>(courtKey(venueId), fetcher, {
    ttlMs: COURT_TTL_MS,
    persistMs: COURT_PERSIST_MS,
    enabled: enabled && !!venueId,
  });
}

const ZERO_CROWD = (id: string): VenueCrowd => ({ venue_id: id, here_now: 0, band_low: null, band_high: null, friends_here: 0 });

/**
 * The crowd at every court on screen: one venue_crowd call per 50 ids, polled
 * once a minute while `active` (the screen is focused). A court nobody is at
 * comes back as zeros.
 */
export function useCourtCrowds(ids: readonly string[], active: boolean) {
  return useIdBatchQuery<VenueCrowd>({
    ns: VENUE_CROWD_NS,
    ids,
    fetch: (chunk) => getVenueCrowd(chunk),
    chunk: VENUE_CROWD_MAX_IDS,
    ttlMs: CROWD_TTL_MS,
    pollMs: CROWD_POLL_MS,
    missing: ZERO_CROWD,
    enabled: active,
  });
}

/** "Alameda, CA" for a point (nearest_us_city), cached by the snapped point. */
export async function nearestCityLabel(p: LatLngLike): Promise<string | null> {
  const raw = await sbCall(() => supabase.rpc('nearest_us_city', { p_lat: p.lat, p_lng: p.lng }), BOUND);
  return cityLabel(raw as { city?: unknown; state?: unknown } | null);
}

/** The nearest US city to a point, at the city's own centre (nearest_us_city). */
export async function nearestCity(p: LatLngLike): Promise<{ label: string; lat: number; lng: number } | null> {
  const raw = (await sbCall(() => supabase.rpc('nearest_us_city', { p_lat: p.lat, p_lng: p.lng }), BOUND)) as
    { city?: unknown; state?: unknown; lat?: unknown; lng?: unknown } | null;
  const label = cityLabel(raw);
  if (!label || !raw || typeof raw.lat !== 'number' || typeof raw.lng !== 'number') return null;
  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lng)) return null;
  return { label, lat: raw.lat, lng: raw.lng };
}

export function useNearestCityLabel(p: LatLngLike | null) {
  const lat = p ? p.lat.toFixed(2) : '';
  const lng = p ? p.lng.toFixed(2) : '';
  const fetcher = useCallback(() => nearestCityLabel({ lat: Number(lat), lng: Number(lng) }), [lat, lng]);
  return useCachedQuery<string | null>(`uscity:near:${lat},${lng}`, fetcher, {
    ttlMs: WEEK_MS,
    persistMs: WEEK_MS,
    enabled: !!p,
  });
}

export type CitySuggestion = { label: string; lat: number; lng: number };

/** "Search a city": US cities whose name starts with the query (us_cities). */
export async function searchUsCities(query: string, limit = 8): Promise<CitySuggestion[]> {
  const q = query.trim().replace(/[%_,]/g, ' ').replace(/\s+/g, ' ');
  if (q.length < 2) return [];
  const rows = (await sbCall(
    () => supabase.from('us_cities').select('city, state_code, lat, lng').ilike('city', `${q}%`).order('city').limit(limit),
    BOUND,
  )) as { city: string; state_code: string; lat: number; lng: number }[] | null;
  return (rows ?? []).flatMap((r) => {
    const label = cityLabel(r);
    return label && Number.isFinite(r.lat) && Number.isFinite(r.lng) ? [{ label, lat: r.lat, lng: r.lng }] : [];
  });
}
