// Players near the search area (lib/playersNear has the rules).
//
//   area set   discover_players_near (the server: leagues, starred and
//              frequent courts, presence privacy, blocks, test accounts);
//              before that SQL is applied, the fallback: discover_players
//              placed by their leagues' home courts (lib/playersNear)
//   no area    discover_players, unlimited (nothing to limit by yet)
import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { SearchArea } from '../lib/searchArea';
import {
  NEAR_PLAYER_COLUMNS,
  isMissingRpcError,
  leagueAnchorsInArea,
  placePlayers,
  playerMatchesQuery,
  type AnchorLeague,
  type AnchorMember,
  type NearPlayer,
} from '../lib/playersNear';

export type PlayersNearOptions = {
  /** Name or @username. */
  query?: string;
  drillingOnly?: boolean;
  /** Leave out unclaimed DUPR placeholders and guest passes. */
  realPeopleOnly?: boolean;
  exclude?: readonly string[];
  limit?: number;
};

const DEFAULT_LIMIT = 200;

/** Remembered for this run once the server says it has no discover_players_near. */
let rpcMissing = false;

function withNoPlace(rows: unknown[]): NearPlayer[] {
  return (rows as NearPlayer[]).map((r) => ({ ...r, place_name: null, place_kind: null, distance_m: null }));
}

async function discoverPlayers(opts: PlayersNearOptions, limit: number): Promise<NearPlayer[]> {
  const rows = await sbCall(() =>
    supabase
      .rpc('discover_players', {
        p_drilling_only: !!opts.drillingOnly,
        p_real_people_only: !!opts.realPeopleOnly,
        p_exclude: opts.exclude?.length ? [...opts.exclude] : null,
        p_limit: limit,
      })
      .select(NEAR_PLAYER_COLUMNS),
  );
  const list = withNoPlace((rows ?? []) as unknown[]);
  return opts.query ? list.filter((p) => playerMatchesQuery(p, opts.query!)) : list;
}

/** Before the SQL is applied: players placed by their leagues' home courts. */
async function fallbackNear(area: SearchArea, opts: PlayersNearOptions, limit: number): Promise<NearPlayer[]> {
  const meId = await currentUserId(supabase);
  const leagues = ((await sbCall(() =>
    supabase
      .from('leagues')
      .select('id, home_court, home_court_lat, home_court_lng, is_open')
      .eq('is_active', true)
      .not('home_court_lat', 'is', null),
  )) ?? []) as AnchorLeague[];
  const ids = leagues.map((l) => l.id);
  if (ids.length === 0) return [];
  const members = ((await sbCall(() =>
    supabase.from('league_members').select('league_id, user_id, expires_at').in('league_id', ids),
  )) ?? []) as AnchorMember[];
  const anchors = leagueAnchorsInArea(leagues, members, area, { meId, now: Date.now() });
  if (anchors.size === 0) return [];
  // discover_players applies deletions, test accounts and the filters; 500 is its cap.
  const everyone = await discoverPlayers(opts, 500);
  return placePlayers(everyone, anchors).slice(0, limit);
}

export async function listPlayersNear(area: SearchArea | null, opts: PlayersNearOptions = {}): Promise<NearPlayer[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 500));
  if (!area) return discoverPlayers(opts, Math.max(limit, 500));
  if (!rpcMissing) {
    try {
      const rows = await sbCall(() =>
        supabase
          .rpc('discover_players_near', {
            p_lat: area.center.lat,
            p_lng: area.center.lng,
            p_radius_m: area.radiusM,
            p_query: opts.query?.trim() ? opts.query.trim() : null,
            p_drilling_only: !!opts.drillingOnly,
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
  return fallbackNear(area, opts, limit);
}
