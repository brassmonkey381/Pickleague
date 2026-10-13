// "Wager market" on SeasonStandings: a collapsed reference section listing the
// players by PLUPR with a 🎲 cell per podium rank. Gated by WAGERS_ENABLED at
// the call site (its RPCs are absent in production), so this only renders in
// builds that turn wagering on. Moved out of the screen unchanged in behaviour:
// top 12 by PLUPR, "Show N more" when there are more.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CollapsibleSection } from '@just-messin-around/expo-foundation/ui';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import FlairName from '../FlairName';

export type MarketRow = {
  user_id: string;
  full_name: string;
  name_color: string | null;
  list_name_style_id: string | null;
  plupr: number;
};

const MARKET_RANKS = [1, 2, 3] as const;
const MARKET_RANK_LABELS: Record<(typeof MARKET_RANKS)[number], string> = { 1: '🥇 1st', 2: '🥈 2nd', 3: '🥉 3rd' };
const MARKET_TOP_N = 12;

export default function WagerMarketSection({
  rows, scopeLabel, onWager, onToggle,
}: {
  rows: MarketRow[];
  /** "Period 3 standings" / "Final season standings". */
  scopeLabel: string;
  onWager: (row: MarketRow, rank: number) => void;
  onToggle?: (open: boolean) => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => b.plupr - a.plupr);
  const overflow = sorted.length > MARKET_TOP_N;
  const visible = showAll || !overflow ? sorted : sorted.slice(0, MARKET_TOP_N);

  return (
    <CollapsibleSection
      compact
      title="Wager market"
      summary={`${scopeLabel} · tap a cell to wager on a rank`}
      onToggle={onToggle}
    >
      <View style={S.headRow}>
        <Text style={[t.fieldLabel, S.nameCol]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Player</Text>
        {MARKET_RANKS.map(r => (
          <Text key={r} style={[t.fieldLabel, S.cellCol]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{MARKET_RANK_LABELS[r]}</Text>
        ))}
      </View>
      {visible.map(row => (
        <View key={row.user_id} style={S.row}>
          <FlairName
            name={row.full_name || 'Player'}
            nameColor={row.name_color}
            styleId={row.list_name_style_id}
            mode="list"
            style={[t.sub, S.nameCol, { color: c.text }]}
            numberOfLines={1}
          />
          {MARKET_RANKS.map(rank => (
            <TouchableOpacity
              key={rank}
              style={[S.cellCol, S.cell]}
              accessibilityRole="button"
              accessibilityLabel={`Wager on ${row.full_name || 'this player'} to finish rank ${rank}`}
              onPress={() => onWager(row, rank)}
            >
              <Text maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>🎲</Text>
            </TouchableOpacity>
          ))}
        </View>
      ))}
      {overflow ? (
        <TouchableOpacity style={S.more} onPress={() => setShowAll(v => !v)} accessibilityRole="button">
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {showAll ? `Show top ${MARKET_TOP_N}` : `Show ${sorted.length - MARKET_TOP_N} more`}
          </Text>
        </TouchableOpacity>
      ) : null}
    </CollapsibleSection>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    headRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: SPACE.xs },
    nameCol: { flex: 2.4, minWidth: 0 },
    cellCol: { flex: 1, textAlign: 'center' },
    cell: {
      minHeight: 44, alignItems: 'center', justifyContent: 'center',
      borderRadius: RADIUS.md, backgroundColor: c.primaryLight,
    },
    more: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  });
}
