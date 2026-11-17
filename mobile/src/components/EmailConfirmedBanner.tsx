// Detects when a user lands on the web app from a Supabase email confirmation
// link (URL hash contains `type=signup`), clears the hash and says so in the
// kit's notice stack (kit 1.128: one top slot, not its own banner at top 32).
//
// The auth state change is handled separately by AppNavigator's session
// listener; by the time this shows, the user is on the signed-in stack.
// Renders nothing itself; mount it inside the ToastProvider.
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useToast } from '@just-messin-around/expo-foundation/toast';

export default function EmailConfirmedBanner() {
  const toast = useToast();
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const hash = window.location.hash || '';
    // Supabase appends "type=signup" / "type=recovery" / "type=invite" /
    // "type=email_change" to its redirects. This greets signup only.
    if (!hash.includes('type=signup')) return;
    // Clear the hash so a refresh doesn't greet again.
    if (window.history?.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    toast.success('Email confirmed. Welcome to Pickleague.');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on load
  }, []);
  return null;
}
