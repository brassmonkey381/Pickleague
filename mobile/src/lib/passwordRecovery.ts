// Password reset (PKL-031). "Forgot password?" on Sign In sends Supabase's
// recovery email; its link signs the player in with type=recovery (the web
// reads it itself and fires PASSWORD_RECOVERY; the app's AuthLinkHandler sets
// the session). Before this, that was all: the player was signed in and never
// asked for a new password. Now a recovery sign-in raises this flag and
// NewPasswordHost asks for one.
//
// PURE (no React Native), so vitest reads it.
import type { AuthLinkResult } from './authLink';

export const MIN_PASSWORD_LENGTH = 6;

export function isRecoveryLink(r: AuthLinkResult | null): boolean {
  return !!r && r.kind === 'session' && r.type === 'recovery';
}

/** What's wrong with a new password, or null when it can be saved. */
export function newPasswordProblem(pw: string): string | null {
  if (pw.length === 0) return 'Enter a new password.';
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  return null;
}

/** What the reset dialog says once the email is on its way. Never says whether the account exists. */
export function resetSentMessage(email: string): string {
  return `If ${email.trim()} has a Pickleague account, a reset link is on its way. Open it on this device or in the app to choose a new password.`;
}

let pending = false;
const listeners = new Set<() => void>();

export function setRecoveryPending(v: boolean): void {
  if (pending === v) return;
  pending = v;
  listeners.forEach((l) => l());
}

export function getRecoveryPending(): boolean {
  return pending;
}

export function subscribeRecoveryPending(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
