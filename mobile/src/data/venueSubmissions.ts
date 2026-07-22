// User-submitted venues — thin wrappers over the submit_venue / find_nearby RPCs
// (see supabase/migration_add_venue_submissions.sql). Mirrors Doggle's
// dogPlaceSubmissions.ts. A submission becomes a source='user',
// confirmation_status='unconfirmed' venue that shows in search immediately
// (ranked below confirmed) until a godmode admin confirms or rejects it.

import { supabase } from '../lib/supabase';

export type NearbyVenueSubmission = {
  id: string;
  name: string;
  kind: string;
  sport: string[];
  address: string | null;
  city: string | null;
  lat: number;
  lng: number;
  submission_cluster_id: string | null;
  confirmation_status: string;
  distance_meters: number;
};

/** Unconfirmed submissions within `radiusM` (default 100 m) — for the "same place?" prompt. */
export async function findNearbyVenueSubmissions(
  lat: number,
  lng: number,
  radiusM = 100,
): Promise<NearbyVenueSubmission[]> {
  const { data, error } = await supabase.rpc('find_nearby_venue_submissions', {
    p_lat: lat,
    p_lng: lng,
    p_radius_m: radiusM,
  });
  if (error || !data) return [];
  return data as NearbyVenueSubmission[];
}

export type SubmitVenueInput = {
  name: string;
  lat: number;
  lng: number;
  sports?: string[];
  kind?: string;
  address?: string | null;
  city?: string | null;
  /** Set to affirm an existing nearby submission instead of creating a new one. */
  affirmVenueId?: string | null;
};

export type SubmitVenueResult = { venue_id: string; affirmed: boolean; cluster_id: string };

/** Create a new unconfirmed venue, or affirm an existing nearby submission. */
export async function submitVenue(input: SubmitVenueInput): Promise<SubmitVenueResult> {
  const { data, error } = await supabase.rpc('submit_venue', {
    p_name: input.name,
    p_lat: input.lat,
    p_lng: input.lng,
    p_sports: input.sports ?? [],
    p_kind: input.kind ?? 'court',
    p_address: input.address ?? null,
    p_city: input.city ?? null,
    p_affirm_venue_id: input.affirmVenueId ?? null,
  });
  if (error) throw error;
  return data as SubmitVenueResult;
}
