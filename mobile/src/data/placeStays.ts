// My Place stays, server side (supabase/migration_place_stays.sql): typed
// wrappers for the four RPCs and a cached read of who is staying where.
//
//   visit_place(p_host)          my avatar stays 4 hours at a friend's place
//   leave_place()                come home early (no reward)
//   claim_place_stay_returns()   finished stays, settled and handed over once
//   get_place_stays(p_owner)     {away, guests} for my place or a friend's
//
// Refusals come back as P0001 with HINT pl:<code> (lib/refusals.ts words
// them); these wrappers never catch them.
import { useEffect } from 'react';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { invalidateQueries, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { supabase } from '../lib/supabase';
import {
  nextStayEndMs,
  placeStayReturnsFromRpc,
  placeStaysFromRpc,
  type PlaceStayReturn,
  type PlaceStays,
} from '../lib/placeStays';

const BOUND = { timeoutMs: 9_000 };
/** Under My Place's 'myplace' prefix, so its pull to refresh reads these again. */
const STAYS_PREFIX = 'myplace:stays';
const staysKey = (ownerId: string | null) => `${STAYS_PREFIX}:${ownerId ?? 'me'}`;
/** A stay starts, ends or is cut short at any time: re-read soon. */
const STAYS_TTL_MS = 30_000;

export async function getPlaceStays(ownerId?: string | null): Promise<PlaceStays> {
  return placeStaysFromRpc(await sbCall(() => supabase.rpc('get_place_stays', { p_owner: ownerId ?? null }), BOUND));
}

/**
 * Who is staying where, for my place (null) or a friend's. Not kept on disk:
 * a stay that ended must not show on the next open. A place I can't visit
 * answers nothing, never an error.
 */
export function usePlaceStays(ownerId: string | null, enabled = true) {
  const q = useCachedQuery<PlaceStays>(staysKey(ownerId), () => getPlaceStays(ownerId), {
    ttlMs: STAYS_TTL_MS,
    enabled,
  });
  // Read again a second after the next stay ends, so the avatar comes home
  // (and a guest leaves) on time while the page is open.
  const endMs = nextStayEndMs(q.data);
  const { refresh } = q;
  useEffect(() => {
    if (!enabled || endMs == null) return;
    const id = setTimeout(() => void refresh(), Math.min(endMs - Date.now() + 1_000, 2_147_000_000));
    return () => clearTimeout(id);
  }, [enabled, endMs, refresh]);
  return q;
}

/** After a stay starts or ends: every stays read again (mine, theirs). */
function refreshStays(): void {
  invalidateQueries(STAYS_PREFIX);
}

/** Start a stay at a friend's place. Returns when it ends (the same stay if I'm already there). */
export async function visitPlace(hostId: string): Promise<{ endsAt: string; hostLabel: string }> {
  const r = ((await sbCall(() => supabase.rpc('visit_place', { p_host: hostId }), BOUND)) ?? {}) as Record<string, unknown>;
  refreshStays();
  return {
    endsAt: typeof r.ends_at === 'string' ? r.ends_at : '',
    hostLabel: typeof r.host_label === 'string' ? r.host_label : "your friend's place",
  };
}

/** Come home early: no reward. A stay already over is settled with its reward (shown on Home). */
export async function leavePlace(): Promise<{ ended: boolean; early: boolean }> {
  const r = ((await sbCall(() => supabase.rpc('leave_place'), BOUND)) ?? {}) as Record<string, unknown>;
  refreshStays();
  return { ended: r.ended === true, early: r.early === true };
}

/** Settle my finished stays and return the ones not shown yet (each once). */
export async function claimPlaceStayReturns(): Promise<PlaceStayReturn[]> {
  const rows = placeStayReturnsFromRpc(await sbCall(() => supabase.rpc('claim_place_stay_returns'), BOUND));
  if (rows.length > 0) refreshStays();
  return rows;
}
