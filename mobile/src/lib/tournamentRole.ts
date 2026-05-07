import { supabase } from './supabase';

export type TournamentRole = 'admin' | 'co-admin' | 'member' | null;

export async function getTournamentRole(tournamentId: string): Promise<TournamentRole> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('tournament_registrations')
    .select('role')
    .eq('tournament_id', tournamentId)
    .eq('user_id', user.id)
    .eq('status', 'approved')
    .maybeSingle();
  return (data?.role ?? null) as TournamentRole;
}

export function isTournamentPrivileged(role: TournamentRole): boolean {
  return role === 'admin' || role === 'co-admin';
}

export function tournamentRoleLabel(role: TournamentRole): string {
  if (role === 'admin')    return 'Admin';
  if (role === 'co-admin') return 'Co-Admin';
  return 'Member';
}

export function tournamentRoleBadgeColor(role: TournamentRole): string {
  if (role === 'admin')    return '#b8860b';
  if (role === 'co-admin') return '#2e7d32';
  return '#888';
}

/** Formats need fixed pre-assigned partners */
export function requiresPartner(format: string): boolean {
  return format === 'mlp';
}

/** How long until bracket_release_time, as a human string */
export function bracketReleaseLabel(releaseTime: string | null): string {
  if (!releaseTime) return '';
  const diff = new Date(releaseTime).getTime() - Date.now();
  if (diff <= 0) return 'Brackets should be released soon';
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(h / 24);
  if (d > 0) return `Brackets expected in ${d}d ${h % 24}h`;
  if (h > 0) return `Brackets expected in ${h}h ${Math.floor((diff % 3600000) / 60000)}m`;
  return `Brackets expected in ${Math.floor(diff / 60000)}m`;
}
