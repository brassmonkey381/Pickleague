// The four looks people can pick in Settings (Look), each with a light and a
// dark palette. Rally is the default. Colours come from the look picker the
// redesign was chosen in; status colours (danger, success, rarity, medals) stay
// the app's own across every look. Kept out of lib/theme so the vitest suites
// that import LIGHT/DARK never load images or fonts.
import type { Skin, Theme, ThemeParts } from '@just-messin-around/expo-foundation/theme';
import { LIGHT, DARK } from './theme';
import { FONT } from './fonts';

type Tokens = {
  bg: string; surface: string; surfaceAlt: string;
  ink: string; sub: string; muted: string;
  primary: string; primaryDark: string; primaryInk: string;
  band: string; bandInk: string; line: string; tint: string; edge: string;
  highlight: string; onHighlight: string;
  /** Text on the primary button when it differs from primaryInk. */
  buttonInk?: string;
};

// The shared parts as picked in round 2, the same in every look; each look's
// colours, corners and fonts make them its own.
const PARTS: ThemeParts = {
  card: 'raised',
  button: 'sticker',
  chip: 'tag',
  segments: 'track',
  sheet: 'band',
  sectionHeader: 'marker',
  toast: 'sticker',
  empty: 'ball',
  titleFont: 'body',
};

type Look = {
  display: string; number: string;
  radii: { card: number; button: number; chip: number; sheet: number };
  texture: unknown;
};

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function palette(base: Theme, t: Tokens, look: Look): Theme {
  return {
    ...base,
    bg: t.bg,
    surface: t.surface,
    surfaceAlt: t.surfaceAlt,
    primary: t.primary,
    primaryLight: t.tint,
    primaryDark: t.primaryDark,
    text: t.ink,
    textSub: t.sub,
    textMuted: t.muted,
    border: t.line,
    textInverse: t.primaryInk,
    primaryInk: t.buttonInk ?? t.primaryInk,
    headerBg: t.band,
    headerText: t.bandInk,
    headerSub: hexAlpha(t.bandInk, 0.72),
    edge: t.edge,
    highlight: t.highlight,
    onHighlight: t.onHighlight,
    fontFamilyDisplay: look.display,
    fontFamilyNumber: look.number,
    radiusCard: look.radii.card,
    radiusButton: look.radii.button,
    radiusChip: look.radii.chip,
    radiusSheet: look.radii.sheet,
    texture: look.texture,
    parts: PARTS,
  };
}

function skin(id: string, label: string, look: Look, light: Tokens, dark: Tokens): Skin {
  return { id, label, light: palette(LIGHT, light, look), dark: palette(DARK, dark, look) };
}

