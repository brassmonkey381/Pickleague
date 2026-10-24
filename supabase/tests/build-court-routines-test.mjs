#!/usr/bin/env node
// Build the routine check-ins persona test: court_routines_personas.sql with
// migration_court_routines.sql (twice: it must be re-runnable), then
// migration_court_routines_planned_end.sql (twice: it replaces the plan-link
// trigger function, the materializer, save_court_routine,
// set_court_routine_active and delete_court_routine, so it goes after every
// run of the routines file, and it must be re-runnable too), then
// migration_checkin_starts_session.sql and migration_court_oneoff_plans.sql
// (each replaces functions the routines file defines) and then
// migration_rls_hardening_2026q3.sql (a
// re-run must keep the new client RPCs online) in place of its
// -- @@MIGRATION@@ line. The test file holds the
// begin / rollback, so the result leaves the linked (live) database untouched.
//
//   node supabase/tests/build-court-routines-test.mjs [out.sql]
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
const BODY = path.join(here, 'court_routines_personas.sql');
const MARKER = '-- @@MIGRATION@@';
const MIGRATION = 'migration_court_routines.sql';
const PLANNED_END = 'migration_court_routines_planned_end.sql';
// Every check-in starts the play session: replaces process_court_arrivals and
// cancel_court_arrival again, so it goes after every run of the two files above.
const CHECKIN_SESSION = 'migration_checkin_starts_session.sql';
// One-off plans: replaces _pl_court_arrival_off and
// process_court_routine_reminders (last defined by the routines file), so it
// goes after every run of it too.
const ONEOFF_PLANS = 'migration_court_oneoff_plans.sql';
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

const body = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n');
if (!body.includes(MARKER)) {
  console.error(`FAILED: ${path.basename(BODY)} has no "${MARKER}" line.`);
  process.exit(1);
}

const spliced = [
  `-- ════ ${MIGRATION} ════\n${read(MIGRATION)}`,
  `-- ════ ${MIGRATION} (re-run) ════\n${read(MIGRATION)}`,
  `-- ════ ${PLANNED_END} ════\n${read(PLANNED_END)}`,
  `-- ════ ${PLANNED_END} (re-run) ════\n${read(PLANNED_END)}`,
  `-- ════ ${CHECKIN_SESSION} ════\n${read(CHECKIN_SESSION)}`,
  `-- ════ ${ONEOFF_PLANS} ════\n${read(ONEOFF_PLANS)}`,
  `-- ════ ${HARDENING} (re-run) ════\n${read(HARDENING)}`,
].join('\n');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'court_routines_test.sql'));
fs.writeFileSync(out, body.replace(MARKER, () => spliced));
console.log(out);
