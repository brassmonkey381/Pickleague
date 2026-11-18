import { describe, expect, it } from 'vitest';
import { shouldReturnTo } from '../returnPath';

describe('shouldReturnTo (TRI-007)', () => {
  it('remembers a signed-out deep link with its query', () => {
    expect(shouldReturnTo('/leagues/abc', '?tab=standings', '', false)).toBe('/leagues/abc?tab=standings');
    expect(shouldReturnTo('/seasons/s1/standings/', '', '', false)).toBe('/seasons/s1/standings');
  });
  it('needs nothing when a session is already stored', () => {
    expect(shouldReturnTo('/leagues/abc', '', '', true)).toBeNull();
  });
  it('skips the root, auth screens and links with their own signed-out flow', () => {
    for (const p of ['/', '/home', '/login', '/register', '/check-email', '/claim', '/g/tok', '/invite/ABC']) {
      expect(shouldReturnTo(p, '', '', false)).toBeNull();
    }
  });
  it('skips auth returns', () => {
    expect(shouldReturnTo('/leagues/abc', '', '#access_token=x&type=signup', false)).toBeNull();
    expect(shouldReturnTo('/leagues/abc', '', '#error=access_denied', false)).toBeNull();
  });
});
