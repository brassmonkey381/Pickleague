export type Region = {
  name: string;
  minLat: number; maxLat: number;
  minLng: number; maxLng: number;
};

// Bay Area sub-regions defined by bounding boxes
export const REGIONS: Region[] = [
  { name: 'San Francisco', minLat: 37.70, maxLat: 37.83, minLng: -122.53, maxLng: -122.35 },
  { name: 'East Bay',      minLat: 37.55, maxLat: 37.95, minLng: -122.35, maxLng: -121.75 },
  { name: 'Peninsula',     minLat: 37.38, maxLat: 37.70, minLng: -122.50, maxLng: -122.10 },
  { name: 'South Bay',     minLat: 37.15, maxLat: 37.44, minLng: -122.25, maxLng: -121.65 },
  { name: 'North Bay',     minLat: 37.83, maxLat: 38.50, minLng: -123.00, maxLng: -122.20 },
];

export function getRegionName(lat: number | null, lng: number | null): string | null {
  if (!lat || !lng) return null;
  return REGIONS.find(r => lat >= r.minLat && lat <= r.maxLat && lng >= r.minLng && lng <= r.maxLng)?.name ?? null;
}

export function inRegion(lat: number | null, lng: number | null, regionName: string): boolean {
  const r = REGIONS.find(x => x.name === regionName);
  if (!r || lat == null || lng == null) return false;
  return lat >= r.minLat && lat <= r.maxLat && lng >= r.minLng && lng <= r.maxLng;
}
