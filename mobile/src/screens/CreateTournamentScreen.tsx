import React, { useState, useEffect } from 'react';
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

// MLP is no longer a "Format" — it's selected via Match Type. The Format
// selector below presents only the 5 structural formats; when the user picks
// Match Type = MLP, the Format selector hides and the MLP-specific Team
// Creation + Play Format pickers take over.
const FORMATS: TournamentFormat[] = [
  'round_robin', 'single_elimination', 'double_elimination',
  'pool_play', 'rotating_partners',
];

type UiMatchType = 'singles' | 'doubles' | 'mlp';
type TeamCreation = 'fixed' | 'random';

// Returns the next Saturday at 9am local time. If it's already Saturday and
// past 9am, jumps to next week's Saturday so the default is always in the future.
function nextSaturday9am(): Date {
  const d = new Date();
  const dow = d.getDay();      // 0=Sun..6=Sat
  let daysUntil = (6 - dow + 7) % 7;
  if (daysUntil === 0 && d.getHours() >= 9) daysUntil = 7;
  d.setDate(d.getDate() + daysUntil);
  d.setHours(9, 0, 0, 0);
  return d;
}

// Auto-name: "{Prefix} {Format Label}, {Match Type}".
// Prefix prefers the league name; falls back to the location name; if neither
// is set, returns just "{Format Label}, {Match Type}".
function makeAutoName(
  prefix: string | null,
  format: TournamentFormat,
  matchType: UiMatchType,
): string {
  const fmt  = FORMAT_META[format].label;
  // For MLP, the format label already includes "Fixed Teams" / "Random Teams",
  // so don't append a redundant "Doubles" suffix.
  const typeSuffix = matchType === 'singles' ? ', Singles'
                   : matchType === 'doubles' ? ', Doubles'
                   : '';
  return `${prefix ? `${prefix} ` : ''}${fmt}${typeSuffix}`;
}

