// LeagueDetail's quick row (plan section 5, slot 2): four labelled 64px tiles,
//
//   [ + Record ] [ Standings ] [ Events ] [ Members ]
//
// replacing the seven 72px option cards that pushed Record to y≈700. Record is
// the one filled (primary) tile and carries the 'leagues' tour's final step
// ('record'): the ref sits on the tile's own TouchableOpacity, which the tour
// measures with measureInWindow. The row is near the top of the screen, so the
// step needs no scroll host.
//
// Non-members get [Standings] [Events] [Members] (the LeagueJoinCard above the
// row is their action). The Standings tile is disabled with "No season yet"
// when the league has never run a season.
//
// Four tiles on a 390pt phone leave about 73pt of text width each, so nothing
// here may truncate: the label shrinks a little on native rather than ellipsize
// at the 1.3x cap ("Standi…"), and the "No season yet" note is its own line
// that wraps to two. The tiles are minHeight 64, so the row grows instead.
import React, { type Ref } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { RADIUS, SPACE, SMALL_TEXT_MAX_SCALE, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';

export type LeagueQuickRowProps = {
  /** Show the Record tile (members, and viewers whose role read failed). */
  showRecord: boolean;
  onRecord: () => void;
  /** Tour anchor for the Record tile. */
  recordRef?: Ref<View>;
  /** Called when the Record tile lays out (register the tour anchor then). */
  onRecordLayout?: () => void;
  /** null = no season at all: the tile is disabled and says "No season yet". */
  onStandings: (() => void) | null;
  onEvents: () => void;
  onMembers: () => void;
};

type Tile = {
  key: string;
  glyph: string;
  label: string;
  sub?: string;
  onPress: (() => void) | null;
  primary?: boolean;
  a11y: string;
};

export default function LeagueQuickRow({
  showRecord,
  onRecord,
  recordRef,
  onRecordLayout,
  onStandings,
  onEvents,
  onMembers,
}: LeagueQuickRowProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);

  const tiles: Tile[] = [
    ...(showRecord
      ? [{ key: 'record', glyph: '＋', label: 'Record', onPress: onRecord, primary: true, a11y: 'Record a match' }]
      : []),
    {
      key: 'standings',
      glyph: '🏆',
      label: 'Standings',
      sub: onStandings ? undefined : 'No season yet',
      onPress: onStandings,
      a11y: onStandings ? 'Season standings' : 'Standings, no season yet',
    },
    { key: 'events', glyph: '📅', label: 'Events', onPress: onEvents, a11y: 'Events' },
    { key: 'members', glyph: '👥', label: 'Members', onPress: onMembers, a11y: 'Members' },
  ];

  return (
    <View style={styles.row}>
      {tiles.map((tile) => {
        const disabled = !tile.onPress;
        const fg = tile.primary ? c.textInverse : disabled ? c.textMuted : c.text;
        return (
          <TouchableOpacity
            key={tile.key}
            ref={tile.key === 'record' ? (recordRef as Ref<any>) : undefined}
            onLayout={tile.key === 'record' ? onRecordLayout : undefined}
            onPress={tile.onPress ?? undefined}
            disabled={disabled}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel={tile.a11y}
            accessibilityState={{ disabled }}
            style={[
              styles.tile,
              tile.primary
                ? { backgroundColor: c.primary, borderColor: c.primary }
                : { backgroundColor: c.surface, borderColor: c.border },
              disabled && styles.dim,
            ]}
          >
            <Text style={[styles.glyph, { color: fg }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{tile.glyph}</Text>
            <Text
              style={[t.meta, styles.center, { color: fg }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
            >
              {tile.label}
            </Text>
            {tile.sub ? (
              <Text
                style={[t.meta, styles.center, styles.sub, { color: fg }]}
                numberOfLines={2}
                maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              >
                {tile.sub}
              </Text>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: SPACE.sm },
  // 64 tile row (plan section 6: chip or tile row = 64), minHeight so large text grows it.
  tile: {
    flex: 1,
    minWidth: 0,
    minHeight: 64,
    borderRadius: RADIUS.md,
    borderWidth: HAIRLINE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACE.xs,
    paddingVertical: SPACE.sm,
    gap: SPACE.xxs,
  },
  glyph: { fontSize: FONT.size.h2, lineHeight: FONT.size.h2 + SPACE.xs, fontWeight: '700' },
  dim: { opacity: 0.6 },
  center: { textAlign: 'center' },
  // No caps tracking on the note: it is sentence copy and needs the width.
  sub: { letterSpacing: 0 },
});
