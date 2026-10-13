// The Pickle Shop (plan section 8, P6: compacted). A 44px balance line, an
// underline tab strip, then one grouped Panel of rows per tab:
//
//   [icon]  Name                                   [🎁] [ Buy ]
//           🥒 120 · two-line description
//   [icon]  Name                                  🔒 Earn Hot Streak
//           (name preview) · thin progress bar
//
// Was a 2-column grid of ~260px cards. Every action stays: Buy, Buy & Equip
// (in the confirm), Gift (pick a player, add a note), and the unlock-gated rows
// that say what earns them. The confirm and gift dialogs are RN Modals, opened
// one at a time (the recipient picker closes before the gift confirm opens).
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Modal, TextInput, useWindowDimensions,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { Panel, SegmentedToggle, ModalBackdrop } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { ProgressBar } from '@just-messin-around/expo-foundation/gamification';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useTheme } from '../lib/ThemeContext';
import { ShopCategory, ShopItem, ShopPurchase, RootStackParamList } from '../types';
import UserPickerModal, { PickedUser } from '../components/UserPickerModal';
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
// though they're stored as two categories under the hood. Tab labels are short
// so four fit a 375px strip; the blurb under the strip names the tab fully.
const TABS: { value: ShopCategory; label: string; blurb: string }[] = [
  { value: 'avatar',             label: 'Avatars', blurb: 'Premium avatars to swap in on your profile.' },
  { value: 'cosmetic_badge',     label: 'Badges',  blurb: 'Decorative badges that show on your profile.' },
  { value: 'profile_name_style', label: 'Profile', blurb: 'Profile name styles for your profile header: colors, glows, and animations.' },
  { value: 'list_name_style',    label: 'Lists',   blurb: 'List name styles for member lists, brackets, registrations, and match history.' },
];

