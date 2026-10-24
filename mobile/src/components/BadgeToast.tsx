import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native';
import { EmojiGlyph } from '@just-messin-around/expo-foundation/icons';
import { SPACE, RADIUS } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useBadgeNotifications } from '../lib/useBadgeNotifications';

/**
 * Floating toast stack rendered at the top of the screen whenever the signed-in
 * user earns a badge. Each card auto-dismisses after ~4s; tapping it dismisses
 * immediately.
 */
export default function BadgeToast() {
  const { toasts, dismissToast } = useBadgeNotifications();
  const { colors: c } = useTheme();
  const styles = makeStyles(c);

  if (toasts.length === 0) return null;

  return (
    <SafeAreaView pointerEvents="box-none" style={styles.wrap}>
      {toasts.map(t => (
        <TouchableOpacity
          key={t.id}
          activeOpacity={0.85}
          onPress={() => dismissToast(t.id)}
          style={styles.card}
          accessibilityRole="button"
          accessibilityLabel={`Badge earned: ${t.name}. Dismiss`}
        >
          {/* The badge's stored emoji draws as our glyph when one maps. */}
          <EmojiGlyph emoji={t.icon} size={28} color={c.textInverse} style={styles.icon} />
          <View style={styles.textCol}>
            <Text style={styles.label}>Badge earned</Text>
            <Text style={styles.name} numberOfLines={1}>{t.name}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </SafeAreaView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    wrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      alignItems: 'center',
      paddingTop: Platform.OS === 'android' ? SPACE.lg : SPACE.sm,
      paddingHorizontal: SPACE.md,
      zIndex: 9999,
      elevation: 9999,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACE.md,
      backgroundColor: c.primary,
      borderRadius: RADIUS.lg,
      paddingVertical: SPACE.sm,
      paddingHorizontal: SPACE.md,
      marginTop: SPACE.sm,
      minWidth: 240,
      maxWidth: 420,
      shadowColor: c.shadow,
      shadowOpacity: 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    // The emoji fallback (a badge emoji with no glyph).
    icon: { fontSize: 26 },
    textCol: { flexShrink: 1 },
    label: {
      color: c.textInverse,
      opacity: 0.85,
      fontSize: FONT.size.xs,
      fontWeight: FONT.weight.bold,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    name: { color: c.textInverse, fontSize: FONT.size.lg, fontWeight: FONT.weight.heavy },
  });
}
