// Open the next overlay only after the current RN Modal has gone.
//
// iOS presents one Modal at a time: presenting a second while the first is
// still animating out is silently dropped. Android and web stack Modals fine,
// so they run at once. 450ms covers the fade/slide-out.
//
// An ActionSheetModal doesn't need this: open the follow-up from its
// `onDismissed` (the Play "+" sheets do). Still used where the closing Modal
// reports no "fully closed" moment: the Filters sheet (Leagues' invite-code
// deep link) and the location confirm (DistanceFilterGroup).
// FOUNDATION-TODO: `onDismissed` on BottomSheet / FilterSheet and ConfirmModal
// / LocationUseConfirmModal (same dismissStrategy latch as ActionSheetModal),
// then delete this file.
import { Platform } from 'react-native';

const IOS_DISMISS_MS = 450;

export function afterModalClose(fn: () => void): void {
  if (Platform.OS === 'ios') setTimeout(fn, IOS_DISMISS_MS);
  else fn();
}
