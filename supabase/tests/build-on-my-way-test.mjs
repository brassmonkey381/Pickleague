#!/usr/bin/env node
// Build the "On my way" persona test: on_my_way_personas.sql with
// migration_on_my_way.sql (twice: it must be re-runnable) in place
// of its -- @@MIGRATION@@ line. The test file holds the begin / rollback, so
// the result leaves the linked (live) database untouched.
//
//   node supabase/tests/build-on-my-way-test.mjs [out.sql]
//   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
//
// It does NOT splice migration_rls_hardening_2026q3.sql: re-running that file
// from an old copy once revoked 20 RPCs, so nothing here runs it. Instead the
// build refuses unless that file's allowlist names send_on_my_way (so a
// later re-run keeps it online), and the test checks the grant the migration
// gives itself. Refuses to build if a spliced file contains a top-level
// transaction statement, which would end the rolled-back transaction early.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');
const BODY = path.join(here, 'on_my_way_personas.sql');
const MARKER = '-- @@MIGRATION@@';
const MIGRATION = 'migration_on_my_way.sql';
const HARDENING = 'migration_rls_hardening_2026q3.sql';

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

function read(name) {
  const sql = fs.readFileSync(path.join(supa, name), 'utf8').replace(/\r\n/g, '\n');
  const bad = topLevel(sql).match(/(^|;)\s*(begin|commit|end|rollback|abort|start\s+transaction)\s*(;|$)/im);
  if (bad) {
    console.error(`FAILED: ${name} contains a top-level "${bad[2]}" statement; it would end the test transaction.`);
    process.exit(1);
  }
  return sql;
}

const hardening = fs.readFileSync(path.join(supa, HARDENING), 'utf8');
if (!/'send_on_my_way'/.test(hardening)) {
  console.error(`FAILED: ${HARDENING}'s allowlist has no 'send_on_my_way'; a re-run of it would take the RPC offline.`);
  process.exit(1);
}

const body = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n');
if (!body.includes(MARKER)) {
  console.error(`FAILED: ${path.basename(BODY)} has no "${MARKER}" line.`);
  process.exit(1);
}

const spliced = [
  `-- ════ ${MIGRATION} ════\n${read(MIGRATION)}`,
  `-- ════ ${MIGRATION} (re-run) ════\n${read(MIGRATION)}`,
].join('\n');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'on_my_way_test.sql'));
fs.writeFileSync(out, body.replace(MARKER, () => spliced));
console.log(out);
