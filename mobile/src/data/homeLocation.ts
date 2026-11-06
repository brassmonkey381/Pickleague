// Home location (supabase/migration_home_location.sql): where I call home,
// for the events near me. The exact point is private (only I read it back);
// my neighborhood ("Alameda, CA") is the only part anyone else could see.
//
//   set_my_home_location(p_lat, p_lng, p_address)  -> {neighborhood, lat, lng, address}
//   get_my_home_location()                         -> that, or null
//   clear_my_home_location()                       -> whether there was one
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { invalidateQueries, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { supabase } from '../lib/supabase';

const BOUND = { timeoutMs: 9_000 };
const KEY = 'me:homeLocation';

export type HomeLocation = { neighborhood: string | null; lat: number; lng: number; address: string | null };

function fromRpc(raw: unknown): HomeLocation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.lat !== 'number' || typeof r.lng !== 'number') return null;
  return {
    neighborhood: typeof r.neighborhood === 'string' && r.neighborhood ? r.neighborhood : null,
    lat: r.lat,
    lng: r.lng,
    address: typeof r.address === 'string' && r.address ? r.address : null,
  };
}

export async function getMyHomeLocation(): Promise<HomeLocation | null> {
  return fromRpc(await sbCall(() => supabase.rpc('get_my_home_location'), BOUND));
}

export function useMyHomeLocation(enabled = true) {
  return useCachedQuery<HomeLocation | null>(KEY, getMyHomeLocation, { ttlMs: 10 * 60_000, enabled });
}

/** Saved: the events near me change with it. */
function afterChange(): void {
  invalidateQueries(KEY);
  invalidateQueries('outsideEvents');
}

export async function setMyHomeLocation(p: { lat: number; lng: number; address?: string | null }): Promise<HomeLocation | null> {
  const r = fromRpc(
    await sbCall(
      () => supabase.rpc('set_my_home_location', { p_lat: p.lat, p_lng: p.lng, p_address: p.address ?? null }),
      BOUND,
    ),
  );
  afterChange();
  return r;
}

export async function clearMyHomeLocation(): Promise<void> {
  await sbCall(() => supabase.rpc('clear_my_home_location'), BOUND);
  afterChange();
}