export default function ShopScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = useMemo(() => makeStyles(c), [c]);
  // The dialogs sit in ModalBackdrop's content-sized wrapper, where a '%'
  // maxHeight has nothing to resolve against: cap them in px instead.
  const { height: winH } = useWindowDimensions();
  const modalCap = { maxHeight: Math.round(winH * 0.9) };
  // null = balance not known yet (still loading, or the read failed). Rendering
  // an unknown balance as 0 told users who could afford an item that they
  // couldn't — so every affordability check requires a real number.
  const [pickles, setPickles] = useState<number | null>(null);
  const [items, setItems]     = useState<ShopItem[]>([]);
  const [owned, setOwned]     = useState<Set<string>>(new Set());
  const [tab, setTab]         = useState<ShopCategory>('avatar');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
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
  const [buyError, setBuyError]                 = useState<string | null>(null);

  // Gift flow
  const [giftItem, setGiftItem]                 = useState<ShopItem | null>(null);
  const [giftRecipient, setGiftRecipient]       = useState<PickedUser | null>(null);
  const [giftMessage, setGiftMessage]           = useState('');
  const [giftError, setGiftError]               = useState<string | null>(null);
  const [showUserPicker, setShowUserPicker]     = useState(false);
  const [sendingGift, setSendingGift]           = useState(false);
  const [myUserId, setMyUserId]                 = useState<string | null>(null);

  const status = useStatusMessage();
  const refresh = useRefresh(load);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    try {
      // Local session read — getUser() is a round trip that returns null on bad
      // WiFi, which used to drop the viewer onto the pickles=0 path.
      const uid = await currentUserId(supabase);
      if (!uid) { setLoadError(null); return; }
      setMyUserId(uid);

      const [profileRow, itemRows, ownedRows, badgeRows, playerBadgeRows] = await Promise.all([
        sbCall(() => supabase.from('profiles').select('pickles, full_name, created_at, rating').eq('id', uid).single()) as Promise<any>,
        sbCall(() => supabase.from('shop_items').select('*').eq('is_active', true).order('sort_order')),
        sbCall(() => supabase.from('player_shop_purchases').select('shop_item_id').eq('user_id', uid)),
        sbCall(() => supabase.from('badges').select('id, name')),
        sbCall(() => supabase.from('player_badges').select('badge_id').eq('user_id', uid)),
      ]);

      setPickles(profileRow?.pickles ?? 0);
      setMyFullName(profileRow?.full_name ?? 'You');
      setItems((itemRows ?? []) as ShopItem[]);
      setOwned(new Set(((ownedRows ?? []) as ShopPurchase[]).map(p => p.shop_item_id)));
      setBadgeNames(new Map(((badgeRows ?? []) as { id: string; name: string }[])
        .map(b => [b.id, b.name])));
      setEarnedBadgeIds(new Set(((playerBadgeRows ?? []) as { badge_id: string }[])
        .map(p => p.badge_id)));
      setLoadError(null);

      // Only compute match-derived progress when we actually have an
      // unlock-gated style on the wire — keeps the Shop snappy when the
      // viewer is browsing non-style tabs.
      const hasUnlockGated = ((itemRows ?? []) as ShopItem[]).some(i => !!i.unlock_badge_id);
      if (hasUnlockGated && profileRow) {
        const prof = profileRow;
        const matches = await sbCall(() => supabase
          .from('matches')
          .select('match_type, player1_id, partner1_id, player2_id, partner2_id, winner_team, location_name')
          .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)
          .order('played_at', { ascending: false })
          .limit(200));
        const mx = (matches ?? []) as any[];
        const didWin = (m: any) => {
          const t1 = m.player1_id === uid || m.partner1_id === uid;
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
    } catch (e) {
      // Keep whatever already loaded on screen; the header + banner say the
      // balance couldn't be refreshed rather than silently showing 0.
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }

  // Pretty number for progress: integers stay integers; PLUPR shows 2 decimals.
  // Falls back to integer to avoid noisy "1.00 / 5.00" labels for wins.
  function formatProgressNum(n: number, label: string): string {
    if (label === 'PLUPR') return n.toFixed(2);
    return Math.floor(n).toString();
  }

  function startGift(item: ShopItem) {
    if (pickles == null) {
      status.error("We couldn't check your pickle balance. Pull to refresh and try again.");
      return;
    }
    if (pickles < item.cost) {
      status.error(`Not enough pickles — you have ${pickles} 🥒, gifting ${item.name} costs ${item.cost} 🥒.`);
      return;
    }
    status.clear();
    setGiftError(null);
    setGiftItem(item);
    setGiftRecipient(null);
    setGiftMessage('');
    setShowUserPicker(true);
  }

  async function confirmGift() {
    if (!giftItem || !giftRecipient) return;
    setGiftError(null);

    setSendingGift(true);
    const { data, error } = await supabase.rpc('gift_shop_item', {
      p_item_id:   giftItem.id,
      p_recipient: giftRecipient.id,
      p_message:   giftMessage.trim() || null,
    });
    setSendingGift(false);
    if (error) { setGiftError(error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { setGiftError(row?.message ?? 'Could not gift — unknown error.'); return; }
    setPickles(row.new_balance);
    status.success(`Gift sent! ${giftItem.name} is now in ${giftRecipient.full_name}'s inventory.`);
    setGiftItem(null);
    setGiftRecipient(null);
    setGiftMessage('');
    setGiftError(null);
  }

  function startBuy(item: ShopItem) {
    if (owned.has(item.id)) return;
    if (pickles == null) {
      status.error("We couldn't check your pickle balance. Pull to refresh and try again.");
      return;
    }
    if (pickles < item.cost) {
      status.error(`Not enough pickles — you have ${pickles} 🥒, ${item.name} costs ${item.cost} 🥒.`);
      return;
    }
    status.clear();
    setBuyError(null);
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
    setBuyError(null);

    setBuying({ id: item.id, equip });
    const { data, error } = await supabase.rpc('purchase_shop_item', { p_item_id: item.id });
    if (error) { setBuying(null); setBuyError(error.message); return; }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) {
      setBuying(null);
      setBuyError(row?.message ?? 'Could not purchase — unknown error.');
      return;
    }
    setPickles(row.new_balance);
    setOwned(prev => new Set(prev).add(item.id));

    if (equip) {
      try { await equipShopItem(item); } catch { /* non-fatal */ }
    }

    setBuying(null);
    setConfirmingItem(null);
    setBuyError(null);
    status.success(
      equip ? `Purchased & equipped! ${item.name} is now equipped on your profile.`
            : `Purchased! ${item.name} is in your inventory. Equip / hide it from your Profile.`,
    );
  }

  // A failed first load must fall through to the ScrollView so pull-to-refresh
  // and the Retry button stay reachable.
  const loadFailed = loadError != null && items.length === 0;
  if (loading && !loadFailed) {
    return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} variant="row" /></View>;
  }

  // The "Profile Styles" tab surfaces both the new profile_name_style items
  // and the legacy `flair` items (color presets) so users see all profile
  // name styles in one place.
  const tabItems = items.filter(i =>
    tab === 'profile_name_style'
      ? (i.category === 'profile_name_style' || i.category === 'flair')
      : i.category === tab
  );
  const tabMeta  = TABS.find(x => x.value === tab)!;

  // One item row. A render function (not a nested component) so FlairName
  // previews aren't remounted on every render.
  function renderItem(item: ShopItem, lastRow: boolean) {
    const isNameStyle  = item.category === 'list_name_style' || item.category === 'profile_name_style';
    const isUnlockGated = !!item.unlock_badge_id;
    const isOwned     = owned.has(item.id);
    // Unknown balance is not "can't afford" — the row stays enabled
    // and startBuy explains why nothing happened.
    const canAfford   = pickles == null || pickles >= item.cost;
    const isBuying    = buying?.id === item.id;
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
    // bar. Once owned (or badge already earned), the preview is at
    // full opacity so the player sees the unlocked style clearly.
    const previewMuted = isUnlockGated && !isOwned && !badgeEarnedButNotOwned;
    const prog = isUnlockGated && unlockBadgeName ? badgeProgress[unlockBadgeName] : undefined;
    const progText = prog
      ? `${formatProgressNum(prog.current, prog.label)} / ${formatProgressNum(prog.target, prog.label)} ${prog.label}`
      : '';

    let trailing: React.ReactNode;
    if (isUnlockGated) {
      trailing = (
        <Text
          style={[t.meta, S.gateText, (isOwned || badgeEarnedButNotOwned) && { color: c.primary }]}
          numberOfLines={2}
          maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        >
          {isOwned
            ? '✓ Unlocked'
            : badgeEarnedButNotOwned
              ? '✓ Earned · pending grant'
              : `🔒 Earn ${unlockBadgeName}`}
        </Text>
      );
    } else {
      trailing = (
        <View style={S.actions}>
          <TouchableOpacity
            style={[S.box44, !canAfford && S.dim]}
            onPress={() => startGift(item)}
            disabled={!canAfford || isBuying}
            accessibilityRole="button"
            accessibilityLabel={`Gift ${item.name}`}
          >
            <Text style={S.giftGlyph}>🎁</Text>
          </TouchableOpacity>
          {isOwned ? (
            <View style={S.box44}>
              <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>✓ Owned</Text>
            </View>
          ) : (
            <Button
              size="sm"
              title={!canAfford ? 'Need 🥒' : 'Buy'}
              onPress={() => startBuy(item)}
              disabled={isBuying || !canAfford}
              loading={isBuying}
            />
          )}
        </View>
      );
    }

    return (
      <View key={item.id} style={[S.row, lastRow && S.rowLast]}>
        <View style={[S.tile, { backgroundColor: item.payload?.bgColor ?? c.surfaceAlt }, previewMuted && S.dim]}>
          <Text style={S.tileGlyph}>{item.icon}</Text>
        </View>
        <View style={S.flexText}>
          <Text style={t.title} numberOfLines={1}>{item.name}</Text>
          {isNameStyle ? (
            <FlairName
              name={myFullName}
              styleId={item.slug}
              mode={item.category === 'list_name_style' ? 'list' : 'hero'}
              style={[S.namePreview, previewMuted && S.dim]}
              numberOfLines={1}
            />
          ) : null}
          {isUnlockGated && prog && !isOwned ? (
            <ProgressBar
              progress={prog.target > 0 ? prog.current / prog.target : 0}
              minFill={0.02}
              height={4}
              trackColor={c.border}
              caption={progText}
              containerStyle={S.progress}
              accessibilityLabel={`${item.name} unlock progress`}
              accessibilityValueText={progText}
            />
          ) : (
            <Text style={t.sub} numberOfLines={isNameStyle ? 1 : 2}>
              {isUnlockGated ? item.description : `🥒 ${item.cost} · ${item.description}`}
            </Text>
          )}
        </View>
        {trailing}
      </View>
    );
  }

  return (
    <View style={S.root}>
      {/* Balance (the header already says "Pickle Shop") */}
      <View style={S.balanceRow}>
        <Text style={[t.sub, S.flexText]}>Your balance</Text>
        <View
          style={S.balancePill}
          accessible
          accessibilityLabel={pickles == null ? 'Balance unavailable' : `${pickles} pickles`}
        >
          <Text style={S.balanceText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>🥒 {pickles ?? '—'}</Text>
        </View>
      </View>

      <SegmentedToggle
        variant="underline"
        size="sm"
        options={TABS.map(x => ({ value: x.value, label: x.label }))}
        value={tab}
        onChange={setTab}
        style={S.tabs}
      />

      <ScrollView contentContainerStyle={S.scroll} refreshControl={<AppRefreshControl {...refresh} />}>
        <StatusBanner status={status.value} />
        <Text style={[t.sub, S.blurb]} numberOfLines={2}>{tabMeta.blurb}</Text>

        {loadFailed ? (
          <EmptyState
            icon="📡"
            title="Couldn't load the shop"
            subtitle={friendlySbMessage(loadError)}
            actionLabel="Retry"
            onAction={() => { setLoading(true); void load(); }}
          />
        ) : tabItems.length === 0 ? (
          <EmptyState compact icon="🛒" title="Nothing here yet" subtitle="No items in this category yet." />
        ) : (
          // TODO: smoke-test in browser — verify the locked name-style row
          // renders with a desaturated preview + "X / Y unit" progress
          // indicator, and flips to "✓ Unlocked" once the badge is earned.
          <Panel padded={false}>
            {tabItems.map((item, i) => renderItem(item, i === tabItems.length - 1))}
          </Panel>
        )}
      </ScrollView>

      {/* Confirm Buy */}
      <Modal
        visible={!!confirmingItem}
        transparent animationType="fade"
        onRequestClose={() => { if (!buying) { setConfirmingItem(null); setBuyError(null); } }}
      >
        <ModalBackdrop
          onDismiss={() => { if (!buying) { setConfirmingItem(null); setBuyError(null); } }}
          backdropColor={c.backdrop}
        >
          <View style={[S.modalCard, modalCap]}>
            <Text style={[t.h3, S.modalTitle]}>Confirm Purchase</Text>
            {confirmingItem && (
              <ScrollView style={S.modalScroll}>
                <View style={S.previewRow}>
                  <View style={[S.previewTile, { backgroundColor: confirmingItem.payload?.bgColor ?? c.surfaceAlt }]}>
                    <Text style={S.previewGlyph}>{confirmingItem.icon}</Text>
                  </View>
                  <View style={S.flexText}>
                    <Text style={t.title}>{confirmingItem.name}</Text>
                    <Text style={t.sub} numberOfLines={3}>{confirmingItem.description}</Text>
                  </View>
                </View>

                <View style={S.costBox}>
                  <View style={S.costLine}>
                    <Text style={t.sub}>Cost</Text>
                    <Text style={S.costValue}>🥒 {confirmingItem.cost}</Text>
                  </View>
                  <View style={S.costLine}>
                    <Text style={t.sub}>Balance after</Text>
                    {/* startBuy already refused to open this modal on an unknown balance. */}
                    <Text style={S.costValue}>🥒 {(pickles ?? 0) - confirmingItem.cost}</Text>
                  </View>
                </View>

                {buyError ? <Text style={S.inlineError}>{buyError}</Text> : null}

                <View style={S.modalBtnRow}>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnSecondary]}
                    onPress={() => { setConfirmingItem(null); setBuyError(null); }}
                    disabled={!!buying}
                    accessibilityRole="button"
                  >
                    <Text style={S.modalBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnOutline]}
                    onPress={() => confirmBuy(false)}
                    disabled={!!buying}
                    accessibilityRole="button"
                  >
                    {buying?.id === confirmingItem.id && !buying.equip
                      ? <ActivityIndicator color={c.primary} size="small" />
                      : <Text style={S.modalBtnOutlineText}>Confirm Buy</Text>}
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={[S.modalBtn, S.modalBtnPrimary, S.modalBtnEquip]}
                  onPress={() => confirmBuy(true)}
                  disabled={!!buying}
                  accessibilityRole="button"
                >
                  {buying?.id === confirmingItem.id && buying.equip
                    ? <ActivityIndicator color={c.textInverse} size="small" />
                    : <Text style={S.modalBtnPrimaryText}>Confirm Buy & Equip</Text>}
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </ModalBackdrop>
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
        onRequestClose={() => { if (!sendingGift) { setGiftItem(null); setGiftRecipient(null); setGiftError(null); } }}
      >
        <ModalBackdrop
          onDismiss={() => { if (!sendingGift) { setGiftItem(null); setGiftRecipient(null); setGiftError(null); } }}
          backdropColor={c.backdrop}
        >
          <View style={[S.modalCard, modalCap]}>
            <Text style={[t.h3, S.modalTitle]}>Send as Gift</Text>
            {giftItem && giftRecipient && (
              <ScrollView style={S.modalScroll} keyboardShouldPersistTaps="handled">
                <View style={S.previewRow}>
                  <View style={[S.previewTile, { backgroundColor: giftItem.payload?.bgColor ?? c.surfaceAlt }]}>
                    <Text style={S.previewGlyph}>{giftItem.icon}</Text>
                  </View>
                  <View style={S.flexText}>
                    <Text style={t.fieldLabel}>To</Text>
                    <Text style={t.title}>{giftRecipient.full_name}</Text>
                    <Text style={t.sub}>{giftItem.name} · 🥒 {giftItem.cost}</Text>
                  </View>
                </View>

                <Text style={[t.fieldLabel, S.fieldLabel]}>Optional message</Text>
                <TextInput
                  style={[S.giftMessage, webInputFontFloor(S.giftMessage)]}
                  placeholder="Add a note (optional)…"
                  placeholderTextColor={c.textMuted}
                  value={giftMessage}
                  onChangeText={setGiftMessage}
                  maxLength={200}
                  multiline
                />

                <Text style={[t.sub, S.giftBalance]}>Your balance after: 🥒 {(pickles ?? 0) - giftItem.cost}</Text>

                {giftError ? <Text style={S.inlineError}>{giftError}</Text> : null}

                <View style={S.modalBtnRow}>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnSecondary]}
                    onPress={() => { setGiftItem(null); setGiftRecipient(null); setGiftMessage(''); setGiftError(null); }}
                    disabled={sendingGift}
                    accessibilityRole="button"
                  >
                    <Text style={S.modalBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.modalBtn, S.modalBtnPrimary]}
                    onPress={confirmGift}
                    disabled={sendingGift}
                    accessibilityRole="button"
                  >
                    {sendingGift
                      ? <ActivityIndicator color={c.textInverse} size="small" />
                      : <Text style={S.modalBtnPrimaryText}>Send Gift</Text>}
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </ModalBackdrop>
      </Modal>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:     { flex: 1, backgroundColor: c.bg },
    flexText: { flex: 1, minWidth: 0 },
    box44:    { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    dim:      { opacity: 0.5 },

    balanceRow: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
      minHeight: 44, paddingHorizontal: SPACE.lg,
      backgroundColor: c.surface,
    },
    balancePill: {
      flexDirection: 'row', alignItems: 'center', minHeight: 28,
      paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill,
      backgroundColor: c.primaryLight, borderWidth: HAIRLINE, borderColor: c.primary,
    },
    balanceText: { fontSize: FONT.size.md, fontWeight: '800', color: c.primary },
    tabs:        { backgroundColor: c.surface, paddingHorizontal: SPACE.sm },

    scroll: { padding: SPACE.lg, paddingBottom: SPACE.xl },
    blurb:  { marginBottom: SPACE.md },

    // A Row inside the tab's Panel: 64 min, hairline divider, none under the last.
    row: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
      minHeight: 64, paddingVertical: SPACE.sm, paddingLeft: SPACE.md, paddingRight: SPACE.sm,
      borderBottomWidth: HAIRLINE, borderBottomColor: c.border,
    },
    rowLast:     { borderBottomWidth: 0 },
    tile:        { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    tileGlyph:   { fontSize: FONT.size.h2 },
    namePreview: { fontSize: FONT.size.md, fontWeight: '700' },
    progress:    { marginTop: SPACE.xs },
    actions:     { flexDirection: 'row', alignItems: 'center' },
    giftGlyph:   { fontSize: FONT.size.xl },
    gateText:    { maxWidth: 112, textAlign: 'right', color: c.textMuted },

    // Overlays (confirm / gift): the only place a card floats.
    modalCard:   { backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.lg, width: '100%', maxWidth: 460 },
    // Shrinks to the card's px cap and scrolls the rest.
    modalScroll: { flexShrink: 1 },
    modalTitle:  { marginBottom: SPACE.md },
    previewRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginBottom: SPACE.md },
    previewTile: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
    previewGlyph:{ fontSize: FONT.size.display },
    costBox:     { backgroundColor: c.primaryLight, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.lg },
    costLine:    { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: SPACE.xxs },
    costValue:   { fontSize: FONT.size.md, color: c.primary, fontWeight: '800' },
    fieldLabel:  { marginTop: SPACE.xs, marginBottom: SPACE.xs },
    giftMessage: {
      borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, padding: SPACE.md,
      // Web raises this to 16 at the input (webInputFontFloor): iOS Safari
      // zooms the page on focus of an input under 16px.
      fontSize: FONT.size.md,
      color: c.text, minHeight: 60, textAlignVertical: 'top',
    },
    giftBalance: { marginTop: SPACE.sm, marginBottom: SPACE.md },
    modalBtnRow: { flexDirection: 'row', gap: SPACE.sm },
    modalBtn:    { flex: 1, minHeight: 44, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
    modalBtnPrimary:       { backgroundColor: c.primary },
    modalBtnPrimaryText:   { color: c.textInverse, fontWeight: '800', fontSize: FONT.size.md },
    modalBtnSecondary:     { backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    modalBtnSecondaryText: { color: c.textSub, fontWeight: '700', fontSize: FONT.size.md },
    modalBtnOutline:       { backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.primary },
    modalBtnOutlineText:   { color: c.primary, fontWeight: '800', fontSize: FONT.size.md },
    modalBtnEquip:         { marginTop: SPACE.sm },
    inlineError: { color: c.danger, fontSize: FONT.size.base, fontWeight: '600', marginBottom: SPACE.sm },
  });
}
