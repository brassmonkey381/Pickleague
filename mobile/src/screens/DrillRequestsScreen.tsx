import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { DrillRequest, DrillRequestMessage, DrillSession, RootStackParamList } from '../types';
import { dateLabel, dateSubLabel, durationLabel, slotLabel } from '../lib/drillTime';
import { formatPlupr } from '../lib/plupr';
import { AVATARS } from '../data/profileCustomization';
import ConfirmModal from '../components/ConfirmModal';
import StatusBanner from '../components/StatusBanner';
import FlairName from '../components/FlairName';
import DrillReviewModal from '../components/DrillReviewModal';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import AppRefreshControl from '../components/AppRefreshControl';
import { useStatusMessage } from '../lib/useStatusMessage';
import { useRefresh } from '../lib/useRefresh';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DrillRequests'> };

type Tab = 'incoming' | 'outgoing';

// A past, not-yet-reviewed drill session the current user can review for pickles.
type ReviewableSession = DrillSession & { partner_name: string };

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
  // When true, the chat modal renders a "Did you both decide on a location?"
  // prompt above messages — set right after a successful accept.
  const [chatLocationPrompt, setChatLocationPrompt] = useState(false);

  // Cancel-request confirm
  const [cancelTarget, setCancelTarget] = useState<DrillRequest | null>(null);

  // Past drill sessions the current user hasn't reviewed yet (+ the review modal target).
  const [reviewable, setReviewable] = useState<ReviewableSession[]>([]);
  const [reviewTarget, setReviewTarget] = useState<ReviewableSession | null>(null);

  // Card-level location picker: which request is choosing, and the cached court list.
  const [locationPickerReq, setLocationPickerReq] = useState<DrillRequest | null>(null);
  const [courts, setCourts] = useState<CourtRow[]>([]);
  const [courtsLoading, setCourtsLoading] = useState(false);
  const [cancelling, setCancelling]     = useState(false);

  const status = useStatusMessage();
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, [tab]));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const fkField = tab === 'incoming'
      ? 'from_profile:profiles!drill_requests_from_user_id_fkey(id, full_name, avatar_id, avatar_url, rating, total_matches_played, name_color, list_name_style_id)'
      : 'to_profile:profiles!drill_requests_to_user_id_fkey(id, full_name, avatar_id, avatar_url, rating, total_matches_played, name_color, list_name_style_id)';

    const { data } = await supabase
      .from('drill_requests')
      .select(`*, ${fkField}`)
      .eq(tab === 'incoming' ? 'to_user_id' : 'from_user_id', user.id)
      .order('created_at', { ascending: false });

    setRequests((data ?? []) as unknown as DrillRequest[]);
    setLoading(false);

    loadReviewable(user.id);
  }

  // Find started drill sessions the current user is a participant of and hasn't
  // reviewed yet, so we can offer the self-review + pickle bonus.
  async function loadReviewable(uid: string) {
    const { data } = await supabase
      .from('drill_sessions')
      .select(`
        *,
        p1:profiles!drill_sessions_player1_id_fkey(id, full_name),
        p2:profiles!drill_sessions_player2_id_fkey(id, full_name),
        drill_session_reviews(user_id)
      `)
      .or(`player1_id.eq.${uid},player2_id.eq.${uid}`)
      .order('starts_at', { ascending: false, nullsFirst: false });

    const now = Date.now();
    const rows = (data ?? []) as any[];
    const list: ReviewableSession[] = rows
      .filter(r => {
        // Only sessions that have started (starts_at null or in the past).
        const started = !r.starts_at || new Date(r.starts_at).getTime() <= now;
        // Only sessions this user hasn't reviewed yet.
        const reviewedByMe = (r.drill_session_reviews ?? []).some((rv: any) => rv.user_id === uid);
        return started && !reviewedByMe;
      })
      .map(r => ({
        ...r,
        partner_name: r.player1_id === uid ? r.p2?.full_name ?? 'your partner' : r.p1?.full_name ?? 'your partner',
      }));
    setReviewable(list);
  }

  function onReviewSubmitted(sessionId: string, earned: number) {
    // Drop the reviewed session from the list, close the modal, and confirm the haul.
    setReviewable(prev => prev.filter(s => s.id !== sessionId));
    setReviewTarget(null);
    status.success(`+${earned} pickles earned!`);
  }

  async function respondToRequest(req: DrillRequest, action: 'accept' | 'decline', acceptedSlot?: { date: string; slot: number }): Promise<boolean> {
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
      return false;
    }
    load();
    return true;
  }

  async function acceptWithSelectedSlot(req: DrillRequest) {
    const idx = selectedSlotIdx[req.id];
    const slot = idx != null ? req.proposed_slots[idx] : null;
    if (!slot) {
      status.error('Tap one of the proposed times before accepting.');
      return;
    }
    const ok = await respondToRequest(req, 'accept', slot);
    if (ok) {
      // Auto-open chat with the location prompt so the pair can sort out where
      // to play before they show up.
      setChatRequest({ ...req, status: 'accepted', accepted_slot: slot });
      setChatLocationPrompt(true);
    }
  }

  async function openLocationPicker(req: DrillRequest) {
    setLocationPickerReq(req);
    if (courts.length === 0) {
      setCourtsLoading(true);
      const { data } = await supabase
        .from('court_locations')
        .select('id, name, nickname, address')
        .order('name');
      setCourts((data ?? []) as CourtRow[]);
      setCourtsLoading(false);
    }
  }

  async function saveLocation(req: DrillRequest, court: CourtRow) {
    setLocationPickerReq(null);
    const label = court.nickname ? `${court.nickname} (${court.name})` : court.name;
    const { error } = await supabase
      .from('drill_requests')
      .update({ location_name: label, location_id: court.id })
      .eq('id', req.id);
    if (error) { status.error(error.message); return; }
    setRequests(prev => prev.map(r =>
      r.id === req.id ? { ...r, location_name: label, location_id: court.id } : r
    ));
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

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

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
        refreshControl={<AppRefreshControl {...refresh} />}
        ListHeaderComponent={
          reviewable.length > 0 ? (
            // TODO: smoke-test in browser — review-your-drills section + bonus modal
            <View style={S.reviewSection}>
              <Text style={S.reviewSectionTitle}>📝 Review your drills</Text>
              <Text style={S.reviewSectionSub}>
                Rate 5 aspects (5 🥒 each) and add a self-review (up to 50 🥒) to claim your bonus.
              </Text>
              {reviewable.map(s => (
                <View key={s.id} style={S.reviewCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={S.reviewCardName}>Drill with {s.partner_name}</Text>
                    <Text style={S.reviewCardSub}>
                      {dateLabel(s.session_date)} {dateSubLabel(s.session_date)} · {slotLabel(s.session_slot)} · {durationLabel(s.length_minutes ?? 60)}
                    </Text>
                  </View>
                  <TouchableOpacity style={S.reviewCardBtn} onPress={() => setReviewTarget(s)}>
                    <Text style={S.reviewCardBtnText}>📝 Review</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          <EmptyState
            icon="📭"
            title={`No ${tab} requests yet.`}
            subtitle={tab === 'incoming'
              ? 'When someone wants to drill with you, you\'ll see it here.'
              : 'Find a partner from the Drill page to send your first request.'}
          />
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
                  {/* TODO: smoke-test in browser — list mode FlairName wire-up */}
                  <FlairName
                    name={otherProfile?.full_name ?? 'Unknown'}
                    nameColor={otherProfile?.name_color}
                    styleId={otherProfile?.list_name_style_id ?? null}
                    mode="list"
                    style={S.name}
                  />
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

              {/* Location — both parties can set/change a confirmed court */}
              {(isAccepted || isPending) && (
                <View style={S.locationSection}>
                  {item.location_name ? (
                    <View style={S.locationConfirmedRow}>
                      <Text style={S.locationConfirmedText} numberOfLines={2}>
                        📍 {item.location_name}
                      </Text>
                      <TouchableOpacity onPress={() => openLocationPicker(item)}>
                        <Text style={S.locationChangeText}>Change</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity style={S.locationSetBtn} onPress={() => openLocationPicker(item)}>
                      <Text style={S.locationSetText}>📍 Set a location</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

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
        showLocationPrompt={chatLocationPrompt}
        onDismissLocationPrompt={() => setChatLocationPrompt(false)}
        onClose={() => { setChatRequest(null); setChatLocationPrompt(false); }}
      />

      <CourtPickerModal
        visible={!!locationPickerReq}
        courts={courts}
        loading={courtsLoading}
        onPick={(court) => { if (locationPickerReq) saveLocation(locationPickerReq, court); }}
        onClose={() => setLocationPickerReq(null)}
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

      <DrillReviewModal
        session={reviewTarget}
        onSubmitted={onReviewSubmitted}
        onClose={() => setReviewTarget(null)}
      />
    </View>
  );
}

// ── Chat modal ─────────────────────────────────────────────
type CourtRow = { id: string; name: string; nickname: string | null; address: string | null };

function DrillChatModal({
  visible, request, currentUserId, showLocationPrompt, onDismissLocationPrompt, onClose,
}: {
  visible: boolean;
  request: DrillRequest | null;
  currentUserId: string | null;
  showLocationPrompt?: boolean;
  onDismissLocationPrompt?: () => void;
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

  // Location-picker state for the "Did you both decide?" prompt.
  // mode = 'confirm'  → "yes, we decided" → on pick, send confirmation message
  // mode = 'propose' → "no, ask them"    → on pick, prefill the composer
  const [locationPickerMode, setLocationPickerMode] = useState<'confirm' | 'propose' | null>(null);
  const [courts, setCourts] = useState<CourtRow[]>([]);
  const [courtsLoading, setCourtsLoading] = useState(false);

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

  async function openLocationPicker(mode: 'confirm' | 'propose') {
    setLocationPickerMode(mode);
    if (courts.length === 0) {
      setCourtsLoading(true);
      const { data } = await supabase
        .from('court_locations')
        .select('id, name, nickname, address')
        .order('name');
      setCourts((data ?? []) as CourtRow[]);
      setCourtsLoading(false);
    }
  }

  async function handleCourtPick(court: CourtRow) {
    const mode = locationPickerMode;
    setLocationPickerMode(null);
    if (!mode || !request || !currentUserId) return;
    const label = court.nickname ? `${court.nickname} (${court.name})` : court.name;
    if (mode === 'confirm') {
      // Persist the confirmed location on the request so it shows on the card.
      await supabase
        .from('drill_requests')
        .update({ location_name: label, location_id: court.id })
        .eq('id', request.id);
      // Send confirmation message.
      setSending(true);
      const { data, error } = await supabase
        .from('drill_request_messages')
        .insert({ request_id: request.id, sender_id: currentUserId, body: `📍 We're playing at: ${label}` })
        .select()
        .single();
      setSending(false);
      if (error) { setSendError(`Send failed: ${error.message}`); return; }
      setMessages(prev => [...prev, data as DrillRequestMessage]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } else {
      // Propose mode: prefill the composer; let the user edit and send.
      setDraft(`Where would you like to play? Does ${label} work for you?`);
    }
    onDismissLocationPrompt?.();
  }

  if (!request) return null;
  const otherName =
    (currentUserId === request.from_user_id ? request.to_profile : request.from_profile)?.full_name
    ?? 'Drill partner';

  const sheet = (
    <View style={S.sheet}>
      <View style={S.header}>
        <Text style={S.title} numberOfLines={1}>💬 {otherName}</Text>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel="Close chat">
          <Text style={S.close}>✕</Text>
        </TouchableOpacity>
      </View>

      {showLocationPrompt && (
        <View style={S.locationPrompt}>
          <Text style={S.locationPromptText}>📍 Did you both decide on a location?</Text>
          <View style={S.locationPromptRow}>
            <TouchableOpacity
              style={[S.locationPromptBtn, S.locationPromptBtnYes]}
              onPress={() => openLocationPicker('confirm')}
            >
              <Text style={S.locationPromptBtnTextYes}>Yes, pick a court</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.locationPromptBtn, S.locationPromptBtnNo]}
              onPress={() => openLocationPicker('propose')}
            >
              <Text style={S.locationPromptBtnTextNo}>No — ask them</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={S.locationPromptDismiss}
              onPress={() => onDismissLocationPrompt?.()}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss location prompt"
            >
              <Text style={S.locationPromptDismissText}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

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

      {/* Location picker overlay — sits inside the chat sheet so we don't
          have to stack two RN Modals (problematic on web). */}
      {locationPickerMode !== null && (
        <View style={S.locationPickerOverlay}>
          <View style={S.locationPickerPanel}>
            <View style={S.locationPickerHeader}>
              <Text style={S.locationPickerTitle}>
                {locationPickerMode === 'confirm' ? 'Where are you playing?' : 'Suggest a court'}
              </Text>
              <TouchableOpacity onPress={() => setLocationPickerMode(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel="Close location picker">
                <Text style={S.close}>✕</Text>
              </TouchableOpacity>
            </View>
            {courtsLoading ? (
              <ActivityIndicator style={{ marginVertical: 24 }} color={colors.primary} />
            ) : courts.length === 0 ? (
              <Text style={S.empty}>No courts found in the database yet.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ padding: 8 }}>
                {courts.map(c2 => (
                  <TouchableOpacity
                    key={c2.id}
                    style={S.courtRow}
                    onPress={() => handleCourtPick(c2)}
                  >
                    <Text style={S.courtRowName}>{c2.nickname ?? c2.name}</Text>
                    {c2.nickname && <Text style={S.courtRowSub}>{c2.name}</Text>}
                    {c2.address && <Text style={S.courtRowSub}>{c2.address}</Text>}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      )}
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {Platform.OS === 'web' ? (
        <View style={S.backdrop}>{sheet}</View>
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={S.backdrop}
        >
          {sheet}
        </KeyboardAvoidingView>
      )}
    </Modal>
  );
}

// ── Court picker modal (card-level) ────────────────────────
function CourtPickerModal({
  visible, courts, loading, onPick, onClose,
}: {
  visible: boolean;
  courts: CourtRow[];
  loading: boolean;
  onPick: (court: CourtRow) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const S = makeCourtPickerStyles(colors);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={S.overlay}>
        <View style={S.panel}>
          <View style={S.header}>
            <Text style={S.title}>📍 Pick a location</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityRole="button" accessibilityLabel="Close location picker">
              <Text style={S.close}>✕</Text>
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator style={{ marginVertical: 24 }} color={colors.primary} />
          ) : courts.length === 0 ? (
            <Text style={S.empty}>No courts found in the database yet.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ padding: 8 }}>
              {courts.map(court => (
                <TouchableOpacity key={court.id} style={S.row} onPress={() => onPick(court)}>
                  <Text style={S.rowName}>{court.nickname ?? court.name}</Text>
                  {court.nickname && <Text style={S.rowSub}>{court.name}</Text>}
                  {court.address && <Text style={S.rowSub}>{court.address}</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeCourtPickerStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 16 },
    panel:   { backgroundColor: c.bg, borderRadius: 12, width: '100%', maxWidth: 480, borderWidth: 1, borderColor: c.border },
    header:  { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border },
    title:   { flex: 1, fontSize: 15, fontWeight: '800', color: c.text },
    close:   { fontSize: 20, color: c.textSub, fontWeight: '700', paddingHorizontal: 4 },
    empty:   { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 32 },
    row:     { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, marginBottom: 4 },
    rowName: { fontSize: 14, fontWeight: '700', color: c.text },
    rowSub:  { fontSize: 12, color: c.textMuted, marginTop: 2 },
  });
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

    locationPrompt:        { padding: 12, backgroundColor: c.surfaceAlt, borderBottomWidth: 1, borderBottomColor: c.border },
    locationPromptText:    { fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 8 },
    locationPromptRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
    locationPromptBtn:     { flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
    locationPromptBtnYes:  { backgroundColor: c.primary, borderColor: c.primary },
    locationPromptBtnNo:   { backgroundColor: c.bg, borderColor: c.border },
    locationPromptBtnTextYes: { color: '#fff', fontWeight: '700', fontSize: 12 },
    locationPromptBtnTextNo:  { color: c.text, fontWeight: '700', fontSize: 12 },
    locationPromptDismiss:    { paddingHorizontal: 6 },
    locationPromptDismissText:{ color: c.textMuted, fontSize: 16, fontWeight: '700' },

    locationPickerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center', padding: 16 },
    locationPickerPanel:   { backgroundColor: c.bg, borderRadius: 12, width: '100%', maxWidth: 480, borderWidth: 1, borderColor: c.border },
    locationPickerHeader:  { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: c.border },
    locationPickerTitle:   { flex: 1, fontSize: 15, fontWeight: '800', color: c.text },
    courtRow:              { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, marginBottom: 4 },
    courtRowName:          { fontSize: 14, fontWeight: '700', color: c.text },
    courtRowSub:           { fontSize: 12, color: c.textMuted, marginTop: 2 },
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

    reviewSection:      { backgroundColor: c.primaryLight, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: c.primary },
    reviewSectionTitle: { fontSize: 15, fontWeight: '800', color: c.primary },
    reviewSectionSub:   { fontSize: 12, color: c.textSub, marginTop: 2, marginBottom: 10 },
    reviewCard:         { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.surface, borderRadius: 10, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: c.border },
    reviewCardName:     { fontSize: 14, fontWeight: '700', color: c.text },
    reviewCardSub:      { fontSize: 11, color: c.textMuted, marginTop: 2 },
    reviewCardBtn:      { backgroundColor: c.primary, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
    reviewCardBtnText:  { color: '#fff', fontWeight: '800', fontSize: 12 },

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

    locationSection:       { marginBottom: 12 },
    locationConfirmedRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.primaryLight, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: c.primary },
    locationConfirmedText: { flex: 1, fontSize: 13, fontWeight: '700', color: c.primary },
    locationChangeText:    { fontSize: 12, fontWeight: '700', color: c.primary, textDecorationLine: 'underline' },
    locationSetBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, backgroundColor: c.surfaceAlt },
    locationSetText:       { fontSize: 13, fontWeight: '700', color: c.textSub },

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
