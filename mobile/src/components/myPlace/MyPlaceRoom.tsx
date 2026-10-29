// One My Place room: the kit's RoomScene with Pickleague's slots, the admin
// layout, what is equipped, the player's avatar in the avatar slot, and the
// wallpaper / floor items tiled across the wall and the floor.
//
// Read-only for visitors. In my own room (`onPressSlot`), every decor slot is
// a touch target on its anchor (front-most on top), empty ones marked with a
// dashed "+", and the bare wall / floor open Wallpaper / Floor. Tapping never
// moves anything: slots are anchored (only the God mode layout moves them).
import React, { useMemo } from 'react';
import { View, Pressable, StyleSheet, Text } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { RoomScene } from '@just-messin-around/expo-foundation/room';
import {
  buildBackdrop,
  type RoomArtResolver,
} from '@just-messin-around/expo-foundation/room/art';
import {
  emptyParentSlot,
  roomFrame,
  slotBox,
  zOf,
  type Box,
  type RoomLayout,
  type SlotDef,
} from '@just-messin-around/expo-foundation/room/layout';
import type { RoomItem } from '@just-messin-around/expo-foundation/room/shop';
import { RADIUS } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { tileGrid, type AvatarLook } from '../../lib/myPlace';
import { MY_PLACE_FLOOR_LINE, MY_PLACE_SLOTS, myPlaceBackdrop } from '../../lib/myPlaceSlots';
import MyPlaceAvatar from './MyPlaceAvatar';

type Props = {
  width: number;
  layout: RoomLayout | null;
  /** slotId -> item drawn there (saved + any preview). Stable (useMemo). */
  items: Readonly<Record<string, RoomItem | null | undefined>>;
  resolveArt: RoomArtResolver;
  avatar: AvatarLook | null;
  /** Spoken name of the room ("Brian's place"). */
  label: string;
  /** My own room: tap a slot to decorate it. Absent for a visit. */
  onPressSlot?: (slotId: string) => void;
  /** The slot the decor sheet is open on (outlined). */
  activeSlot?: string | null;
};

const RATIO = 0.72;
/** Tiles per row across the room (catalog.json backdrops: about a quarter of the width each). */
const TILES_ACROSS = 4;

export default function MyPlaceRoom({ width, layout, items, resolveArt, avatar, label, onPressSlot, activeSlot }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const height = Math.round(width * RATIO);

  const renderBackdrop = useMemo(
    () => (W: number, H: number, bd: Readonly<Record<string, RoomItem | null>>) => (
      <Backdrop W={W} H={H} wallpaper={bd.wallpaper ?? null} floor={bd.floor ?? null} resolveArt={resolveArt} />
    ),
    [resolveArt],
  );

  const renderAvatar = useMemo(
    () => (avatar ? (box: Box) => <MyPlaceAvatar box={box} look={avatar} label={label} /> : undefined),
    [avatar, label],
  );

  const targets = useMemo(() => {
    if (!onPressSlot) return [];
    const f = roomFrame(MY_PLACE_SLOTS, layout, width, height, (id) => items[id]?.aspect ?? null);
    return MY_PLACE_SLOTS.filter((s) => s.kind !== 'backdrop' && s.kind !== 'avatar')
      .filter((s) => !emptyParentSlot(MY_PLACE_SLOTS, s.id, items))
      .map((s) => ({ slot: s, box: slotBox(f, s.id), z: zOf(f, s.id), filled: !!items[s.id] }))
      .filter((t): t is { slot: SlotDef; box: Box; z: number; filled: boolean } => !!t.box)
      .sort((a, b) => a.z - b.z);
  }, [onPressSlot, layout, width, height, items]);

  const floorTop = height * MY_PLACE_FLOOR_LINE;

  return (
    <RoomScene
      width={width}
      height={height}
      slots={MY_PLACE_SLOTS}
      layout={layout}
      equipped={items}
      resolveArt={resolveArt}
      renderAvatar={renderAvatar}
      renderBackdrop={renderBackdrop}
      radius={RADIUS.lg}
      accessibilityLabel={label}
    >
      {onPressSlot ? (
        <>
          <Pressable
            style={[styles.abs, { left: 0, top: 0, width, height: floorTop }]}
            onPress={() => onPressSlot('wallpaper')}
            accessibilityRole="button"
            accessibilityLabel="Wallpaper. Change it"
          />
          <Pressable
            style={[styles.abs, { left: 0, top: floorTop, width, height: height - floorTop }]}
            onPress={() => onPressSlot('floor')}
            accessibilityRole="button"
            accessibilityLabel="Floor. Change it"
          />
          {targets.map(({ slot, box, filled }) => {
            const on = activeSlot === slot.id;
            return (
              <Pressable
                key={slot.id}
                onPress={() => onPressSlot(slot.id)}
                accessibilityRole="button"
                accessibilityLabel={`${slot.label}. ${filled ? 'Change it' : 'Empty, add something'}`}
                hitSlop={4}
                style={[
                  styles.abs,
                  styles.target,
                  { left: box.left, top: box.top, width: Math.max(box.width, 24), height: Math.max(box.height, 24) },
                  !filled && { borderColor: c.textMuted, borderStyle: 'dashed', borderWidth: 1.5, backgroundColor: `${c.surface}2E` /* surface at 18% */ },
                  on && { borderColor: c.primary, borderStyle: 'solid', borderWidth: 2 },
                ]}
              >
                {!filled ? <Text style={[t.h3, styles.plus, { color: c.textSub }]}>+</Text> : null}
              </Pressable>
            );
          })}
        </>
      ) : null}
    </RoomScene>
  );
}

