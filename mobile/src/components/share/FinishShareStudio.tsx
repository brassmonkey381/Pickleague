// The season / tournament finish share card (PKL-013) on the foundation share
// kit (1.87 /share): ShareStudio draws the sheet (layouts, size, look, SHOW,
// Share, the Story link guide); this file owns the card and the copy.
//
// Sharing copies the sharer's referral invite link first (a friend who joins
// from it earns them both REFERRAL_REWARD_PICKLES), then shares the image. The
// Instagram Story link guide shows before the first share, once per account
// (data/seenPrompts.ts). Callers show the entry button only when
// isImageShareAvailable() (false on web and on binaries without view-shot).
//
// Privacy (lib/finishShare.ts): other players are "First L." with initials,
// never photos; blocked and deleted players are "a player"; the podium is off
// by default.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { supabase } from '../../lib/supabase';
import { cachedFetch } from '@just-messin-around/expo-foundation/cache';
import {
  ShareStudio,
  ShareCtaChip,
  StoryLinkGuide,
  type ShareGuide,
  type ShareLook,
  type ShareOption,
  type ShareStudioState,
  type ShareToast,
} from '@just-messin-around/expo-foundation/share';
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
  finishShareMessage,
  medalFor,
  ordinal,
  placeHeadline,
  recordLabel,
  type FinishShareData,
} from '../../lib/finishShare';

type LookId = 'court' | 'night' | 'cream';
type Palette = { ground: string; ink: string; muted: string; accent: string; chip: string };

const LOOKS: Record<LookId, Palette & { label: string }> = {
  court: { label: 'Court', ground: '#1f6f4a', ink: '#ffffff', muted: 'rgba(255,255,255,0.75)', accent: '#c6f36b', chip: 'rgba(255,255,255,0.16)' },
  night: { label: 'Night', ground: '#14213d', ink: '#ffffff', muted: 'rgba(255,255,255,0.72)', accent: '#ffd166', chip: 'rgba(255,255,255,0.14)' },
  cream: { label: 'Cream', ground: '#f6f1e3', ink: '#1d2b22', muted: 'rgba(29,43,34,0.68)', accent: '#2e8b57', chip: 'rgba(29,43,34,0.08)' },
};
const LOOK_OPTIONS: ShareLook[] = (Object.keys(LOOKS) as LookId[]).map((id) => ({ id, label: LOOKS[id].label, ground: LOOKS[id].ground }));

const MEDAL: Record<'gold' | 'silver' | 'bronze', string> = { gold: '#d4af37', silver: '#c0c4cc', bronze: '#cd7f32' };

const TEMPLATES: ShareOption[] = [
  { id: 'big', label: 'Big finish' },
  { id: 'card', label: 'Scorecard' },
];

const DEFAULT_DETAILS = { record: true, podium: false };

