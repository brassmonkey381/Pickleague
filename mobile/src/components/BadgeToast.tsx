import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native';
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
        >
          <Text style={styles.icon}>{t.icon}</Text>
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
      paddingTop: Platform.OS === 'android' ? 16 : 8,
      paddingHorizontal: 12,
      zIndex: 9999,
      elevation: 9999,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: c.primary,
      borderRadius: 16,
      paddingVertical: 10,
      paddingHorizontal: 14,
      marginTop: 8,
      minWidth: 240,
      maxWidth: 420,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    icon: { fontSize: 28 },
    textCol: { flexShrink: 1 },
    label: {
      color: 'rgba(255,255,255,0.85)',
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    name: { color: '#fff', fontSize: 15, fontWeight: '800' },
  });
}