/**
 * The wall and floor: the base colours for what's equipped (so the room reads
 * right before the art loads), the item tiles over them, then the kit's
 * baseboard seam, floor shadow and vignette on top. An item with no readable
 * art keeps the base colours (never a wall of question marks).
 */
function Backdrop({
  W,
  H,
  wallpaper,
  floor,
  resolveArt,
}: {
  W: number;
  H: number;
  wallpaper: RoomItem | null;
  floor: RoomItem | null;
  resolveArt: RoomArtResolver;
}) {
  const base = useMemo(
    () => buildBackdrop(W, H, myPlaceBackdrop(wallpaper?.id, floor?.id)),
    [W, H, wallpaper?.id, floor?.id],
  );
  const floorTop = H * MY_PLACE_FLOOR_LINE;
  const wallArt = wallpaper ? resolveArt(wallpaper) : null;
  const floorArt = floor ? resolveArt(floor) : null;
  const overlay = useMemo(() => shadingOverlay(W, H, floorTop), [W, H, floorTop]);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <SvgXml xml={base} width={W} height={H} />
      {wallArt && wallArt.source !== 'placeholder' ? (
        <Tiles xml={wallArt.xml} aspect={wallArt.aspect ?? wallpaper?.aspect ?? 1} top={0} W={W} bandH={floorTop} />
      ) : null}
      {floorArt && floorArt.source !== 'placeholder' ? (
        <Tiles xml={floorArt.xml} aspect={floorArt.aspect ?? floor?.aspect ?? 2} top={floorTop} W={W} bandH={H - floorTop} />
      ) : null}
      <View style={StyleSheet.absoluteFill}>
        <SvgXml xml={overlay} width={W} height={H} />
      </View>
    </View>
  );
}

/** Memoized: a preview elsewhere in the room must not re-parse every tile. */
const Tiles = React.memo(function Tiles({ xml, aspect, top, W, bandH }: { xml: string; aspect: number; top: number; W: number; bandH: number }) {
  const g = tileGrid(W, bandH, W / TILES_ACROSS, aspect);
  const cells: React.ReactNode[] = [];
  for (let r = 0; r < g.rows; r++) {
    for (let col = 0; col < g.cols; col++) {
      cells.push(
        // +0.5 px overlap so no hairline shows between tiles.
        <View key={`${r}:${col}`} style={{ position: 'absolute', left: col * g.w, top: r * g.h }}>
          <SvgXml xml={xml} width={g.w + 0.5} height={g.h + 0.5} />
        </View>,
      );
    }
  }
  return <View style={{ position: 'absolute', left: 0, top, width: W, height: bandH, overflow: 'hidden' }}>{cells}</View>;
});

/** The kit's buildBackdrop shading (seam, floor shadow, vignette) alone, to lay over the tiles. */
function shadingOverlay(W: number, H: number, floorTop: number): string {
  const floorH = H - floorTop;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
    `<linearGradient id="fs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.2"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient>` +
    `<radialGradient id="vg" cx="0.5" cy="0.42" r="0.75"><stop offset="0.55" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.14"/></radialGradient>` +
    `</defs>` +
    `<rect x="0" y="${floorTop - H * 0.012}" width="${W}" height="${H * 0.012}" fill="#000000" opacity="0.12"/>` +
    `<rect x="0" y="${floorTop}" width="${W}" height="${floorH * 0.28}" fill="url(#fs)"/>` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#vg)"/>` +
    `</svg>`
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  target: { borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  plus: { fontWeight: '800' },
});
