// Court check-ins: "I'm at this court until <expires_at>", and who else is.
// Thin wrappers over the RPCs in supabase/migration_venue_checkins.sql. Every
// write is idempotent server-side (client id, absolute end time), so callers
// may retry or queue them.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';

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

export type NearbyVenue = { id: string; name: string; lat: number; lng: number; distance_meters: number };

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

export async function checkinVenue(p: {
  id: string;
  venueId: string;
  minutes?: number;
  source?: CheckinSource;
  at?: string;
}): Promise<VenueCheckin> {
  return sbCall(
    () =>
      supabase.rpc('checkin_venue', {
        p_id: p.id,
        p_venue: p.venueId,
        p_minutes: p.minutes ?? 120,
        p_source: p.source ?? 'manual',
        p_at: p.at ?? null,
      }),
    BOUND,
  ) as Promise<VenueCheckin>;
}

export async function extendCheckin(id: string, until: string): Promise<VenueCheckin> {
  return sbCall(() => supabase.rpc('extend_checkin', { p_id: id, p_until: until }), BOUND) as Promise<VenueCheckin>;
}

/** Close one check-in, or all of mine (id null), optionally only those `source` opened. */
export async function checkoutVenue(id: string | null, source?: CheckinSource): Promise<number> {
  return sbCall(() => supabase.rpc('checkout_venue', { p_id: id, p_source: source ?? null }), BOUND) as Promise<number>;
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

/** The closest court within `radiusM` of a point, or null. */
export async function resolveVenueAt(lat: number, lng: number, radiusM = 150): Promise<NearbyVenue | null> {
  return ((await sbCall(
    () => supabase.rpc('resolve_venue', { p_lat: lat, p_lng: lng, p_radius_m: radiusM }),
    BOUND,
  )) ?? null) as NearbyVenue | null;
}

export async function getVenueName(venueId: string): Promise<string | null> {
  const row = (await sbCall(
    () => supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
    BOUND,
  )) as { name: string } | null;
  return row?.name ?? null;
}
