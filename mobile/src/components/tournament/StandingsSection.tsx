// Standings for EVERY format (plan section 5, active / completed): one table,
// or one per pool, built by standingsData.ts from lib/tournamentStandings.ts.
// Long tables show the top rows with the viewer's row pinned underneath
// ("… #9 You") and a "Show all (N)" toggle.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { RankMedal } from '@just-messin-around/expo-foundation/ui';
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
  // PKL-040: tie notes under tied rows, behind one toggle.
  const [showTies, setShowTies] = useState(false);
  const single = data.tables.length === 1;
  const showDiff = data.kind === 'team';
  const tieCount = data.tables.reduce((n, tbl) => n + Object.keys(tbl.ties ?? {}).length, 0);

  const header = (
    <View style={[styles.row, styles.headRow, { borderBottomColor: c.border }]}>
      <Text style={[t.fieldLabel, styles.rank]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>#</Text>
      <Text style={[t.fieldLabel, styles.name]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{data.entrantLabel}</Text>
      <Text style={[t.fieldLabel, styles.wl]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{data.recordLabel}</Text>
      {showDiff && <Text style={[t.fieldLabel, styles.diff]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>±</Text>}
    </View>
  );

  const renderRow = (r: StandingRow, position: number, last: boolean, tie?: string) => {
    const diff = (r.pf ?? 0) - (r.pa ?? 0);
    const tieShown = showTies && !!tie;
    return (
      <View key={r.key}>
      <View
        style={[
          styles.row,
          { borderBottomColor: c.border },
          (last || tieShown) && styles.lastRow,
          r.isMe && { backgroundColor: c.primaryLight, borderRadius: RADIUS.sm },
        ]}
        accessibilityLabel={`${position}. ${r.name}${r.isMe ? ' (you)' : ''}, ${r.wins} and ${r.losses}`}
      >
        {/* Places 1-3 as medal discs, 4+ as the plain number in the same box
            width (RankMedal), so the column lines up; the row label reads it. */}
        <View style={styles.rank}>
          <RankMedal place={position} />
        </View>
        <Text style={[t.sub, styles.name, { color: r.isMe ? c.primary : c.text }, r.isMe && styles.strong]} numberOfLines={2}>
          {r.name}{r.isMe ? ' (you)' : ''}
          {tie && !showTies ? <Text style={[t.meta, { color: c.textMuted }]}>{'  tied'}</Text> : null}
        </Text>
        <Text style={[t.sub, styles.wl, { color: c.text }]}>{r.wins}-{r.losses}</Text>
        {showDiff && (
          <Text style={[t.sub, styles.diff, { color: diff > 0 ? c.success : diff < 0 ? c.danger : c.textSub }]}>
            {diff > 0 ? `+${diff}` : diff}
          </Text>
        )}
      </View>
      {tieShown ? (
        <Text
          style={[t.meta, styles.tieLine, { color: c.textSub, borderBottomColor: c.border }, last && styles.lastRow]}
          maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        >
          {tie}
        </Text>
      ) : null}
      </View>
    );
  };

  return (
    <SectionCard title={title}>
      <Text style={[t.meta, styles.note]} numberOfLines={2} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {data.note}
      </Text>
      {tieCount > 0 ? (
        <TouchableOpacity
          onPress={() => setShowTies(v => !v)}
          style={styles.tieToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: showTies }}
          accessibilityLabel={showTies ? 'Hide tiebreaks' : 'Show how ties were broken'}
        >
          <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {showTies ? 'Hide tiebreaks' : `Show tiebreaks (${tieCount} tied)`}
          </Text>
        </TouchableOpacity>
      ) : null}
      {data.tables.map(tbl => {
        if (single && !showAll) {
          const { top, pinned, hidden } = pinMyRow(tbl.rows, TOP_ROWS);
          return (
            <View key={tbl.key}>
              {header}
              {top.map((x, i) => renderRow(x.row, x.position, i === top.length - 1 && !pinned, tbl.ties?.[x.row.key]))}
              {pinned ? (
                <>
                  <View style={styles.gap}>
                    <Icon name="more" size={16} color={c.textMuted} />
                  </View>
                  {renderRow(pinned.row, pinned.position, true, tbl.ties?.[pinned.row.key])}
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
            {tbl.rows.map((r, i) => renderRow(r, i + 1, i === tbl.rows.length - 1, tbl.ties?.[r.key]))}
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
  tieToggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  tieLine: { paddingHorizontal: SPACE.xs, paddingBottom: SPACE.xs, paddingLeft: 24 + SPACE.sm + SPACE.xs, borderBottomWidth: HAIRLINE },
});
