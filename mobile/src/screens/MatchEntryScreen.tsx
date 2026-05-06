import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, Platform,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Picker } from '@react-native-picker/picker';
import { supabase } from '../lib/supabase';
import { Profile, RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchEntry'>;
  route: RouteProp<RootStackParamList, 'MatchEntry'>;
};

type MatchType = 'singles' | 'doubles';
type StatusMsg = { text: string; isError: boolean } | null;

// Cross-platform player picker: HTML <select> on web, native Picker on iOS/Android
function PlayerPickerField({ label, value, onChange, members, exclude }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  members: Profile[];
  exclude: string[];
}) {
  const available = members.filter((m) => !exclude.includes(m.id) || m.id === value);

  const webSelect = Platform.OS === 'web'
    ? React.createElement(
        'select',
        {
          value,
          onChange: (e: any) => onChange(e.target.value),
          style: {
            fontSize: 15,
            padding: '11px 12px',
            width: '100%',
            border: '1px solid #ddd',
            borderRadius: 8,
            backgroundColor: '#fff',
            color: value ? '#1a1a1a' : '#aaa',
            outline: 'none',
            cursor: 'pointer',
            boxSizing: 'border-box',
          },
        },
        [
          React.createElement('option', { key: '', value: '' }, 'Select player...'),
          ...available.map((m) =>
            React.createElement('option', { key: m.id, value: m.id }, m.full_name)
          ),
        ]
      )
    : null;

  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.pickerWrapper}>
        {Platform.OS === 'web' ? (
          webSelect
        ) : (
          <Picker selectedValue={value} onValueChange={onChange}>
            <Picker.Item label="Select player..." value="" />
            {available.map((m) => (
              <Picker.Item key={m.id} label={m.full_name} value={m.id} />
            ))}
          </Picker>
        )}
      </View>
    </>
  );
}

