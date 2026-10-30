import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
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
import { Button, KeyboardTextInput } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import AppRefreshControl from '../components/AppRefreshControl';
import { PickleAmount, picklesLabel } from '../components/PickleAmount';

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
    // LOCAL session read: getUser() is a network call, and offline it made the
    // godmode account fail its own access check and see "Godmode only".
    const uid = await currentUserId(supabase);
    setMyUserId(uid);
    setAuthorized(isGodmodeUserId(uid));
    if (!uid) return;
    try {
      const data = await sbCall(() =>
        supabase.from('profiles').select('pickles').eq('id', uid).single(),
      );
      setMyBalance(data?.pickles ?? 0);
    } catch (e) {
      // A balance of 0 would disable the send button with no explanation.
      status.error(friendlySbMessage(e, "Couldn't load your pickle balance."));
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
    try {
      // No auto-retry: this transfers currency and the RPC isn't idempotent, so
      // a retried request that actually landed would gift twice. Bounded
      // instead, so a dead socket surfaces rather than freezing the button.
      const data = await sbCall(
        () =>
          supabase.rpc('godmode_gift_pickles', {
            p_recipient: recipient.id,
            p_amount:    n,
            p_reason:    reason.trim() || '',
          }),
        { retries: 0 },
      );
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.success) { status.error(row?.message ?? 'Could not send.'); return; }
      setMyBalance(row.new_caller_balance ?? myBalance - n);
      const theirs = row.new_recipient_balance;
      status.success(
        `${picklesLabel(n)} sent to ${recipient.full_name}. Their new balance: ${typeof theirs === 'number' ? picklesLabel(theirs) : '—'}.`,
        { iconName: 'pickle' },
      );
      setRecipient(null);
      setAmount('');
      setReason('');
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not send.'));
    } finally {
      // Always: every early return above used to leave the button spinning.
      setSending(false);
    }
  }

  if (authorized === null) {
    return <LoadingState label="Checking access…" />;
  }
  if (!authorized) {
    return (
      <View style={S.deniedRoot}>
        <Text style={S.deniedTitle}>Godmode only</Text>
        <Text style={S.deniedBody}>This tool is reserved for the original developer account.</Text>
        <Button title="Go back" onPress={() => navigation.goBack()} style={S.deniedBtn} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={S.container} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshControl={<AppRefreshControl {...refresh} />}>
      <View style={S.balanceCard}>
        <Text style={S.balanceLabel}>Your balance</Text>
        <PickleAmount amount={myBalance} preset="display" style={S.balanceValue} />
      </View>

      <Text style={S.fieldLabel}>Recipient</Text>
      <TouchableOpacity
        style={S.pickBtn}
        onPress={() => setShowPicker(true)}
        accessibilityRole="button"
        accessibilityLabel={recipient ? `Recipient: ${recipient.full_name}. Change` : 'Pick a recipient'}
      >
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
            <View style={S.flex1}>
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
      <KeyboardTextInput
        style={[S.input, webInputFontFloor(S.input)]}
        keyboardType="number-pad"
        placeholder="500"
        placeholderTextColor={c.textMuted}
        value={amount}
        onChangeText={setAmount}
      />
      {Number.isFinite(n) && n > myBalance && (
        <Text style={S.errorText}>You only have {picklesLabel(myBalance)}.</Text>
      )}

      <Text style={S.fieldLabel}>Reason (optional)</Text>
      <TextInput
        style={[S.input, webInputFontFloor(S.input)]}
        placeholder="e.g. great match yesterday"
        placeholderTextColor={c.textMuted}
        value={reason}
        onChangeText={setReason}
      />

      <StatusBanner status={status.value} />

      <Button
        title={Number.isFinite(n) && n > 0 ? `Send ${n.toLocaleString()}` : 'Send'}
        iconName="pickle"
        iconPosition="trailing"
        onPress={send}
        disabled={!valid}
        loading={sending}
        accessibilityLabel={Number.isFinite(n) && n > 0 ? `Send ${picklesLabel(n)}` : 'Send pickles'}
        style={S.sendBtn}
      />

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
  const t = textStyles(c);
  return StyleSheet.create({
    container: { padding: SPACE.lg, backgroundColor: c.bg, paddingBottom: SPACE.xl * 2 },
    flex1:     { flex: 1, minWidth: 0 },

    balanceCard:  { backgroundColor: c.primaryLight, borderRadius: RADIUS.lg, padding: SPACE.lg, alignItems: 'center', marginBottom: SPACE.lg, borderWidth: HAIRLINE, borderColor: c.primary },
    balanceLabel: { ...t.label, color: c.primary },
    balanceValue: { marginTop: SPACE.xs },

    fieldLabel: { ...t.fieldLabel, marginTop: SPACE.md, marginBottom: SPACE.xs },
    input:      { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface },

    pickBtn:    { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md, backgroundColor: c.surface, borderStyle: 'dashed', justifyContent: 'center' },
    pickBtnPlaceholder: { ...t.hint, fontSize: FONT.size.md },
    recipientRow:    { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
    recipientAvatar: { width: 40, height: 40, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    recipientAvatarEmoji: { fontSize: 22 },
    recipientName:   t.title,
    recipientUsername:{ ...t.meta, marginTop: SPACE.xxs },
    changeText:      { fontSize: FONT.size.base, color: c.primary, fontWeight: FONT.weight.bold },

    errorText: { fontSize: FONT.size.sm, color: c.danger, marginTop: SPACE.xs },

    sendBtn:   { marginTop: SPACE.xl },

    deniedRoot:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, backgroundColor: c.bg },
    deniedTitle: { ...t.h2, marginBottom: SPACE.sm },
    deniedBody:  { ...t.hint, fontSize: FONT.size.md, textAlign: 'center', marginBottom: SPACE.lg },
    deniedBtn:   { alignSelf: 'center' },
  });
}
