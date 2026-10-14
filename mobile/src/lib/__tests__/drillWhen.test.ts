import { describe, it, expect } from 'vitest';
import { drillWhen, drillWhenLabel, drillWhenRangeLabel, loadDrillSlotStarts, slotKey, type DrillDb } from '../drillWhen';

describe('drillWhen', () => {
  it('reads the real instant on the device clock, whatever the stored wall clock says', () => {
    // Stored as the requester's 9 AM; the instant is 8 AM here.
    expect(drillWhen(new Date(2026, 9, 17, 8, 0).toISOString(), { date: '2026-10-17', slot: 18 }))
      .toEqual({ date: '2026-10-17', time: '8am' });
    // The device day can differ from the stored one, and a 45-minute zone
    // offset still prints its minutes.
    expect(drillWhen(new Date(2026, 9, 17, 23, 45).toISOString(), { date: '2026-10-18', slot: 0 }))
      .toEqual({ date: '2026-10-17', time: '11:45pm' });
    expect(drillWhen(new Date(2026, 9, 17, 12, 30).toISOString(), { date: '2026-10-17', slot: 0 }).time).toBe('12:30pm');
  });

  it('falls back to the stored wall clock when there is no instant', () => {
    expect(drillWhen(null, { date: '2026-10-17', slot: 19 })).toEqual({ date: '2026-10-17', time: '9:30am' });
    expect(drillWhen('not a time', { date: '2026-10-17', slot: 0 })).toEqual({ date: '2026-10-17', time: '12am' });
  });

  it("drillWhenLabel keeps slotFullLabel's format", () => {
    const weekday = new Date(2030, 0, 1).toLocaleDateString(undefined, { weekday: 'short' });
    expect(drillWhenLabel(null, { date: '2030-01-01', slot: 36 })).toBe(`${weekday} 1/1 · 6pm`);
    expect(drillWhenLabel(new Date(2030, 0, 1, 18, 30).toISOString(), { date: '2030-01-01', slot: 0 })).toBe(`${weekday} 1/1 · 6:30pm`);
  });

  it("drillWhenRangeLabel keeps slotRangeLabel's format, ending at start + length", () => {
    const weekday = new Date(2030, 0, 1).toLocaleDateString(undefined, { weekday: 'short' });
    expect(drillWhenRangeLabel(null, { date: '2030-01-01', slot: 36 }, 60)).toBe(`${weekday} 1/1 · 6pm – 7pm`);
    expect(drillWhenRangeLabel(new Date(2030, 0, 1, 23, 0).toISOString(), { date: '2030-01-01', slot: 0 }, 60))
      .toBe(`${weekday} 1/1 · 11pm – 12am`);
  });
});

describe('loadDrillSlotStarts', () => {
  function fakeDb(answer: () => unknown) {
    const calls: unknown[] = [];
    const db = {
      client: { rpc: (name: string, args: unknown) => { calls.push([name, args]); return null; } },
      call: async (build: () => unknown) => { build(); return answer(); },
    } as unknown as DrillDb;
    return { db, calls };
  }

  it('maps each request to its proposed times by date and slot', async () => {
    const { db, calls } = fakeDb(() => [
      { request_id: 'r1', idx: 0, slot_date: '2026-10-17', slot: 18, starts_at: '2026-10-17T15:00:00+00:00' },
      { request_id: 'r1', idx: 1, slot_date: '2026-10-18', slot: 20, starts_at: '2026-10-18T16:00:00+00:00' },
      { request_id: 'r2', idx: 0, slot_date: '2026-10-19', slot: 36, starts_at: null },
    ]);
    const m = await loadDrillSlotStarts(db, ['r1', 'r2', 'r1']);
    expect(calls).toEqual([['drill_request_slot_starts', { p_request_ids: ['r1', 'r2'] }]]);
    expect(m.get('r1')?.get(slotKey({ date: '2026-10-17', slot: 18 }))).toBe('2026-10-17T15:00:00+00:00');
    expect(m.get('r1')?.size).toBe(2);
    expect(m.has('r2')).toBe(false);
  });

  it('never throws, and makes no call without ids', async () => {
    const failing = fakeDb(() => { throw new Error('Could not find the function'); });
    expect((await loadDrillSlotStarts(failing.db, ['r1'])).size).toBe(0);
    const idle = fakeDb(() => []);
    expect((await loadDrillSlotStarts(idle.db, [])).size).toBe(0);
    expect(idle.calls).toEqual([]);
  });
});
