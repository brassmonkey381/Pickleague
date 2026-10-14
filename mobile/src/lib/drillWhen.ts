// Drill times on this device's clock.
//
// A drill time is stored as the REQUESTER's wall clock: {date, slot}, a
// half-hour of their day. On a device in another zone that reads as the wrong
// time. The real instant comes from the server, which knows the requester's
// zone: drill_sessions.starts_at for a session, and drill_request_slot_starts
// (supabase/migration_local_times_in_notices.sql) for a request's proposed
// times. The labels here show that instant in the device zone, and fall back
// to the stored wall clock when it is missing (an old row, a failed read),
// which is what every drill label showed before.
//
// Importable from a plain Node test: the loader takes the client as an
// argument (the same shape as inboxRequests' InboxDb).
import type { sbCall } from '@just-messin-around/expo-foundation/supabase';
import type { supabase as SupabaseSingleton } from './supabase';
import { dateLabel, dateSubLabel, isoDate, slotLabel, slotRangeLabel, type DateSlot } from './drillTime';

export type DrillDb = { client: typeof SupabaseSingleton; call: typeof sbCall };

/** "9am" / "6:30pm", slotLabel's style for any clock time (a zone 45 minutes
 *  off the requester's still reads right). */
function clockLabel(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** The device-zone day ('YYYY-MM-DD') and clock ("9am") of a drill time:
 *  `startsAt` when it parses, else the stored wall-clock slot. */
export function drillWhen(startsAt: string | null | undefined, fallback: DateSlot): { date: string; time: string } {
  const t = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(t)) return { date: fallback.date, time: slotLabel(fallback.slot) };
  const d = new Date(t);
  return { date: isoDate(d), time: clockLabel(d) };
}

/** "Tmrw 10/15 · 6:30pm" (slotFullLabel's format) for a drill time. */
export function drillWhenLabel(startsAt: string | null | undefined, fallback: DateSlot): string {
  const { date, time } = drillWhen(startsAt, fallback);
  return `${dateLabel(date)} ${dateSubLabel(date)} · ${time}`;
}

/** "Tmrw 10/15 · 6pm – 7pm" (slotRangeLabel's format) for a drill time and
 *  its length. */
export function drillWhenRangeLabel(
  startsAt: string | null | undefined,
  fallback: DateSlot,
  lengthMinutes: number,
): string {
  const t = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(t)) {
    return `${dateLabel(fallback.date)} ${dateSubLabel(fallback.date)} · ${slotRangeLabel(fallback.slot, lengthMinutes)}`;
  }
  const start = new Date(t);
  const date = isoDate(start);
  return `${dateLabel(date)} ${dateSubLabel(date)} · ${clockLabel(start)} – ${clockLabel(new Date(t + lengthMinutes * 60_000))}`;
}

/** Key for one proposed time in a loadDrillSlotStarts map. */
export function slotKey(s: DateSlot): string {
  return `${s.date}|${s.slot}`;
}

type SlotStartRow = { request_id: string; idx: number; slot_date: string; slot: number; starts_at: string | null };

/**
 * request id -> (slotKey -> ISO instant) for these requests' proposed times.
 * The server skips requests the caller can't see. Never throws: a failed read
 * (or a database without the RPC yet) is an empty map, so callers keep the
 * wall-clock labels.
 */
export async function loadDrillSlotStarts(
  db: DrillDb,
  requestIds: readonly string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const ids = [...new Set(requestIds)];
  if (!ids.length) return out;
  try {
    const rows = (await db.call(
      () => db.client.rpc('drill_request_slot_starts', { p_request_ids: ids }),
      { retries: 1, timeoutMs: 8_000 },
    )) as SlotStartRow[] | null;
    for (const r of rows ?? []) {
      if (!r?.request_id || !r.starts_at) continue;
      const times = out.get(r.request_id) ?? new Map<string, string>();
      times.set(slotKey({ date: r.slot_date, slot: r.slot }), r.starts_at);
      out.set(r.request_id, times);
    }
  } catch {
    // The wall-clock labels stand.
  }
  return out;
}
