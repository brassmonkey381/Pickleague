import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Modal, TextInput,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { ShopCategory, ShopItem, ShopPurchase, RootStackParamList } from '../types';
import UserPickerModal, { PickedUser } from '../components/UserPickerModal';
import ShippingAddressForm, { ShippingAddress, EMPTY_ADDRESS, isAddressValid } from '../components/ShippingAddressForm';
import StatusBanner from '../components/StatusBanner';
import FlairName from '../components/FlairName';
import EmptyState from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import AppRefreshControl from '../components/AppRefreshControl';
import { useStatusMessage } from '../lib/useStatusMessage';
import { useRefresh } from '../lib/useRefresh';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Shop'> };

// "profile_name_style" tab also surfaces legacy `flair` items (which set
// name_color), so users see all profile name styles in one place even
// though they're stored as two categories under the hood.
const TABS: { value: ShopCategory; label: string; emoji: string; blurb: string }[] = [
  { value: 'avatar',             label: 'Avatars',        emoji: '🎭', blurb: 'Premium avatars to swap in on your profile.' },
  { value: 'cosmetic_badge',     label: 'Badges',         emoji: '🏵️', blurb: 'Decorative badges that show on your profile.' },
  { value: 'profile_name_style', label: 'Profile Styles', emoji: '✨', blurb: 'Name styles for your profile header — colors, glows, and animations.' },
  { value: 'list_name_style',    label: 'List Styles',    emoji: '📝', blurb: 'Name styles that show in member lists, brackets, registrations, and match history.' },
  { value: 'real_world',         label: 'Redemptions',    emoji: '🎁', blurb: 'Trade pickles for real-world gear. 4 items rotate at 20/15/10/5% off every day at midnight UTC. An admin will reach out after you redeem to arrange delivery.' },
];