type Props = {
  visible: boolean;
  onClose: () => void;
  data: FinishShareData;
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

export default function FinishShareStudio({ visible, onClose, data }: Props) {
  const canRefer = useCanRefer(visible);
  const [code, setCode] = React.useState('');

  React.useEffect(() => {
    if (!visible || !canRefer) return;
    let alive = true;
    cachedFetch(REFERRAL_CODE_KEY, getMyReferralCode, { ttlMs: REFERRAL_CODE_TTL_MS, persistMs: REFERRAL_CODE_PERSIST_MS })
      .then((c) => alive && setCode(c || ''))
      .catch(() => {});
    return () => { alive = false; };
  }, [visible, canRefer]);

  const invite = canRefer && !!code;
  const link = invite ? referralInviteUrl(code) : INVITE_ORIGIN;
  const reward = REFERRAL_REWARD_PICKLES.toLocaleString('en-US');

  const details: ShareOption[] = [
    ...(recordLabel(data.wins, data.losses) ? [{ id: 'record', label: 'Record' }] : []),
    ...(data.podium.length > 0 ? [{ id: 'podium', label: 'Podium' }] : []),
  ];

  const prepareShare = async () => {
    track('share.finish', { kind: data.kind, rank: data.rank, invite });
    return { message: finishShareMessage(data, link), clipboard: link };
  };

  const toastFor = ({ method, aspect }: { method: 'image' | 'text' | 'none'; aspect: 'post' | 'story' }): ShareToast => {
    if (method === 'image') {
      const what = invite ? 'Your invite link is copied' : 'The Pickleague link is copied';
      const earn = invite ? ` Friends who join from it get you both ${reward} pickles.` : '';
      return {
        kind: 'success',
        text: aspect === 'story'
          ? `${what}. In your Story, add a Link sticker and paste it.${earn}`
          : `${what}. Posts can’t have tappable links, so paste it in your bio or a Story.${earn}`,
        close: true,
      };
    }
    if (method === 'text') return { kind: 'info', text: 'Shared a link. Image sharing works in the app.', close: false };
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
                body: 'Sharing your finish copies your own Pickleague invite link, ready to paste.',
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
      visible={visible}
      onClose={onClose}
      title="Share your finish"
      looks={LOOK_OPTIONS}
      defaultLook={data.rank === 1 ? 'night' : 'court'}
      details={details}
      defaultDetails={DEFAULT_DETAILS}
      templatesFor={() => TEMPLATES}
      maxPhotos={0}
      renderCard={(s) => <FinishCard s={s} data={data} />}
      prepareShare={prepareShare}
      toastFor={toastFor}
      errorText="Could not share right now. Please try again."
      guide={guide}
      renderExtraCta={invite ? ({ openGuide }) => (
        <ShareCtaChip label={`Share and Earn ${REFERRAL_REWARD_PICKLES} Pickles!`} onPress={openGuide} />
      ) : undefined}
    />
  );
}

// ── The card ────────────────────────────────────────────────────────────

function Medal({ rank, size }: { rank: number; size: number }) {
  const m = medalFor(rank);
  if (!m) return null;
  return (
    <View style={[cs.medal, { width: size, height: size, borderRadius: size / 2, backgroundColor: MEDAL[m] }]}>
      <Text style={[cs.medalText, { fontSize: size * 0.45 }]}>{rank}</Text>
    </View>
  );
}

function FinishCard({ s, data }: { s: ShareStudioState & { width: number; height: number }; data: FinishShareData }) {
  const look = LOOKS[(s.look as LookId)] ?? LOOKS.court;
  const u = s.width / 300; // the preview is 300 wide; everything scales with it
  const story = s.aspect === 'story';
  const record = s.details.record ? recordLabel(data.wins, data.losses) : null;
  const podium = s.details.podium ? data.podium : [];
  const where = data.kind === 'season' && data.league ? data.league : null;
  const big = s.template !== 'card';

  const header = (
    <View style={cs.row}>
      <Text style={[cs.brand, { color: look.ink, fontSize: 13 * u }]}>🥒 Pickleague</Text>
      <Text style={[cs.kind, { color: look.muted, fontSize: 9 * u, letterSpacing: 1.5 * u }]}>
        {data.kind === 'season' ? 'SEASON FINISH' : 'TOURNAMENT FINISH'}
      </Text>
    </View>
  );

  const title = (
    <View style={{ gap: 2 * u }}>
      {where ? <Text style={[cs.sub, { color: look.muted, fontSize: 11 * u }]} numberOfLines={1}>{where}</Text> : null}
      <Text style={[cs.title, { color: look.ink, fontSize: 18 * u }]} numberOfLines={2}>{data.title}</Text>
    </View>
  );

  const place = big ? (
    <View style={[cs.center, { gap: 6 * u }]}>
      <Medal rank={data.rank} size={44 * u} />
      <Text style={[cs.huge, { color: look.accent, fontSize: (data.rank === 1 ? 40 : 56) * u }]} numberOfLines={1} adjustsFontSizeToFit>
        {data.rank === 1 ? 'Champion' : ordinal(data.rank)}
      </Text>
      <Text style={[cs.sub, { color: look.muted, fontSize: 12 * u }]}>
        {data.rank === 1 ? `${data.me} took 1st` : data.of ? `${data.me} · of ${data.of}` : data.me}
      </Text>
    </View>
  ) : (
    <View style={[cs.row, { gap: 10 * u, justifyContent: 'flex-start' }]}>
      <Medal rank={data.rank} size={34 * u} />
      <View style={{ flexShrink: 1 }}>
        <Text style={[cs.title, { color: look.accent, fontSize: 24 * u }]} numberOfLines={1}>{placeHeadline(data.rank, data.of)}</Text>
        <Text style={[cs.sub, { color: look.muted, fontSize: 11 * u }]} numberOfLines={1}>{data.me}</Text>
      </View>
    </View>
  );

  return (
    <View style={[cs.card, { padding: 18 * u, paddingVertical: (story ? 40 : 18) * u, gap: 12 * u }]}>
      {header}
      {title}
      <View style={[cs.fill, { justifyContent: big ? 'center' : 'flex-start', gap: 12 * u }]}>
        {place}
        {record ? (
          <View style={[cs.chip, { backgroundColor: look.chip, borderRadius: 10 * u, paddingVertical: 6 * u, paddingHorizontal: 12 * u, alignSelf: big ? 'center' : 'flex-start' }]}>
            <Text style={[cs.chipText, { color: look.ink, fontSize: 13 * u }]}>Record {record}</Text>
          </View>
        ) : null}
        {podium.length > 0 ? (
          <View style={{ gap: 6 * u }}>
            {podium.map((p) => (
              <View key={p.rank} style={[cs.row, { gap: 8 * u, justifyContent: 'flex-start' }]}>
                <Medal rank={p.rank} size={18 * u} />
                {p.players.slice(0, 2).map((pl, i) => (
                  <View key={i} style={[cs.row, { gap: 4 * u, justifyContent: 'flex-start', flexShrink: 1 }]}>
                    <View style={[cs.initials, { width: 20 * u, height: 20 * u, borderRadius: 10 * u, backgroundColor: look.chip }]}>
                      <Text style={[cs.chipText, { color: look.ink, fontSize: 8 * u }]}>{pl.initials}</Text>
                    </View>
                    <Text style={[cs.sub, { color: look.ink, fontSize: 11 * u }]} numberOfLines={1}>{pl.name}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <Text style={[cs.sub, { color: look.muted, fontSize: 9 * u, textAlign: 'center' }]}>pickleague.club</Text>
    </View>
  );
}

const cs = StyleSheet.create({
  card: { flex: 1 },
  fill: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center' },
  brand: { fontWeight: '800' },
  kind: { fontWeight: '700' },
  title: { fontWeight: '800' },
  sub: { fontWeight: '500' },
  huge: { fontWeight: '900' },
  chip: {},
  chipText: { fontWeight: '700' },
  initials: { alignItems: 'center', justifyContent: 'center' },
  medal: { alignItems: 'center', justifyContent: 'center' },
  medalText: { color: '#1b1b1b', fontWeight: '900' },
});
