// The Instagram share studio for every Pickleague card (PKL-013): a finish, a
// match, a play session, an event, a bracket. The foundation share kit's
// ShareStudio draws the sheet (layouts, SIZE, LOOK, BANNER, LOGO, SHOW,
// PHOTOS, Share, the Story link guide); ShareCardArt draws the card from a
// ShareCardModel (lib/shareCards), and this file says what to share.
//
// Sharing copies the sharer's referral invite link first (a friend who joins
// from it earns them both REFERRAL_REWARD_PICKLES), then shares the image. The
// Instagram Story link guide shows before the first share, once per account
// (data/seenPrompts.ts). A card with other players' scores says
// SCORE_DISCLAIMER right above Share, every time. Callers show the entry only
// when isImageShareAvailable() (false on web and on binaries without view-shot).
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { supabase } from '../../lib/supabase';
import { cachedFetch } from '@just-messin-around/expo-foundation/cache';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import {
  ShareStudio,
  ShareCtaChip,
  StoryLinkGuide,
  type ShareGuide,
  type ShareLook,
  type ShareToast,
} from '@just-messin-around/expo-foundation/share';
import { useTheme } from '../../lib/ThemeContext';
import {
  REFERRAL_CODE_KEY,
  REFERRAL_CODE_PERSIST_MS,
  REFERRAL_CODE_TTL_MS,
  getMyReferralCode,
  referralInviteUrl,
} from '../../data/referrals';
import { INVITE_ORIGIN, REFERRAL_REWARD_PICKLES } from '../../lib/referralRules';
import { REFERRALS_ENABLED } from '../../lib/features';
import { SHARE_LINK_GUIDE_KEY, markGuideSeen, shouldShowGuide } from '../../data/seenPrompts';
import { track } from '../../lib/analytics';
import {
  MAX_SHARE_PHOTOS,
  SCORE_DISCLAIMER,
  SHARE_BANNERS,
  SHARE_BANNER_DEFAULT,
  SHARE_BANNER_FALLBACK,
  SHARE_ERROR,
  SHARE_LOGOS,
  SHARE_LOOKS,
  SHARE_LOOK_IDS,
  SHARE_TEMPLATE_LABEL,
  SHARE_TEXT_ONLY,
  shareCardMessage,
  shareDefaultDetails,
  shareDetailOptions,
  shareStudioKey,
  shareTemplatesFor,
  shareToastText,
  type ShareCardModel,
} from '../../lib/shareCards';
import ShareCardArt from './ShareCardArt';

const LOOK_OPTIONS: ShareLook[] = SHARE_LOOK_IDS.map((id) => ({ id, label: SHARE_LOOKS[id].label, ground: SHARE_LOOKS[id].ground }));

type Props = {
  visible: boolean;
  onClose: () => void;
  /** The sheet's title: "Share your finish", "Share this match". */
  title: string;
  model: ShareCardModel;
  /** Extra analytics props. */
  trackProps?: Record<string, unknown>;
  /** Photos the studio opens with (Godmode's Share card lab). */
  initialPhotos?: readonly string[];
};

/** Saved accounts can refer; a guest shares the plain site link. */
function useCanRefer(visible: boolean): boolean {
  const [can, setCan] = React.useState(false);
  React.useEffect(() => {
    if (!visible || !REFERRALS_ENABLED) return;
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => alive && setCan(!!data.session && !data.session.user.is_anonymous))
      .catch(() => alive && setCan(false));
    return () => { alive = false; };
  }, [visible]);
  return can;
}

