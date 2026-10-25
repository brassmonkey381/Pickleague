// What a signed-in non-member may know about a closed (private) league.
//
// migration_closed_league_privacy.sql limits a closed league's row, roster,
// seasons, standings, events and matches to its members (and its creator and
// godmode). Discover, Home and a league link still show closed leagues to
// everyone signed in, with "Request code" / "Want in?", through two RPCs:
//   get_league_preview(p_league_id)  one league
//   list_league_previews()           every active closed league I can't see
// A preview carries the name, description, member count, match activity and a
// point rounded to about a mile (approx_lat / approx_lng, enough to place the
// league in a search area). Never the home court, its venue, the admin or the
// roster.
//
// Both reads are soft: before the migration is live (the RPCs missing), when
// signed out, or offline, they come back empty and the caller shows what the
// tables gave it, exactly as before.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { League } from '../types';

export type LeaguePreview = {
  id: string;
  name: string;
  description: string | null;
  is_open: boolean;
  is_active: boolean;
  created_at: string;
  member_count: number;
  match_count: number;
  recent_match_count: number;
  play_days: number;
  approx_lat: number | null;
  approx_lng: number | null;
};

const BOUND = { retries: 1, timeoutMs: 9_000 };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function coord(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toLeaguePreview(raw: any): LeaguePreview | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    is_open: raw.is_open !== false,
    is_active: raw.is_active !== false,
    created_at: String(raw.created_at ?? ''),
    member_count: num(raw.member_count),
    match_count: num(raw.match_count),
    recent_match_count: num(raw.recent_match_count),
    play_days: num(raw.play_days),
    approx_lat: coord(raw.approx_lat),
    approx_lng: coord(raw.approx_lng),
  };
}

/** Every active closed league the signed-in player can't see; [] on any failure. */
export async function listLeaguePreviews(): Promise<LeaguePreview[]> {
  try {
    const rows = await sbCall(() => supabase.rpc('list_league_previews'), BOUND);
    return ((rows ?? []) as unknown[]).map(toLeaguePreview).filter((p): p is LeaguePreview => p != null);
  } catch {
    return [];
  }
}

/** One league's preview; null when there is none or the read failed. */
export async function fetchLeaguePreview(leagueId: string): Promise<LeaguePreview | null> {
  try {
    const rows = await sbCall(() => supabase.rpc('get_league_preview', { p_league_id: leagueId }), BOUND);
    const raw = Array.isArray(rows) ? rows[0] : rows;
    return toLeaguePreview(raw);
  } catch {
    return null;
  }
}

/**
 * A preview in the League shape the screens render. The home court stays
 * unnamed; `withPoint` puts the rounded point in home_court_lat / lng (lists
 * place it in a search area with it). A detail page leaves it out, so nothing
 * looks the point up as a court.
 */
export function previewAsLeague(p: LeaguePreview, opts: { withPoint: boolean }): League {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    created_by: '',
    is_active: p.is_active,
    is_open: p.is_open,
    home_court: null,
    home_court_lat: opts.withPoint ? p.approx_lat : null,
    home_court_lng: opts.withPoint ? p.approx_lng : null,
    home_venue_id: null,
    prize_pool: 0,
    payout_structure: [],
    created_at: p.created_at,
  };
}
