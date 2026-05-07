import React, { useState } from 'react';
import {
  ScrollView, View, Text, TextInput, TouchableOpacity,
  StyleSheet, Switch, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import { TournamentFormat, FORMAT_META } from '../lib/tournament';
import AppDateTimePicker from '../components/AppDateTimePicker';
import CourtPicker, { CourtResult } from '../components/CourtPicker';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'CreateTournament'>;
  route: RouteProp<RootStackParamList, 'CreateTournament'>;
};

const FORMATS: TournamentFormat[] = [
  'round_robin', 'single_elimination', 'double_elimination',
  'pool_play', 'mlp', 'rotating_partners',
];

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.pill, active && styles.pillActive]} onPress={onPress}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

export default function CreateTournamentScreen({ navigation, route }: Props) {
  const { leagueId } = route.params ?? {};

  // Basics
  const [name, setName]               = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime]     = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [location, setLocation]       = useState<CourtResult | null>(null);
  const [maxPlayers, setMaxPlayers]   = useState('');

  // Format
  const [format, setFormat]           = useState<TournamentFormat>('round_robin');
  const [matchType, setMatchType]     = useState<'singles' | 'doubles'>('singles');
  const [seeding, setSeeding]         = useState<'random' | 'elo'>('random');
  const [poolCount, setPoolCount]     = useState(2);
  const [partnerRotation, setPartnerRotation] = useState<'every_match' | 'every_round'>('every_match');

  // Registration
  const [inviteOnly, setInviteOnly]   = useState(false);

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState(false);

  async function submit() {
    setError('');
    if (!name.trim()) { setError('Please enter a tournament name.'); return; }

    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();

    const { data: t, error: err } = await supabase.from('tournaments').insert({
      league_id:         leagueId ?? null,
      name:              name.trim(),
      description:       description.trim() || null,
      created_by:        user!.id,
      format,
      match_type:        matchType,
      seeding,
      pool_count:        format === 'pool_play' ? poolCount : 1,
      partner_rotation:  format === 'rotating_partners' ? partnerRotation : null,
      registration_mode: inviteOnly ? 'invite_only' : 'request',
      max_players:       maxPlayers ? parseInt(maxPlayers) : null,
      start_time:        startTime?.toISOString() ?? null,
      location_name:     location?.name ?? null,
      location_lat:      location?.lat ?? null,
      location_lng:      location?.lng ?? null,
    }).select().single();

    setLoading(false);
    if (err) { setError(err.message); return; }

    // Auto-register creator as approved admin
    await supabase.from('tournament_registrations').insert({
      tournament_id: t.id,
      user_id:       user!.id,
      status:        'approved',
      role:          'admin',
    });

    setSuccess(true);
    setTimeout(() => navigation.replace('TournamentDetail', { tournamentId: t.id, tournamentName: t.name }), 800);
  }

  const fmt = FORMAT_META[format];

  return (
    <>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

        {/* ── Basics ── */}
        <SectionHeader title="Basics" />

        <Text style={styles.label}>Tournament Name *</Text>
        <TextInput style={styles.input} placeholder="e.g. Spring Smash Classic" value={name} onChangeText={setName} />

        <Text style={styles.label}>Description (optional)</Text>
        <TextInput style={[styles.input, styles.multiline]} placeholder="Rules, prizes, notes…" value={description} onChangeText={setDescription} multiline />

        <Text style={styles.label}>Date & Time</Text>
        <TouchableOpacity style={styles.dateBtn} onPress={() => setShowDatePicker(true)}>
          <Text style={styles.dateBtnText}>
            {startTime
              ? startTime.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : 'Set date & time'}
          </Text>
          {startTime && (
            <TouchableOpacity onPress={() => setStartTime(null)}>
              <Text style={styles.clearDate}>✕</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>

        <Text style={styles.label}>Location</Text>
        <CourtPicker value={location} onSelect={setLocation} active showNoneOption placeholder="Search for tournament venue…" />

        <Text style={styles.label}>Max Players</Text>
        <TextInput style={[styles.input, styles.inputSmall]} placeholder="No limit" keyboardType="number-pad" value={maxPlayers} onChangeText={setMaxPlayers} />

        {/* ── Format ── */}
        <SectionHeader title="Format" />

        <View style={styles.formatGrid}>
          {FORMATS.map(f => {
            const meta = FORMAT_META[f];
            const active = format === f;
            return (
              <TouchableOpacity
                key={f}
                style={[styles.formatCard, active && styles.formatCardActive]}
                onPress={() => setFormat(f)}
              >
                <Text style={styles.formatIcon}>{meta.icon}</Text>
                <Text style={[styles.formatLabel, active && styles.formatLabelActive]}>{meta.label}</Text>
                <Text style={styles.formatDesc}>{meta.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Match type ── */}
        <SectionHeader title="Match Type" />
        <View style={styles.pillRow}>
          <Pill label="1v1  Singles" active={matchType === 'singles'} onPress={() => setMatchType('singles')} />
          <Pill label="2v2  Doubles" active={matchType === 'doubles'} onPress={() => setMatchType('doubles')} />
        </View>

        {/* ── Seeding ── */}
        <SectionHeader title="Player Seeding" />
        <View style={styles.pillRow}>
          <Pill label="🎲 Random draw"  active={seeding === 'random'} onPress={() => setSeeding('random')} />
          <Pill label="📊 ELO-based"   active={seeding === 'elo'}    onPress={() => setSeeding('elo')}    />
        </View>
        <Text style={styles.hint}>
          {seeding === 'elo'
            ? 'Players are sorted by ELO. Pools and brackets use snake-draft to balance skill levels.'
            : 'Players are assigned randomly to pools and brackets.'}
        </Text>

        {/* ── Pool count (pool play only) ── */}
        {format === 'pool_play' && (
          <>
            <SectionHeader title="Number of Pools" />
            <View style={styles.pillRow}>
              {[2, 3, 4, 6].map(n => (
                <Pill key={n} label={`${n} pools`} active={poolCount === n} onPress={() => setPoolCount(n)} />
              ))}
            </View>
            <Text style={styles.hint}>Players are distributed evenly. Snake-draft keeps pools balanced by ELO when seeding is on.</Text>
          </>
        )}

        {/* ── Partner rotation (rotating_partners only) ── */}
        {format === 'rotating_partners' && (
          <>
            <SectionHeader title="Partner Rotation" />
            <View style={styles.pillRow}>
              <Pill label="Every match"  active={partnerRotation === 'every_match'}  onPress={() => setPartnerRotation('every_match')}  />
              <Pill label="Every round"  active={partnerRotation === 'every_round'}  onPress={() => setPartnerRotation('every_round')}  />
            </View>
            <Text style={styles.hint}>Partners rotate so every player pairs with different teammates over the course of the tournament.</Text>
          </>
        )}

        {/* ── Registration ── */}
        <SectionHeader title="Registration" />
        <Text style={styles.closedNote}>🔒 All tournaments are closed — players must be approved to participate.</Text>

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Invite only</Text>
            <Text style={styles.hint}>{inviteOnly ? 'Only players you invite can register.' : 'Players can request to join; you approve them.'}</Text>
          </View>
          <Switch value={inviteOnly} onValueChange={setInviteOnly} trackColor={{ true: '#2e7d32' }} thumbColor="#fff" />
        </View>

        {/* ── Status / submit ── */}
        {error ? (
          <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>
        ) : null}
        {success ? (
          <View style={styles.successBox}><Text style={styles.successText}>✓ Tournament created!</Text></View>
        ) : null}

        <TouchableOpacity
          style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
          onPress={submit}
          disabled={loading || success}
        >
          <Text style={styles.submitText}>{loading ? 'Creating…' : 'Create Tournament'}</Text>
        </TouchableOpacity>
      </ScrollView>

      <AppDateTimePicker
        visible={showDatePicker}
        value={startTime ?? new Date(Date.now() + 86400000)}
        minimumDate={new Date()}
        onChange={d => { setStartTime(d); setShowDatePicker(false); }}
        onClose={() => setShowDatePicker(false)}
      />
    </>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#fff', flexGrow: 1, paddingBottom: 48 },
  sectionHeader: { fontSize: 15, fontWeight: '800', color: '#1a1a1a', marginTop: 28, marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', paddingBottom: 6 },
  label: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 6, marginTop: 12 },
  hint: { fontSize: 12, color: '#aaa', marginTop: 6, lineHeight: 17 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 13, fontSize: 15, color: '#1a1a1a' },
  multiline: { height: 68, textAlignVertical: 'top' },
  inputSmall: { width: 120 },
  dateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 13 },
  dateBtnText: { fontSize: 15, color: '#555' },
  clearDate: { fontSize: 15, color: '#aaa', paddingHorizontal: 4 },
  formatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  formatCard: { width: '47%', borderWidth: 1.5, borderColor: '#eee', borderRadius: 12, padding: 12, backgroundColor: '#fafafa' },
  formatCardActive: { borderColor: GREEN, backgroundColor: '#f0faf0' },
  formatIcon: { fontSize: 26, marginBottom: 4 },
  formatLabel: { fontSize: 13, fontWeight: '700', color: '#444' },
  formatLabelActive: { color: GREEN },
  formatDesc: { fontSize: 11, color: '#aaa', marginTop: 3, lineHeight: 15 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: '#ddd', backgroundColor: '#fafafa' },
  pillActive: { borderColor: GREEN, backgroundColor: '#e8f5e9' },
  pillText: { fontSize: 13, color: '#666', fontWeight: '500' },
  pillTextActive: { color: GREEN, fontWeight: '700' },
  closedNote: { fontSize: 13, color: '#888', backgroundColor: '#f9f9f9', borderRadius: 8, padding: 10, marginBottom: 4 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9f9f9', borderRadius: 10, padding: 14, marginTop: 8 },
  errorBox: { backgroundColor: '#ffebee', borderRadius: 8, padding: 12, marginTop: 12 },
  errorText: { color: '#c62828', fontSize: 14, fontWeight: '600' },
  successBox: { backgroundColor: '#e8f5e9', borderRadius: 8, padding: 12, marginTop: 12 },
  successText: { color: GREEN, fontSize: 14, fontWeight: '700' },
  submitBtn: { backgroundColor: GREEN, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 20 },
  submitBtnDisabled: { backgroundColor: '#a5d6a7' },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
