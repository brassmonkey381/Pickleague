// Home: "Turn on Always location" (Doggle's AlwaysLocationCard, 2026-11-05).
// Every background check-in path (the starred, routine and nearby circles, the
// arrival watch on a court's outline, "Leaving X?") needs Location set to
// Always, and iOS asks only once. Shown on a phone without Always, once at
// least one court is starred (with none there is nothing to watch, so asking
// would only be noise):
//   * never asked: Turn on (the system sheet);
//   * asked and declined (or location off): Open Settings, the only way back.
// Coming back to the app re-checks it, and once it's on the courts are
// watched right away. "Not now" hides it for 30 days on this phone.
//
// The status and the hook are the foundation's (1.104 useAlwaysLocation).
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { useAlwaysLocation } from '@just-messin-around/expo-foundation/hooks';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { track } from '../../lib/analytics';
import { syncCourtGeofences } from '../../lib/courtGeofence';
import { useCourtFavorites } from '../../data/courtFavorites';

const DISMISSED_KEY = 'pickleague_home_always_location_dismissed_v1';
const DISMISS_MS = 30 * 24 * 60 * 60_000;

export default function AlwaysLocationCard() {
  return Platform.OS === 'web' ? null : <Card />;
}

function Card() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const stars = useCourtFavorites();
  const a = useAlwaysLocation({
    // Just turned on (the sheet, or back from Settings): watch the courts now.
    onGranted: () => void syncCourtGeofences(),
    onAsked: () => track('location.permission_asked', { kind: 'background', surface: 'home_card' }),
    onResult: (granted) => track('location.permission_result', { kind: 'background', granted, surface: 'home_card' }),
  });
  const { check } = a;
  // Hidden until the saved choice is read, so it never flashes.
  const [dismissed, setDismissed] = React.useState(true);

  useFocusEffect(
    React.useCallback(() => {
      void check();
      AsyncStorage.getItem(DISMISSED_KEY)
        .catch(() => null)
        .then((at) => setDismissed(at != null && Date.now() - Number(at) < DISMISS_MS));
    }, [check]),
  );

  if (a.state === 'always' || a.state === 'unavailable' || dismissed) return null;
  if (!(stars.data?.length ?? 0)) return null;

  const settings = a.state === 'settings';
  function notNow() {
    setDismissed(true);
    AsyncStorage.setItem(DISMISSED_KEY, String(Date.now())).catch(() => undefined);
  }

  return (
    <Panel style={S.card}>
      <Text style={t.label}>CHECK-INS</Text>
      <Text style={t.title}>Turn on Always location</Text>
      <Text style={t.sub}>
        {settings
          ? 'So Pickleague can check you in when you get to your courts, even with the app closed. In Settings, tap Location, then Always.'
          : 'So Pickleague can check you in when you get to your courts, even with the app closed.'}
      </Text>
      <View style={S.actions}>
        <Button title="Not now" variant="outline" onPress={notNow} style={S.flex} />
        <Button title={settings ? 'Open Settings' : 'Turn on'} onPress={() => void a.turnOn()} style={S.flex} />
      </View>
    </Panel>
  );
}

const S = StyleSheet.create({
  card: { gap: SPACE.xs, marginTop: SPACE.md },
  actions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },
  flex: { flex: 1 },
});
