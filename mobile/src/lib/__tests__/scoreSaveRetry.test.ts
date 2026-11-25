import { describe, expect, it, vi } from 'vitest';
// The supabase barrel pulls in react-native; the classifier itself is plain TS.
vi.mock('@just-messin-around/expo-foundation/supabase', async () => ({
  classifySbError: (await import('../../../node_modules/@just-messin-around/expo-foundation/src/supabase/errors')).classifySbError,
}));
import { classifySbError } from '../../../node_modules/@just-messin-around/expo-foundation/src/supabase/errors';
import { isStatementTimeout, scoreSaveRetryOn } from '../scoreSaveRetry';

const timeout = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const denied = { code: '42501', message: 'permission denied for table tournament_matches', details: null, hint: null };

/** The loop sbCall runs: up to 3 retries, never on auth, else whatever retryOn says. */
async function saveLike(results: Array<object | null>, retryOn: (e: unknown) => boolean) {
  let calls = 0;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const err = results[Math.min(calls, results.length - 1)];
    calls += 1;
    if (!err) return { saved: true, calls };
    if (attempt === 3 || !(classifySbError(err) !== 'auth' && retryOn(err))) return { saved: false, calls, err };
  }
  return { saved: false, calls };
}

describe('PKL-075 score save retry', () => {
  it('spots a statement timeout by code or message', () => {
    expect(isStatementTimeout(timeout)).toBe(true);
    expect(isStatementTimeout({ message: 'canceling statement due to statement timeout' })).toBe(true);
    expect(isStatementTimeout(denied)).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
  });

  it('one timeout then success: saved on the second try', async () => {
    expect(await saveLike([timeout, null], scoreSaveRetryOn())).toEqual({ saved: true, calls: 2 });
  });

  it('two timeouts: the error surfaces after 2 tries, not 4', async () => {
    const r = await saveLike([timeout, timeout, timeout, timeout], scoreSaveRetryOn());
    expect(r.saved).toBe(false);
    expect(r.calls).toBe(2);
  });

  it('a server refusal is never retried', async () => {
    expect((await saveLike([denied, null], scoreSaveRetryOn())).calls).toBe(1);
  });

  it('network errors keep their retries', async () => {
    const net = new TypeError('Network request failed');
    expect(await saveLike([net, net, null], scoreSaveRetryOn())).toEqual({ saved: true, calls: 3 });
  });

  it('each save gets its own single retry', () => {
    scoreSaveRetryOn()(timeout);
    expect(scoreSaveRetryOn()(timeout)).toBe(true);
  });
});
