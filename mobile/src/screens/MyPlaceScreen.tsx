// My Place (docs/my-place.md): a decoratable room, Doggle's Pet Home on the
// kit's /room module.
//
// My own (no userId, or mine): the room with my avatar in the avatar slot.
// Tap a spot (or its chip below) to open its decor sheet: owned first, then
// for sale with prices and my pickles; Buy asks first, then puts it in;
// Remove empties the spot. Tapping a row previews it in the room. The first
// visit claims the free starter set (claim_my_place_starter) on its own,
// with a button if that fails. Who can visit: Friends (default) or Only me.
// Under the room, the Court Pass chip (docs/court-pass.md): its decor tiers
// land here, owned, and are put in from the spot's sheet like any other.
//
// Someone else's (userId): the same room, read-only. A refused visit (Only
// me, friends only, unavailable, a guest pass) is a friendly state that says
// why and offers what to do, not just a toast.
//
// Stays (migration_place_stays.sql, Brian 2026-11-05): on a friend's place,
// "Stay for 4 hours" sends my avatar there (one stay at a time); it comes home
// on its own with a souvenir and pickles (PlaceStayReturnHost on Home), or
// early with nothing ("Come home early"). While away, my avatar is missing
// from my own place, which says where it is; friends staying over stand on
// the guest spots.
//
// Brian's rule: players never move, resize or arrange anything. Slots are
// anchored; only the God mode layout (MyPlaceLayout) moves them.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, type LayoutChangeEvent } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { createArtResolver } from '@just-messin-around/expo-foundation/room/art';
import { roomBuyConfirmCopy } from '@just-messin-around/expo-foundation/room';
import { Panel, SectionHeader, Chip, ErrorState, SegmentedToggle, ConfirmModal, celebrate } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { isGodmodeUserId } from '../lib/godmode';
import { explainRefusal } from '../lib/refusalNotices';
import { refusalCopy, refusalDetail, refusalMessage } from '../lib/refusals';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import FriendButton from '../components/FriendButton';
import MyPlaceRoom from '../components/myPlace/MyPlaceRoom';
import DecorSheet, { type DecorNotice } from '../components/myPlace/DecorSheet';
import CourtPassChip from '../components/home/CourtPassChip';
import { useCourtPass } from '../lib/useCourtPass';
import { AVATARS } from '../data/profileCustomization';
import {
  buyHomeItem,
  claimMyPlaceStarter,
  clearHomeSlot,
  equipHomeItem,
  invalidateMyPlace,
  setMyPlaceVisibility,
  useItemArt,
  useMyHome,
  useMyPlaceCatalog,
  usePlaceOwner,
  useRoomLayout,
  useVisitHome,
} from '../data/myPlace';
import {
  avatarLook,
  blockingParent,
  decorRows,
  filledCount,
  firstName,
  parentEmptyNote,
  sceneItems,
  slotsTheServerKnows,
  visitBlock,
  visitBlockTitle,
  type DecorRow,
  type MyPlaceItem,
  type MyPlaceVisibility,
} from '../lib/myPlace';
import { MY_PLACE_DECOR_SLOTS, MY_PLACE_SLOTS } from '../lib/myPlaceSlots';
import {
  awayLine,
  COME_HOME_BUTTON,
  COME_HOME_CONFIRM,
  guestLine,
  ownerAwayLine,
  stayingHereLine,
  STAY_BUTTON,
  STAY_PITCH,
} from '../lib/placeStays';
import { leavePlace, usePlaceStays, visitPlace } from '../data/placeStays';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'MyPlace'>;

const PICKLE_WORDS = { singular: 'pickle', plural: 'pickles' };
/** The room never grows past this on a wide web column. */
const MAX_ROOM_WIDTH = 560;
const SLOT_LABEL: Record<string, string> = Object.fromEntries(MY_PLACE_SLOTS.map((s) => [s.id, s.label]));
const slotLabel = (id: string) => SLOT_LABEL[id] ?? id;

