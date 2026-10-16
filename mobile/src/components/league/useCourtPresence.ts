// Who is checked in at a league's home court right now, for the identity row's
// court chip ("Lake Merritt · 2 here ›"): find the court once, then poll
// court_presence every minute while the app is active. The count includes
// players this viewer can't name (court_presence returns them as anonymous
// rows), so it agrees with the roster the chip opens.
//
// The court is the league's stored home venue when it has one
// (leagues.home_venue_id), else the closest mapped court within 200 m of the
// home court's coordinates. `venueId` stays null when neither finds one (the
// chip is then plain text, nothing to open). `count` is null until the first
// read lands or when it fails: the chip just omits "N here" rather than
// claiming nobody is there.
import { useEffect, useState } from 'react';
import { usePollWhileActive } from '@just-messin-around/expo-foundation/hooks';
import { resolveVenueAt } from '../../data/venueCheckins';
import { getCourtPresence } from '../../data/courtPresence';

export type CourtPresence = { venueId: string | null; count: number | null };

export function useCourtPresence(
  lat: number | null | undefined,
  lng: number | null | undefined,
  homeVenueId?: string | null,
): CourtPresence {
  const [venueId, setVenueId] = useState<string | null>(homeVenueId ?? null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    setCount(null);
    if (homeVenueId) {
      setVenueId(homeVenueId);
      return;
    }
    setVenueId(null);
    if (lat == null || lng == null) return;
    let alive = true;
    resolveVenueAt(lat, lng, 200)
      .then((v) => { if (alive) setVenueId(v?.id ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [lat, lng, homeVenueId]);

  usePollWhileActive(
    async () => {
      if (!venueId) return;
      try {
        setCount((await getCourtPresence(venueId)).length);
      } catch {
        // Keep the last count; a blip shouldn't flip the chip to "0 here".
      }
    },
    60_000,
    venueId,
  );

  return { venueId, count };
}
