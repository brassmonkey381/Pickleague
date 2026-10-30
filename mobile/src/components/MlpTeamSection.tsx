import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  Modal, TextInput, ScrollView, Pressable,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { MlpTeam, MlpTeamJoinRequest, MlpTeamSlot, TournamentRegistration } from '../types';
import UserPickerModal, { PickedUser } from './UserPickerModal';
import ConfirmModal from './ConfirmModal';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import EmptyState from './EmptyState';
import { isGodmodeUserId } from '../lib/godmode';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { HAIRLINE, RADIUS, SPACE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { FORMAT_META } from '../lib/tournament';
import { ToastOutlet } from '@just-messin-around/expo-foundation/toast';

type Props = {
  tournamentId: string;
  format: 'mlp' | 'mlp_random';
  mlpPlayFormat?: 'round_robin' | 'pool_play' | 'round_robin_playoff' | 'pool_play_playoff';
  tournamentStatus: string;
  isPriv: boolean;
  currentUserId: string | null;
  approvedRegistrations: TournamentRegistration[];
  bracketAlreadyGenerated: boolean;
  onTeamsChanged?: () => void;
  /**
   * Drop the title row (the subtitle stays: it explains the format), for a
   * host that already names the section (TournamentDetail's "Teams"
   * section). Default false.
   */
  bare?: boolean;
};

type ProfileLite = { id: string; full_name: string; gender: string | null };

const SLOT_LABEL: Record<MlpTeamSlot, string> = {
  male_1:   'Male #1',
  male_2:   'Male #2',
  female_1: 'Female #1',
  female_2: 'Female #2',
};

const SLOT_ORDER: MlpTeamSlot[] = ['male_1', 'male_2', 'female_1', 'female_2'];

export default function MlpTeamSection({
  tournamentId, format, mlpPlayFormat = 'round_robin', tournamentStatus, isPriv, currentUserId,
  approvedRegistrations, bracketAlreadyGenerated, onTeamsChanged, bare = false,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [teams, setTeams]               = useState<MlpTeam[]>([]);
  const [requests, setRequests]         = useState<MlpTeamJoinRequest[]>([]);
  const [profileMap, setProfileMap]     = useState<Record<string, ProfileLite>>({});
  const [loading, setLoading]           = useState(true);
  const [busy, setBusy]                 = useState(false);
  // `busy` only reaches the buttons on the next render; these handlers are
  // reachable from several places at once (rows, modals, godmode tools), so the
  // guard has to be a ref read at the top of each one.
  const busyRef                         = useRef(false);

  // Create team modal
  const [showCreate, setShowCreate]     = useState(false);
  const [newTeamName, setNewTeamName]   = useState('');
  const [createError, setCreateError]   = useState<string | null>(null);

  // Invite flow
  const [invitingTeamId, setInvitingTeamId] = useState<string | null>(null);
  const [pendingInvite, setPendingInvite]   = useState<{ teamId: string; teamName: string; user: PickedUser } | null>(null);
  const [inviteError, setInviteError]       = useState<string | null>(null);

  // Leave/disband flow
  const [leaveConfirm, setLeaveConfirm]   = useState<{ teamId: string; teamName: string; asCaptain: boolean } | null>(null);
  const [leaveError, setLeaveError]       = useState<string | null>(null);

  // Admin action banner (random teams + bracket generation).
  // Inline since Alert.alert can be invisible on web in some focus states.
  const adminStatus = useStatusMessage();

  // Per-approved-player gender, fetched once at load. Used to compute the
  // pre-flight checks for random/snake team generation.
  const [approvedGenders, setApprovedGenders] = useState<Record<string, string | null>>({});

  useFocusEffect(useCallback(() => { load(); }, [tournamentId]));

  async function load() {
    setLoading(true);
    const [teamsRes, requestsRes] = await Promise.all([
      supabase.from('mlp_teams').select('*').eq('tournament_id', tournamentId).order('seed', { ascending: true, nullsFirst: false }).order('created_at'),
      supabase.from('mlp_team_join_requests').select('*'),
    ]);

    const teamRows = (teamsRes.data ?? []) as MlpTeam[];
    setTeams(teamRows);

    // Fetch profiles for everyone referenced
    const ids = new Set<string>();
    for (const t of teamRows) {
      for (const id of [t.captain_id, t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id]) {
        if (id) ids.add(id);
      }
    }
    const reqRows = ((requestsRes.data ?? []) as MlpTeamJoinRequest[])
      .filter(r => teamRows.some(t => t.id === r.team_id) && r.status === 'pending');
    setRequests(reqRows);
    for (const r of reqRows) ids.add(r.user_id);

    if (ids.size > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, gender')
        .in('id', [...ids]);
      const map: Record<string, ProfileLite> = {};
      for (const p of (profs ?? []) as ProfileLite[]) map[p.id] = p;
      setProfileMap(map);
    } else {
      setProfileMap({});
    }

    // ── Genders for every approved tournament player ─────────────────
    // Used for the random/snake pre-flight check (need at least 2 men + 2
    // women per generated team).
    const approvedIds = approvedRegistrations
      .filter(r => r.status === 'approved')
      .map(r => r.user_id);
    if (approvedIds.length > 0) {
      const { data: gprofs } = await supabase
        .from('profiles')
        .select('id, gender')
        .in('id', approvedIds);
      const gmap: Record<string, string | null> = {};
      for (const p of (gprofs ?? []) as { id: string; gender: string | null }[]) {
        gmap[p.id] = p.gender ?? null;
      }
      setApprovedGenders(gmap);
    } else {
      setApprovedGenders({});
    }
    setLoading(false);
  }

  // ── Derived data ────────────────────────────────────────────────────
  const myTeam = currentUserId
    ? teams.find(t =>
        t.captain_id === currentUserId ||
        t.male_1_id  === currentUserId || t.male_2_id  === currentUserId ||
        t.female_1_id === currentUserId || t.female_2_id === currentUserId,
      )
    : null;
  const isCaptain = myTeam?.captain_id === currentUserId;

  function teamFull(t: MlpTeam) {
    return !!(t.male_1_id && t.male_2_id && t.female_1_id && t.female_2_id);
  }

  function teamSlotMember(t: MlpTeam, slot: MlpTeamSlot): ProfileLite | null {
    const id = t[`${slot}_id` as const] as string | null;
    return id ? profileMap[id] ?? null : null;
  }

  // ── Actions ─────────────────────────────────────────────────────────
  async function createTeam() {
    if (busyRef.current) return;
    setCreateError(null);
    const trimmed = newTeamName.trim();
    if (!trimmed) {
      setCreateError('Pick a team name first.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('create_mlp_team', {
        p_tournament_id: tournamentId,
        p_name:          trimmed,
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[MLP create_mlp_team]', error);
        const hint = error.message?.toLowerCase().includes('does not exist')
          ? '\n\nThe migration may not be applied yet — run supabase/migration_add_mlp_teams.sql in the SQL Editor.'
          : '';
        setCreateError(`${error.message ?? 'Unknown error'}${hint}`);
        return;
      }
      // eslint-disable-next-line no-console
      console.log('[MLP create_mlp_team] created team', data);
      setShowCreate(false);
      setNewTeamName('');
      await load();
      onTeamsChanged?.();
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[MLP create_mlp_team] threw', e);
      setCreateError(friendlySbMessage(e, 'Could not create the team.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function requestJoin(teamId: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('mlp_request_join', {
        p_team_id: teamId,
        p_message: null,
      }));
      adminStatus.success('Request sent — the captain will see it.');
      await load();
    } catch (e) {
      adminStatus.error(friendlySbMessage(e, 'Could not send the request.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function respondToRequest(reqId: string, accept: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('mlp_respond_to_join', {
        p_request_id: reqId,
        p_accept:     accept,
      }));
      adminStatus.success(accept ? 'Request accepted — player added to your team.' : 'Request declined.');
      await load();
      onTeamsChanged?.();
    } catch (e) {
      console.warn('[mlp] mlp_respond_to_join', e);
      adminStatus.error(friendlySbMessage(e, 'Could not respond to the request.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // Step 1 of invite flow: user picked from UserPickerModal → stash and
  // open the confirm dialog (closing the picker behind it).
  function pickInvitee(teamId: string, u: PickedUser) {
    const team = teams.find(t => t.id === teamId);
    setPendingInvite({ teamId, teamName: team?.name ?? '', user: u });
    setInvitingTeamId(null);
    setInviteError(null);
  }

  // Step 2: user confirms in the dialog → fire the RPC.
  async function confirmInvite() {
    if (busyRef.current) return;
    if (!pendingInvite) return;
    busyRef.current = true;
    setInviteError(null);
    setBusy(true);
    try {
      const { error } = await supabase.rpc('mlp_invite', {
        p_team_id: pendingInvite.teamId,
        p_user_id: pendingInvite.user.id,
        p_message: null,
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[MLP mlp_invite]', error);
        setInviteError(error.message ?? 'Unknown error');
        return;
      }
      setPendingInvite(null);
      await load();
    } catch (e: any) {
      setInviteError(friendlySbMessage(e, 'Could not send the invite.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function clearSlot(teamId: string, slot: MlpTeamSlot) {
    if (busyRef.current) return;
    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      // Idempotent: sets the slot to a fixed value, so a retry is a no-op.
      await sbCall(() => supabase.rpc('mlp_set_slot', {
        p_team_id: teamId,
        p_slot:    slot,
        p_user_id: null,
      }));
      await load();
      onTeamsChanged?.();
    } catch (e) {
      adminStatus.error(friendlySbMessage(e, 'Could not clear that slot.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function setDreambreaker(teamId: string, userId: string | null) {
    if (busyRef.current) return;
    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('mlp_set_dreambreaker', {
        p_team_id: teamId,
        p_user_id: userId,
      }));
      await load();
      onTeamsChanged?.();
    } catch (e) {
      adminStatus.error(friendlySbMessage(e, 'Could not set the Dreambreaker player.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function lockTeam(teamId: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('mlp_lock_team', { p_team_id: teamId }));
      adminStatus.success('Team locked.');
      await load();
      onTeamsChanged?.();
    } catch (e) {
      adminStatus.error(friendlySbMessage(e, 'Could not lock the team.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // Captain re-slots themselves into their own team after clearing their slot.
  // Auto-routes by gender (male/other → male_1 then male_2, female → female_1 then female_2).
  async function captainJoinOwnTeam(team: MlpTeam) {
    if (busyRef.current) return;
    if (!currentUserId) return;
    const me = profileMap[currentUserId];
    const gender = me?.gender;
    if (!gender || gender === 'prefer-not-to-say') {
      adminStatus.error('Open your profile and set your gender (male/female/other) before joining a team slot.');
      return;
    }

    let slot: MlpTeamSlot | null = null;
    if (gender === 'female') {
      if (team.female_1_id == null) slot = 'female_1';
      else if (team.female_2_id == null) slot = 'female_2';
    } else {
      if (team.male_1_id == null) slot = 'male_1';
      else if (team.male_2_id == null) slot = 'male_2';
    }
    if (!slot) {
      adminStatus.error(`Both ${gender === 'female' ? 'female' : 'male'} slots are filled. Clear one first.`);
      return;
    }

    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('mlp_set_slot', {
        p_team_id: team.id,
        p_slot:    slot,
        p_user_id: currentUserId,
      }));
      await load();
      onTeamsChanged?.();
    } catch (e) {
      adminStatus.error(friendlySbMessage(e, 'Could not join that slot.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmLeaveTeam() {
    if (busyRef.current) return;
    if (!leaveConfirm) return;
    busyRef.current = true;
    setLeaveError(null);
    setBusy(true);
    try {
      const { error } = await supabase.rpc('mlp_leave_team', { p_team_id: leaveConfirm.teamId });
      if (error) {
        setLeaveError(error.message ?? 'Failed to leave team.');
        return;
      }
      setLeaveConfirm(null);
      await load();
      onTeamsChanged?.();
    } catch (e: any) {
      setLeaveError(friendlySbMessage(e, 'Failed to leave team.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // Both generators below WRITE bracket rows and nothing dedupes them, so the
  // ref guard is the thing standing between an impatient second tap and a
  // doubled bracket. Deliberately not retried for the same reason.
  async function generateRandomTeams(mode: 'random' | 'snake') {
    if (busyRef.current) return;
    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      const data = await sbCall(() => supabase.rpc('generate_random_mlp_teams', {
        p_tournament_id: tournamentId,
        p_mode:          mode,
      }), { retries: 0 }) as number | null;
      adminStatus.success(`Generated ${data} team${data === 1 ? '' : 's'}.`);
      await load();
      onTeamsChanged?.();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[mlp] generate_random_mlp_teams', e);
      adminStatus.errorFromRpc(e as { message?: string }, 'supabase/migration_add_mlp_teams.sql');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function generateBracket() {
    if (busyRef.current) return;
    busyRef.current = true;
    adminStatus.clear();
    setBusy(true);
    try {
      const data = await sbCall(() => supabase.rpc('generate_mlp_bracket', {
        p_tournament_id: tournamentId,
      }), { retries: 0 }) as number | null;
      adminStatus.success(`Generated ${data} sub-matches across team-vs-team rounds.`);
      onTeamsChanged?.();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[mlp] generate_mlp_bracket', e);
      adminStatus.errorFromRpc(e as { message?: string }, 'supabase/migration_add_mlp_teams.sql');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // ── Godmode helpers (MLP / Fixed Teams setup shortcuts) ─────────────
  const [inviteDetails, setInviteDetails] = useState<string[]>([]);

  async function godmodeConfirmMyInvites() {
    adminStatus.clear();
    setInviteDetails([]);
    setBusy(true);
    const { data, error } = await supabase.rpc('godmode_confirm_my_mlp_invites', {
      p_tournament_id: tournamentId,
    });
    setBusy(false);
    if (error) {
      console.warn('[mlp] godmode_confirm_my_mlp_invites', error);
      adminStatus.errorFromRpc(error, 'supabase/migration_godmode_mlp_helpers_v2.sql');
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    setInviteDetails((row?.details ?? []) as string[]);
    if ((row?.failed ?? 0) > 0 && (row?.accepted ?? 0) === 0) {
      adminStatus.error(row?.message ?? 'All invites failed.');
    } else {
      adminStatus.success(row?.message ?? 'Done.');
    }
    await load();
    onTeamsChanged?.();
  }

  async function godmodeForceFill() {
    adminStatus.clear();
    setBusy(true);
    const { data, error } = await supabase.rpc('godmode_force_fill_mlp_teams', {
      p_tournament_id: tournamentId,
    });
    setBusy(false);
    if (error) {
      console.warn('[mlp] godmode_force_fill_mlp_teams', error);
      adminStatus.errorFromRpc(error, 'supabase/migration_godmode_mlp_helpers_v2.sql');
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    adminStatus.success(row?.message ?? 'Done.');
    await load();
    onTeamsChanged?.();
  }

  async function godmodeDedupe() {
    adminStatus.clear();
    setBusy(true);
    const { data, error } = await supabase.rpc('godmode_dedupe_mlp_team_members', {
      p_tournament_id: tournamentId,
    });
    setBusy(false);
    if (error) {
      console.warn('[mlp] godmode_dedupe_mlp_team_members', error);
      adminStatus.errorFromRpc(error, 'supabase/migration_godmode_mlp_helpers_v2.sql');
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    adminStatus.success(row?.message ?? 'Done.');
    await load();
    onTeamsChanged?.();
  }

  // ── Render ──────────────────────────────────────────────────────────
  const closeCreateModal = useCallback(() => {
    setShowCreate(false);
    setNewTeamName('');
    setCreateError(null);
  }, []);

  if (loading) return <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: SPACE.xl }} />;

  const allLocked   = teams.length >= 2 && teams.every(t => t.status === 'locked');
  const onApproved  = !!currentUserId && approvedRegistrations.some(r => r.user_id === currentUserId && r.status === 'approved');
  const playersWithoutTeam = approvedRegistrations
    .filter(r => r.status === 'approved')
    .filter(r => !teams.some(t =>
      t.captain_id   === r.user_id ||
      t.male_1_id    === r.user_id || t.male_2_id   === r.user_id ||
      t.female_1_id  === r.user_id || t.female_2_id === r.user_id,
    ));

  return (
    <View style={S.root}>
      {!bare && (
        <View style={S.titleRow}>
          <Icon name={FORMAT_META[format].iconName} size={18} color={c.primary} />
          <Text style={S.title}>{FORMAT_META[format].label}</Text>
        </View>
      )}
      <Text style={S.subtitle}>
        Teams of 4 (2 men + 2 women). Each team-vs-team matchup is 4 doubles matches: men's, women's, and two mixed.
      </Text>
      <StatusBanner status={adminStatus.value} />

      {/* Mode-specific top action */}
      {format === 'mlp' && onApproved && !myTeam && tournamentStatus === 'registration' && (
        <View style={S.actionRow}>
          <Button iconName="plus" title="Create a Team" onPress={() => setShowCreate(true)} />
        </View>
      )}

      {format === 'mlp_random' && isPriv && tournamentStatus === 'registration' && (() => {
        // Pre-flight: gender counts among approved players. Wildcards (no
        // gender on profile) fill either side, so we count them toward
        // both possible team slots.
        const approved = approvedRegistrations.filter(r => r.status === 'approved');
        const males = approved.filter(r => {
          const g = approvedGenders[r.user_id];
          return g === 'male' || g === 'other';
        }).length;
        const females = approved.filter(r => approvedGenders[r.user_id] === 'female').length;
        const wildcards = approved.filter(r => {
          const g = approvedGenders[r.user_id];
          return !g || g === 'prefer-not-to-say';
        }).length;
        const total = males + females + wildcards;
        const teamsPossible = Math.floor(total / 4);
        const ok = teamsPossible >= 2;
        // Estimate balance: ideal is teamsPossible*2 per side. Wildcards bridge
        // the gap. If we can't make 2M+2F per team we say so — but still
        // proceed (function will create best-effort teams).
        const shortMale   = Math.max(0, teamsPossible * 2 - males);
        const shortFemale = Math.max(0, teamsPossible * 2 - females);
        const balanced = (shortMale + shortFemale) <= wildcards;
        return (
          <View>
            <View style={[S.preFlight, ok ? S.preFlightOk : S.preFlightWarn]}>
              <View style={[S.glyphRow, S.preFlightTitleRow]}>
                <Icon name={ok ? 'check-mark' : 'warning'} size={14} color={ok ? c.primary : c.warning} />
                <Text style={[S.preFlightTitle, ok ? S.preFlightOkText : S.preFlightWarnText]}>
                  {ok ? `${teamsPossible} teams possible` : 'Not enough players yet'}
                </Text>
              </View>
              <View
                style={S.genderCounts}
                accessible
                accessibilityLabel={`${males} men, ${females} women${wildcards > 0 ? `, ${wildcards} wildcard${wildcards === 1 ? '' : 's'}` : ''}, ${total} total`}
              >
                <Icon name="male" size={12} color={c.info} />
                <Text style={S.preFlightBody}>{males} ·</Text>
                <Icon name="female" size={12} color={c.rarityRare} />
                <Text style={S.preFlightBody}>{females}</Text>
                {wildcards > 0 ? (
                  <>
                    <Text style={S.preFlightBody}>·</Text>
                    <Icon name="gender-any" size={12} color={c.primary} />
                    <Text style={S.preFlightBody}>{wildcards} wildcard{wildcards === 1 ? '' : 's'}</Text>
                  </>
                ) : null}
                <Text style={S.preFlightBody}>({total} total)</Text>
              </View>
              {!ok && (
                <Text style={S.preFlightBody}>
                  Need at least <Text style={S.heavy}>8 approved players</Text> total to form 2 teams.
                </Text>
              )}
              {ok && !balanced && (
                <Text style={S.preFlightBody}>
                  Best-effort balance: not enough wildcards to perfectly fill 2 men + 2 women per team. Some teams may be lopsided.
                </Text>
              )}
            </View>
            <View style={S.adminRow}>
              <TouchableOpacity
                style={[S.adminBtn, (busy || !ok) && S.btnDim]}
                onPress={() => generateRandomTeams('random')}
                disabled={busy || !ok}
                accessibilityRole="button"
              >
                <Icon name="dice" size={14} color={c.primary} />
                <Text style={S.adminBtnText}>Generate Random</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[S.adminBtn, (busy || !ok) && S.btnDim]}
                onPress={() => generateRandomTeams('snake')}
                disabled={busy || !ok}
                accessibilityRole="button"
              >
                <Icon name="scale" size={14} color={c.primary} />
                <Text style={S.adminBtnText}>Snake-Draft (balanced)</Text>
              </TouchableOpacity>
            </View>
            <StatusBanner status={adminStatus.value} />
          </View>
        );
      })()}

      {/* Teams list */}
      {teams.length === 0 && (
        <EmptyState
          title={format === 'mlp_random'
            ? 'No teams yet — admin will generate them once registration is closed.'
            : 'No teams yet — be the first to create one!'}
        />
      )}

      {teams.map(t => {
        const captain     = t.captain_id ? profileMap[t.captain_id] : null;
        const teamFullN   = teamFull(t);
        const isMyTeam    = myTeam?.id === t.id;
        const myReqHere   = requests.find(r => r.team_id === t.id && r.user_id === currentUserId);
        const teamReqs    = requests.filter(r => r.team_id === t.id);

        return (
          <View key={t.id} style={S.teamCard}>
            <View style={S.teamHeader}>
              <View style={S.teamTitleCol}>
                <View style={S.glyphRow}>
                  {t.is_random_generated ? (
                    <Icon name="dice" size={14} color={c.textSub} accessibilityLabel="Randomly drawn" />
                  ) : null}
                  <Text style={[S.teamName, S.shrink]} numberOfLines={1}>{t.name}</Text>
                </View>
                {captain && (
                  <View style={[S.glyphRow, S.teamCaptainRow]}>
                    <Icon name="crown" size={12} color={c.rarityLegendary} accessibilityLabel="Captain" />
                    <Text style={[S.teamCaptain, S.shrink]} numberOfLines={1}>{captain.full_name}</Text>
                  </View>
                )}
              </View>
              <View style={[S.statusBadge, t.status === 'locked' ? S.statusLocked : S.statusForming]}>
                {t.status === 'locked' ? <Icon name="lock" size={12} color={c.primary} /> : null}
                <Text style={[S.statusText, t.status === 'locked' ? S.statusLockedText : S.statusFormingText]}>
                  {t.status === 'locked' ? 'Locked' : 'Forming'}
                </Text>
              </View>
            </View>

            {/* Roster */}
            <View style={S.roster}>
              {SLOT_ORDER.map(slot => {
                const member = teamSlotMember(t, slot);
                return (
                  <View key={slot} style={S.slotRow}>
                    <Text style={S.slotLabel}>{SLOT_LABEL[slot]}</Text>
                    <Text style={S.slotName} numberOfLines={1}>
                      {member ? member.full_name : <Text style={S.slotEmpty}>— empty —</Text>}
                    </Text>
                    {/* Captain can clear slots while forming */}
                    {format === 'mlp' && isMyTeam && isCaptain && t.status === 'forming' && member && (
                      <TouchableOpacity
                        style={S.removeBox}
                        onPress={() => clearSlot(t.id, slot)}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${member.full_name}`}
                      >
                        <Icon name="close" size={16} color={c.danger} />
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>

            {/* Schema-only for now: a follow-up wires the actual 5th sub-match
                generation. Setting it here just persists the captain's pick. */}
            {((isCaptain && isMyTeam) || isPriv) && (
              <View style={S.dreambreakerRow}>
                <Text style={S.dreambreakerLabel}>Dreambreaker:</Text>
                <View style={S.dreambreakerPills}>
                  {SLOT_ORDER.map(slot => {
                    const pid = t[`${slot}_id` as const] as string | null;
                    const selected = !!pid && t.dreambreaker_player_id === pid;
                    const disabled = !pid || busy;
                    const member = pid ? profileMap[pid] : null;
                    const label = member?.full_name ?? SLOT_LABEL[slot];
                    return (
                      <TouchableOpacity
                        key={slot}
                        style={[S.dreambreakerPill, selected && S.dreambreakerPillSelected, disabled && S.btnDim]}
                        onPress={() => setDreambreaker(t.id, selected ? null : pid)}
                        disabled={disabled}
                        accessibilityRole="button"
                        accessibilityLabel={`Dreambreaker: ${label}`}
                        accessibilityState={{ selected, disabled }}
                      >
                        <Text style={[S.dreambreakerPillText, selected && S.dreambreakerPillTextSelected]} numberOfLines={1}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Captain controls */}
            {format === 'mlp' && isMyTeam && isCaptain && t.status === 'forming' && (
              <View style={S.captainPanel}>
                {!teamFullN && (
                  <TouchableOpacity
                    style={S.captainBtn}
                    onPress={() => setInvitingTeamId(t.id)}
                    accessibilityRole="button"
                  >
                    <Icon name="plus" size={14} color={c.primary} />
                    <Text style={S.captainBtnText}>Invite a player</Text>
                  </TouchableOpacity>
                )}

                {/* Captain isn't in any slot → let them re-add themselves */}
                {currentUserId &&
                  t.captain_id === currentUserId &&
                  t.male_1_id   !== currentUserId &&
                  t.male_2_id   !== currentUserId &&
                  t.female_1_id !== currentUserId &&
                  t.female_2_id !== currentUserId && (
                  <TouchableOpacity
                    style={[S.captainBtn, S.captainBtnGap]}
                    onPress={() => captainJoinOwnTeam(t)}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <Icon name="plus" size={14} color={c.primary} />
                    <Text style={S.captainBtnText}>Add me to a slot</Text>
                  </TouchableOpacity>
                )}

                {teamReqs.filter(r => r.direction === 'request').length > 0 && (
                  <View style={S.reqList}>
                    <Text style={S.reqListTitle}>Pending requests to join</Text>
                    {teamReqs.filter(r => r.direction === 'request').map(r => {
                      const u = profileMap[r.user_id];
                      return (
                        <View key={r.id} style={S.reqRow}>
                          <Text style={S.reqName} numberOfLines={1}>{u?.full_name ?? 'Unknown'}</Text>
                          <Button
                            size="sm"
                            title="Accept"
                            onPress={() => respondToRequest(r.id, true)}
                            accessibilityLabel={`Accept ${u?.full_name ?? 'this player'}'s request`}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            title="Decline"
                            onPress={() => respondToRequest(r.id, false)}
                            accessibilityLabel={`Decline ${u?.full_name ?? 'this player'}'s request`}
                          />
                        </View>
                      );
                    })}
                  </View>
                )}

                {teamReqs.filter(r => r.direction === 'invite').length > 0 && (
                  <View style={S.reqList}>
                    <Text style={S.reqListTitle}>Outstanding invites</Text>
                    {teamReqs.filter(r => r.direction === 'invite').map(r => {
                      const u = profileMap[r.user_id];
                      return (
                        <View key={r.id} style={S.reqRow}>
                          <Text style={S.reqName} numberOfLines={1}>{u?.full_name ?? 'Unknown'}</Text>
                          <Text style={S.reqWaiting}>awaiting reply</Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                {teamFullN && (
                  <Button iconName="lock" title="Lock In Team" onPress={() => lockTeam(t.id)} disabled={busy} style={S.lockBtn} />
                )}
              </View>
            )}

            {/* Leave Team — non-captain members only */}
            {format === 'mlp' && isMyTeam && !isCaptain && t.status === 'forming' && tournamentStatus === 'registration' && (
              <TouchableOpacity
                style={S.leaveBtn}
                onPress={() => setLeaveConfirm({ teamId: t.id, teamName: t.name, asCaptain: false })}
                disabled={busy}
              >
                <Icon name="logout" size={16} color={c.danger} />
                <Text style={S.leaveBtnText}>Leave Team</Text>
              </TouchableOpacity>
            )}

            {/* Disband Team — captain only, separate destructive action */}
            {format === 'mlp' && isMyTeam && isCaptain && t.status === 'forming' && tournamentStatus === 'registration' && (
              <Button
                variant="danger"
                iconName="trash"
                title="Disband Team"
                onPress={() => setLeaveConfirm({ teamId: t.id, teamName: t.name, asCaptain: true })}
                disabled={busy}
                style={S.disbandBtn}
              />
            )}

            {/* Player POV — invite to me */}
            {format === 'mlp' && !isMyTeam && t.status === 'forming' && currentUserId
              && myReqHere?.direction === 'invite' && myReqHere?.status === 'pending' && (
              <View style={S.captainPanel}>
                <Text style={S.captainBtnText}>You've been invited to this team.</Text>
                <View style={S.inviteBtnRow}>
                  <Button size="sm" title="Accept Invite" onPress={() => respondToRequest(myReqHere.id, true)} />
                  <Button size="sm" variant="outline" title="Decline" onPress={() => respondToRequest(myReqHere.id, false)} />
                </View>
              </View>
            )}

            {/* Player POV — request to join */}
            {format === 'mlp' && !myTeam && !isMyTeam && t.status === 'forming' && onApproved && !teamFullN && !myReqHere && tournamentStatus === 'registration' && (
              <TouchableOpacity style={S.requestBtn} onPress={() => requestJoin(t.id)} disabled={busy} accessibilityRole="button">
                <Text style={S.requestBtnText}>Request to Join</Text>
              </TouchableOpacity>
            )}

            {/* "Already requested" indicator */}
            {format === 'mlp' && !isMyTeam && myReqHere?.direction === 'request' && (
              <View style={[S.glyphRow, S.pendingRow]}>
                <Icon name="hourglass" size={12} color={c.warning} />
                <Text style={S.pendingNote}>Your join request is pending.</Text>
              </View>
            )}
          </View>
        );
      })}

      {/* Players without a team — captain gets a one-tap invite per row */}
      {format === 'mlp' && tournamentStatus === 'registration' && playersWithoutTeam.length > 0 && (() => {
        const cap = isCaptain ? myTeam : null;
        const maleOpenings   = cap ? (cap.male_1_id   == null ? 1 : 0) + (cap.male_2_id   == null ? 1 : 0) : 0;
        const femaleOpenings = cap ? (cap.female_1_id == null ? 1 : 0) + (cap.female_2_id == null ? 1 : 0) : 0;
        const canCaptainInvite = !!cap && cap.status === 'forming';

        return (
          <View style={S.unteamedBox}>
            <View style={S.unteamedHeader}>
              <Text style={S.unteamedTitle}>
                {playersWithoutTeam.length} approved player{playersWithoutTeam.length === 1 ? '' : 's'} not yet on a team
              </Text>
              {canCaptainInvite && (
                <View
                  style={S.glyphRow}
                  accessible
                  accessibilityLabel={`Your team: ${maleOpenings} men's slot${maleOpenings === 1 ? '' : 's'} open, ${femaleOpenings} women's slot${femaleOpenings === 1 ? '' : 's'} open`}
                >
                  <Text style={S.unteamedSlots}>Your team:</Text>
                  <Icon name="male" size={12} color={c.info} />
                  <Text style={S.unteamedSlots}>{maleOpenings} open ·</Text>
                  <Icon name="female" size={12} color={c.rarityRare} />
                  <Text style={S.unteamedSlots}>{femaleOpenings} open</Text>
                </View>
              )}
            </View>
            <View style={S.unteamedList}>
              {playersWithoutTeam.map(r => {
                const prof = profileMap[r.user_id];
                const gender = prof?.gender;
                const isFemale = gender === 'female';
                const genderHasOpening = canCaptainInvite && (isFemale ? femaleOpenings > 0 : maleOpenings > 0);
                const existingFromCap = canCaptainInvite
                  ? requests.find(rq => rq.team_id === cap!.id && rq.user_id === r.user_id)
                  : null;
                const alreadyInvited  = existingFromCap?.direction === 'invite';
                const alreadyRequested = existingFromCap?.direction === 'request';

                return (
                  <View key={r.user_id} style={S.unteamedRow}>
                    <Text style={S.unteamedRowName} numberOfLines={1}>
                      {prof?.full_name ?? r.profile?.full_name ?? '?'}
                    </Text>
                    {/* Gender chip: male info, female rare purple, other the
                        brand; the glyph carries the meaning, so it is labelled. */}
                    <View
                      style={[
                        S.unteamedGender,
                        isFemale ? S.unteamedGenderF : gender === 'male' ? S.unteamedGenderM : S.unteamedGenderO,
                      ]}
                      accessible
                      accessibilityLabel={isFemale ? 'Female' : gender === 'male' ? 'Male' : gender ? 'Other gender' : 'Gender not set'}
                    >
                      {isFemale ? (
                        <>
                          <Icon name="female" size={12} color={c.rarityRare} />
                          <Text style={[S.unteamedGenderText, { color: c.rarityRare }]}>F</Text>
                        </>
                      ) : gender === 'male' ? (
                        <>
                          <Icon name="male" size={12} color={c.info} />
                          <Text style={[S.unteamedGenderText, { color: c.info }]}>M</Text>
                        </>
                      ) : gender ? (
                        <Icon name="gender-any" size={12} color={c.primary} />
                      ) : (
                        <Text style={S.unteamedGenderText}>?</Text>
                      )}
                    </View>
                    {canCaptainInvite && (
                      alreadyInvited ? (
                        <View style={S.glyphRow}>
                          <Icon name="mail" size={12} color={c.rarityLegendary} />
                          <Text style={S.unteamedInvited}>invited</Text>
                        </View>
                      ) : alreadyRequested ? (
                        <View style={S.glyphRow}>
                          <Icon name="hourglass" size={12} color={c.primary} />
                          <Text style={S.unteamedRequested}>requested</Text>
                        </View>
                      ) : genderHasOpening ? (
                        <TouchableOpacity
                          style={S.unteamedInviteBtn}
                          onPress={() => pickInvitee(cap!.id, {
                            id: r.user_id,
                            full_name: prof?.full_name ?? r.profile?.full_name ?? '',
                            username: '',
                            avatar_id: null,
                            avatar_emoji: null,
                            avatar_bg_color: null,
                          })}
                          disabled={busy}
                          accessibilityRole="button"
                          accessibilityLabel={`Invite ${prof?.full_name ?? r.profile?.full_name ?? 'this player'}`}
                        >
                          <View style={S.unteamedInvitePill}>
                            <Icon name="plus" size={12} color={c.textInverse} />
                            <Text style={S.unteamedInviteBtnText}>Invite</Text>
                          </View>
                        </TouchableOpacity>
                      ) : (
                        <Text style={S.unteamedFull}>slots full</Text>
                      )
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })()}

      {/* Godmode shortcuts (Brian only) — MLP Fixed Teams setup helpers */}
      {isGodmodeUserId(currentUserId) && format === 'mlp' && tournamentStatus === 'registration' && (() => {
        const myPendingInvites = requests.filter(r =>
          r.direction === 'invite' && r.status === 'pending'
          && teams.some(t => t.id === r.team_id && t.captain_id === currentUserId)
        ).length;
        const leftover = playersWithoutTeam.length;
        return (
          <View style={[S.godmodeBox, S.sectionGap]}>
            <View style={[S.glyphRow, S.godmodeTitleRow]}>
              <Icon name="sparkle" size={14} color={c.rarityRare} />
              <Text style={S.godmodeTitle}>Godmode shortcuts</Text>
            </View>
            <TouchableOpacity
              style={[S.godmodeBtn, (busy || myPendingInvites === 0) && S.btnDim]}
              onPress={godmodeConfirmMyInvites}
              disabled={busy || myPendingInvites === 0}
              accessibilityRole="button"
            >
              <Icon name="check-mark" size={14} color={c.textInverse} />
              <Text style={S.godmodeBtnText}>
                Confirm my pending invites ({myPendingInvites})
              </Text>
            </TouchableOpacity>
            {inviteDetails.length > 0 && (
              <View style={S.godmodeDetailsBox}>
                {inviteDetails.map((d, i) => (
                  // The server writes these lines; a failure line starts with its ✗.
                  <Text key={i} style={[S.godmodeDetailLine, d.startsWith('✗') && S.godmodeDetailLineFail]}>
                    {d}
                  </Text>
                ))}
              </View>
            )}
            <TouchableOpacity
              style={[S.godmodeBtn, (busy || leftover < 4) && S.btnDim, S.godmodeBtnGap]}
              onPress={godmodeForceFill}
              disabled={busy || leftover < 4}
              accessibilityRole="button"
            >
              <Icon name="bolt" size={14} color={c.textInverse} />
              <Text style={S.godmodeBtnText}>
                Force-fill remaining teams ({leftover} player{leftover === 1 ? '' : 's'} unassigned)
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.godmodeBtn, busy && S.btnDim, S.godmodeBtnGap, S.godmodeBtnDanger]}
              onPress={godmodeDedupe}
              disabled={busy}
              accessibilityRole="button"
            >
              <Icon name="trash" size={14} color={c.textInverse} />
              <Text style={S.godmodeBtnText}>
                Dedupe team members (cleanup from v1 bug)
              </Text>
            </TouchableOpacity>
            <StatusBanner status={adminStatus.value} />
          </View>
        );
      })()}

      {/* Generate bracket */}
      {isPriv && !bracketAlreadyGenerated && (() => {
        const lockedCount = teams.filter(t => t.status === 'locked').length;
        const formingCount = teams.filter(t => t.status === 'forming').length;
        const ok = lockedCount >= 2;
        return (
          <View>
            <View style={[S.preFlight, ok ? S.preFlightOk : S.preFlightWarn, S.sectionGap]}>
              <View style={[S.glyphRow, S.preFlightTitleRow]}>
                <Icon name={ok ? 'check-mark' : 'warning'} size={14} color={ok ? c.primary : c.warning} />
                <Text style={[S.preFlightTitle, S.shrink, ok ? S.preFlightOkText : S.preFlightWarnText]}>
                  {ok ? `${lockedCount} locked team${lockedCount === 1 ? '' : 's'} — ready for bracket` : 'Not enough locked teams'}
                </Text>
              </View>
              <Text style={S.preFlightBody}>
                {lockedCount} locked
                {formingCount > 0 ? ` · ${formingCount} still forming` : ''}
              </Text>
              {!ok && (
                <Text style={S.preFlightBody}>
                  Need at least <Text style={S.heavy}>2 locked teams</Text> to generate the bracket. {format === 'mlp_random' ? 'Use Generate Random / Snake-Draft above to fill them.' : 'Captains lock their team once all 4 slots are filled.'}
                </Text>
              )}
            </View>
            <Button
              iconName="bolt"
              title="Generate Bracket"
              onPress={generateBracket}
              disabled={busy || !ok}
              style={S.generateBtn}
            />
            <StatusBanner status={adminStatus.value} />
          </View>
        );
      })()}

      {/* Playoff generates automatically when all pool/RR matches finish —
          via _maybe_auto_advance_mlp_playoff trigger. No manual button. */}

      {/* Create team modal */}
      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={closeCreateModal}>
        <Pressable style={S.modalBackdrop} onPress={(e) => { if (e.target === e.currentTarget) closeCreateModal(); }}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Create your team</Text>
            <Text style={S.modalBody}>
              You'll become the captain. Pick a name now — you can invite teammates after.
            </Text>
            <Text style={S.modalLabel}>Team name</Text>
            <TextInput
              style={[S.modalInput, webInputFontFloor(S.modalInput)]}
              placeholder="e.g. Dink Dynasty"
              placeholderTextColor={c.textMuted}
              value={newTeamName}
              onChangeText={t => { setNewTeamName(t); if (createError) setCreateError(null); }}
              maxLength={40}
              autoFocus
            />
            {createError && (
              <Text style={S.modalErrorText}>{createError}</Text>
            )}
            <View style={S.modalBtnRow}>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnSecondary]} onPress={closeCreateModal}>
                <Text style={S.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnPrimary, (busy || !newTeamName.trim()) && S.modalBtnDim]} onPress={createTeam} disabled={busy || !newTeamName.trim()}>
                {busy ? <ActivityIndicator color={c.textInverse} /> : <Text style={S.modalBtnPrimaryText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
        {/* Toasts and the pickle rain show above this Modal. */}
        <ToastOutlet />
      </Modal>

      {/* Invite user picker */}
      {invitingTeamId && (
        <UserPickerModal
          visible={!!invitingTeamId}
          title="Invite a player"
          excludeUserIds={[
            ...(currentUserId ? [currentUserId] : []),
            ...teams.flatMap(t =>
              [t.captain_id, t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].filter(Boolean) as string[]
            ),
          ]}
          onPick={u => pickInvitee(invitingTeamId!, u)}
          onClose={() => setInvitingTeamId(null)}
        />
      )}

      <ConfirmModal
        visible={!!pendingInvite}
        title="Send invite?"
        body={pendingInvite
          ? `Invite ${pendingInvite.user.full_name} to join ${pendingInvite.teamName}? They'll get a notification and can accept or decline.`
          : ''}
        primaryLabel="Send Invite"
        variant="primary"
        busy={busy}
        error={inviteError}
        onConfirm={confirmInvite}
        onClose={() => { setPendingInvite(null); setInviteError(null); }}
      />

      <ConfirmModal
        visible={!!leaveConfirm}
        title={leaveConfirm?.asCaptain ? `Disband "${leaveConfirm?.teamName}"?` : `Leave "${leaveConfirm?.teamName}"?`}
        body={leaveConfirm?.asCaptain
          ? "You're the captain. Disbanding deletes the team and removes every member from it. Pending invites and join requests for this team will also be cancelled. This cannot be undone."
          : "You'll be removed from this team. You can request to join another team or create your own after."}
        primaryLabel={leaveConfirm?.asCaptain ? 'Disband team' : 'Leave team'}
        variant="danger"
        busy={busy}
        error={leaveError}
        onConfirm={confirmLeaveTeam}
        onClose={() => { setLeaveConfirm(null); setLeaveError(null); }}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  const W = FONT.weight;
  return StyleSheet.create({
    root:     { marginTop: SPACE.sm },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.xs },
    title:    { ...t.h3, fontWeight: W.black, flexShrink: 1 },
    subtitle: { ...t.hint, marginBottom: SPACE.md },
    // A glyph beside its words (decorative unless the Icon has a label).
    glyphRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    shrink:   { flexShrink: 1, minWidth: 0 },
    heavy:    { fontWeight: W.heavy },
    sectionGap: { marginTop: SPACE.md },

    actionRow: { marginBottom: SPACE.md },

    adminRow: { flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.md },
    adminBtn:     { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.sm, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.primary, borderRadius: RADIUS.md },

    preFlight:        { borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.sm, borderLeftWidth: 4 },
    preFlightOk:      { backgroundColor: c.primaryLight, borderLeftColor: c.primary },
    preFlightWarn:    { backgroundColor: c.warningLight, borderLeftColor: c.warning },
    preFlightTitleRow:{ marginBottom: SPACE.xxs },
    preFlightTitle:   { fontSize: FONT.size.base, fontWeight: W.heavy },
    preFlightOkText:  { color: c.primary },
    preFlightWarnText:{ color: c.warning },
    preFlightBody:    { fontSize: FONT.size.sm, color: c.textSub, lineHeight: 17 },
    genderCounts:     { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },

    adminBtnText: { color: c.primary, fontWeight: W.bold, fontSize: FONT.size.base },
    btnDim:       { opacity: 0.5 },

    // Godmode (developer only): the rare purple, from theme tokens.
    godmodeBox:      { backgroundColor: c.rarityRareLight, borderRadius: RADIUS.lg, padding: SPACE.md, borderWidth: 1.5, borderColor: c.rarityRare },
    godmodeTitleRow: { marginBottom: SPACE.sm },
    godmodeTitle:    { fontSize: FONT.size.base, fontWeight: W.black, color: c.rarityRare },
    godmodeBtn:      { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, backgroundColor: c.rarityRare, borderRadius: RADIUS.md, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md },
    godmodeBtnGap:   { marginTop: SPACE.sm },
    godmodeBtnDanger:{ backgroundColor: c.danger },
    godmodeBtnText:  { flexShrink: 1, color: c.textInverse, fontWeight: W.heavy, fontSize: FONT.size.base, textAlign: 'center' },
    godmodeDetailsBox:    { marginTop: SPACE.sm, padding: SPACE.sm, backgroundColor: c.surface, borderRadius: RADIUS.sm, borderWidth: HAIRLINE, borderColor: c.rarityRare },
    godmodeDetailLine:    { fontSize: FONT.size.xs, color: c.text, marginVertical: 1 },
    godmodeDetailLineFail:{ color: c.danger },

    teamCard:    { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    teamHeader:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm },
    teamTitleCol:{ flex: 1, minWidth: 0 },
    teamName:    { fontSize: FONT.size.lg, fontWeight: W.heavy, color: c.text },
    teamCaptainRow: { marginTop: SPACE.xxs },
    teamCaptain: { fontSize: FONT.size.sm, color: c.textSub },
    statusBadge: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill, borderWidth: HAIRLINE },
    statusForming:     { backgroundColor: c.warningLight, borderColor: c.warning },
    statusFormingText: { color: c.warning },
    statusLocked:      { backgroundColor: c.primaryLight, borderColor: c.primary },
    statusLockedText:  { color: c.primary },
    statusText:        { fontSize: FONT.size.xs, fontWeight: W.bold },

    roster:    { gap: SPACE.xs },
    slotRow:   { flexDirection: 'row', alignItems: 'center', minHeight: 28, paddingVertical: SPACE.xs, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    slotLabel: { ...t.fieldLabel, width: 90, letterSpacing: 0.5 },
    slotName:  { flex: 1, fontSize: FONT.size.md, color: c.text },
    slotEmpty: { color: c.textMuted, fontStyle: 'italic' },
    // 44 tap box that doesn't grow the row (web ignores hitSlop).
    removeBox: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -SPACE.md, marginRight: -SPACE.md },

    dreambreakerRow:    { marginTop: SPACE.sm, paddingTop: SPACE.sm, borderTopWidth: HAIRLINE, borderTopColor: c.border },
    dreambreakerLabel:  { ...t.fieldLabel, letterSpacing: 0.5, marginBottom: SPACE.xs },
    dreambreakerPills:  { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
    dreambreakerPill:   { minHeight: 32, justifyContent: 'center', paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill, borderWidth: HAIRLINE, borderColor: c.border, backgroundColor: c.surfaceAlt },
    dreambreakerPillSelected:    { backgroundColor: c.primary, borderColor: c.primary },
    dreambreakerPillText:        { fontSize: FONT.size.sm, fontWeight: W.bold, color: c.textSub, maxWidth: 140 },
    dreambreakerPillTextSelected:{ color: c.textInverse },

    captainPanel:    { marginTop: SPACE.md, paddingTop: SPACE.sm, borderTopWidth: HAIRLINE, borderTopColor: c.border },
    captainBtn:      { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border },
    captainBtnGap:   { marginTop: SPACE.sm },
    captainBtnText:  { fontSize: FONT.size.base, color: c.primary, fontWeight: W.bold },

    reqList:      { marginTop: SPACE.sm },
    reqListTitle: { ...t.fieldLabel, letterSpacing: 0.5, marginBottom: SPACE.xs },
    reqRow:       { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 32 },
    reqName:      { flex: 1, fontSize: FONT.size.base, color: c.text },
    reqWaiting:   { ...t.caption, fontStyle: 'italic' },
    inviteBtnRow: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },

    lockBtn:     { marginTop: SPACE.sm },
    leaveBtn:    { marginTop: SPACE.md, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.danger, backgroundColor: c.surface },
    leaveBtnText:{ color: c.danger, fontWeight: W.bold, fontSize: FONT.size.base },
    disbandBtn:  { marginTop: SPACE.md },

    requestBtn:     { marginTop: SPACE.sm, minHeight: 44, justifyContent: 'center', backgroundColor: c.primaryLight, borderRadius: RADIUS.md, alignItems: 'center', borderWidth: 1.5, borderColor: c.primary },
    requestBtnText: { color: c.primary, fontWeight: W.bold, fontSize: FONT.size.base },

    pendingRow:  { justifyContent: 'center', marginTop: SPACE.sm },
    pendingNote: { fontSize: FONT.size.sm, color: c.textMuted, fontStyle: 'italic', textAlign: 'center' },

    unteamedBox:   { backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    unteamedTitle: { fontSize: FONT.size.sm, fontWeight: W.bold, color: c.textSub },
    unteamedHeader:{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', rowGap: SPACE.xxs },
    unteamedSlots: { fontSize: FONT.size.xs, color: c.textMuted, fontWeight: W.semibold },
    unteamedList:  { marginTop: SPACE.sm, gap: SPACE.xs },
    unteamedRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 36, paddingVertical: SPACE.xs, paddingHorizontal: SPACE.sm, backgroundColor: c.surface, borderRadius: RADIUS.sm },
    unteamedRowName: { flex: 1, fontSize: FONT.size.base, fontWeight: W.semibold, color: c.text },
    unteamedGender:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, paddingHorizontal: SPACE.xs, paddingVertical: SPACE.xxs, borderRadius: RADIUS.sm },
    unteamedGenderM: { backgroundColor: c.infoLight },
    unteamedGenderF: { backgroundColor: c.rarityRareLight },
    unteamedGenderO: { backgroundColor: c.primaryLight },
    unteamedGenderText: { fontSize: FONT.size.xxs, fontWeight: W.heavy, color: c.textSub },
    // 44 tap box around the small pill, without growing the row.
    unteamedInviteBtn: { minHeight: 44, justifyContent: 'center', marginVertical: -SPACE.sm },
    unteamedInvitePill: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xxs, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.sm, backgroundColor: c.primary },
    unteamedInviteBtnText: { fontSize: FONT.size.sm, fontWeight: W.heavy, color: c.textInverse },
    unteamedInvited:   { fontSize: FONT.size.xs, fontWeight: W.bold, color: c.rarityLegendary },
    unteamedRequested: { fontSize: FONT.size.xs, fontWeight: W.bold, color: c.primary },
    unteamedFull:      { fontSize: FONT.size.xs, fontWeight: W.semibold, color: c.textMuted },

    generateBtn:     { marginTop: SPACE.lg },

    modalBackdrop: { flex: 1, backgroundColor: c.backdrop, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl },
    modalCard:     { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.lg, width: '100%', maxWidth: 420 },
    modalTitle:    { ...t.h3, fontWeight: W.black, marginBottom: SPACE.xs },
    modalBody:     { ...t.sub, marginBottom: SPACE.md },
    modalLabel:    { ...t.fieldLabel, fontSize: FONT.size.sm, marginBottom: SPACE.xs },
    modalInput:    { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface, marginBottom: SPACE.lg },
    modalBtnRow:   { flexDirection: 'row', gap: SPACE.sm },
    modalBtn:      { flex: 1, minHeight: 44, justifyContent: 'center', paddingVertical: SPACE.md, borderRadius: RADIUS.md, alignItems: 'center' },
    modalBtnPrimary:    { backgroundColor: c.primary },
    modalBtnPrimaryText:{ color: c.textInverse, fontWeight: W.heavy, fontSize: FONT.size.md },
    modalBtnSecondary:  { backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    modalBtnSecondaryText: { color: c.textSub, fontWeight: W.bold, fontSize: FONT.size.md },
    modalBtnDim:           { opacity: 0.5 },
    modalErrorText:        { fontSize: FONT.size.sm, color: c.danger, marginBottom: SPACE.md, lineHeight: 17 },
  });
}
