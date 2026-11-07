// Court schedules, server side (supabase/migration_court_schedules.sql): typed
// wrappers for the RPCs and the cached reads the screens share.
//
//   list_court_sessions(p_venue_id)        a court's weekly sessions
//   nearby_court_schedules()               courts with sessions near my home location
//   suggest_court_schedule(p_venue_id, p_note)   goes to the review list only
//   admin_schedule_review()                pending items and the source list
//   admin_resolve_schedule_proposal(p_id, p_status)
//
// Refusals come back as P0001 with HINT pl:<code> (lib/refusals.ts words them).
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { invalidateQueries, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { supabase } from '../lib/supabase';

const BOUND = { timeoutMs: 9_000 };
const PREFIX = 'courtSchedules';
const NEARBY_KEY = `${PREFIX}:nearby`;
const courtKey = (venueId: string) => `${PREFIX}:court:${venueId}`;
/** Schedules change a few times a season. */
const TTL_MS = 30 * 60_000;

export type CourtSession = {
  id: string;
  place_id: string;
  title: string;
  days: number;
  start_time: string;
  end_time: string | null;
  tz: string;
  level: string | null;
  cost: string | null;
  note: string | null;
  organizer_name: string | null;
  source_name: string | null;
  source_url: string | null;
  valid_from: string | null;
  valid_to: string | null;
  skip_dates: string[];
  last_verified_at: string;
};

export type NearbySchedules = {
  court_count: number;
  session_count: number;
  courts: { venue_id: string; name: string; city: string | null; session_count: number }[];
};

export type ScheduleProposal = {
  id: string;
  kind: 'page_changed' | 'suggestion';
  note: string | null;
  created_at: string;
  venue_id: string | null;
  venue_name: string | null;
  source_id: string | null;
  source_name: string | null;
  source_url: string | null;
};

export type ScheduleSource = {
  id: string;
  name: string;
  url: string;
  method: 'fetch' | 'manual';
  active: boolean;
  terms_checked: boolean;
  notes: string | null;
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_status: string | null;
};

export type ScheduleReview = { proposals: ScheduleProposal[]; sources: ScheduleSource[] };

export async function listCourtSessions(venueId: string): Promise<CourtSession[]> {
  const r = await sbCall(() => supabase.rpc('list_court_sessions', { p_venue_id: venueId }), BOUND);
  return Array.isArray(r) ? (r as CourtSession[]) : [];
}

export function useCourtSessions(venueId: string) {
  return useCachedQuery<CourtSession[]>(courtKey(venueId), () => listCourtSessions(venueId), { ttlMs: TTL_MS });
}

export async function nearbyCourtSchedules(): Promise<NearbySchedules> {
  const r = (await sbCall(() => supabase.rpc('nearby_court_schedules'), BOUND)) as NearbySchedules | null;
  return r ?? { court_count: 0, session_count: 0, courts: [] };
}

export function useNearbyCourtSchedules() {
  return useCachedQuery<NearbySchedules>(NEARBY_KEY, nearbyCourtSchedules, { ttlMs: TTL_MS });
}

export async function suggestCourtSchedule(venueId: string, note: string): Promise<void> {
  await sbCall(() => supabase.rpc('suggest_court_schedule', { p_venue_id: venueId, p_note: note }), BOUND);
}

export async function adminScheduleReview(): Promise<ScheduleReview> {
  const r = (await sbCall(() => supabase.rpc('admin_schedule_review'), BOUND)) as ScheduleReview | null;
  return r ?? { proposals: [], sources: [] };
}

export async function adminResolveScheduleProposal(id: string, status: 'applied' | 'dismissed'): Promise<void> {
  await sbCall(() => supabase.rpc('admin_resolve_schedule_proposal', { p_id: id, p_status: status }), BOUND);
  invalidateQueries(PREFIX);
}