export default function PickleShareStudio({ visible, onClose, title, model, trackProps, initialPhotos }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const canRefer = useCanRefer(visible);
  const [code, setCode] = React.useState('');

  React.useEffect(() => {
    if (!visible || !canRefer) return;
    let alive = true;
    cachedFetch(REFERRAL_CODE_KEY, getMyReferralCode, { ttlMs: REFERRAL_CODE_TTL_MS, persistMs: REFERRAL_CODE_PERSIST_MS })
      .then((v) => alive && setCode(v || ''))
      .catch(() => {});
    return () => { alive = false; };
  }, [visible, canRefer]);

  const invite = canRefer && !!code;
  const link = invite ? referralInviteUrl(code) : INVITE_ORIGIN;
  const reward = REFERRAL_REWARD_PICKLES.toLocaleString('en-US');

  // Read once at mount by the studio: keep every key the card could offer.
  const defaultDetails = React.useMemo(() => shareDefaultDetails(model), [model]);
  const details = shareDetailOptions(model);
  const templatesFor = React.useCallback(
    (n: number) => shareTemplatesFor(n, model.kind).map((id) => ({ id, label: SHARE_TEMPLATE_LABEL[id] })),
    [model.kind],
  );

  const prepareShare = async (s: { template: string; aspect: string; photos: string[] }) => {
    track(`share.${model.kind}`, { ...trackProps, invite, template: s.template, aspect: s.aspect, photos: s.photos.length });
    return { message: shareCardMessage(model, link), clipboard: link };
  };

  const toastFor = ({ method, aspect }: { method: 'image' | 'text' | 'none'; aspect: 'post' | 'story' }): ShareToast => {
    if (method === 'image') return { kind: 'success', text: shareToastText({ invite, aspect, reward }), close: true };
    if (method === 'text') return { kind: 'info', text: SHARE_TEXT_ONLY, close: false };
    return null;
  };

  const guide = React.useMemo<ShareGuide | null>(
    () => (invite
      ? {
          shouldShow: () => shouldShowGuide(SHARE_LINK_GUIDE_KEY),
          markSeen: (answer) => markGuideSeen(SHARE_LINK_GUIDE_KEY, answer),
          render: ({ onShare, onSkip, busy }) => (
            <StoryLinkGuide
              onShare={onShare}
              onSkip={onSkip}
              busy={busy}
              copied={{
                title: 'Your invite link is copied',
                body: 'Sharing copies your own Pickleague invite link, ready to paste.',
              }}
              reward={{
                badge: `+${reward}`,
                title: `Earn ${reward} pickles per friend`,
                body: `A friend who signs up from your link and confirms their email gets you ${reward} pickles, and they get ${reward} too. Sharing a post? Put the link in your bio.`,
              }}
              photoIcon="trophy"
            />
          ),
        }
      : null),
    [invite, reward],
  );

  return (
    <ShareStudio
      // The studio reads its SHOW defaults once: a card with other toggles gets a fresh one.
      key={shareStudioKey(model)}
      visible={visible}
      onClose={onClose}
      title={title}
      looks={LOOK_OPTIONS}
      defaultLook={model.defaultLook}
      banners={SHARE_BANNERS}
      bannerDefaults={SHARE_BANNER_DEFAULT}
      bannerFallback={SHARE_BANNER_FALLBACK}
      logos={SHARE_LOGOS}
      defaultLogo="full"
      details={details}
      defaultDetails={defaultDetails}
      templatesFor={templatesFor}
      maxPhotos={MAX_SHARE_PHOTOS}
      initialPhotos={initialPhotos}
      strings={{ photoHint: (n) => (n === 0 ? 'Add photos from the court for photo layouts.' : n === 1 ? 'Add another photo for collages.' : `${n} photos`) }}
      renderCard={(s) => <ShareCardArt s={s} model={model} />}
      prepareShare={prepareShare}
      toastFor={toastFor}
      errorText={SHARE_ERROR}
      guide={guide}
      renderAboveShare={model.showsScores ? () => (
        <View style={[S.note, { backgroundColor: c.warningLight, borderColor: c.warning }]} accessibilityRole="text">
          <Icon name="info" size={16} color={c.text} />
          <Text style={[t.sub, S.noteText, { color: c.text }]}>{SCORE_DISCLAIMER}</Text>
        </View>
      ) : undefined}
      renderExtraCta={invite ? ({ openGuide }) => (
        <ShareCtaChip label={`Share and Earn ${reward} Pickles!`} onPress={openGuide} />
      ) : undefined}
    />
  );
}

const S = StyleSheet.create({
  note: { flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start', borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, marginTop: SPACE.lg },
  noteText: { flex: 1 },
});
