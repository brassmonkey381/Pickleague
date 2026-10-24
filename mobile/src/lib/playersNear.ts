// Players near the search area: the pure half (data/playersNear has the reads).
//
// The server answers this with discover_players_near
// (supabase/migration_discover_players_near.sql): where a player PLAYS (their
// leagues' home courts, and, when their presence privacy names them to you,
// their starred and frequent courts), never where they are. Until that file
// is applied on a server, the app places players by what it can read itself:
// the home courts of the leagues they are in. That fallback is narrower (no
// starred or frequent courts) but never wider, and it reads no location.
//
// PURE: no React, no Supabase.
import {
  METERS_PER_MILE,
  milesBetween,
  pointOf,
  withinSearchArea,
  type SearchArea,
} from './searchArea';

export type PlaceKind = 'league' | 'starred' | 'frequent';

/** A player in a people list (the columns discover_players_near returns). */
export type NearPlayer = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  avatar_id: number | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  rating: number | null;
  doubles_rating: number | null;
  total_matches_played: number | null;
  drilling_enabled: boolean | null;
  drill_availability: unknown;
  drill_shot_prefs: string[] | null;
  drill_partner_prefs: string[] | null;
  drill_custom_tags: string[] | null;
  /** Where they play nearest the centre; null when the search was not limited. */
  place_name: string | null;
  place_kind: PlaceKind | null;
  distance_m: number | null;
};

/** The columns every people list reads (the RPC's, and discover_players'). */
export const NEAR_PLAYER_COLUMNS =
  'id, username, full_name, avatar_url, avatar_id, avatar_emoji, avatar_bg_color, rating, doubles_rating, '
  + 'total_matches_played, drilling_enabled, drill_availability, drill_shot_prefs, drill_partner_prefs, drill_custom_tags';

export type AnchorLeague = {
  id: string;
  home_court: string | null;
  home_court_lat: number | null;
  home_court_lng: number | null;
  is_open?: boolean | null;
};

export type AnchorMember = { league_id: string; user_id: string; expires_at?: string | null };

export type PlayerAnchor = { place: string | null; distanceM: number };

/**
 * The fallback's "where they play": for each player, the nearest home court
 * of a league they are in that lies inside the area. Open leagues only, or a
 * closed league I am in too (a closed league's roster is not public); a guest
 * pass that has run out doesn't count. Same rules as the server's league part.
 */
export function leagueAnchorsInArea(
  leagues: readonly AnchorLeague[],
  members: readonly AnchorMember[],
  area: SearchArea,
  ctx: { meId: string | null; now: number },
): Map<string, PlayerAnchor> {
  const live = (m: AnchorMember) => !m.expires_at || new Date(m.expires_at).getTime() > ctx.now;
  const mine = new Set(members.filter((m) => m.user_id === ctx.meId && live(m)).map((m) => m.league_id));
  const inArea = new Map<string, { place: string | null; distanceM: number }>();
  for (const l of leagues) {
    const p = pointOf(l.home_court_lat, l.home_court_lng);
    if (!p || !withinSearchArea(p, area)) continue;
    if (l.is_open === false && !mine.has(l.id)) continue;
    inArea.set(l.id, { place: l.home_court, distanceM: milesBetween(area.center, p) * METERS_PER_MILE });
  }
  const out = new Map<string, PlayerAnchor>();
  for (const m of members) {
    if (m.user_id === ctx.meId || !live(m)) continue;
    const a = inArea.get(m.league_id);
    if (!a) continue;
    const prev = out.get(m.user_id);
    if (!prev || a.distanceM < prev.distanceM) out.set(m.user_id, a);
  }
  return out;
}

/** The fallback's rows: the players with an anchor, nearest first, then by name. */
export function placePlayers<P extends { id: string; full_name: string | null }>(
  players: readonly P[],
  anchors: ReadonlyMap<string, PlayerAnchor>,
): (P & { place_name: string | null; place_kind: PlaceKind | null; distance_m: number | null })[] {
  return players
    .flatMap((p) => {
      const a = anchors.get(p.id);
      return a ? [{ ...p, place_name: a.place, place_kind: 'league' as PlaceKind, distance_m: a.distanceM }] : [];
    })
    .sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0) || (a.full_name ?? '').localeCompare(b.full_name ?? ''));
}

/** A player's name or @username contains the query (a leading @ is ignored). */
export function playerMatchesQuery(p: { full_name: string | null; username: string | null }, query: string): boolean {
  const q = query.trim().replace(/^@/, '').toLowerCase();
  if (!q) return true;
  return (p.full_name ?? '').toLowerCase().includes(q) || (p.username ?? '').toLowerCase().includes(q);
}

/** "Plays at Lakeside Park · 1.2 mi", "Plays nearby · 3 mi". */
export function playsAtLabel(p: Pick<NearPlayer, 'place_name' | 'distance_m'>): string | null {
  if (p.distance_m == null) return null;
  const miles = p.distance_m / METERS_PER_MILE;
  const d = miles < 0.95 ? `${Math.max(0.1, Math.round(miles * 10) / 10)} mi` : `${Math.round(miles)} mi`;
  const where = p.place_name?.trim();
  return where ? `Plays at ${where} · ${d}` : `Plays nearby · ${d}`;
}

/** Whether an error says the RPC isn't on this server yet (the SQL isn't applied). */
export function isMissingRpcError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { code?: unknown; message?: unknown };
  if (o.code === 'PGRST202' || o.code === '42883') return true;
  return typeof o.message === 'string' && /Could not find the function|PGRST202|function .* does not exist/i.test(o.message);
}
