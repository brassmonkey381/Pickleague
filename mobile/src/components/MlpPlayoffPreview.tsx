import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useStatusMessage } from '../lib/useStatusMessage';
import StatusBanner from './StatusBanner';
import type { RootStackParamList } from '../types';

/**
 * MLP playoff view. Two render modes:
 *  1. Preview mode (no playoff matches yet): shows expected bracket using
 *     standings as they accrue ("Pool A #1 vs Pool B #2"), plus a standings
 *     table.
 *  2. Live mode (playoff rounds exist): shows each playoff round as a card
 *     with the 4 rotation sub-matches (Men's / Women's / Mixed 1 / Mixed 2),
 *     a running series score, and tap-to-enter score links per rotation.
 */

type Props = {
  tournamentId: string;
  tournamentName: string;
  leagueId: string;
  mlpPlayFormat: 'round_robin_playoff' | 'pool_play_playoff';
  poolCount: number;
  playoffTeams: number;     // 2 / 4 / 8
  isAdmin?: boolean;        // shows the manual "Generate playoff now" recovery button
};

type StandingsRow = {
  team_id: string;
  team_name: string;
  seed: number;
  pool_letter: string | null;
  sub_matches_won: number;
  sub_matches_lost: number;
};

type MlpTeam = {
  id: string;
  name: string;
  male_1_id: string | null;
  male_2_id: string | null;
  female_1_id: string | null;
  female_2_id: string | null;
};

type PlayoffMatch = {
  id: string;
  round_id: string;
  match_order: number;
  status: string;
  match_type: string;
  team1_player1: string | null;
  team1_player2: string | null;
  team2_player1: string | null;
  team2_player2: string | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_team: string | null;
};

type PlayoffRound = {
  id: string;
  label: string | null;
  round_type: string;
  round_number: number;
  matches: PlayoffMatch[];
};

type Slot = { teamName: string; placeholder: boolean };
type Pairing = { left: Slot; right: Slot; label: string };

const ROTATION_LABELS = ["Men's Doubles", "Women's Doubles", 'Mixed 1', 'Mixed 2'];

