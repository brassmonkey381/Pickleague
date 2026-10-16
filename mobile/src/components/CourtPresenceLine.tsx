// "N players at <court> now" for a place given by coordinates (a league's home
// court). Resolves the court once; renders nothing if no court is mapped there.
import React, { useEffect, useState } from 'react';
import { resolveCourtAt, type ResolvedCourt } from '../data/venueCheckins';
import PlayersHereList from './PlayersHereList';

type Props = { lat: number | null | undefined; lng: number | null | undefined; name?: string | null };

export default function CourtPresenceLine({ lat, lng, name }: Props) {
  const [venue, setVenue] = useState<ResolvedCourt | null>(null);

  useEffect(() => {
    if (lat == null || lng == null) return;
    let alive = true;
    resolveCourtAt(lat, lng, 200)
      .then((v) => alive && setVenue(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lat, lng]);

  if (!venue) return null;
  return <PlayersHereList compact venueId={venue.id} venueName={name ?? venue.name} />;
}
