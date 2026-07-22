#!/usr/bin/env node
// Fill pickleball/tennis/basketball court gaps from Google Places (New) Text Search,
// ToS-compliantly (mirrors Doggle's ingest-google-businesses.mjs):
//   • stores place_id (external_id) long-term — allowed forever;
//   • display fields are a 30-day PERFORMANCE CACHE (details_expires_at); re-run to
//     refresh, or --purge-expired drops stale google rows;
//   • field-masked to the cheapest set we use; attribution stored per row;
//   • dedups against existing (OSM/user) venues so we never duplicate a court.
//
// A bbox is tiled into overlapping search circles. --dry-run prints the planned
// call count + a cost estimate and spends NOTHING (no Google key needed).
//
//   # cost preview (no spend, no key needed) — greater Bay Area is the default bbox:
//   node scripts/ingest-google-venues.mjs --dry-run
//   # real run:
//   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. GOOGLE_PLACES_KEY=.. \
//     node scripts/ingest-google-venues.mjs --bbox "37.2 -122.6 38.1 -121.6"
//   # drop stale google rows past their 30-day cache:
//   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. node scripts/ingest-google-venues.mjs --purge-expired
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const SUPA_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GKEY = process.env.GOOGLE_PLACES_KEY || process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY;
const DRY = flag('--dry-run');
const PURGE = flag('--purge-expired');
const WITH_CONTACT = flag('--with-contact'); // add website/phone → Enterprise SKU (pricier, smaller free cap)
// Greater Bay Area default bbox (south west north east).
const BBOX = (opt('--bbox', '37.2 -122.6 38.1 -121.6') || '').split(/\s+/).map(Number);
const TILE_KM = Math.max(2, Number(opt('--tile-km', '8')));
const MAX_PAGES = Math.max(1, Number(opt('--max-pages', '3'))); // Google caps Text Search at 60 (3 pages)
const SPORTS = (opt('--sports', 'pickleball,tennis,basketball') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TTL_DAYS = 30;
// Text Search SKU: default field mask = PRO (5,000 free calls/mo, then $32/1k);
// --with-contact = ENTERPRISE (1,000 free/mo, $35/1k).
const FREE_CAP = WITH_CONTACT ? 1000 : 5000;
const PER_1K = WITH_CONTACT ? 35 : 32;
const TIER = WITH_CONTACT ? 'Enterprise' : 'Pro';

// The mask sets the SKU. Default = Text Search PRO (id/name/address/location).
// --with-contact adds website/phone → Enterprise (pricier, 1/5th the free cap).
// Ratings are Enterprise+Atmosphere and we don't store them, so never requested.
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  ...(WITH_CONTACT ? ['places.websiteUri', 'places.nationalPhoneNumber'] : []),
  'nextPageToken',
].join(',');

// Tile a bbox into a grid of circle centers spaced ~TILE_KM apart (with overlap
// via a radius of TILE_KM * 0.75). Returns { center_lat, center_lng, radius_m }[].
function tiles([s, w, n, e]) {
  const latStepKm = TILE_KM, kmPerLat = 110.574;
  const midLat = (s + n) / 2, kmPerLng = 111.32 * Math.cos((midLat * Math.PI) / 180);
  const dLat = latStepKm / kmPerLat, dLng = TILE_KM / kmPerLng;
  const out = [];
  for (let lat = s + dLat / 2; lat < n + dLat / 2; lat += dLat) {
    for (let lng = w + dLng / 2; lng < e + dLng / 2; lng += dLng) {
      out.push({ center_lat: lat, center_lng: lng, radius_m: TILE_KM * 1000 * 0.75 });
    }
  }
  return out;
}

function bboxOk(b) {
  return b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
}

