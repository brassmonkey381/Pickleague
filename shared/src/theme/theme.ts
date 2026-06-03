export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * The canonical theme shape shared across apps. Apps supply their own brand
 * palette (values) conforming to this shape via `configureTheme`.
 */
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

/**
 * Neutral fallback palettes. These are only used if a consuming app never calls
 * `configureTheme` (and as the context's initial value). Real apps inject their
 * own brand colors.
 */
export const DEFAULT_LIGHT: Theme = {
  bg:           '#f2f3f5',
  surface:      '#ffffff',
  surfaceAlt:   '#f7f8fa',
  primary:      '#2563eb',
  primaryLight: '#e8efff',
  primaryDark:  '#1d4ed8',
  text:         '#1a1a1a',
  textSub:      '#555555',
  textMuted:    '#999999',
  border:       '#e6e8eb',
  danger:       '#c62828',
  headerBg:     '#2563eb',
  headerText:   '#ffffff',
  headerSub:    'rgba(255,255,255,0.75)',
};

export const DEFAULT_DARK: Theme = {
  bg:           '#0e1116',
  surface:      '#171b21',
  surfaceAlt:   '#1f242c',
  primary:      '#60a5fa',
  primaryLight: '#16202e',
  primaryDark:  '#3b82f6',
  text:         '#f0f0f0',
  textSub:      '#b0b0b0',
  textMuted:    '#666666',
  border:       '#2a3038',
  danger:       '#ef5350',
  headerBg:     '#0e1116',
  headerText:   '#60a5fa',
  headerSub:    'rgba(96,165,250,0.65)',
};
