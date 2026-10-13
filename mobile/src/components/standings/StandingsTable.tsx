// The 4-column standings table on SeasonStandings (plan section 5):
//   #  ·  Player  ·  W-L (or Median on the Final tab)  ·  PLUPR with change
//
// One Panel of 44px divider rows (the Row variant: minHeight, never height, so
// large text grows a row instead of clipping it). The viewer's own row is
// tinted and reports its layout so the screen's "Jump to me" bar can scroll to
// it. Presentational only: the screen owns the data and the navigation.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { AVATARS } from '../../data/profileCustomization';
import FlairName from '../FlairName';

const MEDALS = ['🥇', '🥈', '🥉'];

export type StandingsTableRow = {
  userId: string;
  rank: number;
  name: string;
  nameColor?: string | null;
  styleId?: string | null;
  avatarId?: number | null;
  /** Third column: "3-1" (W-L) or "2.5" (median rank). */
  middle: string;
  /** PLUPR, already formatted ("3.62"). */
  plupr: string;
  /** "+0.12" / "−0.05" / "" — shown after the PLUPR in a smaller tone. */
  change?: string;
  /** Pickles wagered on this player (only shown when > 0). */
  wagered?: number;
};

export type StandingsTableProps = {
  rows: StandingsTableRow[];
  /** Header for the third column ("W-L" or "Median"). */
  middleLabel: string;
  myUserId: string | null;
  onRowPress: (row: StandingsTableRow) => void;
  onRowLongPress?: (row: StandingsTableRow) => void;
  onWagerPress?: (row: StandingsTableRow) => void;
  /** y of the viewer's row inside the table (relative to the Panel). */
  onMyRowLayout?: (y: number, height: number) => void;
};

export default function StandingsTable({
  rows, middleLabel, myUserId, onRowPress, onRowLongPress, onWagerPress, onMyRowLayout,
}: StandingsTableProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);

  return (
    <Panel padded={false} radius={RADIUS.lg}>
      <View style={[S.row, S.headRow]} accessibilityRole="header">
        <Text style={[t.fieldLabel, S.colRank]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>#</Text>
        <Text style={[t.fieldLabel, S.colName]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Player</Text>
        <Text style={[t.fieldLabel, S.colMid]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{middleLabel}</Text>
        <Text style={[t.fieldLabel, S.colPlupr]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>PLUPR</Text>
      </View>
      {rows.map((row, i) => {
        const mine = row.userId === myUserId;
        const av = AVATARS.find(a => a.id === (row.avatarId ?? 1)) ?? AVATARS[0];
        const name = row.name || 'Player';
        const last = i === rows.length - 1;
        return (
          <TouchableOpacity
            key={row.userId}
            style={[S.row, !last && S.divider, mine && S.mine]}
            onPress={() => onRowPress(row)}
            onLongPress={onRowLongPress ? () => onRowLongPress(row) : undefined}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`${mine ? 'You, ' : ''}rank ${row.rank}, ${name}, ${middleLabel} ${row.middle}, PLUPR ${row.plupr}${row.change ? ` ${row.change}` : ''}`}
            onLayout={mine && onMyRowLayout
              ? (e: LayoutChangeEvent) => onMyRowLayout(e.nativeEvent.layout.y, e.nativeEvent.layout.height)
              : undefined}
          >
            <Text style={[S.colRank, row.rank <= 3 ? S.medal : [t.meta, { color: c.textSub }]]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              {MEDALS[row.rank - 1] ?? String(row.rank)}
            </Text>
            <View style={[S.colName, S.nameCell]}>
              <View style={[S.avatar, { backgroundColor: av.bgColor }]}>
                <Text style={S.avatarEmoji} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{av.emoji}</Text>
              </View>
              <FlairName
                name={mine ? `${name} (you)` : name}
                nameColor={row.nameColor}
                styleId={row.styleId ?? null}
                mode="list"
                style={[t.sub, S.name]}
                numberOfLines={1}
              />
              {(row.wagered ?? 0) > 0 && onWagerPress ? (
                // Its own 44 box (RNW ignores hitSlop); a nested touchable wins
                // the press on native and stops the click on web.
                <TouchableOpacity
                  style={S.wagerBox}
                  onPress={() => onWagerPress(row)}
                  accessibilityRole="button"
                  accessibilityLabel={`View wagers on ${name}`}
                >
                  <View style={S.wagerPill}>
                    <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                      🥒 {row.wagered!.toLocaleString()}
                    </Text>
                  </View>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={[t.sub, S.colMid, { color: c.text }]}>{row.middle}</Text>
            <View style={[S.colPlupr, S.pluprCell]}>
              <Text style={[t.sub, S.pluprValue]}>{row.plupr}</Text>
              {row.change ? (
                <Text
                  style={[t.meta, { color: row.change.startsWith('+') ? c.success : c.danger }]}
                  maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
                >
                  {row.change}
                </Text>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </Panel>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 44,
      paddingHorizontal: SPACE.md,
      gap: SPACE.sm,
    },
    headRow: { minHeight: 32, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    divider: { borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    mine: { backgroundColor: c.primaryLight },
    colRank: { width: 28, textAlign: 'center' },
    colName: { flex: 1, minWidth: 0 },
    colMid: { width: 52, textAlign: 'center' },
    colPlupr: { width: 92 },
    medal: { fontSize: 15 },
    nameCell: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    avatar: { width: 24, height: 24, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: 13 },
    name: { flexShrink: 1, color: c.text, fontWeight: '600' },
    wagerBox: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
    wagerPill: { backgroundColor: c.primaryLight, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs },
    pluprCell: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'flex-end', gap: SPACE.xs },
    pluprValue: { color: c.text, fontWeight: '700' },
  });
}
