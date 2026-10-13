// Open the next overlay only after the current RN Modal has gone.
//
// iOS presents one Modal at a time: presenting a second while the first is
// still animating out is silently dropped (the "+" sheet's "Enter code" would
// close the sheet and never show the code form). Android and web stack
// Modals fine, so they run at once. 450ms covers the fade/slide-out.
import { Platform } from 'react-native';

const IOS_DISMISS_MS = 450;

export function afterModalClose(fn: () => void): void {
  if (Platform.OS === 'ios') setTimeout(fn, IOS_DISMISS_MS);
  else fn();
}