function Pill({ label, active, onPress, S, disabled }: { label: string; active: boolean; onPress: () => void; S: ReturnType<typeof makeStyles>; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[S.pill, active && S.pillActive, disabled && { opacity: 0.4 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[S.pillText, active && S.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// rotating_partners is the only Format-selector value that is doubles-only;
// MLP is handled via matchType='mlp' and DOES NOT appear in FORMATS now.
const DOUBLES_ONLY_FORMATS: TournamentFormat[] = ['rotating_partners'];

function SectionHeader({ title, S }: { title: string; S: ReturnType<typeof makeStyles> }) {
  return <Text style={S.sectionHeader}>{title}</Text>;
}

export default function CreateTournamentScreen({ navigation, route }: Props) {
  const { leagueId } = route.params ?? {};
  const { colors } = useTheme();
  const S = makeStyles(colors);

  // Basics
  const [name, setName]                   = useState('');
  const [nameManuallyEdited, setNameEdited] = useState(false);
  const [leagueName, setLeagueName]       = useState<string | null>(null);
  const [description, setDescription]     = useState('');
  const [startTime, setStartTime]         = useState<Date | null>(nextSaturday9am());
  const [durationHours, setDurationHours] = useState('3');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [location, setLocation]           = useState<CourtResult | null>(null);
  const [maxPlayers, setMaxPlayers]       = useState('');

  // Format
  const [format, setFormat]           = useState<TournamentFormat>('round_robin');
  // Default to doubles — the most common match type. MLP is the 3rd option.
  const [matchType, setMatchType]     = useState<UiMatchType>('doubles');
  const [teamCreation, setTeamCreation] = useState<TeamCreation>('fixed');
  const [seeding, setSeeding]         = useState<'random' | 'elo'>('random');
  const [poolCount, setPoolCount]     = useState(2);
  const [partnerRotation, setPartnerRotation] = useState<'every_match' | 'every_round'>('every_match');
  const [playoffFormat, setPlayoffFormat] = useState<'none' | 'top_2' | 'top_4' | 'top_8'>('none');

  // Registration
  const [inviteOnly, setInviteOnly]   = useState(false);

  // Pickle pot
  const [ante, setAnte]               = useState('0');
  const [payoutText, setPayoutText]   = useState('60,25,15');

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState(false);

  // Fetch the league name + home court when a leagueId is passed in, so we
  // can both use the name as the auto-name prefix AND pre-fill the location
  // with the league's home court. When there's no leagueId, fall back to the
  // user's most recently-created tournament location.
  useEffect(() => {
    let cancelled = false;
    if (leagueId) {
      supabase
        .from('leagues')
        .select('name, home_court, home_court_lat, home_court_lng')
        .eq('id', leagueId)
        .single()
        .then(({ data }) => {
          if (cancelled) return;
          setLeagueName(data?.name ?? null);
          // Only pre-fill if the user hasn't picked something already.
          if (data?.home_court) {
            setLocation(prev => prev ?? ({
              name:    data.home_court as string,
              address: '',
              lat:     data.home_court_lat  ?? 0,
              lng:     data.home_court_lng  ?? 0,
              placeId: `league-${leagueId}-${data.home_court}`,
            }));
          }
        });
    } else {
      setLeagueName(null);
      // No league context — pre-fill from the user's most recent tournament.
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (cancelled || !user) return;
        supabase
          .from('tournaments')
          .select('location_name, location_lat, location_lng')
          .eq('created_by', user.id)
          .not('location_name', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(({ data: t }) => {
            if (cancelled || !t?.location_name) return;
            setLocation(prev => prev ?? ({
              name:    t.location_name as string,
              address: '',
              lat:     t.location_lat ?? 0,
              lng:     t.location_lng ?? 0,
              placeId: `prev-${t.location_name}`,
            }));
          });
      });
    }
    return () => { cancelled = true; };
  }, [leagueId]);

  // Auto-name: regenerate whenever league / location / format / match type
  // changes — until the user manually edits the name field, at which point
  // we leave it alone so we don't clobber their input.
  useEffect(() => {
    if (nameManuallyEdited) return;
    const prefix = leagueName ?? location?.name ?? null;
    // For MLP, the "effective" format label is mlp / mlp_random (Fixed / Random
    // teams) so the auto-name reads naturally. Non-MLP uses the selected format.
    const effectiveFormat: TournamentFormat = matchType === 'mlp'
      ? (teamCreation === 'random' ? 'mlp_random' : 'mlp')
      : format;
    setName(makeAutoName(prefix, effectiveFormat, matchType));
  }, [leagueName, location?.name, format, matchType, teamCreation, nameManuallyEdited]);

  const isDoublesOnlyFormat = DOUBLES_ONLY_FORMATS.includes(format);

  // rotating_partners can't generate a singles bracket — force matchType to
  // doubles. (MLP is its own matchType value, handled separately.)
  useEffect(() => {
    if (isDoublesOnlyFormat && matchType === 'singles') setMatchType('doubles');
  }, [isDoublesOnlyFormat, matchType]);


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
    const durationNum = parseFloat(durationHours);
    if (!Number.isFinite(durationNum) || durationNum <= 0) {
      setError('Expected duration must be a positive number of hours.');
      return;
    }
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

    // UI → DB translation. MLP is selected via matchType='mlp' in the UI, but
    // the DB still stores 'mlp' / 'mlp_random' as the `format` value and
    // 'doubles' as the underlying match_type. Only include MLP-specific
    // columns when the tournament is actually MLP.
    const isMlp = matchType === 'mlp';
    const dbFormat: TournamentFormat = isMlp
      ? (teamCreation === 'random' ? 'mlp_random' : 'mlp')
      : format;
    const dbMatchType: 'singles' | 'doubles' = isMlp ? 'doubles' : matchType;
    const insertPayload: Record<string, any> = {
      league_id:         leagueId ?? null,
      name:              name.trim(),
      description:       description.trim() || null,
      created_by:        user!.id,
      format:            dbFormat,
      match_type:        dbMatchType,
      seeding,
      pool_count:        dbFormat === 'pool_play' ? poolCount : 1,
      partner_rotation:  dbFormat === 'rotating_partners' ? partnerRotation : null,
      // Captures Fixed vs Random for both Doubles and MLP. Singles ignores it.
      team_creation:     (matchType === 'doubles' || matchType === 'mlp') ? teamCreation : 'fixed',
      registration_mode: inviteOnly ? 'invite_only' : 'request',
      max_players:       maxPlayers ? parseInt(maxPlayers) : null,
      start_time:        startTime?.toISOString() ?? null,
      expected_duration_hours: durationNum,
      location_name:     location?.name ?? null,
      location_lat:      location?.lat ?? null,
      location_lng:      location?.lng ?? null,
      pickle_ante:       anteNum,
      payout_structure:  structure,
    };
    if (isMlp) {
      // Derive the legacy MLP-specific columns from the unified Format +
      // Playoff Format pickers. mlp_play_format encodes the combination:
      //   format=round_robin + playoff=none   → round_robin
      //   format=round_robin + playoff=top_X  → round_robin_playoff (with mlp_playoff_teams=X)
      //   format=pool_play   + playoff=none   → pool_play
      //   format=pool_play   + playoff=top_X  → pool_play_playoff
      const hasPlayoff = playoffFormat !== 'none';
      const mlpPlayFormat =
        format === 'pool_play'
          ? (hasPlayoff ? 'pool_play_playoff' : 'pool_play')
          : (hasPlayoff ? 'round_robin_playoff' : 'round_robin');
      const mlpPlayoffTeams =
        playoffFormat === 'top_2' ? 2 :
        playoffFormat === 'top_8' ? 8 : 4;
      insertPayload.mlp_play_format   = mlpPlayFormat;
      insertPayload.mlp_pool_count    = format === 'pool_play' ? poolCount : 2;
      insertPayload.mlp_playoff_teams = mlpPlayoffTeams;
    } else if (format === 'round_robin' || format === 'pool_play') {
      insertPayload.playoff_format = playoffFormat;
    }

    const { data: t, error: err } = await supabase
      .from('tournaments')
      .insert(insertPayload)
      .select()
      .single();

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
        <Text style={S.hint}>Defaults to the upcoming Saturday at 9 AM. Tap to change.</Text>

        <Text style={S.label}>Expected Duration (hours)</Text>
        <TextInput
          style={[S.input, S.inputSmall]}
          placeholder="3"
          placeholderTextColor={colors.textMuted}
          keyboardType="decimal-pad"
          value={durationHours}
          onChangeText={setDurationHours}
        />
        <Text style={S.hint}>Roughly how long the tournament will run. Helps players plan their day.</Text>

        <Text style={S.label}>Location</Text>
        <CourtPicker value={location} onSelect={setLocation} active showNoneOption placeholder="Search for tournament venue…" />

        <Text style={S.label}>Max Players</Text>
        <TextInput style={[S.input, S.inputSmall]} placeholder="No limit" placeholderTextColor={colors.textMuted} keyboardType="number-pad" value={maxPlayers} onChangeText={setMaxPlayers} />

        {/* ── Team Type ── (moved above Format; defaults to Doubles) */}
        <SectionHeader title="Team Type" S={S} />
        <View style={[S.pillRow, { flexWrap: 'wrap' }]}>
          <Pill label="① Singles" active={matchType === 'singles'} onPress={() => setMatchType('singles')} S={S} disabled={isDoublesOnlyFormat} />
          <Pill label="② Doubles" active={matchType === 'doubles'} onPress={() => setMatchType('doubles')} S={S} />
          <Pill label="④ MLP"     active={matchType === 'mlp'}     onPress={() => setMatchType('mlp')}     S={S} />
        </View>
        {isDoublesOnlyFormat && matchType !== 'mlp' && <Text style={S.hint}>This format is doubles-only.</Text>}
        {matchType === 'mlp' && (
          <Text style={S.hint}>Teams of 4 (2 men + 2 women). Each team meeting plays 4 sub-matches (men's, women's, 2× mixed).</Text>
        )}

        {/* ── Format ── (all 5 formats shown to every Team Type) */}
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
              {/* MLP caps at 4 pools (each pool needs enough teams to play); non-MLP allows up to 6. */}
              {(matchType === 'mlp' ? [2, 3, 4] : [2, 3, 4, 6]).map(n => (
                <Pill key={n} label={`${n} pools`} active={poolCount === n} onPress={() => setPoolCount(n)} S={S} />
              ))}
            </View>
            <Text style={S.hint}>
              {matchType === 'mlp'
                ? 'Teams are snake-drafted into pools by seed so each pool is balanced.'
                : 'Players are distributed evenly. Snake-draft keeps pools balanced by PLUPR when seeding is on.'}
            </Text>
          </>
        )}

        {/* ── Playoff format (round_robin and pool_play — applies to singles, doubles, and MLP) ── */}
        {(format === 'round_robin' || format === 'pool_play') && (
          <>
            <SectionHeader title="Playoff Format" S={S} />
            <View style={[S.pillRow, { flexWrap: 'wrap' }]}>
              <Pill label="None"   active={playoffFormat === 'none'}  onPress={() => setPlayoffFormat('none')}  S={S} />
              <Pill label="Top 2"  active={playoffFormat === 'top_2'} onPress={() => setPlayoffFormat('top_2')} S={S} />
              <Pill label="Top 4"  active={playoffFormat === 'top_4'} onPress={() => setPlayoffFormat('top_4')} S={S} />
              <Pill label="Top 8"  active={playoffFormat === 'top_8'} onPress={() => setPlayoffFormat('top_8')} S={S} />
            </View>
            <Text style={S.hint}>
              {playoffFormat === 'none'
                ? 'No playoff — final standings come straight from group play.'
                : playoffFormat === 'top_2'
                  ? 'Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4).'
                  : playoffFormat === 'top_4'
                    ? 'Semifinals + Finals.'
                    : 'Quarterfinals + Semifinals + Finals.'}
            </Text>
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

        {/* ── Team Creation Type (Doubles + MLP — placed just above Registration) ── */}
        {(matchType === 'doubles' || matchType === 'mlp') && (
          <>
            <SectionHeader title="Team Creation Type" S={S} />
            <View style={S.pillRow}>
              <Pill label="Fixed Teams"  active={teamCreation === 'fixed'}  onPress={() => setTeamCreation('fixed')}  S={S} />
              <Pill label="Random Teams" active={teamCreation === 'random'} onPress={() => setTeamCreation('random')} S={S} />
            </View>
            <Text style={S.hint}>
              {teamCreation === 'fixed'
                ? (matchType === 'mlp'
                    ? 'Captains form rosters and lock them in before bracket generation.'
                    : 'Players pair up themselves; partners are fixed for the tournament.')
                : (matchType === 'mlp'
                    ? 'Teams are auto-generated from approved players (snake-draft by PLUPR) with wacky names.'
                    : 'Doubles partners are auto-paired from approved players (snake-draft by PLUPR).')}
            </Text>
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

        {/* ── Name ── (auto-generated; manually editable) */}
        <SectionHeader title="Name" S={S} />
        <Text style={S.label}>Tournament Name *</Text>
        <TextInput
          style={S.input}
          placeholder="Auto-generated from league/location + format + match type"
          placeholderTextColor={colors.textMuted}
          value={name}
          onChangeText={t => { setName(t); setNameEdited(true); }}
        />
        <Text style={S.hint}>
          {nameManuallyEdited
            ? 'Custom name — auto-updates are paused. Clear the field to resume.'
            : 'Updates automatically as you change the league/location, format, or match type.'}
        </Text>
        {nameManuallyEdited && (
          <TouchableOpacity onPress={() => { setNameEdited(false); }}>
            <Text style={[S.hint, { color: colors.primary, marginTop: 4 }]}>↺ Re-enable auto-name</Text>
          </TouchableOpacity>
        )}

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
