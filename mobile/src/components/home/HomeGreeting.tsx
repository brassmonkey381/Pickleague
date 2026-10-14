// Home's 44px greeting row (plan section 3): "(avatar) Hi, Brian ›" opens
// Profile, the login streak sits beside it (in place of a modal on every
// launch), and the pickle pill opens the Shop.
//
//   (B) Hi, Brian ›                 🔥 5   🥒 1,240 ›
//
// Until the profile lands the balance reads "—": a 0 would be a claim we can't
// back up (and one users act on).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { AVATARS } from '../../data/profileCustomization';
import FlairName from '../FlairName';
import type { Profile } from '../../types';

type Props = {
  profile: Profile | null;
  /** Login streak in days; 0 hides it. */
  streak: number;
  onProfile: () => void;
  onShop: () => void;
  /** Opens the streak pop-up (current streak + upcoming milestone rewards). */
  onStreak: () => void;
};

const AVATAR = 28;

export default function HomeGreeting({ profile, streak, onProfile, onShop, onStreak }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] ?? '';
  const cartoon = AVATARS.find(a => a.id === (profile?.avatar_id ?? 1)) ?? AVATARS[0];
  const emoji = profile?.avatar_emoji ?? cartoon?.emoji ?? '🙂';
  const avatarBg = profile?.avatar_bg_color ?? cartoon?.bgColor ?? c.surfaceAlt;
  const balance = profile ? (profile.pickles ?? 0).toLocaleString() : '—';

  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.who}
        activeOpacity={0.7}
        onPress={onProfile}
        accessibilityRole="button"
        accessibilityLabel={firstName ? `Hi, ${firstName}. Open your profile` : 'Open your profile'}
      >
        <View style={[styles.avatar, { backgroundColor: avatarBg }]}>
          <Text style={t.sub}>{emoji}</Text>
        </View>
        <Text style={t.title} numberOfLines={1}>Hi, </Text>
        {/* The purchased name style still shows, in its list-sized form. */}
        <FlairName
          style={[t.title, styles.name]}
          nameColor={profile?.name_color}
          styleId={profile?.profile_name_style_id}
          mode="list"
          name={firstName || '…'}
        />
        <Text style={[t.title, { color: c.textMuted }]}> ›</Text>
      </TouchableOpacity>

      {streak > 0 ? (
        // Tappable: opens the streak pop-up with the road map of upcoming
        // milestone rewards, so the number leads somewhere.
        <TouchableOpacity
          style={styles.pillBox}
          onPress={onStreak}
          accessibilityRole="button"
          accessibilityLabel={`${streak} day login streak`}
          accessibilityHint="Shows your streak and upcoming rewards"
        >
          <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            🔥 {streak}
          </Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity
        style={styles.pillBox}
        activeOpacity={0.8}
        onPress={onShop}
        accessibilityRole="button"
        accessibilityLabel={profile ? `${balance} pickles. Open the Pickle Shop` : 'Open the Pickle Shop'}
      >
        <View style={[styles.pill, { backgroundColor: c.primaryLight, borderColor: c.border }]}>
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            🥒 {balance} ›
          </Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  who: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACE.sm,
  },
  name: { flexShrink: 1 },
  // 44 box, 28 pill.
  pillBox: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  pill: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
});
