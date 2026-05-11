import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, Platform,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Picker } from '@react-native-picker/picker';
import { supabase } from '../lib/supabase';
import { DoublesCategory, Profile, RootStackParamList } from '../types';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import { useTheme } from '../lib/ThemeContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchEntry'>;
  route: RouteProp<RootStackParamList, 'MatchEntry'>;
};

type MatchType = 'singles' | 'doubles';
type StatusMsg = { text: string; isError: boolean } | null;

// Cross-platform player picker: HTML <select> on web, native Picker on iOS/Android
function PlayerPickerField({ label, value, onChange, members, exclude, S, colors }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  members: Profile[];
  exclude: string[];
  S: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useTheme>['colors'];
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
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            backgroundColor: colors.surface,
            color: value ? colors.text : colors.textMuted,
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
      <Text style={S.label}>{label}</Text>
      <View style={S.pickerWrapper}>
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
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [members, setMembers] = useState<Profile[]>([]);
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [p1, setP1] = useState('');
  const [partner1, setPartner1] = useState('');
  const [p2, setP2] = useState('');
  const [partner2, setPartner2] = useState('');
  const [score1, setScore1] = useState('');
  const [score2, setScore2] = useState('');
  const [location, setLocation]     = useState<CourtResult | null>(null);
  const [isOutdoor, setIsOutdoor]   = useState<boolean | null>(null);
  const [courtHint, setCourtHint]   = useState<string | null>(null);
  const [myDefaultPaddleId, setMyDefaultPaddleId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const [statusMsg, setStatusMsg]   = useState<StatusMsg>(null);

  useEffect(() => { loadLeagueData(); }, []);

  const [leagueHomeCourt, setLeagueHomeCourt] = useState<string | null>(null);

  async function loadLeagueData() {
    const { data: { user } } = await supabase.auth.getUser();
    const [membersRes, leagueRes, paddleRes] = await Promise.all([
      supabase.from('league_members').select('profile:profiles(*)').eq('league_id', leagueId),
      supabase.from('leagues').select('home_court, home_court_lat, home_court_lng').eq('id', leagueId).single(),
      user ? supabase.from('player_paddles').select('id').eq('user_id', user.id).eq('is_default', true).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    if (paddleRes.data) setMyDefaultPaddleId(paddleRes.data.id);
    setMembers((membersRes.data ?? []).map((m: any) => m.profile).filter(Boolean));
    const lg = leagueRes.data;
    if (lg?.home_court) {
      setLeagueHomeCourt(lg.home_court);
      setLocation({ name: lg.home_court, address: '', lat: lg.home_court_lat ?? 0, lng: lg.home_court_lng ?? 0, placeId: '' });
    }
  }

  // Determine indoor/outdoor default for a location.
  // Primary source: court_locations table (authoritative, keyword-seeded + user-confirmed).
  // Fallback: aggregate of past match flags at this location.
  async function learnCourtDefault(locationName: string) {
    setCourtHint(null);
    if (!locationName) return;

    // ── Primary: court_locations ───────────────────────────────
    const { data: court } = await supabase
      .from('court_locations')
      .select('has_indoor, has_outdoor, default_outdoor, auto_classified, verified')
      .eq('name', locationName)
      .maybeSingle();

    if (court) {
      const hasBoth = court.has_indoor && court.has_outdoor;
      const source  = court.verified        ? '✓ verified'
                    : court.auto_classified  ? 'auto-detected'
                    : 'learned from past matches';

      if (hasBoth) {
        setCourtHint(`🏠 / ☀️ Has both indoor and outdoor courts · ${source}`);
        // Don't pre-select if mixed — let user choose
      } else if (court.default_outdoor === true) {
        setIsOutdoor(true);
        setCourtHint(`☀️ Outdoor · ${source}`);
      } else if (court.default_outdoor === false) {
        setIsOutdoor(false);
        setCourtHint(`🏠 Indoor · ${source}`);
      } else {
        // Row exists but no default yet — fall through to match history
        setCourtHint(null);
      }

      if (court.default_outdoor !== null || hasBoth) return;
    }

    // ── Fallback: aggregate of existing match flags ────────────
    const { data: history } = await supabase
      .from('matches')
      .select('is_outdoor')
      .eq('location_name', locationName)
      .not('is_outdoor', 'is', null)
      .limit(100);

    if (!history || history.length < 3) return;

    const outdoorCount = history.filter((m: any) => m.is_outdoor === true).length;
    const pct          = outdoorCount / history.length;

    if (pct >= 0.80) {
      setIsOutdoor(true);
      setCourtHint(`☀️ Outdoor — based on ${history.length} past matches here`);
    } else if (pct <= 0.20) {
      setIsOutdoor(false);
      setCourtHint(`🏠 Indoor — based on ${history.length} past matches here`);
    } else {
      setCourtHint(`🏠 / ☀️ Mixed (${Math.round(pct * 100)}% outdoor across ${history.length} matches)`);
    }
  }

  // Re-learn when location changes
  useEffect(() => {
    if (location?.name) learnCourtDefault(location.name);
    else { setIsOutdoor(null); setCourtHint(null); }
  }, [location?.name]);

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
    if (!location) return setError('Please enter a match location.');

    const winnerTeam = s1 > s2 ? 'team1' : 'team2';
    const winnerId   = winnerTeam === 'team1' ? p1 : p2;

    setLoading(true);
    const { data, error } = await supabase.from('matches').insert({
      league_id:    leagueId,
      match_type:   matchType,
      player1_id:   p1,
      partner1_id:  matchType === 'doubles' ? partner1 : null,
      player2_id:   p2,
      partner2_id:  matchType === 'doubles' ? partner2 : null,
      player1_score: s1,
      player2_score: s2,
      winner_id:      winnerId,
      winner_team:    winnerTeam,
      location_name:  location?.name ?? null,
      location_lat:   location?.lat ?? null,
      location_lng:   location?.lng ?? null,
      was_home_court: !!(location?.name && leagueHomeCourt && location.name === leagueHomeCourt),
      is_home_court:  !!(location?.name && leagueHomeCourt && location.name === leagueHomeCourt),
      is_outdoor:     isOutdoor,
    }).select('id').single();
    setLoading(false);

    if (error) {
      setError(error.message);
    } else {
      // Record paddle usage for all players who have a default paddle
      // Can be edited within 72h of match
      if (data && myDefaultPaddleId) {
        const { data: { user } } = await supabase.auth.getUser();
        const canEditUntil = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
        await supabase.from('match_paddle_usage').upsert({
          match_id: (data as any).id,
          user_id:  user!.id,
          paddle_id: myDefaultPaddleId,
          can_edit_until: canEditUntil,
        });
      }
      setStatusMsg({ text: 'Match recorded! PLUPR ratings updated.', isError: false });
      setTimeout(() => navigation.goBack(), 1500);
    }
  }

  const team1Players = [p1, partner1].filter(Boolean);
  const team2Players = [p2, partner2].filter(Boolean);

  const p1Name  = members.find((m) => m.id === p1)?.full_name  ?? 'Team 1';
  const p2Name  = members.find((m) => m.id === p2)?.full_name  ?? 'Team 2';

  // Derive doubles category preview (mirrors server logic in classify_doubles_match).
  // Server is the source of truth — this is purely informational so the recorder
  // knows which PLUPR bucket the match will hit.
  const doublesCategory: DoublesCategory | null = (() => {
    if (matchType !== 'doubles') return null;
    if (!p1 || !partner1 || !p2 || !partner2) return null;
    const ids = [p1, partner1, p2, partner2];
    const genders = ids.map(id => members.find(m => m.id === id)?.gender ?? null);
    if (genders.some(g => g == null || g === 'prefer-not-to-say')) return 'unspecified';
    return new Set(genders).size === 1 ? 'gendered' : 'mixed';
  })();

  return (
    <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">

      {/* Singles / Doubles toggle */}
      <View style={S.toggleRow}>
        {(['singles', 'doubles'] as MatchType[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[S.toggleBtn, matchType === t && S.toggleBtnActive]}
            onPress={() => resetOnTypeChange(t)}
          >
            <Text style={[S.toggleText, matchType === t && S.toggleTextActive]}>
              {t === 'singles' ? 'Singles' : 'Doubles'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Team 1 */}
      <View style={S.teamSection}>
        <Text style={S.teamLabel}>Team 1</Text>
        <PlayerPickerField label="Player" value={p1} onChange={setP1} members={members} exclude={[...team2Players, partner1]} S={S} colors={colors} />
        {matchType === 'doubles' && (
          <PlayerPickerField label="Partner" value={partner1} onChange={setPartner1} members={members} exclude={[...team2Players, p1]} S={S} colors={colors} />
        )}
      </View>

      {/* Team 2 */}
      <View style={S.teamSection}>
        <Text style={S.teamLabel}>Team 2</Text>
        <PlayerPickerField label="Player" value={p2} onChange={setP2} members={members} exclude={[...team1Players, partner2]} S={S} colors={colors} />
        {matchType === 'doubles' && (
          <PlayerPickerField label="Partner" value={partner2} onChange={setPartner2} members={members} exclude={[...team1Players, p2]} S={S} colors={colors} />
        )}
      </View>

      {/* Doubles category preview */}
      {doublesCategory && (
        <View style={[
          S.categoryCard,
          doublesCategory === 'gendered'    && S.categoryCardGendered,
          doublesCategory === 'mixed'       && S.categoryCardMixed,
          doublesCategory === 'unspecified' && S.categoryCardUnspecified,
        ]}>
          <Text style={S.categoryHeader}>
            {doublesCategory === 'gendered'    ? '🏓 Gendered Doubles' :
             doublesCategory === 'mixed'       ? '🏓 Mixed Doubles'    :
                                                 '⚠️ Uncategorized Doubles'}
          </Text>
          <Text style={S.categorySub}>
            {doublesCategory === 'gendered'    ? 'All four players share the same gender — updates Gendered Doubles PLUPR.' :
             doublesCategory === 'mixed'       ? 'Players span multiple genders — updates Mixed Doubles PLUPR.'             :
                                                 'At least one player hasn\'t set a gender (or chose Prefer not to say). This match will be saved but won\'t affect any PLUPR until everyone sets a gender.'}
          </Text>
        </View>
      )}

      {/* Score entry */}
      <View style={S.scoreCard}>
        <View style={S.scoreCol}>
          <Text style={S.scoreName} numberOfLines={1}>{p1Name}</Text>
          <TextInput
            style={S.scoreInput}
            keyboardType="number-pad"
            value={score1}
            onChangeText={setScore1}
            placeholder="0"
            placeholderTextColor={colors.border}
            maxLength={2}
          />
        </View>
        <Text style={S.vs}>vs</Text>
        <View style={S.scoreCol}>
          <Text style={S.scoreName} numberOfLines={1}>{p2Name}</Text>
          <TextInput
            style={S.scoreInput}
            keyboardType="number-pad"
            value={score2}
            onChangeText={setScore2}
            placeholder="0"
            placeholderTextColor={colors.border}
            maxLength={2}
          />
        </View>
      </View>

      {/* Location */}
      <View style={S.locationSection}>
        <Text style={S.locationLabel}>
          Match Location
          {!location && <Text style={S.locationRequired}> *</Text>}
        </Text>
        <CourtPicker
          value={location}
          onSelect={setLocation}
          active
          placeholder="Search for the court played at..."
        />
      </View>

      {/* Indoor / Outdoor */}
      <View style={S.courtTypeSection}>
        <Text style={S.courtTypeLabel}>Court Type</Text>
        {courtHint && (
          <Text style={S.courtHint}>📍 {courtHint}</Text>
        )}
        <View style={S.courtTypeRow}>
          {([false, true] as const).map(outdoor => (
            <TouchableOpacity
              key={String(outdoor)}
              style={[
                S.courtTypeBtn,
                isOutdoor === outdoor && S.courtTypeBtnActive,
              ]}
              onPress={() => setIsOutdoor(prev => prev === outdoor ? null : outdoor)}
            >
              <Text style={S.courtTypeIcon}>{outdoor ? '☀️' : '🏠'}</Text>
              <Text style={[
                S.courtTypeText,
                isOutdoor === outdoor && S.courtTypeTextActive,
              ]}>
                {outdoor ? 'Outdoor' : 'Indoor'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Status message */}
      {statusMsg && (
        <View style={[S.statusBox, statusMsg.isError ? S.statusError : S.statusSuccess]}>
          <Text style={[S.statusText, statusMsg.isError ? S.statusTextError : S.statusTextSuccess]}>
            {statusMsg.isError ? '✕  ' : '✓  '}{statusMsg.text}
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[S.button, loading && S.buttonDisabled]}
        onPress={submitMatch}
        disabled={loading}
      >
        <Text style={S.buttonText}>{loading ? 'Saving...' : 'Record Match'}</Text>
      </TouchableOpacity>

    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 20, backgroundColor: c.surface, flexGrow: 1, paddingBottom: 40 },
    toggleRow: { flexDirection: 'row', borderRadius: 10, borderWidth: 1.5, borderColor: c.border, overflow: 'hidden', marginBottom: 20 },
    toggleBtn: { flex: 1, padding: 12, alignItems: 'center', backgroundColor: c.surfaceAlt },
    toggleBtnActive: { backgroundColor: c.primary },
    toggleText: { fontSize: 15, fontWeight: '600', color: c.textMuted },
    toggleTextActive: { color: '#fff' },
    teamSection: { backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: c.border, elevation: 1, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    teamLabel: { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },

    categoryCard:            { borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1.5 },
    categoryCardGendered:    { backgroundColor: c.primaryLight, borderColor: c.primary },
    categoryCardMixed:       { backgroundColor: '#f3e5f5',      borderColor: '#8e24aa' },
    categoryCardUnspecified: { backgroundColor: '#fff8e1',      borderColor: '#f57f17' },
    categoryHeader:          { fontSize: 14, fontWeight: '800', color: c.text, marginBottom: 4 },
    categorySub:             { fontSize: 12, color: c.textSub, lineHeight: 16 },
    label: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 5, marginTop: 10 },
    pickerWrapper: { borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: 'hidden', backgroundColor: c.surface },
    scoreCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 16, marginVertical: 8, gap: 12, borderWidth: 1, borderColor: c.border, elevation: 1, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    scoreCol: { flex: 1, alignItems: 'center' },
    scoreName: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 8, textAlign: 'center' },
    scoreInput: { borderWidth: 2, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 28, textAlign: 'center', fontWeight: '800', color: c.text, width: 72, backgroundColor: c.surface },
    vs: { fontSize: 16, fontWeight: '700', color: c.border },
    statusBox: { borderRadius: 8, padding: 14, marginTop: 8, marginBottom: 4 },
    statusError: { backgroundColor: '#ffebee' },
    statusSuccess: { backgroundColor: c.primaryLight },
    statusText: { fontSize: 14, fontWeight: '600' },
    statusTextError: { color: c.danger },
    statusTextSuccess: { color: c.primary },
    locationSection: { marginTop: 8, marginBottom: 4 },
    locationLabel: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 6 },
    locationRequired: { color: c.danger },
    courtTypeSection: { marginTop: 12, marginBottom: 4 },
    courtTypeLabel: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 4 },
    courtHint: { fontSize: 12, color: c.textMuted, marginBottom: 6, fontStyle: 'italic' },
    courtTypeRow: { flexDirection: 'row', gap: 10 },
    courtTypeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 10, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    courtTypeBtnActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    courtTypeIcon: { fontSize: 18 },
    courtTypeText: { fontSize: 14, fontWeight: '600', color: c.textMuted },
    courtTypeTextActive: { color: c.primary },
    button: { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 12 },
    buttonDisabled: { backgroundColor: c.primary + '80' },
    buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  });
}
