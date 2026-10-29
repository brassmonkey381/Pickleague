#!/usr/bin/env node
// Build the My Place persona test: my_place_personas.sql with
// migration_my_place.sql, twice (it must be re-runnable), in place of its
// -- @@MIGRATION@@ line. The test file holds the begin / rollback, so the
// result leaves the linked (live) database untouched.
//
// It does NOT splice migration_rls_hardening_2026q3.sql (its policy rewrites
// lock other live tables). Instead the build refuses unless that file's
// allowlist names every My Place client RPC (a re-run would otherwise take
// them offline), and M1 checks the grants.
//
//   node supabase/tests/build-my-place-test.mjs [out.sql]
//   (from the linked checkout) supabase db query --linked -f <out.sql> -o csv
//
// Refuses to build if the spliced file contains a top-level transaction
// statement, which would end the rolled-back transaction early.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');
const BODY = path.join(here, 'my_place_personas.sql');
const MARKER = '-- @@MIGRATION@@';
const MIGRATION = 'migration_my_place.sql';
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
for (const fn of ['get_home', 'buy_home_item', 'equip_home_item', 'clear_home_slot', 'set_my_place_visibility', 'claim_my_place_starter', 'save_room_layout']) {
  if (!new RegExp(`'${fn}'`).test(hardening)) {
    console.error(`FAILED: ${HARDENING}'s allowlist has no '${fn}'; a re-run of it would take the RPC offline.`);
    process.exit(1);
  }
}

const body = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n');
if (!body.includes(MARKER)) {
  console.error(`FAILED: ${path.basename(BODY)} has no "${MARKER}" line.`);
  process.exit(1);
}

const spliced = [
  `-- ==== ${MIGRATION} ====\n${read(MIGRATION)}`,
  `-- ==== ${MIGRATION} (re-run) ====\n${read(MIGRATION)}`,
].join('\n');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'my_place_test.sql'));
fs.writeFileSync(out, body.replace(MARKER, () => spliced));
console.log(out);
