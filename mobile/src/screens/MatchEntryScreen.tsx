import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Pressable,
  StyleSheet, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
// Player pickers are the foundation's searchable SingleSelectModal now, not
// @react-native-picker wheels (a doubles match stacked four ~216px wheels).
// The picker package stays installed for any other caller; this screen no
// longer imports it.
import { Panel, Badge, FilterPill, SectionHeader, SegmentedToggle, SingleSelectModal } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { DoublesCategory, Profile, RootStackParamList } from '../types';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import { useTheme } from '../lib/ThemeContext';
import { isGodmodeUserId } from '../lib/godmode';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { computeBadgeProgress } from '../lib/unlockProgress';
import LeaguePickerModal, { PickableLeague } from '../components/LeaguePickerModal';
import TournamentPickerModal, { PickableTournament } from '../components/TournamentPickerModal';
import { sbCall, requireUserId, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MatchEntry'>;
  route: RouteProp<RootStackParamList, 'MatchEntry'>;
};

type MatchType = 'singles' | 'doubles';

/** The four player slots, in the order the form shows them. */
type PlayerSlot = 'p1' | 'partner1' | 'p2' | 'partner2';

const SLOT_LABEL: Record<PlayerSlot, string> = {
  p1: 'Team 1 player',
  partner1: 'Team 1 partner',
  p2: 'Team 2 player',
  partner2: 'Team 2 partner',
};

/**
 * One player slot: a 44px field showing the chosen name (or the slot's name as
 * a placeholder). Tapping it opens the screen's one SingleSelectModal; only
 * one picker Modal is ever up at a time.
 */
