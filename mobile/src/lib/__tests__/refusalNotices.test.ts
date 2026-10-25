import { describe, it, expect, vi, beforeEach } from 'vitest';

// explainRefusal and the notice store, with React Native, storage and the kit
// stubbed: a known refusal gets its own words, anything else falls back to
// the kit's friendly text (with the app's no-connection line), and a refusal
// the player wasn't looking at is kept until shown (or posted at once when
// the app is in the background).
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  appState: 'active' as string,
  posted: [] as { title: string; body: string }[],
  friendly: [] as { fallback?: string; overrides?: Record<string, string> }[],
  granted: true as boolean | 'throws',
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return h.appState;
    },
  },
  Platform: { OS: 'ios' },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      h.store.set(k, v);
    },
    removeItem: async (k: string) => {
      h.store.delete(k);
    },
  },
}));
vi.mock('@just-messin-around/expo-foundation/hooks', () => ({
  createSignal: () => {
    const subs = new Set<() => void>();
    return { emit: () => subs.forEach((f) => f()), subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)) };
  },
}));
vi.mock('@just-messin-around/expo-foundation/platform', () => ({
  isNetworkError: (e: unknown) => /failed to fetch|timed out/i.test(String((e as Error)?.message ?? '')),
}));
vi.mock('@just-messin-around/expo-foundation/platform/push', () => ({
  postLocalNotice: async (title: string, body: string) => {
    h.posted.push({ title, body });
  },
}));
vi.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => {
    if (h.granted === 'throws') throw new Error('no module');
    return { granted: h.granted, status: h.granted ? 'granted' : 'denied' };
  },
}));
vi.mock('@just-messin-around/expo-foundation/supabase', () => {
  // The kit's classifySbError for the shapes these tests send (expo-foundation src/supabase/errors.ts).
  const classifySbError = (e: { code?: string; message?: string } | null) => {
    if (!e) return 'unknown';
    if (/failed to fetch|timed out/i.test(String(e.message ?? ''))) return 'network';
    if (e.code === 'PGRST301') return 'auth';
    if (e.code === '42501') return 'permission';
    if (e.code === 'PGRST202') return 'missingFunction';
    if (e.code === '23505') return 'conflict';
    if (/^XX/.test(e.code ?? '')) return 'server';
    return 'unknown';
  };
  return {
    classifySbError,
    friendlySbMessage: (e: { code?: string; message?: string } | null, fallback?: string, overrides?: Record<string, string>) => {
      h.friendly.push({ fallback, overrides });
      const kind = classifySbError(e);
      if (overrides?.[kind]) return overrides[kind];
      if (kind === 'auth') return 'Please sign in again.';
      if (kind === 'permission') return "You don't have access to that.";
      // The kit's default: the error's own message (the raw text explainRefusal must not show).
      return e?.message || fallback;
    },
  };
});

import {
  explainRefusal,
  isRetryLater,
  markRefusalNoticeShown,
  noteRefusalNotice,
  peekRefusalNotices,
} from '../refusalNotices';

beforeEach(() => {
  h.store.clear();
  h.appState = 'active';
  h.posted.length = 0;
  h.friendly.length = 0;
  h.granted = true;
});

/** What the host does: show the oldest, then OK. */
async function dismissAll(): Promise<string[]> {
  const seen: string[] = [];
  for (let n = (await peekRefusalNotices())[0]; n; n = (await peekRefusalNotices())[0]) {
    seen.push(n.body);
    await markRefusalNoticeShown(n.key, n.atMs);
  }
  return seen;
}

describe('explainRefusal', () => {
  it('a known refusal: its own words, with the context', () => {
    expect(
      explainRefusal({ message: 'x', hint: 'pl:fix.not_at_court', details: '{"distance_m": 90}' }, 'Fallback.', { venueName: 'Lakeside' }),
    ).toBe("You're about 90 m from Lakeside. You need to be at the court to check in, so try again when you get there.");
    expect(h.friendly).toHaveLength(0);
  });

  it("no signal: the app's no-connection line (no em dash), or the caller's own", () => {
    expect(explainRefusal(new Error('Failed to fetch'), "Couldn't check you in. Try again.")).toBe(
      'No connection. Check your signal and try again.',
    );
    expect(explainRefusal(new Error('Request timed out'), 'F.', {}, { network: 'Lost the connection.' })).toBe('Lost the connection.');
  });

  it("signed out or not allowed: the kit's fixed plain copy", () => {
    expect(explainRefusal({ code: 'PGRST301', message: 'JWT expired' }, 'F.')).toBe('Please sign in again.');
    expect(explainRefusal({ code: '42501', message: 'new row violates row-level security policy for table "x"' }, 'F.')).toBe(
      "You don't have access to that.",
    );
  });

  it("a function the server doesn't have yet (PGRST202): the caller's fallback, never the schema-cache text", () => {
    const missing = {
      code: 'PGRST202',
      message: 'Could not find the function public.plan_court_checkin(p_at, p_venue) in the schema cache',
      details: 'Searched for the function public.plan_court_checkin with parameters p_at, p_venue',
      hint: 'Perhaps you meant to call the function public.plan_court_routine',
    };
    const out = explainRefusal(missing, "Couldn't plan your check-in. Try again.", { venueName: 'Lakeside', action: 'plan_checkin' });
    expect(out).toBe("Couldn't plan your check-in. Try again.");
    expect(out).not.toMatch(/schema cache|function/);
  });

  it("any other server or runtime error: the caller's fallback, not its raw message", () => {
    const fb = "Couldn't check you in. Try again.";
    expect(explainRefusal({ message: 'boom', code: 'XX000' }, fb)).toBe(fb);
    expect(explainRefusal({ code: '23505', message: 'duplicate key value violates unique constraint "x_pkey"' }, fb)).toBe(fb);
    expect(explainRefusal({ code: '22P02', message: 'invalid input syntax for type uuid: "x"' }, fb)).toBe(fb);
    expect(explainRefusal(new TypeError("Cannot read properties of undefined (reading 'id')"), fb)).toBe(fb);
    // An older server's P0001 without a pl: code isn't known copy either.
    expect(explainRefusal({ code: 'P0001', message: 'Not authorized' }, fb)).toBe(fb);
    expect(explainRefusal(null, fb)).toBe(fb);
    expect(explainRefusal('a string', fb)).toBe(fb);
  });

  it("a pl:* refusal this build has no code for yet (a newer server): the server's words, written for people", () => {
    expect(
      explainRefusal({ code: 'P0001', message: 'Courts close at 10 PM. Plan an earlier time.', hint: 'pl:court.closed_late' }, 'F.'),
    ).toBe('Courts close at 10 PM. Plan an earlier time.');
    // A pl: hint with no message: nothing to show, so the fallback.
    expect(explainRefusal({ code: 'P0001', message: '', hint: 'pl:court.closed_late' }, 'F.')).toBe('F.');
  });
});

