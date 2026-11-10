import { describe, expect, it } from 'vitest';
import {
  checkEmailBody,
  isEmailNotConfirmed,
  mailAppUrl,
  notConfirmedMessage,
  RESEND_COOLDOWN_S,
  resendLabel,
  resendWaitS,
} from '../checkEmail';

describe('resend cooldown', () => {
  const T = 1_000_000;
  it('ready when never sent, counts down after a send, ready again after', () => {
    expect(resendWaitS(null, T)).toBe(0);
    expect(resendWaitS(T, T)).toBe(RESEND_COOLDOWN_S);
    expect(resendWaitS(T, T + 59_500)).toBe(1);
    expect(resendWaitS(T, T + RESEND_COOLDOWN_S * 1000)).toBe(0);
  });
  it('the button says what it will do', () => {
    expect(resendLabel(0, false)).toBe('Resend the link');
    expect(resendLabel(12, false)).toBe('Resend in 12s');
    expect(resendLabel(0, true)).toBe('Sending...');
  });
});

describe('isEmailNotConfirmed', () => {
  it("reads Supabase's code or its message, nothing else", () => {
    expect(isEmailNotConfirmed({ code: 'email_not_confirmed', message: 'x' })).toBe(true);
    expect(isEmailNotConfirmed({ message: 'Email not confirmed' })).toBe(true);
    expect(isEmailNotConfirmed({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(false);
    expect(isEmailNotConfirmed(null)).toBe(false);
  });
});

describe('copy', () => {
  it('names the address (a typo is only visible here), no middle dots', () => {
    expect(checkEmailBody('a@b.co')).toContain('a@b.co');
    expect(notConfirmedMessage('a@b.co')).toContain('a@b.co');
    expect(checkEmailBody('a@b.co')).not.toContain('·');
  });
  it('Open Mail only where there is one inbox to open', () => {
    expect(mailAppUrl('ios')).toBe('message://');
    expect(mailAppUrl('android')).toBeNull();
    expect(mailAppUrl('web')).toBeNull();
  });
});
