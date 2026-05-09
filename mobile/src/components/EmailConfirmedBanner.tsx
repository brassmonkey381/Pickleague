import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, StyleSheet, Animated } from 'react-native';
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
      style={[styles.container, { opacity, backgroundColor: c.primary }]}
    >
      <Text style={styles.title}>✓  Email confirmed</Text>
      <Text style={styles.subtitle}>Welcome to Pickleague — taking you to your account.</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 24,
    left: 16,
    right: 16,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 12,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    zIndex: 9999,
    alignItems: 'center',
  },
  title:    { color: '#fff', fontSize: 16, fontWeight: '800' },
  subtitle: { color: '#fff', fontSize: 13, marginTop: 2, textAlign: 'center', opacity: 0.95 },
});