export default function MlpPlayoffPreview({
  tournamentId, tournamentName, leagueId,
  mlpPlayFormat, poolCount, playoffTeams, isAdmin,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const genStatus = useStatusMessage();

  const [rows, setRows]               = useState<StandingsRow[]>([]);
  const [teams, setTeams]             = useState<MlpTeam[]>([]);
  const [profileNames, setProfileNames] = useState<Record<string, string>>({});
  const [playoffRounds, setPlayoffRounds] = useState<PlayoffRound[]>([]);
  const [loading, setLoading]         = useState(true);
  const [poolsDone, setPoolsDone]     = useState(false);
  const [errMsg, setErrMsg]           = useState<string | null>(null);
  const [generating, setGenerating]   = useState(false);

  async function generatePlayoff() {
    setGenerating(true);
    genStatus.clear();
    const { error } = await supabase.rpc('generate_mlp_playoff', { p_tournament_id: tournamentId });
    setGenerating(false);
    if (error) {
      console.warn('[MlpPlayoffPreview] generate_mlp_playoff', error);
      genStatus.errorFromRpc(error, 'supabase/migration_mlp_auto_advance_playoff.sql');
      return;
    }
    genStatus.success('Playoff bracket generated.');
    await load();
  }

  useFocusEffect(useCallback(() => { load(); }, [tournamentId, mlpPlayFormat]));

  async function load() {
    setLoading(true);
    setErrMsg(null);
    const [stRes, mRes, teamsRes] = await Promise.all([
      supabase.rpc('mlp_team_standings', { p_tournament_id: tournamentId }),
      supabase
        .from('tournament_matches')
        .select('id, round_id, match_order, status, match_type, team1_player1, team1_player2, team2_player1, team2_player2, team1_score, team2_score, winner_team, round:tournament_rounds!inner(id, label, round_type, round_number)')
        .eq('tournament_id', tournamentId)
        .order('match_order', { ascending: true }),
      supabase
        .from('mlp_teams')
        .select('id, name, male_1_id, male_2_id, female_1_id, female_2_id')
        .eq('tournament_id', tournamentId),
    ]);
    if (stRes.error) {
      console.warn('[MlpPlayoffPreview] mlp_team_standings error', stRes.error);
      const missing = /does not exist|Could not find the function|PGRST202/i.test(stRes.error.message ?? '');
      setErrMsg(missing
        ? 'mlp_team_standings RPC not deployed. Run supabase/migration_fix_mlp_standings.sql.'
        : (stRes.error.message ?? 'Failed to load standings.'));
    }
    setRows((stRes.data ?? []) as StandingsRow[]);
    setTeams((teamsRes.data ?? []) as MlpTeam[]);

    const matches = (mRes.data ?? []) as any[];
    const poolMatches = matches.filter(m =>
      m.round?.round_type === 'pool' || m.round?.round_type === 'winners');
    setPoolsDone(poolMatches.length > 0 && poolMatches.every(m => m.status === 'completed'));

    // Group playoff matches by round
    const playoffTypes = new Set(['finals', 'semifinals', 'quarterfinals', 'third_place_match']);
    const byRound = new Map<string, PlayoffRound>();
    for (const m of matches) {
      if (!playoffTypes.has(m.round?.round_type)) continue;
      const r = m.round;
      if (!byRound.has(r.id)) {
        byRound.set(r.id, {
          id: r.id, label: r.label, round_type: r.round_type,
          round_number: r.round_number ?? 0, matches: [],
        });
      }
      byRound.get(r.id)!.matches.push({
        id: m.id, round_id: m.round_id, match_order: m.match_order ?? 0,
        status: m.status, match_type: m.match_type,
        team1_player1: m.team1_player1, team1_player2: m.team1_player2,
        team2_player1: m.team2_player1, team2_player2: m.team2_player2,
        team1_score: m.team1_score, team2_score: m.team2_score,
        winner_team: m.winner_team,
      });
    }
    const sortedRounds = [...byRound.values()]
      .map(r => ({ ...r, matches: r.matches.sort((a, b) => a.match_order - b.match_order) }))
      .sort((a, b) => {
        // Display order: quarters → semis → finals → third-place
        const order = (t: string) =>
          t === 'quarterfinals' ? 0 :
          t === 'semifinals'    ? 1 :
          t === 'finals'        ? 2 :
          t === 'third_place_match' ? 3 : 4;
        return order(a.round_type) - order(b.round_type) || a.round_number - b.round_number;
      });
    setPlayoffRounds(sortedRounds);

    // Load player names for any player IDs we'll display in the live cards
    const needed = new Set<string>();
    for (const r of sortedRounds) for (const m of r.matches) {
      for (const pid of [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2]) {
        if (pid) needed.add(pid);
      }
    }
    if (needed.size > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', [...needed]);
      const map: Record<string, string> = {};
      for (const p of (profs ?? []) as any[]) map[p.id] = p.full_name ?? '—';
      setProfileNames(map);
    } else {
      setProfileNames({});
    }

    setLoading(false);
  }

  function buildPairings(): Pairing[] {
    const slots: Slot[] = [];
    // Extra slots used only for the Third Place Match when playoffTeams=2.
    let thirdLeft:  Slot | null = null;
    let thirdRight: Slot | null = null;

    if (mlpPlayFormat === 'pool_play_playoff') {
      const topPerPool = Math.max(1, Math.floor(playoffTeams / poolCount));
      const byPool = new Map<string, StandingsRow[]>();
      for (const r of rows) {
        if (!r.pool_letter) continue;
        if (!byPool.has(r.pool_letter)) byPool.set(r.pool_letter, []);
        byPool.get(r.pool_letter)!.push(r);
      }
      const pools = [...byPool.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([letter, list]) => ({ letter, list }));

      for (let rank = 1; rank <= topPerPool; rank++) {
        for (const { letter, list } of pools) {
          if (slots.length >= playoffTeams) break;
          const team = list[rank - 1];
          if (team) {
            slots.push({ teamName: team.team_name, placeholder: false });
          } else {
            slots.push({ teamName: `Pool ${letter} #${rank}`, placeholder: true });
          }
        }
      }
      while (slots.length < playoffTeams) {
        slots.push({ teamName: `TBD ${slots.length + 1}`, placeholder: true });
      }

      // 3rd-place placeholder for Top-2 + pool play: pull each pool's #2.
      if (playoffTeams === 2 && pools.length >= 2) {
        const a2 = pools[0].list[1];
        const b2 = pools[1].list[1];
        thirdLeft  = a2 ? { teamName: a2.team_name, placeholder: false } : { teamName: `Pool ${pools[0].letter} #2`, placeholder: true };
        thirdRight = b2 ? { teamName: b2.team_name, placeholder: false } : { teamName: `Pool ${pools[1].letter} #2`, placeholder: true };
      }
    } else {
      const sorted = [...rows].sort((a, b) =>
        (b.sub_matches_won - a.sub_matches_won)
        || (a.sub_matches_lost - b.sub_matches_lost)
        || (a.seed - b.seed)
      );
      for (let i = 0; i < playoffTeams; i++) {
        const team = sorted[i];
        if (team && poolsDone) {
          slots.push({ teamName: team.team_name, placeholder: false });
        } else {
          slots.push({ teamName: `RR #${i + 1}`, placeholder: true });
        }
      }

      // 3rd-place placeholder for Top-2 + round robin: RR #3 vs RR #4.
      if (playoffTeams === 2) {
        const t3 = sorted[2];
        const t4 = sorted[3];
        thirdLeft  = t3 && poolsDone ? { teamName: t3.team_name, placeholder: false } : { teamName: 'RR #3', placeholder: true };
        thirdRight = t4 && poolsDone ? { teamName: t4.team_name, placeholder: false } : { teamName: 'RR #4', placeholder: true };
      }
    }

    const pairings: Pairing[] = [];
    const N = slots.length;
    const roundLabel = N === 8 ? 'Quarterfinal' : N === 4 ? 'Semifinal' : N === 2 ? 'Final' : `Round of ${N}`;
    for (let i = 0; i < N / 2; i++) {
      pairings.push({
        left:  slots[i],
        right: slots[N - 1 - i],
        label: `${roundLabel} ${i + 1}`,
      });
    }
    if (thirdLeft && thirdRight) {
      pairings.push({ left: thirdLeft, right: thirdRight, label: '🥉 Third Place Match' });
    }
    return pairings;
  }

  // Identify the two MLP teams in a playoff round by matching player IDs.
  function teamsForRound(round: PlayoffRound): { teamA: MlpTeam | null; teamB: MlpTeam | null } {
    if (round.matches.length === 0) return { teamA: null, teamB: null };
    // Men's match is rotation 1 — team1 = A.male_1+A.male_2, team2 = B.male_1+B.male_2.
    const first = round.matches[0];
    const teamA = teams.find(t =>
      (t.male_1_id && (t.male_1_id === first.team1_player1 || t.male_1_id === first.team1_player2)) ||
      (t.male_2_id && (t.male_2_id === first.team1_player1 || t.male_2_id === first.team1_player2))
    ) ?? null;
    const teamB = teams.find(t =>
      (t.male_1_id && (t.male_1_id === first.team2_player1 || t.male_1_id === first.team2_player2)) ||
      (t.male_2_id && (t.male_2_id === first.team2_player1 || t.male_2_id === first.team2_player2))
    ) ?? null;
    return { teamA, teamB };
  }

  function playerName(id: string | null): string {
    if (!id) return '—';
    return profileNames[id] ?? '—';
  }

  function openMatchEntry(m: PlayoffMatch) {
    navigation.navigate('MatchEntry', {
      leagueId,
      tournamentId,
      tournamentMatchId:   m.id,
      tournamentName,
      prefillMatchType:    m.match_type as any,
      prefillTeam1Player:  m.team1_player1 ?? undefined,
      prefillTeam1Partner: m.team1_player2 ?? undefined,
      prefillTeam2Player:  m.team2_player1 ?? undefined,
      prefillTeam2Partner: m.team2_player2 ?? undefined,
    } as any);
  }

  function seriesScore(round: PlayoffRound): { a: number; b: number } {
    let a = 0, b = 0;
    for (const m of round.matches) {
      if (m.status !== 'completed') continue;
      if (m.winner_team === 'team1') a++;
      else if (m.winner_team === 'team2') b++;
    }
    return { a, b };
  }

  function roundDisplayLabel(round: PlayoffRound): string {
    if (round.round_type === 'finals')             return 'Grand Final';
    if (round.round_type === 'semifinals')         return 'Semifinal';
    if (round.round_type === 'quarterfinals')      return 'Quarterfinal';
    if (round.round_type === 'third_place_match')  return '🥉 Third Place Match';
    return round.label ?? 'Playoff';
  }

  if (loading) return <ActivityIndicator style={{ marginVertical: 16 }} color={c.primary} />;

  const hasLivePlayoff = playoffRounds.length > 0;

  const sortedRows = [...rows].sort((a, b) => {
    if (a.pool_letter && b.pool_letter) {
      const cmp = a.pool_letter.localeCompare(b.pool_letter);
      if (cmp !== 0) return cmp;
    }
    return (b.sub_matches_won - a.sub_matches_won)
        || (a.sub_matches_lost - b.sub_matches_lost)
        || (a.seed - b.seed);
  });

  return (
    <View style={S.root}>
      <Text style={S.title}>🏆 Playoff Preview</Text>
      <Text style={S.subtitle}>
        {hasLivePlayoff
          ? 'Playoff bracket is live. Tap any rotation to enter scores.'
          : poolsDone
          ? 'Pool / round-robin play is complete. The playoff bracket below has been seeded.'
          : 'Bracket structure for the playoff. Team names fill in as pool / round-robin standings settle. The bracket generates automatically when all pre-playoff matches finish.'}
      </Text>

      {errMsg && (
        <View style={S.errBox}>
          <Text style={S.errText}>⚠ {errMsg}</Text>
        </View>
      )}

      {/* Admin recovery: pools done but no playoff yet (trigger missing or failed) */}
      {!hasLivePlayoff && poolsDone && isAdmin && (
        <View style={S.recoveryBox}>
          <Text style={S.recoveryTitle}>Pools complete — playoff not generated</Text>
          <Text style={S.recoveryBody}>
            The auto-advance trigger didn't fire (likely because the round-robin matches
            were completed before the trigger was installed). Tap below to generate it now.
          </Text>
          <TouchableOpacity
            style={[S.recoveryBtn, generating && S.recoveryBtnDisabled]}
            onPress={generatePlayoff}
            disabled={generating}
            activeOpacity={0.85}
          >
            <Text style={S.recoveryBtnText}>
              {generating ? 'Generating…' : '⚡ Generate Playoff Now'}
            </Text>
          </TouchableOpacity>
          <StatusBanner status={genStatus.value} />
        </View>
      )}

      {/* Standings table — always shown when standings exist */}
      {sortedRows.length > 0 && (
        <View style={S.standingsTable}>
          <Text style={S.standingsTitle}>Standings</Text>
          <View style={S.standingsHeader}>
            <Text style={[S.standCell, S.standRank]}>#</Text>
            <Text style={[S.standCell, S.standName]}>Team</Text>
            <Text style={[S.standCell, S.standWL]}>W-L</Text>
          </View>
          {(() => {
            const groups: { label: string; rows: StandingsRow[] }[] = [];
            const byPool = new Map<string, StandingsRow[]>();
            for (const r of sortedRows) {
              const key = r.pool_letter ?? '__flat__';
              if (!byPool.has(key)) byPool.set(key, []);
              byPool.get(key)!.push(r);
            }
            for (const [k, list] of byPool.entries()) {
              groups.push({ label: k === '__flat__' ? 'Round Robin' : `Pool ${k}`, rows: list });
            }
            return groups.map(g => (
              <View key={g.label}>
                <Text style={S.standGroupLabel}>{g.label}</Text>
                {g.rows.map((r, i) => (
                  <View key={r.team_id} style={S.standRow}>
                    <Text style={[S.standCell, S.standRank]}>{i + 1}</Text>
                    <Text style={[S.standCell, S.standName]} numberOfLines={1}>{r.team_name}</Text>
                    <Text style={[S.standCell, S.standWL]}>{r.sub_matches_won}–{r.sub_matches_lost}</Text>
                  </View>
                ))}
              </View>
            ));
          })()}
        </View>
      )}

      {/* ── LIVE: actual playoff matches with rotation cards ── */}
      {hasLivePlayoff && playoffRounds.map(round => {
        const { teamA, teamB } = teamsForRound(round);
        const { a, b } = seriesScore(round);
        const winsToClinch = Math.floor(round.matches.length / 2) + 1; // 3 of 4
        const seriesDone =
          a >= winsToClinch || b >= winsToClinch ||
          round.matches.every(m => m.status === 'completed');
        const seriesWinner = seriesDone
          ? (a > b ? teamA?.name : b > a ? teamB?.name : null)
          : null;
        return (
          <View key={round.id} style={S.finalsCard}>
            <View style={S.finalsHeader}>
              <Text style={S.finalsRoundLabel}>{roundDisplayLabel(round)}</Text>
              {seriesDone && seriesWinner && (
                <Text style={S.finalsChampBadge}>🏆 {seriesWinner}</Text>
              )}
            </View>

            <View style={S.finalsTeamsRow}>
              <View style={S.finalsTeamCol}>
                <Text style={[S.finalsTeamName, a > b && seriesDone && S.finalsTeamWinner]} numberOfLines={2}>
                  {teamA?.name ?? 'Team A'}
                </Text>
                <Text style={[S.finalsSeriesScore, a > b && seriesDone && S.finalsSeriesScoreWin]}>{a}</Text>
              </View>
              <Text style={S.finalsSeriesVs}>—</Text>
              <View style={S.finalsTeamCol}>
                <Text style={[S.finalsTeamName, b > a && seriesDone && S.finalsTeamWinner]} numberOfLines={2}>
                  {teamB?.name ?? 'Team B'}
                </Text>
                <Text style={[S.finalsSeriesScore, b > a && seriesDone && S.finalsSeriesScoreWin]}>{b}</Text>
              </View>
            </View>

            <Text style={S.rotationsHeader}>Rotations</Text>
            {round.matches.map((m, i) => {
              const rotLabel = ROTATION_LABELS[i] ?? `Match ${i + 1}`;
              const t1 = `${playerName(m.team1_player1)} & ${playerName(m.team1_player2)}`;
              const t2 = `${playerName(m.team2_player1)} & ${playerName(m.team2_player2)}`;
              const completed = m.status === 'completed' && m.winner_team != null;
              const t1Won = m.winner_team === 'team1';
              const tappable = !completed && !!m.team1_player1 && !!m.team2_player1;
              const Row: any = tappable ? TouchableOpacity : View;
              return (
                <Row
                  key={m.id}
                  style={[S.rotationRow, completed && S.rotationRowDone]}
                  {...(tappable ? { onPress: () => openMatchEntry(m), activeOpacity: 0.6 } : {})}
                >
                  <Text style={S.rotationLabel}>{rotLabel}</Text>
                  <View style={S.rotationBody}>
                    <Text
                      style={[S.rotationLineup, completed && t1Won && S.rotationLineupWin, completed && !t1Won && S.rotationLineupLoss]}
                      numberOfLines={1}
                    >
                      {t1}
                    </Text>
                    {completed ? (
                      <Text style={S.rotationScore}>{m.team1_score}–{m.team2_score}</Text>
                    ) : (
                      <Text style={S.rotationVs}>vs</Text>
                    )}
                    <Text
                      style={[S.rotationLineup, completed && !t1Won && S.rotationLineupWin, completed && t1Won && S.rotationLineupLoss]}
                      numberOfLines={1}
                    >
                      {t2}
                    </Text>
                  </View>
                  {tappable && <Text style={S.rotationChevron}>›</Text>}
                  {!tappable && !completed && <Text style={S.rotationPending}>pending</Text>}
                </Row>
              );
            })}
          </View>
        );
      })}

      {/* ── PREVIEW: placeholder pairings until playoff matches exist ── */}
      {!hasLivePlayoff && buildPairings().map((p, i) => (
        <View key={i} style={S.pairCard}>
          <Text style={S.pairLabel}>{p.label}</Text>
          <View style={S.pairRow}>
            <View style={S.slot}>
              <Text style={[S.slotText, p.left.placeholder && S.slotPlaceholder]}>
                {p.left.teamName}
              </Text>
            </View>
            <Text style={S.vs}>vs</Text>
            <View style={S.slot}>
              <Text style={[S.slotText, p.right.placeholder && S.slotPlaceholder]}>
                {p.right.teamName}
              </Text>
            </View>
          </View>
        </View>
      ))}

      {!hasLivePlayoff && playoffTeams > 2 && (
        <Text style={S.bracketHint}>
          Winners of each {playoffTeams === 8 ? 'Quarterfinal' : 'Semifinal'} advance.
          Loser of each round drops out.
        </Text>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: c.border },
    title:       { fontSize: 16, fontWeight: '900', color: c.text, marginBottom: 4 },
    subtitle:    { fontSize: 12, color: c.textSub, lineHeight: 17, marginBottom: 12 },
    pairCard:    { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 8 },
    pairLabel:   { fontSize: 11, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
    pairRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
    slot:        { flex: 1, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: c.surface, borderRadius: 8, borderWidth: 1, borderColor: c.border },
    slotText:    { fontSize: 13, fontWeight: '700', color: c.text },
    slotPlaceholder: { color: c.textMuted, fontStyle: 'italic', fontWeight: '600' },
    vs:          { fontSize: 12, color: c.textMuted, fontWeight: '700' },
    bracketHint: { fontSize: 11, color: c.textMuted, marginTop: 4, fontStyle: 'italic' },

    errBox:   { backgroundColor: '#ffe5e5', borderRadius: 8, padding: 10, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: '#c62828' },
    errText:  { fontSize: 12, color: '#8a1414', fontWeight: '700' },

    recoveryBox:       { backgroundColor: '#fff8e1', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#e6c875' },
    recoveryTitle:     { fontSize: 13, fontWeight: '900', color: '#8a6d00', marginBottom: 4 },
    recoveryBody:      { fontSize: 12, color: '#5d4a00', lineHeight: 17, marginBottom: 10 },
    recoveryBtn:       { backgroundColor: c.primary, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
    recoveryBtnDisabled: { opacity: 0.6 },
    recoveryBtnText:   { color: '#fff', fontWeight: '900', fontSize: 13 },

    standingsTable:    { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 12 },
    standingsTitle:    { fontSize: 12, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
    standingsHeader:   { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 4, marginBottom: 4 },
    standRow:          { flexDirection: 'row', paddingVertical: 4 },
    standGroupLabel:   { fontSize: 11, fontWeight: '700', color: c.textSub, marginTop: 6, marginBottom: 2 },
    standCell:         { fontSize: 12, color: c.text },
    standRank:         { width: 28, fontWeight: '700' },
    standName:         { flex: 1, fontWeight: '600' },
    standWL:           { width: 60, textAlign: 'right', fontWeight: '700', color: c.primary },

    // Finals / playoff live cards
    finalsCard:        { backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 2, borderColor: c.primary + '55' },
    finalsHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    finalsRoundLabel:  { fontSize: 14, fontWeight: '900', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.8 },
    finalsChampBadge:  { fontSize: 13, fontWeight: '900', color: '#a7740a', backgroundColor: '#fff5d6', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: '#e6c875' },
    finalsTeamsRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, paddingHorizontal: 4 },
    finalsTeamCol:     { flex: 1, alignItems: 'center' },
    finalsTeamName:    { fontSize: 14, fontWeight: '800', color: c.text, textAlign: 'center', marginBottom: 4 },
    finalsTeamWinner:  { color: c.primary },
    finalsSeriesScore: { fontSize: 28, fontWeight: '900', color: c.textSub, fontVariant: ['tabular-nums'] },
    finalsSeriesScoreWin: { color: c.primary },
    finalsSeriesVs:    { fontSize: 14, fontWeight: '700', color: c.textMuted, marginHorizontal: 6 },

    rotationsHeader:   { fontSize: 11, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, marginTop: 4 },
    rotationRow:       { backgroundColor: c.surface, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6, borderWidth: 1, borderColor: c.border, flexDirection: 'row', alignItems: 'center' },
    rotationRowDone:   { backgroundColor: c.surface, opacity: 0.95 },
    rotationLabel:     { fontSize: 11, fontWeight: '800', color: c.textSub, width: 78, textTransform: 'uppercase', letterSpacing: 0.4 },
    rotationBody:      { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
    rotationLineup:    { flex: 1, fontSize: 12, fontWeight: '600', color: c.text },
    rotationLineupWin: { color: c.primary, fontWeight: '800' },
    rotationLineupLoss:{ color: c.textMuted },
    rotationScore:     { fontSize: 13, fontWeight: '900', color: c.text, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'center' },
    rotationVs:        { fontSize: 11, fontWeight: '700', color: c.textMuted, minWidth: 44, textAlign: 'center' },
    rotationChevron:   { fontSize: 18, color: c.primary, fontWeight: '900', marginLeft: 4 },
    rotationPending:   { fontSize: 10, color: c.textMuted, fontStyle: 'italic', marginLeft: 4 },
  });
}
