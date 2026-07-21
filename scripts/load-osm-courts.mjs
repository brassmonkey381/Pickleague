#!/usr/bin/env node
// Load OSM sports courts (from `osmium export -f geojsonseq`) into public.venues.
// Streams the file, keeps only basketball / pickleball courts, captures the useful
// OSM tags, and idempotently upserts via deterministic ids ('osm:<type>/<id>').
// Re-runnable. Ported from Doggle's scripts/load-osm-parks.mjs.
//
// Two write modes (no npm deps, Node 18+):
//   PostgREST (service-role key):
//     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/load-osm-courts.mjs courts.geojsonseq
//   SQL files (apply with the Supabase CLI; no key needed):
//     SQL_OUT=./out node scripts/load-osm-courts.mjs courts.geojsonseq
//     then: for f in out/chunk-*.sql; do supabase db query --linked -f "$f"; done
import { createReadStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SQL_OUT = process.env.SQL_OUT; // when set, emit SQL chunks instead of PostgREST upserts
const FILE = process.argv[2];
if (!FILE || (!SQL_OUT && (!URL || !KEY))) {
  console.error('Usage: (SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. | SQL_OUT=dir) node scripts/load-osm-courts.mjs <courts.geojsonseq>');
  process.exit(1);
}

const REST = URL ? `${URL.replace(/\/+$/, '')}/rest/v1` : null;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// Which sports we care about. A venue can host more than one (sport=basketball;volleyball).
const WANTED = new Set(['basketball', 'pickleball']);

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

// OSM tags → the sports we track. Handles multi-value sport (";" or ","), and the
// common pickleball taggings: sport=pickleball, sport=tennis;pickleball, or a
// tennis court flagged pickleball=yes.
function sportsFor(t) {
  const set = new Set();
  const vals = String(t.sport ?? '').toLowerCase().split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (vals.includes('basketball')) set.add('basketball');
  if (vals.includes('pickleball')) set.add('pickleball');
  if (parseBool(t.pickleball) === true) set.add('pickleball'); // tennis court that also offers pickleball
  return [...set];
}

function kindFor(t) {
  if (t.leisure === 'sports_centre') return 'sports_centre';
  if (t.building === 'sports_hall' || t.building === 'sports_centre') return 'gym';
  return 'court';
}

const TYPE = { n: 'node', w: 'way', r: 'relation' };

function rowFor(f, regions) {
  const t = f.properties ?? {};
  const name = (t.name ?? '').trim();
  if (!name) return null;                       // unnamed courts aren't useful in a picker
  const sport = sportsFor(t);
  if (sport.length === 0) return null;          // not a sport we track
  const c = centroid(f.geometry);
  if (!c) return null;
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
    kind: kindFor(t),
    lat: c.lat,
    lng: c.lng,
    address: t['addr:street'] ? `${t['addr:housenumber'] ?? ''} ${t['addr:street']}`.trim() : null,
    city: t['addr:city'] ?? null,
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
  'id', 'sport', 'name', 'kind', 'lat', 'lng', 'address', 'city', 'region_slug',
  'surface', 'indoor', 'lit', 'covered', 'hoops', 'court_count', 'access', 'fee',
  'operator', 'website', 'phone', 'opening_hours', 'source', 'external_id',
  'source_url', 'attribution', 'confirmation_status',
];
const BOOL_COLS = new Set(['indoor', 'lit', 'covered', 'fee']);
const NUM_COLS = new Set(['lat', 'lng', 'hoops', 'court_count']);
const sqlStr = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
function sqlVal(col, r) {
  const v = r[col];
  if (col === 'sport') return v && v.length ? `ARRAY[${v.map(sqlStr).join(',')}]::text[]` : `'{}'::text[]`;
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
  const rl = createInterface({ input: createReadStream(FILE), crlfDelay: Infinity });

  // osmium emits a closed way twice — once as a LineString and once as an area —
  // and both decode to the same osm id. Dedup by id; a later feature merges tags.
  const byId = new Map();
  let skipped = 0;
  for await (let line of rl) {
    line = line.replace(/^\x1e/, '').trim(); // RFC 8142 record separator
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    const row = rowFor(f, regions);
    if (!row) { skipped++; continue; }
    const prev = byId.get(row.id);
    // Prefer the richer row (more non-null attributes) when the same id repeats.
    if (!prev || countFilled(row) > countFilled(prev)) byId.set(row.id, row);
  }

  const rows = [...byId.values()];
  const CHUNK = Number(process.env.CHUNK_ROWS) || (SQL_OUT ? 400 : 1000);
  let total = 0, bball = 0, pball = 0, withRegion = 0, chunk = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    if (SQL_OUT) {
      writeFileSync(join(SQL_OUT, `chunk-${String(chunk).padStart(4, '0')}.sql`), chunkSql(batch));
      chunk++;
    } else {
      await upsert(batch);
    }
    total += batch.length;
    bball += batch.filter((r) => r.sport.includes('basketball')).length;
    pball += batch.filter((r) => r.sport.includes('pickleball')).length;
    withRegion += batch.filter((r) => r.region_slug).length;
    process.stdout.write(`\r${SQL_OUT ? 'Wrote' : 'Upserted'} ${total} venues…`);
  }
  console.log(`\nDone. ${total} venues (basketball ${bball}, pickleball ${pball}, region-assigned ${withRegion}), skipped ${skipped}.`);
  if (SQL_OUT) console.log(`Wrote ${chunk} SQL chunk(s) to ${SQL_OUT}.`);
}

function countFilled(r) {
  let n = 0;
  for (const c of COLS) if (r[c] != null && !(Array.isArray(r[c]) && r[c].length === 0)) n++;
  return n;
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
