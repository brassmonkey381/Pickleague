// My Place's room structure (docs/my-place.md): the 14 anchored slots, in the
// server's sort order. The app's SlotDef[] is the source; home_slots
// (supabase/migration_my_place.sql) mirrors its id / label / kind / fits /
// parent so equip_home_item can check fit and parents, and
// art/my-place/lib.cjs builds the same list from catalog.json for the art
// previews. data/__tests__/myPlaceSlots.test.ts fails when any of the three
// differ.
//
// Players never move, resize or arrange anything (Brian, 2026-10-27). Each
// slot's `default` is the seeded admin layout (catalog.json defaultLayout);
// the God mode account's saved room_layout wins over it.
//
// PURE (type imports only), so vitest reads it.
import type { SlotDef } from '@just-messin-around/expo-foundation/room/layout';
import type { RoomBackdropOptions } from '@just-messin-around/expo-foundation/room/art';

/** height / width of the room, the same as the art previews and the admin editor. */
export const MY_PLACE_RATIO = 0.72;
/** Where the floor starts, a fraction of the room's height (Doggle's 0.62). */
export const MY_PLACE_FLOOR_LINE = 0.62;

export const MY_PLACE_SLOTS: readonly SlotDef[] = [
  { id: 'wallpaper', label: 'Wallpaper', kind: 'backdrop', fits: 'wallpaper', aspect: 1 },
  { id: 'floor', label: 'Floor', kind: 'backdrop', fits: 'floor', aspect: 2 },
  {
    id: 'rug', label: 'Rug', kind: 'wide', fits: 'rug', aspect: 3,
    default: { kind: 'wide', cx: 0.5, top: 0.72, w: 0.56, ar: 3, z: -1 }, drawOrder: -1,
  },
  {
    id: 'window', label: 'Window', kind: 'free', fits: 'window', aspect: 0.9,
    default: { kind: 'free', cx: 0.16, top: 0.08, w: 0.19, z: 1 }, drawOrder: 1,
  },
  {
    id: 'wall_art', label: 'Wall art', kind: 'free', fits: 'wall_art', aspect: 0.8,
    default: { kind: 'free', cx: 0.5, top: 0.2, w: 0.14, z: 2 }, drawOrder: 2,
  },
  {
    id: 'paddle_rack', label: 'Paddle rack', kind: 'free', fits: 'paddle_rack', aspect: 1.25,
    default: { kind: 'free', cx: 0.84, top: 0.1, w: 0.18, z: 2 }, drawOrder: 2,
  },
  {
    id: 'ceiling', label: 'Ceiling', kind: 'free', fits: 'ceiling', aspect: 4,
    default: { kind: 'free', cx: 0.5, top: 0, w: 0.5, z: 3 }, drawOrder: 3,
  },
  {
    id: 'shelf', label: 'Shelf', kind: 'furniture', fits: 'shelf', aspect: 0.9,
    default: { kind: 'furniture', cx: 0.83, bottom: 0.78, w: 0.17, z: 5 }, drawOrder: 5,
  },
  {
    id: 'shelf_item', label: 'Shelf top', kind: 'prop', fits: 'shelf_item', parent: 'shelf', aspect: 1,
    default: { kind: 'prop', u: 0.5, surface: 0.05, scale: 0.45, z: 6 }, drawOrder: 6,
  },
  {
    id: 'couch', label: 'Couch', kind: 'furniture', fits: 'couch', aspect: 2,
    default: { kind: 'furniture', cx: 0.5, bottom: 0.88, w: 0.46, z: 8 }, drawOrder: 8,
  },
  {
    id: 'couch_pillow', label: 'Couch pillow', kind: 'prop', fits: 'couch_pillow', parent: 'couch', aspect: 1.2,
    default: { kind: 'prop', u: 0.27, surface: 0.55, scale: 0.2, z: 9 }, drawOrder: 9,
  },
  {
    id: 'accent', label: 'Corner', kind: 'floor', fits: 'accent', aspect: 0.75,
    default: { kind: 'floor', u: 0.08, baseY: 0.84, scale: 0.12, z: 7 }, drawOrder: 7,
  },
  {
    id: 'accent2', label: 'Second corner', kind: 'floor', fits: 'accent', aspect: 0.75,
    default: { kind: 'floor', u: 0.93, baseY: 0.97, scale: 0.12, z: 12, flip: true }, drawOrder: 12,
  },
  {
    id: 'avatar', label: 'You', kind: 'avatar', fits: 'avatar', aspect: 0.8,
    default: { kind: 'avatar', cx: 0.2, bottom: 0.98, w: 0.13, z: 1000 }, drawOrder: 1000,
  },
];

/** The slot players pick decor for (every slot but the avatar's). */
export const MY_PLACE_DECOR_SLOTS: readonly SlotDef[] = MY_PLACE_SLOTS.filter((s) => s.kind !== 'avatar');

/** The room with nothing on the walls or floor yet (Doggle's plain room). */
export const MY_PLACE_BASE_BACKDROP: RoomBackdropOptions = {
  wallTop: '#f5f1e6',
  wallBottom: '#efe7d4',
  floorFill: '#d9b07a',
  floorAccent: '#b88a5a',
  floorPattern: 'boards',
  floorLine: MY_PLACE_FLOOR_LINE,
};

/**
 * Each wallpaper / floor item's colours (catalog.json backdrop_opts), painted
 * under its tiles: the room keeps the right colours while the tile art loads,
 * or if it never does. An item missing here (a newer catalog) uses the base.
 */
export const MY_PLACE_BACKDROP_COLORS: Readonly<Record<string, Partial<RoomBackdropOptions>>> = {
  wall_cream: { wallTop: '#f5f1e6', wallBottom: '#efe7d4' },
  wall_net_print: { wallTop: '#e8f5e9', wallBottom: '#d7ecd8' },
  wall_night_court: { wallTop: '#24334f', wallBottom: '#2f4266' },
  floor_maple: { floorFill: '#d9b07a', floorAccent: '#b88a5a', floorPattern: 'boards' },
  floor_court_blue: { floorFill: '#5b8fd4', floorAccent: '#ffffff', floorPattern: 'plain' },
  floor_herringbone: { floorFill: '#a9794d', floorAccent: '#8a6f55', floorPattern: 'boards' },
};

/** The backdrop under the tiles for what is on the wall and the floor. */
export function myPlaceBackdrop(wallpaperId: string | null | undefined, floorId: string | null | undefined): RoomBackdropOptions {
  const wall = (wallpaperId && MY_PLACE_BACKDROP_COLORS[wallpaperId]) || {};
  const floor = (floorId && MY_PLACE_BACKDROP_COLORS[floorId]) || {};
  return {
    ...MY_PLACE_BASE_BACKDROP,
    wallTop: wall.wallTop ?? MY_PLACE_BASE_BACKDROP.wallTop,
    wallBottom: wall.wallBottom ?? MY_PLACE_BASE_BACKDROP.wallBottom,
    floorFill: floor.floorFill ?? MY_PLACE_BASE_BACKDROP.floorFill,
    floorAccent: floor.floorAccent ?? MY_PLACE_BASE_BACKDROP.floorAccent,
    floorPattern: floor.floorPattern ?? MY_PLACE_BASE_BACKDROP.floorPattern,
  };
}
