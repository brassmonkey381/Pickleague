import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DARK, LIGHT, Theme, ThemeMode } from './theme';

type ThemeContextValue = {
  colors: Theme;
  themeMode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  colors: LIGHT,
  themeMode: 'system',
  isDark: false,
  setThemeMode: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    AsyncStorage.getItem('pickleague_theme_mode').then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setThemeModeState(v);
    });
  }, []);

  function setThemeMode(mode: ThemeMode) {
    setThemeModeState(mode);
    AsyncStorage.setItem('pickleague_theme_mode', mode);
  }

  const resolved =
    themeMode === 'system'
      ? systemScheme === 'dark' ? DARK : LIGHT
      : themeMode === 'dark' ? DARK : LIGHT;

  const isDark = resolved === DARK;

  return (
    <ThemeContext.Provider value={{ colors: resolved, themeMode, isDark, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
