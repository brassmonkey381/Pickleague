// The crash screens' fixed colours: Rally light as plain hex, so they render
// even when the theme or the fonts are what broke (no imports on purpose).
import type { CrashPalette } from '@just-messin-around/expo-foundation/ui';

export const PICKLEAGUE_CRASH_PALETTE: CrashPalette = {
  bg: '#fffdf5',
  band: '#e8f03c',
  ink: '#0f3d2a',
  sub: '#4a6458',
  primary: '#0f3d2a',
  primaryInk: '#e8f03c',
  ball: '#f6f9e0',
};

export const CRASH_TITLE = 'That one hit the net';
/** Rally's display face (lib/fonts FONT.lilita). If fonts are what broke, the system font draws it. */
export const CRASH_TITLE_FONT = 'LilitaOne';
export const CRASH_BODY = 'Something went wrong on this screen. Your matches, scores and pickles are safe.';
