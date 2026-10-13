/**
 * TournamentFlowOverview — a compact, generalized "how this tournament flows"
 * strip: group stages (Pool A/B/C… or the round-robin schedule) stacked on
 * the far left, then one card per playoff/elimination stage, left to right.
 *
 * Every EXPECTED stage renders from the moment the bracket is locked in —
 * stages whose rounds the DB hasn't created yet show as dashed "upcoming"
 * cards with their predicted match counts (see lib/tournamentFlow.ts), so
 * players can see the whole road to the final up front.
 *
 *   [POOL A 3/3 ✓]
 *   [POOL B 2/3 ▶]  →  [QUARTERFINALS 0/4 · 2 byes]  →  [SEMIS 0/2]  →  [🏆 FINALS 0/1]
 *   [POOL C 3/3 ✓]
 *
 * UI compaction P5b: the cards double as a stage filter. With `onPressStage`,
 * a card whose round exists is a 44px-min button that filters the schedule to
 * that round (tap again to clear); `selectedKey` marks the active one.
 * Upcoming (predicted) cards stay inert: there is nothing to list yet. Token
 * sweep: SPACE / RADIUS, theme colours, FONT sizes only.
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';

export type FlowOverviewStage = {
  key: string;
  label: string;
  kind: 'group' | 'playoff';
  /** Whether the DB round for this stage exists yet. */
  exists: boolean;
  total: number;      // schedule rows (matches + bye slots)
  completed: number;  // completed rows (byes auto-complete)
  byes: number;
};

type Props = {
  stages: FlowOverviewStage[];
  /** Makes existing stages tappable (the schedule's round filter). */
  onPressStage?: (key: string) => void;
  /** The stage currently filtering the schedule. */
  selectedKey?: string | null;
};

export default function TournamentFlowOverview({ stages, onPressStage, selectedKey }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const groups   = stages.filter(s => s.kind === 'group');
  const playoffs = stages.filter(s => s.kind === 'playoff');
  const isFinalStage = (s: FlowOverviewStage) =>
    playoffs.length > 0 && s.key === playoffs[playoffs.length - 1].key && /final/i.test(s.label);

  function card(s: FlowOverviewStage) {
    const done = s.exists && s.total > 0 && s.completed >= s.total;
    const started = s.exists && s.completed > 0;
    const final = isFinalStage(s);
    const selected = !!selectedKey && selectedKey === s.key;
    const status = done ? '✓ complete'
      : started ? 'in progress'
      : s.exists ? 'ready to play'
      : 'upcoming';
    const body = (
      <>
        <Text
          style={[S.cardLabel, final && S.cardLabelFinal]}
          numberOfLines={1}
          maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        >
          {final ? '🏆 ' : ''}{s.label.toUpperCase()}
        </Text>
        <Text style={[S.cardCount, !s.exists && S.cardCountUpcoming]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {s.completed}/{s.total}
        </Text>
        <Text style={S.cardSub} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {status}
          {s.byes > 0 ? ` · ${s.byes} bye${s.byes === 1 ? '' : 's'}` : ''}
        </Text>
      </>
    );
    const style = [
      S.card,
      done && S.cardDone,
      !s.exists && S.cardUpcoming,
      final && S.cardFinal,
      selected && S.cardSelected,
    ];
    if (onPressStage && s.exists) {
      return (
        <TouchableOpacity
          key={s.key}
          style={style}
          onPress={() => onPressStage(s.key)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={`${s.label}, ${s.completed} of ${s.total} played, ${status}. ${selected ? 'Showing only this round; tap to show all' : 'Show only this round'}`}
        >
          {body}
        </TouchableOpacity>
      );
    }
    return <View key={s.key} style={style}>{body}</View>;
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={S.row}>
      {groups.length > 0 && (
        <View style={S.groupColumn}>{groups.map(card)}</View>
      )}
      {playoffs.map((s, i) => (
        <React.Fragment key={s.key}>
          {(groups.length > 0 || i > 0) && <Text style={S.arrow}>→</Text>}
          <View style={S.playoffColumn}>{card(s)}</View>
        </React.Fragment>
      ))}
    </ScrollView>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  row: { alignItems: 'center', paddingVertical: SPACE.xs, paddingHorizontal: SPACE.xxs },
  groupColumn: { gap: SPACE.xs },
  playoffColumn: { justifyContent: 'center' },
  arrow: { fontSize: FONT.size.lg, color: c.textMuted, marginHorizontal: SPACE.xs },
  card: {
    width: 118,
    minHeight: 44,
    borderRadius: RADIUS.md,
    borderWidth: HAIRLINE,
    borderColor: c.border,
    backgroundColor: c.surface,
    paddingVertical: SPACE.xs,
    paddingHorizontal: SPACE.sm,
  },
  cardDone:     { borderColor: c.success, backgroundColor: c.successLight },
  cardUpcoming: { borderStyle: 'dashed', opacity: 0.65 },
  cardFinal:    { borderColor: c.rarityLegendary },
  // A selected stage gets the brand edge, drawn 2px so it reads over "done".
  cardSelected: { borderColor: c.primary, borderWidth: 2, backgroundColor: c.primaryLight },
  cardLabel:      { fontSize: FONT.size.xxs, fontWeight: FONT.weight.heavy, letterSpacing: 0.4, color: c.textSub },
  cardLabelFinal: { color: c.rarityLegendary },
  cardCount:         { fontSize: FONT.size.xl, fontWeight: FONT.weight.heavy, color: c.text, marginTop: SPACE.xxs },
  cardCountUpcoming: { color: c.textMuted },
  cardSub: { fontSize: FONT.size.xxs, color: c.textMuted, marginTop: SPACE.xxs },
});
