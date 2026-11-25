// PKL-085 option A (Brian 2026-11-25): the MLP Playoff section once the playoff is drawn. Champion banner, the
// podium (1-3 as team badges, then 4th), the Final as a team-v-team tile with per-game chips (highlighted), the
// 3rd-place match, the earlier rounds compact, then the teams that didn't reach the playoff by pool finish. The
// locked "Pool play, final" tables sit below this section (TournamentDetailScreen). No tie text anywhere.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { RADIUS, SPACE, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { RankMedal } from '@just-messin-around/expo-foundation/ui';
import { useTheme } from '../../lib/ThemeContext';
import SectionCard from './SectionCard';
import { teamBadge, type MatchupTile, type MlpPlayoffView } from '../../lib/mlpPlayoffView';

const ROUND_TITLE: Record<string, string> = { semifinals: 'Semifinals', quarterfinals: 'Quarterfinals' };

const SlotContext = React.createContext<Record<string, number>>({});

function Badge({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const slots = React.useContext(SlotContext);
  const b = teamBadge(id, name, slots[id]);
  return (
    <View style={[styles.badge, { width: size, height: size, borderRadius: size / 2, backgroundColor: b.color }]} accessibilityElementsHidden>
      <Text style={[styles.badgeText, { color: b.darkText ? '#1d2b22' : '#ffffff' }]} maxFontSizeMultiplier={1.2}>{b.initials}</Text>
    </View>
  );
}

function Tile({ tile, highlight, compact, myTeamId }: { tile: MatchupTile; highlight?: boolean; compact?: boolean; myTeamId: string | null }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const dimA = tile.winner === 'b', dimB = tile.winner === 'a';
  const label = `${tile.a.name} ${tile.aWins}, ${tile.b.name} ${tile.bWins}${tile.winner ? `. ${tile.winner === 'a' ? tile.a.name : tile.b.name} won` : ', in progress'}`;
  if (compact) {
    return (
      <View style={[styles.compact, { borderTopColor: c.border }]} accessibilityLabel={label}>
        <Text style={[t.sub, styles.flex, { color: c.text }, dimA && styles.dim]} numberOfLines={1}>{tile.a.name}{tile.a.id === myTeamId ? ' (you)' : ''}</Text>
        <Text style={[t.sub, styles.score, { color: c.text }]}>{tile.aWins}-{tile.bWins}</Text>
        <Text style={[t.sub, styles.flex, styles.right, { color: c.text }, dimB && styles.dim]} numberOfLines={1}>{tile.b.name}{tile.b.id === myTeamId ? ' (you)' : ''}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.tile, { backgroundColor: c.surface, borderColor: highlight ? c.primary : c.border }, highlight && styles.tileHl]} accessibilityLabel={label}>
      <View style={styles.vs}>
        <View style={[styles.side, dimA && styles.dim]}>
          <Badge id={tile.a.id} name={tile.a.name} />
          <Text style={[t.sub, styles.sideName, { color: c.text }]} numberOfLines={2}>{tile.a.name}{tile.a.id === myTeamId ? ' (you)' : ''}</Text>
        </View>
        <Text style={[styles.bigScore, { color: c.text }]}>{tile.aWins}-{tile.bWins}</Text>
        <View style={[styles.side, styles.sideRight, dimB && styles.dim]}>
          <Text style={[t.sub, styles.sideName, styles.right, { color: c.text }]} numberOfLines={2}>{tile.b.name}{tile.b.id === myTeamId ? ' (you)' : ''}</Text>
          <Badge id={tile.b.id} name={tile.b.name} />
        </View>
      </View>
      <View style={styles.chips}>
        {tile.games.map(g => (
          <View key={g.label} style={[styles.chip, {
            backgroundColor: g.winner == null ? c.border : g.winner === 1 ? c.success : c.danger + '26',
          }]}>
            <Text style={[styles.chipText, { color: g.winner === 1 ? c.textInverse : g.winner === 2 ? c.danger : c.textSub }]} maxFontSizeMultiplier={1.2}>
              {g.label}{g.s1 != null && g.s2 != null ? ` ${g.s1}-${g.s2}` : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export default function MlpPlayoffMap({ view, myTeamId }: { view: MlpPlayoffView; myTeamId: string | null }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const sub = (s: string) => <Text style={[t.fieldLabel, styles.subHead, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{s}</Text>;
  return (
    <SlotContext.Provider value={view.colorSlot}>
    <View style={styles.wrap}>
      {view.champion ? (
        <View style={[styles.banner, { backgroundColor: c.primary }]} accessibilityRole="header">
          <Text style={[styles.bannerTag, { color: c.textInverse }]}>CHAMPIONS</Text>
          <Text style={[styles.bannerName, { color: c.textInverse }]}>{view.champion.name}{view.champion.id === myTeamId ? ' (you)' : ''}</Text>
          <Text style={[t.sub, { color: c.textInverse }]}>{view.champion.line}</Text>
        </View>
      ) : null}
      <SectionCard title="Playoff">
        {view.podium.length ? (
          <>
            <Text style={[t.meta, { color: c.textSub }]}>Final places 1-4 come from these matchups.</Text>
            <View style={styles.podium}>
              {view.podium.map(p => (
                <View key={p.id} style={[styles.podiumCell, { borderColor: c.border }, p.id === myTeamId && { backgroundColor: c.primaryLight }]}>
                  <RankMedal place={p.place} />
                  <Badge id={p.id} name={p.name} size={36} />
                  <Text style={[t.meta, styles.center, { color: c.text }]} numberOfLines={2}>{p.name}</Text>
                </View>
              ))}
            </View>
            {view.fourth ? <Text style={[t.sub, { color: c.textSub }]}>4th {view.fourth.name}</Text> : null}
          </>
        ) : null}
        {view.final ? <>{sub('Final')}<Tile tile={view.final} highlight myTeamId={myTeamId} /></> : null}
        {view.third ? <>{sub('3rd-place match')}<Tile tile={view.third} myTeamId={myTeamId} /></> : null}
        {view.earlier.map(g => (
          <View key={g.roundType}>
            {sub(ROUND_TITLE[g.roundType] ?? 'Playoff')}
            {g.tiles.map(tile => <Tile key={tile.key} tile={tile} compact={!!view.final} myTeamId={myTeamId} />)}
          </View>
        ))}
        {view.rest.length ? (
          <>
            {sub('Didn\'t reach the playoff, by pool finish')}
            {view.rest.map(r => (
              <View key={r.id} style={[styles.restRow, { borderTopColor: c.border }, r.id === myTeamId && { backgroundColor: c.primaryLight, borderRadius: RADIUS.sm }]}>
                <Text style={[t.meta, styles.restPlace, { color: c.textSub }]}>{r.place}</Text>
                <Badge id={r.id} name={r.name} />
                <View style={styles.flex}>
                  <Text style={[t.sub, { color: c.text }]} numberOfLines={1}>{r.name}{r.id === myTeamId ? ' (you)' : ''}</Text>
                  <Text style={[t.meta, { color: c.textSub }]} numberOfLines={1}>{r.detail}</Text>
                </View>
              </View>
            ))}
          </>
        ) : null}
      </SectionCard>
    </View>
    </SlotContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACE.md },
  banner: { borderRadius: RADIUS.lg, padding: SPACE.lg, alignItems: 'center', gap: SPACE.xxs },
  bannerTag: { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, letterSpacing: 1 },
  bannerName: { fontSize: FONT.size.xl, fontWeight: FONT.weight.bold, textAlign: 'center' },
  subHead: { marginTop: SPACE.sm, marginBottom: SPACE.xxs },
  podium: { flexDirection: 'row', gap: SPACE.xs, marginTop: SPACE.xs },
  podiumCell: { flex: 1, alignItems: 'center', gap: SPACE.xxs, padding: SPACE.xs, borderWidth: HAIRLINE, borderRadius: RADIUS.md },
  center: { textAlign: 'center' },
  tile: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, gap: SPACE.xs },
  tileHl: { borderWidth: 2 },
  vs: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minWidth: 0 },
  sideRight: { justifyContent: 'flex-end' },
  sideName: { flexShrink: 1, fontWeight: FONT.weight.bold },
  bigScore: { fontSize: FONT.size.xl, fontWeight: FONT.weight.bold, fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'center' },
  chip: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  chipText: { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, fontVariant: ['tabular-nums'] },
  compact: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingVertical: SPACE.xs, borderTopWidth: HAIRLINE },
  flex: { flex: 1, minWidth: 0 },
  right: { textAlign: 'right' },
  score: { fontWeight: FONT.weight.bold, fontVariant: ['tabular-nums'] },
  dim: { opacity: 0.45 },
  restRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xs, paddingHorizontal: SPACE.xxs, borderTopWidth: HAIRLINE },
  restPlace: { width: 20 },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 10, fontWeight: FONT.weight.bold },
});
