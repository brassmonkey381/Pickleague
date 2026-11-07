#!/usr/bin/env node
// Import a marketing-studio seed batch of outside events
// (supabase/migration_outside_events.sql) into public.outside_events, on the
// kit's shared importer (outsideEvents/importer, shared with Doggle).
//
//   node scripts/import-outside-events.mjs <seed.csv>          dry run: prints what it would do
//   node scripts/import-outside-events.mjs <seed.csv> --apply  writes them (linked project)
//
// CSV columns (agreed with marketing-studio, 2026-11-06):
//   title,starts_at,ends_at,place_name,place_address,organizer,source_name,source_url,summary,kind
// starts_at / ends_at are ISO 8601 with an offset; ends_at may be blank.
// kind: 1 or 2 of open_play | round_robin | clinic | ladder | tournament | social, joined by "|".
// One-offs only: a repeating session is a court session (migration_court_schedules.sql).
//
// Each place's street address is looked up with OpenStreetMap Nominatim for its
// coordinates. Pickleague has no Google Places key (mobile/app.config.js: the
// EXPO_PUBLIC_GOOGLE_PLACES_KEY value isn't one, and Google answers 400). The
// server pins the event to the nearest Pickleague court within 150 m of them
// (_pl_outside_event_venue); the dry run shows which. A row whose address has no
// street number (e.g. "Oakland, CA") is skipped and reported: it would put the
// event on a city's middle. Dedupe is the server's: the same (source_url,
// starts_at) is skipped, and a page an organizer asked us to take down is
// refused (_pl_save_outside_event).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nominatimLookup,
  runOutsideEventsImport,
} from '../mobile/node_modules/@just-messin-around/expo-foundation/src/outsideEvents/importer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KINDS = ['open_play', 'round_robin', 'clinic', 'ladder', 'tournament', 'social'];
const args = process.argv.slice(2);

const kindsOf = (row) => [...new Set((row.kind ?? '').split('|').map((k) => k.trim().toLowerCase()).filter(Boolean))];
const hasStreet = (addr) => /\d/.test((addr ?? '').split(',')[0] ?? '');

function extraRowCheck(row) {
  const kinds = kindsOf(row);
  if (kinds.length < 1 || kinds.length > 2 || kinds.some((k) => !KINDS.includes(k))) {
    return `kind must be 1 or 2 of ${KINDS.join(', ')} ("${row.kind}")`;
  }
  if (!hasStreet(row.place_address)) return `no street address ("${row.place_address}")`;
  return null;
}

function matchPlace({ point: p, sqlRows }) {
  const [court] = sqlRows(`select v.name, round(public.haversine_meters(v.lat, v.lng, ${p.lat}, ${p.lng}))::int as m
      from public.venues v
     where v.sport @> array['pickleball']
       and v.lat between ${p.lat - 0.002} and ${p.lat + 0.002} and v.lng between ${p.lng - 0.003} and ${p.lng + 0.003}
       and public.haversine_meters(v.lat, v.lng, ${p.lat}, ${p.lng}) <= 150
     order by 2 limit 1`);
  return court ?? null;
}

function buildSaveSql({ row: r, label, point: p, lit }) {
  return `select ${lit(label)} as event, coalesce(public._pl_save_outside_event(
  null, ${lit(r.title)}, ${lit(r.starts_at)}::timestamptz, ${r.ends_at ? `${lit(r.ends_at)}::timestamptz` : 'null'},
  array[${kindsOf(r).map(lit).join(', ')}]::text[], ${lit(r.summary)}, ${lit(r.organizer)}, ${lit(r.source_name)}, ${lit(r.source_url)},
  ${lit(r.place_name)}, ${lit(r.place_address)}, ${p.lat}, ${p.lng}, null, null, true)::text, 'already listed') as result`;
}

const result = await runOutsideEventsImport({
  csvPath: args.find((a) => !a.startsWith('--')),
  apply: args.includes('--apply'),
  lookup: nominatimLookup({ userAgent: 'Pickleague outside-events importer (https://pickleague.club)' }),
  matchPlace,
  buildSaveSql,
  extraRowCheck,
  describe: ({ point, match }) =>
    `${point.address ?? '?'}; ${match ? `court "${match.name}" (${match.m} m)` : 'no Pickleague court within 150 m'}`,
  sqlFileName: 'pickleague_outside_events_import.sql',
  supabasePath: 'C:/Users/Brian/tools/supabase/supabase.exe',
  cwd: ROOT,
});
process.exitCode = result.exitCode;
