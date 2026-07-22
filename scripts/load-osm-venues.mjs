#!/usr/bin/env node
// Load OSM sports venues (courts / fields / skateparks / complexes) into public.venues.
// Streams an `osmium export -f geojsonseq` file, keeps only the sports we track,
// captures the useful OSM tags, and idempotently upserts via deterministic ids
// ('osm:<type>/<id>'). Re-runnable. Ported from Doggle's scripts/load-osm-parks.mjs.
//
// Adding a sport is a one-line change: add it to SPORT_ALIASES below (and to the
// osmium tags-filter in ingest-osm-venues.sh so the extract includes it). The DB
// needs no change — venues.sport is text[] and the search/radius RPCs are generic.
//
// Two write modes (no npm deps, Node 18+):
//   PostgREST (service-role key):
//     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/load-osm-venues.mjs venues.geojsonseq
//   SQL files (apply with the Supabase CLI; no key needed):
//     SQL_OUT=./out node scripts/load-osm-venues.mjs venues.geojsonseq
//     then: for f in out/chunk-*.sql; do supabase db query --linked -f "$f"; done
import { createReadStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SQL_OUT = process.env.SQL_OUT; // when set, emit SQL chunks instead of PostgREST upserts
const DRY_RUN = !!process.env.DRY_RUN; // parse + summarize only; write nothing
const FILE = process.argv[2]; // omit or "-" to read geojsonseq from stdin (pipe mode)
if (!DRY_RUN && !SQL_OUT && (!URL || !KEY)) {
  console.error('Usage: (SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. | SQL_OUT=dir | DRY_RUN=1) node scripts/load-osm-venues.mjs [venues.geojsonseq]');
  console.error('  Omit the file (or pass "-") to read from stdin, e.g.  fetch-overpass-venues.mjs … | load-osm-venues.mjs');
  process.exit(1);
}

const REST = URL ? `${URL.replace(/\/+$/, '')}/rest/v1` : null;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// ── Sport registry: canonical sport → the OSM `sport=` tag values that map to it.
// A venue can host several (sport=basketball;volleyball). To add a sport, add a row
// here + the tag to ingest-osm-venues.sh. Special taggings that don't use `sport=`
// are handled in sportsFor() below.
const SPORT_ALIASES = {
  basketball: ['basketball'],
  pickleball: ['pickleball'],
  tennis:     ['tennis'],
  soccer:     ['soccer'],
  volleyball: ['volleyball', 'beach_volleyball'],
  baseball:   ['baseball'],
  softball:   ['softball'],
  skateboard: ['skateboard'],
  disc_golf:  ['disc_golf', 'discgolf'],
  bocce:      ['bocce'],
};

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function getRegions() {
  // SQL mode: read a {slug,center_lat,center_lng}[] snapshot dumped via the CLI.
  if (process.env.REGIONS_FILE) return JSON.parse(readFileSync(process.env.REGIONS_FILE, 'utf8'));
  if (!REST) return [];
  const res = await fetch(`${REST}/venue_regions?select=slug,center_lat,center_lng&center_lat=not.is.null`, { headers: HEADERS });
  if (!res.ok) throw new Error(`regions ${res.status}: ${await res.text()}`);
  return res.json();
}

function nearestRegion(lat, lng, regions) {
  let best = null, bestKm = 80; // cap (km)
  for (const r of regions) {
    if (Math.abs(r.center_lat - lat) > 0.8 || Math.abs(r.center_lng - lng) > 0.9) continue;
    const km = haversineKm(lat, lng, r.center_lat, r.center_lng);
    if (km < bestKm) { bestKm = km; best = r.slug; }
  }
  return best;
}

// Representative point = bbox center of all coordinates (handles point/line/polygon).
function centroid(geometry) {
  if (!geometry) return null;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, seen = false;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      const [lng, lat] = c;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      seen = true;
    } else for (const x of c) walk(x);
  };
  walk(geometry.coordinates);
  return seen ? { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 } : null;
}

function parseBool(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (['yes', 'true', '1', 'designated'].includes(s)) return true;
  if (['no', 'false', '0'].includes(s)) return false;
  return null;
}

function parseIntOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// OSM tags → the canonical sports a venue offers. Handles multi-value `sport`
// (";"/"," separated) plus taggings that don't use `sport=`:
//   - pickleball on a tennis court flagged pickleball=yes
//   - skateparks (leisure=skatepark) and disc-golf courses (leisure=disc_golf_course),
//     which frequently carry no sport= tag at all.
function sportsFor(t) {
  const set = new Set();
  const vals = String(t.sport ?? '').toLowerCase().split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  for (const [canon, aliases] of Object.entries(SPORT_ALIASES)) {
    if (aliases.some((a) => vals.includes(a))) set.add(canon);
  }
  if (parseBool(t.pickleball) === true) set.add('pickleball');
  if (t.leisure === 'skatepark') set.add('skateboard');
  if (t.leisure === 'disc_golf_course') set.add('disc_golf');
  return [...set];
}

function kindFor(t) {
  if (t.leisure === 'skatepark') return 'skatepark';
  if (t.leisure === 'disc_golf_course') return 'disc_golf_course';
  if (t.leisure === 'sports_centre') return 'sports_centre';
  if (t.building === 'sports_hall' || t.building === 'sports_centre') return 'gym';
  if (t.leisure === 'pitch') return 'pitch';
  return 'court';
}

// Geofence radius (m) for point-only venues, by kind. A real polygon boundary
// (from an osmium area) overrides this — it's the fallback when we only have a
// point. 100 m floor (GPS wobble); bigger for large venues.
function geofenceRadiusFor(kind) {
  switch (kind) {
    case 'disc_golf_course': return 250;
    case 'park': return 150;
    default: return 100; // court / pitch / sports_centre / gym / skatepark
  }
}

// Keep the boundary polygon for areas only; trim precision (~1 m) and skip giants.
const round5 = (x) => Math.round(x * 1e5) / 1e5;
function reduceCoords(coords) {
  return typeof coords[0] === 'number' ? [round5(coords[0]), round5(coords[1])] : coords.map(reduceCoords);
}
function countCoords(coords) {
  if (typeof coords[0] === 'number') return 1;
  let n = 0;
  for (const x of coords) n += countCoords(x);
  return n;
}
function boundaryFor(geom) {
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null;
  if (countCoords(geom.coordinates) > 30000) return null;
  return { type: geom.type, coordinates: reduceCoords(geom.coordinates) };
}

const TYPE = { n: 'node', w: 'way', r: 'relation' };

function rowFor(f, regions) {
  const t = f.properties ?? {};
  const name = (t.name ?? '').trim();
  if (!name) return null;                       // unnamed venues aren't useful in a picker
  const sport = sportsFor(t);
  if (sport.length === 0) return null;          // not a sport we track
  const c = centroid(f.geometry);
  if (!c) return null;
  const kind = kindFor(t);
  // osmium ids: n=node, w=open way, r=relation, a=area. Area ids encode their
  // source: even = way (id/2), odd = relation ((id-1)/2). Decode back to OSM type/id.
  const m = String(f.id ?? '').match(/^([anwr])(\d+)$/);
  if (!m) return null;
  let type, id;
  if (m[1] === 'a') {
    const n = BigInt(m[2]);
    if (n % 2n === 0n) { type = 'way'; id = (n / 2n).toString(); }
    else { type = 'relation'; id = ((n - 1n) / 2n).toString(); }
  } else {
    type = TYPE[m[1]]; id = m[2];
  }
  return {
    id: `osm:${type}/${id}`,
    sport,
    name,
    kind,
    lat: c.lat,
    lng: c.lng,
    boundary: boundaryFor(f.geometry),
    geofence_radius_m: geofenceRadiusFor(kind),
    address: t['addr:street'] ? `${t['addr:housenumber'] ?? ''} ${t['addr:street']}`.trim() : null,
    // city is owned by the offline geocoder (backfill_venue_cities) — NOT written
    // here, so re-running this loader never clobbers the geocoded city.
    region_slug: nearestRegion(c.lat, c.lng, regions),
    surface: t.surface ?? null,
    indoor: parseBool(t.indoor),
    lit: parseBool(t.lit),
    covered: parseBool(t.covered),
    hoops: parseIntOrNull(t.hoops),
    court_count: parseIntOrNull(t.pitches),
    access: t.access ?? null,
    fee: parseBool(t.fee),
    operator: t.operator ?? null,
    website: t.website ?? t['contact:website'] ?? null,
    phone: t.phone ?? t['contact:phone'] ?? null,
    opening_hours: t.opening_hours ?? null,
    source: 'osm',
    external_id: `${type}/${id}`,
    source_url: `https://www.openstreetmap.org/${type}/${id}`,
    attribution: '© OpenStreetMap contributors',
    confirmation_status: 'confirmed',
  };
}

