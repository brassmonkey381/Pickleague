import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pointsCapProgress,
  summarizePointsDay,
  pointsKindOf,
  nextPointsPageRequest,
} from '@just-messin-around/expo-foundation/gamification/pointsLedger';

// The pickle history as the viewer and the calendar get it (data/pickleLedger):
// rows -> kit entries, keyset paging, the 62-day range rule, refusals.
const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> | undefined }[],
  answer: (() => []) as (fn: string, args: Record<string, unknown> | undefined) => unknown,
  fail: null as unknown,
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args?: Record<string, unknown>) => {
      h.calls.push({ fn, args });
      return Promise.resolve(h.fail ? { data: null, error: h.fail } : { data: h.answer(fn, args), error: null });
    },
  },
}));
vi.mock('@just-messin-around/expo-foundation/supabase', () => ({
  sbCall: async (build: () => Promise<{ data: unknown; error: unknown }>) => {
    const { data, error } = await build();
    if (error) throw error;
    return data;
  },
}));

import {
  listPickleLedgerPage,
  listPickleLedgerRange,
  parsePickleToday,
  pickleKindOf,
  pickleLedgerError,
  pickleRangeChunks,
  playStreakCaption,
  toPickleEntry,
  type PickleLedgerRow,
} from '../pickleLedger';

const row = (over: Partial<PickleLedgerRow>): PickleLedgerRow => ({
  id: 1,
  delta: 50,
  balance_after: 1050,
  reason: 'Match win vs Sam',
  kind: 'earn',
  category: 'match',
  is_bonus: false,
  created_at: '2026-10-24T17:30:00.123456+00:00',
  local_day: '2026-10-24',
  meta: null,
  ...over,
});

beforeEach(() => {
  h.calls.length = 0;
  h.answer = () => [];
  h.fail = null;
});

describe('toPickleEntry', () => {
  it('maps a match win to an earned entry, the server time string kept as is', () => {
    expect(toPickleEntry(row({}))).toEqual({
      id: '1',
      amount: 50,
      label: 'Match win vs Sam',
      at: '2026-10-24T17:30:00.123456+00:00',
      bonus: false,
      kind: 'earned',
    });
  });

  it('a gold row (is_bonus) is a bonus entry', () => {
    const e = toPickleEntry(row({ kind: 'bonus', is_bonus: true, reason: 'Daily login reward', delta: 25 }));
    expect(e).toMatchObject({ kind: 'bonus', bonus: true, amount: 25 });
    expect(pointsKindOf(e)).toBe('bonus');
  });

  it('a Shop purchase is spent', () => {
    const e = toPickleEntry(row({ kind: 'spend', delta: -300, reason: 'Shop: Neon paddle', category: 'shop' }));
    expect(e).toMatchObject({ kind: 'spent', amount: -300 });
    expect(pointsKindOf(e)).toBe('spent');
  });

  it.each([
    ['start', 1000, 'Starting balance'],
    ['refund', 100, 'Tournament refund'],
    ['adjust', -20, 'Pickles adjusted'],
    ['reversal', -150, 'Match deleted'],
    ['reversal', 150, 'Match restored'],
  ])('%s (%i) is neutral: listed, counted nowhere', (kind, delta, reason) => {
    const e = toPickleEntry(row({ kind, delta, reason, is_bonus: true }));
    expect(e.kind).toBe('neutral');
    expect(e.bonus).toBe(false); // never gold
    expect(pointsKindOf(e)).toBe('neutral');
    expect(summarizePointsDay([e])).toEqual({ earned: 0, bonus: 0, spent: 0, net: 0, count: 1 });
  });

  it('an unknown kind (a newer server) falls back to the sign', () => {
    const gain = toPickleEntry(row({ kind: 'season_bonus', delta: 40 }));
    const loss = toPickleEntry(row({ kind: 'season_bonus', delta: -40 }));
    expect(gain.kind).toBeUndefined();
    expect(pointsKindOf(gain)).toBe('earned');
    expect(pointsKindOf(loss)).toBe('spent');
    expect(pickleKindOf(null)).toBeUndefined();
  });

  it('a missing reason gets a plain label', () => {
    expect(toPickleEntry(row({ reason: null })).label).toBe('Pickles added');
    expect(toPickleEntry(row({ reason: '  ', delta: -5, kind: 'spend' })).label).toBe('Pickles spent');
  });

  it('a day sums like my_pickle_today (spend only in spent, start left out)', () => {
    const entries = [
      row({ id: 5, kind: 'earn', delta: 100 }),
      row({ id: 4, kind: 'bonus', is_bonus: true, delta: 25 }),
      row({ id: 3, kind: 'spend', delta: -300 }),
      row({ id: 2, kind: 'reversal', delta: -150 }),
      row({ id: 1, kind: 'start', delta: 1000 }),
    ].map(toPickleEntry);
    expect(summarizePointsDay(entries)).toEqual({ earned: 100, bonus: 25, spent: 300, net: -175, count: 5 });
  });
});

