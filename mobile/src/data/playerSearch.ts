// Player search by name, the read (lib/playerSearch has the rules).
//
//   search_players (supabase/migration_search_players.sql): everyone whose
//   name or @username contains the query, the players near the area first
//   (placed by their leagues' home courts only), blocks both ways, test
//   accounts while God mode hides them.
//   Until that file is applied on a server: the name search covers the nearby
//   list only (discover_players_near with the query; discover_players with no
//   area), as before. Never discover_players for a name search with an area:
//   it applies no blocks, and who blocked me is not readable here.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { NearCircle } from '../lib/searchArea';
import { isMissingRpcError, type NearPlayer } from '../lib/playersNear';
import { listPlayersNear } from './playersNear';

export type PlayerSearchOptions = {
  /** Leave out unclaimed DUPR placeholders and guest passes. */
  realPeopleOnly?: boolean;
  exclude?: readonly string[];
  limit?: number;
};

/** Remembered for this run once the server says it has no search_players. */
let rpcMissing = false;

/** Players matching `query` (trimmed, 2+ letters: lib/playerSearch's searchableQuery). */
export async function searchPlayers(
  query: string,
  area: NearCircle | null,
  opts: PlayerSearchOptions = {},
): Promise<NearPlayer[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 60, 200));
  if (!rpcMissing) {
    try {
      const rows = await sbCall(() =>
        supabase.rpc('search_players', {
          p_query: query,
          p_lat: area ? area.center.lat : null,
          p_lng: area ? area.center.lng : null,
          p_radius_m: area ? area.radiusM : 8047,
          p_real_people_only: !!opts.realPeopleOnly,
          p_exclude: opts.exclude?.length ? [...opts.exclude] : null,
          p_limit: limit,
        }),
      );
      return (rows ?? []) as NearPlayer[];
    } catch (e) {
      if (!isMissingRpcError(e)) throw e;
      rpcMissing = true;
    }
  }
  return listPlayersNear(area, { query, realPeopleOnly: opts.realPeopleOnly, exclude: opts.exclude, limit });
}
