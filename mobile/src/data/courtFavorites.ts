// My courts: up to 5 starred courts (court_favorites). They head Home's YOUR
// COURTS and, later, the arrival-alert fence list. Wrappers over
// set_court_favorite / list_my_court_favorites
// (docs/play-sessions-presence-api.md, "Court favorites").
//
// The server canonicalises the id (a duplicate court row stars its facility)
// and refuses a 6th star; the client checks the cap first so the common case
// gets a friendly line without a round trip.
import { useMemo } from 'react';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import {
  invalidateQueries,
  peekQuery,
  setQueryData,
  useCachedQuery,
} from '@just-messin-around/expo-foundation/cache';
import { supabase } from '../lib/supabase';
import { FRIENDS_COURTS_KEY } from './courtPresence';

export const COURT_FAVORITES_KEY = 'me:courtFavorites';
export const MAX_COURT_FAVORITES = 5;

export const FAVORITES_FULL_MESSAGE = `You can star up to ${MAX_COURT_FAVORITES} courts. Unstar one to add this one.`;

export type CourtFavorite = { venue_id: string; venue_name: string; lat: number | null; lng: number | null };

const TTL_MS = 5 * 60_000;
const PERSIST_MS = 7 * 24 * 60 * 60 * 1000;
const BOUND = { timeoutMs: 9_000 };

export async function listMyCourtFavorites(): Promise<CourtFavorite[]> {
  return ((await sbCall(() => supabase.rpc('list_my_court_favorites'), BOUND)) ?? []) as CourtFavorite[];
}

export async function setCourtFavorite(venueId: string, on: boolean): Promise<boolean> {
  return (await sbCall(() => supabase.rpc('set_court_favorite', { p_venue: venueId, p_on: on }), BOUND)) as boolean;
}

export function useCourtFavorites(enabled = true) {
  return useCachedQuery<CourtFavorite[]>(COURT_FAVORITES_KEY, listMyCourtFavorites, {
    ttlMs: TTL_MS,
    persistMs: PERSIST_MS,
    enabled,
  });
}

export function useCourtFavoriteIds(enabled = true): Set<string> {
  const { data } = useCourtFavorites(enabled);
  return useMemo(() => new Set((data ?? []).map((f) => f.venue_id)), [data]);
}

/**
 * Star or unstar a court. Shows at once (the cached list is patched), puts the
 * list back if the write fails, then refetches it and Home's YOUR COURTS.
 * Throws FAVORITES_FULL_MESSAGE past the cap, or the server's message.
 */
export async function toggleCourtFavorite(venueId: string, on: boolean, venueName?: string | null): Promise<void> {
  const before = peekQuery<CourtFavorite[]>(COURT_FAVORITES_KEY);
  const list = before ?? [];
  if (on && !list.some((f) => f.venue_id === venueId) && list.length >= MAX_COURT_FAVORITES) {
    throw new Error(FAVORITES_FULL_MESSAGE);
  }
  setQueryData<CourtFavorite[]>(
    COURT_FAVORITES_KEY,
    on
      ? [...list.filter((f) => f.venue_id !== venueId), { venue_id: venueId, venue_name: venueName ?? '', lat: null, lng: null }]
      : list.filter((f) => f.venue_id !== venueId),
  );
  try {
    await setCourtFavorite(venueId, on);
  } catch (e) {
    if (before) setQueryData(COURT_FAVORITES_KEY, before);
    else invalidateQueries(COURT_FAVORITES_KEY);
    throw e;
  }
  invalidateQueries(COURT_FAVORITES_KEY);
  invalidateQueries(FRIENDS_COURTS_KEY);
}
