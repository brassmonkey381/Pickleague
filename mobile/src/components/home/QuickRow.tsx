// Home's quick row (plan section 3): labelled 64px tiles in one row.
//   Record (league members only) · Play · Courts · Drill · Shop · History
// Courts shows while COURT_DISCOVERY_ENABLED is on. Six tiles at 375 px: the
// row is 343 wide inside Home's 16 px gutters, so with the gap cut to 4 px
// each tile is about 53 px, wide enough for "History" (the longest label, about
// 45 px at the meta size).
// The old About tile is gone (About lives at Settings > App > About) and
// Profile moved to the greeting's avatar. The Wagers tile stays gated by
// WAGERS_ENABLED: the MyWagers screen isn't registered while it's false.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { COURT_DISCOVERY_ENABLED, WAGERS_ENABLED } from '../../lib/features';
import { BallIcon, DumbbellIcon } from '../PickleIcons';

export type QuickTarget = 'record' | 'play' | 'courts' | 'drill' | 'shop' | 'history' | 'wagers';

type Tile = { key: QuickTarget; label: string; icon: React.ReactNode };

type Props = {
  /** Record shows only for league members. */
  showRecord: boolean;
  onPress: (target: QuickTarget, position: number) => void;
};

const GLYPH = 24;

export default function QuickRow({ showRecord, onPress }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const emoji = (e: string) => <Text style={styles.emoji}>{e}</Text>;

  const tiles: Tile[] = [
    ...(showRecord ? [{ key: 'record' as const, label: 'Record', icon: emoji('📝') }] : []),
    { key: 'play', label: 'Play', icon: <BallIcon size={GLYPH} /> },
    ...(COURT_DISCOVERY_ENABLED ? [{ key: 'courts' as const, label: 'Courts', icon: emoji('📍') }] : []),
    { key: 'drill', label: 'Drill', icon: <DumbbellIcon size={GLYPH} /> },
    { key: 'shop', label: 'Shop', icon: emoji('🛒') },
    ...(WAGERS_ENABLED ? [{ key: 'wagers' as const, label: 'Wagers', icon: emoji('🎲') }] : []),
    { key: 'history', label: 'History', icon: emoji('📋') },
  ];

  return (
    <View style={[styles.row, tiles.length >= 6 && styles.tight]}>
      {tiles.map((tile, i) => (
        <TouchableOpacity
          key={tile.key}
          style={[styles.tile, { backgroundColor: c.surface, borderColor: c.border }]}
          activeOpacity={0.75}
          onPress={() => onPress(tile.key, i)}
          accessibilityRole="button"
          accessibilityLabel={tile.label}
        >
          <View style={styles.glyph}>{tile.icon}</View>
          <Text style={[t.meta, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {tile.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: SPACE.sm },
  // Six tiles: a narrower gap keeps every label whole at 375 px.
  tight: { gap: SPACE.xs },
  tile: {
    flex: 1,
    minWidth: 44,
    minHeight: 64,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.xxs,
    paddingVertical: SPACE.xs,
  },
  glyph: { minHeight: GLYPH, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: FONT.size.h2, lineHeight: GLYPH },
});
