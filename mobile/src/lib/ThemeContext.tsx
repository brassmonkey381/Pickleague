// The theme context now lives in @just-messin-around/expo-foundation as a module singleton.
// This adapter injects the Pickleague palette + storage key, then re-exports the
// foundation's ThemeProvider/useTheme so all existing consumers
// (`import { useTheme } from '../lib/ThemeContext'`) are unchanged AND share the
// exact same context instance the foundation's own UI primitives use.
import { configureTheme } from '@just-messin-around/expo-foundation/theme';
import { LIGHT, DARK } from './theme';

configureTheme({ light: LIGHT, dark: DARK, storageKey: 'pickleague_theme_mode' });

export { ThemeProvider, useTheme } from '@just-messin-around/expo-foundation/theme';
