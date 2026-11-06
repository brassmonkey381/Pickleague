#!/usr/bin/env node
// Import a marketing-studio seed batch of outside events
// (supabase/migration_outside_events.sql) into public.outside_events.
// Ported from doggle/scripts/import-outside-events.mjs.
//
//   node scripts/import-outside-events.mjs <seed.csv>          dry run: prints what it would do
//   node scripts/import-outside-events.mjs <seed.csv> --apply  writes them (linked project)
//
// CSV columns (agreed with marketing-studio, 2026-11-06):
//   title,starts_at,ends_at,place_name,place_address,organizer,source_name,source_url,summary,kind
// starts_at / ends_at are ISO 8601 with an offset; ends_at may be blank.
// kind: 1 or 2 of open_play | round_robin | clinic | ladder | tournament | social, joined by "|".
//
// Each place is looked up with Google Places Text Search
// (EXPO_PUBLIC_GOOGLE_PLACES_KEY from mobile/.env, never printed) for its
// coordinates. The server pins the event to the nearest Pickleague court
// within 150 m of them (_pl_outside_event_venue); the dry run shows which. A
// row whose address has no street number (e.g. "Oakland, CA") is skipped and
// reported: it would put the event on a city's middle. Dedupe is the
// server's: the same (source_url, starts_at) is skipped, and a page an
// organizer asked us to take down is refused (_pl_save_outside_event).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE = 'C:/Users/Brian/tools/supabase/supabase.exe';
const KINDS = ['open_play', 'round_robin', 'clinic', 'ladder', 'tournament', 'social'];
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const csvPath = args.find((a) => !a.startsWith('--'));
if (!csvPath) {
  console.error('FAILED: pass the seed CSV path (exit 2)');
  process.exit(2);
}

/** RFC 4180-ish: quoted fields, doubled quotes, commas inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^\uFEFF/, '').trim(), (r[i] ?? '').trim()])));
}

function envKey() {
  const env = fs.readFileSync(path.join(ROOT, 'mobile/.env'), 'utf8');
  const m = env.match(/^EXPO_PUBLIC_GOOGLE_PLACES_KEY=(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

async function findPlace(key, query) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
  });
  if (!res.ok) throw new Error(`Places search failed: HTTP ${res.status}`);
  const p = (await res.json()).places?.[0];
  if (!p?.location) return null;
  return { name: p.displayName?.text ?? null, address: p.formattedAddress ?? null, lat: p.location.latitude, lng: p.location.longitude };
}

/** One read-only query on the linked project, as rows. */
function sqlRows(q) {
  const r = spawnSync(SUPABASE, ['db', 'query', '--linked', q, '-o', 'json'], { cwd: ROOT, encoding: 'utf8' });
  const text = (r.stdout ?? '').trim();
  if (r.status !== 0) throw new Error(`query failed (exit ${r.status}): ${(r.stderr ?? '').slice(0, 500)}`);
  const at = text.search(/[[{]/);
  if (at < 0) return [];
  const j = JSON.parse(text.slice(at));
  return Array.isArray(j) ? j : j.rows ?? [];
}

const lit = (v) => (v == null || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const hasStreet = (addr) => /\d/.test((addr ?? '').split(',')[0] ?? '');

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const key = envKey();
if (!key) {
  console.error('FAILED: EXPO_PUBLIC_GOOGLE_PLACES_KEY is not in mobile/.env (exit 2)');
  process.exit(2);
}

const skipped = [];
const stmts = [];
const places = new Map(); // one lookup per place
for (const r of rows) {
  const label = `${r.title} (${r.starts_at})`;
  if (!r.title || !r.starts_at || !r.source_url || !r.source_name) {
    skipped.push(`${label}: missing title, start, source or link`);
    continue;
  }
  const kinds = [...new Set((r.kind ?? '').split('|').map((k) => k.trim().toLowerCase()).filter(Boolean))];
  if (kinds.length < 1 || kinds.length > 2 || kinds.some((k) => !KINDS.includes(k))) {
    skipped.push(`${label}: kind must be 1 or 2 of ${KINDS.join(', ')} ("${r.kind}")`);
    continue;
  }
  if (!hasStreet(r.place_address)) {
    skipped.push(`${label}: no street address ("${r.place_address}")`);
    continue;
  }
  const query = `${r.place_name}, ${r.place_address}`;
  if (!places.has(query)) {
    const p = await findPlace(key, query);
    let court = null;
    if (p) {
      [court] = sqlRows(`select v.name, round(public.haversine_meters(v.lat, v.lng, ${p.lat}, ${p.lng}))::int as m
          from public.venues v
         where v.sport @> array['pickleball']
           and v.lat between ${p.lat - 0.002} and ${p.lat + 0.002} and v.lng between ${p.lng - 0.003} and ${p.lng + 0.003}
           and public.haversine_meters(v.lat, v.lng, ${p.lat}, ${p.lng}) <= 150
         order by 2 limit 1`);
    }
    places.set(query, p ? { ...p, court } : null);
  }
  const p = places.get(query);
  if (!p) {
    skipped.push(`${label}: Google found no place for "${query}"`);
    continue;
  }
  stmts.push(`select ${lit(label)} as event, coalesce(public._pl_save_outside_event(
  null, ${lit(r.title)}, ${lit(r.starts_at)}::timestamptz, ${r.ends_at ? `${lit(r.ends_at)}::timestamptz` : 'null'},
  array[${kinds.map(lit).join(', ')}]::text[], ${lit(r.summary)}, ${lit(r.organizer)}, ${lit(r.source_name)}, ${lit(r.source_url)},
  ${lit(r.place_name)}, ${lit(r.place_address)}, ${p.lat}, ${p.lng}, null, null, true)::text, 'already listed') as result`);
  const where = p.court ? `court "${p.court.name}" (${p.court.m} m)` : 'no Pickleague court within 150 m';
  console.log(`ok   ${label} -> ${p.address ?? '?'}; ${where}`);
}

for (const s of skipped) console.log(`skip ${s}`);
if (stmts.length === 0) {
  console.log('nothing to import');
  process.exit(0);
}
const sql = stmts.join('\nunion all\n') + ';\n';
const out = path.join(os.tmpdir(), 'pickleague_outside_events_import.sql');
fs.writeFileSync(out, sql);
if (!apply) {
  console.log(`dry run: ${stmts.length} to import, ${skipped.length} skipped. SQL: ${out}. Add --apply to write.`);
  process.exit(0);
}
const r = spawnSync(SUPABASE, ['db', 'query', '--linked', '-f', out, '-o', 'table'], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write((r.stdout ?? '').split('\n').filter((l) => !/Initialising|new version|recommend/i.test(l)).join('\n'));
if (r.status !== 0) {
  console.error(`FAILED: import query (exit ${r.status})\n${(r.stderr ?? '').slice(0, 2000)}`);
  process.exit(r.status ?? 1);
}
console.log(`\nimported or skipped as duplicates: ${stmts.length}; skipped: ${skipped.length}`);
