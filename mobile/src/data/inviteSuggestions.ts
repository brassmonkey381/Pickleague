// Invite suggestions, the reads (lib/inviteSuggestions has the rules).
//
//   getInvitePlace   a league's home court; a tournament's venue, else its
//                    league's home court
//   nearForInvite    the real people who play inside a circle (league courts
//                    only: data/playersNear -> discover_players_near)
//   listEveryone     everyone discover_players lists, every page past its cap
//                    (what "search all" searches)
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { NearCircle } from '../lib/searchArea';
import type { NearPlayer } from '../lib/playersNear';
import { invitePlaceOf, readAllPages, type InvitePlace } from '../lib/inviteSuggestions';
import { listPlayersNear } from './playersNear';

export type InviteScope = { type: 'league' | 'tournament'; id: string };

async function leaguePlace(leagueId: string): Promise<InvitePlace | null> {
  const row = await sbCall(() =>
    supabase.from('leagues').select('home_court, home_court_lat, home_court_lng').eq('id', leagueId).maybeSingle(),
  );
  return row ? invitePlaceOf(row.home_court, row.home_court_lat, row.home_court_lng) : null;
}

/** Where the invite is for; null when it has no located place (then the search area is used). */
export async function getInvitePlace(scope: InviteScope): Promise<InvitePlace | null> {
  if (scope.type === 'league') return leaguePlace(scope.id);
  const t = await sbCall(() =>
    supabase
      .from('tournaments')
      .select('location_name, location_lat, location_lng, league_id')
      .eq('id', scope.id)
      .maybeSingle(),
  );
  if (!t) return null;
  // A tournament with no venue sits at its league's court (lib/playFilters' tournamentPoint).
  return invitePlaceOf(t.location_name, t.location_lat, t.location_lng)
    ?? (t.league_id ? leaguePlace(t.league_id) : null);
}

/** The real people (no unclaimed DUPR placeholders or guest passes) who play inside the circle, nearest first. */
export function nearForInvite(circle: NearCircle, exclude: readonly string[] = [], limit = 200): Promise<NearPlayer[]> {
  return listPlayersNear(circle, { realPeopleOnly: true, exclude, limit });
}

/**
 * Everyone discover_players lists (no deleted accounts; no test accounts while
 * God mode hides them), past its 500-row cap: one page per 500.
 */
export function listEveryone<P extends { id: string }>(
  columns: string,
  opts: { exclude?: readonly string[] } = {},
): Promise<P[]> {
  const base = opts.exclude ?? [];
  return readAllPages<P>(async (seen) => {
    const exclude = [...base, ...seen];
    const rows = await sbCall(() =>
      supabase
        .rpc('discover_players', { p_exclude: exclude.length ? exclude : null, p_limit: 500 })
        .select(columns),
    );
    return (rows ?? []) as unknown as P[];
  });
}
