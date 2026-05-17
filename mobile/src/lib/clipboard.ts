// Cross-platform clipboard wrapper.
// On native: uses expo-clipboard's setStringAsync.
// On web: uses navigator.clipboard.writeText, falling back to a
// document.execCommand('copy') hack for older browsers that lack the async API.
import { Platform } from 'react-native';

async function setClipboardWeb(text: string): Promise<void> {
  // Modern path: async Clipboard API. Requires a secure context (HTTPS / localhost).
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      throw new Error(
        `Couldn't copy to clipboard: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Legacy fallback for older browsers (or non-secure contexts).
  if (typeof document === 'undefined') {
    throw new Error("Couldn't copy to clipboard: no document available.");
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!ok) throw new Error('execCommand returned false');
  } catch (err) {
    throw new Error(
      `Couldn't copy to clipboard: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Cached on first native use so we don't hit the module cache on every copy.
// Stays unresolved on web so the native module never enters the web bundle.
let nativeClipboard: typeof import('expo-clipboard') | null = null;

export async function setClipboard(text: string): Promise<void> {
  if (Platform.OS === 'web') {
    await setClipboardWeb(text);
    return;
  }
  if (!nativeClipboard) nativeClipboard = require('expo-clipboard');
  await nativeClipboard!.setStringAsync(text);
}
