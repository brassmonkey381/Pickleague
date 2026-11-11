// Courts for the first run's "Your courts": suggested_courts (suggested-courts-v1,
// docs/recommendations/suggested-courts.md) ranks by players, check-ins,
// leagues, sessions and distance. Until that RPC is applied the step falls back
// to the nearest courts (list_courts_nearby), so the app never waits on it.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { normalizeSuggestedCourts, type SuggestedCourt } from '../lib/firstRun';
import { isMissingRpcError } from '../lib/playersNear';
import { listCourtsNearby } from './courtDiscovery';

const BOUND = { timeoutMs: 9_000 };
const FALLBACK_RADIUS_M = 15_000;

export type SuggestedCourtsResult = {
  courts: SuggestedCourt[];
  /** The server had a point (the phone's, or the home location). */
  located: boolean;
  /** 'ranked' = suggested_courts; 'nearest' = the fallback. */
  source: 'ranked' | 'nearest';
};

export async function fetchSuggestedCourts(
  point: { lat: number; lng: number } | null,
  limit = 6,
): Promise<SuggestedCourtsResult> {
  try {
    const raw = await sbCall(
      () =>
        supabase.rpc('suggested_courts', {
          p_lat: point?.lat ?? null,
          p_lng: point?.lng ?? null,
          p_limit: limit,
        }),
      BOUND,
    );
    const located = (raw as { located?: unknown } | null)?.located === true;
    return { courts: normalizeSuggestedCourts(raw), located, source: 'ranked' };
  } catch (e) {
    if (!isMissingRpcError(e)) throw e;
  }
  if (!point) return { courts: [], located: false, source: 'nearest' };
  const rows = await listCourtsNearby(point, FALLBACK_RADIUS_M, { limit });
  return {
    located: true,
    source: 'nearest',
    courts: rows.map((r, i) => ({
      venue_id: r.id,
      name: r.name,
      city: r.city,
      distance_m: r.distance_m,
      court_count: r.court_count,
      players_30d: 0,
      checkins_30d: 0,
      leagues: r.league_count ?? 0,
      sessions: 0,
      matches_30d: 0,
      favorites: 0,
      recommended: i < 3,
    })),
  };
}
