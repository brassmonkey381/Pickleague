// Court check-ins: "I'm at this court until <expires_at>", and who else is.
// Thin wrappers over the RPCs in supabase/migration_venue_checkins.sql and the
// presence migration (docs/play-sessions-presence-api.md). Every write is
// idempotent server-side (client id, absolute end time), so callers may retry
// or queue them. A check-in always carries a device fix: the server confirms
// it is inside the court's fence (no manual check-ins).
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { fixArgs, type DeviceFix } from '../lib/courtCheckinRules';
import { getSport } from '../sports/registry';

export type CheckinSource = 'manual' | 'geofence' | 'session';

export type VenueCheckin = {
  id: string;
  user_id: string;
  venue_id: string;
  checked_in_at: string;
  expires_at: string;
  checked_out_at: string | null;
  source: CheckinSource;
};

/** resolve_court's answer: the canonical pickleball court at (or nearest to) a point. */
export type ResolvedCourt = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distance_m: number;
  /** The point is inside the court's mapped boundary. */
  inside: boolean;
};

export type PlayerHere = {
  checkin_id: string;
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  rating: number | null;
  doubles_rating: number | null;
  checked_in_at: string;
  expires_at: string;
};

const BOUND = { timeoutMs: 9_000 };

/** Rejects with "You need to be at the court to check in (about N m away)." when the fix is outside the fence. */
export async function checkinVenue(p: {
  id: string;
  venueId: string;
  minutes?: number;
  source?: CheckinSource;
  at?: string;
  fix: DeviceFix;
}): Promise<VenueCheckin> {
  return sbCall(
    () =>
      supabase.rpc('checkin_venue', {
        p_id: p.id,
        p_venue: p.venueId,
        p_minutes: p.minutes ?? 120,
        p_source: p.source ?? 'manual',
        p_at: p.at ?? null,
        ...fixArgs(p.fix),
      }),
    BOUND,
  ) as Promise<VenueCheckin>;
}

export async function extendCheckin(id: string, until: string): Promise<VenueCheckin> {
  return sbCall(() => supabase.rpc('extend_checkin', { p_id: id, p_until: until }), BOUND) as Promise<VenueCheckin>;
}

/**
 * Close one check-in, or all of mine (id null), optionally only those `source`
 * opened. `at` is when I left (the server clamps it to the check-in's window).
 */
export async function checkoutVenue(id: string | null, source?: CheckinSource | null, at?: string): Promise<number> {
  return sbCall(
    () => supabase.rpc('checkout_venue', { p_id: id, p_source: source ?? null, p_at: at ?? null }),
    BOUND,
  ) as Promise<number>;
}

export async function getMyOpenCheckin(userId: string): Promise<VenueCheckin | null> {
  const rows = (await sbCall(
    () =>
      supabase
        .from('venue_checkins')
        .select('id, user_id, venue_id, checked_in_at, expires_at, checked_out_at, source')
        .eq('user_id', userId)
        .is('checked_out_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('checked_in_at', { ascending: false })
        .limit(1),
    BOUND,
  )) as VenueCheckin[] | null;
  return rows?.[0] ?? null;
}

export async function getPlayersHere(venueId: string): Promise<PlayerHere[]> {
  return ((await sbCall(() => supabase.rpc('venue_players_here', { p_venue: venueId }), BOUND)) ?? []) as PlayerHere[];
}

/**
 * The pickleball court at a point: the one whose boundary contains it, else the
 * nearest within `radiusM`, or null. Duplicates resolve to the canonical row.
 */
export async function resolveCourtAt(lat: number, lng: number, radiusM = 150): Promise<ResolvedCourt | null> {
  return ((await sbCall(
    () =>
      supabase.rpc('resolve_court', { p_lat: lat, p_lng: lng, p_radius_m: radiusM, p_sport: getSport().courtSport }),
    BOUND,
  )) ?? null) as ResolvedCourt | null;
}

export async function getVenueName(venueId: string): Promise<string | null> {
  const row = (await sbCall(
    () => supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
    BOUND,
  )) as { name: string } | null;
  return row?.name ?? null;
}

export type CourtRow = { id: string; name: string; lat: number; lng: number; geofence_radius_m: number | null };

/** Venue rows by id (in no particular order). */
export async function getVenuesByIds(ids: string[]): Promise<CourtRow[]> {
  if (ids.length === 0) return [];
  return ((await sbCall(
    () => supabase.from('venues').select('id, name, lat, lng, geofence_radius_m').in('id', ids),
    BOUND,
  )) ?? []) as CourtRow[];
}

export type MyLeagueCourt = {
  home_venue_id: string | null;
  home_court_lat: number | null;
  home_court_lng: number | null;
};

/**
 * My active leagues' home courts: the stored venue (leagues.home_venue_id) when
 * set, else the coordinates for the caller to resolve.
 */
export async function getMyLeagueCourts(userId: string): Promise<MyLeagueCourt[]> {
  const rows = ((await sbCall(
    () =>
      supabase
        .from('league_members')
        .select('leagues(home_venue_id, home_court_lat, home_court_lng, is_active)')
        .eq('user_id', userId),
    BOUND,
  )) ?? []) as unknown as { leagues: (MyLeagueCourt & { is_active: boolean }) | null }[];
  return rows.flatMap((m) => (m.leagues?.is_active ? [m.leagues] : []));
}

/** My starred courts (court_favorites, max 5). [] when there are none or the read fails. */
export async function getMyFavoriteCourts(): Promise<{ venue_id: string; venue_name: string }[]> {
  try {
    return ((await sbCall(() => supabase.rpc('list_my_court_favorites'), BOUND)) ?? []) as {
      venue_id: string;
      venue_name: string;
    }[];
  } catch {
    return [];
  }
}

/** Who sees my check-ins (get_my_presence_settings), as far as the start sheet needs it. */
export type CheckinVisibility = { level: string | null; pausedUntil: string | null };

/**
 * Who sees my check-ins. null when it can't be read; callers then assume the
 * default (friends and league-mates).
 */
export async function getMyCheckinVisibility(): Promise<CheckinVisibility | null> {
  try {
    const s = (await sbCall(() => supabase.rpc('get_my_presence_settings'), BOUND)) as {
      checkins_level?: string | null;
      paused_until?: string | null;
    } | null;
    return s ? { level: s.checkins_level ?? null, pausedUntil: s.paused_until ?? null } : null;
  } catch {
    return null;
  }
}

/** Courts I checked in at recently, most recent first, one row per court. */
export async function getMyRecentCourts(userId: string, limit = 5): Promise<{ id: string; name: string }[]> {
  const rows = ((await sbCall(
    () =>
      supabase
        .from('venue_checkins')
        .select('venue_id, venues(name)')
        .eq('user_id', userId)
        .order('checked_in_at', { ascending: false })
        .limit(30),
    BOUND,
  )) ?? []) as unknown as { venue_id: string; venues: { name: string } | null }[];
  const out: { id: string; name: string }[] = [];
  for (const r of rows) {
    if (!r.venues || out.some((c) => c.id === r.venue_id)) continue;
    out.push({ id: r.venue_id, name: r.venues.name });
    if (out.length >= limit) break;
  }
  return out;
}
