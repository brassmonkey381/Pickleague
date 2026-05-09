export type ThemeMode = 'light' | 'dark' | 'system';

export type Theme = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  primary: string;
  primaryLight: string;
  primaryDark: string;
  text: string;
  textSub: string;
  textMuted: string;
  border: string;
  danger: string;
  headerBg: string;
  headerText: string;
  headerSub: string;
};

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
  headerBg:     '#0d1a0d',
  headerText:   '#66bb6a',
  headerSub:    'rgba(102,187,106,0.65)',
};
