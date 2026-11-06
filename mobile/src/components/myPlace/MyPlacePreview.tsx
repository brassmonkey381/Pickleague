// My own room, read-only, under the Profile tabs (the user, 2026-11-04: "I
// want people to see their place here!", on all three tabs). The same scene
// MyPlaceScreen draws (MyPlaceRoom with no onPressSlot, so nothing in it is
// tappable on its own); a tap anywhere opens My Place to edit it. Before the
// starter set is claimed it says so and the tap sets it up there. While my
// avatar is staying at a friend's place it isn't in the room; friends staying
// over are (migration_place_stays.sql).
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type LayoutChangeEvent } from 'react-native';
import { createArtResolver } from '@just-messin-around/expo-foundation/room/art';
import { Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import MyPlaceRoom from './MyPlaceRoom';
import { AVATARS } from '../../data/profileCustomization';
import { useItemArt, useMyHome, useMyPlaceCatalog, usePlaceOwner, useRoomLayout } from '../../data/myPlace';
import { avatarLook, sceneItems, type MyPlaceItem } from '../../lib/myPlace';
import { usePlaceStays } from '../../data/placeStays';

type Props = {
  userId: string;
  onOpen: () => void;
};

const EMPTY: Readonly<Record<string, string>> = {};

export default function MyPlacePreview({ userId, onOpen }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const catalog = useMyPlaceCatalog();
  const layoutQ = useRoomLayout();
  const home = useMyHome(true);
  const owner = usePlaceOwner(userId);

  const equipped = (home.data?.equipped ?? EMPTY) as Readonly<Record<string, string>>;
  const art = useItemArt(useMemo(() => Object.values(equipped), [equipped]));
  const byId = useMemo(() => {
    const out: Record<string, MyPlaceItem> = {};
    for (const i of catalog.data?.items ?? []) {
      const svg = art[i.id];
      out[i.id] = svg && svg !== i.svg ? { ...i, svg } : i;
    }
    return out;
  }, [catalog.data, art]);
  const items = useMemo(() => sceneItems(equipped, byId), [equipped, byId]);
  const resolveArt = useMemo(() => createArtResolver(), []);
  const look = useMemo(() => avatarLook(owner.data ?? null, AVATARS), [owner.data]);
  const stays = usePlaceStays(null);
  const away = !!stays.data?.away;
  const guests = useMemo(
    () => (stays.data?.guests ?? []).map((g) => ({ key: g.visitorId, look: avatarLook(g, AVATARS), name: g.name })),
    [stays.data],
  );

  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);

  const unclaimed = home.data != null && !home.data.starterClaimed;

  return (
    <View style={S.block}>
      <SectionHeader title="My Place" size="title" action={{ label: 'Edit', onPress: onOpen, a11yLabel: 'Edit my place' }} />
      <TouchableOpacity activeOpacity={0.9} onPress={onOpen} accessibilityRole="button" accessibilityLabel="Your room. Open My Place to edit it">
        <Panel padded={false} style={S.card}>
          <View onLayout={onLayout}>
            {unclaimed ? (
              <View style={S.empty}>
                <Text style={t.title}>Your place is waiting</Text>
                <Text style={t.sub}>Tap to set it up with the starter set.</Text>
              </View>
            ) : width > 0 ? (
              // pointerEvents none: the card's tap opens My Place; slots don't take touches here.
              <View pointerEvents="none">
                <MyPlaceRoom
                  width={width}
                  layout={layoutQ.layout}
                  items={items}
                  resolveArt={resolveArt}
                  avatar={away ? null : look}
                  guests={guests}
                  label="Your room"
                />
              </View>
            ) : null}
          </View>
        </Panel>
      </TouchableOpacity>
    </View>
  );
}

const S = StyleSheet.create({
  block: { marginTop: SPACE.lg },
  card: { overflow: 'hidden' },
  empty: { padding: SPACE.lg, gap: SPACE.xs },
});
