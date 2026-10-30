import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  Modal, TextInput, Pressable,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { DoublesPair, DoublesPairJoinRequest, TournamentRegistration } from '../types';
import UserPickerModal, { PickedUser } from './UserPickerModal';
import ConfirmModal from './ConfirmModal';
import EmptyState from './EmptyState';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { HAIRLINE, RADIUS, SPACE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { ToastOutlet } from '@just-messin-around/expo-foundation/toast';

type Props = {
  tournamentId: string;
  tournamentStatus: string;
  isPriv: boolean;
  currentUserId: string | null;
  approvedRegistrations: TournamentRegistration[];
  onPairsChanged?: () => void;
  /**
   * Drop the title row, for a host that already names the section
   * (TournamentDetail's "Pairs" section). Default false.
   */
  bare?: boolean;
};

type ProfileLite = { id: string; full_name: string };

const SLOTS = ['partner_1', 'partner_2'] as const;
type Slot = typeof SLOTS[number];

export default function DoublesPairSection({
  tournamentId, tournamentStatus, isPriv, currentUserId,
  approvedRegistrations, onPairsChanged, bare = false,
}: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [pairs, setPairs]               = useState<DoublesPair[]>([]);
  const [requests, setRequests]         = useState<DoublesPairJoinRequest[]>([]);
  const [profileMap, setProfileMap]     = useState<Record<string, ProfileLite>>({});
  const [loading, setLoading]           = useState(true);
  const [busy, setBusy]                 = useState(false);
  // Alert.alert is a no-op under react-native-web, so on pickleague.club every
  // one of these actions succeeded and failed completely silently.
  const status                          = useStatusMessage();
  // `busy` is only visible to the buttons on the next render; the guard that
  // actually stops a double tap has to be a ref read at the top of the handler.
  const busyRef                         = useRef(false);

  const [showCreate, setShowCreate]     = useState(false);
  const [newPairName, setNewPairName]   = useState('');
  const [createError, setCreateError]   = useState<string | null>(null);

  const [invitingPairId, setInvitingPairId] = useState<string | null>(null);
  const [pendingInvite, setPendingInvite]   = useState<{ pairId: string; pairName: string; user: PickedUser } | null>(null);
  const [inviteError, setInviteError]       = useState<string | null>(null);

  const [leaveConfirm, setLeaveConfirm] = useState<{ pairId: string; pairName: string; asCaptain: boolean } | null>(null);
  const [leaveError, setLeaveError]     = useState<string | null>(null);

  useFocusEffect(useCallback(() => { load(); }, [tournamentId]));

  const closeCreateModal = useCallback(() => {
    setShowCreate(false);
    setNewPairName('');
    setCreateError(null);
  }, []);

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
    if (busyRef.current) return;
    setCreateError(null);
    const name = newPairName.trim();
    if (!name) { setCreateError('Pick a pair name first.'); return; }
    busyRef.current = true;
    setBusy(true);
    try {
      // Not retried: a retry after a lost reply creates a second pair with the
      // same name and no captain slot left to fill.
      await sbCall(() => supabase.rpc('create_doubles_pair', {
        p_tournament_id: tournamentId,
        p_name: name,
      }), { retries: 0 });
      setShowCreate(false);
      setNewPairName('');
      await load();
      onPairsChanged?.();
    } catch (e) {
      const msg = friendlySbMessage(e, 'Could not create the pair.');
      const hint = /does not exist/i.test(msg)
        ? '\n\nRun supabase/migration_add_doubles_pairs.sql in the SQL Editor.'
        : '';
      setCreateError(`${msg}${hint}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function requestJoin(pairId: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    status.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('pair_request_join', {
        p_pair_id: pairId,
        p_message: null,
      }));
      status.success('Request sent — the captain will see it.');
      await load();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not send the request.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function respondToRequest(reqId: string, accept: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    status.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('pair_respond_to_join', {
        p_request_id: reqId,
        p_accept: accept,
      }));
      status.success(accept ? 'Request accepted — player added to your pair.' : 'Request declined.');
      await load();
      onPairsChanged?.();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not respond to the request.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function pickInvitee(pairId: string, u: PickedUser) {
    const pair = pairs.find(p => p.id === pairId);
    setPendingInvite({ pairId, pairName: pair?.name ?? '', user: u });
    setInvitingPairId(null);
    setInviteError(null);
  }

  async function confirmInvite() {
    if (busyRef.current) return;
    if (!pendingInvite) return;
    busyRef.current = true;
    setInviteError(null);
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('pair_invite', {
        p_pair_id: pendingInvite.pairId,
        p_user_id: pendingInvite.user.id,
        p_message: null,
      }));
      setPendingInvite(null);
      await load();
    } catch (e) {
      setInviteError(friendlySbMessage(e, 'Could not send the invite.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function clearSlot(pairId: string, slot: Slot) {
    if (busyRef.current) return;
    busyRef.current = true;
    status.clear();
    setBusy(true);
    try {
      // Idempotent: writes a fixed slot value, so a retry lands on the same row.
      await sbCall(() => supabase.rpc('pair_set_slot', {
        p_pair_id: pairId, p_slot: slot, p_user_id: null,
      }));
      await load();
      onPairsChanged?.();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not clear that slot.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function lockPair(pairId: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    status.clear();
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('pair_lock_pair', { p_pair_id: pairId }));
      status.success('Pair locked.');
      await load();
      onPairsChanged?.();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not lock the pair.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function generateRandomPairs(mode: 'random' | 'snake') {
    if (busyRef.current) return;
    busyRef.current = true;
    status.clear();
    setBusy(true);
    try {
      // Not retried: this creates pair rows, and a retry after a lost reply
      // would pair the free players a second time.
      const data = await sbCall(() => supabase.rpc('generate_random_pairs', {
        p_tournament_id: tournamentId, p_mode: mode,
      }), { retries: 0 }) as number | null;
      status.success(`${data ?? 0} pair${data === 1 ? '' : 's'} created.`);
      await load();
      onPairsChanged?.();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not generate pairs.', {
        network: 'Lost the connection — reload and check whether pairs were created before trying again.',
      }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmLeavePair() {
    if (busyRef.current) return;
    if (!leaveConfirm) return;
    busyRef.current = true;
    setLeaveError(null);
    setBusy(true);
    try {
      await sbCall(() => supabase.rpc('pair_leave_pair', { p_pair_id: leaveConfirm.pairId }));
      setLeaveConfirm(null);
      await load();
      onPairsChanged?.();
    } catch (e) {
      setLeaveError(friendlySbMessage(e, 'Failed to leave pair.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (loading) return <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: SPACE.xl }} />;

  return (
    <View style={S.root}>
      {!bare && (
        <View style={S.titleRow}>
          <Icon name="handshake" size={18} color={c.primary} />
          <Text style={S.title}>Doubles Partners</Text>
        </View>
      )}
      <StatusBanner status={status.value} />
      {/* Recruitment pitch only makes sense while pairing is still possible —
          once the bracket is locked (active/completed) just show the teams. */}
      {tournamentStatus === 'registration' && (
        <View style={S.callout}>
          <View style={S.glyphRow}>
            <Icon name="group" size={16} color={c.primary} />
            <Text style={[S.calloutTitle, S.shrink]}>Every player needs a fixed teammate</Text>
          </View>
          <Text style={S.calloutBody}>
            This is a doubles tournament with fixed partners — you'll play with the same teammate every round. Pair up by creating a pair (you become captain) or accepting an invite.
          </Text>
          <Text style={S.calloutBody}>
            Anyone still unpaired when the bracket is drawn will be <Text style={S.calloutEmphasis}>randomly paired with one of the other free players</Text>.
          </Text>
        </View>
      )}

      {/* Create */}
      {onApproved && !myPair && tournamentStatus === 'registration' && (
        <View style={S.actionRow}>
          <Button iconName="plus" title="Create a Pair" onPress={() => setShowCreate(true)} />
        </View>
      )}

      {/* Pairs list */}
      {pairs.length === 0 && (
        <EmptyState iconName="handshake" title="No pairs yet — be the first to create one!" />
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
              <View style={S.teamTitleCol}>
                <View style={S.glyphRow}>
                  {p.is_random_generated ? (
                    <Icon name="dice" size={14} color={c.textSub} accessibilityLabel="Randomly drawn" />
                  ) : null}
                  <Text style={[S.teamName, S.shrink]} numberOfLines={1}>{p.name}</Text>
                </View>
                {captain && (
                  <View style={[S.glyphRow, S.teamCaptainRow]}>
                    <Icon name="crown" size={12} color={c.rarityLegendary} accessibilityLabel="Captain" />
                    <Text style={[S.teamCaptain, S.shrink]} numberOfLines={1}>{captain.full_name}</Text>
                  </View>
                )}
              </View>
              <View style={[S.statusBadge, p.status === 'locked' ? S.statusLocked : S.statusForming]}>
                {p.status === 'locked' ? <Icon name="lock" size={12} color={c.primary} /> : null}
                <Text style={[S.statusText, p.status === 'locked' ? S.statusLockedText : S.statusFormingText]}>
                  {p.status === 'locked' ? 'Locked' : 'Forming'}
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
                      <TouchableOpacity
                        style={S.removeBox}
                        onPress={() => clearSlot(p.id, slot)}
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

            {/* Captain controls */}
            {isMyPair && isCaptain && p.status === 'forming' && (
              <View style={S.captainPanel}>
                {!teamFullN && (
                  <TouchableOpacity style={S.captainBtn} onPress={() => setInvitingPairId(p.id)} accessibilityRole="button">
                    <Icon name="plus" size={14} color={c.primary} />
                    <Text style={S.captainBtnText}>Invite a partner</Text>
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
                  <Button iconName="lock" title="Lock In Pair" onPress={() => lockPair(p.id)} disabled={busy} style={S.lockBtn} />
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
                <Icon name="logout" size={16} color={c.danger} />
                <Text style={S.leaveBtnText}>Leave Pair</Text>
              </TouchableOpacity>
            )}
            {isMyPair && isCaptain && p.status === 'forming' && tournamentStatus === 'registration' && (
              <Button
                variant="danger"
                iconName="trash"
                title="Disband Pair"
                onPress={() => setLeaveConfirm({ pairId: p.id, pairName: p.name, asCaptain: true })}
                disabled={busy}
                style={S.disbandBtn}
              />
            )}

            {/* Player POV — invite to me */}
            {!isMyPair && p.status === 'forming' && currentUserId
              && myReqHere?.direction === 'invite' && myReqHere?.status === 'pending' && (
              <View style={S.captainPanel}>
                <Text style={S.captainBtnText}>You've been invited to pair with this captain.</Text>
                <View style={S.inviteBtnRow}>
                  <Button size="sm" title="Accept Invite" onPress={() => respondToRequest(myReqHere.id, true)} />
                  <Button size="sm" variant="outline" title="Decline" onPress={() => respondToRequest(myReqHere.id, false)} />
                </View>
              </View>
            )}

            {/* Player POV — request to join */}
            {!myPair && !isMyPair && p.status === 'forming' && onApproved && !teamFullN && !myReqHere && tournamentStatus === 'registration' && (
              <TouchableOpacity style={S.requestBtn} onPress={() => requestJoin(p.id)} disabled={busy} accessibilityRole="button">
                <Text style={S.requestBtnText}>Request to Join</Text>
              </TouchableOpacity>
            )}

            {!isMyPair && myReqHere?.direction === 'request' && (
              <View style={[S.glyphRow, S.pendingRow]}>
                <Icon name="hourglass" size={12} color={c.warning} />
                <Text style={S.pendingNote}>Your join request is pending.</Text>
              </View>
            )}
          </View>
        );
      })}

      {/* Admin: random pair generation from unpaired approved players */}
      {isPriv && tournamentStatus === 'registration' && playersWithoutPair.length >= 2 && (
        <View style={S.adminRow}>
          <TouchableOpacity style={[S.adminBtn, busy && S.btnDim]} onPress={() => generateRandomPairs('random')} disabled={busy} accessibilityRole="button">
            <Icon name="dice" size={14} color={c.text} />
            <Text style={S.adminBtnText}>Random-Pair Remaining ({playersWithoutPair.length})</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[S.adminBtn, busy && S.btnDim]} onPress={() => generateRandomPairs('snake')} disabled={busy} accessibilityRole="button">
            <Icon name="scale" size={14} color={c.text} />
            <Text style={S.adminBtnText}>Snake-Pair (balanced)</Text>
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
      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={closeCreateModal}>
        <Pressable style={S.modalBackdrop} onPress={(e) => { if (e.target === e.currentTarget) closeCreateModal(); }}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Create your pair</Text>
            <Text style={S.modalBody}>
              You'll become the captain. Pick a name now — you can invite your partner after.
            </Text>
            <TextInput
              style={[S.modalInput, webInputFontFloor(S.modalInput)]}
              placeholder="Pair name"
              placeholderTextColor={c.textMuted}
              value={newPairName}
              onChangeText={setNewPairName}
              maxLength={40}
              autoFocus
            />
            {createError ? <Text style={S.modalError}>{createError}</Text> : null}
            <View style={S.modalBtnRow}>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnSecondary]} onPress={closeCreateModal}>
                <Text style={S.modalBtnSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnPrimary, (busy || !newPairName.trim()) && S.modalBtnDim]} onPress={createPair} disabled={busy || !newPairName.trim()}>
                {busy ? <ActivityIndicator color={c.textInverse} /> : <Text style={S.modalBtnPrimaryText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
        {/* Toasts and the pickle rain show above this Modal. */}
        <ToastOutlet />
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
  const t = textStyles(c);
  const W = FONT.weight;
  return StyleSheet.create({
    root:     { marginTop: SPACE.sm },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm },
    title:    { ...t.h3, fontWeight: W.black, flexShrink: 1 },
    // A glyph beside its words (decorative unless the Icon has a label).
    glyphRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    shrink:   { flexShrink: 1, minWidth: 0 },

    callout:        { backgroundColor: c.primaryLight, borderLeftWidth: 4, borderLeftColor: c.primary, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.md, gap: SPACE.xs },
    calloutTitle:   { fontSize: FONT.size.md, fontWeight: W.heavy, color: c.text },
    calloutBody:    t.sub,
    calloutEmphasis:{ fontWeight: W.heavy, color: c.text },

    actionRow:    { marginBottom: SPACE.md },

    adminRow:     { flexDirection: 'row', gap: SPACE.sm, marginVertical: SPACE.sm, flexWrap: 'wrap' },
    adminBtn:     { flex: 1, minWidth: 160, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.sm, backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md },
    adminBtnText: { color: c.text, fontWeight: W.bold, fontSize: FONT.size.base },
    btnDim:       { opacity: 0.5 },

    teamCard:     { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    teamHeader:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm },
    teamTitleCol: { flex: 1, minWidth: 0 },
    teamName:     { fontSize: FONT.size.lg, fontWeight: W.heavy, color: c.text },
    teamCaptainRow: { marginTop: SPACE.xxs },
    teamCaptain:  { fontSize: FONT.size.sm, color: c.textSub },
    statusBadge:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.pill },
    statusLocked: { backgroundColor: c.primaryLight },
    statusForming:{ backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    statusText:   { fontSize: FONT.size.xs, fontWeight: W.heavy },
    statusLockedText:  { color: c.primary },
    statusFormingText: { color: c.textSub },

    roster:    { gap: SPACE.xs, marginVertical: SPACE.xs },
    slotRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 24 },
    slotLabel: { fontSize: FONT.size.sm, color: c.textMuted, fontWeight: W.bold, width: 80 },
    slotName:  { flex: 1, fontSize: FONT.size.md, color: c.text, fontWeight: W.semibold },
    slotEmpty: { color: c.textMuted, fontStyle: 'italic', fontWeight: W.medium },
    // 44 tap box that doesn't grow the 24px row (web ignores hitSlop).
    removeBox: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -SPACE.md, marginRight: -SPACE.md },

    captainPanel:    { marginTop: SPACE.md, paddingTop: SPACE.sm, borderTopWidth: HAIRLINE, borderTopColor: c.border },
    captainBtn:      { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border },
    captainBtnText:  { fontSize: FONT.size.base, color: c.primary, fontWeight: W.bold },

    reqList:        { marginTop: SPACE.sm },
    reqListTitle:   { ...t.fieldLabel, marginBottom: SPACE.xs },
    reqRow:         { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 32 },
    reqName:        { flex: 1, fontSize: FONT.size.base, color: c.text, fontWeight: W.semibold },
    reqWaiting:     { ...t.caption, fontStyle: 'italic' },
    inviteBtnRow:   { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },

    requestBtn:     { marginTop: SPACE.sm, minHeight: 44, justifyContent: 'center', backgroundColor: c.primaryLight, borderWidth: 1.5, borderColor: c.primary, borderRadius: RADIUS.md, alignItems: 'center' },
    requestBtnText: { color: c.primary, fontWeight: W.heavy, fontSize: FONT.size.base },
    pendingRow:     { justifyContent: 'center', marginTop: SPACE.sm },
    pendingNote:    { fontSize: FONT.size.sm, color: c.textMuted, fontStyle: 'italic', textAlign: 'center' },

    lockBtn:        { marginTop: SPACE.sm },
    leaveBtn:       { marginTop: SPACE.md, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.danger, backgroundColor: c.surface },
    leaveBtnText:   { color: c.danger, fontWeight: W.bold, fontSize: FONT.size.base },
    disbandBtn:     { marginTop: SPACE.md },

    unteamedBox:    { backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.sm, borderWidth: HAIRLINE, borderColor: c.border },
    unteamedTitle:  { fontSize: FONT.size.sm, fontWeight: W.bold, color: c.textSub, marginBottom: SPACE.xs },
    unteamedNames:  { fontSize: FONT.size.sm, color: c.textMuted, lineHeight: 17 },

    modalBackdrop:    { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.xl },
    modalCard:        { width: '100%', maxWidth: 440, backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.xl },
    modalTitle:       { ...t.h3, fontWeight: W.heavy, marginBottom: SPACE.sm },
    modalBody:        { ...t.bodySub, marginBottom: SPACE.md },
    modalInput:       { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surfaceAlt, marginBottom: SPACE.sm },
    modalError:       { color: c.danger, fontSize: FONT.size.base, fontWeight: W.semibold, marginBottom: SPACE.sm },
    modalBtnRow:      { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm, marginTop: SPACE.sm },
    modalBtn:         { minHeight: 44, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.md, minWidth: 96, alignItems: 'center', justifyContent: 'center' },
    modalBtnSecondary:    { backgroundColor: c.surfaceAlt },
    modalBtnSecondaryText:{ color: c.textSub, fontWeight: W.bold },
    modalBtnPrimary:      { backgroundColor: c.primary },
    modalBtnPrimaryText:  { color: c.textInverse, fontWeight: W.heavy },
    modalBtnDim:          { opacity: 0.5 },
  });
}
