import { Platform } from 'react-native';
import { setClipboard } from './clipboard';

/**
 * Cross-platform "send invite via text" helper.
 *
 * Unlike {@link shareInvite} (which opens the generic OS share sheet), this
 * deep-links straight into the SMS composer with the message pre-filled, so
 * inviting someone is one tap shorter. The text is sent from the *user's own*
 * number — there is no backend / Twilio / per-message cost involved.
 *
 * - Native: uses `expo-sms` to open the Messages composer pre-filled with
 *   `message`. The user picks the recipient(s) and taps send. If `recipients`
 *   is supplied they are pre-populated in the To field.
 * - Web (mobile browser): navigates to an `sms:` URI, which opens the default
 *   messaging app with the body pre-filled.
 * - Web (desktop / no SMS handler / native module unavailable): falls back to
 *   copying `message` to the clipboard so the caller can show a banner.
 *
 * Return shape:
 *   { sent: true,  copied: false } — composer opened (native or web).
 *   { sent: false, copied: true  } — clipboard fallback succeeded.
 *   { sent: false, copied: false } — everything failed / cancelled.
 */
export async function sendSmsInvite(input: {
  message: string;
  recipients?: string[];
}): Promise<{ sent: boolean; copied: boolean }> {
  const { message, recipients = [] } = input;

  if (Platform.OS !== 'web') {
    try {
      // Loaded lazily so the native module never enters the web bundle.
      const SMS = require('expo-sms') as typeof import('expo-sms');
      if (await SMS.isAvailableAsync()) {
        // `result` is 'sent' | 'cancelled' | 'unknown' — on Android the OS
        // can't tell us the real outcome, so we optimistically treat a
        // returned composer as "sent" rather than blocking the UX.
        await SMS.sendSMSAsync(recipients, message);
        return { sent: true, copied: false };
      }
    } catch {
      // No SMS hardware (e.g. tablet/simulator) — fall through to clipboard.
    }
    return copyFallback(message);
  }

  // Web: try to open the default messaging app via the sms: scheme.
  // `?&body=` is the most broadly-compatible form across iOS/Android browsers.
  if (typeof window !== 'undefined' && window.location) {
    try {
      const to = recipients.join(',');
      window.location.href = `sms:${to}?&body=${encodeURIComponent(message)}`;
      return { sent: true, copied: false };
    } catch {
      // Desktop browsers with no sms: handler land here — fall through.
    }
  }

  return copyFallback(message);
}

async function copyFallback(
  message: string,
): Promise<{ sent: boolean; copied: boolean }> {
  try {
    await setClipboard(message);
    return { sent: false, copied: true };
  } catch {
    return { sent: false, copied: false };
  }
}
