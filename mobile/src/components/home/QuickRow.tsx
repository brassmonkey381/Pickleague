// Home's quick tiles (plan section 3): labelled 64px tiles, rows of 3, above the feed.
//   Discover · Record (league members only) · Play · Drill · Shop · History
// Discover (its Places tab: the courts near you, list or map) shows while
// COURT_DISCOVERY_ENABLED is on, first, as Doggle's Home shortcuts put
// Discover first. Play opens the ▶ Play sheet with the bottom bar on
// (PLAY_NAV_ENABLED, state/feed-discover-play-plan.md P1: Play starts a
// session, like Doggle's WALK), else Discover's Leagues tab (the old Play
// hub). HomeScreen.onQuick routes both.
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
const PER_ROW = 3;

export default function QuickRow({ showRecord, onPress }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const emoji = (e: string) => <Text style={styles.emoji}>{e}</Text>;

  const tiles: Tile[] = [
    ...(COURT_DISCOVERY_ENABLED ? [{ key: 'courts' as const, label: 'Discover', icon: emoji('🔍') }] : []),
    ...(showRecord ? [{ key: 'record' as const, label: 'Record', icon: emoji('📝') }] : []),
    { key: 'play', label: 'Play', icon: <BallIcon size={GLYPH} /> },
    { key: 'drill', label: 'Drill', icon: <DumbbellIcon size={GLYPH} /> },
    { key: 'shop', label: 'Shop', icon: emoji('🛒') },
    ...(WAGERS_ENABLED ? [{ key: 'wagers' as const, label: 'Wagers', icon: emoji('🎲') }] : []),
    { key: 'history', label: 'History', icon: emoji('📋') },
  ];

  // Rows of 3 (the user, 2026-10-22: "two rows of 3, above the home feed").
  // A short last row keeps its tiles the same width as the full rows above.
  const rows: Tile[][] = [];
  for (let i = 0; i < tiles.length; i += PER_ROW) rows.push(tiles.slice(i, i + PER_ROW));

  return (
    <View style={styles.grid}>
      {rows.map((row, r) => (
        <View key={r} style={styles.row}>
          {row.map((tile, j) => (
            <TouchableOpacity
              key={tile.key}
              style={[styles.tile, { backgroundColor: c.surface, borderColor: c.border }]}
              activeOpacity={0.75}
              onPress={() => onPress(tile.key, r * PER_ROW + j)}
              accessibilityRole="button"
              accessibilityLabel={tile.label}
            >
              <View style={styles.glyph}>{tile.icon}</View>
              <Text style={[t.meta, { color: c.text }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {tile.label}
              </Text>
            </TouchableOpacity>
          ))}
          {Array.from({ length: PER_ROW - row.length }, (_, k) => (
            <View key={`pad-${k}`} style={styles.pad} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: SPACE.sm },
  row: { flexDirection: 'row', gap: SPACE.sm },
  pad: { flex: 1 },
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
