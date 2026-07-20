import React from 'react';
import {
  WeeklySlotGrid,
  AvailabilityOverlaySlot,
} from '@just-messin-around/expo-foundation/ui';

type Overlay = AvailabilityOverlaySlot; // { date: string; slot: number; length_minutes?: number }

type Props = {
  // Recurring weekly template: boolean[336] (7 weekdays × 48 slots, 0=Mon..6=Sun).
  availability: boolean[];
  onChange: (av: boolean[]) => void;
  onScrollLock: (locked: boolean) => void;
  // Confirmed drill sessions (yellow) over the next 7 days.
  confirmedSlots?: Overlay[];
  // Scheduled match commitments (red). Wins over availability + drill-confirmed
  // paint, since competitive matches outrank drills.
  scheduledMatchSlots?: Overlay[];
};

/**
 * Moved to @just-messin-around/expo-foundation/ui as WeeklySlotGrid. This
 * adapter reproduces the original overlay layers — drill-confirmed (yellow)
 * under scheduled-match (red, painted last so it wins) — and the drill empty
 * label, so existing imports (`../components/DrillAvailabilityGrid`) keep
 * working unchanged.
 */
export default function DrillAvailabilityGrid({
  availability,
  onChange,
  onScrollLock,
  confirmedSlots,
  scheduledMatchSlots,
}: Props) {
  return (
    <WeeklySlotGrid
      availability={availability}
      onChange={onChange}
      onScrollLock={onScrollLock}
      emptyLabel="No drill availability set"
      overlays={[
        { label: 'Drill', color: { light: '#f5c542', dark: '#caa028' }, slots: confirmedSlots ?? [] },
        { label: 'Match', color: { light: '#e75555', dark: '#a13434' }, slots: scheduledMatchSlots ?? [] },
      ]}
    />
  );
}
