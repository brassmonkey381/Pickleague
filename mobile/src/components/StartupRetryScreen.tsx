// Shown when the app cannot resolve the startup session because it can't reach
// the server. This exists because the alternative was worse than an error
// screen: the navigator used to be gated on `{!loading && …}` with an unbounded,
// uncaught getSession(), so a stalled connection rendered a blank background
// forever — no message, no retry, force-quit the only way out.
//
// Distinct from StartupErrorScreen (a crash diagnostic for bundle/render
// throws); this one is an expected, recoverable network state. It renders
// inside ThemeProvider (AppNavigator), so it uses the theme and the
// foundation's glyphs and Button like any other screen.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';

export default function StartupRetryScreen({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTheme();
  const t = textStyles(colors);
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Icon name="offline" size={40} color={colors.textMuted} style={styles.glyph} />
      <Text style={[t.h2, styles.center, styles.title]} accessibilityRole="header">
        Can&apos;t reach Pickleague
      </Text>
      <Text style={[t.body, styles.center, styles.body, { color: colors.textSub }]}>
        Check your connection and try again. Your account is still here.
      </Text>
      <Button title="Try again" onPress={onRetry} style={styles.button} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl },
  glyph: { marginBottom: SPACE.md },
  center: { textAlign: 'center' },
  title: { marginBottom: SPACE.sm },
  body: { marginBottom: SPACE.xl },
  // Button md has no side padding of its own; this one hugs its label.
  button: { paddingHorizontal: SPACE.xl },
});
