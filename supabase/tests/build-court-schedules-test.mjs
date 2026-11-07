#!/usr/bin/env node
// Build the court schedules persona test: court_schedules_personas.sql with
// migration_court_schedules.sql twice (it must be re-runnable) and then
// migration_rls_hardening_2026q3.sql (a re-run must keep the RPCs online) in
// place of its -- @@MIGRATION@@ line. The test file holds the begin / rollback,
// so the result leaves the linked (live) database untouched.
//
//   node supabase/tests/build-court-schedules-test.mjs [out.sql]
//   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');
const BODY = path.join(here, 'court_schedules_personas.sql');
const MARKER = '-- @@MIGRATION@@';
const MIGRATION = 'migration_court_schedules.sql';
const HARDENING = 'migration_rls_hardening_2026q3.sql';

const read = (name) => fs.readFileSync(path.join(supa, name), 'utf8').replace(/\r\n/g, '\n');

const body = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n');
if (!body.includes(MARKER)) {
  console.error(`FAILED: ${path.basename(BODY)} has no "${MARKER}" line.`);
  process.exit(1);
}

const spliced = [
  `-- ════ ${MIGRATION} ════\n${read(MIGRATION)}`,
  `-- ════ ${MIGRATION} (re-run) ════\n${read(MIGRATION)}`,
  `-- ════ ${HARDENING} (re-run) ════\n${read(HARDENING)}`,
].join('\n');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'court_schedules_test.sql'));
fs.writeFileSync(out, body.replace(MARKER, () => spliced));
console.log(out);
