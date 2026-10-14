import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Pressable, StyleSheet, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import {
  Panel,
  Badge,
  ClampText,
  FilterPill,
  ListCard,
  SectionHeader,
  SegmentedToggle,
  CollapsibleSection,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
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
import PlayerModerationMenu from '../components/PlayerModerationMenu';
import { SkeletonList } from '../components/Skeleton';
import AppRefreshControl from '../components/AppRefreshControl';
import { useStatusMessage } from '../lib/useStatusMessage';
import { useRefresh } from '../lib/useRefresh';
import { trackSectionToggle } from '../lib/analytics';
import DrillUpcomingSessions from '../components/DrillUpcomingSessions';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'DrillRequests'>;
  route: RouteProp<RootStackParamList, 'DrillRequests'>;
};

type Tab = 'incoming' | 'outgoing';

// A past, not-yet-reviewed drill session the current user can review for pickles.
type ReviewableSession = DrillSession & { partner_name: string };

type GroupKey = 'open' | 'accepted' | 'closed';
const GROUP_ORDER: GroupKey[] = ['open', 'accepted', 'closed'];

export default function DrillRequestsScreen({ route }: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const t = textStyles(colors);
  // From a push: a drill request or session to show (and maybe open its chat).
  const focusId = route.params?.focusId;
  const openChat = !!route.params?.openChat;
  const chatOpenedFor = useRef<string | null>(null);
  // Same once-per-push guard for auto-opening the Closed section.
  const closedOpenedFor = useRef<string | null>(null);
  const [sessionsKey, setSessionsKey] = useState(0);

  // focusId may be a drill_requests.id (a request row) or a drill_sessions.id
  // (Home's drill rows, the reminder push): whichever row matches reports its
  // node, measured against the scroll content (native and web), and the list
  // scrolls there once per focusId so later reloads never jump the user.
  const scrollRef = useRef<ScrollView>(null);
  const focusedRequestRef = useRef<View>(null);
  const scrolledFor = useRef<string | null>(null);
  function scrollFocusedIntoView(node: View | null) {
    if (!focusId || !node || scrolledFor.current === focusId) return;
    const inner = (scrollRef.current as any)?.getInnerViewRef?.();
    const target: any = node;
    if (!inner || typeof target.measureLayout !== 'function') return;
    try {
      target.measureLayout(inner, (_x: number, y: number) => {
        scrolledFor.current = focusId;
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - SPACE.sm), animated: true }));
      }, () => { /* not measurable yet; the next layout retries */ });
    } catch { /* stay at the top */ }
  }

  const [tab, setTab] = useState<Tab>('incoming');
  const [userId, setUserId] = useState<string | null>(null);
  const [requests, setRequests] = useState<DrillRequest[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed read must not render as "no drill requests".
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-request slot selection for the incoming Accept flow.
  // Key = request.id, value = index into proposed_slots that the receiver picked.
  const [selectedSlotIdx, setSelectedSlotIdx] = useState<Record<string, number>>({});
  // Declined / cancelled requests sit in a collapsed "Closed" section, opened
  // for the visit when a push points at one of them.
  const [closedOpen, setClosedOpen] = useState(false);

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

  // A push points at a request: show the tab it lives on (incoming if it was
  // sent to me, outgoing if I sent it). A session id matches no request and
  // is highlighted in the sessions section instead.
  useEffect(() => {
    if (!focusId) return;
    let cancelled = false;
    void (async () => {
      try {
        const uid = await currentUserId(supabase);
        if (!uid || cancelled) return;
        const row = await sbCall(
          () => supabase.from('drill_requests').select('id, from_user_id').eq('id', focusId).maybeSingle(),
          { retries: 1, timeoutMs: 8_000 },
        ) as { id: string; from_user_id: string } | null;
        if (!cancelled && row) setTab(row.from_user_id === uid ? 'outgoing' : 'incoming');
      } catch {
        // stay on the current tab
      }
    })();
    return () => { cancelled = true; };
  }, [focusId]);

  // "Open chat", or a tapped chat push: open the thread once the request is listed.
  useEffect(() => {
    if (!focusId || !openChat || chatOpenedFor.current === focusId) return;
    const req = requests.find(r => r.id === focusId);
    if (!req) return;
    chatOpenedFor.current = focusId;
    setChatRequest(req);
  }, [focusId, openChat, requests]);

  async function load() {
    // LOCAL session read (getUser() is a network call that fails offline).
    const uid = await currentUserId(supabase);
    if (!uid) { setLoading(false); return; }
    setUserId(uid);

    const fkField = tab === 'incoming'
      ? 'from_profile:profiles!drill_requests_from_user_id_fkey(id, full_name, avatar_id, avatar_url, rating, total_matches_played, name_color, list_name_style_id)'
      : 'to_profile:profiles!drill_requests_to_user_id_fkey(id, full_name, avatar_id, avatar_url, rating, total_matches_played, name_color, list_name_style_id)';

    try {
      const data = await sbCall(() => supabase
        .from('drill_requests')
        .select(`*, ${fkField}`)
        .eq(tab === 'incoming' ? 'to_user_id' : 'from_user_id', uid)
        .order('created_at', { ascending: false }));

      setRequests((data ?? []) as unknown as DrillRequest[]);
      setLoadError(null);
    } catch (e) {
      // A pending drill invite hidden behind "no requests" gets ignored and
      // expires — say the read failed instead.
      setLoadError(friendlySbMessage(e, "Couldn't load your drill requests."));
    } finally {
      // Always: the old early return + happy-path-only flag stranded the skeleton.
      setLoading(false);
    }

    void loadReviewable(uid);
    setSessionsKey(k => k + 1);
  }

  // Find started drill sessions the current user is a participant of and hasn't
  // reviewed yet, so we can offer the self-review + pickle bonus.
  async function loadReviewable(uid: string) {
    let data: any[] | null;
    try {
      data = await sbCall(() => supabase
        .from('drill_sessions')
        .select(`
          *,
          p1:profiles!drill_sessions_player1_id_fkey(id, full_name),
          p2:profiles!drill_sessions_player2_id_fkey(id, full_name),
          drill_session_reviews(user_id)
        `)
        .or(`player1_id.eq.${uid},player2_id.eq.${uid}`)
        .order('starts_at', { ascending: false, nullsFirst: false }));
    } catch {
      // Secondary list — keep whatever we last had rather than clearing it.
      return;
    }

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

    try {
      // Idempotent status write, so retrying a dropped request is safe.
      await sbCall(() => supabase.from('drill_requests').update(updates).eq('id', req.id));
    } catch (e) {
      status.error(friendlySbMessage(e, `Couldn't ${action} that request.`));
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
      try {
        const data = await sbCall(() => supabase
          .from('court_locations')
          .select('id, name, nickname, address')
          .order('name'));
        setCourts((data ?? []) as CourtRow[]);
      } catch (e) {
        // An empty picker reads as "no courts exist" — say what happened.
        status.error(friendlySbMessage(e, "Couldn't load the court list."));
      } finally {
        setCourtsLoading(false);
      }
    }
  }

  async function saveLocation(req: DrillRequest, court: CourtRow) {
    setLocationPickerReq(null);
    const label = court.nickname ? `${court.nickname} (${court.name})` : court.name;
    try {
      await sbCall(() => supabase
        .from('drill_requests')
        .update({ location_name: label, location_id: court.id })
        .eq('id', req.id));
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't save that location."));
      return;
    }
    setRequests(prev => prev.map(r =>
      r.id === req.id ? { ...r, location_name: label, location_id: court.id } : r
    ));
    // On an accepted request this locks it in: the server marks the setter
    // confirmed, so reload the sessions to show ✓ Confirmed.
    if (req.status === 'accepted') load();
  }

  function cancelRequest(req: DrillRequest) {
    setCancelTarget(req);
  }
  async function confirmCancelRequest() {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      // Was fire-and-forget: a failed cancel closed the modal and the request
      // reappeared on the next load with no explanation.
      await sbCall(() =>
        supabase.from('drill_requests').update({ status: 'cancelled' }).eq('id', cancelTarget.id),
      );
      setCancelTarget(null);
      load();
    } catch (e) {
      status.error(friendlySbMessage(e, "Couldn't cancel that request."));
    } finally {
      setCancelling(false);
    }
  }

  // Grouped by what the request needs: open ones first (the only group with
  // actions on someone's clock), then accepted, then the closed ones folded
  // away. The request a push pointed at goes first within its group, and its
  // group renders first (see groupOrder), so a push lands with it in view the
  // way the old flat list put it at the very top.
  const groups = useMemo(() => {
    const byFocus = (a: DrillRequest, b: DrillRequest) =>
      (a.id === focusId ? -1 : b.id === focusId ? 1 : 0);
    const open = requests.filter(r => r.status === 'pending').sort(byFocus);
    const accepted = requests.filter(r => r.status === 'accepted').sort(byFocus);
    const closed = requests.filter(r => r.status === 'declined' || r.status === 'cancelled').sort(byFocus);
    return { open, accepted, closed };
  }, [requests, focusId]);

  const focusGroup: GroupKey | null = !focusId ? null
    : groups.open.some(r => r.id === focusId) ? 'open'
    : groups.accepted.some(r => r.id === focusId) ? 'accepted'
    : groups.closed.some(r => r.id === focusId) ? 'closed'
    : null;
  const groupOrder: GroupKey[] = focusGroup
    ? [focusGroup, ...GROUP_ORDER.filter(k => k !== focusGroup)]
    : GROUP_ORDER;

  // A push for a closed request opens the Closed section once it's listed —
  // once per focusId, so a later reload (focus, pull-to-refresh, onChanged)
  // doesn't re-open it after the user collapsed it.
  useEffect(() => {
    if (!focusId || closedOpenedFor.current === focusId) return;
    if (!groups.closed.some(r => r.id === focusId)) return;
    closedOpenedFor.current = focusId;
    setClosedOpen(true);
  }, [focusId, groups.closed]);

  if (loading) return <View style={S.container}><SkeletonList rows={6} variant="row" /></View>;

  if (loadError && requests.length === 0) {
    return (
      <View style={S.container}>
        <EmptyState
          icon="📡"
          title="Couldn't load drill requests"
          subtitle={loadError}
          actionLabel="Try again"
          onAction={() => { setLoading(true); void load(); }}
        />
      </View>
    );
  }

  // ── One request ─────────────────────────────────────────────────────────
  // The request a link pointed at reports its node once laid out, so the list
  // can scroll it into view (it sits below the sessions / review sections).
  function renderRequest(item: DrillRequest) {
    const node = renderRequestBody(item);
    if (item.id !== focusId) return node;
    return (
      <View
        key={item.id}
        ref={focusedRequestRef}
        collapsable={false}
        onLayout={() => scrollFocusedIntoView(focusedRequestRef.current)}
      >
        {node}
      </View>
    );
  }

  function renderRequestBody(item: DrillRequest) {
    const otherProfile = tab === 'incoming' ? item.from_profile : item.to_profile;
    const avatar = AVATARS.find(a => a.id === (otherProfile?.avatar_id ?? 1)) ?? AVATARS[0];
    const isPending  = item.status === 'pending';
    const isAccepted = item.status === 'accepted';
    const isClosed   = !isPending && !isAccepted;
    const length = durationLabel(item.length_minutes ?? 60);
    const firstName = otherProfile?.full_name?.split(' ')[0] ?? 'them';

    // The status is the group's heading, so the card only says it when the
    // group mixes two (Closed: declined + cancelled).
    const subFacts = [
      `${formatPlupr(otherProfile?.rating, (otherProfile as any)?.total_matches_played)} PLUPR`,
      isClosed ? (item.status === 'declined' ? 'Declined' : 'Cancelled') : null,
      timeAgo(item.created_at),
    ].filter(Boolean).join(' · ');

    const chatButton = (
      <Button
        size="sm"
        variant="outline"
        title={tab === 'incoming' && isPending ? `💬 Reply to ${firstName}` : '💬 Chat'}
        onPress={() => setChatRequest(item)}
      />
    );

    const header = (
      <View style={S.cardTop}>
        <View style={[S.avatar, { backgroundColor: avatar.bgColor }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={S.avatarEmoji} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{avatar.emoji}</Text>
        </View>
        <View style={S.cardTopText}>
          {/* TODO: smoke-test in browser — list mode FlairName wire-up */}
          <FlairName
            name={otherProfile?.full_name ?? 'Player'}
            nameColor={otherProfile?.name_color}
            styleId={otherProfile?.list_name_style_id ?? null}
            mode="list"
            style={t.title}
          />
          <Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{subFacts}</Text>
        </View>
        {/* Accepted and closed requests: Chat is the one action, so it sits
            on the header line instead of a row of its own. */}
        {!isPending ? chatButton : null}
        {otherProfile?.id ? (
          <PlayerModerationMenu
            userId={otherProfile.id}
            userName={otherProfile.full_name ?? 'this player'}
            meId={userId}
            subjectType="message"
            subjectId={item.id}
            snapshot={{ request_message: item.message ?? null }}
            onChanged={() => { void load(); }}
            compact
          />
        ) : null}
      </View>
    );

    // Closed: the header line is the whole card.
    if (isClosed) {
      return (
        <ListCard
          key={item.id}
          variant="row"
          highlighted={focusId === item.id}
          title={header}
          style={S.closedRow}
        />
      );
    }

    const interactable = tab === 'incoming' && isPending;
    const slots = isAccepted && item.accepted_slot ? [item.accepted_slot] : item.proposed_slots;

    return (
      <Panel key={item.id} style={[S.card, focusId === item.id && S.cardFocused]}>
        {header}

        {item.message ? (
          <View style={S.messageBox}>
            {/* 2-line clamp plus "more" (content rule 1), shown only when it overflows. */}
            <ClampText style={S.messageText} moreA11yLabel="Show the whole message" lessA11yLabel="Show less of the message">
              {`"${item.message}"`}
            </ClampText>
          </View>
        ) : null}

        {/* Slots: pick one to enable Accept (incoming), or read them. */}
        <Text style={S.slotsLabel} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          {isAccepted && item.accepted_slot
            ? `Confirmed time · ${length} drill`
            : interactable
              ? `Pick a time to enable Accept · ${length} drill`
              : `Proposed times · ${length} drill`}
        </Text>
        <View style={S.slotsWrap} accessibilityRole={interactable ? 'radiogroup' : undefined}>
          {(slots ?? []).map((s, i) => {
            const label = `${dateLabel(s.date)} ${dateSubLabel(s.date)} · ${slotLabel(s.slot)}`;
            if (interactable) {
              const selected = selectedSlotIdx[item.id] === i;
              return (
                <FilterPill
                  key={i}
                  label={selected ? `✓ ${label}` : label}
                  active={selected}
                  onPress={() => setSelectedSlotIdx(prev => ({ ...prev, [item.id]: i }))}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={label}
                />
              );
            }
            return (
              <Badge
                key={i}
                label={label}
                tone={isAccepted ? 'brand' : 'neutral'}
                maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              />
            );
          })}
        </View>

        {/* Location — both parties can set/change a confirmed court. With an
            accepted time it is locked in: "We're playing at X · <time>". */}
        {item.location_name ? (
          <View style={S.locationRow}>
            <Text style={S.locationText} numberOfLines={isAccepted && item.accepted_slot ? 2 : 1}>
              {isAccepted && item.accepted_slot
                ? `📍 We're playing at ${item.location_name} · ${dateLabel(item.accepted_slot.date)} ${dateSubLabel(item.accepted_slot.date)} · ${slotLabel(item.accepted_slot.slot)}`
                : `📍 ${item.location_name}`}
            </Text>
            <Pressable
              onPress={() => openLocationPicker(item)}
              style={S.linkBox}
              accessibilityRole="button"
              accessibilityLabel="Change the location"
            >
              <Text style={S.linkText}>Change</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => openLocationPicker(item)}
            style={({ pressed }) => [S.locationRow, pressed && S.pressed]}
            accessibilityRole="button"
          >
            <Text style={S.linkText}>📍 Set a location</Text>
          </Pressable>
        )}

        {/* Actions */}
        {tab === 'incoming' && isPending && (
          <View style={S.actions}>
            <Button
              size="sm"
              title="✓ Accept"
              onPress={() => acceptWithSelectedSlot(item)}
              disabled={selectedSlotIdx[item.id] == null}
            />
            <Button size="sm" variant="outline" title="Decline" onPress={() => respondToRequest(item, 'decline')} />
            {chatButton}
          </View>
        )}
        {tab === 'outgoing' && isPending && (
          <View style={S.actions}>
            {chatButton}
            <Pressable
              onPress={() => cancelRequest(item)}
              style={({ pressed }) => [S.linkBox, pressed && S.pressed]}
              accessibilityRole="button"
            >
              <Text style={[S.linkText, S.dangerText]}>Cancel request</Text>
            </Pressable>
          </View>
        )}
      </Panel>
    );
  }

  const openTitle = tab === 'incoming' ? 'Waiting on you' : 'Waiting on them';

  return (
    <View style={S.container}>
      <StatusBanner status={status.value} style={{ marginHorizontal: SPACE.lg, marginTop: SPACE.sm }} />
      <SegmentedToggle<Tab>
        variant="underline"
        options={[
          { value: 'incoming', label: 'Incoming', icon: '📥' },
          { value: 'outgoing', label: 'Outgoing', icon: '📤' },
        ]}
        value={tab}
        onChange={setTab}
        style={S.tabs}
      />

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={S.listContent}
        refreshControl={<AppRefreshControl {...refresh} />}
      >
        <DrillUpcomingSessions
          userId={userId}
          focusId={focusId}
          refreshKey={sessionsKey}
          onFocusedLayout={scrollFocusedIntoView}
        />

        {reviewable.length > 0 ? (
          // TODO: smoke-test in browser — review-your-drills section + bonus modal
          <View style={S.section}>
            <SectionHeader title="Review your drills" count={reviewable.length} />
            <Text style={S.sectionHint} numberOfLines={2}>
              Rate 5 aspects (5 🥒 each) and add a self-review (up to 50 🥒) to claim your bonus.
            </Text>
            <Panel padded={false}>
              {reviewable.map((s, i) => (
                <ListCard
                  key={s.id}
                  variant="row"
                  lastRow={i === reviewable.length - 1}
                  title={`Drill with ${s.partner_name}`}
                  subtitle={`${dateLabel(s.session_date)} ${dateSubLabel(s.session_date)} · ${slotLabel(s.session_slot)} · ${durationLabel(s.length_minutes ?? 60)}`}
                  trailing={<Button size="sm" title="📝 Review" onPress={() => setReviewTarget(s)} />}
                  style={S.actionRow}
                />
              ))}
            </Panel>
          </View>
        ) : null}

        {requests.length === 0 ? (
          <EmptyState
            icon="📭"
            title={`No ${tab} requests yet.`}
            subtitle={tab === 'incoming'
              ? 'When someone wants to drill with you, you\'ll see it here.'
              : 'Find a partner from the Drill page to send your first request.'}
          />
        ) : null}

        {groupOrder.map((k) => {
          if (k === 'open') {
            return groups.open.length > 0 ? (
              <View key={k} style={S.section}>
                <SectionHeader title={openTitle} count={groups.open.length} />
                {groups.open.map(renderRequest)}
              </View>
            ) : null;
          }
          if (k === 'accepted') {
            return groups.accepted.length > 0 ? (
              <View key={k} style={S.section}>
                <SectionHeader title="Accepted" count={groups.accepted.length} />
                {groups.accepted.map(renderRequest)}
              </View>
            ) : null;
          }
          return groups.closed.length > 0 ? (
            <CollapsibleSection
              key={k}
              compact
              title="Closed"
              count={groups.closed.length}
              summary="Declined and cancelled requests"
              open={closedOpen}
              onToggle={(next) => {
                setClosedOpen(next);
                trackSectionToggle({ screen: 'DrillRequests', section: 'closed', open: next });
              }}
            >
              {groups.closed.map(renderRequest)}
            </CollapsibleSection>
          ) : null;
        })}
      </ScrollView>

      <DrillChatModal
        visible={!!chatRequest}
        request={chatRequest}
        currentUserId={userId}
        showLocationPrompt={chatLocationPrompt}
        onDismissLocationPrompt={() => setChatLocationPrompt(false)}
        // The chat can lock in a court (the server marks the setter confirmed): reload on close.
        onClose={() => { setChatRequest(null); setChatLocationPrompt(false); void load(); }}
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
      try {
        const data = await sbCall(() => supabase
          .from('drill_request_messages')
          .select('*')
          .eq('request_id', request.id)
          .order('created_at'));
        if (cancelled) return;
        setMessages((data ?? []) as DrillRequestMessage[]);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
      } catch (e) {
        // An empty thread is indistinguishable from a failed fetch, and this
        // is where the pair agrees where to play.
        if (!cancelled) setSendError(friendlySbMessage(e, "Couldn't load messages."));
      } finally {
        if (!cancelled) setLoadingMsgs(false);
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
    try {
      // No auto-retry: a retried insert that actually landed posts the message
      // twice. Bounded so the composer can't hang on a dead socket.
      const data = await sbCall(
        () => supabase
          .from('drill_request_messages')
          .insert({ request_id: request.id, sender_id: currentUserId, body })
          .select()
          .single(),
        { retries: 0 },
      );
      setMessages(prev => [...prev, data as DrillRequestMessage]);
      setDraft('');
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      setSendError(`Send failed: ${friendlySbMessage(e)}`);
    } finally {
      setSending(false);
    }
  }

  async function openLocationPicker(mode: 'confirm' | 'propose') {
    setLocationPickerMode(mode);
    if (courts.length === 0) {
      setCourtsLoading(true);
      try {
        const data = await sbCall(() => supabase
          .from('court_locations')
          .select('id, name, nickname, address')
          .order('name'));
        setCourts((data ?? []) as CourtRow[]);
      } catch (e) {
        setSendError(friendlySbMessage(e, "Couldn't load the court list."));
      } finally {
        setCourtsLoading(false);
      }
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
  const isMine    = currentUserId === request.from_user_id;
  const otherName =
    (isMine ? request.to_profile : request.from_profile)?.full_name
    ?? 'Drill partner';
  const otherId   = isMine ? request.to_user_id : request.from_user_id;

  const sheet = (
    <View style={S.sheet}>
      <View style={S.header}>
        <Text style={S.title} numberOfLines={1}>💬 {otherName}</Text>
        {/* Report or block from inside the thread — where an abusive message is
            actually read. The last few messages ride along on the report so the
            queue still has them if the sender deletes theirs. */}
        <PlayerModerationMenu
          userId={otherId}
          userName={otherName}
          meId={currentUserId}
          subjectType="message"
          subjectId={request.id}
          snapshot={{
            request_message: request.message ?? null,
            recent: messages.slice(-5).map(m => ({ sender_id: m.sender_id, body: m.body, at: m.created_at })),
          }}
          compact
        />
        <TouchableOpacity onPress={onClose} style={S.closeBox} accessibilityRole="button" accessibilityLabel="Close chat">
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
        contentContainerStyle={{ padding: SPACE.md }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      >
        {loadingMsgs ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : messages.length === 0 ? (
          <EmptyState icon="💬" title="No messages yet. Say hi — you can ask about pace, courts, etc. before deciding to accept." />
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
          style={[S.input, webInputFontFloor(S.input)]}
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
            ? <ActivityIndicator color={colors.textInverse} size="small" />
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
              <TouchableOpacity onPress={() => setLocationPickerMode(null)} style={S.closeBox} accessibilityRole="button" accessibilityLabel="Close location picker">
                <Text style={S.close}>✕</Text>
              </TouchableOpacity>
            </View>
            {courtsLoading ? (
              <ActivityIndicator style={{ marginVertical: SPACE.xl }} color={colors.primary} />
            ) : courts.length === 0 ? (
              <EmptyState title="No courts found in the database yet." />
            ) : (
              <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ padding: SPACE.sm }}>
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
            <TouchableOpacity onPress={onClose} style={S.closeBox} accessibilityRole="button" accessibilityLabel="Close location picker">
              <Text style={S.close}>✕</Text>
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator style={{ marginVertical: SPACE.xl }} color={colors.primary} />
          ) : courts.length === 0 ? (
            <EmptyState title="No courts found in the database yet." />
          ) : (
            <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ padding: SPACE.sm }}>
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
  const t = textStyles(c);
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.lg },
    panel:   { backgroundColor: c.bg, borderRadius: RADIUS.lg, width: '100%', maxWidth: 480, borderWidth: 1, borderColor: c.border },
    header:  { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACE.xs, paddingLeft: SPACE.md, paddingRight: SPACE.xs, borderBottomWidth: 1, borderBottomColor: c.border },
    title:   { ...t.title, flex: 1 },
    close:   { fontSize: FONT.size.h2, color: c.textSub, fontWeight: '700' },
    closeBox:{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    row:     { minHeight: 44, justifyContent: 'center', paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, marginBottom: SPACE.xs },
    rowName: { ...t.title },
    rowSub:  { ...t.meta, fontWeight: '400', marginTop: SPACE.xxs },
  });
}

function makeChatStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    backdrop:    { flex: 1, backgroundColor: c.backdrop, justifyContent: 'flex-end' },
    sheet:       { backgroundColor: c.bg, borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg, maxHeight: '85%', minHeight: 420 },
    header:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingVertical: SPACE.xs, paddingLeft: SPACE.md, paddingRight: SPACE.xs, borderBottomWidth: 1, borderBottomColor: c.border },
    title:       { ...t.title, flex: 1 },
    close:       { fontSize: FONT.size.h2, color: c.textSub, fontWeight: '700' },
    closeBox:    { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    messageList: { flex: 1 },
    bubbleRow:   { flexDirection: 'row', marginBottom: SPACE.xs },
    bubbleRowMine: { justifyContent: 'flex-end' },
    bubble:      { maxWidth: '80%', paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.lg },
    bubbleMine:  { backgroundColor: c.primary, borderBottomRightRadius: RADIUS.sm },
    bubbleTheirs:{ backgroundColor: c.surfaceAlt, borderBottomLeftRadius: RADIUS.sm },
    bubbleText:  { ...t.sub, color: c.text },
    bubbleTextMine: { color: c.textInverse },
    bubbleTime:  { ...t.meta, marginTop: SPACE.xxs },
    bubbleTimeMine: { color: c.textInverse, opacity: 0.7 },
    composer:    { flexDirection: 'row', padding: SPACE.sm, gap: SPACE.sm, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface, alignItems: 'flex-end' },
    input:       { flex: 1, minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, maxHeight: 100, fontSize: FONT.size.md, color: c.text, backgroundColor: c.bg },
    sendBtn:     { backgroundColor: c.primary, paddingHorizontal: SPACE.lg, minHeight: 44, borderRadius: RADIUS.md, minWidth: 64, alignItems: 'center', justifyContent: 'center' },
    sendBtnDim:  { opacity: 0.5 },
    sendBtnText: { color: c.textInverse, fontWeight: '800', fontSize: FONT.size.base },
    sendErrorRow:{ paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, backgroundColor: c.surface },
    sendErrorText:{ ...t.meta, color: c.danger },

    locationPrompt:        { padding: SPACE.md, backgroundColor: c.surfaceAlt, borderBottomWidth: 1, borderBottomColor: c.border },
    locationPromptText:    { ...t.sub, fontWeight: '700', color: c.text, marginBottom: SPACE.sm },
    locationPromptRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    locationPromptBtn:     { flex: 1, minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, alignItems: 'center', borderWidth: 1 },
    locationPromptBtnYes:  { backgroundColor: c.primary, borderColor: c.primary },
    locationPromptBtnNo:   { backgroundColor: c.bg, borderColor: c.border },
    locationPromptBtnTextYes: { color: c.textInverse, fontWeight: '700', fontSize: FONT.size.sm },
    locationPromptBtnTextNo:  { color: c.text, fontWeight: '700', fontSize: FONT.size.sm },
    locationPromptDismiss:    { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    locationPromptDismissText:{ color: c.textMuted, fontSize: FONT.size.lg, fontWeight: '700' },

    locationPickerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.lg },
    locationPickerPanel:   { backgroundColor: c.bg, borderRadius: RADIUS.lg, width: '100%', maxWidth: 480, borderWidth: 1, borderColor: c.border },
    locationPickerHeader:  { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACE.xs, paddingLeft: SPACE.md, paddingRight: SPACE.xs, borderBottomWidth: 1, borderBottomColor: c.border },
    locationPickerTitle:   { ...t.title, flex: 1 },
    courtRow:              { minHeight: 44, justifyContent: 'center', paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, marginBottom: SPACE.xs },
    courtRowName:          { ...t.title },
    courtRowSub:           { ...t.meta, fontWeight: '400', marginTop: SPACE.xxs },
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
  const t = textStyles(c);
  return StyleSheet.create({
    container:   { flex: 1, backgroundColor: c.bg },
    tabs:        { backgroundColor: c.surface, borderBottomColor: c.border },
    listContent: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.xl },
    section:     { marginBottom: SPACE.md },
    sectionHint: { ...t.sub, marginBottom: SPACE.sm },
    pressed:     { opacity: 0.6 },

    // A row whose trailing slot is a 44 sm-button box: 4px vertical padding
    // keeps it at the row's 56 instead of 64 (EntityRow does the same).
    actionRow:   { paddingVertical: SPACE.xs },

    // One request: a Panel (hairline, no shadow), 8 apart.
    card:        { marginBottom: SPACE.sm, gap: SPACE.sm },
    cardFocused: { borderColor: c.primary, backgroundColor: c.primaryLight },
    closedRow:   { paddingVertical: SPACE.xs, paddingHorizontal: 0 },
    cardTop:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
    cardTopText: { flex: 1, minWidth: 0 },
    avatar:      { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: FONT.size.h2 },

    messageBox:  { backgroundColor: c.surfaceAlt, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
    messageText: { ...t.sub, fontStyle: 'italic' },

    slotsLabel:  t.fieldLabel,
    // Interactive slots are FilterPills (28 pill in a 44 box), so the rows
    // touch vertically and read as 16 apart; read-only slots are Badges.
    slotsWrap:   { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm, rowGap: SPACE.xs },

    locationRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
    locationText:{ ...t.sub, flex: 1, color: c.text, fontWeight: '600' },
    linkBox:     { minHeight: 44, minWidth: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    linkText:    { fontSize: FONT.size.base, fontWeight: '700', color: c.primary },
    dangerText:  { color: c.danger },

    actions:     { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
  });
}