async function main() {
  if (!bboxOk(BBOX)) {
    console.error('Bad --bbox. Use: --bbox "south west north east" (e.g. "37.2 -122.6 38.1 -121.6").');
    process.exitCode = 1;
    return;
  }
  const grid = tiles(BBOX);
  const maxCalls = grid.length * SPORTS.length * MAX_PAGES;

  if (DRY) {
    console.log(`DRY RUN — no Google calls, nothing written.`);
    console.log(`bbox ${BBOX.join(' ')} → ${grid.length} tiles (${TILE_KM} km) × ${SPORTS.length} sports (${SPORTS.join(', ')}) × up to ${MAX_PAGES} pages`);
    console.log(`= up to ${maxCalls} Text Search ${TIER} calls (realistic: far fewer — most tiles return 1 page).`);
    if (maxCalls <= FREE_CAP) {
      console.log(`Text Search ${TIER} includes ${FREE_CAP.toLocaleString()} FREE calls/month — this whole run fits FREE (worst case ${maxCalls} ≤ ${FREE_CAP.toLocaleString()}).`);
    } else {
      console.log(`Text Search ${TIER} free cap is ${FREE_CAP.toLocaleString()}/month; worst case ${maxCalls} could exceed it (overage ~$${PER_1K}/1k). Actual is usually well under — narrow --sports / --bbox / raise --tile-km to stay free.`);
    }
    console.log(`Re-run without --dry-run to ingest.`);
    return;
  }

  if (!SUPA_URL || !KEY || (!PURGE && !GKEY)) {
    console.error('Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY' + (PURGE ? '' : ', GOOGLE_PLACES_KEY'));
    process.exitCode = 1;
    return;
  }
  const REST = `${SUPA_URL.replace(/\/+$/, '')}/rest/v1`;
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const kmMeters = (aLat, aLng, bLat, bLng) => {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  if (PURGE) {
    const res = await fetch(`${REST}/venues?source=eq.google&details_expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, {
      method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' },
    });
    if (!res.ok) throw new Error(`purge ${res.status}: ${await res.text()}`);
    console.log('Purged expired google venue rows.');
    return;
  }

  // Existing venues in the bbox (any source) for physical dedup.
  const [s, w, n, e] = BBOX;
  const exRes = await fetch(
    `${REST}/venues?select=lat,lng&lat=gte.${s}&lat=lte.${n}&lng=gte.${w}&lng=lte.${e}&limit=20000`,
    { headers: H },
  );
  const existing = exRes.ok ? await exRes.json() : [];
  console.log(`${grid.length} tiles × ${SPORTS.length} sports; ${existing.length} existing venues to dedup against.`);

  async function searchPage(textQuery, tile, pageToken) {
    const body = {
      textQuery,
      locationBias: { circle: { center: { latitude: tile.center_lat, longitude: tile.center_lng }, radius: tile.radius_m } },
      pageSize: 20,
      ...(pageToken ? { pageToken } : {}),
    };
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GKEY, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function upsert(rows) {
    const res = await fetch(`${REST}/venues?on_conflict=id`, {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`upsert ${res.status}: ${await res.text()}`);
  }

  const expires = new Date(Date.now() + TTL_DAYS * 864e5).toISOString();
  const now = new Date().toISOString();
  const seen = new Set(); // place ids added this run
  let added = 0, skipped = 0, calls = 0;

  for (const tile of grid) {
    for (const sport of SPORTS) {
      const query = `${sport} court`;
      const batch = [];
      let token = null, pages = 0;
      do {
        const data = await searchPage(query, tile, token);
        calls++;
        for (const p of data.places ?? []) {
          const name = p.displayName?.text?.trim();
          const lat = p.location?.latitude, lng = p.location?.longitude;
          if (!p.id || !name || lat == null) continue;
          if (seen.has(p.id)) continue;
          // Physical dedup: skip within 100 m of any existing venue.
          if (existing.some((x) => x.lat != null && kmMeters(lat, lng, x.lat, x.lng) < 100)) { skipped++; continue; }
          seen.add(p.id);
          existing.push({ lat, lng }); // dedup subsequent tiles/sports against it too
          batch.push({
            id: `g:${p.id}`,
            sport: [sport],
            name,
            kind: 'court',
            lat, lng,
            address: p.formattedAddress ?? null,
            website: p.websiteUri ?? null,
            phone: p.nationalPhoneNumber ?? null,
            source: 'google',
            external_id: p.id,
            source_url: `https://www.google.com/maps/place/?q=place_id:${p.id}`,
            attribution: 'Listing data © Google',
            confirmation_status: 'confirmed',
            last_refreshed_at: now,
            details_expires_at: expires,
          });
        }
        token = data.nextPageToken ?? null;
        pages++;
        if (token) await sleep(1500);
      } while (token && pages < MAX_PAGES);
      if (batch.length) await upsert(batch);
      added += batch.length;
    }
    process.stdout.write(`\rTiles done: ${grid.indexOf(tile) + 1}/${grid.length} · added ${added} · ${calls} calls`);
  }
  const overage = Math.max(0, calls - FREE_CAP);
  console.log(`\nDone. Added ${added} google venues, skipped ${skipped} dupes. ${calls} Text Search ${TIER} calls (${FREE_CAP.toLocaleString()} free/mo${overage ? `; ~${overage} over ≈ $${((overage * PER_1K) / 1000).toFixed(2)}` : ' — free'}).`);
}

main().catch((err) => { console.error('\n' + (err.message?.includes('401') ? '401 — check keys' : err.message)); process.exitCode = 1; });
