import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// end_play_session as the app sends it: the End is the check-out of the
// session's own check-in, so it may carry the fix taken at the tap (Phase 1.5).
const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  refuseFix: null as unknown,
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.calls.push({ fn, args });
      if (h.refuseFix && 'p_lat' in args) return Promise.reject(h.refuseFix);
      return Promise.resolve(1);
    },
  },
}));
vi.mock('@just-messin-around/expo-foundation/supabase', () => ({
  sbCall: (fn: () => Promise<unknown>) => fn(),
  classifySbError: (e: { code?: string } | null) => (e?.code === 'PGRST202' ? 'missingFunction' : 'unknown'),
}));

import { endPlaySession } from '../playSessions';

const NOW = Date.parse('2026-10-16T18:30:00.000Z');
const fix = { lat: 40.2001, lng: -100, accuracyM: 10, fixAt: new Date(NOW - 1_500).toISOString() };

beforeEach(() => {
  h.calls.length = 0;
  h.refuseFix = null;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('endPlaySession', () => {
  it('without a fix sends the Phase 1 shape, nothing more', async () => {
    await endPlaySession('s1', '2026-10-16T18:29:00.000Z');
    expect(h.calls).toEqual([{ fn: 'end_play_session', args: { p_id: 's1', p_at: '2026-10-16T18:29:00.000Z' } }]);
  });

  it('with a fix sends it as the check-out fix, its age measured at send', async () => {
    await endPlaySession('s1', '2026-10-16T18:29:00.000Z', fix);
    expect(h.calls).toEqual([
      {
        fn: 'end_play_session',
        args: {
          p_id: 's1',
          p_at: '2026-10-16T18:29:00.000Z',
          p_lat: 40.2001,
          p_lng: -100,
          p_accuracy_m: 10,
          p_fix_age_ms: 1_500,
        },
      },
    ]);
  });

  it('a server without the Phase 1.5 SQL (PGRST202) gets the End again without the fix', async () => {
    h.refuseFix = { code: 'PGRST202', message: 'Could not find the function public.end_play_session' };
    await expect(endPlaySession('s1', '2026-10-16T18:29:00.000Z', fix)).resolves.toBe(1);
    expect(h.calls.map((c) => Object.keys(c.args).sort())).toEqual([
      ['p_accuracy_m', 'p_at', 'p_fix_age_ms', 'p_id', 'p_lat', 'p_lng'],
      ['p_at', 'p_id'],
    ]);
  });

  it('any other failure is not retried (the End queues or fails as before)', async () => {
    h.refuseFix = { code: '42501', message: 'permission denied' };
    await expect(endPlaySession('s1', undefined, fix)).rejects.toEqual(h.refuseFix);
    expect(h.calls).toHaveLength(1);
  });
});
