// A way to your friends: Discover › Players (the Friends screen while Discover
// is off). Two looks:
//   - row:  handshake glyph, "Friends", [2 requests], chevron: a 48 tall
//           ListCard strip (Profile, and the Notifications Requests / Friends
//           chips).
//   - link: a bare "Friends" TextLink with a chevron (44 box) for a section
//           header's trailing slot, e.g. Home's "Friends at the courts".
// The badge counts friend requests waiting on me; with any, the tap opens the
// Requests tab. Renders nothing while FRIENDS_AT_COURTS_ENABLED is off (the
// screen isn't registered then).
import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Badge, ListCard, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { FRIENDS_AT_COURTS_ENABLED } from '../lib/features';
import { openDiscover } from '../lib/discoverNav';
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

/** The strip row's height: the same one-line strip as Profile's next unlock. */
const ROW_HEIGHT = 48;

export function FriendsLink({ variant = 'row', label = 'Friends', style, onPress }: Props) {
  const { colors: c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // Shares the Friends screen's cached list, so this is a cache read on every
  // surface after the first.
  const { data } = useFriendRequests();
  if (!FRIENDS_AT_COURTS_ENABLED) return null;
  const waiting = incomingCount(data);

  // Discover › Players (the Friends screen while Discover is off).
  const open = () => {
    onPress?.();
    openDiscover(navigation, { tab: 'players', players: waiting > 0 ? 'requests' : 'friends' });
  };
  const a11y = waiting > 0
    ? `${label}, ${waiting} friend ${waiting === 1 ? 'request' : 'requests'} waiting`
    : label;

  if (variant === 'link') {
    return (
      <TextLink
        label={waiting > 0 ? `${label} (${waiting})` : label}
        onPress={open}
        accessibilityLabel={a11y}
        style={[S.linkBox, style]}
      />
    );
  }

  return (
    <ListCard
      density="compact"
      minHeight={ROW_HEIGHT}
      style={style}
      leading={<Icon name="handshake" size={18} color={c.primary} />}
      // 13/600, the same label as Profile's other strip rows.
      title={<Text style={[S.label, { color: c.text }]} numberOfLines={1}>{label}</Text>}
      trailing={
        <View style={S.trailing}>
          {waiting > 0 ? (
            <Badge
              label={`${waiting} ${waiting === 1 ? 'request' : 'requests'}`}
              tone="brand"
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
            />
          ) : null}
          <Icon name="chevron-right" size={16} color={c.textMuted} />
        </View>
      }
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={a11y}
    />
  );
}

export default FriendsLink;

const S = StyleSheet.create({
  label: { fontSize: FONT.size.base, fontWeight: FONT.weight.semibold },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  linkBox: { minWidth: 44, paddingHorizontal: SPACE.xs },
});
