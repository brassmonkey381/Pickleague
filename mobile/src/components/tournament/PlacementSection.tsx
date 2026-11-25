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
  // PKL-085 #8: playoff places and the rest under their own headings, never one mixed W-L table.
  const playoff = data.rows.filter(r => r.section === 'playoff');
  const rest = data.rows.filter(r => r.section === 'rest');
  const split = playoff.length > 0 && rest.length > 0;
  const row = (r: PlacementData['rows'][number], last: boolean) => {
    const n = Number(r.place);
    const line = r.detail || (r.decided ? r.from : `${r.from}, to play`);
    return (
      <View
        key={r.key}
        style={[styles.row, { borderBottomColor: c.border }, last && styles.lastRow,
          r.isMe && { backgroundColor: c.primaryLight, borderRadius: RADIUS.sm }]}
        accessibilityLabel={`Place ${r.place}${r.decided ? '' : ', to be decided'}. ${r.name}${r.isMe ? ' (you)' : ''}. ${line}`}
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
          <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{line}</Text>
        </View>
        {!r.detail ? <Text style={[t.sub, styles.wl, { color: c.text }]}>{r.wins}-{r.losses}</Text> : null}
      </View>
    );
  };
  const heading = (label: string) => (
    <Text style={[t.fieldLabel, styles.groupHead]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{label}</Text>
  );
  return (
    <SectionCard title={title}>
      <Text style={[t.meta, styles.note]} numberOfLines={3} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {data.note}
      </Text>
      {split ? heading('Playoff') : null}
      {(split ? playoff : data.rows).map((r, i, all) => row(r, i === all.length - 1))}
      {split ? heading(`Didn't reach the playoff, by ${rest.some(r => /^Pool /.test(r.detail)) ? 'pool' : 'round robin'} finish`) : null}
      {split ? rest.map((r, i) => row(r, i === rest.length - 1)) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  note: { marginBottom: SPACE.xs },
  row: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs, borderBottomWidth: HAIRLINE,
  },
  groupHead: { marginTop: SPACE.sm, marginBottom: SPACE.xxs },
  lastRow: { borderBottomWidth: 0 },
  place: { width: 32 },
  name: { flex: 1, minWidth: 0 },
  strong: { fontWeight: FONT.weight.bold },
  wl: { width: 56, textAlign: 'right' },
});