describe('isRetryLater: a queued write waits instead of being dropped', () => {
  it('no signal, an expired session, or signed out', () => {
    expect(isRetryLater(new Error('Failed to fetch'))).toBe(true);
    expect(isRetryLater({ code: 'PGRST301', message: 'JWT expired' })).toBe(true);
    expect(isRetryLater({ message: 'Not authenticated' })).toBe(true);
    expect(isRetryLater({ message: 'x', hint: 'pl:auth.signed_out' })).toBe(true);
  });

  it('a real refusal is not retried', () => {
    expect(isRetryLater({ message: 'x', hint: 'pl:fix.stale' })).toBe(false);
    expect(isRetryLater({ message: 'Court not found' })).toBe(false);
  });
});

describe('refusal notices (never dropped silently)', () => {
  it('kept until the player dismisses it, once, oldest first', async () => {
    await noteRefusalNotice({ key: 'a', title: 'T', body: 'First.' });
    await noteRefusalNotice({ key: 'b', title: 'T', body: 'Second.' });
    await noteRefusalNotice({ key: 'a', title: 'T', body: 'First again.' }); // same write: one notice
    expect(await dismissAll()).toEqual(['Second.', 'First again.']);
    expect(await peekRefusalNotices()).toEqual([]);
  });

  it('looking is not seeing: a notice stays until it is dismissed (the app closed with it on screen)', async () => {
    await noteRefusalNotice({ key: 'a', title: 'T', body: 'First.' });
    expect((await peekRefusalNotices()).map((n) => n.body)).toEqual(['First.']);
    expect((await peekRefusalNotices()).map((n) => n.body)).toEqual(['First.']);
  });

  it('dismissing an older copy keeps a newer one stored under the same key since', async () => {
    await noteRefusalNotice({ key: 'a', title: 'T', body: 'Old.' });
    const [old] = await peekRefusalNotices();
    // Stored as the same key a moment later, while "Old." was still on screen.
    const later = h.store.get('pickleague_refusal_notices_v1')!;
    h.store.set(
      'pickleague_refusal_notices_v1',
      JSON.stringify(JSON.parse(later).map((n: { atMs: number }) => ({ ...n, body: 'New.', atMs: n.atMs + 5 }))),
    );
    await markRefusalNoticeShown(old.key, old.atMs);
    expect((await peekRefusalNotices()).map((n) => n.body)).toEqual(['New.']);
  });

  it('in the background with notifications allowed it goes out at once (and is not shown in the app again)', async () => {
    h.appState = 'background';
    await noteRefusalNotice({ key: 'c', title: 'Check-out didn\'t go through', body: 'Why. What to do.' });
    expect(h.posted).toEqual([{ title: "Check-out didn't go through", body: 'Why. What to do.' }]);
    h.appState = 'active';
    expect(await peekRefusalNotices()).toEqual([]);
  });

  it('in the background without notification permission it waits for the app (the OS would drop it)', async () => {
    h.appState = 'background';
    h.granted = false;
    await noteRefusalNotice({ key: 'd', title: 'Play session not saved', body: 'Why. What to do.' });
    expect(h.posted).toEqual([]);
    h.appState = 'active';
    expect((await peekRefusalNotices()).map((n) => n.body)).toEqual(['Why. What to do.']);
  });

  it('...and when the permission read fails, the same', async () => {
    h.appState = 'background';
    h.granted = 'throws';
    await noteRefusalNotice({ key: 'e', title: 'T', body: 'Waits.' });
    expect(h.posted).toEqual([]);
    expect((await peekRefusalNotices()).map((n) => n.body)).toEqual(['Waits.']);
  });
});
