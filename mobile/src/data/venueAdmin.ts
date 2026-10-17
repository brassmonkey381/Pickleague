// Godmode-only venue moderation — wraps list_admin_venue_reviews /
// admin_review_venue (see supabase/migration_add_venue_submissions.sql).
// Mirrors Doggle's dogPlaceAdmin.ts. Confirmation is admin-driven; there is no
// auto-threshold (affirmation_count is display-only).

import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { BoundaryGeometry } from '@just-messin-around/expo-foundation/ui';

/**
 * True if the caller qualifies for godmode (the app-admin allow-list).
 * Retried — a network blip answering "not an admin" locks the admin out of the
 * screen entirely, and the denial looks like a permissions problem.
 */
export async function amIGodmode(): Promise<boolean> {
  try {
    return (await sbCall(() => supabase.rpc('is_godmode_user'))) === true;
  } catch {
    return false;
  }
}

export type VenueReview = {
  id: string;
  name: string;
  sport: string[];
  kind: string;
  lat: number;
  lng: number;
  address: string | null;
  city: string | null;
  confirmation_status: string;
  submission_cluster_id: string | null;
  created_by: string | null;
  created_at: string;
  submitter_name: string;
  affirmation_count: number;
};

/**
 * The unconfirmed-venue review queue (godmode only). THROWS on failure — the
 * caller already surfaces the message, and an empty queue from a swallowed
 * error means submitted courts sit unreviewed because nobody knew they existed.
 */
export async function listAdminVenueReviews(): Promise<VenueReview[]> {
  const data = await sbCall(() => supabase.rpc('list_admin_venue_reviews'));
  return (data ?? []) as VenueReview[];
}

export type VenueReviewAction = 'save' | 'confirm' | 'reject';

export type VenueReviewEdits = {
  name?: string;
  sports?: string[];
  kind?: string;
  address?: string;
  city?: string;
};

/** Save edits, confirm, or reject a submitted venue (godmode only). */
export async function adminReviewVenue(
  venueId: string,
  action: VenueReviewAction,
  edits?: VenueReviewEdits,
): Promise<void> {
  const { error } = await supabase.rpc('admin_review_venue', {
    p_venue_id: venueId,
    p_action: action,
    p_name: edits?.name ?? null,
    p_sports: edits?.sports ?? null,
    p_kind: edits?.kind ?? null,
    p_address: edits?.address ?? null,
    p_city: edits?.city ?? null,
  });
  if (error) throw error;
}

// ── Court outlines (supabase/migration_admin_venue_boundary.sql) ────────────

export type BoundaryFilter = 'all' | 'has' | 'missing';

export type VenueBoundaryRow = {
  id: string;
  name: string;
  city: string | null;
  lat: number;
  lng: number;
  area_sqm: number | null;
  has_boundary: boolean;
  checkins: number;
};

/** Courts with their outline status, busiest first (godmode only). THROWS. */
export async function adminListVenueBoundaries(query: string, filter: BoundaryFilter): Promise<VenueBoundaryRow[]> {
  const data = await sbCall(() =>
    supabase.rpc('admin_list_venue_boundaries', { p_query: query.trim(), p_filter: filter, p_limit: 100 }),
  );
  return (data ?? []) as VenueBoundaryRow[];
}

export type VenueForBoundary = {
  id: string;
  name: string;
  city: string | null;
  lat: number;
  lng: number;
  boundary: BoundaryGeometry | null;
  area_sqm: number | null;
  geofence_radius_m: number | null;
};

/** One court with its outline, for the editor. THROWS; null when not found. */
export async function fetchVenueForBoundary(id: string): Promise<VenueForBoundary | null> {
  const data = await sbCall(() =>
    supabase
      .from('venues')
      .select('id, name, city, lat, lng, boundary, area_sqm, geofence_radius_m')
      .eq('id', id)
      .maybeSingle(),
  );
  return (data ?? null) as VenueForBoundary | null;
}

export type SavedBoundary = { area_sqm: number | null; has_boundary: boolean; pin_inside: boolean };

/** Save (or clear, with null) a court's outline (godmode only). THROWS with the server's message. */
export async function adminSaveVenueBoundary(id: string, boundary: BoundaryGeometry | null): Promise<SavedBoundary> {
  const { data, error } = await supabase.rpc('admin_save_venue_boundary', { p_venue_id: id, p_boundary: boundary });
  if (error) throw error;
  return data as SavedBoundary;
}