function PlayerField({ slot, name, onPress, S }: {
  slot: PlayerSlot;
  name: string | null;
  onPress: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  return (
    <TouchableOpacity
      style={S.field}
      activeOpacity={0.7}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={name ? `${SLOT_LABEL[slot]}: ${name}. Change` : `Choose ${SLOT_LABEL[slot].toLowerCase()}`}
    >
      <Text style={[S.fieldText, !name && S.fieldPlaceholder]} numberOfLines={1}>
        {name ?? SLOT_LABEL[slot]}
      </Text>
      <Text style={S.fieldChevron}>▾</Text>
    </TouchableOpacity>
  );
}

export default function MatchEntryScreen({ navigation, route }: Props) {
  const {
    leagueId,
    fromHome,
    tournamentId,
    tournamentMatchId,
    tournamentName,
    eventId,
    prefillMatchType,
    prefillTeam1Player, prefillTeam1Partner,
    prefillTeam2Player, prefillTeam2Partner,
  } = route.params;
  const isTournamentMatch = !!tournamentMatchId;
  // Home-launched entry: no fixed league, so the user picks the league (required)
  // and an optional tournament tag inline. Any other entry point fixes the league.
  const pickLeagueInline = !leagueId && !isTournamentMatch;
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [members, setMembers] = useState<Profile[]>([]);
  // Home-launched entry: the chosen league/tournament. When the league is fixed
  // by the route, selectedLeagueId mirrors it and these dropdowns are hidden.
  const [selectedLeagueId, setSelectedLeagueId] = useState<string | null>(leagueId ?? null);
  const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(tournamentId ?? null);
  const [leagueCandidates, setLeagueCandidates] = useState<PickableLeague[]>([]);
  const [tournamentCandidates, setTournamentCandidates] = useState<PickableTournament[]>([]);
  // The recording user's own league ids — candidate leagues are restricted to
  // these so the matches INSERT RLS (auth.uid() must be a member of league_id)
  // can never reject the submit.
  const [myLeagueIds, setMyLeagueIds] = useState<Set<string>>(new Set());
  // Tracks the court name we last auto-prefilled from a league's home court, so
  // a later league switch can replace it without clobbering a user's own choice.
  const autoFilledCourtRef = useRef<string | null>(null);
  const [leaguePickerOpen, setLeaguePickerOpen] = useState(false);
  const [tournamentPickerOpen, setTournamentPickerOpen] = useState(false);
  // Which player slot's picker is open (one SingleSelectModal serves all four;
  // it clears its search on each open, so no slot inherits another's).
  const [pickerSlot, setPickerSlot] = useState<PlayerSlot | null>(null);
  const openPicker = (slot: PlayerSlot) => setPickerSlot(slot);
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
  // `matches` has no dedupe constraint and a match insert cascades into PLUPR,
  // pickle ledgers and notifications — a duplicate row is not a cosmetic bug.
  // The success path defers navigation by 1.5–2.5s so the user can read the
  // banner, so the button must stay latched off for that whole window, not just
  // while the request is in flight.
  const [submitted, setSubmitted]   = useState(false);
  const inFlight                    = useRef(false);
  const navTimer                    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = useStatusMessage();

  useEffect(() => () => { if (navTimer.current) clearTimeout(navTimer.current); }, []);

  useEffect(() => { loadLeagueData(); }, []);

  const [leagueHomeCourt, setLeagueHomeCourt] = useState<string | null>(null);

  async function loadLeagueData() {
    // Local session read: the network getUser() resolved null offline, so the
    // default paddle silently stopped being applied to recorded matches.
    const uid = await currentUserId(supabase);
    if (uid) {
      const { data: paddle } = await supabase.from('player_paddles')
        .select('id').eq('user_id', uid).eq('is_default', true).maybeSingle();
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

    // ── Home-launched match: no fixed league yet ──
    // Load the union of everyone the current user shares a league with, so
    // players can be picked first; the league/tournament dropdowns are then
    // filtered to those that contain all selected players (see candidate effect).
    if (pickLeagueInline) {
      await loadLeaguematesUnion();
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

  // Build the pool of pickable players for a Home-launched match: every profile
  // who shares at least one league with the current user (union across the
  // user's leagues), plus the user themselves. League/tournament candidates are
  // narrowed afterwards based on which players actually get picked.
  async function loadLeaguematesUnion() {
    // Local read: an offline getUser() emptied the player picker entirely, so
    // there was nobody to record a match against.
    const uid = await currentUserId(supabase);
    if (!uid) { setMembers([]); return; }
    const user = { id: uid };

    // Leagues the current user belongs to.
    const { data: myLeaguesRows } = await supabase
      .from('league_members')
      .select('league_id')
      .eq('user_id', user.id);
    const myIds = Array.from(new Set(((myLeaguesRows ?? []) as any[]).map(r => r.league_id).filter(Boolean)));
    setMyLeagueIds(new Set(myIds));
    if (myIds.length === 0) { setMembers([]); return; }

    // Everyone who is a member of any of those leagues (deduped by profile id).
    const { data: memberRows } = await supabase
      .from('league_members')
      .select('profile:profiles(*)')
      .in('league_id', myIds);

    const byId = new Map<string, Profile>();
    for (const row of ((memberRows ?? []) as any[])) {
      const p = row.profile as Profile | null;
      if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
    }
    setMembers(Array.from(byId.values()).sort((a, b) =>
      (a.full_name ?? '').localeCompare(b.full_name ?? '')));
  }

  // Recompute the league/tournament dropdown candidates whenever the selected
  // players change (Home-launched entry only). A league/tournament qualifies
  // only if ALL selected players are members / approved registrants of it.
  const selectedPlayerIds = (matchType === 'singles'
    ? [p1, p2]
    : [p1, partner1, p2, partner2]
  ).filter(Boolean);
  // Stable dependency key so the effect only fires on a real selection change.
  const selectedPlayerKey = [...selectedPlayerIds].sort().join(',');
  // Stable key for the user's own leagues (a Set isn't a stable dep by identity).
  const myLeagueIdsKey = [...myLeagueIds].sort().join(',');

  useEffect(() => {
    if (!pickLeagueInline) return;
    const ids = selectedPlayerKey ? selectedPlayerKey.split(',') : [];
    if (ids.length === 0) {
      setLeagueCandidates([]);
      setTournamentCandidates([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const need = ids.length;

      // Leagues where every selected player is a member.
      const { data: lmRows } = await supabase
        .from('league_members')
        .select('league_id, user_id')
        .in('user_id', ids);
      const leagueMemberSets = new Map<string, Set<string>>();
      for (const r of ((lmRows ?? []) as any[])) {
        if (!r.league_id || !r.user_id) continue;
        if (!leagueMemberSets.has(r.league_id)) leagueMemberSets.set(r.league_id, new Set());
        leagueMemberSets.get(r.league_id)!.add(r.user_id);
      }
      const qualifyingLeagueIds = [...leagueMemberSets.entries()]
        // All selected players are members AND the recording user is a member
        // (latter is required by the matches INSERT RLS policy).
        .filter(([lid, set]) => set.size === need && myLeagueIds.has(lid))
        .map(([lid]) => lid);

      // Tournaments where every selected player is an approved registrant.
      const { data: trRows } = await supabase
        .from('tournament_registrations')
        .select('tournament_id, user_id')
        .eq('status', 'approved')
        .in('user_id', ids);
      const tournMemberSets = new Map<string, Set<string>>();
      for (const r of ((trRows ?? []) as any[])) {
        if (!r.tournament_id || !r.user_id) continue;
        if (!tournMemberSets.has(r.tournament_id)) tournMemberSets.set(r.tournament_id, new Set());
        tournMemberSets.get(r.tournament_id)!.add(r.user_id);
      }
      const qualifyingTournamentIds = [...tournMemberSets.entries()]
        .filter(([, set]) => set.size === need)
        .map(([tid]) => tid);

      // Resolve names for the dropdowns.
      const [leaguesRes, tournsRes] = await Promise.all([
        qualifyingLeagueIds.length
          ? supabase.from('leagues').select('id, name').in('id', qualifyingLeagueIds).order('name')
          : Promise.resolve({ data: [] as any[] }),
        qualifyingTournamentIds.length
          ? supabase.from('tournaments').select('id, name, status, league_id').in('id', qualifyingTournamentIds).order('name')
          : Promise.resolve({ data: [] as any[] }),
      ]);
      if (cancelled) return;

      const leagues = ((leaguesRes.data ?? []) as PickableLeague[]);
      const tourns = ((tournsRes.data ?? []) as PickableTournament[]);
      setLeagueCandidates(leagues);
      setTournamentCandidates(tourns);

      // Clear selections that no longer qualify after a player change. When
      // exactly one league holds every chosen player (and the recorder, per
      // the insert RLS), pick it: there is nothing to choose. A league the
      // user picked themselves is kept as long as it still qualifies.
      setSelectedLeagueId(prev => {
        if (prev && leagues.some(l => l.id === prev)) return prev;
        return leagues.length === 1 ? leagues[0].id : null;
      });
      setSelectedTournamentId(prev => (prev && tourns.some(t => t.id === prev)) ? prev : null);
    })();
    return () => { cancelled = true; };
    // myLeagueIdsKey: recompute once the user's own leagues finish loading.
  }, [pickLeagueInline, selectedPlayerKey, myLeagueIdsKey]);

  // Only let a match be tagged with a tournament that is locked-in and running
  // (status 'active') AND belongs to the selected league. Registration-stage,
  // completed, or cancelled tournaments — and tournaments from other leagues —
  // are not selectable.
  const visibleTournaments = useMemo(
    () => tournamentCandidates.filter(
      t => t.status === 'active' && !!selectedLeagueId && t.league_id === selectedLeagueId,
    ),
    [tournamentCandidates, selectedLeagueId],
  );

  // Drop a tournament tag that no longer qualifies after a league/player change
  // (inline-pick flow only; other entry points fix the tournament via route).
  useEffect(() => {
    if (!pickLeagueInline) return;
    if (selectedTournamentId && !visibleTournaments.some(t => t.id === selectedTournamentId)) {
      setSelectedTournamentId(null);
    }
  }, [pickLeagueInline, visibleTournaments, selectedTournamentId]);

  // Home-launched entry: when a league is picked, adopt its home court for the
  // home-court flags (and prefill the location field if the user hasn't set one,
  // or only previously accepted an auto-fill from another league).
  useEffect(() => {
    if (!pickLeagueInline || !selectedLeagueId) { return; }
    let cancelled = false;
    (async () => {
      const { data: lg } = await supabase
        .from('leagues')
        .select('home_court, home_court_lat, home_court_lng')
        .eq('id', selectedLeagueId)
        .single();
      if (cancelled) return;
      setLeagueHomeCourt(lg?.home_court ?? null);
      // Prefill the location only when it's empty or still holds a court we
      // auto-filled from a previous league — never clobber a user's own pick.
      const canAutoFill = !location || location.name === autoFilledCourtRef.current;
      if (lg?.home_court && canAutoFill) {
        setLocation({ name: lg.home_court, address: '', lat: lg.home_court_lat ?? 0, lng: lg.home_court_lng ?? 0, placeId: '' });
        autoFilledCourtRef.current = lg.home_court;
      }
    })();
    return () => { cancelled = true; };
    // location intentionally excluded: we only want to prefill on league change,
    // not re-run when the user edits the location afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickLeagueInline, selectedLeagueId]);

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
    // Checked here, not just via `disabled`: two taps in the same frame both
    // enter this before React re-renders the button.
    if (inFlight.current || submitted) return;
    status.clear();

    // Validation
    if (matchType === 'singles') {
      if (!p1 || !p2) return setError('Please select both players.');
      if (p1 === p2) return setError('Players must be different.');
    } else {
      if (!p1 || !partner1 || !p2 || !partner2) return setError('Please select all four players.');
      if (new Set([p1, partner1, p2, partner2]).size !== 4) return setError('All four players must be different.');
    }

    // Home-launched entry: a league is required (matches.league_id is NOT NULL).
    if (pickLeagueInline && !selectedLeagueId) {
      return setError('Please choose a league for this match.');
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

    inFlight.current = true;
    setLoading(true);
    try {
      // ── Tournament match: update the existing tournament_matches row ──
      // The on_tournament_match_completed trigger fires when status flips to
      // 'completed' and applies PLUPR to the right facet/scope automatically.
      if (isTournamentMatch && tournamentMatchId) {
        // Safe to retry: an update keyed by id writes the same values twice.
        await sbCall(() => supabase
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
          .eq('id', tournamentMatchId));
        setSubmitted(true);
        status.success('Tournament match recorded. PLUPR updated.');
        navTimer.current = setTimeout(() => navigation.goBack(), 1500);
        return;
      }

      // ── League / casual match: insert into `matches` as pending (confirm flow) ──
      // The entering user auto-confirms whichever team they're on — the OTHER
      // team must confirm within 1 hour or the row is deleted (via the
      // expire_pending_matches cron job).
      //
      // Godmode shortcut: insert as 'completed' with both team confirms set to
      // the godmode user, so PLUPR applies immediately and no expiry is needed.
      //
      // LOCAL session read: getUser() is a network call that resolves
      // { user: null } offline, so `user!.id` below used to throw a TypeError
      // out of this handler and strand the button on "Saving...".
      const enteringUid = await requireUserId(supabase, 'Please sign in again to record a match.');
      const isOnTeam1 = enteringUid === p1 || (matchType === 'doubles' && enteringUid === partner1);
      const isOnTeam2 = enteringUid === p2 || (matchType === 'doubles' && enteringUid === partner2);
      const isGod = isGodmodeUserId(enteringUid);
      const deadline = isGod ? null : new Date(Date.now() + 60 * 60 * 1000).toISOString();

      // Deliberately NOT retried. A timeout can't distinguish "never landed"
      // from "landed, reply lost", and a second `matches` row re-runs the whole
      // PLUPR / pickle / notification cascade with no dedupe constraint to stop
      // it. One bounded attempt; on a transport failure we tell the truth below.
      const inserted = await sbCall(() => supabase.from('matches').insert({
        league_id:     selectedLeagueId,
        tournament_id: selectedTournamentId ?? null,
        event_id:      eventId ?? null,
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
      }).select('id').single(), { retries: 0, timeoutMs: 30_000 }) as { id: string } | null;

      // Latch before any follow-up work: the match exists, so nothing after this
      // point may put the user back in a position to insert it again.
      setSubmitted(true);

      // Record paddle usage for all players who have a default paddle
      // Can be edited within 72h of match
      if (inserted?.id && myDefaultPaddleId) {
        const canEditUntil = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
        try {
          await sbCall(() => supabase.from('match_paddle_usage').upsert({
            match_id: inserted.id,
            user_id:  enteringUid,
            paddle_id: myDefaultPaddleId,
            can_edit_until: canEditUntil,
          }));
        } catch {
          // Paddle attribution is editable for 72h — never fail (or re-offer) a
          // match that is already recorded because this side note didn't land.
        }
      }

      const baseMsg = isGod
        ? 'Match recorded and confirmed (godmode). PLUPR updated.'
        : 'Match recorded — pending confirmation. The other team has 1 hour to confirm before this match expires.';

      // Show the result + schedule navigation immediately — never wait on the
      // nudge query. The unlock nudge runs in parallel and, if it resolves
      // before the screen pops, upgrades the banner with a "keep going" line
      // when the entering user is 50–99% toward an unearned badge.
      status.success(baseMsg);
      navTimer.current = setTimeout(() => navigation.goBack(), isGod ? 1500 : 2500);
      computeBadgeProgress(enteringUid)
        .then(progress => {
          const close = progress.find(p => !p.earned && !p.perLeague && p.pct >= 0.5 && p.pct < 1);
          if (close) status.success(`${baseMsg}\n\n🔥 ${close.label} — keep going to unlock ${close.badge}!`);
        })
        .catch(() => { /* nudge is best-effort */ });
    } catch (e) {
      setError(friendlySbMessage(e, 'Could not record the match.', {
        network: 'Lost the connection, so we can\'t tell whether this match saved. Check Match History before recording it again.',
      }));
    } finally {
      inFlight.current = false;
      setLoading(false);
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

  // ── Player picker (one SingleSelectModal for all four slots) ───────────
  const slotValue: Record<PlayerSlot, string> = { p1, partner1, p2, partner2 };
  const slotSetter: Record<PlayerSlot, (v: string) => void> = {
    p1: setP1, partner1: setPartner1, p2: setP2, partner2: setPartner2,
  };
  // Who a slot may NOT pick: anyone already on the other team, and its own
  // teammate. Same exclusions the wheel pickers applied.
  const slotExclude: Record<PlayerSlot, string[]> = {
    p1:       [...team2Players, partner1],
    partner1: [...team2Players, p1],
    p2:       [...team1Players, partner2],
    partner2: [...team1Players, p2],
  };
  const nameOf = (id: string) => (id ? members.find((m) => m.id === id)?.full_name ?? 'Player' : null);

  const pickerItems = useMemo(() => {
    if (!pickerSlot) return [];
    const value = slotValue[pickerSlot];
    const exclude = slotExclude[pickerSlot];
    return members
      .filter((m) => !exclude.includes(m.id) || m.id === value)
      .map((m) => ({ id: m.id, name: m.full_name ?? 'Player' }));
    // slotValue / slotExclude are rebuilt every render from these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerSlot, members, p1, partner1, p2, partner2]);

  const selectedLeagueName = leagueCandidates.find(l => l.id === selectedLeagueId)?.name ?? null;
  // The optional tournament tag only renders when the chosen league has an
  // active tournament these players are all in (or one is already chosen):
  // a disabled "(none)" field is a row of nothing.
  const showTournamentField = pickLeagueInline && (visibleTournaments.length > 0 || !!selectedTournamentId);
  const categoryCopy: Record<DoublesCategory, { label: string; tone: 'brand' | 'info' | 'warning'; sub: string }> = {
    gendered:    { label: 'Gendered doubles', tone: 'brand',   sub: 'Updates Gendered Doubles PLUPR' },
    mixed:       { label: 'Mixed doubles',    tone: 'info',    sub: 'Updates Mixed Doubles PLUPR' },
    unspecified: { label: 'Needs genders',    tone: 'warning', sub: 'Pick a gender above for every player without one' },
  };

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.container} keyboardShouldPersistTaps="handled">

      {/* Tournament-match banner */}
      {isTournamentMatch && (
        // The screen's one Emphasis card: Panel + 3px accent edge.
        <Panel emphasis style={S.tournamentBanner}>
          <Text style={S.tournamentBannerTitle}>🏆 Recording a tournament match</Text>
          <Text style={S.tournamentBannerBody} numberOfLines={3}>
            {tournamentName ? `From ${tournamentName}. ` : ''}Players and match type are locked from the bracket. PLUPR updates as soon as you submit — no separate confirmation step.
          </Text>
        </Panel>
      )}

      {/* Singles / Doubles toggle — locked in tournament mode (the other type
          is disabled, the bracket's stays selected).
          FOUNDATION-TODO: SegmentedToggle's segments only set
          accessibilityState.selected, which RNW drops, so web screen readers
          can't tell which type is chosen. Needs aria-pressed (or radio +
          aria-checked) in the foundation's segmentA11y. */}
      <SegmentedToggle<MatchType>
        variant="solid"
        size="lg"
        fullWidth
        options={(['singles', 'doubles'] as MatchType[]).map((t) => ({
          value: t,
          label: t === 'singles' ? 'Singles' : 'Doubles',
          disabled: isTournamentMatch && t !== matchType,
        }))}
        value={matchType}
        onChange={resetOnTypeChange}
        style={S.typeToggle}
      />

      {/* Players first: on a Home-launched match the league list below is
          narrowed to leagues every chosen player shares (and auto-picked when
          exactly one does). */}
      <Panel style={S.block}>
        <View style={S.teamRow}>
          <PlayerField slot="p1" name={nameOf(p1)} onPress={() => openPicker('p1')} S={S} />
          {matchType === 'doubles' && (
            <PlayerField slot="partner1" name={nameOf(partner1)} onPress={() => openPicker('partner1')} S={S} />
          )}
        </View>
        <View style={S.vsRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={S.vsRule} />
          <Text style={S.vsText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>vs</Text>
          <View style={S.vsRule} />
        </View>
        <View style={S.teamRow}>
          <PlayerField slot="p2" name={nameOf(p2)} onPress={() => openPicker('p2')} S={S} />
          {matchType === 'doubles' && (
            <PlayerField slot="partner2" name={nameOf(partner2)} onPress={() => openPicker('partner2')} S={S} />
          )}
        </View>
      </Panel>

      {/* Home-launched entry: league (required) + tournament tag (optional).
          Hidden for every other entry point, which fixes the league via route. */}
      {pickLeagueInline && (
        <View style={[S.block, S.tagRow]}>
          <View style={S.tagCol}>
            <Text style={S.fieldLabel} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              League <Text style={S.required}>*</Text>
            </Text>
            <TouchableOpacity
              style={[S.field, selectedPlayerIds.length === 0 && S.dim]}
              activeOpacity={0.7}
              disabled={selectedPlayerIds.length === 0}
              onPress={() => setLeaguePickerOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={selectedLeagueName ? `League: ${selectedLeagueName}. Change` : 'Choose a league'}
            >
              <Text style={[S.fieldText, !selectedLeagueId && S.fieldPlaceholder]} numberOfLines={1}>
                {selectedPlayerIds.length === 0
                  ? 'Pick players first…'
                  : (selectedLeagueName
                      ?? (leagueCandidates.length === 0 ? 'No shared league for these players' : 'Select a league…'))}
              </Text>
              <Text style={S.fieldChevron}>▾</Text>
            </TouchableOpacity>
          </View>

          {showTournamentField && (
            <View style={S.tagCol}>
              <Text style={S.fieldLabel} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Tournament</Text>
              <TouchableOpacity
                style={S.field}
                activeOpacity={0.7}
                onPress={() => setTournamentPickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Tag a tournament (optional)"
              >
                <Text style={[S.fieldText, !selectedTournamentId && S.fieldPlaceholder]} numberOfLines={1}>
                  {selectedTournamentId
                    ? (visibleTournaments.find(t => t.id === selectedTournamentId)?.name ?? 'Optional')
                    : 'Optional'}
                </Text>
                <Text style={S.fieldChevron}>▾</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Per-match gender declaration for players without a profile gender */}
      {matchType === 'doubles' && pendingGenderSlots.length > 0 && (
        <View style={[S.block, S.genderDeclareCard]}>
          <Text style={S.genderDeclareTitle}>Declare gender for this match</Text>
          <Text style={S.genderDeclareBody} numberOfLines={2}>
            {pendingGenderSlots.length === 1 ? 'This player hasn\'t' : 'These players haven\'t'} set a gender on their profile, so we can't tell Gendered from Mixed Doubles.
          </Text>
          {pendingGenderSlots.map(s => (
            <View key={s.slot} style={S.genderDeclareRow}>
              <Text style={S.genderDeclareName} numberOfLines={1}>{s.name}</Text>
              {(['male','female'] as const).map(g => {
                const active = genderOverrides[s.slot] === g;
                return (
                  <FilterPill
                    key={g}
                    label={g === 'male' ? '♂ Male' : '♀ Female'}
                    active={active}
                    onPress={() => setGenderOverrides(prev => ({ ...prev, [s.slot]: g }))}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    accessibilityLabel={`${s.name}: ${g}`}
                  />
                );
              })}
            </View>
          ))}
        </View>
      )}

      {/* Doubles category preview: one line instead of a card. */}
      {doublesCategory && (
        <View style={[S.block, S.categoryLine]}>
          <Badge
            label={categoryCopy[doublesCategory].label}
            tone={categoryCopy[doublesCategory].tone}
            maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
          />
          <Text style={S.categorySub} numberOfLines={1}>{categoryCopy[doublesCategory].sub}</Text>
        </View>
      )}

      {/* Score entry — supports best-of-N (add a game per row). */}
      <Panel padded={false} style={S.block}>
        <SectionHeader
          title="Score"
          action={{ label: '+ Add game', a11yLabel: 'Add another game', onPress: addGame }}
          style={S.panelHeader}
        />
        <View style={S.scoreBody}>
          {games.map((g, i) => (
            <View key={i} style={S.scoreRow}>
              {games.length > 1 && (
                <Text style={S.gameLabel} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>G{i + 1}</Text>
              )}
              <View style={S.scoreCol}>
                {i === 0 && <Text style={S.scoreName} numberOfLines={1}>{p1Name}</Text>}
                <TextInput
                  style={S.scoreInput}
                  keyboardType="number-pad"
                  value={g.t1}
                  onChangeText={(v) => updateGame(i, 't1', v)}
                  placeholder="0"
                  placeholderTextColor={colors.textMuted}
                  maxLength={2}
                  accessibilityLabel={`Game ${i + 1}, ${p1Name} score`}
                />
              </View>
              <Text style={S.vs}>–</Text>
              <View style={S.scoreCol}>
                {i === 0 && <Text style={S.scoreName} numberOfLines={1}>{p2Name}</Text>}
                <TextInput
                  style={S.scoreInput}
                  keyboardType="number-pad"
                  value={g.t2}
                  onChangeText={(v) => updateGame(i, 't2', v)}
                  placeholder="0"
                  placeholderTextColor={colors.textMuted}
                  maxLength={2}
                  accessibilityLabel={`Game ${i + 1}, ${p2Name} score`}
                />
              </View>
              {games.length > 1 && (
                <Pressable
                  onPress={() => removeGame(i)}
                  style={({ pressed }) => [S.removeBox, pressed && S.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove game ${i + 1}`}
                >
                  <Text style={S.removeGlyph}>✕</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      </Panel>

      {/* Location */}
      <View style={S.block}>
        <SectionHeader
          title={location ? 'Match location' : 'Match location *'}
          action={{
            label: 'Add a court',
            a11yLabel: "Can't find your court? Add it",
            onPress: () =>
              navigation.navigate(
                'SubmitVenue',
                location ? { lat: location.lat, lng: location.lng } : undefined,
              ),
          }}
        />
        <CourtPicker
          value={location}
          onSelect={setLocation}
          active
          placeholder="Search for the court played at..."
        />
      </View>

      {/* Indoor / Outdoor */}
      <View style={S.block}>
        <SectionHeader title="Court type" />
        {courtHint && (
          <Text style={S.courtHint} numberOfLines={1}>📍 {courtHint}</Text>
        )}
        <View style={S.courtTypeRow}>
          {([false, true] as const).map(outdoor => {
            const buttonType: 'outdoor' | 'indoor' = outdoor ? 'outdoor' : 'indoor';
            const isDisabled = courtTypeLocked !== null && courtTypeLocked !== buttonType;
            const isActive = isOutdoor === outdoor;
            return (
              <TouchableOpacity
                key={String(outdoor)}
                style={[
                  S.courtTypeBtn,
                  isActive && S.courtTypeBtnActive,
                  isDisabled && S.courtTypeBtnDisabled,
                ]}
                onPress={() => isDisabled ? null : setIsOutdoor(prev => prev === outdoor ? null : outdoor)}
                disabled={isDisabled}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive, disabled: isDisabled }}
              >
                <Text style={S.courtTypeIcon}>{outdoor ? '☀️' : '🏠'}</Text>
                <Text style={[
                  S.courtTypeText,
                  isActive && S.courtTypeTextActive,
                ]}>
                  {outdoor ? 'Outdoor' : 'Indoor'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Status message */}
      <StatusBanner status={status.value} style={S.status} />

      {/* The one full-height primary on the screen. */}
      <Button
        title={submitted ? 'Recorded' : 'Record match'}
        onPress={submitMatch}
        loading={loading}
        disabled={loading || submitted}
      />

      {/* One player picker for the four slots. A Modal only ever opens from a
          tap on this screen, never on top of another one. */}
      <SingleSelectModal
        visible={pickerSlot != null}
        title={pickerSlot ? SLOT_LABEL[pickerSlot] : ''}
        items={pickerItems}
        selectedId={pickerSlot ? slotValue[pickerSlot] || null : null}
        onPick={(id) => {
          if (pickerSlot) slotSetter[pickerSlot](id ?? '');
          setPickerSlot(null);
        }}
        onClose={() => setPickerSlot(null)}
        searchPlaceholder="Search players…"
        // The clear row stays first; emptyText shows under it when nothing
        // matches (foundation 1.42).
        noneLabel="No player"
        emptyText={members.length === 0
          ? (pickLeagueInline ? 'Join a league to record a match with league-mates.' : 'No players to pick from yet.')
          : 'No matches.'}
      />

      {/* Home-launched league / tournament pickers. */}
      {/* TODO: smoke-test in browser */}
      {pickLeagueInline && (
        <>
          <LeaguePickerModal
            visible={leaguePickerOpen}
            leagues={leagueCandidates}
            selectedId={selectedLeagueId}
            onPick={(id) => { setSelectedLeagueId(id); setLeaguePickerOpen(false); }}
            onClose={() => setLeaguePickerOpen(false)}
          />
          <TournamentPickerModal
            visible={tournamentPickerOpen}
            tournaments={visibleTournaments}
            selectedId={selectedTournamentId}
            onPick={(id) => { setSelectedTournamentId(id); setTournamentPickerOpen(false); }}
            onClose={() => setTournamentPickerOpen(false)}
          />
        </>
      )}

    </ScrollView>
  );
}

// Height budget for a Home-launched doubles match at the default text size,
// with nothing picked yet (the plan's "under 700px, no wheels"): 12 top +
// toggle 44 + teams panel 136 + league 62 + score 124 + location ~90 + court
// type 76 + Record 50 + 6 gaps of 12 + 24 bottom = about 690.
function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    screen:    { flex: 1, backgroundColor: c.bg },
    container: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.xl, flexGrow: 1 },
    block:     { marginBottom: SPACE.md },
    dim:       { opacity: 0.4 },
    pressed:   { opacity: 0.6 },

    // Panel supplies the hairline border, surface fill, 12 padding and radius 14.
    tournamentBanner:      { marginBottom: SPACE.md },
    tournamentBannerTitle: { ...t.title, marginBottom: SPACE.xxs },
    tournamentBannerBody:  t.sub,

    typeToggle:       { marginBottom: SPACE.md },

    // Player / league fields: a 44 box, the 15px value, a chevron.
    teamRow:          { flexDirection: 'row', gap: SPACE.sm },
    field:            { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, backgroundColor: c.surface },
    fieldText:        { flex: 1, fontSize: FONT.size.lg, color: c.text },
    fieldPlaceholder: { color: c.textMuted },
    fieldChevron:     { fontSize: FONT.size.md, color: c.textMuted, marginLeft: SPACE.sm },
    vsRow:            { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginVertical: SPACE.xs },
    vsRule:           { flex: 1, height: HAIRLINE, backgroundColor: c.border },
    vsText:           t.meta,

    tagRow:     { flexDirection: 'row', gap: SPACE.sm },
    tagCol:     { flex: 1, minWidth: 0 },
    fieldLabel: { ...t.fieldLabel, marginBottom: SPACE.xs },
    required:   { color: c.danger },

    genderDeclareCard:  { borderRadius: RADIUS.lg, padding: SPACE.md, borderWidth: HAIRLINE, borderColor: c.warning, backgroundColor: c.warningLight },
    genderDeclareTitle: { ...t.title, fontSize: FONT.size.md },
    genderDeclareBody:  { ...t.sub, marginTop: SPACE.xxs, marginBottom: SPACE.xs },
    genderDeclareRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    genderDeclareName:  { flex: 1, fontSize: FONT.size.base, fontWeight: '700', color: c.text },

    categoryLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 24 },
    categorySub:  { ...t.sub, flex: 1 },

    panelHeader: { paddingHorizontal: SPACE.md },
    scoreBody:   { paddingHorizontal: SPACE.md, paddingBottom: SPACE.md, gap: SPACE.sm },
    scoreRow:    { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.md },
    scoreCol:    { flex: 1, alignItems: 'center' },
    scoreName:   { ...t.meta, color: c.textSub, marginBottom: SPACE.xs, textAlign: 'center' },
    scoreInput:  { borderWidth: 2, borderColor: c.border, borderRadius: RADIUS.md, minHeight: 48, paddingVertical: SPACE.xs, fontSize: FONT.size.h1, textAlign: 'center', fontWeight: '800', color: c.text, width: 72, backgroundColor: c.surface },
    vs:          { fontSize: FONT.size.xl, fontWeight: '700', color: c.textMuted, paddingBottom: SPACE.md },
    gameLabel:   { ...t.meta, width: 24, paddingBottom: SPACE.md + SPACE.xxs },
    removeBox:   { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    removeGlyph: { fontSize: FONT.size.lg, fontWeight: '700', color: c.textMuted },

    courtHint:            { ...t.sub, color: c.textMuted, fontStyle: 'italic', marginBottom: SPACE.xs },
    courtTypeRow:         { flexDirection: 'row', gap: SPACE.sm },
    courtTypeBtn:         { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, minHeight: 44, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, backgroundColor: c.surface },
    courtTypeBtnActive:   { borderColor: c.primary, backgroundColor: c.primaryLight },
    courtTypeBtnDisabled: { opacity: 0.4, backgroundColor: c.bg },
    courtTypeIcon:        { fontSize: FONT.size.xl },
    courtTypeText:        { fontSize: FONT.size.md, fontWeight: '600', color: c.textSub },
    courtTypeTextActive:  { color: c.primary },

    status: { marginBottom: SPACE.sm },
  });
}
