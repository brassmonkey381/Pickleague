#!/usr/bin/env node
// Coverage report for the venues catalog: per-sport counts + per-field coverage %.
// Reads the rows via PostgREST using the service-role OR anon key (venues is
// world-readable, so either works) — no Supabase CLI needed. Writes
// scripts/venue-coverage-report.md.
//
//   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=..  node scripts/venue-coverage-report.mjs
//   SUPABASE_URL=.. SUPABASE_ANON_KEY=..          node scripts/venue-coverage-report.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Write next to this script regardless of cwd (the toolbox runs it from scripts/).
const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'venue-coverage-report.md');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).');
  process.exit(1);
}
const REST = `${URL.replace(/\/+$/, '')}/rest/v1`;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// label -> [column, mode]. mode: 'name' (non-blank), 'true' (=== true), else non-null.
const FIELDS = [
  ['name', ['name', 'name']],
  ['address', ['address']],
  ['city', ['city']],
  ['region_slug', ['region_slug']],
  ['surface', ['surface']],
  ['indoor', ['indoor']],
  ['lit', ['lit', 'true']],
  ['covered', ['covered', 'true']],
  ['hoops', ['hoops']],
  ['court_count', ['court_count']],
  ['access', ['access']],
  ['fee', ['fee']],
  ['operator', ['operator']],
  ['website', ['website']],
  ['phone', ['phone']],
  ['opening_hours', ['opening_hours']],
];
const COLS = ['sport', ...FIELDS.map(([, [col]]) => col)];

function populated(v, mode) {
  if (mode === 'name') return v != null && String(v).trim().length > 0;
  if (mode === 'true') return v === true;
  return v != null;
}

async function fetchAllVenues() {
  const PAGE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${REST}/venues?select=${COLS.join(',')}&limit=${PAGE}&offset=${offset}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`venues ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

// Cheap exact count via PostgREST's Content-Range (no rows fetched).
async function countWhere(filter) {
  const res = await fetch(`${REST}/venues?select=id&${filter}`, {
    headers: { ...HEADERS, Prefer: 'count=exact', Range: '0-0' },
  });
  const total = (res.headers.get('content-range') || '').split('/')[1];
  return Number(total) || 0;
}

async function main() {
  const rows = await fetchAllVenues();
  const total = rows.length;

  // per-sport counts (sport is text[])
  const bySport = new Map();
  for (const r of rows) for (const s of r.sport ?? []) bySport.set(s, (bySport.get(s) ?? 0) + 1);
  const sports = [...bySport.entries()].sort((a, b) => b[1] - a[1]);

  // geofences (counted server-side so we never fetch the boundary jsonb)
  const [withBoundary, withRadius] = await Promise.all([
    countWhere('boundary=not.is.null'),
    countWhere('geofence_radius_m=not.is.null'),
  ]);

  const pct = (n) => (total ? ((100 * n) / total).toFixed(1) : '0.0');
  const lines = [
    `# Venue catalog coverage`,
    ``,
    `Source: \`public.venues\`. Total rows: **${total.toLocaleString()}**.`,
    ``,
    `## By sport`,
    ``,
    `| Sport | Venues |`,
    `| --- | ---: |`,
    ...sports.map(([s, n]) => `| ${s} | ${n.toLocaleString()} |`),
    ``,
    `## Field coverage`,
    ``,
    `| Field | Populated | Coverage |`,
    `| --- | ---: | ---: |`,
  ];
  for (const [label, [col, mode]] of FIELDS) {
    const n = rows.reduce((acc, r) => acc + (populated(r[col], mode) ? 1 : 0), 0);
    lines.push(`| ${label} | ${n.toLocaleString()} | ${pct(n)}% |`);
  }
  lines.push(
    ``,
    `## Geofences`,
    ``,
    `| Geofence | Venues | Coverage |`,
    `| --- | ---: | ---: |`,
    `| polygon boundary | ${withBoundary.toLocaleString()} | ${pct(withBoundary)}% |`,
    `| radius fallback | ${withRadius.toLocaleString()} | ${pct(withRadius)}% |`,
  );
  const out = lines.join('\n') + '\n';

  // Print the table first so a write hiccup can never hide it.
  console.log(out);
  try {
    writeFileSync(OUT_PATH, out);
    console.error('Wrote ' + OUT_PATH);
  } catch (e) {
    console.error('(could not write md file: ' + e.message + ')');
  }
}

main().catch((e) => {
  console.error('\n' + e.message);
  process.exitCode = 1; // not process.exit() — avoids the Windows libuv crash mid-fetch
});
