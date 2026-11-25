// PKL-090 DEV-ONLY: the golden screens Brian reviews. Renders the REAL Standings card (StandingsSection) and You card
// (TournamentYouCard) for each sample moment in lib/__dev__/goldenSamples.ts, plus the MLP Playoff block's standings
// (lib/mlpStandings, the function MlpPlayoffPreview uses). Each moment sits in a phone-width frame with
// testID "golden-<id>" so a script can screenshot it. No sign-in, no reads or writes: everything is local data.
// Registered only when __DEV__ (AppNavigator), at /dev/goldens on the web.
import React from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import StandingsSection from '../components/tournament/StandingsSection';
import PlacementSection from '../components/tournament/PlacementSection';
import TournamentYouCard, { youCardView, type YouCardFacts } from '../components/tournament/TournamentYouCard';
import { buildStandings, myStanding } from '../components/tournament/standingsData';
import { mlpPoolGroups } from '../lib/mlpStandings';
import { waitReason } from '../lib/waitReason';
import { goldenMoments, type GoldenMoment } from '../lib/__dev__/goldenSamples';

const noop = () => {};

function facts(m: GoldenMoment): YouCardFacts {
  const data = buildStandings(m.standings);
  const mine = myStanding(data);
  const w = m.wait ? waitReason(m.wait) : null;
  return {
    isFull: false, spotsLeft: null, ante: 0, closesLabel: null, register: noop,
    inviterName: '', accept: noop, decline: noop, waitlistPosition: null,
    teamLine: null, needsPartner: false, findPartnerLabel: '', onFindPartner: noop, releaseLine: null,
    setupIndex: 0, setupTotal: 1, setupLabel: '', onOpenSetup: noop,
    opponents: '', partner: null, roundLabel: null,
    recordLine: mine ? `You ${mine.row.wins}-${mine.row.losses}, #${mine.position} of ${mine.of}${mine.table ? ` in ${mine.table}` : ''}` : null,
    waitTitle: w?.title ?? null, waitLine: w?.line ?? null, waitHasMatch: !!w?.matchId,
    onRecord: noop, onOpenSchedule: noop,
    myRank: null, podium: [], payoutLine: null, onShare: null,
  };
}

function Moment({ m }: { m: GoldenMoment }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const data = buildStandings(m.standings);
  const w = m.wait ? waitReason(m.wait) : null;
  const view = w ? youCardView('playing', facts(m)) : null;
  const isMlp = m.standings.tournament.format === 'mlp';
  void isMlp; void mlpPoolGroups;
  return (
    <View testID={`golden-${m.id}`} style={[styles.frame, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={t.label}>{m.format}</Text>
      <Text style={t.title}>{m.title}</Text>
      <Text style={[t.sub, { marginBottom: SPACE.md }]}>{m.story}</Text>
      {view ? <TournamentYouCard view={view} /> : <Text style={t.sub}>{m.wait && m.wait.matches.some(x => x.status === 'pending' && [x.team1_player1, x.team1_player2, x.team2_player1, x.team2_player2].some(p => !!p && m.wait!.me.includes(p))) ? '(Your match is open: the Next match card shows.)' : '(Every match is in: the tournament closes and the Final results card shows.)'}</Text>}
      {data ? <View style={{ marginTop: SPACE.md }}><StandingsSection data={data} title={data.stageLocked ? (m.standings.tournament.format === 'pool_play' ? 'Pool play, final' : 'Round robin, final') : 'Standings'} /></View> : null}
      {data?.placement && data.placement.rows.length > 0 ? (
        <View style={{ marginTop: SPACE.md }}>
          <PlacementSection data={data.placement} entrantLabel={data.entrantLabel}
            title={data.placement.settled ? 'Final placement' : 'Final placement (so far)'} />
        </View>
      ) : null}
    </View>
  );
}

export default function GoldensScreen() {
  const { colors: c } = useTheme();
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.page}>
      {goldenMoments().map(m => <Moment key={m.id} m={m} />)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: SPACE.md, gap: SPACE.lg, alignItems: 'center' },
  frame: { width: 390, padding: SPACE.md, borderWidth: 1, borderRadius: 12 },
  block: { marginTop: SPACE.md, padding: SPACE.md, borderWidth: 1, borderRadius: 12, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
});
