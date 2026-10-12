import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View, type TextProps } from 'react-native';
import { track } from '../lib/analytics';
import { clearDestination, peekDestination } from '../lib/deferredLink';
import { useTheme } from '../lib/ThemeContext';

/**
 * Offers back the destination someone was heading for when they went to install
 * the app. See lib/deferredLink for why this lives on the web rather than in an
 * attribution SDK.
 *
 * The link is a plain anchor to our own site, which is the whole trick: if the
 * app got installed, the universal-link association intercepts and opens it on
 * the right screen; if it did not, the browser just goes there. One control,
 * correct in both worlds, and it needs to know nothing about which world it is
 * in — which is what keeps it honest.
 */
export default function ContinueInAppBanner() {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const [path, setPath] = useState<string | null>(null);

  // Read once on mount. Deliberately not reactive: a banner that appears
  // mid-scroll because storage changed would shift layout under the reader.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setPath(peekDestination());
  }, []);

  if (Platform.OS !== 'web' || !path) return null;

  return (
    <View style={S.bar}>
      <Text style={S.label} numberOfLines={1}>
        Picking up where you left off?
      </Text>

      <Text
        accessibilityRole="link"
        {...({ href: path } as unknown as TextProps)}
        onPress={() => {
          track('deferredlink.resume', { path });
          clearDestination();
        }}
        style={S.cta}
      >
        Continue →
      </Text>

      <TouchableOpacity
        accessibilityLabel="Dismiss"
        onPress={() => { clearDestination(); setPath(null); }}
        style={S.dismiss}
      >
        <Text style={S.dismissText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    bar:        { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: c.surfaceAlt, borderBottomWidth: 1, borderBottomColor: c.border },
    label:      { flex: 1, fontSize: 13, color: c.textSub },
    cta:        { fontSize: 13, fontWeight: '800', color: c.primary, textDecorationLine: 'none' },
    dismiss:    { paddingHorizontal: 6, paddingVertical: 2 },
    dismissText:{ fontSize: 14, color: c.textMuted },
  });
}
