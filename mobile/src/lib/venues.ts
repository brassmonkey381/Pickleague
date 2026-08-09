// Search our own venue catalog (public.venues, scraped from OpenStreetMap — see
// docs/location-pipeline.md) for the court picker. Backs VenuePicker's `localSearch`
// so our known courts surface ABOVE the external provider (Google/Nominatim) — a
// dual-run: our data first, external fills any gaps. Flip the picker to
// externalSearch="none" once coverage is trusted (P6 in the pipeline doc).

import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import type { VenueResult } from '@just-messin-around/expo-foundation/ui';

// Sports the picker searches. Pickleball is very often played on tennis courts,
// and OSM under-tags pickleball ~5:1 vs tennis, so we search BOTH for real
// coverage. When the multi-sport `sport` dimension lands (see
// docs/basketball-vertical.md), pass the league/tournament's sport(s) instead.
export const PICKLEBALL_VENUE_SPORTS = ['pickleball', 'tennis'];

type Coords = { lat: number; lng: number } | null;

// A row from the search_venues RPC (returns a jsonb array).
type SearchVenueRow = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  lat: number;
  lng: number;
  kind: string | null;
  sport: string[] | null;
  confirmation_status: string | null;
  distance_meters: number | null;
};

/**
 * Search the venue catalog, ranked by name match + proximity.
 *
 * THROWS when the search fails. VenuePicker distinguishes "no matches" from
 * "couldn't search" and offers a retry, but only if this rejects — returning
 * `[]` on error (the old behavior) told users on weak WiFi that their home
 * court isn't in the app, with no way to tell otherwise.
 */
export async function searchVenues(
  query: string,
  coords: Coords,
  sports: string[] = PICKLEBALL_VENUE_SPORTS,
  limit = 8,
): Promise<VenueResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const data = await sbCall(() =>
    supabase.rpc('search_venues', {
      p_query: q,
      p_lat: coords?.lat ?? null,
      p_lng: coords?.lng ?? null,
      p_sports: sports.length ? sports : null,
      p_limit: limit,
    }),
  );
  if (!data) return [];
  return (data as SearchVenueRow[]).map((r) => ({
    name: r.name,
    address: r.address || r.city || '',
    lat: r.lat,
    lng: r.lng,
    placeId: r.id,
    catalogId: r.id, // our own catalog — the picker skips the external resolve step
    unconfirmed: r.confirmation_status === 'unconfirmed',
    localBadge: r.sport?.length ? r.sport.join(' / ') : r.kind ?? undefined,
  }));
}

/** Ready-made `localSearch` for CourtPicker (pickleball + tennis venues). */
export const venueLocalSearch = (query: string, coords: Coords): Promise<VenueResult[]> =>
  searchVenues(query, coords);
