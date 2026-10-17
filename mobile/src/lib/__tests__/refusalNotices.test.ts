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
vi.mock('@just-messin-around/expo-foundation/supabase', () => ({
  classifySbError: (e: { code?: string } | null) => (e?.code === 'PGRST301' ? 'auth' : 'unknown'),
  friendlySbMessage: (_e: unknown, fallback?: string, overrides?: Record<string, string>) => {
    h.friendly.push({ fallback, overrides });
    return `kit:${fallback}`;
  },
}));

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

  it('anything else: the kit text with the caller\'s fallback and the app\'s no-connection line (no em dash)', () => {
    expect(explainRefusal({ message: 'boom', code: 'XX000' }, "Couldn't check you in. Try again.")).toBe(
      "kit:Couldn't check you in. Try again.",
    );
    expect(h.friendly[0].overrides?.network).toBe('No connection. Check your signal and try again.');
    explainRefusal(new Error('Failed to fetch'), 'F.', {}, { network: 'Lost the connection.' });
    expect(h.friendly[1].overrides?.network).toBe('Lost the connection.');
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
