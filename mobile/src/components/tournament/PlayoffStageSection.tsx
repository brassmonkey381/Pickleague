// PKL-041: the medal stage. The Final and the Third Place Match are one
// stage, drawn together and playable in either order, so they sit side by
// side (wrapping to a stack on narrow phones) with no arrow or order between
// them. Each card names both sides (both partners for doubles), the score
// once played, and opens score entry for whoever may record it.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useTheme } from '../../lib/ThemeContext';
import SectionCard from './SectionCard';
import { canRecordMatch, involves, type ScheduleMatch } from './tournamentModel';

type Props = {
  final: ScheduleMatch;
  third: ScheduleMatch | null;
  myUserId: string | null;
  isPriv: boolean;
  playerName: (id: string | undefined) => string;
  onRecord: (m: ScheduleMatch) => void;
};

export default function PlayoffStageSection({ final, third, myUserId, isPriv, playerName, onRecord }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const both = !!third;
  const done = [final, third].filter(Boolean).every(m => m!.status === 'completed');

  const side = (p1: string | null, p2: string | null) =>
    p1 ? [p1, p2].filter(Boolean).map(id => playerName(id!)).join(' & ') : 'To be decided';

  const card = (m: ScheduleMatch, label: string, places: string, trophy: boolean) => {
    const completed = m.status === 'completed';
    const t1Won = completed && m.winner_team === 'team1';
    const t2Won = completed && m.winner_team === 'team2';
    const mine = involves(m, myUserId);
    const tappable = canRecordMatch(m, { isPriv, myUserId });
    const line = (name: string, score: number | null | undefined, won: boolean, lost: boolean) => (
      <View style={styles.sideRow}>
        <Text
          style={[t.sub, styles.sideName, { color: lost ? c.textSub : c.text }, won && styles.strong]}
          numberOfLines={2}
        >
          {name}
        </Text>
        {completed ? (
          <Text style={[t.sub, styles.score, { color: c.text }, won && styles.strong]}>{score ?? '-'}</Text>
        ) : null}
      </View>
    );
    const body = (
      <>
        <View style={styles.head}>
          {trophy ? <Icon name="trophy" size={12} color={c.rarityLegendary} /> : null}
          <Text style={[t.label, styles.shrink]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{label}</Text>
          <Text style={[t.meta, { color: c.textMuted }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{places}</Text>
        </View>
        {line(side(m.team1_player1, m.team1_player2), m.team1_score, t1Won, t2Won)}
        <Text style={[t.meta, { color: c.textMuted }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>vs</Text>
        {line(side(m.team2_player1, m.team2_player2), m.team2_score, t2Won, t1Won)}
        <View style={styles.foot}>
          <Text style={[t.meta, { color: completed ? c.success : c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {completed ? 'Played' : tappable ? 'Tap to record' : 'To play'}
          </Text>
          {mine ? <Text style={[t.meta, { color: c.primary }, styles.strong]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>You</Text> : null}
        </View>
      </>
    );
    const style = [
      styles.card,
      { borderColor: trophy ? c.rarityLegendary : c.border, backgroundColor: completed ? c.successLight : c.surface },
      mine && { borderColor: c.primary },
    ];
    if (tappable) {
      return (
        <TouchableOpacity
          key={m.id}
          style={style}
          onPress={() => onRecord(m)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Record the ${label}: ${side(m.team1_player1, m.team1_player2)} versus ${side(m.team2_player1, m.team2_player2)}`}
        >
          {body}
        </TouchableOpacity>
      );
    }
    return <View key={m.id} style={style}>{body}</View>;
  };

  return (
    <SectionCard title="Medal matches" count={done ? 'done' : undefined}>
      {both ? (
        <Text style={[t.meta, styles.note]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          One stage. Play them at the same time or in any order.
        </Text>
      ) : null}
      <View style={styles.grid}>
        {card(final, 'Final', '1st and 2nd', true)}
        {third ? card(third, '3rd place match', '3rd and 4th', false) : null}
      </View>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  note: { marginBottom: SPACE.xs },
  // Side by side when there's room; each card wraps to its own line below
  // ~2 x 140px (narrow phones), so neither reads as "first".
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  card: {
    flexGrow: 1, flexBasis: 140, minWidth: 0, minHeight: 44,
    borderWidth: HAIRLINE, borderRadius: RADIUS.md,
    paddingVertical: SPACE.sm, paddingHorizontal: SPACE.sm, gap: SPACE.xxs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, marginBottom: SPACE.xxs },
  shrink: { flexShrink: 1, flexGrow: 1, minWidth: 0 },
  sideRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  sideName: { flex: 1, minWidth: 0 },
  score: { minWidth: 24, textAlign: 'right' },
  strong: { fontWeight: FONT.weight.bold },
  foot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.xxs },
});
