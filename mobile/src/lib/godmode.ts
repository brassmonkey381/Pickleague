import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';

// "Godmode" — an app-wide superuser bypass. Reserved for the original developer
// account, identified by the auth user ID (not name/username — names aren't
// guaranteed unique, and the username can be changed).
//
// Godmode users are exempt from the per-account create limits, can edit closed
// leagues/tournaments, and can delete any league/tournament. Keep this list
// short and version-controlled.

const GODMODE_USER_IDS = new Set<string>([
  '252a36e1-5d89-4ad2-8a3e-b786579f019a', // Brian Stockman (bsaucey)
]);

export function isGodmodeUserId(userId: string | null | undefined): boolean {
  return !!userId && GODMODE_USER_IDS.has(userId);
}

// Async helper — checks whether the current auth user qualifies for godmode.
// Reads the session LOCALLY: getUser() is a network round trip, so offline the
// godmode account lost its own admin surface for the whole session.
export async function checkGodmode(): Promise<boolean> {
  const userId = await currentUserId(supabase);
  return isGodmodeUserId(userId);
}

// Counts active leagues where the user is admin (creator OR `league_members.role='admin'`).
// "Active" = leagues.is_active = true.
//
// Throws if a count can't be read. These numbers gate the per-account create
// limits, and a swallowed error returning 0 is the answer that always lets the
// create through — fail loud instead so the caller can say "try again".
export async function countActiveAdminLeagues(userId: string): Promise<number> {
  const [created, memberOf] = await Promise.all([
    sbCall(() => supabase.from('leagues').select('id').eq('created_by', userId).eq('is_active', true)),
    sbCall(() => supabase.from('league_members').select('league_id').eq('user_id', userId).eq('role', 'admin')),
  ]);

  const ids = new Set<string>();
  ((created ?? []) as { id: string }[]).forEach(r => ids.add(r.id));
  ((memberOf ?? []) as { league_id: string }[]).forEach(r => ids.add(r.league_id));
  if (ids.size === 0) return 0;

  // Restrict member-admin matches to active leagues
  const activeMatches = await sbCall(() =>
    supabase.from('leagues').select('id').in('id', [...ids]).eq('is_active', true),
  );
  return activeMatches?.length ?? 0;
}

// Counts active tournaments where the user is creator. "Active" = status not in
// ('completed','cancelled'). Throws on failure — see countActiveAdminLeagues.
export async function countActiveOwnedTournaments(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('tournaments')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', userId)
    .in('status', ['registration', 'active']);
  if (error) throw error;
  return count ?? 0;
}
