// The "Check your email" step after sign-up (PKL-020). Supabase won't sign an
// account in until its email is confirmed (password sign-in answers
// email_not_confirmed), so instead of bouncing the player to Sign In we hold
// them on one screen that says where the link went, lets them resend it (with a
// cooldown) or fix the address, and opens Sign In with the email filled in.
//
// PURE (no React Native), so vitest reads it.

/** Seconds before Resend works again. Supabase also rate-limits signup mail per address. */
export const RESEND_COOLDOWN_S = 60;

/** Seconds left on the cooldown at `nowMs`, 0 when Resend is ready. */
export function resendWaitS(lastSentMs: number | null, nowMs: number): number {
  if (lastSentMs == null) return 0;
  const left = Math.ceil((lastSentMs + RESEND_COOLDOWN_S * 1000 - nowMs) / 1000);
  return left > 0 ? left : 0;
}

/** Supabase's answer for a password sign-in to an account whose email isn't confirmed yet. */
export function isEmailNotConfirmed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === 'email_not_confirmed') return true;
  return typeof e.message === 'string' && /email not confirmed/i.test(e.message);
}

/** The iOS Mail app's inbox. Android and the web have no one inbox to open, so no button there. */
export function mailAppUrl(os: string): string | null {
  return os === 'ios' ? 'message://' : null;
}

/**
 * Sign-up to an address that already has a confirmed account: Supabase answers
 * with no error and a stand-in user whose `identities` is empty, and sends no
 * email (so nobody can probe which addresses exist). Without this check the
 * player waits on Check your email for a code that never comes.
 */
export function isExistingAccount(user: unknown): boolean {
  if (!user || typeof user !== 'object') return false;
  const ids = (user as { identities?: unknown }).identities;
  return Array.isArray(ids) && ids.length === 0;
}

export function existingAccountMessage(email: string): string {
  return `${email} already has an account. Sign in instead. If you forgot the password, you can reset it there.`;
}

// ── copy ────────────────────────────────────────────────────────────────────

export const CHECK_EMAIL_TITLE = 'Check your email';

export function checkEmailBody(email: string): string {
  return `We sent a code to ${email}. Type it below to finish signing up.`;
}

export function referralLine(pickles: number): string {
  return `Once you're in, you and your friend each get ${pickles} pickles.`;
}

/** Under the buttons: the two things that go wrong. */
export const CHECK_EMAIL_HELP = "Nothing there? Check spam. If the address above is wrong, fix it: a new code only goes to the same address.";

export function resendLabel(waitS: number, sending: boolean): string {
  if (sending) return 'Sending...';
  return waitS > 0 ? `New code in ${waitS}s` : 'Send a new code';
}

export function resentMessage(email: string): string {
  return `Sent again to ${email}.`;
}

/** Sign In, when the account exists but its email isn't confirmed yet. */
export function notConfirmedMessage(email: string): string {
  return `Your email isn't confirmed yet. We sent a code to ${email}: open Check your email to type it or get a new one.`;
}

// ── the code in the email (Triage pick A, 2026-11-10) ──────────────────────────
// The "Confirm signup" email carries a code ({{ .Token }}, supabase/templates/
// confirm-signup.html). Typing it here signs the player in on this screen:
// verifyOtp({ type: 'email' }) confirms the address and starts the session.

/** Supabase's email codes are 6 digits by default; the project may set up to 10. */
export const CODE_MIN = 6;
export const CODE_MAX = 10;

/** Digits only, at most CODE_MAX (a pasted "123 456" or "Code: 123456" still works). */
export function cleanCode(s: string): string {
  return s.replace(/\D+/g, '').slice(0, CODE_MAX);
}

export function codeReady(code: string): boolean {
  return code.length >= CODE_MIN;
}

/** An expired or wrong code reads the same to Supabase (otp_expired). */
export function codeErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === 'otp_expired' || (typeof e.message === 'string' && /expired|invalid/i.test(e.message))) {
    return "That code didn't work: it's wrong or too old. Check it, or resend for a new one.";
  }
  return null;
}

export const CODE_LABEL = 'Code from the email';
