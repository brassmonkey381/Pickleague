import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Listen for the Escape key on web and call `onEscape` when pressed.
 * No-op on native. Pass `enabled: false` (typically tied to a modal's `visible`
 * state) to suspend the listener without unmounting.
 */
export function useEscapeKey(onEscape: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onEscape]);
}
