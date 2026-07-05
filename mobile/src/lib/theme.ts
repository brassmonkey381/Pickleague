// The Theme/ThemeMode shape now lives in @just-messin-around/expo-foundation (single source
// of truth shared with the foundation's UI primitives). This file keeps the
// Pickleague brand palette and re-exports the types, so all existing
// `import { Theme, ThemeMode, LIGHT, DARK } from '../lib/theme'` call sites work.
import type { Theme } from '@just-messin-around/expo-foundation/theme';

export type { Theme, ThemeMode } from '@just-messin-around/expo-foundation/theme';

export const LIGHT: Theme = {
  bg:           '#eef2ee',
  surface:      '#ffffff',
  surfaceAlt:   '#f8faf8',
  primary:      '#2e7d32',
  primaryLight: '#e8f5e9',
  primaryDark:  '#1b5e20',
  text:         '#1a1a1a',
  textSub:      '#555555',
  textMuted:    '#999999',
  border:       '#e8e8e8',
  danger:       '#c62828',
  dangerLight:  '#fbe7e5',
  dangerDark:   '#b33a33',
  success:      '#2e9e5b',
  successLight: '#e3f5ea',
  warning:      '#e0871e',
  warningLight: '#fbeed6',
  info:         '#1f9bb3',
  infoLight:    '#def1f5',
  rarityRare:          '#7c3aed',
  rarityRareLight:     '#f1e9fe',
  rarityLegendary:     '#ca8a04',
  rarityLegendaryLight:'#fdf3d7',
  textInverse:  '#ffffff',
  backdrop:     'rgba(0,0,0,0.5)',
  headerBg:     '#2e7d32',
  headerText:   '#ffffff',
  headerSub:    'rgba(255,255,255,0.75)',
};

export const DARK: Theme = {
  bg:           '#0d1a0d',
  surface:      '#182418',
  surfaceAlt:   '#1f2e1f',
  primary:      '#66bb6a',
  primaryLight: '#1a2e1a',
  primaryDark:  '#4caf50',
  text:         '#f0f0f0',
  textSub:      '#b0b0b0',
  textMuted:    '#666666',
  border:       '#2a3d2a',
  danger:       '#ef5350',
  dangerLight:  '#3a1f1d',
  dangerDark:   '#c75049',
  success:      '#46c07e',
  successLight: '#143020',
  warning:      '#f0a23a',
  warningLight: '#33240c',
  info:         '#4fc3d6',
  infoLight:    '#0f2a31',
  rarityRare:          '#a78bfa',
  rarityRareLight:     '#2a1f47',
  rarityLegendary:     '#eab308',
  rarityLegendaryLight:'#332908',
  textInverse:  '#ffffff',
  backdrop:     'rgba(0,0,0,0.6)',
  headerBg:     '#0d1a0d',
  headerText:   '#66bb6a',
  headerSub:    'rgba(102,187,106,0.65)',
};
