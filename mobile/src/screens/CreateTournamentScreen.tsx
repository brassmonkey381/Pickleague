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
import { checkGodmode, countActiveOwnedTournaments } from '../lib/godmode';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'CreateTournament'>;
  route: RouteProp<RootStackParamList, 'CreateTournament'>;
};

const FORMATS: TournamentFormat[] = [
  'round_robin', 'single_elimination', 'double_elimination',
  'pool_play', 'mlp', 'mlp_random', 'rotating_partners',
];

function Pill({ label, active, onPress, S }: { label: string; active: boolean; onPress: () => void; S: ReturnType<typeof makeStyles> }) {
  return (
    <TouchableOpacity style={[S.pill, active && S.pillActive]} onPress={onPress}>
      <Text style={[S.pillText, active && S.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function SectionHeader({ title, S }: { title: string; S: ReturnType<typeof makeStyles> }) {
  return <Text style={S.sectionHeader}>{title}</Text>;
}

export default function CreateTournamentScreen({ navigation, route }: Props) {
  const { leagueId } = route.params ?? {};
  const { colors } = useTheme();
  const S = makeStyles(colors);

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

  // Pickle pot
  const [ante, setAnte]               = useState('0');
  const [payoutText, setPayoutText]   = useState('60,25,15');

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState(false);

  function parsePayout(): number[] | null {
    const parts = payoutText.split(',').map(s => parseInt(s.trim(), 10));
    if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    if (parts.reduce((a, b) => a + b, 0) !== 100) return null;
    return parts;
  }

  async function submit() {
    setError('');
    if (!name.trim()) { setError('Please enter a tournament name.'); return; }
    const anteNum = parseInt(ante, 10);
    if (!Number.isFinite(anteNum) || anteNum < 0) { setError('Ante must be 0 or a positive number.'); return; }
    const structure = parsePayout();
    if (!structure) { setError('Payout structure must be comma-separated percentages summing to 100 (e.g. 60,25,15).'); return; }

    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();

    // Per-account active-tournament limit (godmode bypasses)
    if (user?.id) {
      const [godmode, activeCount] = await Promise.all([
        checkGodmode(),
        countActiveOwnedTournaments(user.id),
      ]);
      if (!godmode && activeCount >= 1) {
        setLoading(false);
        setError("You're already running an active tournament. Wait for it to end (or cancel it) before starting another.");
        return;
      }
    }

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
      pickle_ante:       anteNum,
      payout_structure:  structure,
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
      <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">

        {/* ── Basics ── */}
        <SectionHeader title="Basics" S={S} />

        <Text style={S.label}>Tournament Name *</Text>
        <TextInput style={S.input} placeholder="e.g. Spring Smash Classic" placeholderTextColor={colors.textMuted} value={name} onChangeText={setName} />

        <Text style={S.label}>Description (optional)</Text>
        <TextInput style={[S.input, S.multiline]} placeholder="Rules, prizes, notes…" placeholderTextColor={colors.textMuted} value={description} onChangeText={setDescription} multiline />

        <Text style={S.label}>Date & Time</Text>
        <TouchableOpacity style={S.dateBtn} onPress={() => setShowDatePicker(true)}>
          <Text style={S.dateBtnText}>
            {startTime
              ? startTime.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : 'Set date & time'}
          </Text>
          {startTime && (
            <TouchableOpacity onPress={() => setStartTime(null)}>
              <Text style={S.clearDate}>✕</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>

        <Text style={S.label}>Location</Text>
        <CourtPicker value={location} onSelect={setLocation} active showNoneOption placeholder="Search for tournament venue…" />

        <Text style={S.label}>Max Players</Text>
        <TextInput style={[S.input, S.inputSmall]} placeholder="No limit" placeholderTextColor={colors.textMuted} keyboardType="number-pad" value={maxPlayers} onChangeText={setMaxPlayers} />

        {/* ── Format ── */}
        <SectionHeader title="Format" S={S} />

        <View style={S.formatGrid}>
          {FORMATS.map(f => {
            const meta = FORMAT_META[f];
            const active = format === f;
            return (
              <TouchableOpacity
                key={f}
                style={[S.formatCard, active && S.formatCardActive]}
                onPress={() => setFormat(f)}
              >
                <Text style={S.formatIcon}>{meta.icon}</Text>
                <Text style={[S.formatLabel, active && S.formatLabelActive]}>{meta.label}</Text>
                <Text style={S.formatDesc}>{meta.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Match type ── */}
        <SectionHeader title="Match Type" S={S} />
        <View style={S.pillRow}>
          <Pill label="Singles" active={matchType === 'singles'} onPress={() => setMatchType('singles')} S={S} />
          <Pill label="Doubles" active={matchType === 'doubles'} onPress={() => setMatchType('doubles')} S={S} />
        </View>

        {/* ── Seeding ── */}
        <SectionHeader title="Bracket Seeding" S={S} />
        <View style={S.pillRow}>
          <Pill label="🎲 Random draw"  active={seeding === 'random'} onPress={() => setSeeding('random')} S={S} />
          <Pill label="📊 PLUPR-based" active={seeding === 'elo'}    onPress={() => setSeeding('elo')}    S={S} />
        </View>
        <Text style={S.hint}>
          {seeding === 'elo'
            ? 'Determines bracket structure and which players face off in each round. Players are sorted by PLUPR; pools and brackets use snake-draft so the top seed faces the bottom seed and skill levels stay balanced across pools.'
            : 'Determines bracket structure and which players face off in each round. Players are drawn randomly into pools and bracket slots.'}
        </Text>

        {/* ── Pool count (pool play only) ── */}
        {format === 'pool_play' && (
          <>
            <SectionHeader title="Number of Pools" S={S} />
            <View style={S.pillRow}>
              {[2, 3, 4, 6].map(n => (
                <Pill key={n} label={`${n} pools`} active={poolCount === n} onPress={() => setPoolCount(n)} S={S} />
              ))}
            </View>
            <Text style={S.hint}>Players are distributed evenly. Snake-draft keeps pools balanced by PLUPR when seeding is on.</Text>
          </>
        )}

        {/* ── Partner rotation (rotating_partners only) ── */}
        {format === 'rotating_partners' && (
          <>
            <SectionHeader title="Partner Rotation" S={S} />
            <View style={S.pillRow}>
              <Pill label="Every match"  active={partnerRotation === 'every_match'}  onPress={() => setPartnerRotation('every_match')}  S={S} />
              <Pill label="Every round"  active={partnerRotation === 'every_round'}  onPress={() => setPartnerRotation('every_round')}  S={S} />
            </View>
            <Text style={S.hint}>Partners rotate so every player pairs with different teammates over the course of the tournament.</Text>
          </>
        )}

        {/* ── Registration ── */}
        <SectionHeader title="Registration" S={S} />
        <Text style={S.closedNote}>🔒 All tournaments are closed — players must be approved to participate.</Text>

        <View style={S.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={S.label}>Invite only</Text>
            <Text style={S.hint}>{inviteOnly ? 'Only players you invite can register.' : 'Players can request to join; you approve them.'}</Text>
          </View>
          <Switch value={inviteOnly} onValueChange={setInviteOnly} trackColor={{ true: colors.primary }} thumbColor="#fff" />
        </View>

        {/* ── Pickle pot ── */}
        <SectionHeader title="🥒 Pickle Pot" S={S} />

        <Text style={S.label}>Entry Ante</Text>
        <TextInput
          style={[S.input, S.inputSmall]}
          placeholder="0"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
          value={ante}
          onChangeText={setAnte}
        />
        <Text style={S.hint}>
          Pickles each player pays on approval. Goes into the prize pool. Set to 0 for free entry.
        </Text>

        <Text style={S.label}>Payout Structure</Text>
        <TextInput
          style={S.input}
          placeholder="60,25,15"
          placeholderTextColor={colors.textMuted}
          value={payoutText}
          onChangeText={setPayoutText}
        />
        <Text style={S.hint}>
          Comma-separated percentages for top finishers (must sum to 100). Default is 60% / 25% / 15% for 1st / 2nd / 3rd. Locked once registration closes.
        </Text>

        {/* ── Status / submit ── */}
        {error ? (
          <View style={S.errorBox}><Text style={S.errorText}>{error}</Text></View>
        ) : null}
        {success ? (
          <View style={S.successBox}><Text style={S.successText}>✓ Tournament created!</Text></View>
        ) : null}

        <TouchableOpacity
          style={[S.submitBtn, loading && S.submitBtnDisabled]}
          onPress={submit}
          disabled={loading || success}
        >
          <Text style={S.submitText}>{loading ? 'Creating…' : 'Create Tournament'}</Text>
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

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 20, backgroundColor: c.surface, flexGrow: 1, paddingBottom: 48 },
    sectionHeader: { fontSize: 15, fontWeight: '800', color: c.text, marginTop: 28, marginBottom: 10, borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 6 },
    label: { fontSize: 13, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 12 },
    hint: { fontSize: 12, color: c.textMuted, marginTop: 6, lineHeight: 17 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 13, fontSize: 15, color: c.text, backgroundColor: c.surface },
    multiline: { height: 68, textAlignVertical: 'top' },
    inputSmall: { width: 120 },
    dateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 13 },
    dateBtnText: { fontSize: 15, color: c.textSub },
    clearDate: { fontSize: 15, color: c.textMuted, paddingHorizontal: 4 },
    formatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    formatCard: { width: '47%', borderWidth: 1.5, borderColor: c.border, borderRadius: 14, padding: 12, backgroundColor: c.surfaceAlt, elevation: 1, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    formatCardActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    formatIcon: { fontSize: 26, marginBottom: 4 },
    formatLabel: { fontSize: 13, fontWeight: '700', color: c.textSub },
    formatLabelActive: { color: c.primary },
    formatDesc: { fontSize: 11, color: c.textMuted, marginTop: 3, lineHeight: 15 },
    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    pillActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    pillText: { fontSize: 13, color: c.textSub, fontWeight: '500' },
    pillTextActive: { color: c.primary, fontWeight: '700' },
    closedNote: { fontSize: 13, color: c.textMuted, backgroundColor: c.surfaceAlt, borderRadius: 8, padding: 10, marginBottom: 4 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 14, marginTop: 8 },
    errorBox: { backgroundColor: '#ffebee', borderRadius: 8, padding: 12, marginTop: 12 },
    errorText: { color: c.danger, fontSize: 14, fontWeight: '600' },
    successBox: { backgroundColor: c.primaryLight, borderRadius: 8, padding: 12, marginTop: 12 },
    successText: { color: c.primary, fontSize: 14, fontWeight: '700' },
    submitBtn: { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 20 },
    submitBtnDisabled: { backgroundColor: c.primary + '80' },
    submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  });
}
