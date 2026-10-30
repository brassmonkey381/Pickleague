// Captures a referral code from the launch / deep-link URL (/invite/CODE or
// ?ref=CODE), keeps it on the device until there is an account, and claims it
// after sign-in; with no code in hand it asks the deferred matcher once for a
// fresh account (a link tapped in a browser before the app was installed).
// Doggle's ReferralHost, on the foundation's referral kit. Renders nothing.
// AppNavigator mounts it only while REFERRALS_ENABLED is on.
import { useReferralCapture } from '@just-messin-around/expo-foundation/referrals';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../lib/useToast';
import { REFERRALS_ENABLED } from '../../lib/features';
import { claimRainPickles, claimToastText, keepReferralForLater } from '../../lib/referralRules';
import { rainPayout } from '../../lib/payoutRain';
import { claimReferral, deferredInvites, referralStash } from '../../data/referrals';

export default function ReferralHost() {
  const toast = useToast();
  useReferralCapture({
    enabled: REFERRALS_ENABLED,
    supabase,
    stash: referralStash,
    deferred: deferredInvites,
    claim: claimReferral,
    // A guest is refused until it upgrades; the code then also rides in on the
    // new email's metadata (UpgradeAccountScreen), so either path pays.
    keepStash: keepReferralForLater,
    onResult: (result) => {
      const text = claimToastText(result);
      if (text) toast.success(text);
      // Paid just now: the pickles rain (an earlier claim's pay already did).
      rainPayout(claimRainPickles(result));
    },
  });
  return null;
}
