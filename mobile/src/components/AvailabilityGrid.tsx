import React from 'react';
import {
  AvailabilityGrid,
  AVAILABILITY_PRESETS,
} from '@just-messin-around/expo-foundation/ui';

type Props = {
  availability: boolean[];
  onChange: (av: boolean[]) => void;
  onScrollLock: (locked: boolean) => void;
};

// Pickleague's preset set matches the kit's defaults except the lunch chip,
// which the kit renamed "Lunch Crew" — keep the original "Lunch League" label.
const PRESETS = AVAILABILITY_PRESETS.map(p =>
  p.id === 'lunch_league' ? { ...p, label: 'Lunch League' } : p,
);

/**
 * Moved to @just-messin-around/expo-foundation/ui. This adapter keeps the
 * original Pickleague preset labels so existing imports
 * (`../components/AvailabilityGrid`) keep working unchanged.
 */
export default function PickleagueAvailabilityGrid(props: Props) {
  return <AvailabilityGrid {...props} presets={PRESETS} />;
}
