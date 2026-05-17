import { Platform, Share } from 'react-native';

/**
 * Cross-platform share helper.
 *
 * - Native: opens the OS share sheet via `Share.share`.
 * - Web (mobile browser): tries the Web Share API (`navigator.share`) so users
 *   can pick SMS / WhatsApp / etc just like native.
 * - Web (desktop / Web Share unavailable / user-cancelled non-abort error):
 *   falls back to copying `message` to the clipboard so the caller can show a
 *   "Copied to clipboard" banner.
 *
 * Return shape:
 *   { shared: true,  copied: false } — share sheet completed (native or web).
 *   { shared: false, copied: true  } — clipboard fallback succeeded.
 *   { shared: false, copied: false } — user cancelled the Web Share dialog
 *                                      (AbortError) or everything failed.
 */
export async function shareInvite(input: {
  title?: string;
  message: string;
  url?: string;
}): Promise<{ shared: boolean; copied: boolean }> {
  const { title, message, url } = input;

  if (Platform.OS !== 'web') {
    await Share.share({ title, message });
    return { shared: true, copied: false };
  }

  // Web: prefer the Web Share API on mobile browsers.
  const nav: Navigator | undefined =
    typeof navigator !== 'undefined' ? navigator : undefined;

  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ title, text: message, url });
      return { shared: true, copied: false };
    } catch (err: any) {
      // User cancelled the native share sheet — don't fall back to clipboard,
      // they didn't ask for that.
      if (err?.name === 'AbortError') {
        return { shared: false, copied: false };
      }
      // Any other error falls through to the clipboard path.
    }
  }

  // Fallback: copy to clipboard so caller can flash a confirmation banner.
  if (nav?.clipboard?.writeText) {
    try {
      const toCopy = url ? `${message}\n\n${url}` : message;
      await nav.clipboard.writeText(toCopy);
      return { shared: false, copied: true };
    } catch {
      // Clipboard blocked (e.g. insecure context) — give up cleanly.
    }
  }

  return { shared: false, copied: false };
}
