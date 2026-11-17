// Shows the refusals the player wasn't looking at (lib/refusalNotices): an
// offline-queued check-in, check-out, Start or End the server refused when it
// was finally sent, or a sign-out that couldn't close a check-in. Rule 11:
// never silent, so each one stays on screen until the player taps OK (a 4 s
// toast can't carry 30 to 50 words), one at a time, oldest first, and is
// marked seen only then. Checked on mount, on every return to the
// foreground, and the moment one is stored while the app is open.
//
// A sticky notice in the kit's notice stack (kit 1.128: the one top slot,
// below the safe area and any top banner), not a Modal: it never fights the
// end sheet or the start sheet for the screen (iOS presents one Modal at a
// time). Inside a Modal it shows above the sheet through the kit's outlet.
//
// Mounted once at the app root (navigation/AppNavigator) after the splash, so
// it never opens behind it; signed in or not, so a sign-out notice still
// shows on the sign-in screen.
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { useToast } from '@just-messin-around/expo-foundation/toast';
import {
  markRefusalNoticeShown,
  peekRefusalNotices,
  refusalNoticed,
} from '../lib/refusalNotices';

export default function RefusalNoticeHost() {
  const toast = useToast();
  // The notice on screen (its key and time), so a reload doesn't show it twice.
  const showing = useRef<string | null>(null);

  const load = useCallback(() => {
    void peekRefusalNotices().then((list) => {
      const n = list[0];
      if (!n) return;
      const id = `${n.key}@${n.atMs}`;
      if (showing.current === id) return;
      showing.current = id;
      toast.show({
        kind: 'notice',
        title: n.title,
        text: n.body,
        sticky: true,
        onDismiss: () => {
          void markRefusalNoticeShown(n.key, n.atMs).then(() => {
            showing.current = null;
            load();
          });
        },
      });
    });
  }, [toast]);

  useEffect(() => {
    load();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') load();
    });
    return () => sub.remove();
  }, [load]);
  useSignal(refusalNoticed, load);

  return null;
}
