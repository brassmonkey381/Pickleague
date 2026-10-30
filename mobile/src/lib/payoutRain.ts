// Pickle rain for a payout shown in a sheet (kit 1.88 rainReward).
//
// The rain draws in the toast layer, which is above a foundation sheet but
// UNDER a React Native Modal on iOS and Android. So a payout shown inside a
// Modal (the drill review's thanks) rains only once that Modal has fully
// closed (the foundation's useModalDismissed reports the moment), and a
// payout the player takes straight into the share studio is held until the
// studio closes: raining under it would show nothing.
import { Platform } from 'react-native';
import { rainReward } from '@just-messin-around/expo-foundation/ui/rewardRain';

/**
 * After the Modal is reported gone: iOS and web report the real end of the
 * dismissal; Android reports the hide's commit, while its fade still runs.
 */
export const RAIN_AFTER_DISMISS_MS = Platform.OS === 'android' ? 300 : 0;
/** After the share studio's close (it reports no dismissal of its own). */
export const RAIN_AFTER_SHARE_MS = 450;

/** Pickles worth a rain: a whole, positive amount; anything else is 0 (no rain). */
export function rainAmount(earned: number | null | undefined): number {
  return typeof earned === 'number' && Number.isFinite(earned) && earned >= 1 ? Math.floor(earned) : 0;
}

/** Rain for this payout now (nothing for 0, null or an unknown amount). */
export function rainPayout(earned: number | null | undefined, delayMs = 0): void {
  const n = rainAmount(earned);
  if (!n) return;
  if (delayMs > 0) setTimeout(() => rainReward(n), delayMs);
  else rainReward(n);
}

let held = 0;

/** Keep this payout's rain for later (the share studio is opening over it). */
export function holdPayoutRain(earned: number | null | undefined): void {
  held += rainAmount(earned);
}

/** Rain what was held, once (the share studio closed). */
export function releasePayoutRain(delayMs = RAIN_AFTER_SHARE_MS): void {
  const n = held;
  held = 0;
  rainPayout(n, delayMs);
}
