import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_DARK, DEFAULT_LIGHT, Theme, ThemeMode } from './theme';

// ── Module singleton ────────────────────────────────────────────────────────
// The context object is created ONCE in this module so that the package's own UI
// primitives (which call `useTheme`) and the consuming app (which renders
// `ThemeProvider`) share the exact same context instance. The app injects its
// palette + storage key via `configureTheme` (a side-effect at adapter load),
// rather than via a per-call factory which would create a second context and
// silently break `useTheme`.
type ThemeConfig = { light: Theme; dark: Theme; storageKey: string };

let cfg: ThemeConfig = {
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
  storageKey: 'app_theme_mode',
};

/** Inject the app's palette + persistence key. Call once, before render. */
export function configureTheme(next: Partial<ThemeConfig>): void {
  cfg = { ...cfg, ...next };
}

type ThemeContextValue = {
  colors: Theme;
  themeMode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  colors: cfg.light,
  themeMode: 'system',
  isDark: false,
  setThemeMode: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    AsyncStorage.getItem(cfg.storageKey).then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setThemeModeState(v);
    });
  }, []);

  function setThemeMode(mode: ThemeMode) {
    setThemeModeState(mode);
    AsyncStorage.setItem(cfg.storageKey, mode);
  }

  const resolved =
    themeMode === 'system'
      ? systemScheme === 'dark' ? cfg.dark : cfg.light
      : themeMode === 'dark' ? cfg.dark : cfg.light;

  const isDark = resolved === cfg.dark;

  return (
    <ThemeContext.Provider value={{ colors: resolved, themeMode, isDark, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
