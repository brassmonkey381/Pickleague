import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  Alert, Modal, TextInput,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { DoublesPair, DoublesPairJoinRequest, TournamentRegistration } from '../types';
import UserPickerModal, { PickedUser } from './UserPickerModal';
import ConfirmModal from './ConfirmModal';

type Props = {
  tournamentId: string;
  tournamentStatus: string;
  isPriv: boolean;
  currentUserId: string | null;
  approvedRegistrations: TournamentRegistration[];
  onPairsChanged?: () => void;
};

type ProfileLite = { id: string; full_name: string };

const SLOTS = ['partner_1', 'partner_2'] as const;
type Slot = typeof SLOTS[number];

export default function DoublesPairSection({
  tournamentId, tournamentStatus, isPriv, currentUserId,
  approvedRegistrations, onPairsChanged,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [pairs, setPairs]               = useState<DoublesPair[]>([]);
  const [requests, setRequests]         = useState<DoublesPairJoinRequest[]>([]);
  const [profileMap, setProfileMap]     = useState<Record<string, ProfileLite>>({});
  const [loading, setLoading]           = useState(true);
  const [busy, setBusy]                 = useState(false);

  const [showCreate, setShowCreate]     = useState(false);
  const [newPairName, setNewPairName]   = useState('');
  const [createError, setCreateError]   = useState<string | null>(null);

  const [invitingPairId, setInvitingPairId] = useState<string | null>(null);
  const [pendingInvite, setPendingInvite]   = useState<{ pairId: string; pairName: string; user: PickedUser } | null>(null);
  const [inviteError, setInviteError]       = useState<string | null>(null);

  const [leaveConfirm, setLeaveConfirm] = useState<{ pairId: string; pairName: string; asCaptain: boolean } | null>(null);
  const [leaveError, setLeaveError]     = useState<string | null>(null);

  useFocusEffect(useCallback(() => { load(); }, [tournamentId]));

  async function load() {
    setLoading(true);
    const [pairsRes, requestsRes] = await Promise.all([
      supabase.from('doubles_pairs')
        .select('*')
        .eq('tournament_id', tournamentId)
        .order('seed', { ascending: true, nullsFirst: false })
        .order('created_at'),
      supabase.from('doubles_pair_join_requests').select('*'),
    ]);

    const pairRows = (pairsRes.data ?? []) as DoublesPair[];
    setPairs(pairRows);

    const ids = new Set<string>();
    for (const p of pairRows) {
      for (const id of [p.captain_id, p.partner_1_id, p.partner_2_id]) {
        if (id) ids.add(id);
      }
    }
    const reqRows = ((requestsRes.data ?? []) as DoublesPairJoinRequest[])
      .filter(r => pairRows.some(p => p.id === r.pair_id) && r.status === 'pending');
    setRequests(reqRows);
    for (const r of reqRows) ids.add(r.user_id);

    if (ids.size > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', [...ids]);
      const map: Record<string, ProfileLite> = {};
      for (const p of (profs ?? []) as ProfileLite[]) map[p.id] = p;
      setProfileMap(map);
    }
    setLoading(false);
  }

  // ── Derived ─────────────────────────────────────────────────────────
  const myPair = currentUserId
    ? pairs.find(p =>
        p.captain_id === currentUserId ||
        p.partner_1_id === currentUserId || p.partner_2_id === currentUserId,
      )
    : null;
  const isCaptain = myPair?.captain_id === currentUserId;
  const onApproved = !!currentUserId && approvedRegistrations.some(r => r.user_id === currentUserId && r.status === 'approved');

  function pairFull(p: DoublesPair) {
    return !!(p.partner_1_id && p.partner_2_id);
  }
  function slotMember(p: DoublesPair, slot: Slot): ProfileLite | null {
    const id = p[`${slot}_id` as 'partner_1_id' | 'partner_2_id'] as string | null;
    return id ? profileMap[id] ?? null : null;
  }

  const playersWithoutPair = approvedRegistrations
    .filter(r => r.status === 'approved')
    .filter(r => !pairs.some(p =>
      p.captain_id === r.user_id || p.partner_1_id === r.user_id || p.partner_2_id === r.user_id,
    ));

  // ── Actions ─────────────────────────────────────────────────────────
  async function createPair() {
    setCreateError(null);
    const name = newPairName.trim();
    if (!name) { setCreateError('Pick a pair name first.'); return; }
    setBusy(true);
    const { error } = await supabase.rpc('create_doubles_pair', {
      p_tournament_id: tournamentId,
      p_name: name,
    });
    setBusy(false);
    if (error) {
      const hint = error.message?.toLowerCase().includes('does not exist')
        ? '\n\nRun supabase/migration_add_doubles_pairs.sql in the SQL Editor.'
        : '';
      setCreateError(`${error.message ?? 'Unknown error'}${hint}`);
      return;
    }
    setShowCreate(false);
    setNewPairName('');
    await load();
    onPairsChanged?.();
  }

  async function requestJoin(pairId: string) {
    setBusy(true);
    const { error } = await supabase.rpc('pair_request_join', {
      p_pair_id: pairId,
      p_message: null,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    Alert.alert('Request sent', 'The captain will see your request.');
    await load();
  }

  async function respondToRequest(reqId: string, accept: boolean) {
    setBusy(true);
    const { error } = await supabase.rpc('pair_respond_to_join', {
      p_request_id: reqId,
      p_accept: accept,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    await load();
    onPairsChanged?.();
  }

  function pickInvitee(pairId: string, u: PickedUser) {
    const pair = pairs.find(p => p.id === pairId);
    setPendingInvite({ pairId, pairName: pair?.name ?? '', user: u });
    setInvitingPairId(null);
    setInviteError(null);
  }

  async function confirmInvite() {
    if (!pendingInvite) return;
    setInviteError(null);
    setBusy(true);
    const { error } = await supabase.rpc('pair_invite', {
      p_pair_id: pendingInvite.pairId,
      p_user_id: pendingInvite.user.id,
      p_message: null,
    });
    setBusy(false);
    if (error) { setInviteError(error.message ?? 'Unknown error'); return; }
    setPendingInvite(null);
    await load();
  }

  async function clearSlot(pairId: string, slot: Slot) {
    setBusy(true);
    const { error } = await supabase.rpc('pair_set_slot', {
      p_pair_id: pairId, p_slot: slot, p_user_id: null,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    await load();
    onPairsChanged?.();
  }

  async function lockPair(pairId: string) {
    setBusy(true);
    const { error } = await supabase.rpc('pair_lock_pair', { p_pair_id: pairId });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    await load();
    onPairsChanged?.();
  }

  async function generateRandomPairs(mode: 'random' | 'snake') {
    setBusy(true);
    const { data, error } = await supabase.rpc('generate_random_pairs', {
      p_tournament_id: tournamentId, p_mode: mode,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    Alert.alert('Pairs generated', `${data ?? 0} pair${data === 1 ? '' : 's'} created.`);
    await load();
    onPairsChanged?.();
  }

  async function confirmLeavePair() {
    if (!leaveConfirm) return;
    setLeaveError(null);
    setBusy(true);
    const { error } = await supabase.rpc('pair_leave_pair', { p_pair_id: leaveConfirm.pairId });
    setBusy(false);
    if (error) { setLeaveError(error.message ?? 'Failed to leave pair.'); return; }
    setLeaveConfirm(null);
    await load();
    onPairsChanged?.();
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (loading) return <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 24 }} />;

  return (
    <View style={S.root}>
      <Text style={S.title}>🤝 Doubles Partners</Text>
      <View style={S.callout}>
        <Text style={S.calloutTitle}>👯 Every player needs a fixed teammate</Text>
        <Text style={S.calloutBody}>
          This is a doubles tournament with fixed partners — you'll play with the same teammate every round. Pair up by creating a pair (you become captain) or accepting an invite.
        </Text>
        <Text style={S.calloutBody}>
          Anyone still unpaired when the bracket is drawn will be <Text style={S.calloutEmphasis}>randomly paired with one of the other free players</Text>.
        </Text>
      </View>

      {/* Create */}
      {onApproved && !myPair && tournamentStatus === 'registration' && (
        <View style={S.actionRow}>
          <TouchableOpacity style={S.primaryBtn} onPress={() => setShowCreate(true)}>
            <Text style={S.primaryBtnText}>+ Create a Pair</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Pairs list */}
      {pairs.length === 0 && (
        <Text style={S.empty}>No pairs yet — be the first to create one!</Text>
      )}

      {pairs.map(p => {
        const captain     = p.captain_id ? profileMap[p.captain_id] : null;
        const teamFullN   = pairFull(p);
        const isMyPair    = myPair?.id === p.id;
        const myReqHere   = requests.find(r => r.pair_id === p.id && r.user_id === currentUserId);
        const pairReqs    = requests.filter(r => r.pair_id === p.id);

        return (
          <View key={p.id} style={S.teamCard}>
            <View style={S.teamHeader}>
              <View style={{ flex: 1 }}>
                <Text style={S.teamName} numberOfLines={1}>
                  {p.is_random_generated ? '🎲 ' : ''}{p.name}
                </Text>
                {captain && <Text style={S.teamCaptain}>👑 {captain.full_name}</Text>}
              </View>
              <View style={[S.statusBadge, p.status === 'locked' ? S.statusLocked : S.statusForming]}>
                <Text style={[S.statusText, p.status === 'locked' ? S.statusLockedText : S.statusFormingText]}>
                  {p.status === 'locked' ? '🔒 Locked' : 'Forming'}
                </Text>
              </View>
            </View>

            {/* Roster */}
            <View style={S.roster}>
              {SLOTS.map(slot => {
                const member = slotMember(p, slot);
                const label = slot === 'partner_1' ? 'Partner 1' : 'Partner 2';
                return (
                  <View key={slot} style={S.slotRow}>
                    <Text style={S.slotLabel}>{label}</Text>
                    <Text style={S.slotName} numberOfLines={1}>
                      {member ? member.full_name : <Text style={S.slotEmpty}>— empty —</Text>}
                    </Text>
                    {isMyPair && isCaptain && p.status === 'forming' && member && (
                      <TouchableOpacity onPress={() => clearSlot(p.id, slot)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={S.removeIcon}>✕</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>

            {/* Captain controls */}
            {isMyPair && isCaptain && p.status === 'forming' && (
              <View style={S.captainPanel}>
                {!teamFullN && (
                  <TouchableOpacity style={S.captainBtn} onPress={() => setInvitingPairId(p.id)}>
                    <Text style={S.captainBtnText}>+ Invite a partner</Text>
                  </TouchableOpacity>
                )}

                {pairReqs.filter(r => r.direction === 'request').length > 0 && (
                  <View style={S.reqList}>
                    <Text style={S.reqListTitle}>Pending requests to join</Text>
                    {pairReqs.filter(r => r.direction === 'request').map(r => {
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

                {pairReqs.filter(r => r.direction === 'invite').length > 0 && (
                  <View style={S.reqList}>
                    <Text style={S.reqListTitle}>Outstanding invites</Text>
                    {pairReqs.filter(r => r.direction === 'invite').map(r => {
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
                  <TouchableOpacity style={S.lockBtn} onPress={() => lockPair(p.id)} disabled={busy}>
                    <Text style={S.lockBtnText}>🔒 Lock In Pair</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Leave/Disband — visible to any pair member while forming */}
            {isMyPair && !isCaptain && p.status === 'forming' && tournamentStatus === 'registration' && (
              <TouchableOpacity
                style={S.leaveBtn}
                onPress={() => setLeaveConfirm({ pairId: p.id, pairName: p.name, asCaptain: false })}
                disabled={busy}
              >
                <Text style={S.leaveBtnText}>🚪 Leave Pair</Text>
              </TouchableOpacity>
            )}
            {isMyPair && isCaptain && p.status === 'forming' && tournamentStatus === 'registration' && (
              <TouchableOpacity
                style={S.disbandBtn}
                onPress={() => setLeaveConfirm({ pairId: p.id, pairName: p.name, asCaptain: true })}
                disabled={busy}
              >
                <Text style={S.disbandBtnText}>🗑  Disband Pair</Text>
              </TouchableOpacity>
            )}

            {/* Player POV — invite to me */}
            {!isMyPair && p.status === 'forming' && currentUserId
              && myReqHere?.direction === 'invite' && myReqHere?.status === 'pending' && (
              <View style={S.captainPanel}>
                <Text style={S.captainBtnText}>You've been invited to pair with this captain.</Text>
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
            {!myPair && !isMyPair && p.status === 'forming' && onApproved && !teamFullN && !myReqHere && tournamentStatus === 'registration' && (
              <TouchableOpacity style={S.requestBtn} onPress={() => requestJoin(p.id)} disabled={busy}>
                <Text style={S.requestBtnText}>Request to Join</Text>
              </TouchableOpacity>
            )}

            {!isMyPair && myReqHere?.direction === 'request' && (
              <Text style={S.pendingNote}>⏳ Your join request is pending.</Text>
            )}
          </View>
        );
      })}

      {/* Admin: random pair generation from unpaired approved players */}
      {isPriv && tournamentStatus === 'registration' && playersWithoutPair.length >= 2 && (
        <View style={S.adminRow}>
          <TouchableOpacity style={[S.adminBtn, busy && S.btnDim]} onPress={() => generateRandomPairs('random')} disabled={busy}>
            <Text style={S.adminBtnText}>🎲 Random-Pair Remaining ({playersWithoutPair.length})</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[S.adminBtn, busy && S.btnDim]} onPress={() => generateRandomPairs('snake')} disabled={busy}>
            <Text style={S.adminBtnText}>🐍 Snake-Pair (balanced)</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Unpaired list (read-only) */}
      {tournamentStatus === 'registration' && playersWithoutPair.length > 0 && (
        <View style={S.unteamedBox}>
          <Text style={S.unteamedTitle}>{playersWithoutPair.length} approved player{playersWithoutPair.length === 1 ? '' : 's'} not yet paired</Text>
          <Text style={S.unteamedNames} numberOfLines={3}>
            {playersWithoutPair.map(r => (r.profile?.full_name ?? '?')).join(' · ')}
          </Text>
        </View>
      )}

      {/* Create modal */}
      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={() => { setShowCreate(false); setCreateError(null); }}>
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Create your pair</Text>
            <Text style={S.modalBody}>
              You'll become the captain. Pick a name now — you can invite your partner after.
            </Text>
            <TextInput
              style={S.modalInput}
              placeholder="Pair name"
              placeholderTextColor={c.textMuted}
              value={newPairName}
              onChangeText={setNewPairName}
              maxLength={40}
              autoFocus
            />
            {createError ? <Text style={S.modalError}>{createError}</Text> : null}
            <View style={S.modalBtnRow}>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnSecondary]} onPress={() => { setShowCreate(false); setNewPairName(''); setCreateError(null); }}>
                <Text style={S.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnPrimary, (busy || !newPairName.trim()) && S.modalBtnDim]} onPress={createPair} disabled={busy || !newPairName.trim()}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={S.modalBtnPrimaryText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Invite picker */}
      {invitingPairId && (
        <UserPickerModal
          visible={!!invitingPairId}
          title="Invite a partner"
          excludeUserIds={[
            ...(currentUserId ? [currentUserId] : []),
            ...pairs.flatMap(p =>
              [p.captain_id, p.partner_1_id, p.partner_2_id].filter(Boolean) as string[]
            ),
          ]}
          onPick={u => pickInvitee(invitingPairId!, u)}
          onClose={() => setInvitingPairId(null)}
        />
      )}

      <ConfirmModal
        visible={!!pendingInvite}
        title="Send invite?"
        body={pendingInvite
          ? `Invite ${pendingInvite.user.full_name} to pair as ${pendingInvite.pairName}? They'll get a notification.`
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
        title={leaveConfirm?.asCaptain ? `Disband "${leaveConfirm?.pairName}"?` : `Leave "${leaveConfirm?.pairName}"?`}
        body={leaveConfirm?.asCaptain
          ? "You're the captain. Disbanding deletes the pair and frees your partner. Pending invites/requests will also be cancelled. This cannot be undone."
          : "You'll be removed from this pair. You can request to join another pair or create your own after."}
        primaryLabel={leaveConfirm?.asCaptain ? 'Disband pair' : 'Leave pair'}
        variant="danger"
        busy={busy}
        error={leaveError}
        onConfirm={confirmLeavePair}
        onClose={() => { setLeaveConfirm(null); setLeaveError(null); }}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:     { marginTop: 8 },
    title:    { fontSize: 18, fontWeight: '900', color: c.text, marginBottom: 8 },
    subtitle: { fontSize: 13, color: c.textMuted, marginBottom: 14, lineHeight: 18 },

    callout:        { backgroundColor: c.primaryLight, borderLeftWidth: 4, borderLeftColor: c.primary, borderRadius: 10, padding: 12, marginBottom: 14, gap: 6 },
    calloutTitle:   { fontSize: 14, fontWeight: '800', color: c.text },
    calloutBody:    { fontSize: 13, color: c.textSub, lineHeight: 19 },
    calloutEmphasis:{ fontWeight: '800', color: c.text },

    actionRow:    { marginBottom: 14 },
    primaryBtn:   { backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

    adminRow:     { flexDirection: 'row', gap: 8, marginVertical: 10, flexWrap: 'wrap' },
    adminBtn:     { flex: 1, minWidth: 160, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
    adminBtnText: { color: c.text, fontWeight: '700', fontSize: 13 },
    btnDim:       { opacity: 0.4 },

    empty:        { fontSize: 13, color: c.textMuted, textAlign: 'center', marginVertical: 16 },

    teamCard:     { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.border },
    teamHeader:   { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
    teamName:     { fontSize: 16, fontWeight: '800', color: c.text },
    teamCaptain:  { fontSize: 12, color: c.textSub, marginTop: 2 },
    statusBadge:  { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
    statusLocked: { backgroundColor: c.primaryLight },
    statusForming:{ backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    statusText:   { fontSize: 11, fontWeight: '800' },
    statusLockedText:  { color: c.primary },
    statusFormingText: { color: c.textSub },

    roster:    { gap: 6, marginVertical: 4 },
    slotRow:   { flexDirection: 'row', alignItems: 'center', gap: 10 },
    slotLabel: { fontSize: 12, color: c.textMuted, fontWeight: '700', width: 80 },
    slotName:  { flex: 1, fontSize: 14, color: c.text, fontWeight: '600' },
    slotEmpty: { color: c.textMuted, fontStyle: 'italic', fontWeight: '500' },
    removeIcon:{ color: c.danger, fontSize: 16, paddingHorizontal: 6, fontWeight: '700' },

    captainPanel:    { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border },
    captainBtn:      { backgroundColor: c.surfaceAlt, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: c.border },
    captainBtnText:  { fontSize: 13, color: c.primary, fontWeight: '700' },

    reqList:        { marginTop: 10 },
    reqListTitle:   { fontSize: 11, color: c.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
    reqRow:         { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
    reqName:        { flex: 1, fontSize: 13, color: c.text, fontWeight: '600' },
    reqWaiting:     { fontSize: 11, color: c.textMuted, fontStyle: 'italic' },
    acceptBtn:      { backgroundColor: c.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
    acceptBtnText:  { color: '#fff', fontSize: 12, fontWeight: '700' },
    declineBtn:     { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
    declineBtnText: { color: c.textSub, fontSize: 12, fontWeight: '700' },

    requestBtn:     { marginTop: 8, backgroundColor: c.primaryLight, borderWidth: 1.5, borderColor: c.primary, paddingVertical: 9, borderRadius: 10, alignItems: 'center' },
    requestBtnText: { color: c.primary, fontWeight: '800', fontSize: 13 },
    pendingNote:    { marginTop: 8, fontSize: 12, color: c.textMuted, fontStyle: 'italic', textAlign: 'center' },

    lockBtn:        { marginTop: 10, backgroundColor: c.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    lockBtnText:    { color: '#fff', fontWeight: '800', fontSize: 14 },
    leaveBtn:       { marginTop: 12, paddingVertical: 10, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: c.danger, backgroundColor: c.surface },
    leaveBtnText:   { color: c.danger, fontWeight: '700', fontSize: 13 },
    disbandBtn:     { marginTop: 12, paddingVertical: 10, alignItems: 'center', borderRadius: 10, backgroundColor: c.danger },
    disbandBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },

    unteamedBox:    { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 12, marginTop: 8, borderWidth: 1, borderColor: c.border },
    unteamedTitle:  { fontSize: 12, fontWeight: '700', color: c.textSub, marginBottom: 4 },
    unteamedNames:  { fontSize: 12, color: c.textMuted, lineHeight: 17 },

    modalBackdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
    modalCard:        { width: '100%', maxWidth: 440, backgroundColor: c.surface, borderRadius: 14, padding: 22 },
    modalTitle:       { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 10 },
    modalBody:        { fontSize: 14, color: c.textSub, lineHeight: 20, marginBottom: 12 },
    modalInput:       { borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: c.text, backgroundColor: c.surfaceAlt, marginBottom: 10 },
    modalError:       { color: c.danger, fontSize: 13, fontWeight: '600', marginBottom: 8 },
    modalBtnRow:      { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
    modalBtn:         { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, minWidth: 96, alignItems: 'center', justifyContent: 'center' },
    modalBtnSecondary:    { backgroundColor: c.surfaceAlt },
    modalBtnSecondaryText:{ color: c.textSub, fontWeight: '700' },
    modalBtnPrimary:      { backgroundColor: c.primary },
    modalBtnPrimaryText:  { color: '#fff', fontWeight: '800' },
    modalBtnDim:          { opacity: 0.5 },
  });
}
