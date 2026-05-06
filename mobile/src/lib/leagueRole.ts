import { supabase } from './supabase';

export type LeagueRole = 'admin' | 'co-admin' | 'member' | null;

export async function getLeagueRole(leagueId: string): Promise<LeagueRole> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('league_members')
    .select('role')
    .eq('league_id', leagueId)
    .eq('user_id', user.id)
    .maybeSingle();
  return (data?.role ?? null) as LeagueRole;
}

export function isPrivileged(role: LeagueRole): boolean {
  return role === 'admin' || role === 'co-admin';
}

export function roleBadgeColor(role: LeagueRole): string {
  if (role === 'admin')    return '#b8860b';
  if (role === 'co-admin') return '#2e7d32';
  return '#888';
}

export function roleLabel(role: LeagueRole): string {
  if (role === 'admin')    return 'Admin';
  if (role === 'co-admin') return 'Co-Admin';
  return 'Member';
}