function formatUsd(cents: number | undefined): string {
  if (!cents && cents !== 0) return '';
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ShopScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const [pickles, setPickles] = useState<number>(0);
  const [items, setItems]     = useState<ShopItem[]>([]);
  const [owned, setOwned]     = useState<Set<string>>(new Set());
  const [discounts, setDiscounts] = useState<Map<string, number>>(new Map());
  const [tab, setTab]         = useState<ShopCategory>('avatar');
  const [loading, setLoading] = useState(true);
  const [buying, setBuying]   = useState<{ id: string; equip: boolean } | null>(null);
  // Used for live name previews on the List/Hero Name tabs.
  const [myFullName, setMyFullName] = useState<string>('You');
  // badge id → badge name, for rendering "Earn X to unlock" labels.
  const [badgeNames, setBadgeNames] = useState<Map<string, string>>(new Map());
  // badge id → set of badge ids the viewer has already earned. Used to mark
  // unlock-gated rows as ✓ Unlocked even on the (rare) chance the trigger
  // didn't run (e.g. seed added after the user earned the badge).
  const [earnedBadgeIds, setEarnedBadgeIds] = useState<Set<string>>(new Set());
  // badge name → { current, target, label } for the small progress indicator
  // rendered under each locked name-style preview. Mirrors the computation
  // in UnlockProgressScreen so the two screens agree.
  const [badgeProgress, setBadgeProgress] = useState<Record<string, { current: number; target: number; label: string }>>({});

  // Buy flow
  const [confirmingItem, setConfirmingItem]     = useState<ShopItem | null>(null);
  const [shipAddr, setShipAddr]                 = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [buyError, setBuyError]                 = useState<string | null>(null);

  // Gift flow
  const [giftItem, setGiftItem]                 = useState<ShopItem | null>(null);
  const [giftRecipient, setGiftRecipient]       = useState<PickedUser | null>(null);
  const [giftMessage, setGiftMessage]           = useState('');
  const [giftAddr, setGiftAddr]                 = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [giftError, setGiftError]               = useState<string | null>(null);
  const [showUserPicker, setShowUserPicker]     = useState(false);
  const [sendingGift, setSendingGift]           = useState(false);
  const [myUserId, setMyUserId]                 = useState<string | null>(null);

  const status = useStatusMessage();
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    setMyUserId(user.id);

    const [profileRes, itemsRes, ownedRes, discountsRes, badgesRes, playerBadgesRes] = await Promise.all([
      supabase.from('profiles').select('pickles, full_name, created_at, rating').eq('id', user.id).single(),
      supabase.from('shop_items').select('*').eq('is_active', true).order('sort_order'),
      supabase.from('player_shop_purchases').select('shop_item_id').eq('user_id', user.id),
      supabase.rpc('current_real_world_discounts'),
      supabase.from('badges').select('id, name'),
      supabase.from('player_badges').select('badge_id').eq('user_id', user.id),
    ]);

    setPickles(profileRes.data?.pickles ?? 0);
    setMyFullName(profileRes.data?.full_name ?? 'You');
    setItems((itemsRes.data ?? []) as ShopItem[]);
    setOwned(new Set(((ownedRes.data ?? []) as ShopPurchase[]).map(p => p.shop_item_id)));
    setDiscounts(new Map(((discountsRes.data ?? []) as { slug: string; discount_pct: number }[])
      .map(d => [d.slug, d.discount_pct])));
    setBadgeNames(new Map(((badgesRes.data ?? []) as { id: string; name: string }[])
      .map(b => [b.id, b.name])));
    setEarnedBadgeIds(new Set(((playerBadgesRes.data ?? []) as { badge_id: string }[])
      .map(p => p.badge_id)));

    // Only compute match-derived progress when we actually have an
    // unlock-gated style on the wire — keeps the Shop snappy when the
    // viewer is browsing non-style tabs.
    const hasUnlockGated = ((itemsRes.data ?? []) as ShopItem[]).some(i => !!i.unlock_badge_id);
    if (hasUnlockGated && profileRes.data) {
      const prof = profileRes.data;
      const { data: matches } = await supabase
        .from('matches')
        .select('match_type, player1_id, partner1_id, player2_id, partner2_id, winner_team, location_name')
        .or(`player1_id.eq.${user.id},partner1_id.eq.${user.id},player2_id.eq.${user.id},partner2_id.eq.${user.id}`)
        .order('played_at', { ascending: false })
        .limit(200);
      const mx = matches ?? [];
      const didWin = (m: any) => {
        const t1 = m.player1_id === user.id || m.partner1_id === user.id;
        return (t1 && m.winner_team === 'team1') || (!t1 && m.winner_team === 'team2');
      };
      let streak = 0;
      for (const m of mx) { if (didWin(m)) streak++; else break; }
      const courts = new Set(mx.map((m: any) => m.location_name).filter(Boolean)).size;
      const doublesPlayed = mx.filter((m: any) => m.match_type === 'doubles').length;
      const singlesPlayed = mx.filter((m: any) => m.match_type === 'singles').length;
      const memberDays = Math.floor((Date.now() - new Date(prof.created_at).getTime()) / 86_400_000);
      const elo = prof.rating ?? 3.25;

      const entry = (current: number, target: number, label: string) =>
        ({ current, target, label });
      setBadgeProgress({
        'First Rally':        entry(mx.length,     1,   'matches played'),
        'Hot Streak':         entry(streak,        5,   'wins in a row'),
        'Top Rated':          entry(elo,           4.0, 'PLUPR'),
        'Veteran':            entry(memberDays,    30,  'days as member'),
        'Court Hopper':       entry(courts,        5,   'courts played'),
        'Doubles Dynamo':     entry(doublesPlayed, 20,  'doubles matches'),
        'Singles Specialist': entry(singlesPlayed, 25,  'singles matches'),
      });
    }
    setLoading(false);
  }

  // Pretty number for progress: integers stay integers; PLUPR shows 2 decimals.
  // Falls back to integer to avoid noisy "1.00 / 5.00" labels for wins.
  function formatProgressNum(n: number, label: string): string {
    if (label === 'PLUPR') return n.toFixed(2);
    return Math.floor(n).toString();
  }

  function effectiveCost(item: ShopItem): { cost: number; discount: number } {
    if (item.category !== 'real_world') return { cost: item.cost, discount: 0 };
    const d = discounts.get(item.slug) ?? 0;
    return { cost: Math.floor(item.cost * (100 - d) / 100), discount: d };
  }

  function startGift(item: ShopItem) {
    const { cost } = effectiveCost(item);
    if (pickles < cost) {
      status.error(`Not enough pickles — you have ${pickles} 🥒, gifting ${item.name} costs ${cost} 🥒.`);
      return;
    }
    status.clear();
    setGiftError(null);
    setGiftItem(item);
    setGiftRecipient(null);
    setGiftMessage('');
    setGiftAddr(EMPTY_ADDRESS);
    setShowUserPicker(true);
  }

  async function confirmGift() {
    if (!giftItem || !giftRecipient) return;
    const isRedemption = giftItem.category === 'real_world';

    if (isRedemption && !isAddressValid(giftAddr)) {
      setGiftError("Please fill in the recipient's shipping address before sending the gift.");
      return;
    }
    setGiftError(null);

    setSendingGift(true);
    const { data, error } = isRedemption
      ? await supabase.rpc('gift_real_world_item', {
          p_item_id:          giftItem.id,
          p_recipient:        giftRecipient.id,
          p_message:          giftMessage.trim() || null,
          p_shipping_address: giftAddr,
        })
      : await supabase.rpc('gift_shop_item', {
          p_item_id:   giftItem.id,
          p_recipient: giftRecipient.id,
          p_message:   giftMessage.trim() || null,
        });
    setSendingGift(false);
    if (error) { setGiftError(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { setGiftError(row?.message ?? 'Could not gift — unknown error.'); return; }
    setPickles(row.new_balance);
    status.success(
      isRedemption
        ? `Gift sent! ${giftItem.name} will ship to ${giftRecipient.full_name}.`
        : `Gift sent! ${giftItem.name} is now in ${giftRecipient.full_name}'s inventory.`,
    );
    setGiftItem(null);
    setGiftRecipient(null);
    setGiftMessage('');
    setGiftAddr(EMPTY_ADDRESS);
    setGiftError(null);
  }

  function startBuy(item: ShopItem) {
    // Cosmetics are one-per-user; redemptions are stackable so we skip
    // the owned check for them.
    if (item.category !== 'real_world' && owned.has(item.id)) return;
    const { cost } = effectiveCost(item);
    if (pickles < cost) {
      status.error(`Not enough pickles — you have ${pickles} 🥒, ${item.name} costs ${cost} 🥒.`);
      return;
    }
    status.clear();
    setBuyError(null);
    // Reset the shipping address every time the confirm modal opens.
    setShipAddr(EMPTY_ADDRESS);
    setConfirmingItem(item);
  }

  async function equipShopItem(item: ShopItem) {
    if (!myUserId) return;
    const update: Record<string, any> = {};
    if (item.category === 'avatar') {
      update.avatar_emoji    = item.payload?.emoji    ?? null;
      update.avatar_bg_color = item.payload?.bgColor  ?? null;
    } else if (item.category === 'flair' && item.payload?.kind === 'name_color') {
      update.name_color = item.payload?.value ?? null;
    } else if (item.category === 'list_name_style') {
      // purchase_shop_item already auto-equips; this is for the "Buy & Equip"
      // explicit path so the optimistic update stays consistent.
      update.list_name_style_id = item.slug;
    } else if (item.category === 'profile_name_style') {
      update.profile_name_style_id = item.slug;
    }
    // cosmetic_badge: visible by default — nothing to write.
    if (Object.keys(update).length > 0) {
      await supabase.from('profiles').update(update).eq('id', myUserId);
    }
  }

  async function confirmBuy(equip: boolean = false) {
    const item = confirmingItem;
    if (!item) return;
    const isRedemption = item.category === 'real_world';

    if (isRedemption && !isAddressValid(shipAddr)) {
      setBuyError('Please fill in your shipping address before redeeming.');
      return;
    }
    setBuyError(null);

    setBuying({ id: item.id, equip });
    const { data, error } = isRedemption
      ? await supabase.rpc('redeem_real_world_item', {
          p_item_id:          item.id,
          p_shipping_address: shipAddr,
        })
      : await supabase.rpc('purchase_shop_item', { p_item_id: item.id });
    if (error) { setBuying(null); setBuyError(error.message); return; }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) {
      setBuying(null);
      setBuyError(row?.message ?? 'Could not purchase — unknown error.');
      return;
    }
    setPickles(row.new_balance);
    if (!isRedemption) setOwned(prev => new Set(prev).add(item.id));

    if (equip && !isRedemption) {
      try { await equipShopItem(item); } catch { /* non-fatal */ }
    }

    setBuying(null);
    setConfirmingItem(null);
    setShipAddr(EMPTY_ADDRESS);
    setBuyError(null);
    status.success(
      isRedemption ? `Redemption queued! ${item.name} will ship to the address you entered.`
        : equip    ? `Purchased & equipped! ${item.name} is now equipped on your profile.`
        :            `Purchased! ${item.name} is in your inventory. Equip / hide it from your Profile.`,
    );
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;

  // The "Profile Styles" tab surfaces both the new profile_name_style items
  // and the legacy `flair` items (color presets) so users see all profile
  // name styles in one place.
  const tabItems = items.filter(i =>
    tab === 'profile_name_style'
      ? (i.category === 'profile_name_style' || i.category === 'flair')
      : i.category === tab
  );
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

      <ScrollView contentContainerStyle={S.scroll} refreshControl={<AppRefreshControl {...refresh} />}>
        <StatusBanner status={status.value} />
        <Text style={S.tabBlurb}>{tabMeta.blurb}</Text>

        {tabItems.length === 0 ? (
          <EmptyState icon="🛒" title="Nothing here yet" subtitle="No items in this category yet." />
        ) : (
          <View style={S.grid}>
            {/* TODO: smoke-test in browser — verify the locked name-style row
                renders with a desaturated preview + "X / Y unit" progress
                indicator, and flips to "✓ Unlocked" once the badge is earned. */}
            {tabItems.map(item => {
              const isRedemption = item.category === 'real_world';
              const isNameStyle  = item.category === 'list_name_style' || item.category === 'profile_name_style';
              const isUnlockGated = !!item.unlock_badge_id;
              const { cost: effCost, discount } = effectiveCost(item);
              // Redemptions are stackable, so owned/duplicate guards don't apply.
              const isOwned     = !isRedemption && owned.has(item.id);
              const canAfford   = pickles >= effCost;
              const isBuying    = buying?.id === item.id;
              const usdCents    = item.payload?.usdCents as number | undefined;
              const unlockBadgeName = isUnlockGated
                ? badgeNames.get(item.unlock_badge_id!) ?? 'a badge'
                : null;
              // Edge case: viewer earned the gating badge but the row isn't
                // owned (e.g. trigger wasn't in place when the badge was
                // awarded). We surface this as "✓ Earned · pending grant" so
                // the UI doesn't claim "Locked" when it isn't, and skip the
                // "Claim" RPC for simplicity (see PR description).
              const badgeEarnedButNotOwned = isUnlockGated && !isOwned
                && !!item.unlock_badge_id && earnedBadgeIds.has(item.unlock_badge_id);
              // Locked name styles get a desaturated preview + small progress
              // chip. Once owned (or badge already earned), the preview is at
              // full opacity so the player sees the unlocked style clearly.
              const previewMuted = isUnlockGated && !isOwned && !badgeEarnedButNotOwned;
              const prog = isUnlockGated && unlockBadgeName ? badgeProgress[unlockBadgeName] : undefined;

              return (
                <View key={item.id} style={S.card}>
                  {discount > 0 && (
                    <View style={S.discountRibbon}>
                      <Text style={S.discountRibbonText}>−{discount}%</Text>
                    </View>
                  )}
                  <View style={[
                    S.iconBox,
                    { backgroundColor: item.payload?.bgColor ?? c.surfaceAlt },
                    previewMuted && S.iconBoxMuted,
                  ]}>
                    <Text style={[S.iconEmoji, previewMuted && S.iconEmojiMuted]}>{item.icon}</Text>
                  </View>
                  <Text style={S.cardName} numberOfLines={1}>{item.name}</Text>
                  {isNameStyle && (
                    <View style={[S.namePreviewBox, previewMuted && S.namePreviewBoxMuted]}>
                      <FlairName
                        name={myFullName}
                        styleId={item.slug}
                        mode={item.category === 'list_name_style' ? 'list' : 'hero'}
                        style={[S.namePreviewText, previewMuted && S.namePreviewTextMuted]}
                        numberOfLines={1}
                      />
                    </View>
                  )}
                  {isUnlockGated && prog && !isOwned && (
                    <View style={S.unlockProgressBox}>
                      <View style={S.unlockProgressBarTrack}>
                        <View style={[
                          S.unlockProgressBarFill,
                          { width: `${Math.min(100, Math.max(2, (prog.current / prog.target) * 100))}%` },
                        ]} />
                      </View>
                      <Text style={S.unlockProgressText} numberOfLines={1}>
                        {formatProgressNum(prog.current, prog.label)} / {formatProgressNum(prog.target, prog.label)} {prog.label}
                      </Text>
                    </View>
                  )}
                  <Text style={S.cardDesc} numberOfLines={3}>{item.description}</Text>
                  {isRedemption && usdCents != null && (
                    <Text style={S.usdLine}>Worth {formatUsd(usdCents)} online</Text>
                  )}
                  {!isUnlockGated && (
                    <View style={S.costRow}>
                      <View style={S.costPill}>
                        {discount > 0
                          ? <Text style={S.costText}>
                              <Text style={S.costStrike}>🥒 {item.cost}</Text>{'  '}
                              <Text style={S.costDiscounted}>🥒 {effCost}</Text>
                            </Text>
                          : <Text style={S.costText}>🥒 {effCost}</Text>}
                      </View>
                    </View>
                  )}
                  {isUnlockGated ? (
                    <View style={S.actionRow}>
                      <View style={[
                        S.buyBtn,
                        (isOwned || badgeEarnedButNotOwned) ? S.buyBtnOwned : S.buyBtnDisabled,
                        { flex: 1 },
                      ]}>
                        <Text
                          style={[
                            S.buyBtnText,
                            !(isOwned || badgeEarnedButNotOwned) && S.buyBtnTextDim,
                          ]}
                          numberOfLines={2}
                        >
                          {isOwned
                            ? '✓ Unlocked'
                            : badgeEarnedButNotOwned
                              ? '✓ Earned · pending grant'
                              : `🔒 Earn ${unlockBadgeName}`}
                        </Text>
                      </View>
                    </View>
                  ) : (
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
                          {isOwned ? '✓ Owned'
                            : isBuying ? '…'
                            : !canAfford ? 'Need 🥒'
                            : isRedemption ? 'Redeem' : 'Buy'}
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
                  )}
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
        onRequestClose={() => { setConfirmingItem(null); setBuyError(null); }}
      >
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Confirm Purchase</Text>
            {confirmingItem && (() => {
              const { cost: effCost, discount } = effectiveCost(confirmingItem);
              const isRedemption = confirmingItem.category === 'real_world';
              const addrOk = !isRedemption || isAddressValid(shipAddr);
              return (
              <ScrollView style={S.modalScroll}>
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
                  {discount > 0 && (
                    <>
                      <View style={S.confirmCostRow}>
                        <Text style={S.confirmCostLabel}>Base price</Text>
                        <Text style={S.confirmCostValue}>🥒 {confirmingItem.cost}</Text>
                      </View>
                      <View style={S.confirmCostRow}>
                        <Text style={S.confirmCostLabel}>Today's discount</Text>
                        <Text style={S.confirmCostValue}>−{discount}%</Text>
                      </View>
                    </>
                  )}
                  <View style={S.confirmCostRow}>
                    <Text style={S.confirmCostLabel}>Cost</Text>
                    <Text style={S.confirmCostValue}>🥒 {effCost}</Text>
                  </View>
                  <View style={S.confirmCostRow}>
                    <Text style={S.confirmCostLabel}>Balance after</Text>
                    <Text style={S.confirmCostValue}>🥒 {pickles - effCost}</Text>
                  </View>
                </View>

                {isRedemption && (
                  <>
                    <Text style={S.redemptionNote}>
                      🚚 We'll ship to the address below. Required.
                    </Text>
                    <ShippingAddressForm value={shipAddr} onChange={setShipAddr} />
                  </>
                )}

                {buyError ? <Text style={S.inlineError}>{buyError}</Text> : null}

                <View style={S.modalBtnRow}>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnSecondary]}
                    onPress={() => { setConfirmingItem(null); setBuyError(null); }}
                    disabled={!!buying}
                  >
                    <Text style={S.modalBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      S.modalBtn,
                      isRedemption ? S.modalBtnPrimary : S.modalBtnOutline,
                      !addrOk && S.modalBtnDisabled,
                    ]}
                    onPress={() => confirmBuy(false)}
                    disabled={!!buying || !addrOk}
                  >
                    {buying?.id === confirmingItem.id && !buying.equip
                      ? <ActivityIndicator color={isRedemption ? '#fff' : c.primary} size="small" />
                      : <Text style={isRedemption ? S.modalBtnPrimaryText : S.modalBtnOutlineText}>
                          {isRedemption ? 'Confirm Redeem' : 'Confirm Buy'}
                        </Text>}
                  </TouchableOpacity>
                </View>

                {!isRedemption && (
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnPrimary, S.modalBtnEquip]}
                    onPress={() => confirmBuy(true)}
                    disabled={!!buying}
                  >
                    {buying?.id === confirmingItem.id && buying.equip
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={S.modalBtnPrimaryText}>Confirm Buy & Equip</Text>}
                  </TouchableOpacity>
                )}
              </ScrollView>
              );
            })()}
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
        onRequestClose={() => { setGiftItem(null); setGiftRecipient(null); setGiftError(null); }}
      >
        <View style={S.modalBackdrop}>
          <View style={S.modalCard}>
            <Text style={S.modalTitle}>Send as Gift</Text>
            {giftItem && giftRecipient && (() => {
              const { cost: giftCost } = effectiveCost(giftItem);
              const isRedemption = giftItem.category === 'real_world';
              const addrOk = !isRedemption || isAddressValid(giftAddr);
              return (
              <ScrollView style={S.modalScroll}>
                <View style={S.giftPreviewRow}>
                  <View style={[S.giftIconBox, { backgroundColor: giftItem.payload?.bgColor ?? c.surfaceAlt }]}>
                    <Text style={S.giftIconEmoji}>{giftItem.icon}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={S.giftLabel}>To</Text>
                    <Text style={S.giftRecipientName}>{giftRecipient.full_name}</Text>
                    <Text style={S.giftItemName}>{giftItem.name} · 🥒 {giftCost}</Text>
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

                {isRedemption && (
                  <>
                    <Text style={S.redemptionNote}>
                      🚚 We'll ship to the address you enter below for {giftRecipient.full_name}. Required.
                    </Text>
                    <ShippingAddressForm
                      value={giftAddr}
                      onChange={setGiftAddr}
                      recipientLabel={`Ship to ${giftRecipient.full_name}`}
                    />
                  </>
                )}

                <Text style={S.giftBalance}>Your balance after: 🥒 {pickles - giftCost}</Text>

                {giftError ? <Text style={S.inlineError}>{giftError}</Text> : null}

                <View style={S.modalBtnRow}>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnSecondary]}
                    onPress={() => { setGiftItem(null); setGiftRecipient(null); setGiftMessage(''); setGiftAddr(EMPTY_ADDRESS); setGiftError(null); }}
                    disabled={sendingGift}
                  >
                    <Text style={S.modalBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnPrimary, !addrOk && S.modalBtnDisabled]}
                    onPress={confirmGift}
                    disabled={sendingGift || !addrOk}
                  >
                    {sendingGift
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={S.modalBtnPrimaryText}>Send Gift</Text>}
                  </TouchableOpacity>
                </View>
              </ScrollView>
              );
            })()}
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

    tabBar:        { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: c.surface, paddingHorizontal: 12, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border },
    tab:           { flexGrow: 1, flexBasis: '22%', paddingVertical: 8, paddingHorizontal: 4, borderRadius: 18, borderWidth: 1.5, borderColor: c.border, alignItems: 'center', backgroundColor: c.surface },
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
      position: 'relative',
    },
    iconBox:   { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 8 },
    iconEmoji: { fontSize: 32 },
    cardName:  { fontSize: 14, fontWeight: '800', color: c.text, textAlign: 'center', marginBottom: 4 },
    cardDesc:  { fontSize: 11, color: c.textMuted, textAlign: 'center', minHeight: 44, lineHeight: 15 },
    namePreviewBox:  { backgroundColor: c.surfaceAlt, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 8, marginBottom: 6, alignItems: 'center' },
    namePreviewBoxMuted: { opacity: 0.55 },
    namePreviewText: { fontSize: 14, fontWeight: '700' },
    namePreviewTextMuted: { opacity: 0.7 },
    iconBoxMuted:    { opacity: 0.55 },
    iconEmojiMuted:  { opacity: 0.7 },
    unlockProgressBox: { marginBottom: 6, paddingHorizontal: 4 },
    unlockProgressBarTrack: { height: 4, borderRadius: 2, backgroundColor: c.border, overflow: 'hidden' },
    unlockProgressBarFill:  { height: 4, backgroundColor: c.primary, borderRadius: 2 },
    unlockProgressText:     { fontSize: 10, fontWeight: '700', color: c.textSub, marginTop: 3, textAlign: 'center' },

    costRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', marginTop: 10 },
    costPill:   { backgroundColor: c.surfaceAlt, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignSelf: 'flex-start' },
    costText:   { fontSize: 12, fontWeight: '700', color: c.text },
    costStrike:     { fontSize: 11, color: c.textMuted, textDecorationLine: 'line-through', fontWeight: '600' },
    costDiscounted: { fontSize: 13, color: c.primary, fontWeight: '800' },
    usdLine:        { fontSize: 11, color: c.textMuted, textAlign: 'center', marginTop: 4 },
    discountRibbon: {
      position: 'absolute', top: 8, right: 8,
      backgroundColor: '#ef5350', borderRadius: 6,
      paddingHorizontal: 6, paddingVertical: 2, zIndex: 2,
    },
    discountRibbonText: { color: '#fff', fontWeight: '800', fontSize: 11 },
    redemptionNote: { fontSize: 12, color: c.textSub, marginBottom: 12, textAlign: 'center', lineHeight: 16 },
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
    modalCard:     { backgroundColor: c.surface, borderRadius: 16, padding: 20, width: '100%', maxWidth: 460, maxHeight: '92%' },
    modalScroll:   { maxHeight: '100%' },
    modalBtnDisabled: { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
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
    modalBtnOutline:     { backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.primary },
    modalBtnOutlineText: { color: c.primary, fontWeight: '800', fontSize: 14 },
    modalBtnEquip:       { marginTop: 8 },

    confirmCostBox:    { backgroundColor: c.primaryLight, borderRadius: 10, padding: 12, marginBottom: 16 },
    confirmCostRow:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
    confirmCostLabel:  { fontSize: 13, color: c.textSub, fontWeight: '600' },
    confirmCostValue:  { fontSize: 14, color: c.primary, fontWeight: '800' },
    inlineError:       { color: '#c62828', fontSize: 13, fontWeight: '600', marginBottom: 10 },
  });
}
