import React, { useState, useCallback } from 'react';
import {
  ScrollView, View, Text, TouchableOpacity, Modal, Pressable,
  StyleSheet, Alert, ActivityIndicator, FlatList, TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Tournament, TournamentRegistration, Profile, RootStackParamList } from '../types';
import {
  getTournamentRole, isTournamentPrivileged, requiresPartner,
  bracketReleaseLabel, tournamentRoleLabel, tournamentRoleBadgeColor,
  TournamentRole,
} from '../lib/tournamentRole';
import {
  FORMAT_META, seedPlayers, seedTeams,
  generateRoundRobin, generatePoolPlay, generateSingleElim, generateDoubleElim,
  generateRotatingPartners, generateMLPSchedule,
  generateDoublesRoundRobin, generateDoublesSingleElim, generateDoublesDoubleElim, generateDoublesPoolPlay,
  MatchPairing, validateDoublesTeams, validateMlpTeams, validatePools, MlpTeamShape,
} from '../lib/tournament';
import { checkGodmode } from '../lib/godmode';
import { formatPlupr } from '../lib/plupr';
import AppDateTimePicker from '../components/AppDateTimePicker';
import TournamentBracket, { BracketSlot } from '../components/TournamentBracket';
import PicklePotCard from '../components/PicklePotCard';
import MlpTeamSection from '../components/MlpTeamSection';
import DoublesPairSection from '../components/DoublesPairSection';
import MlpPlayoffPreview from '../components/MlpPlayoffPreview';
import PayoutPreviewModal from '../components/PayoutPreviewModal';
import ConfirmModal from '../components/ConfirmModal';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentDetail'>;
  route: RouteProp<RootStackParamList, 'TournamentDetail'>;
};

type PartnerRequest = {
  id: string;
  requester_id: string;
  requested_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  requesterProfile?: Profile;
  requestedProfile?: Profile;
};

