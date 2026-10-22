// The Distance filter (a FilterSheet `custom` group in Play > Leagues and
// Play > Tournaments, standalone on Courts): Pickleague's options and copy over
// the foundation's DistanceFilterGroup (hoisted from this file in 1.51).
//
// THE ONLY PLACE THE APP ASKS FOR LOCATION TO BROWSE (plan section 4). Without
// a location it shows a "Use my location" button:
//   tap -> LocationUseConfirmModal (our copy) -> requestForegroundLocationPermission()
//       -> granted: read a fix, share it (onCoords), pick 25 mi
//       -> denied:  a "Location is off" confirm with Open settings (OK on web).
// With a location it shows the radius chips (Any / 5 / 10 / 25 / 50 mi). The
// values are the same strings as before ('any', '25'), so lib/playFilters
// distanceMiles keeps reading them.
//
// Both confirms render INSIDE the group's tree (a sibling Modal over the
// FilterSheet would never appear on iOS); the foundation keeps that.
import React from 'react';
import {
  DistanceFilterGroup as KitDistanceFilterGroup,
  type DistanceFilterGroupProps as KitProps,
} from '@just-messin-around/expo-foundation/ui';
import { DISTANCE_OPTIONS } from '../../lib/playFilters';

const OPTIONS = DISTANCE_OPTIONS.map(Number);

/** The radius picked automatically once location is granted. */
const FIRST_RADIUS = 25;

export type DistanceFilterGroupProps = Omit<KitProps, 'options' | 'unit' | 'copy' | 'firstRadius'> & {
  /** 'leagues' | 'tournaments' | 'courts', for the copy. */
  noun: string;
};

export default function DistanceFilterGroup({ noun, ...rest }: DistanceFilterGroupProps) {
  return (
    <KitDistanceFilterGroup
      {...rest}
      options={OPTIONS}
      unit="mi"
      firstRadius={FIRST_RADIUS}
      copy={{
        ask: `Show ${noun} near you. Your location is only read while you browse.`,
        confirmBody: `Pickleague uses it to show ${noun} near you and sort them by distance. It isn't saved to your profile or shared.`,
        deniedBodyNative: `Turn on location for Pickleague in Settings to see ${noun} near you.`,
        deniedBodyWeb: `Allow location for this site in your browser settings, then tap Use my location again to see ${noun} near you.`,
      }}
    />
  );
}
