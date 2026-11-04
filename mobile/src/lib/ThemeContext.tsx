// The theme context now lives in @just-messin-around/expo-foundation as a module singleton.
// This adapter injects the Pickleague palette + storage key, then re-exports the
// foundation's ThemeProvider/useTheme so all existing consumers
// (`import { useTheme } from '../lib/ThemeContext'`) are unchanged AND share the
// exact same context instance the foundation's own UI primitives use.
import { configureTheme } from '@just-messin-around/expo-foundation/theme';
import { LIGHT, DARK } from './theme';
import { SKINS, DEFAULT_SKIN } from './skins';
// Side effect: registers Pickleague's glyphs (pickle, pickleball, paddle, shot
// arcs) and turns on glyphs for emoji icon props, before anything renders.
import './glyphs';

// LIGHT/DARK are only the fallback: the active look (Settings, Look) supplies
// the palettes. The look is saved as 'pickleague_theme_mode_skin'.
configureTheme({ light: LIGHT, dark: DARK, storageKey: 'pickleague_theme_mode', skins: SKINS, defaultSkin: DEFAULT_SKIN });

export { ThemeProvider, useTheme } from '@just-messin-around/expo-foundation/theme';
