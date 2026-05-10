import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Alert, Modal, TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { ShopCategory, ShopItem, ShopPurchase, RootStackParamList } from '../types';
import UserPickerModal, { PickedUser } from '../components/UserPickerModal';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Shop'> };

const TABS: { value: ShopCategory; label: string; emoji: string; blurb: string }[] = [
  { value: 'avatar',         label: 'Avatars',  emoji: '🎭', blurb: 'Premium avatars to swap in on your profile.' },
  { value: 'cosmetic_badge', label: 'Badges',   emoji: '🏵️', blurb: 'Decorative badges that show on your profile.' },
  { value: 'flair',          label: 'Flair',    emoji: '✨', blurb: 'Profile customization — start with name colors.' },
];

export default function ShopScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const [pickles, setPickles] = useState<number>(0);
  const [items, setItems]     = useState<ShopItem[]>([]);
  const [owned, setOwned]     = useState<Set<string>>(new Set());
  const [tab, setTab]         = useState<ShopCategory>('avatar');
  const [loading, setLoading] = useState(true);
  const [buying, setBuying]   = useState<string | null>(null);

  // Buy flow
  const [confirmingItem, setConfirmingItem]     = useState<ShopItem | null>(null);

  // Gift flow
  const [giftItem, setGiftItem]                 = useState<ShopItem | null>(null);
  const [giftRecipient, setGiftRecipient]       = useState<PickedUser | null>(null);
  const [giftMessage, setGiftMessage]           = useState('');
  const [showUserPicker, setShowUserPicker]     = useState(false);
  const [sendingGift, setSendingGift]           = useState(false);
  const [myUserId, setMyUserId]                 = useState<string | null>(null);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    setMyUserId(user.id);

    const [profileRes, itemsRes, ownedRes] = await Promise.all([
      supabase.from('profiles').select('pickles').eq('id', user.id).single(),
      supabase.from('shop_items').select('*').eq('is_active', true).order('sort_order'),
      supabase.from('player_shop_purchases').select('shop_item_id').eq('user_id', user.id),
    ]);

    setPickles(profileRes.data?.pickles ?? 0);
    setItems((itemsRes.data ?? []) as ShopItem[]);
    setOwned(new Set(((ownedRes.data ?? []) as ShopPurchase[]).map(p => p.shop_item_id)));
    setLoading(false);
  }

  function startGift(item: ShopItem) {
    if (pickles < item.cost) {
      Alert.alert('Not enough pickles', `You have ${pickles} 🥒 — gifting ${item.name} costs ${item.cost} 🥒.`);
      return;
    }
    setGiftItem(item);
    setGiftRecipient(null);
    setGiftMessage('');
    setShowUserPicker(true);
  }

  async function confirmGift() {
    if (!giftItem || !giftRecipient) return;
    setSendingGift(true);
    const { data, error } = await supabase.rpc('gift_shop_item', {
      p_item_id:   giftItem.id,
      p_recipient: giftRecipient.id,
      p_message:   giftMessage.trim() || null,
    });
    setSendingGift(false);
    if (error) { Alert.alert('Error', error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { Alert.alert('Could not gift', row?.message ?? 'Unknown error'); return; }
    setPickles(row.new_balance);
    Alert.alert('Gift sent!', `${giftItem.name} is now in ${giftRecipient.full_name}'s inventory.`);
    setGiftItem(null);
    setGiftRecipient(null);
    setGiftMessage('');
  }

  function startBuy(item: ShopItem) {
    if (owned.has(item.id)) return;
    if (pickles < item.cost) {
      Alert.alert('Not enough pickles', `You have ${pickles} 🥒 — ${item.name} costs ${item.cost} 🥒.`);
      return;
    }
    setConfirmingItem(item);
  }

  async function confirmBuy() {
    const item = confirmingItem;
    if (!item) return;
    setBuying(item.id);
    const { data, error } = await supabase.rpc('purchase_shop_item', { p_item_id: item.id });
    setBuying(null);
    if (error) { Alert.alert('Error', error.message); return; }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) {
      Alert.alert('Could not purchase', row?.message ?? 'Unknown error');
      return;
    }
    setPickles(row.new_balance);
    setOwned(prev => new Set(prev).add(item.id));
    setConfirmingItem(null);
    Alert.alert('Purchased!', `${item.name} is in your inventory. Equip / hide it from your Profile.`);
  }

  if (loading) return <ActivityIndicator style={{ flex: 1, backgroundColor: c.bg }} size="large" color={c.primary} />;

  const tabItems = items.filter(i => i.category === tab);
  const tabMeta  = TABS.find(t => t.value === tab)!;

  return (
    <View style={S.root}>
      {/* Balance header */}
      <View style={S.header}>
        <Text style={S.headerTitle}>Pickle Shop</Text>
        <View style={S.balancePill}>
          <Text style={S.balanceEmoji}>🥒</Text>
          <Text style={S.balanceValue}>{pickles}</Text>
        </View>
      </View>

      {/* Tab strip */}
      <View style={S.tabBar}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.value}
            style={[S.tab, tab === t.value && S.tabActive]}
            onPress={() => setTab(t.value)}
          >
            <Text style={[S.tabText, tab === t.value && S.tabTextActive]}>
              {t.emoji} {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={S.scroll}>
        <Text style={S.tabBlurb}>{tabMeta.blurb}</Text>

        {tabItems.length === 0 ? (
          <Text style={S.empty}>No items in this category yet.</Text>
        ) : (
          <View style={S.grid}>
            {tabItems.map(item => {
              const isOwned     = owned.has(item.id);
              const canAfford   = pickles >= item.cost;
              const isBuying    = buying === item.id;

              return (
                <View key={item.id} style={S.card}>
                  <View style={[S.iconBox, { backgroundColor: item.payload?.bgColor ?? c.surfaceAlt }]}>
                    <Text style={S.iconEmoji}>{item.icon}</Text>
                  </View>
                  <Text style={S.cardName} numberOfLines={1}>{item.name}</Text>
                  <Text style={S.cardDesc} numberOfLines={3}>{item.description}</Text>
                  <View style={S.costRow}>
                    <View style={S.costPill}>
                      <Text style={S.costText}>🥒 {item.cost}</Text>
                    </View>
                  </View>
                  <View style={S.actionRow}>
                    <TouchableOpacity
                      style={[
                        S.buyBtn,
                        isOwned   && S.buyBtnOwned,
                        !canAfford && !isOwned && S.buyBtnDisabled,
                      ]}
                      onPress={() => startBuy(item)}
                      disabled={isOwned || isBuying || !canAfford}
                    >
                      <Text style={[
                        S.buyBtnText,
                        (isOwned || !canAfford) && S.buyBtnTextDim,
                      ]}>
                        {isOwned ? '✓ Owned' : isBuying ? '…' : canAfford ? 'Buy' : 'Need 🥒'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[S.giftBtn, !canAfford && S.giftBtnDisabled]}
                      onPress={() => startGift(item)}
                      disabled={!canAfford || isBuying}
                    >
                      <Text style={[S.giftBtnText, !canAfford && S.giftBtnTextDim]}>🎁 Gift</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Confirm Buy */}
      <Modal
        visible={!!confirmingItem}
        transparent animationType="fade"
        onRequestClose={() => setConfirmingItem(null)}
      >
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Confirm Purchase</Text>
            {confirmingItem && (
              <>
                <View style={S.giftPreviewRow}>
                  <View style={[S.giftIconBox, { backgroundColor: confirmingItem.payload?.bgColor ?? c.surfaceAlt }]}>
                    <Text style={S.giftIconEmoji}>{confirmingItem.icon}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={S.giftRecipientName}>{confirmingItem.name}</Text>
                    <Text style={S.giftItemName} numberOfLines={3}>{confirmingItem.description}</Text>
                  </View>
                </View>

                <View style={S.confirmCostBox}>
                  <View style={S.confirmCostRow}>
                    <Text style={S.confirmCostLabel}>Cost</Text>
                    <Text style={S.confirmCostValue}>🥒 {confirmingItem.cost}</Text>
                  </View>
                  <View style={S.confirmCostRow}>
                    <Text style={S.confirmCostLabel}>Balance after</Text>
                    <Text style={S.confirmCostValue}>🥒 {pickles - confirmingItem.cost}</Text>
                  </View>
                </View>

                <View style={S.modalBtnRow}>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnSecondary]}
                    onPress={() => setConfirmingItem(null)}
                    disabled={!!buying}
                  >
                    <Text style={S.modalBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnPrimary]}
                    onPress={confirmBuy}
                    disabled={!!buying}
                  >
                    {buying === confirmingItem.id
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={S.modalBtnPrimaryText}>Confirm Buy</Text>}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Pick a recipient */}
      <UserPickerModal
        visible={showUserPicker}
        title={giftItem ? `Gift ${giftItem.name}` : 'Pick recipient'}
        excludeUserIds={myUserId ? [myUserId] : []}
        onPick={(u) => { setGiftRecipient(u); setShowUserPicker(false); }}
        onClose={() => { setShowUserPicker(false); if (!giftRecipient) setGiftItem(null); }}
      />

      {/* Confirm gift */}
      <Modal
        visible={!!giftItem && !!giftRecipient && !showUserPicker}
        transparent animationType="fade"
        onRequestClose={() => { setGiftItem(null); setGiftRecipient(null); }}
      >
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Send as Gift</Text>
            {giftItem && giftRecipient && (
              <>
                <View style={S.giftPreviewRow}>
                  <View style={[S.giftIconBox, { backgroundColor: giftItem.payload?.bgColor ?? c.surfaceAlt }]}>
                    <Text style={S.giftIconEmoji}>{giftItem.icon}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={S.giftLabel}>To</Text>
                    <Text style={S.giftRecipientName}>{giftRecipient.full_name}</Text>
                    <Text style={S.giftItemName}>{giftItem.name} · 🥒 {giftItem.cost}</Text>
                  </View>
                </View>

                <Text style={S.giftFieldLabel}>Optional message</Text>
                <TextInput
                  style={S.giftMessage}
                  placeholder="Add a note (optional)…"
                  placeholderTextColor={c.textMuted}
                  value={giftMessage}
                  onChangeText={setGiftMessage}
                  maxLength={200}
                  multiline
                />

                <Text style={S.giftBalance}>Your balance after: 🥒 {pickles - giftItem.cost}</Text>

                <View style={S.modalBtnRow}>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnSecondary]}
                    onPress={() => { setGiftItem(null); setGiftRecipient(null); setGiftMessage(''); }}
                    disabled={sendingGift}
                  >
                    <Text style={S.modalBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnPrimary]}
                    onPress={confirmGift}
                    disabled={sendingGift}
                  >
                    {sendingGift
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={S.modalBtnPrimaryText}>Send Gift</Text>}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 14,
      backgroundColor: c.surface,
      borderBottomWidth: 1, borderBottomColor: c.border,
    },
    headerTitle:  { fontSize: 20, fontWeight: '800', color: c.text },
    balancePill:  {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 14, paddingVertical: 7,
      borderRadius: 20, backgroundColor: c.primaryLight,
      borderWidth: 1.5, borderColor: c.primary,
    },
    balanceEmoji: { fontSize: 16 },
    balanceValue: { fontSize: 16, fontWeight: '800', color: c.primary },

    tabBar:        { flexDirection: 'row', backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border },
    tab:           { flex: 1, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 18, borderWidth: 1.5, borderColor: c.border, alignItems: 'center', backgroundColor: c.surface },
    tabActive:     { borderColor: c.primary, backgroundColor: c.primaryLight },
    tabText:       { fontSize: 13, fontWeight: '600', color: c.textSub },
    tabTextActive: { color: c.primary, fontWeight: '700' },

    scroll: { padding: 16, paddingBottom: 40 },
    tabBlurb: { fontSize: 13, color: c.textMuted, marginBottom: 14, lineHeight: 18 },
    empty:    { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 14 },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' },
    card: {
      width: '48%',
      backgroundColor: c.surface, borderRadius: 14, padding: 12,
      shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2,
      borderWidth: 1, borderColor: c.border,
    },
    iconBox:   { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 8 },
    iconEmoji: { fontSize: 32 },
    cardName:  { fontSize: 14, fontWeight: '800', color: c.text, textAlign: 'center', marginBottom: 4 },
    cardDesc:  { fontSize: 11, color: c.textMuted, textAlign: 'center', minHeight: 44, lineHeight: 15 },

    costRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', marginTop: 10 },
    costPill:   { backgroundColor: c.surfaceAlt, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignSelf: 'flex-start' },
    costText:   { fontSize: 12, fontWeight: '700', color: c.text },
    actionRow:  { flexDirection: 'row', gap: 6, marginTop: 8 },
    buyBtn:     { flex: 1, backgroundColor: c.primary, paddingVertical: 7, borderRadius: 10, alignItems: 'center' },
    buyBtnOwned:{ backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    buyBtnDisabled: { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    buyBtnText: { fontSize: 12, fontWeight: '700', color: '#fff' },
    buyBtnTextDim: { color: c.textMuted },
    giftBtn:        { flex: 1, backgroundColor: c.surfaceAlt, paddingVertical: 7, borderRadius: 10, alignItems: 'center', borderWidth: 1.5, borderColor: c.primary },
    giftBtnDisabled:{ borderColor: c.border, backgroundColor: c.surfaceAlt },
    giftBtnText:    { fontSize: 12, fontWeight: '700', color: c.primary },
    giftBtnTextDim: { color: c.textMuted },

    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
    modalCard:     { backgroundColor: c.surface, borderRadius: 16, padding: 20, width: '100%', maxWidth: 460 },
    modalTitle:    { fontSize: 18, fontWeight: '900', color: c.text, marginBottom: 12 },
    giftPreviewRow:    { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
    giftIconBox:       { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
    giftIconEmoji:     { fontSize: 28 },
    giftLabel:         { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.7 },
    giftRecipientName: { fontSize: 16, fontWeight: '800', color: c.text, marginTop: 1 },
    giftItemName:      { fontSize: 12, color: c.textSub, marginTop: 2 },
    giftFieldLabel:    { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 4, marginBottom: 6 },
    giftMessage:       { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 14, color: c.text, minHeight: 60, textAlignVertical: 'top' },
    giftBalance:       { fontSize: 12, color: c.textSub, marginTop: 10, marginBottom: 14 },
    modalBtnRow:       { flexDirection: 'row', gap: 10 },
    modalBtn:          { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
    modalBtnPrimary:   { backgroundColor: c.primary },
    modalBtnPrimaryText:{ color: '#fff', fontWeight: '800', fontSize: 14 },
    modalBtnSecondary: { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    modalBtnSecondaryText: { color: c.textSub, fontWeight: '700', fontSize: 14 },

    confirmCostBox:    { backgroundColor: c.primaryLight, borderRadius: 10, padding: 12, marginBottom: 16 },
    confirmCostRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
    confirmCostLabel:  { fontSize: 13, color: c.textSub, fontWeight: '600' },
    confirmCostValue:  { fontSize: 14, color: c.primary, fontWeight: '800' },
  });
}
