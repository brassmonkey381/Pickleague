// Tapping a court's pin on Discover's map opens this: the court's list row
// (name, distance, facts, crowd, and its ☆ star) with Directions and View
// details. Doggle's PlaceMapModal, on the same foundation MapPinModal shell.
import React from 'react';
import { MapPinModal } from '@just-messin-around/expo-foundation/ui';
import { openDirections } from '@just-messin-around/expo-foundation/platform';
import { useToast } from '../../lib/useToast';
import { track } from '../../lib/analytics';
import type { CourtRow } from '../../lib/courtDiscovery';
import type { VenueCrowd } from '../../data/venueCrowd';
import CourtListRow from './CourtListRow';

type Props = {
  /** The tapped court, or null when the modal is closed. */
  court: CourtRow | null;
  crowd: VenueCrowd | null | undefined;
  starred: boolean;
  onClose: () => void;
  onViewDetails: (court: CourtRow) => void;
};

export default function CourtPinModal({ court, crowd, starred, onClose, onViewDetails }: Props) {
  const toast = useToast();

  async function directions() {
    if (!court) return;
    track('courts.directions', { from: 'map' });
    const ok = await openDirections(court.lat, court.lng);
    if (!ok) toast.error("Couldn't open maps.");
  }

  return (
    <MapPinModal
      visible={court != null}
      onClose={onClose}
      onGetDirections={() => void directions()}
      onViewDetails={() => {
        if (court) onViewDetails(court);
      }}
    >
      {court ? (
        <CourtListRow court={court} crowd={crowd} starred={starred} onPress={() => onViewDetails(court)} />
      ) : null}
    </MapPinModal>
  );
}
