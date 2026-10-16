#!/usr/bin/env node
// Build the Presence Phase 1 persona test: one SQL file that is
//
//   begin;
//   <presence_p1_personas.sql up to -- @@MIGRATIONS@@>   (state captured before)
//   <the five migration_presence_p1_*.sql files, in apply order>
//   <migration_rls_hardening_2026q3.sql>                 (a re-run must take nothing offline)
//   <presence_p1_personas.sql after the marker>          (personas + assertions)
//   rollback;
//
// so the whole thing runs against the linked (live) database and leaves it
// untouched. The last statement before rollback selects the results table.
//
//   node supabase/tests/build-presence-test.mjs [out.sql]
//   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
//
// Refuses to build if any input contains a top-level transaction statement
// (begin; / commit; / end; / rollback;), which would end the rolled-back
// transaction early and apply the rest for real.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');

export const MIGRATIONS = [
  'migration_presence_p1_schema.sql',
  'migration_presence_p1_checkins.sql',
  'migration_presence_p1_reads.sql',
  'migration_presence_p1_friends.sql',
  'migration_presence_p1_hygiene.sql',
];
const HARDENING = 'migration_rls_hardening_2026q3.sql';
const BODY = path.join(here, 'presence_p1_personas.sql');
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

const parts = [
  'begin;',
  body.slice(0, at),
  ...MIGRATIONS.map((f) => `-- ════ ${f} ════\n${read(path.join(supa, f))}`),
  `-- ════ ${HARDENING} (re-run) ════\n${read(path.join(supa, HARDENING))}`,
  body.slice(at + MARKER.length),
  'rollback;',
  '',
];

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'presence_p1_test.sql'));
fs.writeFileSync(out, parts.join('\n'));
console.log(out);
