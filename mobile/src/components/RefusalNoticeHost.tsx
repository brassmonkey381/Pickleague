// Shows the refusals the player wasn't looking at (lib/refusalNotices): an
// offline-queued check-in, check-out, Start or End the server refused when it
// was finally sent, or a sign-out that couldn't close a check-in. Each one is
// a toast the next time the app is open (on mount, on every return to the
// foreground, and the moment one is stored while the app is open). Renders
// nothing. Mounted once at the app root (navigation/AppNavigator), signed in
// or not, so a sign-out notice still shows on the sign-in screen.
import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { useToast } from '../lib/useToast';
import { refusalNoticed, takeRefusalNotices } from '../lib/refusalNotices';

export default function RefusalNoticeHost() {
  const toast = useToast();
  const show = useCallback(() => {
    void takeRefusalNotices().then((list) => {
      // The body says it all (the title is for the lock-screen notification).
      for (const n of list) toast.error(n.body);
    });
  }, [toast]);

  useEffect(() => {
    show();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') show();
    });
    return () => sub.remove();
  }, [show]);
  useSignal(refusalNoticed, show);
  return null;
}
