import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, StyleSheet, Animated, View } from 'react-native';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { shadowColor } from '@just-messin-around/expo-foundation/theme';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';

// Detects when a user lands on the web app from a Supabase email confirmation
// link (URL hash contains `type=signup`), shows a brief "you're confirmed"
// banner, clears the hash, and auto-dismisses after a few seconds.
//
// The auth state change is handled separately by AppNavigator's session
// listener — by the time this banner is on screen the user is already routed
// to the authenticated home stack.
export default function EmailConfirmedBanner() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined') return;

    const hash = window.location.hash || '';
    // Supabase appends "type=signup" / "type=recovery" / "type=invite" /
    // "type=email_change" to confirmation redirects. We greet signup; the
    // others fall through silently.
    if (!hash.includes('type=signup')) return;

    // Clear the hash so a refresh doesn't re-trigger the banner.
    if (window.history?.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    setVisible(true);
    Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();

    const dismissTimer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true })
        .start(() => setVisible(false));
    }, 4000);

    return () => clearTimeout(dismissTimer);
  }, [opacity]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.container, { opacity, backgroundColor: c.primary, shadowColor: shadowColor(c) }]}
      accessibilityRole="alert"
    >
      <View style={styles.titleRow}>
        <Icon name="check-mark" size={16} color={c.textInverse} />
        <Text style={[t.title, { color: c.textInverse }]}>Email confirmed</Text>
      </View>
      <Text style={[t.sub, styles.subtitle, { color: c.textInverse }]}>
        Welcome to Pickleague — taking you to your account.
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: SPACE.xl,
    left: SPACE.lg,
    right: SPACE.lg,
    paddingVertical: SPACE.md,
    paddingHorizontal: SPACE.lg,
    borderRadius: RADIUS.lg,
    elevation: 6,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    zIndex: 9999,
    alignItems: 'center',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  subtitle: { marginTop: SPACE.xxs, textAlign: 'center', opacity: 0.95 },
});
