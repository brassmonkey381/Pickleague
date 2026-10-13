// Standings for EVERY format (plan section 5, active / completed): one table,
// or one per pool, built by standingsData.ts from lib/tournamentStandings.ts.
// Long tables show the top rows with the viewer's row pinned underneath
// ("… #9 You") and a "Show all (N)" toggle.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { pinMyRow } from '../../lib/tournamentStandings';
import SectionCard from './SectionCard';
import type { StandingRow, StandingsData } from './standingsData';

/** Rows shown before "Show all" on a single long table. */
const TOP_ROWS = 8;

export default function StandingsSection({ data, title }: { data: StandingsData; title: string }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [showAll, setShowAll] = useState(false);
  const single = data.tables.length === 1;
  const showDiff = data.kind === 'team';

  const header = (
    <View style={[styles.row, styles.headRow, { borderBottomColor: c.border }]}>
      <Text style={[t.fieldLabel, styles.rank]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>#</Text>
      <Text style={[t.fieldLabel, styles.name]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{data.entrantLabel}</Text>
      <Text style={[t.fieldLabel, styles.wl]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{data.recordLabel}</Text>
      {showDiff && <Text style={[t.fieldLabel, styles.diff]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>±</Text>}
    </View>
  );

  const renderRow = (r: StandingRow, position: number, last: boolean) => {
    const diff = (r.pf ?? 0) - (r.pa ?? 0);
    return (
      <View
        key={r.key}
        style={[
          styles.row,
          { borderBottomColor: c.border },
          last && styles.lastRow,
          r.isMe && { backgroundColor: c.primaryLight, borderRadius: RADIUS.sm },
        ]}
        accessibilityLabel={`${position}. ${r.name}${r.isMe ? ' (you)' : ''}, ${r.wins} and ${r.losses}`}
      >
        <Text style={[t.meta, styles.rank]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{position}</Text>
        <Text style={[t.sub, styles.name, { color: r.isMe ? c.primary : c.text }, r.isMe && styles.strong]} numberOfLines={1}>
          {r.name}{r.isMe ? ' (you)' : ''}
        </Text>
        <Text style={[t.sub, styles.wl, { color: c.text }]}>{r.wins}-{r.losses}</Text>
        {showDiff && (
          <Text style={[t.sub, styles.diff, { color: diff > 0 ? c.success : diff < 0 ? c.danger : c.textSub }]}>
            {diff > 0 ? `+${diff}` : diff}
          </Text>
        )}
      </View>
    );
  };

  return (
    <SectionCard title={title}>
      <Text style={[t.meta, styles.note]} numberOfLines={2} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {data.note}
      </Text>
      {data.tables.map(tbl => {
        if (single && !showAll) {
          const { top, pinned, hidden } = pinMyRow(tbl.rows, TOP_ROWS);
          return (
            <View key={tbl.key}>
              {header}
              {top.map((x, i) => renderRow(x.row, x.position, i === top.length - 1 && !pinned))}
              {pinned ? (
                <>
                  <Text style={[t.meta, styles.gap]}>⋯</Text>
                  {renderRow(pinned.row, pinned.position, true)}
                </>
              ) : null}
              {hidden > 0 ? (
                <TouchableOpacity
                  onPress={() => setShowAll(true)}
                  style={styles.more}
                  accessibilityRole="button"
                >
                  <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                    Show all ({tbl.rows.length})
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        }
        return (
          <View key={tbl.key} style={!single && styles.poolBlock}>
            {tbl.label ? <Text style={[t.label, styles.poolLabel]}>{tbl.label}</Text> : null}
            {header}
            {tbl.rows.map((r, i) => renderRow(r, i + 1, i === tbl.rows.length - 1))}
            {tbl.rows.length === 0 ? <Text style={[t.hint, styles.gap]}>No entrants yet.</Text> : null}
          </View>
        );
      })}
      {single && showAll && data.tables[0].rows.length > TOP_ROWS ? (
        <TouchableOpacity onPress={() => setShowAll(false)} style={styles.more} accessibilityRole="button">
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            Show top {TOP_ROWS}
          </Text>
        </TouchableOpacity>
      ) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  note: { marginBottom: SPACE.xs },
  row: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    paddingHorizontal: SPACE.xs, borderBottomWidth: HAIRLINE,
  },
  headRow: { minHeight: 32 },
  lastRow: { borderBottomWidth: 0 },
  rank: { width: 24 },
  name: { flex: 1, minWidth: 0 },
  strong: { fontWeight: FONT.weight.bold },
  wl: { width: 56, textAlign: 'right' },
  diff: { width: 44, textAlign: 'right' },
  gap: { paddingVertical: SPACE.xs, paddingHorizontal: SPACE.xs },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  poolBlock: { marginTop: SPACE.sm },
  poolLabel: { paddingVertical: SPACE.xs },
});
