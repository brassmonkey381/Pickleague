// Who is checked in at a league's home court right now, for the identity row's
// court chip ("Lake Merritt · 2 here ›"). Same two calls CourtPresenceLine made
// (resolve the court once from the league's coordinates, then poll
// venue_players_here every minute while the app is active); this returns the
// numbers instead of rendering a line, so the chip can carry them.
//
// `venueId` stays null when no mapped court is within 200 m of the home court
// (the chip is then plain text, nothing to open). `count` is null until the
// first read lands or when it fails: the chip just omits "N here" rather than
// claiming nobody is there.
import { useEffect, useState } from 'react';
import { usePollWhileActive } from '@just-messin-around/expo-foundation/hooks';
import { getPlayersHere, resolveVenueAt } from '../../data/venueCheckins';

export type CourtPresence = { venueId: string | null; count: number | null };

export function useCourtPresence(lat: number | null | undefined, lng: number | null | undefined): CourtPresence {
  const [venueId, setVenueId] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    setVenueId(null);
    setCount(null);
    if (lat == null || lng == null) return;
    let alive = true;
    resolveVenueAt(lat, lng, 200)
      .then((v) => { if (alive) setVenueId(v?.id ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [lat, lng]);

  usePollWhileActive(
    async () => {
      if (!venueId) return;
      try {
        setCount((await getPlayersHere(venueId)).length);
      } catch {
        // Keep the last count; a blip shouldn't flip the chip to "0 here".
      }
    },
    60_000,
    venueId,
  );

  return { venueId, count };
}