export default function MatchEntryScreen({ navigation, route }: Props) {
  const { leagueId } = route.params;
  const [members, setMembers] = useState<Profile[]>([]);
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [p1, setP1] = useState('');
  const [partner1, setPartner1] = useState('');
  const [p2, setP2] = useState('');
  const [partner2, setPartner2] = useState('');
  const [score1, setScore1] = useState('');
  const [score2, setScore2] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<StatusMsg>(null);

  useEffect(() => { loadMembers(); }, []);

  async function loadMembers() {
    const { data } = await supabase
      .from('league_members')
      .select('profile:profiles(*)')
      .eq('league_id', leagueId);
    setMembers((data ?? []).map((m: any) => m.profile).filter(Boolean));
  }

  function resetOnTypeChange(type: MatchType) {
    setMatchType(type);
    setP1(''); setPartner1(''); setP2(''); setPartner2('');
    setScore1(''); setScore2('');
    setStatusMsg(null);
  }

  function setError(text: string) {
    setStatusMsg({ text, isError: true });
  }

  async function submitMatch() {
    setStatusMsg(null);

    // Validation
    if (matchType === 'singles') {
      if (!p1 || !p2) return setError('Please select both players.');
      if (p1 === p2) return setError('Players must be different.');
    } else {
      if (!p1 || !partner1 || !p2 || !partner2) return setError('Please select all four players.');
      if (new Set([p1, partner1, p2, partner2]).size !== 4) return setError('All four players must be different.');
    }

    const s1 = parseInt(score1), s2 = parseInt(score2);
    if (isNaN(s1) || isNaN(s2) || score1 === '' || score2 === '') return setError('Please enter scores for both teams.');
    if (s1 < 0 || s2 < 0) return setError('Scores cannot be negative.');
    if (s1 === s2) return setError('Scores cannot be tied — pickleball always has a winner.');

    const winnerTeam = s1 > s2 ? 'team1' : 'team2';
    const winnerId   = winnerTeam === 'team1' ? p1 : p2;

    setLoading(true);
    const { error } = await supabase.from('matches').insert({
      league_id:    leagueId,
      match_type:   matchType,
      player1_id:   p1,
      partner1_id:  matchType === 'doubles' ? partner1 : null,
      player2_id:   p2,
      partner2_id:  matchType === 'doubles' ? partner2 : null,
      player1_score: s1,
      player2_score: s2,
      winner_id:    winnerId,
      winner_team:  winnerTeam,
    });
    setLoading(false);

    if (error) {
      setError(error.message);
    } else {
      setStatusMsg({ text: 'Match recorded! ELO ratings updated.', isError: false });
      setTimeout(() => navigation.goBack(), 1500);
    }
  }

  const team1Players = [p1, partner1].filter(Boolean);
  const team2Players = [p2, partner2].filter(Boolean);

  const p1Name  = members.find((m) => m.id === p1)?.full_name  ?? 'Team 1';
  const p2Name  = members.find((m) => m.id === p2)?.full_name  ?? 'Team 2';

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

      {/* Singles / Doubles toggle */}
      <View style={styles.toggleRow}>
        {(['singles', 'doubles'] as MatchType[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.toggleBtn, matchType === t && styles.toggleBtnActive]}
            onPress={() => resetOnTypeChange(t)}
          >
            <Text style={[styles.toggleText, matchType === t && styles.toggleTextActive]}>
              {t === 'singles' ? '1v1  Singles' : '2v2  Doubles'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Team 1 */}
      <View style={styles.teamSection}>
        <Text style={styles.teamLabel}>Team 1</Text>
        <PlayerPickerField label="Player" value={p1} onChange={setP1} members={members} exclude={[...team2Players, partner1]} />
        {matchType === 'doubles' && (
          <PlayerPickerField label="Partner" value={partner1} onChange={setPartner1} members={members} exclude={[...team2Players, p1]} />
        )}
      </View>

      {/* Team 2 */}
      <View style={styles.teamSection}>
        <Text style={styles.teamLabel}>Team 2</Text>
        <PlayerPickerField label="Player" value={p2} onChange={setP2} members={members} exclude={[...team1Players, partner2]} />
        {matchType === 'doubles' && (
          <PlayerPickerField label="Partner" value={partner2} onChange={setPartner2} members={members} exclude={[...team1Players, p2]} />
        )}
      </View>

      {/* Score entry */}
      <View style={styles.scoreCard}>
        <View style={styles.scoreCol}>
          <Text style={styles.scoreName} numberOfLines={1}>{p1Name}</Text>
          <TextInput
            style={styles.scoreInput}
            keyboardType="number-pad"
            value={score1}
            onChangeText={setScore1}
            placeholder="0"
            placeholderTextColor="#ccc"
            maxLength={2}
          />
        </View>
        <Text style={styles.vs}>vs</Text>
        <View style={styles.scoreCol}>
          <Text style={styles.scoreName} numberOfLines={1}>{p2Name}</Text>
          <TextInput
            style={styles.scoreInput}
            keyboardType="number-pad"
            value={score2}
            onChangeText={setScore2}
            placeholder="0"
            placeholderTextColor="#ccc"
            maxLength={2}
          />
        </View>
      </View>

      {/* Status message */}
      {statusMsg && (
        <View style={[styles.statusBox, statusMsg.isError ? styles.statusError : styles.statusSuccess]}>
          <Text style={[styles.statusText, statusMsg.isError ? styles.statusTextError : styles.statusTextSuccess]}>
            {statusMsg.isError ? '✕  ' : '✓  '}{statusMsg.text}
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={submitMatch}
        disabled={loading}
      >
        <Text style={styles.buttonText}>{loading ? 'Saving...' : 'Record Match'}</Text>
      </TouchableOpacity>

    </ScrollView>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#fff', flexGrow: 1, paddingBottom: 40 },
  toggleRow: { flexDirection: 'row', borderRadius: 10, borderWidth: 1.5, borderColor: '#ddd', overflow: 'hidden', marginBottom: 20 },
  toggleBtn: { flex: 1, padding: 12, alignItems: 'center', backgroundColor: '#fafafa' },
  toggleBtnActive: { backgroundColor: GREEN },
  toggleText: { fontSize: 15, fontWeight: '600', color: '#888' },
  toggleTextActive: { color: '#fff' },
  teamSection: { backgroundColor: '#f9f9f9', borderRadius: 10, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#eee' },
  teamLabel: { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },
  label: { fontSize: 13, fontWeight: '600', color: '#444', marginBottom: 5, marginTop: 10 },
  pickerWrapper: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  scoreCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9f9f9', borderRadius: 12, padding: 16, marginVertical: 8, gap: 12, borderWidth: 1, borderColor: '#eee' },
  scoreCol: { flex: 1, alignItems: 'center' },
  scoreName: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 8, textAlign: 'center' },
  scoreInput: { borderWidth: 2, borderColor: '#ddd', borderRadius: 10, padding: 12, fontSize: 28, textAlign: 'center', fontWeight: '800', color: '#1a1a1a', width: 72, backgroundColor: '#fff' },
  vs: { fontSize: 16, fontWeight: '700', color: '#bbb' },
  statusBox: { borderRadius: 8, padding: 14, marginTop: 8, marginBottom: 4 },
  statusError: { backgroundColor: '#ffebee' },
  statusSuccess: { backgroundColor: '#e8f5e9' },
  statusText: { fontSize: 14, fontWeight: '600' },
  statusTextError: { color: '#c62828' },
  statusTextSuccess: { color: GREEN },
  button: { backgroundColor: GREEN, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 12 },
  buttonDisabled: { backgroundColor: '#a5d6a7' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
