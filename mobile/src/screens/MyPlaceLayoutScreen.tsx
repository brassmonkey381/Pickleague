// God mode only: where each My Place slot is drawn, for every player's room
// (docs/my-place.md, rule 2). The kit's RoomLayoutEditor bound to room_layout
// and save_room_layout. Each slot shows a sample with real art (what's in my
// own room there, else a starter, else the first item that fits) so every box
// is visible, and my avatar stands in the avatar spot.
//
// Self-guards with is_godmode_user() (amIGodmode); save_room_layout refuses
// everyone else too (pl:admin.only). Players never see this: they only pick
// which item fills a slot.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, type LayoutChangeEvent } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RoomLayoutEditor } from '@just-messin-around/expo-foundation/room';
import { createArtResolver } from '@just-messin-around/expo-foundation/room/art';
import type { Box, RoomLayout } from '@just-messin-around/expo-foundation/room/layout';
import { itemFitsSlot } from '@just-messin-around/expo-foundation/room/shop';
import { ErrorState } from '@just-messin-around/expo-foundation/ui';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { explainRefusal } from '../lib/refusalNotices';
import EmptyState from '../components/EmptyState';
import MyPlaceAvatar from '../components/myPlace/MyPlaceAvatar';
import { amIGodmode } from '../data/venueAdmin';
import { AVATARS } from '../data/profileCustomization';
import {
  saveRoomLayout,
  useItemArt,
  useMyHome,
  useMyPlaceCatalog,
  usePlaceOwner,
  useRoomLayout,
} from '../data/myPlace';
import { avatarLook, type MyPlaceItem } from '../lib/myPlace';
import { MY_PLACE_RATIO, MY_PLACE_SLOTS, myPlaceBackdrop } from '../lib/myPlaceSlots';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'MyPlaceLayout'>;

const MAX_WIDTH = 560;

export default function MyPlaceLayoutScreen(_: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  useEffect(() => {
    void amIGodmode().then(setAdmin);
    void currentUserId(supabase).then((id) => setMeId(id ?? null)).catch(() => {});
  }, []);

  const catalog = useMyPlaceCatalog(admin === true);
  const layoutQ = useRoomLayout(admin === true);
  const myHome = useMyHome(admin === true);
  const me = usePlaceOwner(admin ? meId : null);

  // One sample per slot: mine there, else a starter, else the first that fits.
  const baseSamples = useMemo(() => {
    const items = catalog.data?.items ?? [];
    const byId = catalog.data?.byId ?? {};
    const mine = myHome.data?.equipped ?? {};
    const out: Record<string, MyPlaceItem> = {};
    for (const s of MY_PLACE_SLOTS) {
      if (s.kind === 'avatar') continue;
      const own = mine[s.id] ? byId[mine[s.id]] : undefined;
      const fits = items.filter((i) => itemFitsSlot(i, s));
      const pick = own ?? fits.find((i) => i.isStarter) ?? fits[0];
      if (pick) out[s.id] = pick;
    }
    return out;
  }, [catalog.data, myHome.data?.equipped]);

  const art = useItemArt(useMemo(() => Object.values(baseSamples).map((i) => i.id), [baseSamples]));
  const samples = useMemo(() => {
    const out: Record<string, MyPlaceItem> = {};
    for (const [slot, i] of Object.entries(baseSamples)) out[slot] = art[i.id] ? { ...i, svg: art[i.id] } : i;
    return out;
  }, [baseSamples, art]);

  const resolveArt = useMemo(() => createArtResolver(), []);
  const look = useMemo(() => avatarLook(me.data ?? null, AVATARS), [me.data]);
  const renderAvatar = useCallback((box: Box) => <MyPlaceAvatar box={box} look={look} />, [look]);
  const backdrop = useMemo(() => myPlaceBackdrop(samples.wallpaper?.id, samples.floor?.id), [samples]);

  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);

  const onSave = useCallback(
    async (layout: RoomLayout) => {
      await saveRoomLayout(layout);
      toast.success('Layout saved. Every room uses it from their next open.');
    },
    [toast],
  );

  if (admin === null) return <ActivityIndicator style={styles.center} color={c.primary} />;
  if (!admin) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <EmptyState
          iconName="lock"
          title="God mode only"
          subtitle="Only the God mode account moves My Place spots. Players pick what fills each spot from their own My Place."
        />
      </View>
    );
  }
  const err = (!catalog.data && catalog.error) || (!layoutQ.layout && layoutQ.error) || null;
  if (err) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <ErrorState
          iconName="offline"
          error={err}
          message={explainRefusal(err, "Couldn't load the layout. Check your connection and try again.")}
          onRetry={() => {
            void catalog.refresh();
            void layoutQ.refresh();
          }}
        />
      </View>
    );
  }
  if (!catalog.data || layoutQ.loading) return <ActivityIndicator style={styles.center} color={c.primary} />;

  const editorWidth = Math.min(Math.max(0, width - SPACE.lg * 2), MAX_WIDTH);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]} onLayout={onLayout}>
      <Text style={[t.meta, styles.note]}>
        Moves every player's room. Players can't move or resize anything; they only pick what fills each spot.
        {layoutQ.newerVersion ? ' This layout was saved by a newer Pickleague, so it is read-only here: update to edit it.' : ''}
      </Text>
      {editorWidth > 0 ? (
        <RoomLayoutEditor
          admin
          slots={MY_PLACE_SLOTS}
          layout={layoutQ.layout}
          samples={samples}
          resolveArt={resolveArt}
          backdrop={backdrop}
          renderAvatar={renderAvatar}
          width={editorWidth}
          ratio={MY_PLACE_RATIO}
          onSave={onSave}
          saveErrorText={(e) => explainRefusal(e, "Couldn't save the layout, so nothing changed. Check your connection and save again.")}
          style={styles.editor}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignSelf: 'center' },
  note: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md },
  editor: { flex: 1 },
});
