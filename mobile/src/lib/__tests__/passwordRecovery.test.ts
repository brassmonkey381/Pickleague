import { describe, expect, it } from 'vitest';
import { parseAuthLink } from '../authLink';
import {
  getRecoveryPending, isRecoveryLink, newPasswordProblem, resetSentMessage,
  setRecoveryPending, subscribeRecoveryPending,
} from '../passwordRecovery';

describe('isRecoveryLink', () => {
  it('a recovery link signs in and asks for a new password', () => {
    expect(isRecoveryLink(parseAuthLink('https://pickleague.club/#access_token=a&refresh_token=b&type=recovery'))).toBe(true);
  });
  it('a signup link or a failed link does not', () => {
    expect(isRecoveryLink(parseAuthLink('https://pickleague.club/#access_token=a&refresh_token=b&type=signup'))).toBe(false);
    expect(isRecoveryLink(parseAuthLink('https://pickleague.club/#error=access_denied&error_code=otp_expired'))).toBe(false);
    expect(isRecoveryLink(null)).toBe(false);
  });
});

describe('newPasswordProblem', () => {
  it('needs 6 characters, like sign-up', () => {
    expect(newPasswordProblem('')).toBe('Enter a new password.');
    expect(newPasswordProblem('abc')).toBe('Use at least 6 characters.');
    expect(newPasswordProblem('abcdef')).toBeNull();
  });
});

describe('resetSentMessage', () => {
  it('never says whether the account exists', () => {
    expect(resetSentMessage(' sam@x.com ')).toContain('If sam@x.com has a Pickleague account');
  });
});

describe('recovery flag', () => {
  it('notifies once per change', () => {
    let n = 0;
    const off = subscribeRecoveryPending(() => n++);
    setRecoveryPending(true);
    setRecoveryPending(true);
    expect(getRecoveryPending()).toBe(true);
    setRecoveryPending(false);
    off();
    expect(n).toBe(2);
  });
});
