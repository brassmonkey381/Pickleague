// City / address search for the home location picker: OpenStreetMap
// Nominatim, as the kit's web VenuePicker does, but on every platform. The
// kit's native picker only knows Google Places, and Pickleague has no Google
// Places key (app.config.js), so the picker runs with externalSearch="none"
// and this as its localSearch. US only; at most 5; nearest first when the
// phone's position is known.
import type { VenueResult } from '@just-messin-around/expo-foundation/ui';

type NominatimItem = { place_id?: number; lat?: string; lon?: string; display_name?: string; name?: string };

const MIN_QUERY = 3;

export async function searchPlacesOsm(query: string, coords: { lat: number; lng: number } | null): Promise<VenueResult[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];
  const near = coords
    ? `&viewbox=${coords.lng - 1},${coords.lat + 1},${coords.lng + 1},${coords.lat - 1}`
    : '';
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=us&addressdetails=0${near}&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const items = (await res.json()) as NominatimItem[];
    return (Array.isArray(items) ? items : []).flatMap((it) => {
      const lat = Number(it.lat);
      const lng = Number(it.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !it.display_name) return [];
      const address = it.display_name;
      return [{ name: it.name || address.split(',')[0], address, lat, lng, placeId: `osm:${it.place_id ?? `${lat},${lng}`}` }];
    });
  } catch {
    return [];
  }
}
