import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { DrillRequest, RootStackParamList } from '../types';
import { dateLabel, dateSubLabel, slotLabel, slotFullLabel } from '../lib/drillTime';
import { AVATARS } from '../data/profileCustomization';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DrillRequests'> };

type Tab = 'incoming' | 'outgoing';

export default function DrillRequestsScreen({}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);

  const [tab, setTab] = useState<Tab>('incoming');
  const [userId, setUserId] = useState<string | null>(null);
  const [requests, setRequests] = useState<DrillRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => { load(); }, [tab]));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const fkField = tab === 'incoming'
      ? 'from_profile:profiles!drill_requests_from_user_id_fkey(id, full_name, avatar_id, avatar_url, rating)'
      : 'to_profile:profiles!drill_requests_to_user_id_fkey(id, full_name, avatar_id, avatar_url, rating)';

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
      Alert.alert('Failed', error.message);
      return;
    }
    load();
  }

  function pickSlotAndAccept(req: DrillRequest) {
    if (req.proposed_slots.length === 1) {
      respondToRequest(req, 'accept', req.proposed_slots[0]);
      return;
    }
    Alert.alert(
      'Pick a time',
      'Which slot works for you?',
      [
        ...req.proposed_slots.map(s => ({
          text: slotFullLabel(s),
          onPress: () => respondToRequest(req, 'accept', s),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  }

  async function cancelRequest(req: DrillRequest) {
    Alert.alert(
      'Cancel request?',
      `Cancel your drill request to ${req.to_profile?.full_name ?? 'this player'}?`,
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes, cancel',
          style: 'destructive',
          onPress: async () => {
            await supabase
              .from('drill_requests')
              .update({ status: 'cancelled' })
              .eq('id', req.id);
            load();
          },
        },
      ]
    );
  }

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: colors.bg }} size="large" color={colors.primary} />;

  return (
    <View style={S.container}>
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
                    {otherProfile?.rating ?? 1000} ELO · {timeAgo(item.created_at)}
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
                {isAccepted && item.accepted_slot ? 'Confirmed time' : 'Proposed times'}
              </Text>
              <View style={S.slotsWrap}>
                {(isAccepted && item.accepted_slot
                  ? [item.accepted_slot]
                  : item.proposed_slots
                ).map((s, i) => (
                  <View key={i} style={[S.slotChip, isAccepted && S.slotChipAccepted]}>
                    <Text style={[S.slotChipText, isAccepted && S.slotChipTextAccepted]}>
                      {dateLabel(s.date)} {dateSubLabel(s.date)} · {slotLabel(s.slot)}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Actions */}
              {tab === 'incoming' && isPending && (
                <View style={S.actions}>
                  <TouchableOpacity
                    style={[S.actionBtn, S.acceptBtn]}
                    onPress={() => pickSlotAndAccept(item)}
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
              )}
              {tab === 'outgoing' && isPending && (
                <TouchableOpacity style={S.cancelBtn} onPress={() => cancelRequest(item)}>
                  <Text style={S.cancelText}>Cancel request</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
      />
    </View>
  );
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
    acceptBtn:   { backgroundColor: c.primary },
    acceptText:  { color: '#fff', fontWeight: '800', fontSize: 14 },
    declineBtn:  { backgroundColor: c.surfaceAlt, borderWidth: 1.5, borderColor: c.border },
    declineText: { color: c.textSub, fontWeight: '700', fontSize: 14 },
    cancelBtn:   { padding: 10, alignItems: 'center' },
    cancelText:  { color: c.danger, fontSize: 13, fontWeight: '600' },
  });
}
