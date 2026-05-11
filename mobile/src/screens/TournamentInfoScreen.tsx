import React, { useEffect, useState } from 'react';
import { ScrollView, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { Tournament, RootStackParamList } from '../types';
import { FORMAT_META } from '../lib/tournament';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentInfo'>;
  route:      RouteProp<RootStackParamList, 'TournamentInfo'>;
};

// Per-format explainers — what's shown depends on this tournament's format.
const FORMAT_EXPLAINERS: Record<Tournament['format'], { headline: string; flow: string[]; advancement: string[] }> = {
  round_robin: {
    headline: 'Every player faces every other player exactly once.',
    flow: [
      'A circle-method schedule pairs every player with every other player.',
      'Standings are tracked by win-loss record, with PLUPR as the tiebreaker.',
      'No elimination — everyone plays every round.',
    ],
    advancement: [
      'There\'s no bracket. The standings table is the result.',
      'Top spot = highest wins; ties broken by PLUPR rating.',
    ],
  },
  single_elimination: {
    headline: 'One loss and you\'re out.',
    flow: [
      'Players are seeded into a bracket whose size is the next power of 2 above the entrant count (extra slots become BYEs).',
      'Round 1 pairings: top seed vs bottom seed, 2 vs second-from-bottom, etc.',
      'Each round halves the field; the winner of the final round takes the title.',
    ],
    advancement: [
      'Win → advance to next round. Lose → eliminated.',
      'BYEs auto-advance their holder.',
    ],
  },
  double_elimination: {
    headline: 'Two losses to be eliminated — losers get a second chance.',
    flow: [
      'Same Round 1 pairings as single-elim.',
      'A player who loses drops to the losers bracket and keeps playing.',
      'Champion is the player who never loses, OR the losers-bracket survivor who beats them.',
    ],
    advancement: [
      'First loss → moved to losers bracket.',
      'Second loss → eliminated.',
      'Losers bracket finalist plays the winners bracket champion in the grand final.',
    ],
  },
  pool_play: {
    headline: 'Round-robin pools, then a knockout bracket from the top finishers.',
    flow: [
      'Players are split into balanced pools (snake-draft for PLUPR seeding, otherwise random).',
      'Inside each pool, every team plays every other team once.',
      'Top 2 from each pool advance to the semi-finals; semi winners play in the grand final.',
    ],
    advancement: [
      '1st in each pool gets a higher seed than 2nd.',
      'Standings: best wins/losses record first, point differential as tiebreaker.',
      'Bracket pairings: A1 vs B2 in Semi 1; B1 vs A2 in Semi 2; semi winners meet in the grand final.',
    ],
  },
  mlp: {
    headline: 'Pre-formed teams play a round-robin against each other.',
    flow: [
      'Each pair of approved players is locked in as a fixed team.',
      'Teams play every other team once in a circle-method round robin.',
      'Standings are by wins, with PLUPR of the team average as tiebreaker.',
    ],
    advancement: [
      'No bracket — the round-robin standings are the final order.',
    ],
  },
  rotating_partners: {
    headline: 'Doubles where partners rotate every round.',
    flow: [
      'Players are arrayed and rotated each round so every player gets a fresh partner.',
      'Within each group of four, the pairing variant cycles: (a,b) vs (c,d), then (a,c) vs (b,d), then (a,d) vs (b,c).',
      'Designed for social/league-night play rather than a single champion.',
    ],
    advancement: [
      'No bracket — every match is independent.',
      'Standings are tracked per individual: wins desc, PLUPR as tiebreak.',
    ],
  },
};

