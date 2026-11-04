// Home's numbers, the first card under the brand band (the redesign's layout
// B, the user's pick 2026-11-04):
//
//   [ (fire) 12      | (pickle) 52,791 | (home)          ]
//   [ day streak     | pickles         | My Place        ]
//   [ Court Pass, Tier 1  [=====-------]  15 to next  >  ]
//
// The streak opens the streak pop-up. The pickles open the Shop straight away
// (the user: "straightforward access to the Shop"); the pickle history moved
// behind the Shop's balance. My Place opens the room. The foot opens Court
// Pass, with a red dot while a reward is new, and renders nothing while the
// pass is loading, failed or unseeded, as CourtPassChip did.
import React from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { SPACE, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon, IconValue } from '@just-messin-around/expo-foundation/icons';
import { numberFont } from '@just-messin-around/expo-foundation/theme';
import { useTheme } from '../../lib/ThemeContext';
import { PickleBalance, picklesLabel } from '../PickleAmount';
import { courtPassChipA11y, courtPassChipLabel, type CourtPassSummary } from '../../lib/courtPassCopy';

type Props = {
  /** Login streak in days. */
  streak: number;
  /** null until the profile lands: the cell reads "—". */
  balance: number | null;
  courtPass: CourtPassSummary | null;
  onStreak: () => void;
  onShop: () => void;
  onMyPlace: () => void;
  onCourtPass: () => void;
};

const BAR = 6;

export default function HomeStatCard({ streak, balance, courtPass, onStreak, onShop, onMyPlace, onCourtPass }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const num = { fontFamily: numberFont(c) };
  const caption = [t.meta, { color: c.textSub }];
  const divider = { borderLeftWidth: HAIRLINE, borderLeftColor: c.border };

  return (
    <Panel padded={false} style={styles.card}>
      <View style={styles.cells}>
        <TouchableOpacity
          style={styles.cell}
          onPress={onStreak}
          accessibilityRole="button"
          accessibilityLabel={`${streak} day streak`}
          accessibilityHint="Shows your streak and upcoming rewards"
        >
          <IconValue iconName="fire" value={streak} preset="title" iconColor={c.warning} textStyle={num} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
          <Text style={caption} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>day streak</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.cell, divider]}
          onPress={onShop}
          accessibilityRole="button"
          accessibilityLabel={balance != null ? `${picklesLabel(balance)}. Open the Pickle Shop` : 'Open the Pickle Shop'}
        >
          <PickleBalance balance={balance} preset="title" textStyle={num} decorative />
          <Text style={caption} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>pickles, Shop</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.cell, divider]}
          onPress={onMyPlace}
          accessibilityRole="button"
          accessibilityLabel="My Place, your room"
        >
          <Icon name="home" size={20} color={c.primary} />
          <Text style={caption} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>My Place</Text>
        </TouchableOpacity>
      </View>

      {courtPass ? (
        <TouchableOpacity
          style={[styles.foot, { borderTopColor: c.border }]}
          onPress={onCourtPass}
          accessibilityRole="button"
          accessibilityLabel={courtPassChipA11y(courtPass)}
        >
          {courtPass.kind === 'running' && !courtPass.finished ? (
            <>
              <Icon name="ticket" size={14} color={c.primary} />
              <Text style={[t.meta, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                Court Pass, Tier {courtPass.tier}
              </Text>
              <View style={[styles.track, { backgroundColor: c.primaryLight }]}>
                <View style={[styles.fill, { backgroundColor: c.primary, width: `${Math.round(courtPass.progress * 100)}%` }]} />
              </View>
              <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {courtPass.xpToNext} to next
              </Text>
            </>
          ) : (
            <>
              <Icon name="ticket" size={14} color={c.primary} />
              <Text style={[t.meta, styles.flex, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {courtPassChipLabel(courtPass)}
              </Text>
            </>
          )}
          {courtPass.kind === 'running' && courtPass.newCount > 0 ? (
            <View style={[styles.dot, { backgroundColor: c.danger }]} />
          ) : null}
          <Icon name="chevron-right" size={12} color={c.textMuted} />
        </TouchableOpacity>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden' },
  cells: { flexDirection: 'row' },
  // Each cell its own 44+ tap target, figure over caption.
  cell: { flex: 1, minWidth: 0, minHeight: 64, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, justifyContent: 'center', gap: SPACE.xxs },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    minHeight: 44,
    paddingHorizontal: SPACE.md,
    borderTopWidth: HAIRLINE,
  },
  track: { flex: 1, height: BAR, borderRadius: BAR / 2, overflow: 'hidden' },
  fill: { height: BAR, borderRadius: BAR / 2 },
  flex: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
