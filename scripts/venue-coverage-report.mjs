#!/usr/bin/env node
// Coverage report for the venues catalog: per-sport counts plus, for each field,
// how many rows have it populated as a % of total. Runs two read-only aggregates
// through the Supabase CLI (no service-role key needed) and writes
// scripts/venue-coverage-report.md. Ported from Doggle's osm-coverage-report.mjs.
//
//   node scripts/venue-coverage-report.mjs          # run from the repo root
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { SUPABASE_BIN as SB } from './lib/supabaseBin.mjs';

// label -> SQL predicate counted as "populated".
const FIELDS = [
  ['name', "name is not null and length(trim(name)) > 0"],
  ['address', 'address is not null'],
  ['city', 'city is not null'],
  ['region_slug', 'region_slug is not null'],
  ['surface', 'surface is not null'],
  ['indoor', 'indoor is not null'],
  ['lit', 'lit is true'],
  ['covered', 'covered is true'],
  ['hoops', 'hoops is not null'],
  ['court_count', 'court_count is not null'],
  ['access', 'access is not null'],
  ['fee', 'fee is not null'],
  ['operator', 'operator is not null'],
  ['website', 'website is not null'],
  ['phone', 'phone is not null'],
  ['opening_hours', 'opening_hours is not null'],
];

function q(sql) {
  const raw = execFileSync(SB, ['db', 'query', '--linked', sql, '-o', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw).rows;
}

const selects = FIELDS.map(([, pred], i) => `count(*) filter (where ${pred}) as f${i}`).join(', ');
const row = q(`select count(*) as total, ${selects} from public.venues`)[0];
const total = Number(row.total) || 0;

const sports = q(
  `select unnest(sport) as sport, count(*) as n from public.venues group by 1 order by 2 desc`,
);

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
  ...sports.map((s) => `| ${s.sport} | ${Number(s.n).toLocaleString()} |`),
  ``,
  `## Field coverage`,
  ``,
  `| Field | Populated | Coverage |`,
  `| --- | ---: | ---: |`,
];
FIELDS.forEach(([label], i) => {
  const n = Number(row[`f${i}`]) || 0;
  lines.push(`| ${label} | ${n.toLocaleString()} | ${pct(n)}% |`);
});
const out = lines.join('\n') + '\n';

writeFileSync('scripts/venue-coverage-report.md', out);
console.log(out);
console.error('Wrote scripts/venue-coverage-report.md');
