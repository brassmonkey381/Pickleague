// The anonymous crowd at courts ("6 playing now · mostly 3.5–4.0 · 2 friends"):
// a wrapper over venue_crowd (docs/play-sessions-presence-api.md). It counts
// everyone checked in and location-confirmed, hidden players included and
// blocked players excluded, and only sends a skill band with 3+ rated players
// there. Works with zero friends, so it is the open-play turnout signal.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import type { CrowdNumbers } from '../lib/courtCrowd';

export type VenueCrowd = CrowdNumbers & { venue_id: string };

/** The RPC takes at most this many ids per call. */
export const VENUE_CROWD_MAX_IDS = 50;

const BOUND = { timeoutMs: 9_000 };

/** One cache entry per court, so every surface showing that court shares it. */
export function venueCrowdKey(venueId: string): string {
  return `venue:crowd:${venueId}`;
}

// numeric columns can arrive as strings
type Num = number | string | null;
type Row = { venue_id: string; here_now: Num; band_low: Num; band_high: Num; friends_here: Num };

const toNum = (v: number | string | null | undefined): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Crowd numbers by court id. A court with nobody there may be missing from
 *  the RPC's rows; it comes back as zeros (asked about, so known to be empty). */
export async function getVenueCrowd(venueIds: readonly string[]): Promise<Map<string, VenueCrowd>> {
  const ids = [...new Set(venueIds.filter(Boolean))];
  const out = new Map<string, VenueCrowd>();
  for (const id of ids) out.set(id, { venue_id: id, here_now: 0, band_low: null, band_high: null, friends_here: 0 });
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += VENUE_CROWD_MAX_IDS) chunks.push(ids.slice(i, i + VENUE_CROWD_MAX_IDS));
  const results = await Promise.all(
    chunks.map((chunk) => sbCall(() => supabase.rpc('venue_crowd', { p_venue_ids: chunk }), BOUND) as Promise<Row[] | null>),
  );
  for (const rows of results) {
    for (const r of rows ?? []) {
      if (!r?.venue_id) continue;
      out.set(r.venue_id, {
        venue_id: r.venue_id,
        here_now: Math.max(0, Math.floor(toNum(r.here_now) ?? 0)),
        band_low: toNum(r.band_low),
        band_high: toNum(r.band_high),
        friends_here: Math.max(0, Math.floor(toNum(r.friends_here) ?? 0)),
      });
    }
  }
  return out;
}

/** One court's crowd (zeros when nobody is there). */
export async function getOneVenueCrowd(venueId: string): Promise<VenueCrowd> {
  return (await getVenueCrowd([venueId])).get(venueId)!;
}
