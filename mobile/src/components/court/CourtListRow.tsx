// One court in the Courts list (court discovery, Phase 1): the foundation's
// PlaceListCard with the crowd line and the ☆ star.
//
//   Lakeside Park                                                    ☆
//   1.2 mi · Oakland · 3 leagues
//   (6 courts) (Lights) (Free)
//   6 playing now · mostly 3.5–4.0
//
// The crowd comes in as a prop (one batched venue_crowd read per page, see
// data/courtDiscovery useCourtCrowds), so a row never polls on its own. The
// card is one element to a screen reader ("Lakeside Park, 1.2 miles, 6 playing
// now, 3 leagues"), so the star is offered there as an action too.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Badge, PlaceListCard } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { COURT_STARS_ENABLED, FRIENDS_AT_COURTS_ENABLED } from '../../lib/features';
import { courtRowView, type CourtRow } from '../../lib/courtDiscovery';
import type { VenueCrowd } from '../../data/venueCrowd';
import CrowdLine from './CrowdLine';
import CourtFavoriteStar from './CourtFavoriteStar';

type Props = {
  court: CourtRow;
  /** undefined: not loaded yet; null: none. */
  crowd: VenueCrowd | null | undefined;
  starred: boolean;
  onPress: () => void;
  /** The screen-reader "Star" action (the star itself is inside the card). */
  onToggleStar?: () => void;
};

function CourtListRow({ court, crowd, starred, onPress, onToggleStar }: Props) {
  const view = courtRowView(court, crowd, {
    friendsEnabled: FRIENDS_AT_COURTS_ENABLED,
    starsEnabled: COURT_STARS_ENABLED,
    starred,
  });
  const starAction = view.showStar && onToggleStar;
  return (
    <PlaceListCard
      name={court.name}
      distanceLabel={view.distanceLabel}
      meta={view.meta}
      chips={
        view.chips.length > 0 || court.unconfirmed ? (
          <View style={S.chips}>
            {view.chips.map((c) => (
              <Badge key={c} label={c} />
            ))}
            {court.unconfirmed ? <Badge label="Unconfirmed" tone="warning" /> : null}
          </View>
        ) : undefined
      }
      trailing={view.showStar ? <CourtFavoriteStar venueId={court.id} venueName={court.name} /> : undefined}
      onPress={onPress}
      accessibilityLabel={view.a11yLabel}
      accessibilityHint="Opens the court's page"
      accessibilityActions={
        starAction ? [{ name: 'star', label: starred ? 'Remove from your courts' : 'Add to your courts' }] : undefined
      }
      onAccessibilityAction={starAction ? (e) => e.nativeEvent.actionName === 'star' && onToggleStar() : undefined}
    >
      {view.crowdText ? <CrowdLine venueId={court.id} venueName={court.name} crowd={crowd} /> : null}
    </PlaceListCard>
  );
}

export default React.memo(CourtListRow);

const S = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
});
