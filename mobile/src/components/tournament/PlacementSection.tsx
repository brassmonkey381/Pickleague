// PKL-037: the final placement table, separate from the round-robin
// standings. Rows come from standingsData (stored ranks once completed,
// otherwise the provisional placement from lib/tournamentPlacement.ts).
// Each row says what decided the place (Final, 3rd place match, Round robin).
// A place still waiting on its match shows its range ("1-2") muted.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { HAIRLINE, RADIUS, SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { RankMedal } from '@just-messin-around/expo-foundation/ui';
import { useTheme } from '../../lib/ThemeContext';
import SectionCard from './SectionCard';
import type { PlacementData } from './standingsData';

export default function PlacementSection({ data, entrantLabel, title }: {
  data: PlacementData;
  entrantLabel: string;
  title: string;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <SectionCard title={title}>
      <Text style={[t.meta, styles.note]} numberOfLines={2} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {data.note}
      </Text>
      <View style={[styles.row, styles.headRow, { borderBottomColor: c.border }]}>
        <Text style={[t.fieldLabel, styles.place]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>#</Text>
        <Text style={[t.fieldLabel, styles.name]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{entrantLabel}</Text>
        <Text style={[t.fieldLabel, styles.wl]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>W-L</Text>
      </View>
      {data.rows.map((r, i) => {
        const n = Number(r.place);
        const last = i === data.rows.length - 1;
        return (
          <View
            key={r.key}
            style={[
              styles.row,
              { borderBottomColor: c.border },
              last && styles.lastRow,
              r.isMe && { backgroundColor: c.primaryLight, borderRadius: RADIUS.sm },
            ]}
            accessibilityLabel={`Place ${r.place}${r.decided ? '' : ', to be decided'}. ${r.name}${r.isMe ? ' (you)' : ''}. From ${r.from}. ${r.wins} and ${r.losses}`}
          >
            <View style={styles.place}>
              {r.decided && Number.isFinite(n) ? (
                <RankMedal place={n} />
              ) : (
                <Text style={[t.meta, { color: c.textMuted }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{r.place}</Text>
              )}
            </View>
            <View style={styles.name}>
              <Text style={[t.sub, { color: r.isMe ? c.primary : c.text }, r.isMe && styles.strong]} numberOfLines={2}>
                {r.name}{r.isMe ? ' (you)' : ''}
              </Text>
              <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {r.decided ? r.from : `${r.from}, to play`}
              </Text>
            </View>
            <Text style={[t.sub, styles.wl, { color: c.text }]}>{r.wins}-{r.losses}</Text>
          </View>
        );
      })}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  note: { marginBottom: SPACE.xs },
  row: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs, borderBottomWidth: HAIRLINE,
  },
  headRow: { minHeight: 32 },
  lastRow: { borderBottomWidth: 0 },
  place: { width: 32 },
  name: { flex: 1, minWidth: 0 },
  strong: { fontWeight: FONT.weight.bold },
  wl: { width: 56, textAlign: 'right' },
});
