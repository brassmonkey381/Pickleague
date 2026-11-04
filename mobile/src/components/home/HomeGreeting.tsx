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
//
// variant 'band' (the redesign's Home header, inside the brand band): a big
// "Hi, Brian" in the look's display font, then the streak and balance as
// pills, all in the band's ink (headerText).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon, IconValue } from '@just-messin-around/expo-foundation/icons';
import { numberFont } from '@just-messin-around/expo-foundation/theme';
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
  /** 'row' (default): the 44px row on the page. 'band': on the brand band. */
  variant?: 'row' | 'band';
};

const AVATAR = 28;
/** The avatar emoji is the player's own pick (content, not chrome): 16 in the 28 circle. */
const AVATAR_EMOJI = 16;

export default function HomeGreeting({ profile, streak, onProfile, onBalance, onStreak, variant = 'row' }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] ?? '';
  const cartoon = AVATARS.find(a => a.id === (profile?.avatar_id ?? 1)) ?? AVATARS[0];
  const emoji = profile?.avatar_emoji ?? cartoon?.emoji ?? null;
  const avatarBg = profile?.avatar_bg_color ?? cartoon?.bgColor ?? c.surfaceAlt;
  const balance = profile ? profile.pickles ?? 0 : null;

  if (variant === 'band') {
    const ink = c.headerText;
    // The pills: the band's ink at 14% over the band.
    const pillBg = withAlpha(ink, 0.14);
    return (
      <View style={styles.band}>
        <TouchableOpacity
          style={styles.hello}
          activeOpacity={0.7}
          onPress={onProfile}
          accessibilityRole="button"
          accessibilityLabel={firstName ? `Hi, ${firstName}. Open your profile` : 'Open your profile'}
        >
          <Text style={[t.display, styles.big, { color: ink }]} numberOfLines={1}>
            {firstName ? `Hi, ${firstName}` : 'Hi'}
          </Text>
        </TouchableOpacity>
        <View style={styles.pills}>
          {streak > 0 ? (
            <TouchableOpacity
              style={styles.pillBox}
              onPress={onStreak}
              accessibilityRole="button"
              accessibilityLabel={`${streak} day streak`}
              accessibilityHint="Shows your streak and upcoming rewards"
            >
              <View style={[styles.pill, { backgroundColor: pillBg }]}>
                <IconValue
                  iconName="fire"
                  value={streak}
                  preset="title"
                  color={ink}
                  iconColor={ink}
                  textStyle={{ fontFamily: numberFont(c) }}
                  maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
                />
                <Text style={[t.meta, { color: ink }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>day streak</Text>
              </View>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={styles.pillBox}
            activeOpacity={0.8}
            onPress={onBalance}
            accessibilityRole="button"
            accessibilityLabel={
              balance != null ? `${picklesLabel(balance)}. Open your pickle history` : 'Open your pickle history'
            }
            accessibilityHint="Shows what you earned and spent, with links to the Shop and the calendar"
          >
            <View style={[styles.pill, { backgroundColor: pillBg }]}>
              <PickleBalance balance={balance} preset="title" color={ink} iconColor={ink} textStyle={{ fontFamily: numberFont(c) }} decorative />
              <Text style={[t.meta, { color: ink }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>pickles</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

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

/** '#rrggbb' at alpha `a` (band pills). Other colour forms pass through. */
function withAlpha(hex: string, a: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const styles = StyleSheet.create({
  // ── variant 'band' ──
  band: { paddingHorizontal: SPACE.lg, paddingBottom: SPACE.lg, gap: SPACE.sm },
  hello: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', maxWidth: '100%' },
  big: { fontSize: 30, lineHeight: 36 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  pillBox: { minHeight: 44, justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs },
  // ── variant 'row' ──
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
