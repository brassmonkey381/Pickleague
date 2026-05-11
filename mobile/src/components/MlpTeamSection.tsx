import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  Alert, Modal, TextInput, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { MlpTeam, MlpTeamJoinRequest, MlpTeamSlot, TournamentRegistration } from '../types';
import UserPickerModal, { PickedUser } from './UserPickerModal';

type Props = {
  tournamentId: string;
  format: 'mlp' | 'mlp_random';
  tournamentStatus: string;
  isPriv: boolean;
  currentUserId: string | null;
  approvedRegistrations: TournamentRegistration[];
  bracketAlreadyGenerated: boolean;
  onTeamsChanged?: () => void;
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
  tournamentId, format, tournamentStatus, isPriv, currentUserId,
  approvedRegistrations, bracketAlreadyGenerated, onTeamsChanged,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [teams, setTeams]               = useState<MlpTeam[]>([]);
  const [requests, setRequests]         = useState<MlpTeamJoinRequest[]>([]);
  const [profileMap, setProfileMap]     = useState<Record<string, ProfileLite>>({});
  const [loading, setLoading]           = useState(true);
  const [busy, setBusy]                 = useState(false);

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
    setCreateError(null);
    const trimmed = newTeamName.trim();
    if (!trimmed) {
      setCreateError('Pick a team name first.');
      return;
    }
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
      setCreateError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function requestJoin(teamId: string) {
    setBusy(true);
    const { error } = await supabase.rpc('mlp_request_join', {
      p_team_id: teamId,
      p_message: null,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    Alert.alert('Request sent', 'The captain will see your request.');
    await load();
  }

  async function respondToRequest(reqId: string, accept: boolean) {
    setBusy(true);
    const { error } = await supabase.rpc('mlp_respond_to_join', {
      p_request_id: reqId,
      p_accept:     accept,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    await load();
    onTeamsChanged?.();
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
    if (!pendingInvite) return;
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
      setInviteError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearSlot(teamId: string, slot: MlpTeamSlot) {
    setBusy(true);
    const { error } = await supabase.rpc('mlp_set_slot', {
      p_team_id: teamId,
      p_slot:    slot,
      p_user_id: null,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    await load();
    onTeamsChanged?.();
  }

  async function lockTeam(teamId: string) {
    setBusy(true);
    const { error } = await supabase.rpc('mlp_lock_team', { p_team_id: teamId });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    await load();
    onTeamsChanged?.();
  }

  async function confirmLeaveTeam() {
    if (!leaveConfirm) return;
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
      setLeaveError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateRandomTeams(mode: 'random' | 'snake') {
    setBusy(true);
    const { data, error } = await supabase.rpc('generate_random_mlp_teams', {
      p_tournament_id: tournamentId,
      p_mode:          mode,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    Alert.alert('Teams generated', `${data} team${data === 1 ? '' : 's'} created.`);
    await load();
    onTeamsChanged?.();
  }

  async function generateBracket() {
    setBusy(true);
    const { data, error } = await supabase.rpc('generate_mlp_bracket', {
      p_tournament_id: tournamentId,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    Alert.alert('Bracket generated', `${data} sub-matches created across team-vs-team rounds.`);
    onTeamsChanged?.();
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (loading) return <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 24 }} />;

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
      <Text style={S.title}>{format === 'mlp_random' ? '🎲 MLP / Random Teams' : '🤝 MLP / Fixed Teams'}</Text>
      <Text style={S.subtitle}>
        Teams of 4 (2 men + 2 women). Each team-vs-team matchup is 4 doubles matches: men's, women's, and two mixed.
      </Text>

      {/* Mode-specific top action */}
      {format === 'mlp' && onApproved && !myTeam && tournamentStatus === 'registration' && (
        <View style={S.actionRow}>
          <TouchableOpacity style={S.primaryBtn} onPress={() => setShowCreate(true)}>
            <Text style={S.primaryBtnText}>+ Create a Team</Text>
          </TouchableOpacity>
        </View>
      )}

      {format === 'mlp_random' && isPriv && tournamentStatus === 'registration' && (
        <View style={S.adminRow}>
          <TouchableOpacity style={[S.adminBtn, busy && S.btnDim]} onPress={() => generateRandomTeams('random')} disabled={busy}>
            <Text style={S.adminBtnText}>🎲 Generate Random</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[S.adminBtn, busy && S.btnDim]} onPress={() => generateRandomTeams('snake')} disabled={busy}>
            <Text style={S.adminBtnText}>🐍 Snake-Draft (balanced)</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Teams list */}
      {teams.length === 0 && (
        <Text style={S.empty}>
          {format === 'mlp_random'
            ? 'No teams yet — admin will generate them once registration is closed.'
            : 'No teams yet — be the first to create one!'}
        </Text>
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
              <View style={{ flex: 1 }}>
                <Text style={S.teamName} numberOfLines={1}>
                  {t.is_random_generated ? '🎲 ' : ''}{t.name}
                </Text>
                {captain && <Text style={S.teamCaptain}>👑 {captain.full_name}</Text>}
              </View>
              <View style={[S.statusBadge, t.status === 'locked' ? S.statusLocked : S.statusForming]}>
                <Text style={[S.statusText, t.status === 'locked' ? S.statusLockedText : S.statusFormingText]}>
                  {t.status === 'locked' ? '🔒 Locked' : 'Forming'}
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
                      <TouchableOpacity onPress={() => clearSlot(t.id, slot)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={S.removeIcon}>✕</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>

            {/* Captain controls */}
            {format === 'mlp' && isMyTeam && isCaptain && t.status === 'forming' && (
              <View style={S.captainPanel}>
                {!teamFullN && (
                  <TouchableOpacity
                    style={S.captainBtn}
                    onPress={() => setInvitingTeamId(t.id)}
                  >
                    <Text style={S.captainBtnText}>+ Invite a player</Text>
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
                          <TouchableOpacity style={S.acceptBtn} onPress={() => respondToRequest(r.id, true)}>
                            <Text style={S.acceptBtnText}>Accept</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={S.declineBtn} onPress={() => respondToRequest(r.id, false)}>
                            <Text style={S.declineBtnText}>Decline</Text>
                          </TouchableOpacity>
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
                  <TouchableOpacity style={S.lockBtn} onPress={() => lockTeam(t.id)} disabled={busy}>
                    <Text style={S.lockBtnText}>🔒 Lock In Team</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Leave / Disband button — visible to any team member while forming */}
            {format === 'mlp' && isMyTeam && t.status === 'forming' && tournamentStatus === 'registration' && (
              <TouchableOpacity
                style={S.leaveBtn}
                onPress={() => setLeaveConfirm({ teamId: t.id, teamName: t.name, asCaptain: isCaptain })}
                disabled={busy}
              >
                <Text style={S.leaveBtnText}>
                  {isCaptain ? '🗑  Disband Team' : '🚪 Leave Team'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Player POV — invite to me */}
            {format === 'mlp' && !isMyTeam && t.status === 'forming' && currentUserId
              && myReqHere?.direction === 'invite' && myReqHere?.status === 'pending' && (
              <View style={S.captainPanel}>
                <Text style={S.captainBtnText}>You've been invited to this team.</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={S.acceptBtn} onPress={() => respondToRequest(myReqHere.id, true)}>
                    <Text style={S.acceptBtnText}>Accept Invite</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.declineBtn} onPress={() => respondToRequest(myReqHere.id, false)}>
                    <Text style={S.declineBtnText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Player POV — request to join */}
            {format === 'mlp' && !myTeam && !isMyTeam && t.status === 'forming' && onApproved && !teamFullN && !myReqHere && tournamentStatus === 'registration' && (
              <TouchableOpacity style={S.requestBtn} onPress={() => requestJoin(t.id)} disabled={busy}>
                <Text style={S.requestBtnText}>Request to Join</Text>
              </TouchableOpacity>
            )}

            {/* "Already requested" indicator */}
            {format === 'mlp' && !isMyTeam && myReqHere?.direction === 'request' && (
              <Text style={S.pendingNote}>⏳ Your join request is pending.</Text>
            )}
          </View>
        );
      })}

      {/* Players without a team list */}
      {format === 'mlp' && tournamentStatus === 'registration' && playersWithoutTeam.length > 0 && (
        <View style={S.unteamedBox}>
          <Text style={S.unteamedTitle}>{playersWithoutTeam.length} approved player{playersWithoutTeam.length === 1 ? '' : 's'} not yet on a team</Text>
          <Text style={S.unteamedNames} numberOfLines={3}>
            {playersWithoutTeam.map(r => (r.profile?.full_name ?? '?')).join(' · ')}
          </Text>
        </View>
      )}

      {/* Generate bracket */}
      {isPriv && allLocked && !bracketAlreadyGenerated && (
        <TouchableOpacity style={[S.generateBtn, busy && S.btnDim]} onPress={generateBracket} disabled={busy}>
          <Text style={S.generateBtnText}>⚡ Generate Bracket</Text>
        </TouchableOpacity>
      )}

      {/* Create team modal */}
      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={() => { setShowCreate(false); setCreateError(null); }}>
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Create your team</Text>
            <Text style={S.modalBody}>
              You'll become the captain. Pick a name now — you can invite teammates after.
            </Text>
            <Text style={S.modalLabel}>Team name</Text>
            <TextInput
              style={S.modalInput}
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
              <TouchableOpacity style={[S.modalBtn, S.modalBtnSecondary]} onPress={() => { setShowCreate(false); setNewTeamName(''); setCreateError(null); }}>
                <Text style={S.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnPrimary, (busy || !newTeamName.trim()) && S.modalBtnDim]} onPress={createTeam} disabled={busy || !newTeamName.trim()}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={S.modalBtnPrimaryText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
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

      {/* Invite confirmation dialog */}
      <Modal
        visible={!!pendingInvite}
        transparent animationType="fade"
        onRequestClose={() => { setPendingInvite(null); setInviteError(null); }}
      >
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Send invite?</Text>
            {pendingInvite && (
              <Text style={S.modalBody}>
                Invite <Text style={{ fontWeight: '800', color: c.text }}>{pendingInvite.user.full_name}</Text> to join{' '}
                <Text style={{ fontWeight: '800', color: c.text }}>{pendingInvite.teamName}</Text>?{'\n\n'}
                They'll get a notification and can accept or decline.
              </Text>
            )}
            {inviteError && <Text style={S.modalErrorText}>{inviteError}</Text>}
            <View style={S.modalBtnRow}>
              <TouchableOpacity
                style={[S.modalBtn, S.modalBtnSecondary]}
                onPress={() => { setPendingInvite(null); setInviteError(null); }}
                disabled={busy}
              >
                <Text style={S.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[S.modalBtn, S.modalBtnPrimary, busy && S.modalBtnDim]}
                onPress={confirmInvite}
                disabled={busy}
              >
                {busy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={S.modalBtnPrimaryText}>Send Invite</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Leave / Disband confirm modal */}
      <Modal
        visible={!!leaveConfirm}
        transparent
        animationType="fade"
        onRequestClose={() => (busy ? null : setLeaveConfirm(null))}
      >
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>
              {leaveConfirm?.asCaptain ? `Disband "${leaveConfirm?.teamName}"?` : `Leave "${leaveConfirm?.teamName}"?`}
            </Text>
            <Text style={S.modalBody}>
              {leaveConfirm?.asCaptain
                ? 'You\'re the captain. Disbanding deletes the team and removes every member from it. Pending invites and join requests for this team will also be cancelled. This cannot be undone.'
                : 'You\'ll be removed from this team. You can request to join another team or create your own after.'}
            </Text>
            {leaveError ? (
              <Text style={{ color: '#c62828', fontSize: 13, fontWeight: '600', marginBottom: 8 }}>
                {leaveError}
              </Text>
            ) : null}
            <View style={S.modalBtnRow}>
              <TouchableOpacity
                style={[S.modalBtn, S.modalBtnSecondary]}
                onPress={() => { setLeaveConfirm(null); setLeaveError(null); }}
                disabled={busy}
              >
                <Text style={S.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[S.modalBtn, { backgroundColor: '#c62828' }, busy && S.modalBtnDim]}
                onPress={confirmLeaveTeam}
                disabled={busy}
              >
                {busy
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={S.modalBtnPrimaryText}>
                      {leaveConfirm?.asCaptain ? 'Disband team' : 'Leave team'}
                    </Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:     { marginTop: 8 },
    title:    { fontSize: 18, fontWeight: '900', color: c.text, marginBottom: 4 },
    subtitle: { fontSize: 13, color: c.textMuted, marginBottom: 14, lineHeight: 18 },

    actionRow: { marginBottom: 14 },
    primaryBtn:     { backgroundColor: c.primary, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
    primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },

    adminRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
    adminBtn:     { flex: 1, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.primary, paddingVertical: 11, borderRadius: 12, alignItems: 'center' },
    adminBtnText: { color: c.primary, fontWeight: '700', fontSize: 13 },
    btnDim:       { opacity: 0.5 },

    empty: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 16 },

    teamCard:    { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.border },
    teamHeader:  { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
    teamName:    { fontSize: 16, fontWeight: '800', color: c.text },
    teamCaptain: { fontSize: 12, color: c.textSub, marginTop: 2 },
    statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, borderWidth: 1, marginLeft: 8 },
    statusForming:     { backgroundColor: '#fff3e0', borderColor: '#ffb74d' },
    statusFormingText: { color: '#e65100' },
    statusLocked:      { backgroundColor: c.primaryLight, borderColor: c.primary },
    statusLockedText:  { color: c.primary },
    statusText:        { fontSize: 11, fontWeight: '700' },

    roster:    { gap: 6 },
    slotRow:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: c.border },
    slotLabel: { width: 90, fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
    slotName:  { flex: 1, fontSize: 14, color: c.text },
    slotEmpty: { color: c.textMuted, fontStyle: 'italic' },
    removeIcon:{ fontSize: 16, color: c.danger, fontWeight: '700', paddingHorizontal: 6 },

    captainPanel:    { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border },
    captainBtn:      { backgroundColor: c.surfaceAlt, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: c.border },
    captainBtnText:  { fontSize: 13, color: c.primary, fontWeight: '700' },

    reqList:      { marginTop: 10 },
    reqListTitle: { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
    reqRow:       { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
    reqName:      { flex: 1, fontSize: 13, color: c.text },
    reqWaiting:   { fontSize: 11, color: c.textMuted, fontStyle: 'italic' },
    acceptBtn:        { backgroundColor: c.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
    acceptBtnText:    { color: '#fff', fontSize: 12, fontWeight: '700' },
    declineBtn:       { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
    declineBtnText:   { color: c.textSub, fontSize: 12, fontWeight: '700' },

    lockBtn:     { backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center', marginTop: 10 },
    lockBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
    leaveBtn:    { marginTop: 12, paddingVertical: 10, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: c.danger, backgroundColor: c.surface },
    leaveBtnText:{ color: c.danger, fontWeight: '700', fontSize: 13 },

    requestBtn:     { marginTop: 8, backgroundColor: c.primaryLight, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1.5, borderColor: c.primary },
    requestBtnText: { color: c.primary, fontWeight: '700', fontSize: 13 },

    pendingNote: { fontSize: 12, color: c.textMuted, fontStyle: 'italic', textAlign: 'center', marginTop: 8 },

    unteamedBox:   { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 12, marginTop: 8, borderWidth: 1, borderColor: c.border },
    unteamedTitle: { fontSize: 12, fontWeight: '700', color: c.textSub, marginBottom: 4 },
    unteamedNames: { fontSize: 12, color: c.textMuted, lineHeight: 17 },

    generateBtn:     { marginTop: 16, backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    generateBtnText: { color: '#fff', fontWeight: '900', fontSize: 15, letterSpacing: 0.5 },

    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    modalCard:     { backgroundColor: c.surface, borderRadius: 14, padding: 20, width: '100%', maxWidth: 420 },
    modalTitle:    { fontSize: 18, fontWeight: '900', color: c.text, marginBottom: 6 },
    modalBody:     { fontSize: 13, color: c.textSub, lineHeight: 18, marginBottom: 14 },
    modalLabel:    { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
    modalInput:    { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 15, color: c.text, backgroundColor: c.surface, marginBottom: 16 },
    modalBtnRow:   { flexDirection: 'row', gap: 10 },
    modalBtn:      { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    modalBtnPrimary:    { backgroundColor: c.primary },
    modalBtnPrimaryText:{ color: '#fff', fontWeight: '800', fontSize: 14 },
    modalBtnSecondary:  { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    modalBtnSecondaryText: { color: c.textSub, fontWeight: '700', fontSize: 14 },
    modalBtnDim:           { opacity: 0.5 },
    modalErrorText:        { fontSize: 12, color: c.danger, marginBottom: 12, lineHeight: 17 },
  });
}
