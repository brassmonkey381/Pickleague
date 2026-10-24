import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View, type ViewProps } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { HAIRLINE, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
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
 *
 * The anchor is a View with `href` (react-native-web renders it as an `a`), so
 * the label and its arrow glyph are one link. `onClick` is RNW's DOM click,
 * which never prevents the navigation. Both are web-only props, cast here; the
 * component returns null on native before rendering.
 */
export default function ContinueInAppBanner() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [path, setPath] = useState<string | null>(null);

  // Read once on mount. Deliberately not reactive: a banner that appears
  // mid-scroll because storage changed would shift layout under the reader.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setPath(peekDestination());
  }, []);

  if (Platform.OS !== 'web' || !path) return null;

  const anchor = {
    href: path,
    onClick: () => {
      track('deferredlink.resume', { path });
      clearDestination();
    },
  } as unknown as ViewProps;

  return (
    <View style={S.bar}>
      <Text style={[t.sub, S.label]} numberOfLines={1}>
        Picking up where you left off?
      </Text>

      <View accessibilityRole="link" {...anchor} style={S.cta}>
        <Text style={[t.sub, S.ctaText]}>Continue</Text>
        <Icon name="arrow-right" size={14} color={c.primary} />
      </View>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={() => { clearDestination(); setPath(null); }}
        style={S.dismiss}
      >
        <Icon name="close" size={16} color={c.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // A 44-tall strip: the link and the dismiss are each a real 44 box.
    bar:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingLeft: SPACE.lg, paddingRight: SPACE.xs, backgroundColor: c.surfaceAlt, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    label:   { flex: 1 },
    cta:     { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs },
    ctaText: { color: c.primary, fontWeight: FONT.weight.heavy },
    dismiss: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  });
}
