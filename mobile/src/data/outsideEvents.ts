// Outside events, server side (supabase/migration_outside_events.sql): typed
// wrappers for the client RPCs and the cached reads every screen shares.
//
//   list_outside_events(p_kinds, p_mine)   listed events near my home court
//   get_outside_event(p_id)                one (or a hidden / past one I RSVP'd to)
//   set_outside_event_rsvp(p_id, p_status) Going / Interested (maybe) / clear
//   report_outside_event(p_id, p_reason)   report a problem
//   mark_outside_events_seen(p_ids)        the NEW count
//
// One list read (every kind) feeds the Events screen, its kind chips (they
// filter on the phone), the court badges and the court page. Refusals come
// back as P0001 with HINT pl:<code> (lib/refusals.ts words them); these
// wrappers never catch them.
import { useMemo } from 'react';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { invalidateQueries, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import type { OutsideReportReason } from '@just-messin-around/expo-foundation/outsideEvents/rules';
import { supabase } from '../lib/supabase';
import {
  createOutsideSeenStore,
  eventsByCourt,
  outsideEventFromRpc,
  outsideEventsFromRpc,
  type OutsideEvent,
  type RsvpStatus,
} from '../lib/outsideEvents';

const BOUND = { timeoutMs: 9_000 };
const PREFIX = 'outsideEvents';
const LIST_KEY = `${PREFIX}:list`;
const MINE_KEY = `${PREFIX}:mine`;
const eventKey = (id: string) => `${PREFIX}:event:${id}`;
/** Events change a few times a day; RSVP counts a little more often. */
const LIST_TTL_MS = 5 * 60_000;

export async function listOutsideEvents(opts: { mine?: boolean } = {}): Promise<OutsideEvent[]> {
  return outsideEventsFromRpc(
    await sbCall(() => supabase.rpc('list_outside_events', { p_kinds: null, p_mine: !!opts.mine }), BOUND),
  );
}

/** Every listed event near me (all kinds), soonest first. */
export function useOutsideEvents(enabled = true) {
  return useCachedQuery<OutsideEvent[]>(LIST_KEY, () => listOutsideEvents(), { ttlMs: LIST_TTL_MS, enabled });
}

/** The ones I marked Interested or Going: the Home feed's events. */
export function useMyOutsideEvents(enabled = true) {
  return useCachedQuery<OutsideEvent[]>(MINE_KEY, () => listOutsideEvents({ mine: true }), {
    ttlMs: LIST_TTL_MS,
    enabled,
  });
}

/** Listed events by court id, from the shared list read. */
export function useOutsideEventsByCourt(enabled = true): Map<string, OutsideEvent[]> {
  const q = useOutsideEvents(enabled);
  return useMemo(() => eventsByCourt(q.data ?? []), [q.data]);
}

export async function getOutsideEvent(id: string): Promise<OutsideEvent | null> {
  return outsideEventFromRpc(await sbCall(() => supabase.rpc('get_outside_event', { p_id: id }), BOUND));
}

export function useOutsideEvent(id: string) {
  return useCachedQuery<OutsideEvent | null>(eventKey(id), () => getOutsideEvent(id), { ttlMs: 60_000 });
}

/** After an RSVP or a report: every outside-events read again. */
function refreshAll(): void {
  invalidateQueries(PREFIX);
}

export async function setOutsideEventRsvp(
  id: string,
  status: RsvpStatus | null,
): Promise<{ myStatus: RsvpStatus | null; goingCount: number; interestedCount: number }> {
  const r = ((await sbCall(() => supabase.rpc('set_outside_event_rsvp', { p_id: id, p_status: status }), BOUND)) ??
    {}) as Record<string, unknown>;
  refreshAll();
  return {
    myStatus: r.my_status === 'going' || r.my_status === 'maybe' ? r.my_status : null,
    goingCount: typeof r.going_count === 'number' ? r.going_count : 0,
    interestedCount: typeof r.interested_count === 'number' ? r.interested_count : 0,
  };
}

export async function reportOutsideEvent(
  id: string,
  reason: OutsideReportReason,
): Promise<{ status: string; hidden: boolean; hiddenReason: string | null }> {
  const r = ((await sbCall(() => supabase.rpc('report_outside_event', { p_id: id, p_reason: reason }), BOUND)) ??
    {}) as Record<string, unknown>;
  refreshAll();
  return {
    status: typeof r.status === 'string' ? r.status : 'reported',
    hidden: r.hidden === true,
    hiddenReason: typeof r.hidden_reason === 'string' ? r.hidden_reason : null,
  };
}

/**
 * Which events I've seen (the NEW tags and Home's dot). One per app. Marks
 * are optimistic; a failed server call counts them as new again.
 */
export const outsideSeen = createOutsideSeenStore<OutsideEvent>({
  markOnServer: async (ids) => {
    await sbCall(() => supabase.rpc('mark_outside_events_seen', { p_ids: ids }), BOUND);
  },
  // Every row here is an outside event (the server's rows carry no source).
  isOutside: () => true,
});
