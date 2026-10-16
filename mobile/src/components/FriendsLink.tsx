// A way into the Friends screen. Two looks:
//   - row:  "🤝 Friends            [2 requests] ›", a 48 tall strip (Profile,
//           and the Notifications Requests / Friends chips).
//   - link: a bare "Friends ›" (44 box) for a section header's trailing slot,
//           e.g. Home's "Friends at the courts".
// The badge counts friend requests waiting on me; with any, the tap opens the
// Requests tab. Renders nothing while FRIENDS_AT_COURTS_ENABLED is off (the
// screen isn't registered then).
import React from 'react';
import { Text, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Badge } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { FRIENDS_AT_COURTS_ENABLED } from '../lib/features';
import { useFriendRequests } from '../lib/useFriends';
import { incomingCount } from '../lib/friendship';
import type { RootStackParamList } from '../types';

type Props = {
  variant?: 'row' | 'link';
  /** Default "Friends". */
  label?: string;
  style?: StyleProp<ViewStyle>;
  /** Analytics or other side effects; the navigation happens either way. */
  onPress?: () => void;
};

export function FriendsLink({ variant = 'row', label = 'Friends', style, onPress }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // Shares the Friends screen's cached list, so this is a cache read on every
  // surface after the first.
  const { data } = useFriendRequests();
  if (!FRIENDS_AT_COURTS_ENABLED) return null;
  const waiting = incomingCount(data);

  const open = () => {
    onPress?.();
    navigation.navigate('Friends', waiting > 0 ? { tab: 'requests' } : undefined);
  };
  const a11y = waiting > 0
    ? `${label}, ${waiting} friend ${waiting === 1 ? 'request' : 'requests'} waiting`
    : label;

  if (variant === 'link') {
    return (
      <TouchableOpacity style={[S.linkBox, style]} onPress={open} accessibilityRole="button" accessibilityLabel={a11y}>
        <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {waiting > 0 ? `${label} (${waiting}) ›` : `${label} ›`}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      style={[S.row, { borderColor: c.border, backgroundColor: c.surface }, style]}
      onPress={open}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={a11y}
    >
      <Text style={S.glyph}>🤝</Text>
      <Text style={[S.label, { color: c.text }]} numberOfLines={1}>{label}</Text>
      {waiting > 0 ? (
        <Badge
          label={`${waiting} ${waiting === 1 ? 'request' : 'requests'}`}
          tone="brand"
          maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        />
      ) : null}
      <Text style={[S.chevron, { color: c.textMuted }]}>›</Text>
    </TouchableOpacity>
  );
}

export default FriendsLink;

const S = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    minHeight: 48, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
    borderRadius: RADIUS.lg, borderWidth: HAIRLINE,
  },
  glyph: { fontSize: FONT.size.lg },
  label: { flex: 1, minWidth: 0, fontSize: FONT.size.base, fontWeight: '600' },
  chevron: { fontSize: FONT.size.h2, fontWeight: '700' },
  linkBox: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: SPACE.xs },
});
