import { describe, expect, it } from 'vitest';
import { authLinkNotice, getAuthLinkNotice, parseAuthLink, setAuthLinkNotice, subscribeAuthLinkNotice } from '../authLink';

describe('the link in an auth email', () => {
  it('a confirmed link carries the session in the hash', () => {
    expect(parseAuthLink('https://pickleague.club/#access_token=a.b.c&expires_in=3600&refresh_token=r1&token_type=bearer&type=signup')).toEqual({
      kind: 'session', accessToken: 'a.b.c', refreshToken: 'r1', type: 'signup',
    });
  });
  it('a used or old link carries an error', () => {
    const r = parseAuthLink('https://pickleague.club/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(r).toEqual({ kind: 'error', code: 'otp_expired', description: 'Email link is invalid or has expired' });
    expect(authLinkNotice(r!)).toMatch(/already used or is too old/);
  });
  it('an error in the query string counts too', () => {
    expect(parseAuthLink('pickleague://login?error=server_error&error_description=x')?.kind).toBe('error');
  });
  it('an ordinary link is not an auth link', () => {
    expect(parseAuthLink('https://pickleague.club/leagues/l1')).toBeNull();
    expect(parseAuthLink('https://pickleague.club/#section')).toBeNull();
    expect(parseAuthLink(null)).toBeNull();
  });
  it('Sign In hears about a notice set before it mounts', () => {
    let calls = 0;
    const off = subscribeAuthLinkNotice(() => { calls++; });
    setAuthLinkNotice('hi');
    expect(getAuthLinkNotice()).toBe('hi');
    setAuthLinkNotice(null);
    off();
    setAuthLinkNotice('later');
    expect(calls).toBe(2);
    setAuthLinkNotice(null);
  });
});
