// Display and number faces for the four looks (lib/skins). Each is one weight,
// registered under its own family name, because a custom family can't borrow a
// bold from fontWeight on iOS. Body text stays the system font for now.
import { useEffect, useState } from 'react';
import * as Font from 'expo-font';
import { primeThemeMode } from '@just-messin-around/expo-foundation/theme';
import { LilitaOne_400Regular } from '@expo-google-fonts/lilita-one/400Regular';
import { BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed/700Bold';
import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { SairaCondensed_700Bold } from '@expo-google-fonts/saira-condensed/700Bold';
import { IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono/600SemiBold';

export const FONT = {
  lilita: 'LilitaOne',
  barlowCondensed: 'BarlowCondensed-Bold',
  fraunces: 'Fraunces-SemiBold',
  sairaCondensed: 'SairaCondensed-Bold',
  plexMono: 'IBMPlexMono-SemiBold',
} as const;

const SOURCES = {
  [FONT.lilita]: LilitaOne_400Regular,
  [FONT.barlowCondensed]: BarlowCondensed_700Bold,
  [FONT.fraunces]: Fraunces_600SemiBold,
  [FONT.sairaCondensed]: SairaCondensed_700Bold,
  [FONT.plexMono]: IBMPlexMono_600SemiBold,
};

// A slow or failed font load must never hold the app: after this long we
// render anyway and the faces swap in when they land.
const BOOT_WAIT_MS = 1500;

/**
 * True once the look's fonts and the saved mode + look are loaded (or the wait
 * ran out), so the first frame is drawn in the person's own look.
 */
export function useBootLook(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        setReady(true);
      }
    };
    const timer = setTimeout(finish, BOOT_WAIT_MS);
    Promise.all([Font.loadAsync(SOURCES).catch(() => undefined), primeThemeMode()]).then(finish, finish);
    return () => clearTimeout(timer);
  }, []);
  return ready;
}