export default function TournamentDetailScreen({ navigation, route }: Props) {
  const { tournamentId } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [tournament, setTournament]       = useState<Tournament | null>(null);
  const [registrations, setRegistrations] = useState<TournamentRegistration[]>([]);
  const [myRole, setMyRole]               = useState<TournamentRole>(null);
  const [myUserId, setMyUserId]           = useState<string | null>(null);
  const [partnerRequests, setPartnerRequests] = useState<PartnerRequest[]>([]);
  const [generatedMatches, setGeneratedMatches] = useState<MatchPairing[] | null>(null);
  const [pools, setPools]                 = useState<string[][] | null>(null);
  // Fixed doubles pairs (non-MLP doubles formats). Loaded alongside regs.
  const [doublesPairs, setDoublesPairs]   = useState<{ partner_1_id: string | null; partner_2_id: string | null }[]>([]);
  const [locking, setLocking]             = useState(false);
  const [showLockInConfirm, setShowLockInConfirm] = useState(false);
  const [lockInError, setLockInError]     = useState<string | null>(null);
  const [savedMatches, setSavedMatches]   = useState<any[]>([]);
  const [savedRounds, setSavedRounds]     = useState<any[]>([]);
  const [myMatchesOnly, setMyMatchesOnly] = useState(false);
  const [profileNames, setProfileNames]   = useState<Record<string, string>>({});
  const [profileRatings, setProfileRatings] = useState<Record<string, number>>({});
  const [loading, setLoading]             = useState(true);

  // Bracket release time picker
  const [showReleasePicker, setShowReleasePicker] = useState(false);

  // Partner selection modal
  const [showPartnerModal, setShowPartnerModal] = useState(false);

  // Godmode (Brian Stockman superuser bypass)
  const [godmode, setGodmode] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting]                   = useState(false);
  const [simulating, setSimulating]               = useState(false);
  const [deleteError, setDeleteError]             = useState<string | null>(null);
  const [showPayoutModal, setShowPayoutModal]     = useState(false);
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const [completing, setCompleting]               = useState(false);
  const [completeError, setCompleteError]         = useState<string | null>(null);

  // Edit-tournament modal (admin only)
  const [showEditModal, setShowEditModal]     = useState(false);
  const [editName, setEditName]               = useState('');
  const [editDesc, setEditDesc]               = useState('');
  const [editLocation, setEditLocation]       = useState('');
  const [editMaxPlayers, setEditMaxPlayers]   = useState('');
  const [editStartTime, setEditStartTime]     = useState<Date | null>(null);
  const [editLengthHours, setEditLengthHours] = useState('');
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [savingEdit, setSavingEdit]           = useState(false);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? null;
    setMyUserId(uid);

    const [tRes, regRes, role, godmodeResult] = await Promise.all([
      supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
      supabase.from('tournament_registrations')
        .select('*, profile:profiles!tournament_registrations_user_id_fkey(id, full_name, rating, total_matches_played)')
        .eq('tournament_id', tournamentId)
        .order('role'),
      getTournamentRole(tournamentId),
      checkGodmode(),
    ]);
    setGodmode(godmodeResult);

    const t = tRes.data as Tournament;
    setTournament(t);
    setMyRole(role);

    const regs = (regRes.data ?? []) as TournamentRegistration[];
    setRegistrations(regs);

    // Doubles pair list (only relevant for non-MLP doubles formats — harmless
    // to load for others, returns empty).
    const { data: pairs } = await supabase
      .from('doubles_pairs')
      .select('partner_1_id, partner_2_id')
      .eq('tournament_id', tournamentId);
    setDoublesPairs((pairs ?? []) as any);

    const names: Record<string, string> = {};
    const ratings: Record<string, number> = {};
    regs.forEach(r => {
      if (r.profile) { names[r.user_id] = r.profile.full_name; ratings[r.user_id] = (r.profile as any).rating ?? 3.25; }
    });
    setProfileNames(names);
    setProfileRatings(ratings);

    // Load saved matches + rounds if tournament is active OR completed
    if (t?.status === 'active' || t?.status === 'completed') {
      const [smRes, srRes] = await Promise.all([
        supabase.from('tournament_matches')
          .select('*, round:tournament_rounds(id, label, round_type, round_number)')
          .eq('tournament_id', tournamentId)
          .order('match_order'),
        supabase.from('tournament_rounds')
          .select('*')
          .eq('tournament_id', tournamentId)
          .order('round_number'),
      ]);
      setSavedMatches(smRes.data ?? []);
      setSavedRounds(srRes.data ?? []);
    }

    // Load partner requests if format requires it
    if (requiresPartner(t?.format ?? '', t?.match_type ?? '') && uid) {
      const { data: pr } = await supabase
        .from('tournament_partner_requests')
        .select('*, requesterProfile:profiles!tournament_partner_requests_requester_id_fkey(id, full_name), requestedProfile:profiles!tournament_partner_requests_requested_id_fkey(id, full_name)')
        .eq('tournament_id', tournamentId)
        .or(`requester_id.eq.${uid},requested_id.eq.${uid}`);
      setPartnerRequests((pr ?? []) as PartnerRequest[]);
    }

    setLoading(false);
  }

  // ── Registration ────────────────────────────────────────────
  async function register() {
    const { error } = await supabase.from('tournament_registrations').insert({
      tournament_id: tournamentId, user_id: myUserId,
    });
    if (error) Alert.alert('Error', error.message);
    else load();
  }

  async function approveReg(regId: string) {
    await supabase.from('tournament_registrations').update({ status: 'approved' }).eq('id', regId);
    load();
  }
  async function rejectReg(regId: string) {
    await supabase.from('tournament_registrations').update({ status: 'rejected' }).eq('id', regId);
    load();
  }

  // Invitee responds to a tournament invite (admin-sent). Notifies the inviter.
  async function respondToTournamentInvite(regId: string, accept: boolean) {
    const { error } = await supabase.rpc('tournament_respond_to_invite', {
      p_registration_id: regId,
      p_accept: accept,
    });
    if (error) {
      Alert.alert(accept ? 'Accept failed' : 'Decline failed', error.message);
      return;
    }
    load();
  }

  // ── Bracket release time ────────────────────────────────────
  // ── Godmode simulate (Brian only) — fills pending matches randomly ──
  async function simulateFillMatches() {
    if (!tournament) return;
    setSimulating(true);
    const { data, error } = await supabase.rpc('godmode_simulate_fill_matches', {
      p_tournament_id: tournament.id,
    });
    setSimulating(false);
    if (error) {
      Alert.alert('Simulate failed', error.message);
      return;
    }
    Alert.alert('Filled!', `${data} pending match${data === 1 ? '' : 'es'} got random scores. Reloading…`);
    load();
  }

  // ── Godmode tournament-setup shortcuts (Brian only) ─────────
  async function godmodeApproveAllInvitees() {
    if (!tournament) return;
    const { data, error } = await supabase.rpc('godmode_approve_all_invitees', {
      p_tournament_id: tournament.id,
    });
    if (error) { Alert.alert('Error', error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    Alert.alert('Done', row?.message ?? 'Approved.');
    load();
  }

  async function godmodeForceCreateTeams() {
    if (!tournament) return;
    // mlp_random → snake-draft RPC; mlp → fixed-team filler; otherwise →
    // generic doubles auto-pairer.
    const rpcName =
      tournament.format === 'mlp_random' ? 'generate_random_mlp_teams' :
      tournament.format === 'mlp'        ? 'godmode_force_fill_mlp_teams' :
                                           'godmode_auto_pair_doubles_for_tournament';
    const params: Record<string, unknown> = { p_tournament_id: tournament.id };
    if (tournament.format === 'mlp_random') params.p_mode = 'snake';
    const { data, error } = await supabase.rpc(rpcName, params);
    if (error) { Alert.alert('Error', error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    Alert.alert('Done', row?.message ?? (typeof row === 'string' ? row : 'Teams created.'));
    load();
  }

  async function godmodeAutoGenerateAndLock() {
    if (!tournament) return;
    try {
      // MLP formats need the server-side generate_mlp_bracket RPC because each
      // round expands into 4 sub-matches (Men's / Women's / Mixed 1 / Mixed 2)
      // that the local generateBracket() pure helpers don't produce. Non-MLP
      // formats go through the standard generate-then-lock flow.
      if (tournament.format === 'mlp' || tournament.format === 'mlp_random') {
        const { error } = await supabase.rpc('generate_mlp_bracket', {
          p_tournament_id: tournament.id,
        });
        if (error) {
          Alert.alert('Auto-setup failed', `Could not generate MLP bracket: ${error.message}`);
          return;
        }
        Alert.alert('Auto-setup complete', '✓ Generated MLP bracket');
        load();
        return;
      }

      // generateBracket() alerts on its own validation failures and returns
      // null; otherwise it returns the matches synchronously so we can pass
      // them straight into doLockIn() without waiting on a React state flush.
      const matches = await generateBracket();
      if (!matches || matches.length === 0) return;
      await doLockIn(matches);
    } catch (e: any) {
      Alert.alert('Auto-lock failed', e?.message ?? String(e));
    }
  }

  // ── Godmode delete (Brian only) ────────────────────────────
  function deleteTournament() {
    if (!tournament) return;
    setDeleteError(null);
    setShowDeleteConfirm(true);
  }

  async function confirmDeleteTournament() {
    if (!tournament) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      // Try the SECURITY DEFINER RPC first (bypasses RLS entirely). Falls
      // back to a direct DELETE if the RPC hasn't been deployed yet.
      const rpcRes = await supabase.rpc('godmode_delete_tournament', {
        p_tournament_id: tournament.id,
      });
      console.warn('[delete tournament rpc]', rpcRes);

      if (rpcRes.error) {
        const msg = rpcRes.error.message ?? '';
        const looksMissing =
          /function .* does not exist|Could not find the function|404|PGRST202/i.test(msg);
        if (!looksMissing) {
          setDeleteError(msg || 'Delete failed.');
          return;
        }
        // RPC missing — fall back to direct delete via RLS policy.
        const fallback = await supabase
          .from('tournaments')
          .delete()
          .eq('id', tournament.id)
          .select();
        console.warn('[delete tournament fallback]', fallback);
        if (fallback.error) {
          setDeleteError(fallback.error.message ?? 'Delete failed.');
          return;
        }
        if (!fallback.data || fallback.data.length === 0) {
          setDeleteError(
            'No rows were deleted. Run supabase/migration_add_godmode_delete_rpc.sql ' +
            '(or migration_add_godmode_delete.sql) in Supabase SQL Editor.'
          );
          return;
        }
      }

      setShowDeleteConfirm(false);
      navigation.goBack();
    } catch (e: any) {
      console.warn('[delete tournament] exception', e);
      setDeleteError(e?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  }

  // ── Complete tournament (admin) ────────────────────────────
  async function confirmCompleteTournament() {
    if (!tournament) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      const { error } = await supabase.rpc('admin_complete_tournament', {
        p_tournament_id: tournament.id,
      });
      if (error) {
        setCompleteError(error.message ?? 'Complete failed.');
        return;
      }
      setShowCompleteConfirm(false);
      load();
    } catch (e: any) {
      setCompleteError(e?.message ?? String(e));
    } finally {
      setCompleting(false);
    }
  }

  // ── Edit tournament (admin) ────────────────────────────────
  function openEditModal() {
    if (!tournament) return;
    setEditName(tournament.name);
    setEditDesc(tournament.description ?? '');
    setEditLocation(tournament.location_name ?? '');
    setEditMaxPlayers(tournament.max_players != null ? String(tournament.max_players) : '');
    setEditStartTime(tournament.start_time ? new Date(tournament.start_time) : null);
    setEditLengthHours(tournament.expected_length_hours != null ? String(tournament.expected_length_hours) : '');
    setShowEditModal(true);
  }

  async function saveTournamentEdits() {
    if (!tournament) return;
    const name = editName.trim();
    if (!name) { Alert.alert('', 'Tournament name is required.'); return; }
    const maxPlayersN = editMaxPlayers.trim() ? parseInt(editMaxPlayers.trim(), 10) : null;
    if (editMaxPlayers.trim() && (Number.isNaN(maxPlayersN!) || maxPlayersN! < 2)) {
      Alert.alert('', 'Max players must be a number ≥ 2.'); return;
    }
    let lengthN: number | null = null;
    if (editLengthHours.trim()) {
      lengthN = parseFloat(editLengthHours.trim());
      if (Number.isNaN(lengthN) || lengthN < 0.5 || lengthN > 168) {
        Alert.alert('', 'Expected length must be between 0.5 and 168 hours.'); return;
      }
    }

    setSavingEdit(true);
    const { error } = await supabase.from('tournaments').update({
      name,
      description:           editDesc.trim() || null,
      location_name:         editLocation.trim() || null,
      max_players:           maxPlayersN,
      start_time:            editStartTime ? editStartTime.toISOString() : null,
      expected_length_hours: lengthN,
    }).eq('id', tournament.id);
    setSavingEdit(false);

    if (error) { Alert.alert('Error', error.message); return; }
    setShowEditModal(false);
    load();
  }

  async function saveBracketReleaseTime(date: Date) {
    setShowReleasePicker(false);
    await supabase.from('tournaments').update({ bracket_release_time: date.toISOString() }).eq('id', tournamentId);
    load();
  }

  // ── Bracket generation (admin only) ────────────────────────
  // Returns the generated MatchPairing[] (also written to state) so callers
  // that need to chain into doLockIn() can pass them directly instead of
  // waiting for a React state flush.
  async function generateBracket(): Promise<MatchPairing[] | null> {
    if (!tournament) return null;
    const approved = registrations.filter(r => r.status === 'approved').map(r => r.user_id);
    if (approved.length < 2) { Alert.alert('Need at least 2 approved players.'); return null; }

    // Wrap throws from the pure generators so an unexpected violation surfaces
    // as a user-facing alert instead of a silent crash.
    function bailFromError(label: string, e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert(`Couldn't generate ${label}`, msg);
    }

    function commit(matches: MatchPairing[]): MatchPairing[] {
      setGeneratedMatches(matches);
      return matches;
    }

    // ── MLP (Fixed Teams / Random Teams) ──
    // Validate that every mlp_teams row has all four slots filled before
    // attempting to generate a schedule. mlp_random tournaments still write
    // to mlp_teams once Generate Random Teams has been clicked, so the same
    // check applies.
    if (tournament.format === 'mlp' || tournament.format === 'mlp_random') {
      const { data: mlpRows, error: mlpErr } = await supabase
        .from('mlp_teams')
        .select('id, name, male_1_id, male_2_id, female_1_id, female_2_id')
        .eq('tournament_id', tournament.id);
      if (mlpErr) { Alert.alert('Could not load MLP teams', mlpErr.message); return null; }
      const teamRows = (mlpRows ?? []) as MlpTeamShape[];
      const teamError = validateMlpTeams(teamRows);
      if (teamError) { Alert.alert('MLP teams incomplete', teamError.message); return null; }

      // Build [string, string][] pairs from the validated teams for the
      // existing schedule generator (it treats each team as a 2-token pair).
      // We pass [male_1, male_2] as the token pair and rely on the live MLP
      // backend tables (mlp_team_standings, etc.) to track the actual 4-player
      // roster. The preview here is just round-by-round team matchups.
      const teams: [string, string][] = teamRows
        .map(t => [t.male_1_id!, t.male_2_id!] as [string, string]);

      try { return commit(generateMLPSchedule(teams)); }
      catch (e) { bailFromError('MLP bracket', e); return null; }
    }

    // ── Doubles tournaments with fixed pairs (round-robin / elim / pool play) ──
    const usesFixedPairs = tournament.match_type === 'doubles'
      && tournament.format !== 'rotating_partners';

    if (usesFixedPairs) {
      const approvedSet = new Set(approved);
      const teams: [string, string][] = [];
      const paired = new Set<string>();
      for (const p of doublesPairs) {
        if (p.partner_1_id && p.partner_2_id
            && approvedSet.has(p.partner_1_id) && approvedSet.has(p.partner_2_id)) {
          teams.push([p.partner_1_id, p.partner_2_id]);
          paired.add(p.partner_1_id);
          paired.add(p.partner_2_id);
        }
      }
      // Random-pair the leftovers (preview only — does NOT persist to DB).
      const leftovers = approved.filter(uid => !paired.has(uid));
      for (let i = leftovers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [leftovers[i], leftovers[j]] = [leftovers[j], leftovers[i]];
      }
      for (let i = 0; i + 1 < leftovers.length; i += 2) {
        teams.push([leftovers[i], leftovers[i + 1]]);
      }
      if (teams.length < 2) {
        Alert.alert('Not enough teams', 'Need at least 2 doubles pairs to generate a bracket.');
        return null;
      }
      // Validate every team has two distinct partners and no player is on
      // multiple teams.
      const teamErr = validateDoublesTeams(teams);
      if (teamErr) { Alert.alert('Doubles teams invalid', teamErr.message); return null; }

      const seededTeams = seedTeams(teams, profileRatings, tournament.seeding);

      try {
        switch (tournament.format) {
          case 'round_robin':
            return commit(generateDoublesRoundRobin(seededTeams));
          case 'single_elimination':
            return commit(generateDoublesSingleElim(seededTeams));
          case 'double_elimination':
            return commit(generateDoublesDoubleElim(seededTeams));
          case 'pool_play': {
            const { pools: p, matches: m } = generateDoublesPoolPlay(seededTeams, tournament.pool_count);
            const poolErr = validatePools(p, tournament.pool_count, m);
            if (poolErr) { Alert.alert('Pool setup invalid', poolErr.message); return null; }
            setPools(p.map(pool => pool.flat()));
            return commit(m);
          }
        }
      } catch (e) { bailFromError('doubles bracket', e); }
      return null;
    }

    // ── Singles + Rotating-partners: existing per-player logic ──
    const seeded = seedPlayers(approved, profileRatings, tournament.seeding);

    try {
      switch (tournament.format) {
        case 'round_robin':
          return commit(generateRoundRobin(seeded));
        case 'single_elimination':
          return commit(generateSingleElim(seeded));
        case 'double_elimination':
          return commit(generateDoubleElim(seeded));
        case 'pool_play': {
          const { pools: p, matches: m } = generatePoolPlay(seeded, tournament.pool_count);
          const poolErr = validatePools(p, tournament.pool_count, m);
          if (poolErr) { Alert.alert('Pool setup invalid', poolErr.message); return null; }
          setPools(p);
          return commit(m);
        }
        case 'rotating_partners':
          return commit(generateRotatingPartners(seeded, Math.ceil(seeded.length / 4) * 3));
      }
    } catch (e) { bailFromError('bracket', e); }
    return null;
  }

  // ── Lock in bracket + notify ────────────────────────────────
  // Alert.alert with multiple buttons collapses to a single OK on web, which
  // killed this flow. Use a Modal instead — same pattern as Disband Team,
  // Delete Tournament confirm, etc.
  function lockInBracket() {
    if (!generatedMatches || !tournament) return;
    setLockInError(null);
    setShowLockInConfirm(true);
  }

  async function doLockIn(matchesArg?: MatchPairing[]) {
    // matchesArg lets callers (e.g. the godmode setup shortcut) pass freshly
    // generated matches directly, bypassing React state-flush timing.
    const matches = matchesArg ?? generatedMatches;
    if (!matches || !tournament) return;
    setLocking(true);

    try {
      // 0. Persist any novel doubles pairs used in the bracket preview.
      //    Non-MLP doubles tournaments may have included random pairings of
      //    previously-unpaired approved players — those rows weren't written
      //    to doubles_pairs yet. Insert them now so the pair section UI
      //    reflects every team that actually got locked in.
      const usesFixedPairs = tournament.match_type === 'doubles'
        && tournament.format !== 'mlp'
        && tournament.format !== 'mlp_random'
        && tournament.format !== 'rotating_partners';

      if (usesFixedPairs) {
        const alreadyPaired = new Set<string>();
        for (const p of doublesPairs) {
          if (p.partner_1_id) alreadyPaired.add(p.partner_1_id);
          if (p.partner_2_id) alreadyPaired.add(p.partner_2_id);
        }
        // Collect distinct teams from the generated matches.
        const novelPairs: { p1: string; p2: string }[] = [];
        const seenKey = new Set<string>();
        for (const m of matches) {
          for (const team of [m.team1, m.team2]) {
            const [a, b] = team;
            if (!a || !b || a === 'BYE' || b === 'BYE') continue;
            if (alreadyPaired.has(a) || alreadyPaired.has(b)) continue;
            const key = [a, b].sort().join('|');
            if (seenKey.has(key)) continue;
            seenKey.add(key);
            novelPairs.push({ p1: a, p2: b });
          }
        }
        if (novelPairs.length > 0) {
          const { error: pairErr } = await supabase.rpc('persist_random_doubles_pairs', {
            p_tournament_id: tournament.id,
            p_pairs: novelPairs,
          });
          if (pairErr) {
            // Non-fatal — bracket lock-in can still proceed.
            // eslint-disable-next-line no-console
            console.warn('[lock-in] failed to persist novel doubles pairs', pairErr);
          }
        }
      }

      // 1. Create a round record
      const roundType = tournament.format === 'pool_play' ? 'pool' : 'winners';
      const { data: round, error: rErr } = await supabase
        .from('tournament_rounds')
        .insert({
          tournament_id: tournament.id,
          round_number: 1,
          label: FORMAT_META[tournament.format].label + ' Schedule',
          round_type: roundType,
        })
        .select().single();
      if (rErr) throw new Error('Could not create round: ' + rErr.message);

      // 2. Save all matches — rotating_partners is always doubles regardless of setting
      const isRotating = tournament.format === 'rotating_partners' || tournament.format === 'mlp';
      const matchRows = matches.map((m, i) => ({
        tournament_id: tournament.id,
        round_id:      round.id,
        match_order:   i,
        match_type:    isRotating ? 'doubles' : tournament.match_type,
        team1_player1: m.team1[0] !== 'BYE' ? m.team1[0] : null,
        team1_player2: m.team1[1] && m.team1[1] !== 'BYE' ? m.team1[1] : null,
        team2_player1: m.team2[0] !== 'BYE' ? m.team2[0] : null,
        team2_player2: m.team2[1] && m.team2[1] !== 'BYE' ? m.team2[1] : null,
      }));

      // Insert in batches of 20 to avoid request size issues
      for (let i = 0; i < matchRows.length; i += 20) {
        const { error: mErr } = await supabase.from('tournament_matches').insert(matchRows.slice(i, i + 20));
        if (mErr) throw new Error('Could not save matches: ' + mErr.message);
      }

      // 3. Update tournament status
      const { error: sErr } = await supabase.from('tournaments').update({ status: 'active' }).eq('id', tournament.id);
      if (sErr) throw new Error('Could not update status: ' + sErr.message);

      // 4. Notify each member individually to avoid RLS batch-check timeouts
      const approvedRegs = registrations.filter(r => r.status === 'approved');
      const memberIds = approvedRegs.map(r => r.user_id);
      let notifsFailed = 0;
      for (const uid of memberIds) {
        const { error: nErr } = await supabase.from('notifications').insert({
          user_id:     uid,
          title:       `🏆 Bracket Set — ${tournament.name}`,
          body:        `The draw has been finalized! ${matches.length} matches scheduled. Open the tournament to see your matches.`,
          type:        'tournament',
          entity_id:   tournament.id,
          entity_type: 'tournament',
        });
        if (nErr) notifsFailed++;
      }

      setGeneratedMatches(null);
      setPools(null);
      setShowLockInConfirm(false);
      load();

      const notified = memberIds.length - notifsFailed;
      Alert.alert(
        '✓ Bracket locked!',
        `Schedule saved — ${notified}/${memberIds.length} members notified.` +
          (notifsFailed > 0 ? ` (${notifsFailed} notifications failed)` : '')
      );
    } catch (err: any) {
      setLockInError(err?.message ?? 'Unknown error. Please try again.');
    } finally {
      setLocking(false);
    }
  }

  // ── Partner requests ────────────────────────────────────────
  async function sendPartnerRequest(targetId: string) {
    setShowPartnerModal(false);
    const { error } = await supabase.from('tournament_partner_requests').upsert({
      tournament_id: tournamentId, requester_id: myUserId!, requested_id: targetId, status: 'pending',
    });
    if (error) Alert.alert('Error', error.message);
    else { Alert.alert('Request sent!', 'They\'ll be notified to accept or decline.'); load(); }
  }

  async function respondToPartnerRequest(reqId: string, accept: boolean) {
    await supabase.from('tournament_partner_requests')
      .update({ status: accept ? 'accepted' : 'rejected' }).eq('id', reqId);
    load();
  }

  async function cancelPartnerRequest(reqId: string) {
    await supabase.from('tournament_partner_requests').delete().eq('id', reqId);
    load();
  }

  // ── Helpers ─────────────────────────────────────────────────
  function playerName(id: string | undefined): string {
    if (!id || id === 'BYE') return 'BYE';
    return profileNames[id] ?? '…';
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={c.primary} />;
  if (!tournament) return <Text style={S.empty}>Tournament not found.</Text>;

  const fmt        = FORMAT_META[tournament.format];
  const approved   = registrations.filter(r => r.status === 'approved');
  const pending    = registrations.filter(r => r.status === 'pending');
  // Pending registrations split: admin-invited (waiting on invitee) vs self-submitted requests.
  const pendingInvited  = pending.filter(r => r.invited_by != null);
  const pendingRequests = pending.filter(r => r.invited_by == null);
  // Public "Players" list: approved members + outstanding invites (the people the
  // tournament is actively trying to fill its roster with). Join-requests stay
  // admin-only since admins haven't decided on them yet.
  const rosterShown = [...approved, ...pendingInvited];
  const myReg      = registrations.find(r => r.user_id === myUserId);
  const isPriv     = isTournamentPrivileged(myRole);
  const isAdmin    = myRole === 'admin';
  const canRegister = !myReg && tournament.status === 'registration'
                       && tournament.registration_mode === 'request';
  const bracketLabel = bracketReleaseLabel(tournament.bracket_release_time);

  // Partner state for current user
  const myPartnerReqSent     = partnerRequests.find(r => r.requester_id === myUserId && r.status === 'pending');
  const myPartnerReqReceived = partnerRequests.find(r => r.requested_id === myUserId && r.status === 'pending');
  const myConfirmedPartner   = partnerRequests.find(r =>
    (r.requester_id === myUserId || r.requested_id === myUserId) && r.status === 'accepted'
  );
  const myPartnerUserId = myConfirmedPartner
    ? (myConfirmedPartner.requester_id === myUserId ? myConfirmedPartner.requested_id : myConfirmedPartner.requester_id)
    : null;

  // Available partners = approved members without a confirmed partner and not myself
  const takenPartnerIds = new Set(
    partnerRequests.filter(r => r.status === 'accepted').flatMap(r => [r.requester_id, r.requested_id])
  );
  const availablePartners = approved.filter(r =>
    r.user_id !== myUserId && !takenPartnerIds.has(r.user_id)
  );

  return (
    <>
      <ScrollView style={S.container} contentContainerStyle={{ paddingBottom: 48 }}>

        {/* ── Header ── */}
        <View style={S.headerCard}>
          <View style={S.headerTop}>
            <Text style={S.fmtIcon}>{fmt.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={S.fmtLabel}>{fmt.label}</Text>
              <Text style={S.fmtDesc}>{fmt.description}</Text>
            </View>
            {myRole && (
              <View style={[S.myRoleBadge, { backgroundColor: tournamentRoleBadgeColor(myRole) + '22', borderColor: tournamentRoleBadgeColor(myRole) + '55' }]}>
                <Text style={[S.myRoleText, { color: tournamentRoleBadgeColor(myRole) }]}>
                  {tournamentRoleLabel(myRole)}
                </Text>
              </View>
            )}
          </View>

          {/* Settings chips */}
          <View style={S.chipsRow}>
            <Text style={S.chip}>{tournament.match_type === 'doubles' ? 'Doubles' : 'Singles'}</Text>
            <Text style={S.chip}>{tournament.seeding === 'elo' ? '📊 PLUPR seeded' : '🎲 Random'}</Text>
            {tournament.format === 'pool_play' && <Text style={S.chip}>{tournament.pool_count} pools</Text>}
            {tournament.partner_rotation && <Text style={S.chip}>Rotate {tournament.partner_rotation.replace('_', ' ')}</Text>}
            <Text style={S.chip}>{tournament.registration_mode === 'invite_only' ? '🔒 Invite only' : '📝 Requests'}</Text>
          </View>

          {tournament.start_time && (
            <Text style={S.metaLine}>📅 {new Date(tournament.start_time).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
          )}
          {tournament.expected_length_hours != null && (
            <Text style={S.metaLine}>⏱️ ~{tournament.expected_length_hours}h expected</Text>
          )}
          {tournament.location_name && <Text style={S.metaLine}>📍 {tournament.location_name}</Text>}
          {tournament.description && <Text style={S.desc}>{tournament.description}</Text>}
        </View>

        {/* ── Quick action row ── */}
        <View style={S.quickActionsRow}>
          <TouchableOpacity
            style={S.quickActionBtn}
            onPress={() => navigation.navigate('TournamentInfo', { tournamentId, tournamentName: tournament.name })}
            activeOpacity={0.7}
          >
            <Text style={S.quickActionText}>ℹ️ How this works</Text>
          </TouchableOpacity>
          {isAdmin && (godmode || (tournament.status !== 'completed' && tournament.status !== 'cancelled')) && (
            <TouchableOpacity
              style={[S.quickActionBtn, S.quickActionBtnPrimary]}
              onPress={openEditModal}
              activeOpacity={0.7}
            >
              <Text style={[S.quickActionText, S.quickActionTextPrimary]}>Edit Tournament</Text>
            </TouchableOpacity>
          )}
          {isPriv && tournament.status === 'registration' && (
            <TouchableOpacity
              style={[S.quickActionBtn, S.quickActionBtnPrimary]}
              onPress={() => navigation.navigate('TournamentInvitePlayers', { tournamentId, tournamentName: tournament.name })}
              activeOpacity={0.7}
            >
              <Text style={[S.quickActionText, S.quickActionTextPrimary]}>+ Invite Players</Text>
            </TouchableOpacity>
          )}
          {isPriv && tournament.status === 'registration' && (
            <TouchableOpacity
              style={[S.quickActionBtn, S.quickActionBtnPrimary]}
              onPress={() => navigation.navigate('TournamentInvite', { tournamentId, tournamentName: tournament.name })}
              activeOpacity={0.7}
            >
              <Text style={[S.quickActionText, S.quickActionTextPrimary]}>✉️ Invite via Code</Text>
            </TouchableOpacity>
          )}
        </View>
        {(tournament.status === 'completed' || tournament.status === 'cancelled') && (
          <View style={S.closedBanner}>
            <Text style={S.closedBannerText}>
              🔒 This tournament is {tournament.status === 'completed' ? 'ended' : 'cancelled'} — edits are locked.
            </Text>
          </View>
        )}

        {/* ── Match History (active or completed tournaments) ── */}
        {(tournament.status === 'active' || tournament.status === 'completed') && (
          <TouchableOpacity
            style={S.historyBtn}
            onPress={() => navigation.navigate('TournamentMatchHistory', {
              tournamentId,
              title: `${tournament.name} History`,
            })}
            activeOpacity={0.85}
          >
            <Text style={S.historyBtnText}>📜  Match History</Text>
            <Text style={S.historyBtnSub}>All scheduled and completed matches</Text>
          </TouchableOpacity>
        )}

        {/* ── Pickle pot ── */}
        <PicklePotCard
          scopeType="tournament"
          scopeId={tournamentId}
          scopeLabel="Tournament"
          pool={tournament.prize_pool ?? 0}
          ante={tournament.pickle_ante ?? 0}
          structure={tournament.payout_structure ?? [60, 25, 15]}
          isAdmin={isPriv}
          canDistribute={tournament.status === 'completed'}
          members={approved.map(r => ({
            id: r.user_id,
            full_name: r.profile?.full_name ?? 'Unknown',
          }))}
          onChange={() => load()}
        />

        {/* ── MLP teams (Fixed or Random) ── */}
        {(tournament.format === 'mlp' || tournament.format === 'mlp_random') && (
          <View style={S.mlpCard}>
            <MlpTeamSection
              tournamentId={tournamentId}
              format={tournament.format}
              mlpPlayFormat={tournament.mlp_play_format}
              tournamentStatus={tournament.status}
              isPriv={isPriv}
              currentUserId={myUserId}
              approvedRegistrations={registrations.filter(r => r.status === 'approved')}
              bracketAlreadyGenerated={savedMatches.length > 0}
              onTeamsChanged={() => load()}
            />
            {(tournament.mlp_play_format === 'round_robin_playoff' || tournament.mlp_play_format === 'pool_play_playoff') && (
              <MlpPlayoffPreview
                tournamentId={tournamentId}
                tournamentName={tournament.name}
                leagueId={tournament.league_id ?? ''}
                mlpPlayFormat={tournament.mlp_play_format}
                poolCount={tournament.mlp_pool_count ?? 2}
                playoffTeams={tournament.mlp_playoff_teams ?? 4}
                isAdmin={isPriv}
              />
            )}
            {/* Auto-payout: shown when MLP playoff tournament is completed,
                pool > 0, payout not yet applied, viewer is admin. */}
            {isPriv
              && tournament.status === 'completed'
              && (tournament.mlp_play_format === 'round_robin_playoff' || tournament.mlp_play_format === 'pool_play_playoff')
              && (tournament.prize_pool ?? 0) > 0
              && !tournament.champion_payout_applied_at && (
              <TouchableOpacity
                style={S.payoutBtn}
                onPress={() => setShowPayoutModal(true)}
                activeOpacity={0.85}
              >
                <Text style={S.payoutBtnText}>🏆 Pay Out Prizes</Text>
                <Text style={S.payoutBtnSub}>
                  Splits 🥒 {tournament.prize_pool} among bracket finishers · stamps badges · applies PLUPR bonus
                </Text>
              </TouchableOpacity>
            )}
            {isPriv && tournament.champion_payout_applied_at && (
              <View style={S.payoutDoneBanner}>
                <Text style={S.payoutDoneText}>✓ Prizes paid out on {new Date(tournament.champion_payout_applied_at).toLocaleDateString()}</Text>
              </View>
            )}
          </View>
        )}

        {/* ── Admin: complete tournament ── */}
        {isPriv && tournament.status === 'active' && (
          <TouchableOpacity
            style={S.payoutBtn}
            onPress={() => setShowCompleteConfirm(true)}
            activeOpacity={0.85}
          >
            <Text style={S.payoutBtnText}>🏁 Complete Tournament</Text>
            <Text style={S.payoutBtnSub}>
              Flips status to completed · stops further match recording · unlocks payout
            </Text>
          </TouchableOpacity>
        )}

        {/* ── Member: bracket release countdown ── */}
        {myReg?.status === 'approved' && !generatedMatches && (
          <View style={S.infoBox}>
            {bracketLabel ? (
              <>
                <Text style={S.infoIcon}>⏰</Text>
                <Text style={S.infoText}>{bracketLabel}</Text>
              </>
            ) : (
              <>
                <Text style={S.infoIcon}>🗓️</Text>
                <Text style={S.infoText}>Bracket release date hasn't been set yet. Check back soon!</Text>
              </>
            )}
          </View>
        )}

        {/* ── Admin: set bracket release time ── */}
        {isPriv && !generatedMatches && (
          <TouchableOpacity style={S.setReleaseBtn} onPress={() => setShowReleasePicker(true)}>
            <Text style={S.setReleaseBtnText}>
              {tournament.bracket_release_time
                ? `⏰ Bracket release: ${new Date(tournament.bracket_release_time).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}  (tap to change)`
                : '⏰ Set expected bracket release time'}
            </Text>
          </TouchableOpacity>
        )}

        {/* ── Registration ── */}
        {canRegister && (
          <TouchableOpacity style={S.registerBtn} onPress={register}>
            <Text style={S.registerBtnText}>📝 Request to Join</Text>
          </TouchableOpacity>
        )}
        {tournament.registration_mode === 'invite_only' && !myReg && (
          <View style={S.inviteNote}>
            <Text style={S.inviteNoteText}>🔒 This tournament is invite only. Contact an organizer to be added.</Text>
          </View>
        )}
        {myReg && myReg.status === 'pending' && myReg.invited_by ? (
          <View style={[S.myRegBadge, S.regPending]}>
            <Text style={S.myRegText}>
              📨 {playerName(myReg.invited_by)} invited you to this tournament.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
              <TouchableOpacity
                style={{ flex: 1, backgroundColor: c.primary, paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                onPress={() => respondToTournamentInvite(myReg.id, true)}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Accept invite</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, backgroundColor: '#fff', borderWidth: 1.5, borderColor: c.border, paddingVertical: 10, borderRadius: 8, alignItems: 'center' }}
                onPress={() => respondToTournamentInvite(myReg.id, false)}
              >
                <Text style={{ color: c.textSub, fontWeight: '700' }}>Decline</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : myReg && (
          <View style={[S.myRegBadge,
            myReg.status === 'approved' ? S.regApproved :
            myReg.status === 'rejected' ? S.regRejected : S.regPending]}>
            <Text style={S.myRegText}>
              {myReg.status === 'approved' ? '✓ You\'re in the tournament!'
               : myReg.status === 'rejected' ? '✗ Request not approved'
               : '⏳ Registration pending — an admin will review your request shortly.'}
            </Text>
          </View>
        )}

        {/* ── Doubles partner pair (non-MLP doubles formats) ── */}
        {requiresPartner(tournament.format, tournament.match_type) && (
          <View style={S.section}>
            <DoublesPairSection
              tournamentId={tournamentId}
              tournamentStatus={tournament.status}
              isPriv={isPriv}
              currentUserId={myUserId}
              approvedRegistrations={registrations.filter(r => r.status === 'approved')}
              onPairsChanged={() => load()}
            />
          </View>
        )}

        {/* ── Players (approved + outstanding invites) ── */}
        <View style={S.section}>
          <View style={S.sectionHeaderRow}>
            <Text style={S.sectionTitle}>
              Players ({rosterShown.length}{tournament.max_players ? `/${tournament.max_players}` : ''})
            </Text>
            {isPriv && (
              <TouchableOpacity onPress={() => navigation.navigate('TournamentMembers', { tournamentId, tournamentName: tournament.name })}>
                <Text style={S.manageLinkText}>Manage Roles →</Text>
              </TouchableOpacity>
            )}
          </View>
          {rosterShown.map((r, i) => {
            const role = r.role as TournamentRole;
            const bc = tournamentRoleBadgeColor(role);
            const isInvitePending = r.status === 'pending';
            return (
              <View key={r.id} style={S.playerRow}>
                <Text style={S.playerSeed}>#{i + 1}</Text>
                <Text style={[S.playerName, isInvitePending && { color: c.textMuted, fontStyle: 'italic' }]}>
                  {r.profile?.full_name ?? '—'}
                </Text>
                <Text style={S.playerRating}>{formatPlupr((r.profile as any)?.rating, (r.profile as any)?.total_matches_played)}</Text>
                {isInvitePending ? (
                  <View style={[S.rolePill, { backgroundColor: '#fff3cd', borderColor: '#d4a72c' }]}>
                    <Text style={[S.rolePillText, { color: '#8a6d00' }]}>📨 invited</Text>
                  </View>
                ) : role !== 'member' && (
                  <View style={[S.rolePill, { backgroundColor: bc + '22', borderColor: bc }]}>
                    <Text style={[S.rolePillText, { color: bc }]}>{tournamentRoleLabel(role)}</Text>
                  </View>
                )}
              </View>
            );
          })}
          {rosterShown.length === 0 && <Text style={S.emptySection}>No players yet.</Text>}
        </View>

        {/* ── Pending join requests (admin/co-admin only) ── */}
        {isPriv && pendingRequests.length > 0 && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>Pending Requests ({pendingRequests.length})</Text>
            {pendingRequests.map(r => (
              <View key={r.id} style={S.pendingRow}>
                <Text style={S.playerName} numberOfLines={1}>{r.profile?.full_name ?? '—'}</Text>
                <Text style={S.playerRating}>{formatPlupr((r.profile as any)?.rating, (r.profile as any)?.total_matches_played)} PLUPR</Text>
                <View style={S.pendingActions}>
                  <TouchableOpacity style={S.approveBtn} onPress={() => approveReg(r.id)}>
                    <Text style={S.approveBtnText}>✓</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.rejectBtn} onPress={() => rejectReg(r.id)}>
                    <Text style={S.rejectBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ── Generate / Lock bracket ── */}
        {tournament.status === 'registration' && isAdmin && approved.length >= 2 && (
          <>
            <TouchableOpacity style={S.generateBtn} onPress={generateBracket}>
              <Text style={S.generateBtnText}>⚡ {generatedMatches ? 'Re-generate Preview' : `Generate ${fmt.label} Schedule`}</Text>
            </TouchableOpacity>
            {generatedMatches && (
              <TouchableOpacity
                style={[S.lockBtn, locking && S.lockBtnDisabled]}
                onPress={lockInBracket}
                disabled={locking}
              >
                <Text style={S.lockBtnText}>
                  {locking ? 'Locking in…' : `🔒 Lock In & Notify ${approved.length} Members`}
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
        {tournament.status === 'active' && (
          <View style={S.activeBanner}>
            <Text style={S.activeBannerText}>✓ Bracket finalized — all members notified</Text>
          </View>
        )}
        {tournament.status === 'completed' && (
          <View style={S.completedBanner}>
            <Text style={S.completedBannerText}>🏁 Tournament Complete</Text>
          </View>
        )}
        {!isAdmin && isPriv && tournament.status === 'registration' && (
          <View style={S.coAdminNote}>
            <Text style={S.coAdminNoteText}>Only the tournament admin can generate the bracket.</Text>
          </View>
        )}

        {/* ── Pools ── */}
        {pools && (
          <View style={S.section}>
            <Text style={S.sectionTitle}>Pool Assignments ({tournament.seeding === 'elo' ? 'PLUPR snake-draft' : 'random'})</Text>
            {pools.map((pool, pi) => (
              <View key={pi} style={S.poolCard}>
                <Text style={S.poolLabel}>Pool {String.fromCharCode(65 + pi)}</Text>
                {pool.map(uid => <Text key={uid} style={S.poolPlayer}>• {playerName(uid)}</Text>)}
              </View>
            ))}
          </View>
        )}

        {/* ── Pool-play bracket view ── */}
        {(tournament.status === 'active' || tournament.status === 'completed') && tournament.format === 'pool_play' && savedRounds.length > 0 && (() => {
          const poolRounds = savedRounds.filter((r: any) => r.round_type === 'pool');
          if (poolRounds.length === 0) return null;

          type Stat = {
            key: string; name: string; isMe: boolean;
            wins: number; losses: number; pf: number; pa: number;
          };

          function teamKey(p1: string, p2: string | null) { return p1 + '|' + (p2 ?? ''); }
          function teamDisplayName(p1: string | null, p2: string | null): string {
            if (!p1) return '?';
            const n1 = profileNames[p1] ?? '?';
            const n2 = p2 ? (profileNames[p2] ?? '?') : null;
            return n2 ? `${n1} & ${n2}` : n1;
          }

          function computeStandings(round: any): Stat[] {
            const stats = new Map<string, Stat>();
            const ensure = (p1: string | null, p2: string | null): Stat | null => {
              if (!p1) return null;
              const key = teamKey(p1, p2);
              if (!stats.has(key)) {
                stats.set(key, {
                  key, name: teamDisplayName(p1, p2),
                  isMe: p1 === myUserId || p2 === myUserId,
                  wins: 0, losses: 0, pf: 0, pa: 0,
                });
              }
              return stats.get(key)!;
            };

            for (const m of savedMatches.filter((m: any) => m.round?.id === round.id)) {
              const t1 = ensure(m.team1_player1, m.team1_player2);
              const t2 = ensure(m.team2_player1, m.team2_player2);
              if (!t1 || !t2) continue;
              if (m.status === 'completed' && m.winner_team) {
                t1.pf += m.team1_score ?? 0; t1.pa += m.team2_score ?? 0;
                t2.pf += m.team2_score ?? 0; t2.pa += m.team1_score ?? 0;
                if (m.winner_team === 'team1') { t1.wins++; t2.losses++; }
                else                            { t2.wins++; t1.losses++; }
              }
            }

            return Array.from(stats.values()).sort((a, b) => {
              if (a.wins !== b.wins) return b.wins - a.wins;
              return (b.pf - b.pa) - (a.pf - a.pa);
            });
          }

          // Compute standings for the first 2 pools (bracket assumes A & B)
          const standA = poolRounds[0] ? computeStandings(poolRounds[0]) : [];
          const standB = poolRounds[1] ? computeStandings(poolRounds[1]) : [];
          const poolMatchesPlayed = poolRounds.every((r: any) =>
            savedMatches.filter((m: any) => m.round?.id === r.id).every((m: any) => m.status === 'completed')
          );

          // Look up actual playoff matches if they exist
          function findPlayoffMatch(roundType: 'semifinals' | 'finals', orderIdx: number) {
            const rounds = savedRounds.filter((r: any) => r.round_type === roundType);
            if (rounds.length === 0) return null;
            // Use match_order to disambiguate semi-final 1 vs 2 within the same round
            const candidates = savedMatches
              .filter((m: any) => rounds.some((r: any) => r.id === m.round?.id))
              .sort((a: any, b: any) => (a.match_order ?? 0) - (b.match_order ?? 0));
            return candidates[orderIdx] ?? null;
          }

          function winnerOfMatch(m: any | null, fallback?: { name?: string; isMe?: boolean }) {
            if (!m || m.status !== 'completed' || !m.winner_team) return fallback;
            const isT1 = m.winner_team === 'team1';
            const p1 = isT1 ? m.team1_player1 : m.team2_player1;
            const p2 = isT1 ? m.team1_player2 : m.team2_player2;
            if (!p1) return fallback;
            return {
              name: teamDisplayName(p1, p2),
              isMe: p1 === myUserId || p2 === myUserId,
            };
          }

          const semi1Match = findPlayoffMatch('semifinals', 0);
          const semi2Match = findPlayoffMatch('semifinals', 1);
          const finalMatch = findPlayoffMatch('finals',     0);

          const a1 = standA[0]; const a2 = standA[1];
          const b1 = standB[0]; const b2 = standB[1];

          const semi1Winner = winnerOfMatch(semi1Match);
          const semi2Winner = winnerOfMatch(semi2Match);
          const finalWinner = winnerOfMatch(finalMatch);

          return (
            <View style={S.section}>
              <Text style={S.sectionTitle}>Tournament Bracket</Text>

              {/* Pool standings */}
              <View style={S.poolsRow}>
                {poolRounds.map((round: any, pi: number) => {
                  const standings = pi === 0 ? standA : pi === 1 ? standB : computeStandings(round);
                  return (
                    <View key={round.id} style={S.poolBlock}>
                      <Text style={S.poolBlockTitle}>Pool {String.fromCharCode(65 + pi)}</Text>
                      {standings.map((t, i) => (
                        <View key={t.key} style={S.poolTeamRow}>
                          <Text style={S.poolTeamIndex}>{i + 1}</Text>
                          <Text style={[S.poolTeamText, t.isMe && S.poolTeamTextMe]} numberOfLines={2}>
                            {t.name}
                          </Text>
                          {(t.wins > 0 || t.losses > 0) && (
                            <Text style={[S.poolTeamRecord, i < 2 && S.poolTeamRecordAdvanced]}>
                              {t.wins}-{t.losses}
                            </Text>
                          )}
                          {t.isMe && <Text style={S.youTag}>YOU</Text>}
                        </View>
                      ))}
                      {standings.length === 0 && <Text style={S.poolEmpty}>No teams yet</Text>}
                    </View>
                  );
                })}
              </View>

              <View style={S.bracketDivider} />

              {/* Advancement criteria */}
              <View style={S.advancementCard}>
                <Text style={S.advancementTitle}>How teams advance</Text>
                <Text style={S.advancementRule}>
                  {'🏆  '}The <Text style={S.bold}>top 2 teams</Text> from each pool advance to the semi-finals, determined by:
                </Text>
                <Text style={S.advancementPoint}>1.  Best win/loss record</Text>
                <Text style={S.advancementPoint}>2.  Point differential (if tied on record)</Text>
                {poolMatchesPlayed && a1 && b2 && (
                  <Text style={S.advancementResultLine}>
                    ✓ Pools complete — top 2 from each pool seeded into the bracket below.
                  </Text>
                )}
              </View>

              <View style={S.bracketDivider} />

              {/* Visual bracket — populated with actual team names + winners where available */}
              <TournamentBracket
                slotA1={{ label: 'Pool A · 1st Place', team: a1?.name, highlight: a1?.isMe }}
                slotB2={{ label: 'Pool B · 2nd Place', team: b2?.name, highlight: b2?.isMe }}
                slotB1={{ label: 'Pool B · 1st Place', team: b1?.name, highlight: b1?.isMe }}
                slotA2={{ label: 'Pool A · 2nd Place', team: a2?.name, highlight: a2?.isMe }}
                semi1={{
                  label: semi1Match?.status === 'completed'
                    ? `Semi 1: ${semi1Match.team1_score}–${semi1Match.team2_score}`
                    : 'Semi-Final 1',
                  team: semi1Winner?.name,
                  highlight: semi1Winner?.isMe,
                }}
                semi2={{
                  label: semi2Match?.status === 'completed'
                    ? `Semi 2: ${semi2Match.team1_score}–${semi2Match.team2_score}`
                    : 'Semi-Final 2',
                  team: semi2Winner?.name,
                  highlight: semi2Winner?.isMe,
                }}
                final={{
                  label: finalMatch?.status === 'completed'
                    ? `Final: ${finalMatch.team1_score}–${finalMatch.team2_score}`
                    : 'Grand Final',
                  team: finalWinner?.name,
                  highlight: finalWinner?.isMe,
                }}
              />
            </View>
          );
        })()}

        {/* ── Saved schedule (tournament is active or completed) ── */}
        {(tournament.status === 'active' || tournament.status === 'completed') && savedMatches.length > 0 && (() => {
          const myCount = savedMatches.filter(m =>
            myUserId && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(myUserId)
          ).length;
          const displayed = myMatchesOnly
            ? savedMatches.filter(m => myUserId && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(myUserId))
            : savedMatches;

          return (
            <View style={S.section}>
              {/* Filter toggle */}
              <View style={S.scheduleHeader}>
                <Text style={S.sectionTitle}>
                  Match Schedule ({displayed.length}{myMatchesOnly ? '' : ` of ${savedMatches.length}`})
                </Text>
                <TouchableOpacity
                  style={[S.myMatchesToggle, myMatchesOnly && S.myMatchesToggleOn]}
                  onPress={() => setMyMatchesOnly(v => !v)}
                >
                  <Text style={[S.myMatchesToggleText, myMatchesOnly && S.myMatchesToggleTextOn]}>
                    {myMatchesOnly ? '👤 My matches' : '👥 All matches'}
                  </Text>
                </TouchableOpacity>
              </View>

              {myMatchesOnly && myCount === 0 && (
                <Text style={S.noMyMatches}>You have no scheduled matches in this tournament.</Text>
              )}

              {(() => {
                // Group by round so the user can see how each round shaped the next.
                const groups: { round: any | null; matches: any[] }[] = [];
                const idxByRound = new Map<string, number>();
                for (const m of displayed) {
                  const key = m.round?.id ?? '__no_round__';
                  let idx = idxByRound.get(key);
                  if (idx === undefined) {
                    idx = groups.length;
                    idxByRound.set(key, idx);
                    groups.push({ round: m.round ?? null, matches: [] });
                  }
                  groups[idx].matches.push(m);
                }
                groups.sort((a, b) =>
                  (a.round?.round_number ?? 999) - (b.round?.round_number ?? 999),
                );

                let globalIdx = 0;
                return groups.map((group, gi) => (
                  <View key={group.round?.id ?? `g${gi}`} style={gi > 0 && S.roundBlock}>
                    {group.round?.label && (
                      <Text style={S.scheduleRoundLabel}>{group.round.label}</Text>
                    )}
                    {group.matches.map((m) => {
                      const i = globalIdx++;
                      const t1 = [m.team1_player1, m.team1_player2].filter(Boolean).map(playerName).join(' & ') || '—';
                      const t2 = [m.team2_player1, m.team2_player2].filter(Boolean).map(playerName).join(' & ') || '—';
                      const isMyMatch = myUserId && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(myUserId);
                      const completed = m.status === 'completed' && m.winner_team != null;
                      const team1Won = m.winner_team === 'team1';
                      // Tappable when not yet recorded. Completed rows are inert —
                      // they're history at that point. The League_id we pass is the
                      // tournament's league_id (may be null for standalone tournaments).
                      const tappable = !completed && !!m.team1_player1 && !!m.team2_player1;
                      const handlePress = () => navigation.navigate('MatchEntry', {
                        leagueId:           tournament?.league_id ?? '',
                        tournamentId:       tournament?.id,
                        tournamentMatchId:  m.id,
                        tournamentName:     tournament?.name,
                        prefillMatchType:   m.match_type,
                        prefillTeam1Player: m.team1_player1 ?? undefined,
                        prefillTeam1Partner:m.team1_player2 ?? undefined,
                        prefillTeam2Player: m.team2_player1 ?? undefined,
                        prefillTeam2Partner:m.team2_player2 ?? undefined,
                      });
                      const Row: any = tappable ? TouchableOpacity : View;
                      return (
                        <Row
                          key={m.id}
                          style={[S.matchRow, isMyMatch && S.matchRowHighlight]}
                          {...(tappable ? { onPress: handlePress, activeOpacity: 0.6 } : {})}
                        >
                          <Text style={S.matchNum}>{i + 1}</Text>
                          <Text style={[
                            S.matchup,
                            completed && team1Won && S.matchupWinner,
                            completed && !team1Won && S.matchupLoser,
                            isMyMatch && S.matchupHighlight,
                          ]} numberOfLines={1}>{t1}</Text>
                          {completed ? (
                            <Text style={S.matchScore}>{m.team1_score}–{m.team2_score}</Text>
                          ) : (
                            <Text style={S.vs}>vs</Text>
                          )}
                          <Text style={[
                            S.matchup,
                            completed && !team1Won && S.matchupWinner,
                            completed && team1Won && S.matchupLoser,
                            isMyMatch && S.matchupHighlight,
                          ]} numberOfLines={1}>{t2}</Text>
                          {isMyMatch && <Text style={S.myMatchTag}>YOU</Text>}
                          {tappable && !isMyMatch && (
                            <Text style={S.recordChevron}>›</Text>
                          )}
                        </Row>
                      );
                    })}
                  </View>
                ));
              })()}
            </View>
          );
        })()}

        {/* ── Generated preview schedule (before lock-in) ── */}
        {generatedMatches && generatedMatches.length > 0 && (() => {
          const previewFiltered = myMatchesOnly
            ? generatedMatches.filter(m => myUserId && (m.team1.includes(myUserId) || m.team2.includes(myUserId)))
            : generatedMatches;
          const rounds = [...new Set(previewFiltered.map(m => m.round))].sort((a,b) => a-b);

          return (
            <View style={S.section}>
              <View style={S.previewBanner}>
                <Text style={S.previewBannerText}>👁 Preview — tap "Lock In" above to save and notify members</Text>
              </View>

              {/* Filter toggle */}
              <View style={S.scheduleHeader}>
                <Text style={S.sectionTitle}>
                  Preview ({previewFiltered.length}{myMatchesOnly ? '' : ` of ${generatedMatches.length}`} matches)
                </Text>
                <TouchableOpacity
                  style={[S.myMatchesToggle, myMatchesOnly && S.myMatchesToggleOn]}
                  onPress={() => setMyMatchesOnly(v => !v)}
                >
                  <Text style={[S.myMatchesToggleText, myMatchesOnly && S.myMatchesToggleTextOn]}>
                    {myMatchesOnly ? '👤 My matches' : '👥 All matches'}
                  </Text>
                </TouchableOpacity>
              </View>

              {rounds.map(r => (
                <View key={r} style={S.roundBlock}>
                  <Text style={S.roundLabel}>
                    {generatedMatches.find(m => m.round === r)?.label?.split('·')[0]?.trim() ?? `Round ${r}`}
                  </Text>
                  {previewFiltered.filter(m => m.round === r).map((m, mi) => {
                    const t1 = m.team1.map(playerName).join(' & ');
                    const t2 = m.team2.map(playerName).join(' & ');
                    const isMyMatch = myUserId && (m.team1.includes(myUserId) || m.team2.includes(myUserId));
                    return (
                      <View key={mi} style={[S.matchRow, isMyMatch && S.matchRowHighlight]}>
                        <Text style={S.matchNum}>{mi+1}</Text>
                        <Text style={[S.matchup, isMyMatch && S.matchupHighlight]} numberOfLines={1}>{t1}</Text>
                        <Text style={S.vs}>vs</Text>
                        <Text style={[S.matchup, isMyMatch && S.matchupHighlight]} numberOfLines={1}>{t2}</Text>
                        {isMyMatch && <Text style={S.myMatchTag}>YOU</Text>}
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          );
        })()}

        {/* ── Godmode test helpers (Brian only) ── */}
        {godmode && (
          <>
            {tournament.status === 'registration' && (
              <View style={S.godmodeSetupBlock}>
                <Text style={S.godmodeSectionTitle}>Tournament setup shortcuts</Text>
                <TouchableOpacity
                  style={[S.quickActionBtn, S.godmodeSetupBtn]}
                  onPress={godmodeApproveAllInvitees}
                  activeOpacity={0.7}
                >
                  <Text style={S.quickActionText}>✅ Force-approve all invitees</Text>
                </TouchableOpacity>
                {(tournament.match_type === 'doubles'
                  || tournament.format === 'mlp'
                  || tournament.format === 'mlp_random') && (
                  <TouchableOpacity
                    style={[S.quickActionBtn, S.godmodeSetupBtn]}
                    onPress={godmodeForceCreateTeams}
                    activeOpacity={0.7}
                  >
                    <Text style={S.quickActionText}>🤝 Force-create teams</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[S.quickActionBtn, S.godmodeSetupBtn]}
                  onPress={godmodeAutoGenerateAndLock}
                  activeOpacity={0.7}
                >
                  <Text style={S.quickActionText}>🎯 Auto-generate + lock-in bracket</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={[S.dangerBtn, { backgroundColor: '#6d28d9', borderColor: '#6d28d9' }]}
              onPress={simulateFillMatches}
              activeOpacity={0.85}
              disabled={simulating}
            >
              <Text style={[S.dangerBtnText, { color: '#fff' }]}>
                {simulating ? 'Filling…' : '🎲 Auto-fill pending matches with random scores (godmode)'}
              </Text>
              <Text style={[S.dangerBtnSub, { color: '#e9d5ff' }]}>
                Picks a random winner per match (11–rand 0..9). PLUPR fires per update. Last pool/RR match auto-spawns the playoff.
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={S.dangerBtn} onPress={deleteTournament} activeOpacity={0.85}>
              <Text style={S.dangerBtnText}>🗑  Delete Tournament (godmode)</Text>
              <Text style={S.dangerBtnSub}>Removes the tournament and everything cascaded under it.</Text>
            </TouchableOpacity>
          </>
        )}

      </ScrollView>

      {/* ── Bracket release time picker ── */}
      <AppDateTimePicker
        visible={showReleasePicker}
        value={tournament.bracket_release_time ? new Date(tournament.bracket_release_time) : new Date(Date.now() + 86400000)}
        minimumDate={new Date()}
        onChange={saveBracketReleaseTime}
        onClose={() => setShowReleasePicker(false)}
      />

      {/* ── Partner selection modal ── */}
      <Modal visible={showPartnerModal} transparent animationType="slide" onRequestClose={() => setShowPartnerModal(false)}>
        <Pressable style={S.modalOverlay} onPress={() => setShowPartnerModal(false)}>
          <Pressable style={S.modalSheet} onPress={() => {}}>
            <Text style={S.modalTitle}>Request a Partner</Text>
            <Text style={S.modalSubtitle}>{availablePartners.length} player{availablePartners.length !== 1 ? 's' : ''} available</Text>
            <FlatList
              data={availablePartners}
              keyExtractor={i => i.id}
              scrollEnabled={availablePartners.length > 6}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={S.partnerOption} onPress={() => sendPartnerRequest(item.user_id)}>
                  <View style={S.partnerOptionAvatar}>
                    <Text style={S.partnerOptionInitial}>{(item.profile?.full_name ?? '?')[0].toUpperCase()}</Text>
                  </View>
                  <Text style={S.partnerOptionName}>{item.profile?.full_name}</Text>
                  <Text style={S.partnerOptionRating}>{formatPlupr((item.profile as any)?.rating, (item.profile as any)?.total_matches_played)} PLUPR</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={S.modalEmpty}>All players are already partnered.</Text>}
            />
            <TouchableOpacity style={S.modalClose} onPress={() => setShowPartnerModal(false)}>
              <Text style={S.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Edit tournament modal ──────────────────────────── */}
      <Modal visible={showEditModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowEditModal(false)}>
        <ScrollView contentContainerStyle={S.editModal} keyboardShouldPersistTaps="handled">
          <Text style={S.editModalTitle}>Edit Tournament</Text>

          <Text style={S.editFieldLabel}>Name</Text>
          <TextInput
            style={S.editInput}
            value={editName}
            onChangeText={setEditName}
            placeholder="Tournament name"
            placeholderTextColor={c.textMuted}
            maxLength={80}
          />

          <Text style={S.editFieldLabel}>Description</Text>
          <TextInput
            style={[S.editInput, S.editInputMultiline]}
            value={editDesc}
            onChangeText={setEditDesc}
            placeholder="What's this tournament about?"
            placeholderTextColor={c.textMuted}
            multiline
            numberOfLines={4}
            maxLength={500}
          />

          <Text style={S.editFieldLabel}>Start time</Text>
          <TouchableOpacity
            style={[S.editInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
            onPress={() => setShowStartPicker(true)}
            activeOpacity={0.7}
          >
            <Text style={editStartTime ? S.editDateText : S.editDatePlaceholder}>
              {editStartTime
                ? editStartTime.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : 'Tap to set'}
            </Text>
            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: c.primaryLight }}>
              <Text style={{ fontSize: 12, color: c.primary, fontWeight: '700' }}>
                📅 {editStartTime ? 'Change' : 'Pick'}
              </Text>
            </View>
          </TouchableOpacity>
          {editStartTime && (
            <TouchableOpacity onPress={() => setEditStartTime(null)} style={{ paddingVertical: 6, alignSelf: 'flex-start' }}>
              <Text style={{ fontSize: 13, color: c.danger, fontWeight: '600' }}>Clear start time</Text>
            </TouchableOpacity>
          )}

          <Text style={S.editFieldLabel}>Expected length (hours)</Text>
          <TextInput
            style={S.editInput}
            value={editLengthHours}
            onChangeText={setEditLengthHours}
            placeholder="e.g. 3, 4.5"
            placeholderTextColor={c.textMuted}
            keyboardType="decimal-pad"
            maxLength={6}
          />

          <Text style={S.editFieldLabel}>Location</Text>
          <TextInput
            style={S.editInput}
            value={editLocation}
            onChangeText={setEditLocation}
            placeholder="Where is it being held?"
            placeholderTextColor={c.textMuted}
            maxLength={200}
          />

          <Text style={S.editFieldLabel}>Max players</Text>
          <TextInput
            style={S.editInput}
            value={editMaxPlayers}
            onChangeText={setEditMaxPlayers}
            placeholder="No cap"
            placeholderTextColor={c.textMuted}
            keyboardType="number-pad"
            maxLength={4}
          />

          <TouchableOpacity
            style={[S.editSaveBtn, savingEdit && S.editSaveBtnDisabled]}
            onPress={saveTournamentEdits}
            disabled={savingEdit}
          >
            <Text style={S.editSaveBtnText}>{savingEdit ? 'Saving…' : 'Save Changes'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.editCancelBtn} onPress={() => setShowEditModal(false)}>
            <Text style={S.editCancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Datetime picker MUST live inside the edit Modal so its position:fixed
            overlay shares the same stacking context. Otherwise on web the page-
            sheet Modal renders above the picker and it appears hidden until
            the edit modal closes. */}
        <AppDateTimePicker
          visible={showStartPicker}
          value={editStartTime ?? new Date()}
          onChange={d => { setEditStartTime(d); setShowStartPicker(false); }}
          onClose={() => setShowStartPicker(false)}
        />
      </Modal>

      <ConfirmModal
        visible={showLockInConfirm}
        title="Lock in bracket?"
        body={`This finalizes the schedule and notifies all ${approved.length} member${approved.length === 1 ? '' : 's'}. You won't be able to regenerate after this.`}
        primaryLabel="Lock In & Notify"
        variant="danger"
        busy={locking}
        error={lockInError}
        onConfirm={doLockIn}
        onClose={() => setShowLockInConfirm(false)}
      />

      <ConfirmModal
        visible={showCompleteConfirm}
        title="Complete tournament?"
        body="This flips the tournament status to completed. Players can no longer record matches. Payout becomes available."
        primaryLabel="Complete"
        variant="danger"
        busy={completing}
        error={completeError}
        onConfirm={() => confirmCompleteTournament()}
        onClose={() => setShowCompleteConfirm(false)}
      />

      <ConfirmModal
        visible={showDeleteConfirm}
        title={`🗑  Delete "${tournament?.name ?? ''}"?`}
        body="This permanently removes the tournament and all of its rounds, matches, registrations, and partner requests. This cannot be undone."
        primaryLabel="Delete Tournament"
        variant="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={confirmDeleteTournament}
        onClose={() => setShowDeleteConfirm(false)}
      />

      <PayoutPreviewModal
        visible={showPayoutModal}
        tournamentId={tournamentId}
        prizePool={tournament?.prize_pool ?? 0}
        onClose={() => setShowPayoutModal(false)}
        onPaid={() => { setShowPayoutModal(false); load(); }}
      />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    empty: { textAlign: 'center', marginTop: 60, color: c.textMuted, fontSize: 15 },

    headerCard: { backgroundColor: c.surface, padding: 16, marginBottom: 8, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3 },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
    fmtIcon: { fontSize: 30, marginTop: 2 },
    fmtLabel: { fontSize: 16, fontWeight: '800', color: c.text },
    fmtDesc: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    myRoleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
    myRoleText: { fontSize: 11, fontWeight: '700' },
    chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    chip: { backgroundColor: c.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, fontSize: 12, color: c.textSub, fontWeight: '500' },
    metaLine: { fontSize: 13, color: c.textSub, marginBottom: 3 },
    desc: { fontSize: 13, color: c.textMuted, marginTop: 6 },

    infoBox: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff8e1', margin: 12, marginBottom: 4, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#ffe082' },
    mlpCard: { margin: 12, marginBottom: 4, backgroundColor: c.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    infoIcon: { fontSize: 22 },
    infoText: { flex: 1, fontSize: 14, color: '#b8860b', fontWeight: '500' },

    setReleaseBtn: { margin: 12, marginBottom: 4, backgroundColor: c.bg, borderRadius: 12, padding: 12 },
    setReleaseBtnText: { fontSize: 13, color: c.textSub, fontWeight: '500' },
    historyBtn: { margin: 12, marginBottom: 4, backgroundColor: c.surface, borderRadius: 12, padding: 14, flexDirection: 'column', borderWidth: 1, borderColor: c.border, elevation: 2, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4 },
    historyBtnText: { fontSize: 15, fontWeight: '700', color: c.text },
    historyBtnSub:  { fontSize: 12, color: c.textMuted, marginTop: 2 },

    quickActionsRow: { flexDirection: 'row', gap: 8, marginHorizontal: 12, marginBottom: 8, marginTop: 0 },
    quickActionBtn:  { flex: 1, backgroundColor: c.surface, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', borderWidth: 1, borderColor: c.border },
    quickActionBtnPrimary:   { backgroundColor: c.primaryLight, borderColor: c.primary },
    quickActionText:         { fontSize: 13, fontWeight: '700', color: c.textSub },
    quickActionTextPrimary:  { color: c.primary },

    closedBanner:     { marginHorizontal: 12, marginBottom: 8, backgroundColor: '#fff8e1', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#ffe082' },
    closedBannerText: { fontSize: 13, color: '#b8860b', fontWeight: '600' },
    dangerBtn:        { margin: 12, marginTop: 16, backgroundColor: c.surface, borderRadius: 14, padding: 16, borderWidth: 1.5, borderColor: c.danger + '88' },
    dangerBtnText:    { fontSize: 15, fontWeight: '800', color: c.danger },
    godmodeSetupBlock: { marginHorizontal: 12, marginTop: 16, padding: 12, gap: 8, borderRadius: 14, borderWidth: 1.5, borderColor: '#6d28d988', backgroundColor: c.surface },
    godmodeSectionTitle: { fontSize: 13, fontWeight: '800', color: '#6d28d9', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },
    godmodeSetupBtn:  { flex: 0, alignSelf: 'stretch' },

    confirmBackdrop:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    confirmCard:            { backgroundColor: c.surface, borderRadius: 16, padding: 22, maxWidth: 460, width: '100%' },
    confirmTitle:           { fontSize: 18, fontWeight: '900', color: c.text, marginBottom: 10 },
    confirmBody:            { fontSize: 13, color: c.textSub, lineHeight: 19, marginBottom: 18 },
    confirmBtnRow:          { flexDirection: 'row', gap: 10 },
    confirmBtn:             { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    confirmBtnSecondary:    { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    confirmBtnSecondaryText:{ color: c.textSub, fontWeight: '700', fontSize: 14 },
    confirmBtnDanger:       { backgroundColor: c.danger },
    confirmBtnDangerText:   { color: '#fff', fontWeight: '800', fontSize: 14 },
    dangerBtnSub:     { fontSize: 12, color: c.textMuted, marginTop: 4 },

    payoutBtn:        { marginTop: 12, backgroundColor: c.primary, borderRadius: 12, padding: 14, alignItems: 'center' },
    payoutBtnText:    { fontSize: 15, fontWeight: '900', color: '#fff' },
    payoutBtnSub:     { fontSize: 11, color: '#fff', opacity: 0.85, marginTop: 4, textAlign: 'center' },
    payoutDoneBanner: { marginTop: 12, backgroundColor: '#e8f5e9', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#a5d6a7', alignItems: 'center' },
    payoutDoneText:   { fontSize: 12, color: '#2e7d32', fontWeight: '700' },

    editModal:        { padding: 24, paddingTop: 48, flexGrow: 1, backgroundColor: c.surface },
    editModalTitle:   { fontSize: 22, fontWeight: '800', color: c.text, marginBottom: 6 },
    editFieldLabel:   { fontSize: 13, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 18, marginBottom: 6 },
    editInput:        { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 14, fontSize: 16, marginBottom: 4, backgroundColor: c.surface, color: c.text },
    editInputMultiline: { minHeight: 96, textAlignVertical: 'top' },
    editDateText:     { fontSize: 15, color: c.text },
    editDatePlaceholder: { fontSize: 15, color: c.textMuted },
    editSaveBtn:      { backgroundColor: c.primary, padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 24 },
    editSaveBtnDisabled: { backgroundColor: '#a5d6a7' },
    editSaveBtnText:  { color: '#fff', fontWeight: '700', fontSize: 16 },
    editCancelBtn:    { padding: 14, alignItems: 'center' },
    editCancelBtnText:{ fontSize: 15, color: c.textMuted },

    registerBtn: { margin: 12, backgroundColor: c.primary, borderRadius: 12, padding: 16, alignItems: 'center' },
    registerBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
    inviteNote: { margin: 12, backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 14 },
    inviteNoteText: { fontSize: 13, color: c.textMuted },
    myRegBadge: { margin: 12, borderRadius: 12, padding: 14 },
    regApproved: { backgroundColor: c.primaryLight },
    regPending:  { backgroundColor: '#fff8e1' },
    regRejected: { backgroundColor: '#ffebee' },
    myRegText: { fontSize: 14, fontWeight: '600', color: c.text },

    section: { backgroundColor: c.surface, margin: 12, marginTop: 0, marginBottom: 8, borderRadius: 14, padding: 14, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3 },
    sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    sectionTitle: { fontSize: 13, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 },
    manageLinkText: { fontSize: 12, color: c.primary, fontWeight: '600' },
    emptySection: { fontSize: 15, color: c.textMuted, textAlign: 'center', paddingVertical: 8 },

    playerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: c.bg },
    playerSeed: { width: 28, fontSize: 12, color: c.border, fontWeight: '600' },
    playerName: { flex: 1, fontSize: 14, fontWeight: '600', color: c.text },
    playerRating: { fontSize: 13, fontWeight: '700', color: c.primary, marginRight: 6 },
    rolePill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1 },
    rolePillText: { fontSize: 10, fontWeight: '700' },

    pendingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.bg },
    pendingActions: { flexDirection: 'row', gap: 6 },
    approveBtn: { backgroundColor: c.primary, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    approveBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
    rejectBtn: { backgroundColor: c.bg, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    rejectBtnText: { color: c.textMuted, fontSize: 14, fontWeight: '800' },

    generateBtn: { margin: 12, marginBottom: 6, backgroundColor: '#1565c0', borderRadius: 12, padding: 16, alignItems: 'center' },
    generateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    lockBtn: { margin: 12, marginTop: 0, backgroundColor: c.primary, borderRadius: 12, padding: 16, alignItems: 'center' },
    lockBtnDisabled: { backgroundColor: '#a5d6a7' },
    lockBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    activeBanner: { margin: 12, backgroundColor: c.primaryLight, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#c8e6c9' },
    activeBannerText: { fontSize: 14, color: c.primary, fontWeight: '700' },
    completedBanner: { margin: 12, backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: c.border },
    completedBannerText: { fontSize: 14, color: c.textSub, fontWeight: '700' },
    coAdminNote: { margin: 12, marginTop: 0, backgroundColor: c.bg, borderRadius: 12, padding: 12 },
    coAdminNoteText: { fontSize: 13, color: c.textMuted, textAlign: 'center' },
    bracketDivider: { height: 1, backgroundColor: c.border, marginVertical: 14 },
    poolsRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
    poolBlock: { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 11, borderWidth: 1, borderColor: c.border },
    poolBlockTitle: { fontSize: 12, fontWeight: '800', color: '#1565c0', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
    poolTeamRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6 },
    poolTeamIndex: { width: 16, fontSize: 11, fontWeight: '700', color: c.border },
    poolTeamText: { flex: 1, fontSize: 12, color: c.text, fontWeight: '500', lineHeight: 16 },
    poolTeamTextMe: { color: c.primary, fontWeight: '700' },
    poolTeamRecord: { fontSize: 11, fontWeight: '700', color: c.textMuted, marginRight: 4 },
    poolTeamRecordAdvanced: { color: c.primary },
    poolEmpty: { fontSize: 11, color: c.textMuted, fontStyle: 'italic', paddingVertical: 4 },
    advancementResultLine: { fontSize: 12, color: c.primary, fontWeight: '600', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border },
    youTag: { fontSize: 9, fontWeight: '800', color: c.primary, backgroundColor: c.primaryLight, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6 },
    advancementCard: { backgroundColor: '#f0f4ff', borderRadius: 10, padding: 13, borderWidth: 1, borderColor: '#c5cff5' },
    advancementTitle: { fontSize: 13, fontWeight: '700', color: '#1565c0', marginBottom: 7 },
    advancementRule: { fontSize: 13, color: c.text, lineHeight: 19, marginBottom: 6 },
    advancementPoint: { fontSize: 13, color: c.textSub, lineHeight: 18, paddingLeft: 8 },
    bold: { fontWeight: '700' },
    scheduleHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    myMatchesToggle: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
    myMatchesToggleOn: { borderColor: c.primary, backgroundColor: c.primaryLight },
    myMatchesToggleText: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
    myMatchesToggleTextOn: { color: c.primary },
    noMyMatches: { fontSize: 15, color: c.textMuted, textAlign: 'center', paddingVertical: 12 },
    previewBanner: { backgroundColor: '#fff3e0', borderRadius: 8, padding: 10, marginBottom: 10 },
    previewBannerText: { fontSize: 12, color: '#e65100', fontWeight: '500' },
    matchRowHighlight: { backgroundColor: c.primaryLight },
    matchupHighlight: { color: c.primary, fontWeight: '800' },
    matchupWinner: { fontWeight: '800', color: c.text },
    matchupLoser:  { color: c.textMuted },
    matchScore: { fontSize: 13, fontWeight: '800', color: c.textSub, paddingHorizontal: 4 },
    scheduleRoundLabel: { fontSize: 12, fontWeight: '700', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 4 },
    myMatchTag: { fontSize: 9, color: c.primary, fontWeight: '800', backgroundColor: c.primaryLight, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6 },
    recordChevron: { fontSize: 18, color: c.textMuted, fontWeight: '700', marginLeft: 4 },

    // Partner section
    partnerConfirmed: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.primaryLight, borderRadius: 10, padding: 12 },
    partnerConfirmedIcon: { fontSize: 24 },
    partnerConfirmedName: { flex: 1, fontSize: 15, fontWeight: '700', color: c.text },
    partnerConfirmedNote: { fontSize: 12, color: c.primary },
    partnerPending: { backgroundColor: '#fff8e1', borderRadius: 10, padding: 12 },
    partnerPendingText: { fontSize: 13, color: '#b8860b', marginBottom: 6 },
    cancelReqText: { fontSize: 12, color: c.danger, fontWeight: '600' },
    partnerRequest: { backgroundColor: c.primaryLight, borderRadius: 10, padding: 12 },
    partnerReqText: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 10 },
    partnerReqActions: { flexDirection: 'row', gap: 10 },
    acceptBtn: { flex: 1, backgroundColor: c.primary, borderRadius: 8, padding: 10, alignItems: 'center' },
    acceptBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    declineBtn: { flex: 1, backgroundColor: c.bg, borderRadius: 8, padding: 10, alignItems: 'center' },
    declineBtnText: { color: c.textMuted, fontWeight: '600', fontSize: 14 },
    noPartnerText: { fontSize: 15, color: c.textMuted, marginBottom: 10 },
    findPartnerBtn: { backgroundColor: c.primaryLight, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: c.primary },
    findPartnerBtnText: { color: c.primary, fontWeight: '700', fontSize: 14 },

    // Pools & schedule
    poolCard: { backgroundColor: c.surfaceAlt, borderRadius: 8, padding: 10, marginBottom: 8 },
    poolLabel: { fontSize: 13, fontWeight: '700', color: '#1565c0', marginBottom: 4 },
    poolPlayer: { fontSize: 13, color: c.textSub, paddingVertical: 2 },
    roundBlock: { marginBottom: 12 },
    roundLabel: { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
    matchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: c.bg },
    matchNum: { width: 20, fontSize: 11, color: c.border, fontWeight: '600' },
    matchup: { flex: 1, fontSize: 13, fontWeight: '600', color: c.text },
    vs: { fontSize: 11, color: c.border, fontWeight: '700' },

    // Partner modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36 },
    modalTitle: { fontSize: 20, fontWeight: '800', color: c.text, marginBottom: 4 },
    modalSubtitle: { fontSize: 13, color: c.textMuted, marginBottom: 14 },
    partnerOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.bg },
    partnerOptionAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    partnerOptionInitial: { fontSize: 16, fontWeight: '700', color: c.primary },
    partnerOptionName: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text },
    partnerOptionRating: { fontSize: 13, fontWeight: '700', color: c.primary },
    modalEmpty: { textAlign: 'center', color: c.textMuted, paddingVertical: 20, fontSize: 15 },
    modalClose: { marginTop: 16, padding: 14, alignItems: 'center' },
    modalCloseText: { fontSize: 15, color: c.textMuted },
  });
}
