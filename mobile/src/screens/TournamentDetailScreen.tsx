import React, { useState, useCallback } from 'react';
import {
  ScrollView, View, Text, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Tournament, TournamentRegistration, RootStackParamList } from '../types';
import {
  FORMAT_META, seedPlayers,
  generateRoundRobin, generatePoolPlay,
  generateSingleElim, generateRotatingPartners,
  generateMLPSchedule, MatchPairing,
} from '../lib/tournament';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentDetail'>;
  route: RouteProp<RootStackParamList, 'TournamentDetail'>;
};

const STATUS_COLOR: Record<Tournament['status'], string> = {
  registration: '#2e7d32', active: '#1565c0', completed: '#888', cancelled: '#c62828',
};

export default function TournamentDetailScreen({ navigation, route }: Props) {
  const { tournamentId } = route.params;
  const [tournament, setTournament]     = useState<Tournament | null>(null);
  const [registrations, setRegistrations] = useState<TournamentRegistration[]>([]);
  const [myUserId, setMyUserId]         = useState<string | null>(null);
  const [isCreator, setIsCreator]       = useState(false);
  const [generatedMatches, setGeneratedMatches] = useState<MatchPairing[] | null>(null);
  const [pools, setPools]               = useState<string[][] | null>(null);
  const [profileNames, setProfileNames] = useState<Record<string, string>>({});
  const [profileRatings, setProfileRatings] = useState<Record<string, number>>({});
  const [loading, setLoading]           = useState(true);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    setMyUserId(user?.id ?? null);

    const [tRes, regRes] = await Promise.all([
      supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
      supabase.from('tournament_registrations')
        .select('*, profile:profiles(id, full_name, rating)')
        .eq('tournament_id', tournamentId)
        .order('registered_at'),
    ]);

    const t = tRes.data as Tournament;
    setTournament(t);
    setIsCreator(t?.created_by === user?.id);

    const regs = (regRes.data ?? []) as TournamentRegistration[];
    setRegistrations(regs);

    // Build name/rating lookup for bracket display
    const names: Record<string, string> = {};
    const ratings: Record<string, number> = {};
    regs.forEach(r => {
      if (r.profile) { names[r.user_id] = r.profile.full_name; ratings[r.user_id] = (r.profile as any).rating ?? 1000; }
    });
    setProfileNames(names);
    setProfileRatings(ratings);

    setLoading(false);
  }

  async function register() {
    const { error } = await supabase.from('tournament_registrations').insert({
      tournament_id: tournamentId, user_id: myUserId,
    });
    if (error) Alert.alert('Error', error.message);
    else load();
  }

  async function approveReg(regId: string, userId: string) {
    await supabase.from('tournament_registrations').update({ status: 'approved' }).eq('id', regId);
    load();
  }

  async function rejectReg(regId: string) {
    await supabase.from('tournament_registrations').update({ status: 'rejected' }).eq('id', regId);
    load();
  }

  function generateBracket() {
    if (!tournament) return;
    const approved = registrations.filter(r => r.status === 'approved').map(r => r.user_id);
    if (approved.length < 2) { Alert.alert('Need at least 2 approved players to generate a bracket.'); return; }

    const seeded = seedPlayers(approved, profileRatings, tournament.seeding);

    switch (tournament.format) {
      case 'round_robin': {
        setGeneratedMatches(generateRoundRobin(seeded));
        break;
      }
      case 'single_elimination':
      case 'double_elimination': {
        setGeneratedMatches(generateSingleElim(seeded));
        break;
      }
      case 'pool_play': {
        const { pools: p, matches: m } = generatePoolPlay(seeded, tournament.pool_count);
        setPools(p);
        setGeneratedMatches(m);
        break;
      }
      case 'rotating_partners': {
        const numRounds = Math.ceil(seeded.length / 4) * 3;
        setGeneratedMatches(generateRotatingPartners(seeded, numRounds));
        break;
      }
      case 'mlp': {
        // Pair players into teams of 2
        const teams: [string, string][] = [];
        for (let i = 0; i + 1 < seeded.length; i += 2) teams.push([seeded[i], seeded[i+1]]);
        setGeneratedMatches(generateMLPSchedule(teams));
        break;
      }
    }
  }

  function playerName(id: string | undefined): string {
    if (!id || id === 'BYE') return 'BYE';
    return profileNames[id] ?? id.slice(0, 8) + '…';
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;
  if (!tournament) return <Text style={styles.empty}>Tournament not found.</Text>;

  const fmt          = FORMAT_META[tournament.format];
  const statusColor  = STATUS_COLOR[tournament.status];
  const approved     = registrations.filter(r => r.status === 'approved');
  const pending      = registrations.filter(r => r.status === 'pending');
  const myReg        = registrations.find(r => r.user_id === myUserId);
  const canRegister  = !myReg && tournament.status === 'registration';

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>

      {/* Header card */}
      <View style={styles.headerCard}>
        <View style={styles.headerTop}>
          <Text style={styles.fmtIcon}>{fmt.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.fmtLabel}>{fmt.label}</Text>
            <Text style={styles.fmtDesc}>{fmt.description}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {tournament.status.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </Text>
          </View>
        </View>

        {/* Settings strip */}
        <View style={styles.settingsStrip}>
          <Text style={styles.settingChip}>{tournament.match_type === 'doubles' ? '2v2' : '1v1'}</Text>
          <Text style={styles.settingChip}>{tournament.seeding === 'elo' ? '📊 ELO seeded' : '🎲 Random'}</Text>
          {tournament.format === 'pool_play' && <Text style={styles.settingChip}>{tournament.pool_count} pools</Text>}
          {tournament.partner_rotation && <Text style={styles.settingChip}>Rotate {tournament.partner_rotation.replace('_', ' ')}</Text>}
          <Text style={styles.settingChip}>{tournament.registration_mode === 'invite_only' ? '🔒 Invite only' : '📝 Requests'}</Text>
        </View>

        {tournament.start_time && (
          <Text style={styles.meta}>📅 {new Date(tournament.start_time).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
        )}
        {tournament.location_name && <Text style={styles.meta}>📍 {tournament.location_name}</Text>}
        {tournament.description && <Text style={styles.desc}>{tournament.description}</Text>}
      </View>

      {/* Registration action */}
      {canRegister && tournament.registration_mode === 'request' && (
        <TouchableOpacity style={styles.registerBtn} onPress={register}>
          <Text style={styles.registerBtnText}>Request to Join</Text>
        </TouchableOpacity>
      )}
      {myReg && (
        <View style={[styles.myRegBadge, myReg.status === 'approved' ? styles.myRegApproved : myReg.status === 'rejected' ? styles.myRegRejected : styles.myRegPending]}>
          <Text style={styles.myRegText}>
            {myReg.status === 'approved' ? '✓ You\'re in!' : myReg.status === 'rejected' ? '✗ Request declined' : '⏳ Request pending approval'}
          </Text>
        </View>
      )}

      {/* Approved players */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Players ({approved.length}{tournament.max_players ? ` / ${tournament.max_players}` : ''})
        </Text>
        {approved.map((r, i) => (
          <View key={r.id} style={styles.playerRow}>
            <Text style={styles.playerSeed}>#{i + 1}</Text>
            <Text style={styles.playerName}>{r.profile?.full_name ?? '—'}</Text>
            <Text style={styles.playerRating}>{(r.profile as any)?.rating ?? 1000} ELO</Text>
          </View>
        ))}
        {approved.length === 0 && <Text style={styles.emptySection}>No approved players yet.</Text>}
      </View>

      {/* Pending requests (creator only) */}
      {isCreator && pending.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pending Requests ({pending.length})</Text>
          {pending.map(r => (
            <View key={r.id} style={styles.pendingRow}>
              <Text style={styles.playerName} numberOfLines={1}>{r.profile?.full_name ?? '—'}</Text>
              <View style={styles.pendingActions}>
                <TouchableOpacity style={styles.approveBtn} onPress={() => approveReg(r.id, r.user_id)}>
                  <Text style={styles.approveBtnText}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.rejectBtn} onPress={() => rejectReg(r.id)}>
                  <Text style={styles.rejectBtnText}>Reject</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Generate bracket (creator only) */}
      {isCreator && approved.length >= 2 && (
        <TouchableOpacity style={styles.generateBtn} onPress={generateBracket}>
          <Text style={styles.generateBtnText}>⚡  Generate {fmt.label} Schedule</Text>
        </TouchableOpacity>
      )}

      {/* Pool assignments */}
      {pools && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pool Assignments</Text>
          {pools.map((pool, pi) => (
            <View key={pi} style={styles.poolCard}>
              <Text style={styles.poolLabel}>Pool {String.fromCharCode(65 + pi)}</Text>
              {pool.map(uid => (
                <Text key={uid} style={styles.poolPlayer}>• {playerName(uid)}</Text>
              ))}
            </View>
          ))}
        </View>
      )}

      {/* Generated match schedule */}
      {generatedMatches && generatedMatches.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Match Schedule ({generatedMatches.length} matches)</Text>
          {(() => {
            const rounds = [...new Set(generatedMatches.map(m => m.round))].sort((a, b) => a - b);
            return rounds.map(r => (
              <View key={r} style={styles.roundBlock}>
                <Text style={styles.roundLabel}>
                  {generatedMatches.find(m => m.round === r)?.label?.split('·')[0]?.trim() ?? `Round ${r}`}
                </Text>
                {generatedMatches.filter(m => m.round === r).map((m, mi) => {
                  const t1 = m.team1.map(playerName).join(' & ');
                  const t2 = m.team2.map(playerName).join(' & ');
                  return (
                    <View key={mi} style={styles.matchRow}>
                      <Text style={styles.matchNum}>{mi + 1}</Text>
                      <Text style={styles.matchup} numberOfLines={1}>{t1}</Text>
                      <Text style={styles.vs}>vs</Text>
                      <Text style={styles.matchup} numberOfLines={1}>{t2}</Text>
                    </View>
                  );
                })}
              </View>
            ));
          })()}
        </View>
      )}
    </ScrollView>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  empty: { textAlign: 'center', marginTop: 60, color: '#999' },

  headerCard: { backgroundColor: '#fff', padding: 16, marginBottom: 8 },
  headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  fmtIcon: { fontSize: 30, marginTop: 2 },
  fmtLabel: { fontSize: 16, fontWeight: '800', color: '#1a1a1a' },
  fmtDesc: { fontSize: 12, color: '#888', marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  statusText: { fontSize: 11, fontWeight: '700' },
  settingsStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  settingChip: { backgroundColor: '#f5f5f5', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, fontSize: 12, color: '#555', fontWeight: '500' },
  meta: { fontSize: 13, color: '#666', marginBottom: 3 },
  desc: { fontSize: 13, color: '#777', marginTop: 8 },

  registerBtn: { margin: 12, backgroundColor: GREEN, borderRadius: 10, padding: 16, alignItems: 'center' },
  registerBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  myRegBadge: { margin: 12, borderRadius: 10, padding: 14, alignItems: 'center' },
  myRegApproved: { backgroundColor: '#e8f5e9' },
  myRegPending:  { backgroundColor: '#fff8e1' },
  myRegRejected: { backgroundColor: '#ffebee' },
  myRegText: { fontSize: 14, fontWeight: '600', color: '#333' },

  section: { backgroundColor: '#fff', margin: 12, marginTop: 0, marginBottom: 8, borderRadius: 12, padding: 14 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  emptySection: { fontSize: 13, color: '#ccc', textAlign: 'center', paddingVertical: 8 },

  playerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  playerSeed: { width: 28, fontSize: 12, color: '#bbb', fontWeight: '600' },
  playerName: { flex: 1, fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  playerRating: { fontSize: 13, fontWeight: '700', color: GREEN },

  pendingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  pendingActions: { flexDirection: 'row', gap: 8 },
  approveBtn: { backgroundColor: GREEN, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  approveBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  rejectBtn: { backgroundColor: '#f5f5f5', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  rejectBtnText: { color: '#888', fontSize: 12, fontWeight: '600' },

  generateBtn: { margin: 12, backgroundColor: '#1565c0', borderRadius: 10, padding: 16, alignItems: 'center' },
  generateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  poolCard: { backgroundColor: '#f9f9f9', borderRadius: 8, padding: 10, marginBottom: 8 },
  poolLabel: { fontSize: 13, fontWeight: '700', color: '#1565c0', marginBottom: 4 },
  poolPlayer: { fontSize: 13, color: '#444', paddingVertical: 2 },

  roundBlock: { marginBottom: 12 },
  roundLabel: { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  matchNum: { width: 20, fontSize: 11, color: '#bbb', fontWeight: '600' },
  matchup: { flex: 1, fontSize: 13, fontWeight: '600', color: '#1a1a1a' },
  vs: { fontSize: 11, color: '#bbb', fontWeight: '700' },
});
