// Home's 44px greeting row (plan section 3): "(avatar) Hi, Brian ›" opens
// Profile, the login streak sits beside it (in place of a modal on every
// launch), and the balance opens the pickles viewer (history, play streak,
// and the links to the Shop and the calendar).
//
//   (B) Hi, Brian ›                       (fire) 5   (pickle) 1,240
//
// Streak and balance are drawn the same way (Doggle's header points badge,
// glyphs-ui-plan.md 5.2): glyph + number in the same text style, no pill, no
// chevron, each in its own 44 box.
//
// Until the profile lands the balance reads "—": a 0 would be a claim we can't
// back up (and one users act on).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon, IconValue } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';
import { AVATARS } from '../../data/profileCustomization';
import FlairName from '../FlairName';
import { PickleBalance, picklesLabel } from '../PickleAmount';
import type { Profile } from '../../types';

type Props = {
  profile: Profile | null;
  /** Login streak in days; 0 hides it. */
  streak: number;
  onProfile: () => void;
  /** Opens the pickles viewer (components/home/PicklesViewer). */
  onBalance: () => void;
  /** Opens the streak pop-up (current streak + upcoming milestone rewards). */
  onStreak: () => void;
};

const AVATAR = 28;
/** The avatar emoji is the player's own pick (content, not chrome): 16 in the 28 circle. */
const AVATAR_EMOJI = 16;

export default function HomeGreeting({ profile, streak, onProfile, onBalance, onStreak }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] ?? '';
  const cartoon = AVATARS.find(a => a.id === (profile?.avatar_id ?? 1)) ?? AVATARS[0];
  const emoji = profile?.avatar_emoji ?? cartoon?.emoji ?? null;
  const avatarBg = profile?.avatar_bg_color ?? cartoon?.bgColor ?? c.surfaceAlt;
  const balance = profile ? profile.pickles ?? 0 : null;

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
          {emoji ? (
            <Text style={styles.avatarEmoji} maxFontSizeMultiplier={1}>{emoji}</Text>
          ) : (
            <Icon name="person" size={16} color={c.textMuted} />
          )}
        </View>
        {/* A no-break space: web collapses a trailing plain space between two
            inline boxes ("Hi,Jake"). */}
        <Text style={t.title} numberOfLines={1}>{'Hi, '}</Text>
        {/* The purchased name style still shows, in its list-sized form. */}
        <FlairName
          style={[t.title, styles.name]}
          nameColor={profile?.name_color}
          styleId={profile?.profile_name_style_id}
          mode="list"
          name={firstName || '…'}
        />
        <Icon name="chevron-right" size={16} color={c.textMuted} style={styles.chevron} />
      </TouchableOpacity>

      {streak > 0 ? (
        // Tappable: opens the streak pop-up with the road map of upcoming
        // milestone rewards, so the number leads somewhere.
        <TouchableOpacity
          style={styles.box}
          onPress={onStreak}
          accessibilityRole="button"
          accessibilityLabel={`${streak} day streak`}
          accessibilityHint="Shows your streak and upcoming rewards"
        >
          <IconValue
            iconName="fire"
            value={streak}
            preset="title"
            iconColor={c.warning}
            maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
          />
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity
        style={styles.box}
        activeOpacity={0.8}
        onPress={onBalance}
        accessibilityRole="button"
        accessibilityLabel={
          balance != null ? `${picklesLabel(balance)}. Open your pickle history` : 'Open your pickle history'
        }
        accessibilityHint="Shows what you earned and spent, with links to the Shop and the calendar"
      >
        <PickleBalance balance={balance} preset="title" decorative />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 44 },
  who: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACE.sm,
  },
  avatarEmoji: { fontSize: AVATAR_EMOJI, lineHeight: AVATAR_EMOJI + SPACE.xs },
  name: { flexShrink: 1 },
  chevron: { marginLeft: SPACE.xxs },
  // Each figure in its own 44 box (the tap target), the figure centred in it.
  box: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
