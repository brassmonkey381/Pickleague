// Shows the refusals the player wasn't looking at (lib/refusalNotices): an
// offline-queued check-in, check-out, Start or End the server refused when it
// was finally sent, or a sign-out that couldn't close a check-in. Rule 11:
// never silent, so each one stays on screen until the player taps OK (a 4 s
// toast can't carry 30 to 50 words), one at a time, oldest first, and is
// marked seen only then. Checked on mount, on every return to the
// foreground, and the moment one is stored while the app is open.
//
// A card over the top of the screen, like the kit's UpdateReadyBanner (same
// inset and slot), not a Modal: it never fights the end sheet or the start
// sheet for the screen (iOS presents one Modal at a time), and while another
// Modal is up it simply waits underneath until that one closes.
//
// Mounted once at the app root (navigation/AppNavigator) after the splash, so
// it never opens behind it; signed in or not, so a sign-out notice still
// shows on the sign-in screen.
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { TopChromeView } from '@just-messin-around/expo-foundation/navigation';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import {
  markRefusalNoticeShown,
  peekRefusalNotices,
  refusalNoticed,
  type PendingNotice,
} from '../lib/refusalNotices';

export default function RefusalNoticeHost() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [notice, setNotice] = useState<PendingNotice | null>(null);

  const load = useCallback(() => {
    void peekRefusalNotices().then((list) => setNotice(list[0] ?? null));
  }, []);

  useEffect(() => {
    load();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') load();
    });
    return () => sub.remove();
  }, [load]);
  useSignal(refusalNoticed, load);

  const dismiss = () => {
    if (!notice) return;
    const { key, atMs } = notice;
    setNotice(null);
    void markRefusalNoticeShown(key, atMs).then(load);
  };

  if (!notice) return null;
  return (
    <TopChromeView owner="refusal-notice" style={S.container} pointerEvents="box-none">
      <View
        style={[S.card, { backgroundColor: c.surface, borderColor: c.border, borderLeftColor: c.danger }]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <Text style={[t.sub, S.title, { color: c.text }]}>{notice.title}</Text>
        <Text style={[t.sub, { color: c.text }]}>{notice.body}</Text>
        <View style={S.actions}>
          <Button title="OK" variant="outline" onPress={dismiss} style={S.btn} />
        </View>
      </View>
    </TopChromeView>
  );
}

const S = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 16 : 48, // clears the status bar (matches the toasts and the update banner)
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9997, // under the offline banner (9998) and the toasts (9999)
    paddingHorizontal: 12,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 4,
    elevation: 6,
    gap: 8,
  },
  title: { fontWeight: '700' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
  btn: { minWidth: 88 },
});
