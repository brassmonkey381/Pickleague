// The season status strip on LeagueDetail (plan section 5, slot 3):
//
//   Fall · Wk 7 of 12 · You #2 · locks Oct 20                 ›   56
//   #1  Alice                                   5-1    3.82       44
//   #2  You                                     4-2    3.71       44
//   #3  Bob                                     3-3    3.55       44
//   (#5 You, when you're below the top 3)                         44
//
// The whole strip is ONE pressable that opens SeasonStandings: a single tap
// target with a single label is easier on a screen reader than five rows that
// all go to the same place. Numbers come from lib/seasonSummary.ts, which ranks
// exactly like SeasonStandings' live tab.
//
// No season:
//   - privileged viewer: one 44 line, "No active season · Start in Manage";
//   - anyone else: nothing (an empty section doesn't render, plan section 6).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Panel } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, SPACE, SMALL_TEXT_MAX_SCALE, RADIUS } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { seasonHeadline, shortDate, type SeasonStandingRow, type SeasonSummary } from '../lib/seasonSummary';

export type SeasonStripProps = {
  /** null = no active or upcoming season. */
  summary: SeasonSummary | null;
  /** Admin / co-admin: sees the "Start in Manage" line when there's no season. */
  privileged: boolean;
  myUserId: string | null;
  /** Opens SeasonStandings for the strip's season. */
  onOpen: () => void;
  /** The privileged no-season line (opens the season setup). */
  onStartSeason?: () => void;
};

export default function SeasonStrip({ summary, privileged, myUserId, onOpen, onStartSeason }: SeasonStripProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);

  if (!summary) {
    if (!privileged || !onStartSeason) return null;
    return (
      <TouchableOpacity
        onPress={onStartSeason}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel="No active season. Start one in Manage."
        style={[styles.emptyLine, { borderColor: c.border, backgroundColor: c.surface }]}
      >
        <Text style={[t.sub, styles.flex]} numberOfLines={1}>
          No active season · <Text style={{ color: c.primary, fontWeight: FONT.weight.bold }}>Start in Manage</Text>
        </Text>
        <Text style={[styles.chevron, { color: c.textMuted }]}>›</Text>
      </TouchableOpacity>
    );
  }

  const headline = seasonHeadline(summary, shortDate, { privileged });
  const rows: SeasonStandingRow[] = summary.me ? [...summary.top, summary.me] : summary.top;

  return (
    <TouchableOpacity
      onPress={onOpen}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${headline}. Open season standings.`}
    >
      <Panel padded={false}>
        <View style={styles.head}>
          <Text style={[t.title, styles.flex]} numberOfLines={2}>{headline}</Text>
          <Text style={[styles.chevron, { color: c.textMuted }]}>›</Text>
        </View>
        {rows.map((r, i) => {
          const mine = !!myUserId && r.user_id === myUserId;
          const gap = summary.me && i === rows.length - 1;
          return (
            <View
              key={r.user_id}
              style={[
                styles.row,
                { borderTopColor: c.border },
                mine && { backgroundColor: c.primaryLight },
                i === rows.length - 1 && styles.lastRow,
                gap && styles.gapRow,
              ]}
            >
              <Text style={[t.meta, styles.rank, mine && { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                #{r.rank}
              </Text>
              <Text style={[t.sub, styles.flex, { color: c.text }, mine && styles.bold]} numberOfLines={1}>
                {mine ? 'You' : r.full_name}
              </Text>
              <Text style={[t.meta, styles.num]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {r.wins}-{r.losses}
              </Text>
              <Text style={[t.meta, styles.num, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {r.rating.toFixed(2)}
              </Text>
            </View>
          );
        })}
      </Panel>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  head: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    paddingHorizontal: SPACE.md,
    borderTopWidth: HAIRLINE,
  },
  // The Panel's 14 radius clips nothing on its own; round the last row's tint to match.
  lastRow: { borderBottomLeftRadius: RADIUS.lg, borderBottomRightRadius: RADIUS.lg },
  // "Your row" under the top 3 is not adjacent in rank: a heavier rule says so.
  gapRow: { borderTopWidth: HAIRLINE * 3 },
  rank: { minWidth: 28 },
  num: { minWidth: 36, textAlign: 'right' },
  bold: { fontWeight: FONT.weight.bold },
  chevron: { fontSize: FONT.size.h2, fontWeight: FONT.weight.bold },
  emptyLine: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.lg,
    borderWidth: HAIRLINE,
  },
});
