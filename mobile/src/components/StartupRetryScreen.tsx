// Shown when the app cannot resolve the startup session because it can't reach
// the server. This exists because the alternative was worse than an error
// screen: the navigator used to be gated on `{!loading && …}` with an unbounded,
// uncaught getSession(), so a stalled connection rendered a blank background
// forever — no message, no retry, force-quit the only way out.
//
// Distinct from StartupErrorScreen (a crash diagnostic for bundle/render
// throws); this one is an expected, recoverable network state.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

export default function StartupRetryScreen({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Text style={styles.emoji}>📡</Text>
      <Text style={[styles.title, { color: colors.text }]}>Can&apos;t reach Pickleague</Text>
      <Text style={[styles.body, { color: colors.textSub }]}>
        Check your connection and try again. Your account is still here.
      </Text>
      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.primary }]}
        onPress={onRetry}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>Try again</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emoji: { fontSize: 44, marginBottom: 12 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 24 },
  button: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
