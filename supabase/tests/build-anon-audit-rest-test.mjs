#!/usr/bin/env node
// Build the signed-out audit (the rest) persona test:
// anon_audit_rest_personas.sql with migration_anon_audit_rest.sql twice (it
// must be re-runnable) and then migration_rls_hardening_2026q3.sql (a re-run
// must leave every grant the file makes) in place of its -- @@MIGRATION@@
// line. The test file holds the begin / rollback, so the result leaves the
// linked (live) database untouched.
//
//   node supabase/tests/build-anon-audit-rest-test.mjs [out.sql] [tournament-suites-out.sql]
//   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
//
// Refuses to build if a spliced file contains a top-level transaction
// statement, which would end the rolled-back transaction early.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');
const BODY = path.join(here, 'anon_audit_rest_personas.sql');
const MARKER = '-- @@MIGRATION@@';
const FIX = 'migration_anon_audit_rest.sql';
const PREV = 'migration_anon_audit_fixes.sql';
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
    const tag = rest.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
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

const body = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n');
if (!body.includes(MARKER)) {
  console.error(`FAILED: ${path.basename(BODY)} has no "${MARKER}" line.`);
  process.exit(1);
}

const spliced = [
  `-- ==== ${FIX} ====\n${read(FIX)}`,
  `-- ==== ${FIX} (re-run) ====\n${read(FIX)}`,
  `-- ==== ${HARDENING} (re-run) ====\n${read(HARDENING)}`,
].join('\n');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'anon_audit_rest_test.sql'));
fs.writeFileSync(out, body.replace(MARKER, () => spliced));
console.log(out);

// Optional second file: every Tier-3 tournament suite (test_*.sql here) on
// top of the signed-out fixes and this file, in ONE rolled-back transaction.
// Each suite's own begin / rollback pairs become a savepoint and a rollback to
// it. They run with service-role claims (the path the sims and scripts use;
// generate_playoff_bracket refuses a caller with no user). A failing assert
// aborts the whole run, so reaching the SUMMARY row is the pass.
//   node supabase/tests/build-anon-audit-rest-test.mjs <out.sql> <tournament-out.sql>
const TOURNAMENT_SUITES = fs.readdirSync(here).filter((f) => /^test_.*\.sql$/.test(f)).sort();
if (process.argv[3]) {
  const parts = ['begin;', `-- ==== ${PREV} ====`, read(PREV), `-- ==== ${FIX} ====`, read(FIX),
    `select set_config('request.jwt.claims', '{"role": "service_role"}', true);`];
  for (const name of TOURNAMENT_SUITES) {
    const sql = fs.readFileSync(path.join(here, name), 'utf8').replace(/\r\n/g, '\n');
    const nBegin = (sql.match(/^begin;[ \t]*$/gm) ?? []).length;
    const nRollback = (sql.match(/^rollback;[ \t]*$/gm) ?? []).length;
    if (nBegin === 0 || nBegin !== nRollback) {
      console.error(`FAILED: ${name}: ${nBegin} begin; lines and ${nRollback} rollback; lines (expected matching pairs).`);
      process.exit(1);
    }
    const converted = sql
      // psql meta-commands (\set ON_ERROR_STOP on): the query API runs SQL only.
      .replace(/^\\.*$/gm, '')
      .replace(/^begin;[ \t]*$/gm, 'savepoint pl_suite;')
      .replace(/^rollback;[ \t]*$/gm, 'rollback to savepoint pl_suite;');
    const left = topLevel(converted).match(/(^|;)\s*(begin|commit|end|rollback|abort|start\s+transaction)\s*(;|$)/im);
    if (left) {
      console.error(`FAILED: ${name} still has a top-level "${left[2]}" after the conversion.`);
      process.exit(1);
    }
    parts.push(`-- ==== ${name} ====`, converted);
  }
  parts.push(`select 'SUMMARY: ${TOURNAMENT_SUITES.length} tournament suites passed with the fixes applied' as test, true as ok, null::text as detail;`,
    'rollback;');
  const out2 = path.resolve(process.argv[3]);
  fs.writeFileSync(out2, parts.join('\n') + '\n');
  console.log(out2);
}
