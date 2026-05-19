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
import { isGodmodeUserId } from '../lib/godmode';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchEntry'>;
  route: RouteProp<RootStackParamList, 'MatchEntry'>;
};

type MatchType = 'singles' | 'doubles';

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
  const {
    leagueId,
    tournamentId,
    tournamentMatchId,
    tournamentName,
    prefillMatchType,
    prefillTeam1Player, prefillTeam1Partner,
    prefillTeam2Player, prefillTeam2Partner,
  } = route.params;
  const isTournamentMatch = !!tournamentMatchId;
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [members, setMembers] = useState<Profile[]>([]);
  const [matchType, setMatchType] = useState<MatchType>(prefillMatchType ?? 'doubles');
  const [p1, setP1] = useState(prefillTeam1Player ?? '');
  const [partner1, setPartner1] = useState(prefillTeam1Partner ?? '');
  const [p2, setP2] = useState(prefillTeam2Player ?? '');
  const [partner2, setPartner2] = useState(prefillTeam2Partner ?? '');
  // Best-of-N support: each entry is one game's score pair.
  type GameScore = { t1: string; t2: string };
  const [games, setGames] = useState<GameScore[]>([{ t1: '', t2: '' }]);
  const updateGame = (i: number, field: 't1' | 't2', value: string) =>
    setGames(prev => prev.map((g, idx) => idx === i ? { ...g, [field]: value } : g));
  const addGame    = () => setGames(prev => [...prev, { t1: '', t2: '' }]);
  const removeGame = (i: number) => setGames(prev => prev.filter((_, idx) => idx !== i));
  // Per-match gender overrides for players who don't have a gender on their profile.
  // Keyed by which slot the player is in: 'p1' | 'partner1' | 'p2' | 'partner2'.
  const [genderOverrides, setGenderOverrides] = useState<Record<'p1'|'partner1'|'p2'|'partner2', 'male'|'female'|null>>({
    p1: null, partner1: null, p2: null, partner2: null,
  });
  const [location, setLocation]     = useState<CourtResult | null>(null);
  // Default outdoor — overridden by learnCourtDefault when we have a signal.
  const [isOutdoor, setIsOutdoor]   = useState<boolean | null>(true);
  const [courtHint, setCourtHint]   = useState<string | null>(null);
  // When a location only has one type of court, lock the toggle to that type.
  const [courtTypeLocked, setCourtTypeLocked] = useState<'outdoor' | 'indoor' | null>(null);
  const [myDefaultPaddleId, setMyDefaultPaddleId] = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const status = useStatusMessage();

  useEffect(() => { loadLeagueData(); }, []);

  const [leagueHomeCourt, setLeagueHomeCourt] = useState<string | null>(null);

  async function loadLeagueData() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: paddle } = await supabase.from('player_paddles')
        .select('id').eq('user_id', user.id).eq('is_default', true).maybeSingle();
      if (paddle) setMyDefaultPaddleId(paddle.id);
    }

    // ── Tournament match: members come from tournament_registrations, location
    //    comes from the tournament itself. (league_members may be empty or
    //    irrelevant — tournaments can have approved players who aren't members
    //    of the parent league, or no parent league at all.)
    if (isTournamentMatch && tournamentId) {
      const [regsRes, tournRes] = await Promise.all([
        supabase
          .from('tournament_registrations')
          .select('profile:profiles!tournament_registrations_user_id_fkey(*)')
          .eq('tournament_id', tournamentId)
          .eq('status', 'approved'),
        supabase
          .from('tournaments')
          .select('location_name, location_lat, location_lng')
          .eq('id', tournamentId)
          .single(),
      ]);
      setMembers(((regsRes.data ?? []) as any[]).map(r => r.profile).filter(Boolean));
      const t = tournRes.data;
      if (t?.location_name) {
        setLocation({
          name: t.location_name,
          address: '',
          lat: t.location_lat ?? 0,
          lng: t.location_lng ?? 0,
          placeId: '',
        });
        // Reuse the same indoor/outdoor learner so the toggle defaults correctly.
        learnCourtDefault(t.location_name);
      }
      return;
    }

    // ── League / casual match (existing path) ──
    const [membersRes, leagueRes] = await Promise.all([
      supabase.from('league_members').select('profile:profiles(*)').eq('league_id', leagueId),
      supabase.from('leagues').select('home_court, home_court_lat, home_court_lng').eq('id', leagueId).single(),
    ]);
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
  // Always pre-seeds with outdoor as the default unless a stronger signal flips it.
  async function learnCourtDefault(locationName: string) {
    setCourtHint(null);
    setCourtTypeLocked(null);
    setIsOutdoor(true); // baseline default; refined below if we have a signal

    if (!locationName) return;

    // ── Primary: court_locations ───────────────────────────────
    const { data: court } = await supabase
      .from('court_locations')
      .select('has_indoor, has_outdoor, default_outdoor, auto_classified, verified')
      .eq('name', locationName)
      .maybeSingle();

    if (court) {
      const source = court.verified       ? '✓ verified'
                   : court.auto_classified ? 'auto-detected'
                   :                          'learned from past matches';
      const onlyOutdoor = court.has_outdoor && !court.has_indoor;
      const onlyIndoor  = court.has_indoor && !court.has_outdoor;
      const hasBoth     = court.has_outdoor && court.has_indoor;

      if (onlyOutdoor) {
        setIsOutdoor(true);
        setCourtTypeLocked('outdoor');
        setCourtHint(`☀️ Outdoor only · ${source}`);
        return;
      }
      if (onlyIndoor) {
        setIsOutdoor(false);
        setCourtTypeLocked('indoor');
        setCourtHint(`🏠 Indoor only · ${source}`);
        return;
      }
      if (hasBoth) {
        // Has both — prefer the location's stored default, else fall back to outdoor.
        if (court.default_outdoor === false) setIsOutdoor(false);
        else                                  setIsOutdoor(true);
        setCourtHint(`🏠 / ☀️ Has both indoor and outdoor courts · ${source}`);
        return;
      }
      // Row exists but unclassified (has_indoor=false, has_outdoor=false). Fall
      // through to match history; isOutdoor stays at the outdoor default.
    }

    // ── Fallback: aggregate of existing match flags ────────────
    const { data: history } = await supabase
      .from('matches')
      .select('is_outdoor')
      .eq('location_name', locationName)
      .not('is_outdoor', 'is', null)
      .limit(100);

    if (!history || history.length < 3) return; // keep outdoor default

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
    if (location?.name) {
      learnCourtDefault(location.name);
    } else {
      setIsOutdoor(true); // default outdoor when no location selected
      setCourtHint(null);
      setCourtTypeLocked(null);
    }
  }, [location?.name]);

  function resetOnTypeChange(type: MatchType) {
    setMatchType(type);
    setP1(''); setPartner1(''); setP2(''); setPartner2('');
    setGames([{ t1: '', t2: '' }]);
    status.clear();
  }

  function setError(text: string) {
    status.error(text);
  }

  async function submitMatch() {
    status.clear();

    // Validation
    if (matchType === 'singles') {
      if (!p1 || !p2) return setError('Please select both players.');
      if (p1 === p2) return setError('Players must be different.');
    } else {
      if (!p1 || !partner1 || !p2 || !partner2) return setError('Please select all four players.');
      if (new Set([p1, partner1, p2, partner2]).size !== 4) return setError('All four players must be different.');
    }

    // Parse and validate every game; build the per-game array and roll-up totals.
    const parsedGames: { t1: number; t2: number }[] = [];
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const t1 = parseInt(g.t1), t2 = parseInt(g.t2);
      if (isNaN(t1) || isNaN(t2) || g.t1 === '' || g.t2 === '') {
        return setError(`Please enter scores for game ${i + 1}.`);
      }
      if (t1 < 0 || t2 < 0) return setError(`Game ${i + 1}: scores cannot be negative.`);
      if (t1 === t2) return setError(`Game ${i + 1}: scores cannot be tied — pickleball always has a winner.`);
      parsedGames.push({ t1, t2 });
    }
    const t1GamesWon = parsedGames.filter(g => g.t1 > g.t2).length;
    const t2GamesWon = parsedGames.length - t1GamesWon;
    if (t1GamesWon === t2GamesWon) return setError('No overall winner — split the series. Add another game or fix the scores.');
    // For single-game matches keep the exact score; for multi-game matches store
    // the sum of points across games (PLUPR delta math is based on point totals).
    const s1 = parsedGames.length === 1 ? parsedGames[0].t1 : parsedGames.reduce((a, g) => a + g.t1, 0);
    const s2 = parsedGames.length === 1 ? parsedGames[0].t2 : parsedGames.reduce((a, g) => a + g.t2, 0);
    const gameScoresPayload = parsedGames.length > 1 ? parsedGames : null;
    // Tournament matches inherit the tournament's location; only require for league matches.
    if (!isTournamentMatch && !location) return setError('Please enter a match location.');
    // For doubles, every ungendered player needs a per-match gender declared.
    if (matchType === 'doubles' && pendingGenderSlots.length > 0) {
      return setError('Pick a gender for every player without one before recording.');
    }

    const winnerTeam = t1GamesWon > t2GamesWon ? 'team1' : 'team2';
    const winnerId   = winnerTeam === 'team1' ? p1 : p2;

    setLoading(true);

    // ── Tournament match: update the existing tournament_matches row ──
    // The on_tournament_match_completed trigger fires when status flips to
    // 'completed' and applies PLUPR to the right facet/scope automatically.
    if (isTournamentMatch && tournamentMatchId) {
      const { error: tmErr } = await supabase
        .from('tournament_matches')
        .update({
          team1_score: s1,
          team2_score: s2,
          game_scores: gameScoresPayload,
          winner_team: winnerTeam,
          status:      'completed',
          team1_player1_gender_override: genderOverrides.p1,
          team1_player2_gender_override: matchType === 'doubles' ? genderOverrides.partner1 : null,
          team2_player1_gender_override: genderOverrides.p2,
          team2_player2_gender_override: matchType === 'doubles' ? genderOverrides.partner2 : null,
        })
        .eq('id', tournamentMatchId);
      setLoading(false);
      if (tmErr) {
        setError(tmErr.message);
        return;
      }
      status.success('Tournament match recorded. PLUPR updated.');
      setTimeout(() => navigation.goBack(), 1500);
      return;
    }

    // ── League / casual match: insert into `matches` as pending (confirm flow) ──
    // The entering user auto-confirms whichever team they're on — the OTHER
    // team must confirm within 1 hour or the row is deleted (via the
    // expire_pending_matches cron job).
    //
    // Godmode shortcut: insert as 'completed' with both team confirms set to
    // the godmode user, so PLUPR applies immediately and no expiry is needed.
    const { data: { user } } = await supabase.auth.getUser();
    const enteringUid = user?.id ?? null;
    const isOnTeam1 = enteringUid && (enteringUid === p1 || (matchType === 'doubles' && enteringUid === partner1));
    const isOnTeam2 = enteringUid && (enteringUid === p2 || (matchType === 'doubles' && enteringUid === partner2));
    const isGod = isGodmodeUserId(enteringUid);
    const deadline = isGod ? null : new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase.from('matches').insert({
      league_id:    leagueId,
      match_type:   matchType,
      player1_id:   p1,
      partner1_id:  matchType === 'doubles' ? partner1 : null,
      player2_id:   p2,
      partner2_id:  matchType === 'doubles' ? partner2 : null,
      player1_score: s1,
      player2_score: s2,
      game_scores:   gameScoresPayload,
      winner_id:      winnerId,
      winner_team:    winnerTeam,
      location_name:  location?.name ?? null,
      location_lat:   location?.lat ?? null,
      location_lng:   location?.lng ?? null,
      was_home_court: !!(location?.name && leagueHomeCourt && location.name === leagueHomeCourt),
      is_home_court:  !!(location?.name && leagueHomeCourt && location.name === leagueHomeCourt),
      is_outdoor:     isOutdoor,
      status:             isGod ? 'completed' : 'pending',
      confirm_deadline:   deadline,
      team1_confirmed_by: isGod ? enteringUid : (isOnTeam1 ? enteringUid : null),
      team2_confirmed_by: isGod ? enteringUid : (isOnTeam2 ? enteringUid : null),
      player1_gender_override:  genderOverrides.p1,
      partner1_gender_override: matchType === 'doubles' ? genderOverrides.partner1 : null,
      player2_gender_override:  genderOverrides.p2,
      partner2_gender_override: matchType === 'doubles' ? genderOverrides.partner2 : null,
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
      status.success(isGod
        ? 'Match recorded and confirmed (godmode). PLUPR updated.'
        : 'Match recorded — pending confirmation. The other team has 1 hour to confirm before this match expires.');
      setTimeout(() => navigation.goBack(), isGod ? 1500 : 2500);
    }
  }

  const team1Players = [p1, partner1].filter(Boolean);
  const team2Players = [p2, partner2].filter(Boolean);

  const p1Name  = members.find((m) => m.id === p1)?.full_name  ?? 'Team 1';
  const p2Name  = members.find((m) => m.id === p2)?.full_name  ?? 'Team 2';

  // Resolve a player's effective gender, factoring in any per-match override.
  function effectiveGender(playerId: string, slot: 'p1'|'partner1'|'p2'|'partner2'): string | null {
    const override = genderOverrides[slot];
    if (override) return override;
    const profileG = members.find(m => m.id === playerId)?.gender ?? null;
    if (profileG === 'prefer-not-to-say') return null;
    return profileG;
  }

  // Players who don't have a profile gender → need a per-match declaration.
  // Returns the list of slots requiring a declaration that hasn't been made yet.
  function unsetSlots(): Array<{ slot: 'p1'|'partner1'|'p2'|'partner2'; playerId: string; name: string }> {
    if (matchType !== 'doubles') return [];
    const out: Array<{ slot: 'p1'|'partner1'|'p2'|'partner2'; playerId: string; name: string }> = [];
    for (const [slot, pid] of [
      ['p1', p1] as const, ['partner1', partner1] as const,
      ['p2', p2] as const, ['partner2', partner2] as const,
    ]) {
      if (!pid) continue;
      const m = members.find(mm => mm.id === pid);
      const g = m?.gender;
      if (g == null || g === 'prefer-not-to-say') {
        if (!genderOverrides[slot]) {
          out.push({ slot, playerId: pid, name: m?.full_name ?? 'Player' });
        }
      }
    }
    return out;
  }

  // Doubles category preview using effective genders (override → profile).
  const doublesCategory: DoublesCategory | null = (() => {
    if (matchType !== 'doubles') return null;
    if (!p1 || !partner1 || !p2 || !partner2) return null;
    const genders = [
      effectiveGender(p1, 'p1'),
      effectiveGender(partner1, 'partner1'),
      effectiveGender(p2, 'p2'),
      effectiveGender(partner2, 'partner2'),
    ];
    if (genders.some(g => g == null)) return 'unspecified';
    const hasMale   = genders.some(g => g === 'male');
    const hasFemale = genders.some(g => g === 'female');
    return (hasMale && hasFemale) ? 'mixed' : 'gendered';
  })();

  // List of slots that still need a gender declared (after applying overrides).
  const pendingGenderSlots = unsetSlots();

  return (
    <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">

      {/* Tournament-match banner */}
      {isTournamentMatch && (
        <View style={S.tournamentBanner}>
          <Text style={S.tournamentBannerTitle}>🏆 Recording a tournament match</Text>
          <Text style={S.tournamentBannerBody}>
            {tournamentName ? `From ${tournamentName}. ` : ''}Players and match type are locked from the bracket. PLUPR updates as soon as you submit — no separate confirmation step.
          </Text>
        </View>
      )}

      {/* Singles / Doubles toggle — locked in tournament mode */}
      <View style={S.toggleRow}>
        {(['singles', 'doubles'] as MatchType[]).map((t) => {
          const isActive = matchType === t;
          const disabled = isTournamentMatch && !isActive;
          return (
            <TouchableOpacity
              key={t}
              style={[S.toggleBtn, isActive && S.toggleBtnActive, disabled && { opacity: 0.4 }]}
              onPress={() => disabled ? null : resetOnTypeChange(t)}
              disabled={disabled}
            >
              <Text style={[S.toggleText, isActive && S.toggleTextActive]}>
                {t === 'singles' ? 'Singles' : 'Doubles'}
              </Text>
            </TouchableOpacity>
          );
        })}
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

      {/* Per-match gender declaration for players without a profile gender */}
      {matchType === 'doubles' && pendingGenderSlots.length > 0 && (
        <View style={S.genderDeclareCard}>
          <Text style={S.genderDeclareTitle}>Declare gender for this match</Text>
          <Text style={S.genderDeclareBody}>
            {pendingGenderSlots.length === 1 ? 'This player hasn\'t' : 'These players haven\'t'} set a gender on their profile.
            Pick a gender for this match so we can classify it as Gendered or Mixed Doubles.
          </Text>
          {pendingGenderSlots.map(s => (
            <View key={s.slot} style={S.genderDeclareRow}>
              <Text style={S.genderDeclareName} numberOfLines={1}>{s.name}</Text>
              <View style={S.genderDeclarePills}>
                {(['male','female'] as const).map(g => {
                  const active = genderOverrides[s.slot] === g;
                  return (
                    <TouchableOpacity
                      key={g}
                      style={[S.genderDeclarePill, active && S.genderDeclarePillActive]}
                      onPress={() => setGenderOverrides(prev => ({ ...prev, [s.slot]: g }))}
                    >
                      <Text style={[S.genderDeclarePillText, active && S.genderDeclarePillTextActive]}>
                        {g === 'male' ? '♂ Male' : '♀ Female'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      )}

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
            {doublesCategory === 'gendered'    ? 'All four players are on the same side (or one declared the same as the others) — updates Gendered Doubles PLUPR.' :
             doublesCategory === 'mixed'       ? 'Players span multiple genders — updates Mixed Doubles PLUPR.'             :
                                                 'Pick a gender above for every player without one to enable this match.'}
          </Text>
        </View>
      )}

      {/* Score entry — supports best-of-N (add a game per row). */}
      {games.map((g, i) => (
        <View key={i} style={S.scoreCard}>
          {games.length > 1 && (
            <View style={S.gameLabelRow}>
              <Text style={S.gameLabel}>Game {i + 1}</Text>
              <TouchableOpacity onPress={() => removeGame(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={S.gameRemove}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={S.scoreRow}>
            <View style={S.scoreCol}>
              {i === 0 && <Text style={S.scoreName} numberOfLines={1}>{p1Name}</Text>}
              <TextInput
                style={S.scoreInput}
                keyboardType="number-pad"
                value={g.t1}
                onChangeText={(v) => updateGame(i, 't1', v)}
                placeholder="0"
                placeholderTextColor={colors.border}
                maxLength={2}
              />
            </View>
            <Text style={S.vs}>vs</Text>
            <View style={S.scoreCol}>
              {i === 0 && <Text style={S.scoreName} numberOfLines={1}>{p2Name}</Text>}
              <TextInput
                style={S.scoreInput}
                keyboardType="number-pad"
                value={g.t2}
                onChangeText={(v) => updateGame(i, 't2', v)}
                placeholder="0"
                placeholderTextColor={colors.border}
                maxLength={2}
              />
            </View>
          </View>
        </View>
      ))}
      <TouchableOpacity style={S.addGameBtn} onPress={addGame}>
        <Text style={S.addGameBtnText}>+ Add another game</Text>
      </TouchableOpacity>

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
          {([false, true] as const).map(outdoor => {
            const buttonType: 'outdoor' | 'indoor' = outdoor ? 'outdoor' : 'indoor';
            const isDisabled = courtTypeLocked !== null && courtTypeLocked !== buttonType;
            return (
              <TouchableOpacity
                key={String(outdoor)}
                style={[
                  S.courtTypeBtn,
                  isOutdoor === outdoor && S.courtTypeBtnActive,
                  isDisabled && S.courtTypeBtnDisabled,
                ]}
                onPress={() => isDisabled ? null : setIsOutdoor(prev => prev === outdoor ? null : outdoor)}
                disabled={isDisabled}
              >
                <Text style={[S.courtTypeIcon, isDisabled && S.courtTypeTextDisabled]}>{outdoor ? '☀️' : '🏠'}</Text>
                <Text style={[
                  S.courtTypeText,
                  isOutdoor === outdoor && S.courtTypeTextActive,
                  isDisabled && S.courtTypeTextDisabled,
                ]}>
                  {outdoor ? 'Outdoor' : 'Indoor'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Status message */}
      <StatusBanner status={status.value} />

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
    tournamentBanner:      { backgroundColor: c.primaryLight, borderLeftWidth: 4, borderLeftColor: c.primary, borderRadius: 10, padding: 12, marginBottom: 16 },
    tournamentBannerTitle: { fontSize: 14, fontWeight: '800', color: c.text, marginBottom: 4 },
    tournamentBannerBody:  { fontSize: 13, color: c.textSub, lineHeight: 18 },
    toggleRow: { flexDirection: 'row', borderRadius: 10, borderWidth: 1.5, borderColor: c.border, overflow: 'hidden', marginBottom: 20 },
    toggleBtn: { flex: 1, padding: 12, alignItems: 'center', backgroundColor: c.surfaceAlt },
    toggleBtnActive: { backgroundColor: c.primary },
    toggleText: { fontSize: 15, fontWeight: '600', color: c.textMuted },
    toggleTextActive: { color: '#fff' },
    teamSection: { backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: c.border, elevation: 1, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    teamLabel: { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },

    genderDeclareCard:       { borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1.5, borderColor: '#d4a72c', backgroundColor: '#fff8e6' },
    genderDeclareTitle:      { fontSize: 14, fontWeight: '800', color: '#8a6d00', marginBottom: 4 },
    genderDeclareBody:       { fontSize: 12, color: c.textSub, lineHeight: 17, marginBottom: 8 },
    genderDeclareRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    genderDeclareName:       { flex: 1, fontSize: 13, fontWeight: '700', color: c.text },
    genderDeclarePills:      { flexDirection: 'row', gap: 6 },
    genderDeclarePill:       { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surface },
    genderDeclarePillActive: { borderColor: c.primary, backgroundColor: c.primaryLight },
    genderDeclarePillText:   { fontSize: 12, fontWeight: '700', color: c.textSub },
    genderDeclarePillTextActive: { color: c.primary },

    categoryCard:            { borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1.5 },
    categoryCardGendered:    { backgroundColor: c.primaryLight, borderColor: c.primary },
    categoryCardMixed:       { backgroundColor: '#f3e5f5',      borderColor: '#8e24aa' },
    categoryCardUnspecified: { backgroundColor: '#fff8e1',      borderColor: '#f57f17' },
    categoryHeader:          { fontSize: 14, fontWeight: '800', color: c.text, marginBottom: 4 },
    categorySub:             { fontSize: 12, color: c.textSub, lineHeight: 16 },
    label: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 5, marginTop: 10 },
    pickerWrapper: { borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: 'hidden', backgroundColor: c.surface },
    scoreCard: { flexDirection: 'column', backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 16, marginVertical: 8, borderWidth: 1, borderColor: c.border, elevation: 1, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
    scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    scoreCol: { flex: 1, alignItems: 'center' },
    scoreName: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 8, textAlign: 'center' },
    scoreInput: { borderWidth: 2, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 28, textAlign: 'center', fontWeight: '800', color: c.text, width: 72, backgroundColor: c.surface },
    vs: { fontSize: 16, fontWeight: '700', color: c.border },
    gameLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    gameLabel: { fontSize: 12, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6 },
    gameRemove: { fontSize: 16, color: c.textMuted, fontWeight: '700', paddingHorizontal: 4 },
    addGameBtn: { alignSelf: 'center', marginTop: 4, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: c.primary, backgroundColor: c.surface },
    addGameBtnText: { fontSize: 13, fontWeight: '700', color: c.primary },
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
    courtTypeBtnDisabled: { opacity: 0.4, backgroundColor: c.bg },
    courtTypeIcon: { fontSize: 18 },
    courtTypeText: { fontSize: 14, fontWeight: '600', color: c.textMuted },
    courtTypeTextActive: { color: c.primary },
    courtTypeTextDisabled: { color: c.textMuted },
    button: { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 12 },
    buttonDisabled: { backgroundColor: c.primary + '80' },
    buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  });
}
