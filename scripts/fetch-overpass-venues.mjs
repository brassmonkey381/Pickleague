#!/usr/bin/env node
// Fetch sport venues from the Overpass API (no osmium, no PBF download) and emit
// line-delimited GeoJSON on stdout — the same format load-osm-venues.mjs consumes.
// Pure Node 18+. Use this instead of ingest-osm-venues.sh when you don't have the
// osmium CLI (e.g. on Windows).
//
//   # a metro bounding box (south west north east) — recommended for a first run:
//   node scripts/fetch-overpass-venues.mjs 37.70 -122.55 37.85 -122.35 > venues.geojsonseq
//   # or a whole ISO area (may be large / time out on the public server):
//   node scripts/fetch-overpass-venues.mjs US-CA > venues.geojsonseq
//
// then load it (same loader as the osmium path):
//   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. node scripts/load-osm-venues.mjs venues.geojsonseq
//   # or key-free: SQL_OUT=./out node scripts/load-osm-venues.mjs venues.geojsonseq
//
// Overpass needs no API key but rate-limits; override the endpoint with OVERPASS_URL
// (e.g. a mirror like https://overpass.kumi.systems/api/interpreter).

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

// Broad filter (the loader refines to the sports we track precisely). Keep in sync
// with the osmium tags-filter in ingest-osm-venues.sh.
const SPORTS = 'basketball|pickleball|tennis|soccer|volleyball|beach_volleyball|baseball|softball|skateboard|disc_golf|bocce';

function buildQuery({ scope, area }) {
  const header = area
    ? `[out:json][timeout:300];\narea["ISO3166-2"="${area}"]->.a;`
    : `[out:json][timeout:180];`;
  const s = area ? '(area.a)' : scope;
  return `${header}
(
  nwr["leisure"="pitch"]${s};
  nwr["leisure"="sports_centre"]${s};
  nwr["leisure"="skatepark"]${s};
  nwr["leisure"="disc_golf_course"]${s};
  nwr["sport"~"${SPORTS}"]${s};
);
out center tags;`;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const nums = a.filter((x) => /^-?\d+(\.\d+)?$/.test(x));
  if (nums.length >= 4) {
    const [s, w, n, e] = nums.map(Number);
    return { scope: `(${s},${w},${n},${e})`, label: `bbox ${s},${w},${n},${e}` };
  }
  if (a[0]) return { area: a[0], label: `area ${a[0]}` };
  return null;
}

async function overpass(ql) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'pickleague-venue-ingest/1.0' },
      body: ql,
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const wait = 5000 * (attempt + 1);
      process.stderr.write(`Overpass ${res.status}; retrying in ${wait / 1000}s…\n`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Overpass ${res.status}: ${await res.text()}`);
  }
  throw new Error('Overpass failed after retries');
}

const TYPE_CHAR = { node: 'n', way: 'w', relation: 'r' };

// Overpass element (with `out center`) → a Feature line the loader understands.
// The loader keys off f.id ('n'|'w'|'r' + numeric id) + f.properties (tags) + a point.
function toFeatureLine(el) {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const tc = TYPE_CHAR[el.type];
  if (!tc) return null;
  return JSON.stringify({
    type: 'Feature',
    id: `${tc}${el.id}`,
    properties: el.tags ?? {},
    geometry: { type: 'Point', coordinates: [lon, lat] },
  });
}

async function main() {
  const args = parseArgs();
  if (!args) {
    process.stderr.write('Usage: node scripts/fetch-overpass-venues.mjs <south> <west> <north> <east> | <ISO-area, e.g. US-CA>\n');
    process.exit(1);
  }
  process.stderr.write(`Querying Overpass (${args.label})…\n`);
  const data = await overpass(buildQuery(args));
  let n = 0;
  for (const el of data.elements ?? []) {
    const line = toFeatureLine(el);
    if (line) { process.stdout.write(line + '\n'); n++; }
  }
  process.stderr.write(`Wrote ${n} feature(s) to stdout.\n`);
}

main().catch((e) => { process.stderr.write('\n' + e.message + '\n'); process.exit(1); });
