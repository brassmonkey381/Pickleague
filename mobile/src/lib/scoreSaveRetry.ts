/**
 * PKL-075: when to retry a tournament score save.
 *
 * The save is one UPDATE keyed by the match id, so repeating it is safe:
 *   - a statement the server cancelled (57014, statement timeout) rolled back, so the second try saves it once;
 *   - if a "failed" try did commit, the retry writes the same values and the completion trigger does not run again.
 *
 * Network errors keep the foundation's default retries. A statement timeout is retried once only: a database
 * stall can last seconds, and more tries would just hold the Save spinner.
 */
import { classifySbError } from '@just-messin-around/expo-foundation/supabase';

export const STATEMENT_TIMEOUT = '57014';

export function isStatementTimeout(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  if (code === STATEMENT_TIMEOUT) return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && /canceling statement due to statement timeout/i.test(message);
}

/** A fresh predicate per save: network errors retry, a statement timeout retries once. */
export function scoreSaveRetryOn(): (e: unknown) => boolean {
  let timeoutsLeft = 1;
  return (e: unknown) => {
    if (isStatementTimeout(e)) {
      if (timeoutsLeft <= 0) return false;
      timeoutsLeft -= 1;
      return true;
    }
    return classifySbError(e) === 'network';
  };
}

/** Total budget for the save, retries included: two 8 s server limits plus backoff and round trips. */
export const SCORE_SAVE_TIMEOUT_MS = 25_000;
