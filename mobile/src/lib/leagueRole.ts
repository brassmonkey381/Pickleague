import { sbCall, currentUserId } from '@just-messin-around/expo-foundation/supabase';
import type { Theme } from '@just-messin-around/expo-foundation/theme';
import { supabase } from './supabase';

/**
 * The signed-in user's standing in a league.
 *
 * `null` means definitively NOT a member. `'unknown'` means we couldn't find
 * out — the read failed. The two used to collapse into `null`, which is why a
 * member on bad WiFi was shown "Join this league" and an admin lost their
 * controls: screens read the failure as a fact about the user.
 *
 * Callers should leave whatever they last knew in place when they get
 * `'unknown'`, never downgrade the UI on it.
 */
export type LeagueRole = 'admin' | 'co-admin' | 'member' | 'unknown' | null;

export async function getLeagueRole(leagueId: string): Promise<LeagueRole> {
  // LOCAL session read — getUser() is a network round trip, so offline it
  // answered "no user" and every member looked like a stranger.
  const userId = await currentUserId(supabase);
  if (!userId) return null;
  try {
    const data = await sbCall(() =>
      supabase
        .from('league_members')
        .select('role')
        .eq('league_id', leagueId)
        .eq('user_id', userId)
        .maybeSingle(),
    );
    return (data?.role ?? null) as LeagueRole;
  } catch {
    return 'unknown';
  }
}

/** True only for a role we actually determined (i.e. safe to act on). */
export function isRoleKnown(role: LeagueRole): boolean {
  return role !== 'unknown';
}

/** True when the user is definitely in the league. `'unknown'` is not. */
export function isMember(role: LeagueRole): boolean {
  return role === 'admin' || role === 'co-admin' || role === 'member';
}

export function isPrivileged(role: LeagueRole): boolean {
  return role === 'admin' || role === 'co-admin';
}

/** A role's accent, from the theme (light and dark): admin gold, co-admin the
 *  brand, everyone else muted. */
export function roleBadgeColor(role: LeagueRole, c: Theme): string {
  if (role === 'admin')    return c.rarityLegendary;
  if (role === 'co-admin') return c.primary;
  return c.textMuted;
}

export function roleLabel(role: LeagueRole): string {
  if (role === 'admin')    return 'Admin';
  if (role === 'co-admin') return 'Co-Admin';
  if (role === 'unknown')  return '—';
  return 'Member';
}
