// Profile's "Invite & Earn" (Doggle's ReferralStatsSection + InviteFriendsPanel):
// counters, the reward, the player's code and link, Share, Copy link and a QR.
// Renders nothing while REFERRALS_ENABLED is off (no fetches) and for a guest
// (who has to save the account first; a guest's own code would work, but its
// rewards would land on an account that may expire).
import React, { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { CollapsibleSection } from '@just-messin-around/expo-foundation/ui';
import { InviteEarnPanel } from '@just-messin-around/expo-foundation/referrals';
import { cachedFetch, useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { shareInvite, setClipboard } from '@just-messin-around/expo-foundation/platform';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { REFERRALS_ENABLED } from '../../lib/features';
import {
  REFERRAL_REWARD_PICKLES,
  ZERO_REFERRAL_STATS,
  nextMilestoneText,
  referralRewardLine,
} from '../../lib/referralRules';
import {
  REFERRAL_CODE_KEY,
  REFERRAL_CODE_PERSIST_MS,
  REFERRAL_CODE_TTL_MS,
  REFERRAL_STATS_KEY,
  REFERRAL_STATS_PERSIST_MS,
  REFERRAL_STATS_TTL_MS,
  getMyReferralCode,
  getMyReferralStats,
  referralInviteUrl,
  referralShareContent,
} from '../../data/referrals';

export default function InviteEarnSection({ onToggle }: { onToggle?: (open: boolean) => void }) {
  // Guests see nothing; read from the local session (no network).
  const [guest, setGuest] = useState<boolean | null>(null);
  useEffect(() => {
    if (!REFERRALS_ENABLED) return;
    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => active && setGuest(!data.session || !!data.session.user.is_anonymous))
      .catch(() => active && setGuest(true));
    return () => {
      active = false;
    };
  }, []);

  if (!REFERRALS_ENABLED || guest !== false) return null;
  return (
    <CollapsibleSection
      compact
      title="Invite & Earn"
      summary={`Invite a friend · you both get ${REFERRAL_REWARD_PICKLES} 🥒`}
      onToggle={onToggle}
    >
      <InviteEarnBody />
    </CollapsibleSection>
  );
}

/** Mounted only while the section is open, so a closed section fetches nothing. */
function InviteEarnBody() {
  const { colors } = useTheme();
  const t = textStyles(colors);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data: code } = useCachedQuery(REFERRAL_CODE_KEY, getMyReferralCode, {
    ttlMs: REFERRAL_CODE_TTL_MS,
    persistMs: REFERRAL_CODE_PERSIST_MS,
  });
  const { data } = useCachedQuery(REFERRAL_STATS_KEY, getMyReferralStats, {
    ttlMs: REFERRAL_STATS_TTL_MS,
    persistMs: REFERRAL_STATS_PERSIST_MS,
  });
  const stats = data ?? ZERO_REFERRAL_STATS;

  // Focus revalidate, TTL-guarded (a fresh cache makes this a no-op).
  useFocusEffect(
    useCallback(() => {
      void cachedFetch(REFERRAL_STATS_KEY, getMyReferralStats, {
        ttlMs: REFERRAL_STATS_TTL_MS,
        persistMs: REFERRAL_STATS_PERSIST_MS,
      }).catch(() => {});
    }, []),
  );

  const link = referralInviteUrl(code);
  const milestone = nextMilestoneText(stats.joined);

  async function share() {
    if (!code) return;
    setBusy(true);
    try {
      const res = await shareInvite(referralShareContent(code));
      if (res.copied) toast.success('Invite copied. Paste it to a friend.');
    } catch {
      toast.error("Couldn't open sharing. Try Copy link instead.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await setClipboard(link);
      toast.success('Link copied');
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <InviteEarnPanel
      blurb={referralRewardLine()}
      stats={[
        { label: 'Invited', value: stats.invited },
        { label: 'Joined', value: stats.joined },
        { label: 'Pickles earned', value: stats.pickles_earned },
      ]}
      emptyStatsHint="Share your link below. Friends count once they confirm their email."
      code={code || null}
      link={link || null}
      onShare={share}
      copyLabel="Copy link"
      onCopy={copy}
      busy={busy}
      qrCaption="Scan to join Pickleague"
      footer={milestone ? <Text style={[t.sub, { marginTop: 12, textAlign: 'center' }]}>{milestone}</Text> : undefined}
      testID="invite-earn"
    />
  );
}