// Text on filled success/danger controls in the light looks stays white
// (primaryInk); the primary button's own ink (buttonInk) is the look's yellow
// where the picker had it.
export const SKINS: Skin[] = [
  skin('rally', 'Rally', {
    display: FONT.lilita, number: FONT.lilita,
    radii: { card: 18, button: 14, chip: 8, sheet: 24 },
    texture: require('../../assets/textures/rally-holes.png'),
  }, {
    bg: '#fffdf5', surface: '#ffffff', surfaceAlt: '#fffefa',
    ink: '#0f3d2a', sub: '#4a6458', muted: '#60766b',
    primary: '#0f3d2a', primaryDark: '#0b2e20', primaryInk: '#ffffff', buttonInk: '#e8f03c',
    band: '#e8f03c', bandInk: '#0f3d2a', line: '#d9dfc4', tint: '#f1f6c4', edge: '#0f3d2a',
    highlight: '#e8f03c', onHighlight: '#0f3d2a',
  }, {
    bg: '#0c1f17', surface: '#13301f', surfaceAlt: '#10281b',
    ink: '#f6f9e6', sub: '#b4c7b9', muted: '#85988c',
    primary: '#e8f03c', primaryDark: '#c5cc33', primaryInk: '#0c1f17',
    band: '#e8f03c', bandInk: '#0f3d2a', line: '#2c5a43', tint: '#1b3a28', edge: '#e8f03c',
    highlight: '#e8f03c', onHighlight: '#0f3d2a',
  }),
  skin('court', 'Court', {
    display: FONT.barlowCondensed, number: FONT.barlowCondensed,
    radii: { card: 10, button: 8, chip: 6, sheet: 14 },
    texture: require('../../assets/textures/court-lines.png'),
  }, {
    bg: '#eef1ea', surface: '#ffffff', surfaceAlt: '#f7f8f5',
    ink: '#14231a', sub: '#56645b', muted: '#626f66',
    primary: '#2f6b45', primaryDark: '#235034', primaryInk: '#ffffff',
    band: '#2f6b45', bandInk: '#ffffff', line: '#dce2d8', tint: '#e3eee5', edge: '#14231a',
    highlight: '#2c5d8f', onHighlight: '#ffffff',
  }, {
    bg: '#0e1712', surface: '#16231b', surfaceAlt: '#121d17',
    ink: '#e8efe9', sub: '#9db0a3', muted: '#7e8e83',
    primary: '#6fbf8a', primaryDark: '#5ea275', primaryInk: '#0e1712',
    band: '#1c4a30', bandInk: '#ffffff', line: '#263a2d', tint: '#1b2f23', edge: '#6fbf8a',
    highlight: '#7fb0e0', onHighlight: '#0e1712',
  }),
  skin('clubhouse', 'Clubhouse', {
    display: FONT.fraunces, number: FONT.fraunces,
    radii: { card: 4, button: 3, chip: 3, sheet: 6 },
    texture: require('../../assets/textures/clubhouse-linen.png'),
  }, {
    bg: '#f5efe2', surface: '#fffcf5', surfaceAlt: '#faf6ec',
    ink: '#1c1f1a', sub: '#5e5a4e', muted: '#6d695d',
    primary: '#1f4a33', primaryDark: '#173826', primaryInk: '#f5efe2',
    band: '#1f4a33', bandInk: '#f5efe2', line: '#e4dac6', tint: '#ede4d0', edge: '#1f4a33',
    highlight: '#a87a2c', onHighlight: '#fffcf5',
  }, {
    bg: '#15140f', surface: '#1f1d16', surfaceAlt: '#1a1913',
    ink: '#efe7d6', sub: '#a89f8a', muted: '#8e8674',
    primary: '#8fbf9e', primaryDark: '#7aa286', primaryInk: '#15140f',
    band: '#1f4a33', bandInk: '#f5efe2', line: '#353126', tint: '#2a271e', edge: '#d4a55a',
    highlight: '#d4a55a', onHighlight: '#15140f',
  }),
  skin('night', 'Night session', {
    display: FONT.sairaCondensed, number: FONT.plexMono,
    radii: { card: 6, button: 4, chip: 4, sheet: 8 },
    texture: require('../../assets/textures/night-mesh.png'),
  }, {
    bg: '#eef2ec', surface: '#ffffff', surfaceAlt: '#f7f9f6',
    ink: '#0b1a0d', sub: '#4c5e50', muted: '#5f7063',
    primary: '#133a22', primaryDark: '#0e2c1a', primaryInk: '#ffffff', buttonInk: '#d8e84a',
    band: '#0b1a0d', bandInk: '#e9f2e9', line: '#d5ded4', tint: '#e1eada', edge: '#0b1a0d',
    highlight: '#d8e84a', onHighlight: '#0b1a0d',
  }, {
    bg: '#0b1a0d', surface: '#112515', surfaceAlt: '#0e2011',
    ink: '#e9f2e9', sub: '#93a897', muted: '#7b8e7e',
    primary: '#d8e84a', primaryDark: '#b8c53f', primaryInk: '#0b1a0d',
    band: '#071209', bandInk: '#e9f2e9', line: '#1f3a26', tint: '#163a22', edge: '#d8e84a',
    highlight: '#d8e84a', onHighlight: '#0b1a0d',
  }),
];

export const DEFAULT_SKIN = 'rally';
