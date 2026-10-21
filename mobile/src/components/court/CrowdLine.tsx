// "6 playing now · mostly 3.5–4.0 · 2 friends" for one court, with an
// optional ☆ "my courts" star. Anonymous numbers (venue_crowd), so it works
// with zero friends: the open-play turnout signal.
//
// Refreshes every minute, only while its screen is focused and the app is in
// the foreground (usePollWhileActive), through one shared cache entry per
// court, so two surfaces showing the same court read once.
//
// Renders nothing while FRIENDS_AT_COURTS_ENABLED is off, before the first
// read lands, or when nobody is there (unless `emptyText` is given): the
// surfaces it sits on already say "No one else here yet".
//
// A list passes `crowd` instead (court discovery): the numbers come from one
// batched venue_crowd read per page (data/courtDiscovery useCourtCrowds), so
// the row never polls on its own. With `crowd` the line shows whatever the
// friends flag says (decision 4: the anonymous turnout is useful alone), and
// the "· 2 friends" part follows `showFriends` (default: the friends flag).
import React, { useCallback } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { usePollWhileActive } from '@just-messin-around/expo-foundation/hooks';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FRIENDS_AT_COURTS_ENABLED } from '../../lib/features';
import { useTheme } from '../../lib/ThemeContext';
import { crowdLineText } from '../../lib/courtCrowd';
import { getOneVenueCrowd, venueCrowdKey, type VenueCrowd } from '../../data/venueCrowd';
import CourtFavoriteStar from './CourtFavoriteStar';

const POLL_MS = 60_000;

/** One court's crowd, polled every minute while focused. `null` venue: idle. */
export function useVenueCrowd(venueId: string | null): VenueCrowd | undefined {
  const focused = useIsFocused();
  const enabled = FRIENDS_AT_COURTS_ENABLED && !!venueId;
  const fetcher = useCallback(() => getOneVenueCrowd(venueId as string), [venueId]);
  const { data, refresh } = useCachedQuery<VenueCrowd>(venueCrowdKey(venueId ?? '-'), fetcher, {
    ttlMs: 30_000,
    enabled,
  });
  usePollWhileActive(refresh, POLL_MS, enabled && focused ? venueId : null);
  return enabled ? data : undefined;
}

type Props = {
  venueId: string;
  venueName?: string | null;
  /** Show the ☆ "my courts" toggle at the end of the line. */
  star?: boolean;
  /** What to say when nobody is there (default: render nothing). */
  emptyText?: string | null;
  /**
   * The numbers, read by the caller (one batched read for a whole list). Given
   * (even undefined while it loads), the line never polls on its own and shows
   * whatever FRIENDS_AT_COURTS_ENABLED says.
   */
  crowd?: VenueCrowd | null;
  /** Include "· N friends". Default: FRIENDS_AT_COURTS_ENABLED. */
  showFriends?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function CrowdLine(props: Props) {
  if ('crowd' in props) return <CrowdLineView {...props} crowd={props.crowd} />;
  return FRIENDS_AT_COURTS_ENABLED ? <CrowdLineBody {...props} /> : null;
}

function CrowdLineBody(props: Props) {
  const crowd = useVenueCrowd(props.venueId);
  return <CrowdLineView {...props} crowd={crowd} />;
}

function CrowdLineView({
  venueId,
  venueName,
  star,
  emptyText = null,
  crowd,
  showFriends = FRIENDS_AT_COURTS_ENABLED,
  style,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const text = crowdLineText(crowd, emptyText, { showFriends });
  if (!text && !star) return null;
  return (
    <View style={[S.row, style]}>
      <Text style={[t.sub, S.text]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
        {text ?? ''}
      </Text>
      {star ? <CourtFavoriteStar venueId={venueId} venueName={venueName} /> : null}
    </View>
  );
}

const S = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 32 },
  text: { flex: 1, minWidth: 0 },
});