export default function MyPlaceScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const ownerParam = route.params?.userId ?? null;

  // Who I am (a local session read, as the other screens do).
  const [meId, setMeId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void currentUserId(supabase).then((id) => live && setMeId(id ?? null)).catch(() => live && setMeId(null));
    return () => {
      live = false;
    };
  }, []);
  const mine = !ownerParam || (meId != null && ownerParam === meId);
  const ownerId = mine ? meId ?? null : ownerParam;

  const catalog = useMyPlaceCatalog();
  const layoutQ = useRoomLayout();
  const myHome = useMyHome(mine && meId !== undefined);
  // My own place links to the Court Pass, where decor tiers are earned.
  const courtPass = useCourtPass({ enabled: mine && meId != null });
  const visit = useVisitHome(mine ? null : ownerParam, !mine && meId !== undefined);
  const home = mine ? myHome : visit;
  const owner = usePlaceOwner(ownerId);
  // Stays: mine (where my avatar is), and this place's (who is here, and
  // whether its owner is away). The same read when it's my own place.
  const myStays = usePlaceStays(null, meId != null);
  const placeStays = usePlaceStays(mine ? null : ownerParam, !mine && meId != null);
  const stays = mine ? myStays : placeStays;

  // Pickles change on other screens (Shop, gifts, claims): re-read my balance on every focus.
  const refreshMine = myHome.refresh;
  useFocusEffect(
    useCallback(() => {
      if (mine && meId !== undefined) void refreshMine();
    }, [mine, meId, refreshMine]),
  );

  const ownerFirst = firstName(owner.data?.full_name) || route.params?.userName?.split(/\s+/)[0] || '';
  useEffect(() => {
    navigation.setOptions({ title: mine ? 'My Place' : ownerFirst ? `${ownerFirst}'s place` : 'Their place' });
  }, [navigation, mine, ownerFirst]);

  // ── the starter set, claimed once on my first visit ──
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const claimTried = useRef(false);
  const claim = useCallback(async () => {
    setClaiming(true);
    setClaimError(null);
    try {
      await claimMyPlaceStarter();
    } catch (e) {
      setClaimError(explainRefusal(e, "Couldn't set up your place. Check your connection, then tap Set up my place."));
    } finally {
      setClaiming(false);
    }
  }, []);
  useEffect(() => {
    if (!mine || !myHome.data || myHome.data.starterClaimed || claimTried.current) return;
    claimTried.current = true;
    void claim();
  }, [mine, myHome.data, claim]);

  // ── the open sheet and its preview ──
  const [activeSlot, setActiveSlot] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ slotId: string; itemId: string } | null>(null);
  const [notice, setNotice] = useState<DecorNotice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingBuy, setPendingBuy] = useState<{ slotId: string; item: MyPlaceItem } | null>(null);
  const [visBusy, setVisBusy] = useState(false);
  const [visError, setVisError] = useState<string | null>(null);

  const openSlot = useCallback((slotId: string) => {
    setActiveSlot(slotId);
    setPreview(null);
    setNotice(null);
  }, []);
  const closeSheet = useCallback(() => {
    setActiveSlot(null);
    setPreview(null);
    setNotice(null);
  }, []);

  const decorSlots = useMemo(() => slotsTheServerKnows(MY_PLACE_DECOR_SLOTS, catalog.data?.serverSlotIds), [catalog.data?.serverSlotIds]);
  const saved = home.data?.equipped ?? EMPTY;
  const shownIds = useMemo(
    () => (preview ? { ...saved, [preview.slotId]: preview.itemId } : saved),
    [saved, preview],
  );

  const slot = activeSlot ? decorSlots.find((s) => s.id === activeSlot) ?? null : null;
  const baseRows = useMemo(
    () =>
      slot && catalog.data && mine && home.data
        ? decorRows(catalog.data.items, slot, { owned: home.data.owned, equipped: saved, balance: home.data.balance })
        : [],
    [slot, catalog.data, mine, home.data, saved],
  );

  // Art only for what's drawn: the room, and the open sheet's rows.
  const art = useItemArt(useMemo(() => [...Object.values(shownIds), ...baseRows.map((r) => r.item.id)], [shownIds, baseRows]));
  const withArt = useCallback((i: MyPlaceItem): MyPlaceItem => {
    const svg = art[i.id];
    return svg && svg !== i.svg ? { ...i, svg } : i;
  }, [art]);
  const byId = useMemo(() => {
    const out: Record<string, MyPlaceItem> = {};
    for (const i of catalog.data?.items ?? []) out[i.id] = withArt(i);
    return out;
  }, [catalog.data, withArt]);
  const rows = useMemo(() => baseRows.map((r) => ({ ...r, item: byId[r.item.id] ?? r.item })), [baseRows, byId]);
  const sceneEquipped = useMemo(() => sceneItems(shownIds, byId), [shownIds, byId]);
  const resolveArt = useMemo(() => createArtResolver(), []);

  const look = useMemo(() => (owner.data ? avatarLook(owner.data, AVATARS) : avatarLook(null, AVATARS)), [owner.data]);
  // The owner's avatar is missing while they're staying somewhere else.
  const ownerAway = stays.data?.away ?? null;
  const guestList = useMemo(() => stays.data?.guests ?? [], [stays.data]);
  const guests = useMemo(
    () => guestList.map((g) => ({ key: g.visitorId, look: avatarLook(g, AVATARS), name: g.visitorId === meId ? 'You' : g.name })),
    [guestList, meId],
  );
  const myAway = myStays.data?.away ?? null;
  const stayingHere = !mine && !!myAway && myAway.hostId === ownerParam;

  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);
  const roomWidth = Math.min(Math.max(0, width), MAX_ROOM_WIDTH);

  const refresh = useRefresh(async () => {
    invalidateMyPlace();
    await Promise.all([catalog.refresh(), layoutQ.refresh(), home.refresh(), owner.refresh(), myStays.refresh(), placeStays.refresh()]);
  });

  // ── actions ──
  const say = (kind: DecorNotice['kind'], text: string) => setNotice({ kind, text });

  // A ref, not state: two taps in one frame both see busyId === null.
  const busyRef = useRef(false);
  async function run(id: string, fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(id);
    setNotice(null);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }

  function onAction(row: DecorRow) {
    if (!slot || busyId || busyRef.current) return;
    const { item, action } = row;
    const slotId = slot.id;
    // A pillow with no couch wouldn't show: say so before any pickles are spent.
    const parent = blockingParent(MY_PLACE_SLOTS, slotId, saved);
    if (parent && (action.type === 'buy' || action.type === 'equip')) {
      say('info', parentEmptyNote(slot, parent));
      return;
    }
    switch (action.type) {
      case 'remove':
        void run(item.id, async () => {
          try {
            await clearHomeSlot(slotId);
            setPreview(null);
            say('success', `Took ${item.name} out of ${slot.label}.`);
          } catch (e) {
            say('error', explainRefusal(e, `Couldn't take ${item.name} out. Check your connection and try again.`));
          }
        });
        return;
      case 'equip':
        void run(item.id, async () => {
          try {
            await equipHomeItem(slotId, item.id);
            setPreview(null);
            say('success', action.from ? `Moved ${item.name} here from ${slotLabel(action.from)}.` : `${item.name} is in your room.`);
          } catch (e) {
            say('error', explainRefusal(e, `Couldn't put ${item.name} in. Check your connection and try again.`));
          }
        });
        return;
      case 'buy':
        setPendingBuy({ slotId, item });
        return;
      case 'locked':
        say(
          'info',
          action.short == null
            ? `Your pickles haven't loaded yet, so ${item.name} can't be bought. Pull down to refresh, then try again.`
            : refusalCopy('home.not_enough', {}, { item: item.name, cost: item.cost, short: action.short }),
        );
        return;
      case 'unavailable':
        say(
          'info',
          action.notYet
            ? refusalCopy('home.not_yet', {}, { item: item.name, available_from: item.availableFrom ? String(item.availableFrom) : null })
            : refusalCopy('home.ended', {}, { item: item.name }),
        );
    }
  }

  async function confirmBuy() {
    const p = pendingBuy;
    if (!p || busyRef.current) return;
    setPendingBuy(null);
    await run(p.item.id, async () => {
      try {
        await buyHomeItem(p.item.id);
      } catch (e) {
        say('error', explainRefusal(e, `Couldn't buy ${p.item.name}, and no pickles were spent. Check your connection and try again.`));
        return;
      }
      celebrate();
      try {
        await equipHomeItem(p.slotId, p.item.id);
        setPreview(null);
        say('success', `Got ${p.item.name}! It's in your room.`);
      } catch (e) {
        const why = refusalMessage(e);
        say('error', `You own ${p.item.name} now, but it couldn't be put in.${why ? ` ${why}` : ''} Tap Put in to try again.`);
      }
    });
  }

  // ── stays ──
  const [stayBusy, setStayBusy] = useState(false);
  const [stayError, setStayError] = useState<string | null>(null);
  const [confirmHome, setConfirmHome] = useState(false);
  async function startStay() {
    if (!ownerParam || stayBusy) return;
    setStayBusy(true);
    setStayError(null);
    try {
      await visitPlace(ownerParam);
      celebrate();
    } catch (e) {
      setStayError(
        explainRefusal(e, "Couldn't start your stay. Check your connection and try again.", {
          action: 'visit_place',
          personName: ownerFirst || undefined,
        }),
      );
    } finally {
      setStayBusy(false);
    }
  }
  async function comeHome() {
    setConfirmHome(false);
    if (stayBusy) return;
    setStayBusy(true);
    setStayError(null);
    try {
      await leavePlace();
    } catch (e) {
      setStayError(explainRefusal(e, "Couldn't bring you home. Check your connection and try again."));
    } finally {
      setStayBusy(false);
    }
  }
  const comeHomeButton = (
    <Button
      size="sm"
      variant="outline"
      title={COME_HOME_BUTTON}
      onPress={() => setConfirmHome(true)}
      loading={stayBusy}
      style={[styles.hug, styles.stayBtn]}
    />
  );
  const stayErrorText = stayError ? <Text style={[t.meta, { color: c.danger }]}>{stayError}</Text> : null;

  async function changeVisibility(v: MyPlaceVisibility) {
    if (!home.data || v === home.data.visibility) return;
    setVisBusy(true);
    setVisError(null);
    try {
      await setMyPlaceVisibility(v);
    } catch (e) {
      setVisError(explainRefusal(e, "Couldn't change who can visit. Check your connection and try again."));
    } finally {
      setVisBusy(false);
    }
  }

  // ── states ──
  const loadingAny = meId === undefined || (catalog.loading && !catalog.data) || (layoutQ.loading && !layoutQ.layout) || (home.loading && !home.data);
  if (loadingAny) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <SkeletonList rows={5} variant="row" />
      </View>
    );
  }

  // A refusal wins over a room read earlier this session: Only me, an unfriend
  // or a block applies as soon as the server says so.
  const block = !mine && home.error ? visitBlock(home.error) : null;
  if (block) {
    const body = refusalMessage(home.error, { action: 'visit_place', personName: ownerFirst || null }) ?? '';
    return (
      <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.container} refreshControl={<AppRefreshControl {...refresh} />}>
        <Panel style={styles.blockPanel}>
          <Icon name={block === 'private' || block === 'friends_only' ? 'lock' : block === 'guest' || block === 'signed_out' ? 'person' : 'eye-off'} size={36} color={c.textMuted} />
          <Text style={[t.h3, styles.center]}>{visitBlockTitle(block, ownerFirst || refusalDetail(home.error).name as string)}</Text>
          <Text style={[t.bodySub, styles.center]}>{body}</Text>
          {block === 'friends_only' && ownerParam && owner.data ? (
            <FriendButton userId={ownerParam} meId={meId ?? null} profile={owner.data} style={styles.friend} />
          ) : null}
          {block === 'guest' ? (
            <Button title="Finish signing up" onPress={() => navigation.navigate('UpgradeAccount')} style={styles.blockBtn} />
          ) : null}
          {block === 'friends_only' ? (
            <Button size="sm" variant="outline" title="Check again" onPress={() => void refresh.onRefresh()} style={styles.blockBtn} />
          ) : null}
          <Button size="sm" variant="outline" title="Go back" onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home'))} style={styles.blockBtn} />
        </Panel>
      </ScrollView>
    );
  }

  const firstError = (!catalog.data && catalog.error) || (!home.data && home.error) || null;
  if (firstError) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <ErrorState
          iconName="offline"
          error={firstError}
          message={explainRefusal(firstError, mine ? "Couldn't load My Place. Check your connection and try again." : "Couldn't load this place. Check your connection and try again.")}
          onRetry={() => void refresh.onRefresh()}
        />
      </View>
    );
  }

  const data = home.data;
  const filled = filledCount(saved, decorSlots);
  const blocked = slot ? blockingParent(MY_PLACE_SLOTS, slot.id, saved) : null;
  const confirm = pendingBuy ? roomBuyConfirmCopy(pendingBuy.item, PICKLE_WORDS) : null;
  const roomName = mine ? 'Your room' : ownerFirst ? `${ownerFirst}'s room` : 'Their room';

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <ScrollView
        contentContainerStyle={styles.container}
        stickyHeaderIndices={[0]}
        refreshControl={<AppRefreshControl {...refresh} />}
        keyboardShouldPersistTaps="handled"
      >
        {/* The room stays in view while the sheet scrolls under it. */}
        <View style={[styles.roomWrap, { backgroundColor: c.bg }]} onLayout={onLayout}>
          {roomWidth > 0 ? (
            <MyPlaceRoom
              width={roomWidth}
              layout={layoutQ.layout}
              items={sceneEquipped}
              resolveArt={resolveArt}
              avatar={ownerAway ? null : look}
              guests={guests}
              label={roomName}
              onPressSlot={mine && data?.starterClaimed ? openSlot : undefined}
              activeSlot={activeSlot}
            />
          ) : null}
        </View>

        {mine ? (
          <>
            {!data?.starterClaimed ? (
              <Panel style={styles.block}>
                <Text style={t.title}>{claiming ? 'Setting up your place...' : 'Welcome to My Place'}</Text>
                <Text style={t.sub}>
                  {claimError ?? 'Your starter room is free. Once it is set up, decorate it with pickles you earn.'}
                </Text>
                {!claiming ? <Button title="Set up my place" onPress={() => void claim()} style={styles.hug} /> : null}
              </Panel>
            ) : slot ? (
              <DecorSheet
                slot={slot}
                rows={rows}
                balance={data.balance}
                resolveArt={resolveArt}
                previewId={preview?.slotId === slot.id ? preview.itemId : null}
                onPreview={(row) =>
                  setPreview((p) => (p?.slotId === slot.id && p.itemId === row.item.id ? null : { slotId: slot.id, itemId: row.item.id }))
                }
                onAction={onAction}
                busyId={busyId}
                notice={notice}
                onDismissNotice={() => setNotice(null)}
                blockedBy={blocked}
                blockedNote={blocked ? parentEmptyNote(slot, blocked) : null}
                onOpenSlot={openSlot}
                slotLabel={slotLabel}
                onClose={closeSheet}
              />
            ) : (
              <>
                {myAway ? (
                  <Panel style={styles.block}>
                    <Text style={t.title}>{awayLine(myAway)}</Text>
                    <Text style={t.sub}>Your avatar is out, so it isn't in your room until it comes home.</Text>
                    {comeHomeButton}
                    {stayErrorText}
                  </Panel>
                ) : null}
                {guestList.map((g) => (
                  <Text key={g.visitorId} style={t.sub}>{guestLine(g)}</Text>
                ))}
                {courtPass.summary ? (
                  <CourtPassChip summary={courtPass.summary} onPress={() => navigation.navigate('CourtPass')} />
                ) : null}
                <Text style={[t.sub, styles.block]}>
                  {filled === 0
                    ? 'Your room is empty. Tap a spot in the room, or pick one below, to decorate it.'
                    : 'Tap anything in your room, or pick a spot below, to change it. Spots stay where they are; you pick what goes in them.'}
                </Text>
                <View style={styles.chips}>
                  {decorSlots.map((s) => {
                    const has = !!saved[s.id];
                    return (
                      <Chip
                        key={s.id}
                        label={s.label}
                        iconName={has ? 'check' : 'plus'}
                        tone={has ? 'brand' : 'neutral'}
                        size="sm"
                        onPress={() => openSlot(s.id)}
                        accessibilityLabel={`${s.label}, ${has ? 'filled. Change it' : 'empty. Add something'}`}
                        maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
                      />
                    );
                  })}
                </View>
                {catalog.data && catalog.data.items.length === 0 ? (
                  <Text style={[t.hint, styles.block]}>Decor is on its way. New items arrive with each drop, so check back soon.</Text>
                ) : null}

                <SectionHeader title="Who can visit" />
                <Panel style={styles.block}>
                  <SegmentedToggle<MyPlaceVisibility>
                    options={[
                      { label: 'Friends', value: 'friends', iconName: 'group' },
                      { label: 'Only me', value: 'only_me', iconName: 'lock' },
                    ]}
                    value={data?.visibility ?? 'friends'}
                    onChange={(v) => void changeVisibility(v)}
                    fullWidth
                  />
                  <Text style={[t.meta, styles.visNote]}>
                    {visBusy
                      ? 'Saving...'
                      : (data?.visibility ?? 'friends') === 'friends'
                        ? 'Your friends can visit your place from your profile. Players you block never can.'
                        : 'Only you can see your place. Friends who try to visit are told it is private.'}
                  </Text>
                  {visError ? <Text style={[t.meta, { color: c.danger }]}>{visError}</Text> : null}
                </Panel>

                {isGodmodeUserId(meId) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    iconName="edit"
                    title="Edit the layout (God mode)"
                    onPress={() => navigation.navigate('MyPlaceLayout')}
                    style={[styles.hug, styles.block]}
                  />
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            <Panel style={styles.block}>
              {stayingHere && myAway ? (
                <>
                  <Text style={t.title}>{stayingHereLine(myAway.endsAt)}</Text>
                  {comeHomeButton}
                </>
              ) : myAway ? (
                <>
                  <Text style={t.title}>{awayLine(myAway)}</Text>
                  <Text style={t.sub}>One stay at a time. Come home first to stay here instead.</Text>
                  {comeHomeButton}
                </>
              ) : (
                <>
                  <Text style={t.sub}>{STAY_PITCH}</Text>
                  <Button
                    size="sm"
                    title={STAY_BUTTON}
                    iconName="home"
                    onPress={() => void startStay()}
                    loading={stayBusy}
                    disabled={myStays.loading && !myStays.data}
                    style={[styles.hug, styles.stayBtn]}
                  />
                </>
              )}
              {stayErrorText}
            </Panel>
            {ownerAway ? <Text style={t.sub}>{ownerAwayLine(ownerFirst, ownerAway)}</Text> : null}
            {guestList.filter((g) => g.visitorId !== meId).map((g) => (
              <Text key={g.visitorId} style={t.sub}>{guestLine(g)}</Text>
            ))}
            <Text style={[t.sub, styles.block]}>
              {filled === 0
                ? `${ownerFirst ? `${ownerFirst} hasn't` : "They haven't"} decorated yet. Check back later.`
                : `This is ${ownerFirst ? `${ownerFirst}'s` : 'their'} place. Only ${ownerFirst || 'they'} can decorate it.`}
            </Text>
          </>
        )}
      </ScrollView>

      <ConfirmModal
        visible={confirmHome}
        title={COME_HOME_CONFIRM.title}
        body={COME_HOME_CONFIRM.body}
        primaryLabel={COME_HOME_CONFIRM.label}
        onConfirm={() => void comeHome()}
        onClose={() => setConfirmHome(false)}
      />

      <ConfirmModal
        visible={!!pendingBuy}
        title={confirm?.title ?? ''}
        body={confirm ? `${confirm.body} It goes straight into ${slotLabel(pendingBuy?.slotId ?? '')}.` : undefined}
        primaryLabel={confirm?.label ?? ''}
        variant="success"
        onConfirm={() => void confirmBuy()}
        onClose={() => setPendingBuy(null)}
      />
    </View>
  );
}

const EMPTY: Record<string, string> = Object.freeze({}) as Record<string, string>;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { padding: SPACE.lg, paddingBottom: SPACE.xl, gap: SPACE.md, flexGrow: 1 },
  roomWrap: { alignItems: 'center', paddingBottom: SPACE.sm, borderRadius: RADIUS.lg },
  block: { marginTop: SPACE.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  hug: { alignSelf: 'flex-start' },
  visNote: { marginTop: SPACE.sm },
  blockPanel: { alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xl },
  center: { textAlign: 'center' },
  friend: { alignSelf: 'stretch' },
  blockBtn: { alignSelf: 'stretch' },
  stayBtn: { marginTop: SPACE.sm },
});
