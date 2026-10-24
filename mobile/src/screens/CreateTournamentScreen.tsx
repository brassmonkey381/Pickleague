import React, { useState, useEffect, useRef } from 'react';
import {
  ScrollView, View, Text, TextInput, TouchableOpacity,
  StyleSheet, Switch,
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
import { sbCall, requireUserId, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { shadowColor } from '@just-messin-around/expo-foundation/theme';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';

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

type PlayoffFormat =
  | 'none' | 'top_2' | 'top_4' | 'top_8'
  | 'top_1_per_pool' | 'top_2_per_pool';

const PLAYOFF_FORMAT_HINTS: Record<PlayoffFormat, string> = {
  none:            'No playoff — final standings come straight from group play.',
  top_2:           'Grand Final (#1 vs #2) plus a Third Place Match (#3 vs #4).',
  top_4:           'Semifinals + Finals.',
  top_8:           'Quarterfinals + Semifinals + Finals.',
  top_1_per_pool:  'Pool winners advance to a single-elim bracket. Crossover seeding (A1 vs B-last, etc.).',
  top_2_per_pool:  'Top 2 from each pool advance to a single-elim bracket. Crossover seeding (A1 vs B2, B1 vs A2, etc.).',
};

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

// A selectable option pill. `iconName`: a glyph before the label in the
// label's colour (decorative; the label names the option).
function Pill({ label, active, onPress, S, disabled, iconName }: { label: string; active: boolean; onPress: () => void; S: ReturnType<typeof makeStyles>; disabled?: boolean; iconName?: IconName }) {
  const { colors: c } = useTheme();
  return (
    <TouchableOpacity
      style={[S.pill, active && S.pillActive, disabled && S.pillDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !!disabled }}
    >
      {iconName ? <Icon name={iconName} size={14} color={active ? c.primary : c.textSub} /> : null}
      <Text style={[S.pillText, active && S.pillTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// rotating_partners is the only Format-selector value that is doubles-only;
// MLP is handled via matchType='mlp' and DOES NOT appear in FORMATS now.
const DOUBLES_ONLY_FORMATS: TournamentFormat[] = ['rotating_partners'];

function SectionHeader({ title, S, iconName }: { title: string; S: ReturnType<typeof makeStyles>; iconName?: IconName }) {
  const { colors: c } = useTheme();
  return (
    <View style={S.sectionHeader}>
      {iconName ? <Icon name={iconName} size={16} color={c.primary} /> : null}
      <Text style={S.sectionHeaderText} accessibilityRole="header">{title}</Text>
    </View>
  );
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
  const [minPlayers, setMinPlayers]       = useState('');
  const [maxPlayers, setMaxPlayers]       = useState('');

  // Format
  const [format, setFormat]           = useState<TournamentFormat>('round_robin');
  // Default to doubles — the most common match type. MLP is the 3rd option.
  const [matchType, setMatchType]     = useState<UiMatchType>('doubles');
  const [teamCreation, setTeamCreation] = useState<TeamCreation>('fixed');
  const [seeding, setSeeding]         = useState<'random' | 'elo'>('random');
  const [poolCount, setPoolCount]     = useState(2);
  const [partnerRotation, setPartnerRotation] = useState<'every_match' | 'every_round'>('every_match');
  const [playoffFormat, setPlayoffFormat] = useState<PlayoffFormat>('none');
  // Whether Top 4 / Top 8 brackets get a Third Place Match between losing semifinalists.
  // (Top 2 always pairs standings #3 vs #4 — that's not toggleable.)
  const [playoffThirdPlace, setPlayoffThirdPlace] = useState(false);

  // Registration
  const [inviteOnly, setInviteOnly]   = useState(false);
  const [regCloses, setRegCloses]     = useState<Date | null>(null);
  const [showRegClosesPicker, setShowRegClosesPicker] = useState(false);

  // Pickle pot
  const [ante, setAnte]               = useState('0');
  const [payoutText, setPayoutText]   = useState('60,25,15');

  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState(false);
  // `tournaments` has no dedupe key and each creation burns the one-active
  // allowance, so the handler must be un-re-enterable from the first tap until
  // the deferred navigate — `disabled` alone loses that race.
  const inFlight                      = useRef(false);
  const navTimer                      = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (navTimer.current) clearTimeout(navTimer.current); }, []);

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
      // Local session read — getUser() was a round trip that returns null
      // offline, silently dropping the location prefill.
      currentUserId(supabase).then((uid) => {
        if (cancelled || !uid) return;
        supabase
          .from('tournaments')
          .select('location_name, location_lat, location_lng')
          .eq('created_by', uid)
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

  // top_N_per_pool is only meaningful for non-MLP pool_play. Reset if either
  // condition no longer holds so we don't ship an invalid combination.
  useEffect(() => {
    // The playoff generator only supports qualifier fields of 2/4/6/8, so
    // top_1_per_pool needs 2/4/6 pools and top_2_per_pool needs 2/3/4 pools —
    // otherwise the admin finds out AFTER group play that no bracket can be
    // generated. Reset to 'none' whenever the combo goes invalid.
    const perPoolValid =
      playoffFormat === 'top_1_per_pool' ? [2, 4, 6].includes(poolCount) :
      playoffFormat === 'top_2_per_pool' ? [2, 3, 4].includes(poolCount) : true;
    if (
      (playoffFormat === 'top_1_per_pool' || playoffFormat === 'top_2_per_pool') &&
      (format !== 'pool_play' || matchType === 'mlp' || !perPoolValid)
    ) {
      setPlayoffFormat('none');
    }
  }, [format, matchType, playoffFormat, poolCount]);


  function parsePayout(): number[] | null {
    const parts = payoutText.split(',').map(s => parseInt(s.trim(), 10));
    if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    if (parts.reduce((a, b) => a + b, 0) !== 100) return null;
    return parts;
  }

  async function submit() {
    if (inFlight.current || success) return;
    setError('');
    if (!name.trim()) { setError('Please enter a tournament name.'); return; }
    const anteNum = parseInt(ante, 10);
    if (!Number.isFinite(anteNum) || anteNum < 0) { setError('Ante must be 0 or a positive number.'); return; }
    const durationNum = parseFloat(durationHours);
    if (!Number.isFinite(durationNum) || durationNum < 0.5 || durationNum > 168) {
      setError('Expected duration must be between 0.5 and 168 hours.');
      return;
    }
    const structure = parsePayout();
    if (!structure) { setError('Payout structure must be comma-separated percentages summing to 100 (e.g. 60,25,15).'); return; }
    const minPlayersN = minPlayers.trim() ? parseInt(minPlayers.trim(), 10) : null;
    const maxPlayersN = maxPlayers.trim() ? parseInt(maxPlayers.trim(), 10) : null;
    if (minPlayersN != null && (!Number.isFinite(minPlayersN) || minPlayersN < 2)) {
      setError('Min players must be a number ≥ 2.'); return;
    }
    if (maxPlayersN != null && (!Number.isFinite(maxPlayersN) || maxPlayersN < 2)) {
      setError('Max players must be a number ≥ 2.'); return;
    }
    if (minPlayersN != null && maxPlayersN != null && minPlayersN > maxPlayersN) {
      setError('Min players can\'t be greater than max players.'); return;
    }

    inFlight.current = true;
    setLoading(true);
    try {
      // LOCAL session read. getUser() is a network call that resolves
      // { user: null } offline, so the `user!.id` below threw a TypeError out of
      // this handler and left the button stuck on "Creating…" with no recovery.
      const uid = await requireUserId(supabase, 'Please sign in again to create a tournament.');

      // Per-account active-tournament limit (godmode bypasses)
      {
        const [godmode, activeCount] = await Promise.all([
          checkGodmode(),
          countActiveOwnedTournaments(uid),
        ]);
        if (!godmode && activeCount >= 1) {
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

      // Final safety net mirroring the DB `tournaments_format_match_type_check`
      // constraint: mlp / mlp_random / rotating_partners are doubles-only. The UI
      // already steers away from this (Singles pill is disabled for doubles-only
      // formats, MLP forces doubles), but those corrections run on re-render, so
      // guard here too rather than let the DB reject the insert with a raw 23514.
      if (dbMatchType === 'singles' &&
          (dbFormat === 'mlp' || dbFormat === 'mlp_random' || dbFormat === 'rotating_partners')) {
        setError('This format requires doubles. Switch Team Type to Doubles (or MLP) and try again.');
        return;
      }

      const insertPayload: Record<string, any> = {
        league_id:         leagueId ?? null,
        name:              name.trim(),
        description:       description.trim() || null,
        created_by:        uid,
        format:            dbFormat,
        match_type:        dbMatchType,
        seeding,
        pool_count:        dbFormat === 'pool_play' ? poolCount : 1,
        partner_rotation:  dbFormat === 'rotating_partners' ? partnerRotation : null,
        // Captures Fixed vs Random for both Doubles and MLP. Singles ignores it.
        team_creation:     (matchType === 'doubles' || matchType === 'mlp') ? teamCreation : 'fixed',
        registration_mode: inviteOnly ? 'invite_only' : 'request',
        registration_closes_at: regCloses?.toISOString() ?? null,
        min_players:       minPlayersN,
        max_players:       maxPlayersN,
        start_time:        startTime?.toISOString() ?? null,
        expected_length_hours: durationNum,
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
        // 3PM toggle only meaningful for top_4 / top_8; safe to send false otherwise.
        insertPayload.playoff_third_place =
          (playoffFormat === 'top_4' || playoffFormat === 'top_8') && playoffThirdPlace;
      }

      // Not retried: nothing dedupes tournaments, so a retry after a lost reply
      // would leave two and immediately trip the one-active limit.
      const t = await sbCall(() => supabase
        .from('tournaments')
        .insert(insertPayload)
        .select()
        .single(), { retries: 0, timeoutMs: 30_000 }) as { id: string; name: string };

      // Auto-register creator as approved admin. This is NOT optional bookkeeping:
      // without it the creator can't administer the tournament they just made, and
      // the orphan still counts against the one-active limit so they can't make a
      // replacement either. Upsert (there's a unique(tournament_id,user_id)) so a
      // retry after a lost reply is a no-op rather than a 23505.
      try {
        await sbCall(() => supabase.from('tournament_registrations').upsert({
          tournament_id: t.id,
          user_id:       uid,
          status:        'approved',
          role:          'admin',
        }, { onConflict: 'tournament_id,user_id' }));
      } catch (regErr) {
        // Cancel the half-built tournament so it stops consuming the allowance —
        // the creator-update policy permits this, delete is godmode-only.
        let rolledBack = false;
        try {
          await sbCall(() => supabase.from('tournaments').update({ status: 'cancelled' }).eq('id', t.id));
          rolledBack = true;
        } catch { /* reported below */ }
        setError(rolledBack
          ? `${friendlySbMessage(regErr, 'Could not finish setting up the tournament.')} It was cancelled — nothing was left half-created. Please try again.`
          : `${friendlySbMessage(regErr, 'Could not finish setting up the tournament.')} "${t.name}" was created but you are not registered as its admin — reconnect and cancel it from the tournament page before creating another.`);
        return;
      }

      setSuccess(true);
      navTimer.current = setTimeout(() => navigation.replace('TournamentDetail', { tournamentId: t.id, tournamentName: t.name }), 800);
    } catch (e) {
      setError(friendlySbMessage(e, 'Could not create the tournament.', {
        network: 'Lost the connection. Check the Tournaments list before trying again — it may have been created.',
      }));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
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
            <TouchableOpacity
              style={S.clearDate}
              onPress={() => setStartTime(null)}
              accessibilityRole="button"
              accessibilityLabel="Clear the date and time"
            >
              <Icon name="close" size={16} color={colors.textMuted} />
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

        <Text style={S.label}>Min Players</Text>
        <TextInput style={[S.input, S.inputSmall]} placeholder="No minimum" placeholderTextColor={colors.textMuted} keyboardType="number-pad" value={minPlayers} onChangeText={setMinPlayers} />
        <Text style={S.hint}>The bracket can't be locked in with fewer approved players than this.</Text>

        <Text style={S.label}>Max Players</Text>
        <TextInput style={[S.input, S.inputSmall]} placeholder="No limit" placeholderTextColor={colors.textMuted} keyboardType="number-pad" value={maxPlayers} onChangeText={setMaxPlayers} />
        <Text style={S.hint}>Once full, new join requests go on a waitlist and are promoted automatically when a spot opens.</Text>

        {/* ── Team Type ── (moved above Format; defaults to Doubles) */}
        <SectionHeader title="Team Type" S={S} />
        <View style={[S.pillRow, { flexWrap: 'wrap' }]}>
          <Pill iconName="person"    label="Singles" active={matchType === 'singles'} onPress={() => setMatchType('singles')} S={S} disabled={isDoublesOnlyFormat} />
          <Pill iconName="handshake" label="Doubles" active={matchType === 'doubles'} onPress={() => setMatchType('doubles')} S={S} />
          <Pill iconName="group"     label="MLP"     active={matchType === 'mlp'}     onPress={() => setMatchType('mlp')}     S={S} />
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
                accessibilityRole="button"
                accessibilityLabel={`${meta.label}. ${meta.description}`}
                accessibilityState={{ selected: active }}
              >
                <Icon name={meta.iconName} size={24} color={active ? colors.primary : colors.textSub} style={S.formatIcon} />
                <Text style={[S.formatLabel, active && S.formatLabelActive]}>{meta.label}</Text>
                <Text style={S.formatDesc}>{meta.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Seeding ── */}
        <SectionHeader title="Bracket Seeding" S={S} />
        <View style={S.pillRow}>
          <Pill iconName="dice"  label="Random draw" active={seeding === 'random'} onPress={() => setSeeding('random')} S={S} />
          <Pill iconName="chart" label="PLUPR-based" active={seeding === 'elo'}    onPress={() => setSeeding('elo')}    S={S} />
        </View>
        <Text style={S.hint}>
          {seeding === 'elo'
            ? 'Determines bracket structure and which players face off in each round. Players are sorted by PLUPR; pools and brackets use snake-draft so the top seed faces the bottom seed and skill levels stay balanced across pools.'
            : 'Determines bracket structure and which players face off in each round. Players are drawn randomly into pools and bracket slots.'}
          {(format === 'single_elimination' || format === 'double_elimination') && (
            seeding === 'elo'
              ? ' If the field isn’t a power of 2 (4, 8, 16…), the top PLUPR seeds get first-round byes.'
              : ' Heads up: if the field isn’t a power of 2 (4, 8, 16…), first-round byes are handed out by the random draw — a pure luck advantage for whoever lands them.'
          )}
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
              {/* Top N per Pool: pool_play only (non-MLP); crossover seeding. */}
              {format === 'pool_play' && matchType !== 'mlp' && (
                <>
                  {/* Only combos yielding 2/4/6/8 qualifiers are generatable. */}
                  {[2, 4, 6].includes(poolCount) && (
                    <Pill label="Top 1 per Pool" active={playoffFormat === 'top_1_per_pool'} onPress={() => setPlayoffFormat('top_1_per_pool')} S={S} />
                  )}
                  {[2, 3, 4].includes(poolCount) && (
                    <Pill label="Top 2 per Pool" active={playoffFormat === 'top_2_per_pool'} onPress={() => setPlayoffFormat('top_2_per_pool')} S={S} />
                  )}
                </>
              )}
            </View>
            <Text style={S.hint}>{PLAYOFF_FORMAT_HINTS[playoffFormat]}</Text>
            {(playoffFormat === 'top_4' || playoffFormat === 'top_8') && (
              <View style={S.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={S.label}>Third Place Match</Text>
                  <Text style={S.hint}>
                    {playoffThirdPlace
                      ? 'Losing semifinalists play for 3rd place after both Semifinals complete.'
                      : 'No 3rd place match — losing semifinalists tie for 3rd.'}
                  </Text>
                </View>
                <Switch
                  value={playoffThirdPlace}
                  onValueChange={setPlayoffThirdPlace}
                  trackColor={{ true: colors.primary }}
                  thumbColor={colors.textInverse}
                />
              </View>
            )}
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
        <View style={S.closedNote}>
          <Icon name="lock" size={14} color={colors.textMuted} />
          <Text style={S.closedNoteText}>All tournaments are closed — players must be approved to participate.</Text>
        </View>

        <View style={S.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={S.label}>Invite only</Text>
            <Text style={S.hint}>{inviteOnly ? 'Only players you invite can register.' : 'Players can request to join; you approve them.'}</Text>
          </View>
          <Switch value={inviteOnly} onValueChange={setInviteOnly} trackColor={{ true: colors.primary }} thumbColor={colors.textInverse} />
        </View>

        <Text style={S.label}>Registration Deadline (optional)</Text>
        <TouchableOpacity style={S.dateBtn} onPress={() => setShowRegClosesPicker(true)}>
          <Text style={S.dateBtnText}>
            {regCloses
              ? regCloses.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : 'No deadline'}
          </Text>
          {regCloses && (
            <TouchableOpacity
              style={S.clearDate}
              onPress={() => setRegCloses(null)}
              accessibilityRole="button"
              accessibilityLabel="Clear the registration deadline"
            >
              <Icon name="close" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
        <Text style={S.hint}>After this, players can no longer request to join. Non-registered players get a reminder 6 hours before it closes.</Text>

        {/* ── Pickle pot ── */}
        <SectionHeader iconName="pickle" title="Pickle Pot" S={S} />

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
          <TouchableOpacity
            style={S.relink}
            onPress={() => { setNameEdited(false); }}
            accessibilityRole="button"
            accessibilityLabel="Re-enable auto-name"
          >
            <Icon name="undo" size={14} color={colors.primary} />
            <Text style={[S.hint, S.relinkText]}>Re-enable auto-name</Text>
          </TouchableOpacity>
        )}

        {/* ── Status / submit ── */}
        {error ? (
          <View style={S.errorBox}><Text style={S.errorText}>{error}</Text></View>
        ) : null}
        {success ? (
          <View style={S.successBox}>
            <Icon name="check-mark" size={16} color={colors.success} />
            <Text style={S.successText}>Tournament created!</Text>
          </View>
        ) : null}

        <Button
          title={loading ? 'Creating…' : success ? 'Created' : 'Create Tournament'}
          onPress={submit}
          disabled={loading || success}
          style={S.submitBtn}
        />
      </ScrollView>

      <AppDateTimePicker
        visible={showDatePicker}
        value={startTime ?? new Date(Date.now() + 86400000)}
        minimumDate={new Date()}
        onChange={d => { setStartTime(d); setShowDatePicker(false); }}
        onClose={() => setShowDatePicker(false)}
      />
      <AppDateTimePicker
        visible={showRegClosesPicker}
        value={regCloses ?? startTime ?? new Date(Date.now() + 86400000)}
        minimumDate={new Date()}
        onChange={d => { setRegCloses(d); setShowRegClosesPicker(false); }}
        onClose={() => setShowRegClosesPicker(false)}
      />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    container: { padding: SPACE.lg, backgroundColor: c.surface, flexGrow: 1, paddingBottom: SPACE.xl * 2 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xl, marginBottom: SPACE.sm, borderBottomWidth: HAIRLINE, borderBottomColor: c.border, paddingBottom: SPACE.xs },
    sectionHeaderText: { ...t.title, fontWeight: FONT.weight.heavy },
    label: { ...t.fieldLabel, marginBottom: SPACE.xs, marginTop: SPACE.md },
    hint: { ...t.hint, marginTop: SPACE.xs },
    input: { borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface },
    multiline: { height: 68, textAlignVertical: 'top' },
    inputSmall: { width: 120 },
    dateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingLeft: SPACE.md, minHeight: 48 },
    dateBtnText: { flex: 1, fontSize: FONT.size.lg, color: c.textSub, paddingVertical: SPACE.md },
    // 44 tap box for the clear glyph (web ignores hitSlop).
    clearDate: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    formatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
    formatCard: { width: '47%', borderWidth: 1.5, borderColor: c.border, borderRadius: RADIUS.lg, padding: SPACE.md, backgroundColor: c.surfaceAlt, elevation: 1, shadowColor: shadowColor(c), shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    formatCardActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    formatIcon: { marginBottom: SPACE.xs },
    formatLabel: { ...t.sub, fontWeight: FONT.weight.bold },
    formatLabelActive: { color: c.primary },
    formatDesc: { ...t.caption, marginTop: SPACE.xxs, lineHeight: 15 },
    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
    pill: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 36, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.pill, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    pillActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    pillDisabled: { opacity: 0.5 },
    pillText: { ...t.sub, fontWeight: FONT.weight.medium },
    pillTextActive: { color: c.primary, fontWeight: FONT.weight.bold },
    closedNote: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.xs },
    closedNoteText: { ...t.hint, flex: 1 },
    toggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.sm },
    relink: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: SPACE.xs, minHeight: 44 },
    relinkText: { color: c.primary, marginTop: 0, fontWeight: FONT.weight.semibold },
    errorBox: { backgroundColor: c.dangerLight, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md },
    errorText: { ...t.bodySub, color: c.danger, fontWeight: FONT.weight.semibold },
    successBox: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, backgroundColor: c.successLight, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md },
    successText: { ...t.bodySub, color: c.success, fontWeight: FONT.weight.bold },
    submitBtn: { marginTop: SPACE.xl },
  });
}
