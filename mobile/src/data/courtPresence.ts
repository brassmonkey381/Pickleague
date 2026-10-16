// Who is at a court, and which friends are at which courts: wrappers over
// court_presence and friends_at_courts (docs/play-sessions-presence-api.md,
// "Presence reads"). Both are SECURITY DEFINER reads that apply each player's
// own privacy level, blocks, pauses and hide-from on the server, so what comes
// back is already what this viewer may see. An anonymous row carries only
// what a count needs: a random checkin_id (new on every call: a React key,
// nothing more), null user_id / name / rating, its times rounded out to the
// hour, and no session fields; their order means nothing.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { normalizeFriendsAtCourts, type FriendsAtCourts } from '../lib/friendsAtCourts';

export type {
  FriendAtCourt,
  FriendsAtCourts,
  FriendsCourtGroup,
  YourCourt,
  YourCourtReason,
} from '../lib/friendsAtCourts';

export type CourtPresenceRow = {
  checkin_id: string;
  /** null on an anonymous row. */
  user_id: string | null;
  full_name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  doubles_rating: number | null;
  checked_in_at: string;
  expires_at: string;
  anonymous: boolean;
  is_friend: boolean;
  is_close_friend: boolean;
  via_session: boolean;
  session_kind: string | null;
};

/** Home's own cache entry for the section, apart from 'home:overview:v2' so the
 *  Home payload (homeData.ts) never waits on it. */
export const FRIENDS_COURTS_KEY = 'home:friendsCourts:v1';

const BOUND = { timeoutMs: 9_000 };

export async function getCourtPresence(venueId: string): Promise<CourtPresenceRow[]> {
  const rows = ((await sbCall(() => supabase.rpc('court_presence', { p_venue: venueId }), BOUND)) ??
    []) as CourtPresenceRow[];
  // Booleans default to false if a column ever arrives null.
  return rows.map((r) => ({
    ...r,
    anonymous: r.anonymous === true,
    is_friend: r.is_friend === true,
    is_close_friend: r.is_close_friend === true,
    via_session: r.via_session === true,
  }));
}

/** Friends (and closed-league mates) checked in within the last `hours`, by
 *  court, plus my courts (every star, filled up to 3) with their crowd numbers. */
export async function getFriendsAtCourts(hours = 12): Promise<FriendsAtCourts> {
  return normalizeFriendsAtCourts(await sbCall(() => supabase.rpc('friends_at_courts', { p_hours: hours }), BOUND));
}
