#!/usr/bin/env node
// Build the court discovery Phase 0 persona test: one SQL file that is
//
//   begin;
//   <court_discovery_p0_personas.sql up to -- @@MIGRATIONS@@>
//   <migration_venue_data_guards.sql>
//   <migration_venue_data_guards.sql>          (again: it must be re-runnable)
//   <migration_rls_hardening_2026q3.sql>       (a re-run must take nothing offline)
//   <court_discovery_p0_personas.sql after the marker>
//   rollback;
//
// so it runs against the linked (live) database and leaves it untouched. The
// last statement before rollback selects the results.
//
//   node supabase/tests/build-court-discovery-p0-test.mjs [out.sql]
//   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
//
// Refuses to build if any input has a top-level transaction statement
// (begin; / commit; / end; / rollback;), which would end the rolled-back
// transaction early and apply the rest for real.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');

const MIGRATION = 'migration_venue_data_guards.sql';
const HARDENING = 'migration_rls_hardening_2026q3.sql';
const BODY = path.join(here, 'court_discovery_p0_personas.sql');
const MARKER = '-- @@MIGRATIONS@@';

/** The SQL with comments, string literals and dollar-quoted bodies blanked out. */
function topLevel(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? sql.length : close + 2;
      continue;
    }
    const tag = rest.match(/^\$[A-Za-z_]*\$/);
    if (tag) {
      const close = sql.indexOf(tag[0], i + tag[0].length);
      i = close < 0 ? sql.length : close + tag[0].length;
      out += ' ';
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      i = j + 1;
      out += ' ';
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

function guard(name, sql) {
  const bad = topLevel(sql).match(/(^|;)\s*(begin|commit|end|rollback|abort|start\s+transaction)\s*(;|$)/im);
  if (bad) {
    console.error(`FAILED: ${name} contains a top-level "${bad[2]}" statement; it would end the test transaction.`);
    process.exit(1);
  }
  return sql;
}

const read = (file) => guard(path.basename(file), fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));

const body = read(BODY);
const at = body.indexOf(MARKER);
if (at < 0) {
  console.error(`FAILED: ${path.basename(BODY)} has no "${MARKER}" line.`);
  process.exit(1);
}
const migration = read(path.join(supa, MIGRATION));

const parts = [
  'begin;',
  [
    '-- The pg_temp helpers run as anon / authenticated. Since migration_anon_audit_rest.sql,',
    '-- functions postgres creates are not EXECUTE-able by PUBLIC by default, so this test',
    '-- transaction (rolled back) gives the helpers the old default back.',
    'alter default privileges for role postgres grant execute on functions to public;',
  ].join('\n'),
  body.slice(0, at),
  `-- ════ ${MIGRATION} ════\n${migration}`,
  `-- ════ ${MIGRATION} (re-run) ════\n${migration}`,
  `-- ════ ${HARDENING} (re-run) ════\n${read(path.join(supa, HARDENING))}`,
  body.slice(at + MARKER.length),
  'rollback;',
  '',
];

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'court_discovery_p0_test.sql'));
fs.writeFileSync(out, parts.join('\n'));
console.log(out);