describe('listPickleLedgerPage', () => {
  it('first page: no cursor', async () => {
    h.answer = () => [row({ id: 9 })];
    const out = await listPickleLedgerPage({ limit: 50, offset: 0, before: null, beforeId: null });
    expect(h.calls).toEqual([{ fn: 'list_pickle_ledger', args: { p_limit: 50, p_before: null, p_before_id: null } }]);
    expect(out.map((e) => e.id)).toEqual(['9']);
  });

  it('next page: the oldest row\'s exact created_at and numeric id (keyset)', async () => {
    const loaded = [row({ id: 12, created_at: '2026-10-24T17:30:00.5+00:00' }), row({ id: 11, created_at: '2026-10-24T17:30:00.123456+00:00' })].map(toPickleEntry);
    const req = nextPointsPageRequest(loaded, 50);
    await listPickleLedgerPage(req);
    expect(h.calls[0].args).toEqual({ p_limit: 50, p_before: '2026-10-24T17:30:00.123456+00:00', p_before_id: 11 });
  });

  it('clamps the page size to the server\'s 1..100', async () => {
    await listPickleLedgerPage({ limit: 500, offset: 0, before: null, beforeId: null });
    expect(h.calls[0].args?.p_limit).toBe(100);
  });

  it('a non-array answer is an empty page', async () => {
    h.answer = () => null;
    expect(await listPickleLedgerPage({ limit: 20, offset: 0, before: null, beforeId: null })).toEqual([]);
  });
});

describe('the calendar range', () => {
  it('a month is one call', async () => {
    h.answer = () => [row({ id: 2 }), row({ id: 1 })];
    const out = await listPickleLedgerRange('2026-10-01T04:00:00.000Z', '2026-11-01T04:00:00.000Z');
    expect(h.calls).toEqual([
      { fn: 'list_pickle_ledger_range', args: { p_from: '2026-10-01T04:00:00.000Z', p_to: '2026-11-01T04:00:00.000Z' } },
    ]);
    expect(out.map((e) => e.id)).toEqual(['2', '1']);
  });

  it('a span over 62 days is split, newest span first', async () => {
    h.answer = (_fn, args) => [row({ id: String(args?.p_from) })];
    const out = await listPickleLedgerRange('2026-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
    expect(h.calls.map((c) => c.args)).toEqual([
      { p_from: '2026-03-04T00:00:00.000Z', p_to: '2026-04-01T00:00:00.000Z' },
      { p_from: '2026-01-01T00:00:00.000Z', p_to: '2026-03-04T00:00:00.000Z' },
    ]);
    expect(out.map((e) => e.id)).toEqual(['2026-03-04T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
  });

  it('every chunk fits the server\'s limit; an empty or inverted range asks nothing', () => {
    const chunks = pickleRangeChunks('2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z');
    for (const [a, b] of chunks) expect(Date.parse(b) - Date.parse(a)).toBeLessThanOrEqual(62 * 86_400_000);
    expect(chunks[0][0]).toBe('2026-01-01T00:00:00.000Z');
    expect(chunks[chunks.length - 1][1]).toBe('2026-12-31T00:00:00.000Z');
    expect(pickleRangeChunks('2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('refusals', () => {
  it('a server refusal (pl: hint) passes as is: its message already says what to do', async () => {
    const refusal = { code: 'P0001', hint: 'pl:request.bad', message: "Couldn't load your pickle history because …" };
    h.fail = refusal;
    await expect(listPickleLedgerRange('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')).rejects.toBe(refusal);
  });

  it('an old-wording refusal gets the app\'s copy', () => {
    const e = pickleLedgerError({ message: 'Not authenticated' }) as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("You're signed out. Sign in to Pickleague and try again.");
  });

  it('anything else is untouched, for the kit to classify (no signal, a missing function)', () => {
    const missing = { code: 'PGRST202', message: 'Could not find the function public.list_pickle_ledger' };
    expect(pickleLedgerError(missing)).toBe(missing);
  });
});

describe('my_pickle_today and the play streak meter', () => {
  const raw = {
    tz: 'America/Chicago', day: '2026-10-24', cap: 200, played_today: true, streak_days: 2,
    streak_today: 100, next_streak: 150, earned_today: 250, bonus_today: 25, spent_today: 0, net_today: 275,
  };

  it('parses the object, defaulting what is missing', () => {
    expect(parsePickleToday(raw)).toEqual(raw);
    expect(parsePickleToday({})).toMatchObject({ cap: 200, played_today: false, streak_today: 0 });
    expect(parsePickleToday(null)).toBeNull();
  });

  it('the meter reads the streak grant, not the day\'s earned total', () => {
    const today = parsePickleToday(raw)!;
    // A match win today is earned but not capped: it must not fill the meter.
    const entries = [toPickleEntry(row({ delta: 150, created_at: new Date().toISOString() }))];
    const p = pointsCapProgress(entries, { cap: today.cap, earnedToday: today.streak_today });
    expect(p).toMatchObject({ earned: 100, cap: 200, complete: true, reached: false });
  });

  it('captions: played today, a streak to keep, a streak to start', () => {
    const t = parsePickleToday(raw)!;
    expect(playStreakCaption(t)).toBe(
      "Day 2 of your play streak is in. Play tomorrow for 150 more. Other pickles don't count toward it.",
    );
    expect(playStreakCaption({ ...t, played_today: false, streak_days: 3, next_streak: 200 })).toBe(
      'Play a match today to keep your 3-day streak and earn 200.',
    );
    expect(playStreakCaption({ ...t, played_today: false, streak_days: 0, next_streak: 50 })).toBe(
      'Play a match today to start a play streak and earn 50.',
    );
    expect(playStreakCaption(null)).toBeNull();
  });
});
