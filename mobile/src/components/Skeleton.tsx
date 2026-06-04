import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, ViewStyle, StyleProp, Platform } from 'react-native';
import { useTheme } from '../lib/ThemeContext';

// Animated placeholder block for loading states. Compose these into a
// content-shaped skeleton per screen instead of a bare full-screen spinner.
//
//   {loading ? <SkeletonList rows={6} /> : <RealList ... />}
//
// Hidden from screen readers (the surrounding screen announces "loading").

export function Skeleton({
  width,
  height = 14,
  radius = 6,
  style,
}: {
  width?: ViewStyle['width'];
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1.0, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width: width ?? '100%', height, borderRadius: radius, backgroundColor: colors.border, opacity },
        style,
      ]}
    />
  );
}

// A column of card-shaped skeleton rows — the common "loading a list" case.
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  const { colors } = useTheme();
  return (
    <View style={st.list} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[st.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Skeleton width={42} height={42} radius={21} />
          <View style={st.cardBody}>
            <Skeleton width="60%" height={13} />
            <Skeleton width="40%" height={11} style={{ marginTop: 8 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  list:     { padding: 16, gap: 10 },
  card:     { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: 1, padding: 14 },
  cardBody: { flex: 1 },
});
