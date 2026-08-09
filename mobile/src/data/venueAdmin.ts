// Godmode-only venue moderation — wraps list_admin_venue_reviews /
// admin_review_venue (see supabase/migration_add_venue_submissions.sql).
// Mirrors Doggle's dogPlaceAdmin.ts. Confirmation is admin-driven; there is no
// auto-threshold (affirmation_count is display-only).

import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';

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
