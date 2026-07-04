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
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
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

type Props = { stages: FlowOverviewStage[] };

export default function TournamentFlowOverview({ stages }: Props) {
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
    return (
      <View
        key={s.key}
        style={[
          S.card,
          done && S.cardDone,
          !s.exists && S.cardUpcoming,
          final && S.cardFinal,
        ]}
      >
        <Text style={[S.cardLabel, final && S.cardLabelFinal]} numberOfLines={1}>
          {final ? '🏆 ' : ''}{s.label.toUpperCase()}
        </Text>
        <Text style={[S.cardCount, !s.exists && S.cardCountUpcoming]}>
          {s.completed}/{s.total}
        </Text>
        <Text style={S.cardSub} numberOfLines={1}>
          {done ? '✓ complete'
            : started ? 'in progress'
            : s.exists ? 'ready to play'
            : 'upcoming'}
          {s.byes > 0 ? ` · ${s.byes} bye${s.byes === 1 ? '' : 's'}` : ''}
        </Text>
      </View>
    );
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

const makeStyles = (c: any) => StyleSheet.create({
  row: { alignItems: 'center', paddingVertical: 4, paddingHorizontal: 2 },
  groupColumn: { gap: 6 },
  playoffColumn: { justifyContent: 'center' },
  arrow: { fontSize: 16, color: c.textMuted, marginHorizontal: 6 },
  card: {
    width: 118,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surface,
    paddingVertical: 7,
    paddingHorizontal: 9,
  },
  cardDone:     { borderColor: '#2e7d32', backgroundColor: '#2e7d3211' },
  cardUpcoming: { borderStyle: 'dashed', opacity: 0.65 },
  cardFinal:    { borderColor: '#b8860b' },
  cardLabel:      { fontSize: 10, fontWeight: '800', letterSpacing: 0.4, color: c.textSub },
  cardLabelFinal: { color: '#b8860b' },
  cardCount:         { fontSize: 17, fontWeight: '800', color: c.text, marginTop: 1 },
  cardCountUpcoming: { color: c.textMuted },
  cardSub: { fontSize: 10, color: c.textMuted, marginTop: 1 },
});