// ── SQL emitter ─────────────────────────────────────────────────────────────
const COLS = [
  'id', 'sport', 'name', 'kind', 'lat', 'lng', 'address', 'region_slug',
  'surface', 'indoor', 'lit', 'covered', 'hoops', 'court_count', 'access', 'fee',
  'operator', 'website', 'phone', 'opening_hours', 'source', 'external_id',
  'source_url', 'attribution', 'confirmation_status', 'boundary', 'geofence_radius_m',
];
const BOOL_COLS = new Set(['indoor', 'lit', 'covered', 'fee']);
const NUM_COLS = new Set(['lat', 'lng', 'hoops', 'court_count', 'geofence_radius_m']);
const sqlStr = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
function sqlVal(col, r) {
  const v = r[col];
  if (col === 'sport') return v && v.length ? `ARRAY[${v.map(sqlStr).join(',')}]::text[]` : `'{}'::text[]`;
  if (col === 'boundary') return v ? `${sqlStr(JSON.stringify(v))}::jsonb` : 'NULL';
  if (NUM_COLS.has(col)) return v == null ? 'NULL' : String(v);
  if (BOOL_COLS.has(col)) return v == null ? 'NULL' : v ? 'true' : 'false';
  return sqlStr(v);
}
function chunkSql(rows) {
  const values = rows.map((r) => `(${COLS.map((c) => sqlVal(c, r)).join(',')})`).join(',\n');
  const updates = COLS.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(', ');
  return `insert into public.venues (${COLS.join(',')}) values\n${values}\non conflict (id) do update set ${updates};\n`;
}

async function upsert(rows) {
  const res = await fetch(`${REST}/venues?on_conflict=id`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert ${res.status}: ${await res.text()}`);
}

async function main() {
  const regions = await getRegions();
  console.log(`Loaded ${regions.length} region(s).`);
  if (SQL_OUT) mkdirSync(SQL_OUT, { recursive: true });
  const input = (!FILE || FILE === '-') ? process.stdin : createReadStream(FILE);
  const rl = createInterface({ input, crlfDelay: Infinity });

  // osmium emits a closed way twice — once as a LineString and once as an area —
  // and both decode to the same osm id. Dedup by id, keeping the richer row.
  const byId = new Map();
  const perSport = {};
  let skipped = 0;
  for await (let line of rl) {
    line = line.replace(/^\x1e/, '').trim(); // RFC 8142 record separator
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    const row = rowFor(f, regions);
    if (!row) { skipped++; continue; }
    const prev = byId.get(row.id);
    if (!prev || countFilled(row) > countFilled(prev)) byId.set(row.id, row);
  }

  const rows = [...byId.values()];
  for (const r of rows) for (const s of r.sport) perSport[s] = (perSport[s] ?? 0) + 1;
  const CHUNK = Number(process.env.CHUNK_ROWS) || (SQL_OUT ? 400 : 1000);
  let total = 0, withRegion = 0, chunk = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    if (DRY_RUN) {
      // no writes — just tally
    } else if (SQL_OUT) {
      writeFileSync(join(SQL_OUT, `chunk-${String(chunk).padStart(4, '0')}.sql`), chunkSql(batch));
      chunk++;
    } else {
      await upsert(batch);
    }
    total += batch.length;
    withRegion += batch.filter((r) => r.region_slug).length;
    process.stdout.write(`\r${DRY_RUN ? 'Parsed' : SQL_OUT ? 'Wrote' : 'Upserted'} ${total} venues…`);
  }
  const breakdown = Object.entries(perSport).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ');
  console.log(`\n${DRY_RUN ? 'DRY RUN — nothing written. ' : 'Done. '}${total} venues (region-assigned ${withRegion}), skipped ${skipped}.`);
  console.log(`By sport: ${breakdown || '(none)'}`);
  if (SQL_OUT) console.log(`Wrote ${chunk} SQL chunk(s) to ${SQL_OUT}.`);
}

function countFilled(r) {
  let n = 0;
  for (const c of COLS) if (r[c] != null && !(Array.isArray(r[c]) && r[c].length === 0)) n++;
  return n;
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
