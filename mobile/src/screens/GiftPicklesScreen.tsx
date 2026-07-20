import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import UserPickerModal, { PickedUser } from '../components/UserPickerModal';
import { isGodmodeUserId } from '../lib/godmode';
import { AVATARS } from '../data/profileCustomization';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { useRefresh } from '../lib/useRefresh';
import { LoadingState } from '@just-messin-around/expo-foundation/ui';
import AppRefreshControl from '../components/AppRefreshControl';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'GiftPickles'> };

export default function GiftPicklesScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myBalance, setMyBalance] = useState(0);
  const [recipient, setRecipient] = useState<PickedUser | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const status = useStatusMessage();

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? null;
    setMyUserId(uid);
    setAuthorized(isGodmodeUserId(uid));
    if (uid) {
      const { data } = await supabase.from('profiles').select('pickles').eq('id', uid).single();
      setMyBalance(data?.pickles ?? 0);
    }
  }, []);
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const n = parseInt(amount, 10);
  const valid = !!recipient && Number.isFinite(n) && n > 0 && n <= myBalance;

  async function send() {
    if (!valid || !recipient) return;
    status.clear();
    setSending(true);
    const { data, error } = await supabase.rpc('godmode_gift_pickles', {
      p_recipient: recipient.id,
      p_amount:    n,
      p_reason:    reason.trim() || '',
    });
    setSending(false);
    if (error) { status.error(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { status.error(row?.message ?? 'Could not send.'); return; }
    setMyBalance(row.new_caller_balance ?? myBalance - n);
    status.success(
      `${n.toLocaleString()} 🥒 sent to ${recipient.full_name}. Their new balance: ${row.new_recipient_balance?.toLocaleString() ?? '—'} 🥒`,
    );
    setRecipient(null);
    setAmount('');
    setReason('');
  }

  if (authorized === null) {
    return <LoadingState label="Checking access…" />;
  }
  if (!authorized) {
    return (
      <View style={S.deniedRoot}>
        <Text style={S.deniedTitle}>Godmode only</Text>
        <Text style={S.deniedBody}>This tool is reserved for the original developer account.</Text>
        <TouchableOpacity style={S.deniedBtn} onPress={() => navigation.goBack()}>
          <Text style={S.deniedBtnText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={S.container} refreshControl={<AppRefreshControl {...refresh} />}>
      <View style={S.balanceCard}>
        <Text style={S.balanceLabel}>Your balance</Text>
        <Text style={S.balanceValue}>🥒 {myBalance.toLocaleString()}</Text>
      </View>

      <Text style={S.fieldLabel}>Recipient</Text>
      <TouchableOpacity style={S.pickBtn} onPress={() => setShowPicker(true)}>
        {recipient ? (
          <View style={S.recipientRow}>
            {(() => {
              const cartoon = AVATARS.find(a => a.id === (recipient.avatar_id ?? 1)) ?? AVATARS[0];
              const emoji = recipient.avatar_emoji ?? cartoon.emoji;
              const bg    = recipient.avatar_bg_color ?? cartoon.bgColor;
              return (
                <View style={[S.recipientAvatar, { backgroundColor: bg }]}>
                  <Text style={S.recipientAvatarEmoji}>{emoji}</Text>
                </View>
              );
            })()}
            <View style={{ flex: 1 }}>
              <Text style={S.recipientName}>{recipient.full_name}</Text>
              <Text style={S.recipientUsername}>@{recipient.username}</Text>
            </View>
            <Text style={S.changeText}>Change</Text>
          </View>
        ) : (
          <Text style={S.pickBtnPlaceholder}>Tap to search and pick a user…</Text>
        )}
      </TouchableOpacity>

      <Text style={S.fieldLabel}>Amount (max {myBalance.toLocaleString()})</Text>
      <TextInput
        style={S.input}
        keyboardType="number-pad"
        placeholder="500"
        placeholderTextColor={c.textMuted}
        value={amount}
        onChangeText={setAmount}
      />
      {Number.isFinite(n) && n > myBalance && (
        <Text style={S.errorText}>You only have {myBalance.toLocaleString()} 🥒.</Text>
      )}

      <Text style={S.fieldLabel}>Reason (optional)</Text>
      <TextInput
        style={S.input}
        placeholder="e.g. great match yesterday"
        placeholderTextColor={c.textMuted}
        value={reason}
        onChangeText={setReason}
      />

      <StatusBanner status={status.value} />

      <TouchableOpacity
        style={[S.sendBtn, !valid && S.sendBtnDisabled]}
        onPress={send}
        disabled={!valid || sending}
      >
        {sending
          ? <ActivityIndicator color="#fff" />
          : <Text style={S.sendBtnText}>Send {Number.isFinite(n) && n > 0 ? `${n.toLocaleString()} 🥒` : '🥒'}</Text>}
      </TouchableOpacity>

      <UserPickerModal
        visible={showPicker}
        title="Send pickles to"
        excludeUserIds={myUserId ? [myUserId] : []}
        onPick={(u) => { setRecipient(u); setShowPicker(false); }}
        onClose={() => setShowPicker(false)}
      />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { padding: 16, backgroundColor: c.bg, paddingBottom: 60 },

    balanceCard:  { backgroundColor: c.primaryLight, borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 16, borderWidth: 1.5, borderColor: c.primary },
    balanceLabel: { fontSize: 12, fontWeight: '700', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.8 },
    balanceValue: { fontSize: 28, fontWeight: '900', color: c.primary, marginTop: 4 },

    fieldLabel: { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 12, marginBottom: 6 },
    input:      { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 15, color: c.text, backgroundColor: c.surface },

    pickBtn:    { borderWidth: 1.5, borderColor: c.border, borderRadius: 10, padding: 14, backgroundColor: c.surface, borderStyle: 'dashed' },
    pickBtnPlaceholder: { fontSize: 14, color: c.textMuted },
    recipientRow:    { flexDirection: 'row', alignItems: 'center', gap: 12 },
    recipientAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    recipientAvatarEmoji: { fontSize: 22 },
    recipientName:   { fontSize: 15, fontWeight: '800', color: c.text },
    recipientUsername:{ fontSize: 12, color: c.textMuted, marginTop: 1 },
    changeText:      { fontSize: 13, color: c.primary, fontWeight: '700' },

    errorText: { fontSize: 12, color: c.danger, marginTop: 6 },

    sendBtn:        { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 24 },
    sendBtnDisabled:{ opacity: 0.45 },
    sendBtnText:    { color: '#fff', fontSize: 16, fontWeight: '900' },

    deniedRoot:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: c.bg },
    deniedTitle: { fontSize: 22, fontWeight: '900', color: c.text, marginBottom: 8 },
    deniedBody:  { fontSize: 14, color: c.textMuted, textAlign: 'center', marginBottom: 20 },
    deniedBtn:   { backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
    deniedBtnText:{ color: '#fff', fontWeight: '700' },
  });
}