export default function TournamentInfoScreen({ route }: Props) {
  const { tournamentId } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [t, setT]         = useState<Tournament | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    const [tRes, mRes] = await Promise.all([
      supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
      supabase.from('tournament_registrations').select('id', { count: 'exact', head: true }).eq('tournament_id', tournamentId).eq('status', 'approved'),
    ]);
    setT(tRes.data as Tournament);
    setMemberCount(mRes.count ?? 0);
    setLoading(false);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={c.primary} />;
  if (!t) return <Text style={S.empty}>Tournament not found.</Text>;

  const meta = FORMAT_META[t.format];
  const expl = FORMAT_EXPLAINERS[t.format];

  return (
    <ScrollView style={S.container} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Text style={S.pageTitle}>How {t.name} works</Text>
      <Text style={S.pageSub}>
        Specifics for this tournament's format and the rules that govern its bracket.
      </Text>

      {/* ── Format headline ────────────────────────────────── */}
      <View style={S.headline}>
        <Text style={S.headlineIcon}>{meta.icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={S.headlineLabel}>{meta.label}</Text>
          <Text style={S.headlineDesc}>{expl.headline}</Text>
        </View>
      </View>

      {/* ── At a glance ────────────────────────────────────── */}
      <Section S={S} title="At a glance">
        <Row S={S} label="Match type"        value={t.match_type === 'doubles' ? 'Doubles' : 'Singles'} />
        <Row S={S} label="Seeding"           value={t.seeding === 'elo' ? '📊 PLUPR-seeded' : '🎲 Random draw'} />
        {t.format === 'pool_play' && <Row S={S} label="Pools" value={`${t.pool_count} pool${t.pool_count === 1 ? '' : 's'}`} />}
        {t.partner_rotation && <Row S={S} label="Partner rotation" value={t.partner_rotation.replace('_', ' ')} />}
        <Row S={S} label="Registration"      value={t.registration_mode === 'invite_only' ? '🔒 Invite only' : '📝 Request to join'} />
        {t.max_players != null && <Row S={S} label="Max players"   value={`${t.max_players}`} />}
        <Row S={S} label="Approved players"  value={`${memberCount}`} />
        <Row S={S} label="Status"            value={statusLabel(t.status)} />
      </Section>

      {/* ── Flow of play ──────────────────────────────────── */}
      <Section S={S} title="Flow of play">
        {expl.flow.map((line, i) => (
          <BulletLine key={i} S={S} index={i + 1} text={line} />
        ))}
      </Section>

      {/* ── Advancement / how winners are determined ──────── */}
      <Section S={S} title={t.format === 'round_robin' || t.format === 'mlp' || t.format === 'rotating_partners' ? 'Standings' : 'Advancement'}>
        {expl.advancement.map((line, i) => (
          <Para key={i} S={S}>• {line}</Para>
        ))}
      </Section>

      {/* ── Seeding details ──────────────────────────────── */}
      <Section S={S} title="Seeding rules">
        <Para S={S}>
          {t.seeding === 'elo'
            ? 'Players are sorted by current PLUPR rating before pairing. The strongest seed plays the weakest in round 1, second-strongest plays second-weakest, and so on. Pool play uses a snake-draft (1→A, 2→B, 3→B, 4→A …) so every pool gets a balanced spread of strength.'
            : 'Players are shuffled into a random order before pairing — no PLUPR bias.'}
        </Para>
      </Section>

      {/* ── PLUPR impact ────────────────────────────────────── */}
      <Section S={S} title="PLUPR impact">
        <Para S={S}>
          Tournament matches are tracked in their own table and do <Text style={S.bold}>not</Text> affect league PLUPR ratings.
          Bracket results, scores, and the round-by-round flow are visible in the tournament's bracket view and match history.
        </Para>
      </Section>

      {/* ── Doubles partner rules ─────────────────────────── */}
      {t.match_type === 'doubles' && (
        <Section S={S} title="Doubles partner rules">
          {t.format === 'mlp' && (
            <Para S={S}>
              <Text style={S.bold}>Fixed teams</Text> — once approved, you and your partner are locked in for the whole event.
              Use the partner-finder modal on the tournament detail page to send a partner request before the bracket is generated.
            </Para>
          )}
          {t.format === 'rotating_partners' && (
            <Para S={S}>
              <Text style={S.bold}>Rotating partners</Text> — you don't pick a partner. The schedule rotates pairings every round
              so every player partners with several different people across the event.
            </Para>
          )}
          {t.format !== 'mlp' && t.format !== 'rotating_partners' && (
            <Para S={S}>
              For doubles in this format, your partner is chosen via partner-request before the bracket is locked.
              Once locked, you're a team for the duration.
            </Para>
          )}
        </Section>
      )}
    </ScrollView>
  );
}

function statusLabel(s: Tournament['status']): string {
  if (s === 'registration') return 'Registration open';
  if (s === 'active')       return 'In progress';
  if (s === 'completed')    return 'Ended';
  return 'Cancelled';
}

function Section({ S, title, children }: { S: any; title: string; children: React.ReactNode }) {
  return (
    <View style={S.section}>
      <Text style={S.sectionTitle}>{title}</Text>
      <View style={{ gap: 10 }}>{children}</View>
    </View>
  );
}

function Row({ S, label, value }: { S: any; label: string; value: string }) {
  return (
    <View style={S.row}>
      <Text style={S.rowLabel}>{label}</Text>
      <Text style={S.rowValue}>{value}</Text>
    </View>
  );
}

function Para({ S, children }: { S: any; children: React.ReactNode }) {
  return <Text style={S.para}>{children}</Text>;
}

function BulletLine({ S, index, text }: { S: any; index: number; text: string }) {
  return (
    <View style={S.bulletRow}>
      <View style={S.bulletNum}><Text style={S.bulletNumText}>{index}</Text></View>
      <Text style={S.bulletText}>{text}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:    { flex: 1, backgroundColor: c.bg },
    pageTitle:    { fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 4 },
    pageSub:      { fontSize: 14, color: c.textMuted, marginBottom: 18 },
    headline:     { backgroundColor: c.primaryLight, borderRadius: 14, padding: 14, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: c.primary + '44' },
    headlineIcon: { fontSize: 32 },
    headlineLabel:{ fontSize: 18, fontWeight: '800', color: c.primary },
    headlineDesc: { fontSize: 13, color: c.text, marginTop: 2, lineHeight: 18 },
    section:      { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    sectionTitle: { fontSize: 13, fontWeight: '800', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
    row:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingVertical: 4 },
    rowLabel:     { fontSize: 13, color: c.textMuted, fontWeight: '600' },
    rowValue:     { fontSize: 14, color: c.text, fontWeight: '600', flex: 1, textAlign: 'right' },
    para:         { fontSize: 14, color: c.text, lineHeight: 20 },
    bold:         { fontWeight: '800' },
    bulletRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    bulletNum:    { width: 22, height: 22, borderRadius: 11, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
    bulletNumText:{ fontSize: 11, fontWeight: '800', color: '#fff' },
    bulletText:   { flex: 1, fontSize: 14, color: c.text, lineHeight: 20 },
    empty:        { textAlign: 'center', marginTop: 60, color: c.textMuted, fontSize: 15 },
  });
}
