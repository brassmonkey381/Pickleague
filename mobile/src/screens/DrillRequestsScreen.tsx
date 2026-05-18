import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { DrillRequest, DrillRequestMessage, RootStackParamList } from '../types';
import { dateLabel, dateSubLabel, durationLabel, slotLabel } from '../lib/drillTime';
import { formatPlupr } from '../lib/plupr';
import { AVATARS } from '../data/profileCustomization';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DrillRequests'> };

type Tab = 'incoming' | 'outgoing';

export default function DrillRequestsScreen({}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [tab, setTab] = useState<Tab>('incoming');
  const [userId, setUserId] = useState<string | null>(null);
  const [requests, setRequests] = useState<DrillRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // Per-request slot selection for the incoming Accept flow.
  // Key = request.id, value = index into proposed_slots that the receiver picked.
  const [selectedSlotIdx, setSelectedSlotIdx] = useState<Record<string, number>>({});

  // Chat modal state
  const [chatRequest, setChatRequest] = useState<DrillRequest | null>(null);

  // Cancel-request confirm
  const [cancelTarget, setCancelTarget] = useState<DrillRequest | null>(null);
  const [cancelling, setCancelling]     = useState(false);

  const status = useStatusMessage();

  useFocusEffect(useCallback(() => { load(); }, [tab]));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const fkField = tab === 'incoming'
      ? 'from_profile:profiles!drill_requests_from_user_id_fkey(id, full_name, avatar_id, avatar_url, rating, total_matches_played)'
      : 'to_profile:profiles!drill_requests_to_user_id_fkey(id, full_name, avatar_id, avatar_url, rating, total_matches_played)';

    const { data } = await supabase
      .from('drill_requests')
      .select(`*, ${fkField}`)
      .eq(tab === 'incoming' ? 'to_user_id' : 'from_user_id', user.id)
      .order('created_at', { ascending: false });

    setRequests((data ?? []) as unknown as DrillRequest[]);
    setLoading(false);
  }

  async function respondToRequest(req: DrillRequest, action: 'accept' | 'decline', acceptedSlot?: { date: string; slot: number }) {
    const updates: any = {
      status: action === 'accept' ? 'accepted' : 'declined',
      responded_at: new Date().toISOString(),
    };
    if (acceptedSlot) updates.accepted_slot = acceptedSlot;

    const { error } = await supabase
      .from('drill_requests')
      .update(updates)
      .eq('id', req.id);
    if (error) {
      status.error(error.message);
      return;
    }
    load();
  }

  function acceptWithSelectedSlot(req: DrillRequest) {
    const idx = selectedSlotIdx[req.id];
    const slot = idx != null ? req.proposed_slots[idx] : null;
    if (!slot) {
      status.error('Tap one of the proposed times before accepting.');
      return;
    }
    respondToRequest(req, 'accept', slot);
  }

  function cancelRequest(req: DrillRequest) {
    setCancelTarget(req);
  }
  async function confirmCancelRequest() {
    if (!cancelTarget) return;
    setCancelling(true);
    await supabase.from('drill_requests').update({ status: 'cancelled' }).eq('id', cancelTarget.id);
    setCancelling(false);
    setCancelTarget(null);
    load();
  }

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: colors.bg }} size="large" color={colors.primary} />;

  return (
    <View style={S.container}>
      <StatusBanner status={status.value} style={{ marginHorizontal: 16, marginTop: 8 }} />
      <View style={S.tabs}>
        {(['incoming', 'outgoing'] as Tab[]).map(t => (
          <TouchableOpacity
            key={t}
            style={[S.tab, tab === t && S.tabActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[S.tabText, tab === t && S.tabTextActive]}>
              {t === 'incoming' ? '📥 Incoming' : '📤 Outgoing'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={requests}
        keyExtractor={r => r.id}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={
          <View style={S.emptyWrap}>
            <Text style={S.emptyEmoji}>📭</Text>
            <Text style={S.emptyText}>
              No {tab} requests yet.
              {tab === 'incoming'
                ? '\n\nWhen someone wants to drill with you, you\'ll see it here.'
                : '\n\nFind a partner from the Drill page to send your first request.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const otherProfile = tab === 'incoming' ? item.from_profile : item.to_profile;
          const avatar = AVATARS.find(a => a.id === (otherProfile?.avatar_id ?? 1)) ?? AVATARS[0];
          const isPending  = item.status === 'pending';
          const isAccepted = item.status === 'accepted';
          const isDeclined = item.status === 'declined';
          const isCancelled = item.status === 'cancelled';

          return (
            <View style={S.card}>
              <View style={S.cardTop}>
                <View style={[S.avatar, { backgroundColor: avatar.bgColor }]}>
                  <Text style={S.avatarEmoji}>{avatar.emoji}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={S.name}>{otherProfile?.full_name ?? 'Unknown'}</Text>
                  <Text style={S.sub}>
                    {formatPlupr(otherProfile?.rating, (otherProfile as any)?.total_matches_played)} PLUPR · {timeAgo(item.created_at)}
                  </Text>
                </View>
                <View style={[
                  S.statusPill,
                  isAccepted && S.statusAccepted,
                  isDeclined && S.statusDeclined,
                  isCancelled && S.statusCancelled,
                ]}>
                  <Text style={[
                    S.statusText,
                    isAccepted && S.statusTextAccepted,
                    isDeclined && S.statusTextDeclined,
                    isCancelled && S.statusTextCancelled,
                  ]}>
                    {isPending ? 'Pending' : isAccepted ? '✓ Accepted' : isDeclined ? '✗ Declined' : 'Cancelled'}
                  </Text>
                </View>
              </View>

              {item.message && (
                <View style={S.messageBox}>
                  <Text style={S.messageText}>"{item.message}"</Text>
                </View>
              )}

              {/* Slots display */}
              <Text style={S.slotsLabel}>
                {isAccepted && item.accepted_slot
                  ? `Confirmed time · ${durationLabel(item.length_minutes ?? 60)} drill`
                  : tab === 'incoming' && isPending
                    ? `Pick a time below to enable Accept · ${durationLabel(item.length_minutes ?? 60)} drill`
                    : `Proposed times · ${durationLabel(item.length_minutes ?? 60)} drill`}
              </Text>
              <View style={S.slotsWrap}>
                {(isAccepted && item.accepted_slot
                  ? [item.accepted_slot]
                  : item.proposed_slots
                ).map((s, i) => {
                  const interactable = tab === 'incoming' && isPending && !isAccepted;
                  const selected = selectedSlotIdx[item.id] === i;
                  const showAsAccepted = isAccepted || (interactable && selected);
                  return (
                    <TouchableOpacity
                      key={i}
                      style={[S.slotChip, showAsAccepted && S.slotChipAccepted]}
                      onPress={interactable ? () => setSelectedSlotIdx(prev => ({ ...prev, [item.id]: i })) : undefined}
                      activeOpacity={interactable ? 0.7 : 1}
                      disabled={!interactable}
                    >
                      <Text style={[S.slotChipText, showAsAccepted && S.slotChipTextAccepted]}>
                        {selected ? '✓ ' : ''}{dateLabel(s.date)} {dateSubLabel(s.date)} · {slotLabel(s.slot)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Actions */}
              {tab === 'incoming' && isPending && (
                <>
                  <View style={S.actions}>
                    <TouchableOpacity
                      style={[
                        S.actionBtn,
                        S.acceptBtn,
                        selectedSlotIdx[item.id] == null && S.actionBtnDim,
                      ]}
                      onPress={() => acceptWithSelectedSlot(item)}
                      disabled={selectedSlotIdx[item.id] == null}
                    >
                      <Text style={S.acceptText}>✓ Accept</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[S.actionBtn, S.declineBtn]}
                      onPress={() => respondToRequest(item, 'decline')}
                    >
                      <Text style={S.declineText}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={S.replyBtn} onPress={() => setChatRequest(item)}>
                    <Text style={S.replyBtnText}>💬 Reply to {otherProfile?.full_name?.split(' ')[0] ?? 'them'}</Text>
                  </TouchableOpacity>
                </>
              )}
              {tab === 'outgoing' && isPending && (
                <>
                  <TouchableOpacity style={S.replyBtn} onPress={() => setChatRequest(item)}>
                    <Text style={S.replyBtnText}>💬 Open chat</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={S.cancelBtn} onPress={() => cancelRequest(item)}>
                    <Text style={S.cancelText}>Cancel request</Text>
                  </TouchableOpacity>
                </>
              )}
              {/* Chat is available even after accept/decline so the pair can coordinate */}
              {!isPending && (
                <TouchableOpacity style={S.replyBtn} onPress={() => setChatRequest(item)}>
                  <Text style={S.replyBtnText}>💬 Chat</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
      />

      <DrillChatModal
        visible={!!chatRequest}
        request={chatRequest}
        currentUserId={userId}
        onClose={() => setChatRequest(null)}
      />

      <ConfirmModal
        visible={!!cancelTarget}
        title="Cancel request?"
        body={`Cancel your drill request to ${cancelTarget?.to_profile?.full_name ?? 'this player'}?`}
        primaryLabel="Yes, cancel"
        cancelLabel="No"
        variant="danger"
        busy={cancelling}
        onConfirm={confirmCancelRequest}
        onClose={() => setCancelTarget(null)}
      />
    </View>
  );
}

// ── Chat modal ─────────────────────────────────────────────
function DrillChatModal({
  visible, request, currentUserId, onClose,
}: {
  visible: boolean;
  request: DrillRequest | null;
  currentUserId: string | null;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const S = makeChatStyles(colors);
  const [messages, setMessages] = useState<DrillRequestMessage[]>([]);
  const [draft, setDraft]       = useState('');
  const [sending, setSending]   = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    if (!visible || !request) return;
    let cancelled = false;
    setSendError(null);
    (async () => {
      setLoadingMsgs(true);
      const { data } = await supabase
        .from('drill_request_messages')
        .select('*')
        .eq('request_id', request.id)
        .order('created_at');
      if (!cancelled) {
        setMessages((data ?? []) as DrillRequestMessage[]);
        setLoadingMsgs(false);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, request?.id]);

  async function sendMessage() {
    if (!request || !currentUserId) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setSendError(null);
    const { data, error } = await supabase
      .from('drill_request_messages')
      .insert({ request_id: request.id, sender_id: currentUserId, body })
      .select()
      .single();
    setSending(false);
    if (error) {
      setSendError(`Send failed: ${error.message}`);
      return;
    }
    setMessages(prev => [...prev, data as DrillRequestMessage]);
    setDraft('');
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }

  if (!request) return null;
  const otherName =
    (currentUserId === request.from_user_id ? request.to_profile : request.from_profile)?.full_name
    ?? 'Drill partner';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={S.backdrop}
      >
        <View style={S.sheet}>
          <View style={S.header}>
            <Text style={S.title} numberOfLines={1}>💬 {otherName}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={S.close}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            ref={listRef}
            style={S.messageList}
            contentContainerStyle={{ padding: 12 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          >
            {loadingMsgs ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : messages.length === 0 ? (
              <Text style={S.empty}>
                No messages yet. Say hi — you can ask about pace, courts, etc. before deciding to accept.
              </Text>
            ) : (
              messages.map(m => {
                const mine = m.sender_id === currentUserId;
                return (
                  <View key={m.id} style={[S.bubbleRow, mine && S.bubbleRowMine]}>
                    <View style={[S.bubble, mine ? S.bubbleMine : S.bubbleTheirs]}>
                      <Text style={[S.bubbleText, mine && S.bubbleTextMine]}>{m.body}</Text>
                      <Text style={[S.bubbleTime, mine && S.bubbleTimeMine]}>
                        {new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>

          {sendError && (
            <View style={S.sendErrorRow}>
              <Text style={S.sendErrorText}>{sendError}</Text>
            </View>
          )}
          <View style={S.composer}>
            <TextInput
              style={S.input}
              value={draft}
              onChangeText={(t) => { setDraft(t); if (sendError) setSendError(null); }}
              placeholder="Type a message…"
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={500}
              editable={!sending}
            />
            <TouchableOpacity
              style={[S.sendBtn, (!draft.trim() || sending) && S.sendBtnDim]}
              onPress={sendMessage}
              disabled={!draft.trim() || sending}
            >
              {sending
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={S.sendBtnText}>Send</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeChatStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet:       { backgroundColor: c.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '85%', minHeight: 420 },
    header:      { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border },
    title:       { flex: 1, fontSize: 16, fontWeight: '800', color: c.text },
    close:       { fontSize: 20, color: c.textSub, fontWeight: '700', paddingHorizontal: 4 },
    messageList: { flex: 1 },
    empty:       { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 40, lineHeight: 20 },
    bubbleRow:   { flexDirection: 'row', marginBottom: 6 },
    bubbleRowMine: { justifyContent: 'flex-end' },
    bubble:      { maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
    bubbleMine:  { backgroundColor: c.primary, borderBottomRightRadius: 4 },
    bubbleTheirs:{ backgroundColor: c.surfaceAlt, borderBottomLeftRadius: 4 },
    bubbleText:  { fontSize: 14, color: c.text, lineHeight: 19 },
    bubbleTextMine: { color: '#fff' },
    bubbleTime:  { fontSize: 10, color: c.textMuted, marginTop: 2 },
    bubbleTimeMine: { color: 'rgba(255,255,255,0.7)' },
    composer:    { flexDirection: 'row', padding: 10, gap: 8, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface, alignItems: 'flex-end' },
    input:       { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, maxHeight: 100, fontSize: 14, color: c.text, backgroundColor: c.bg },
    sendBtn:     { backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, minWidth: 64, alignItems: 'center', justifyContent: 'center' },
    sendBtnDim:  { opacity: 0.5 },
    sendBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
    sendErrorRow:{ paddingHorizontal: 12, paddingTop: 8, backgroundColor: c.surface },
    sendErrorText:{ color: '#c62828', fontSize: 12, fontWeight: '600' },
  });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:   { flex: 1, backgroundColor: c.bg },
    tabs:        { flexDirection: 'row', backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border },
    tab:         { flex: 1, paddingVertical: 14, alignItems: 'center', borderBottomWidth: 3, borderBottomColor: 'transparent' },
    tabActive:   { borderBottomColor: c.primary },
    tabText:     { fontSize: 14, color: c.textMuted, fontWeight: '600' },
    tabTextActive:{ color: c.primary, fontWeight: '800' },

    emptyWrap:   { alignItems: 'center', padding: 40, marginTop: 60 },
    emptyEmoji:  { fontSize: 56, marginBottom: 12 },
    emptyText:   { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 22 },

    card:        {
      backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    },
    cardTop:     { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
    avatar:      { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: 22 },
    name:        { fontSize: 15, fontWeight: '800', color: c.text },
    sub:         { fontSize: 11, color: c.textMuted, marginTop: 2 },

    statusPill:  { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: c.surfaceAlt },
    statusAccepted: { backgroundColor: c.primaryLight },
    statusDeclined: { backgroundColor: c.bg },
    statusCancelled: { backgroundColor: c.bg },
    statusText:  { fontSize: 11, fontWeight: '800', color: c.textSub },
    statusTextAccepted: { color: c.primary },
    statusTextDeclined: { color: c.danger },
    statusTextCancelled: { color: c.textMuted },

    messageBox:  { backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10, marginBottom: 10 },
    messageText: { fontSize: 13, color: c.textSub, fontStyle: 'italic', lineHeight: 18 },

    slotsLabel:  { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
    slotsWrap:   { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
    slotChip:    { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    slotChipAccepted: { backgroundColor: c.primaryLight, borderColor: c.primary },
    slotChipText:{ fontSize: 12, color: c.textSub, fontWeight: '600' },
    slotChipTextAccepted: { color: c.primary, fontWeight: '800' },

    actions:     { flexDirection: 'row', gap: 10 },
    actionBtn:   { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center' },
    actionBtnDim:{ opacity: 0.4 },
    acceptBtn:   { backgroundColor: c.primary },
    acceptText:  { color: '#fff', fontWeight: '800', fontSize: 14 },
    declineBtn:  { backgroundColor: c.surfaceAlt, borderWidth: 1.5, borderColor: c.border },
    declineText: { color: c.textSub, fontWeight: '700', fontSize: 14 },
    replyBtn:    { marginTop: 10, padding: 10, borderRadius: 10, alignItems: 'center', backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    replyBtnText:{ color: c.primary, fontWeight: '700', fontSize: 13 },
    cancelBtn:   { padding: 10, alignItems: 'center' },
    cancelText:  { color: c.danger, fontSize: 13, fontWeight: '600' },
  });
}
