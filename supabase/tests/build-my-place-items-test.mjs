#!/usr/bin/env node
// Build the My Place catalog check: my_place_items_check.sql with
// migration_my_place_items.sql in place of its -- @@ITEMS@@ line and again
// (it must be re-runnable) at -- @@ITEMS_RERUN@@, and the catalog's items
// (art/my-place/catalog.json) as rows of _expect at -- @@EXPECT@@. The test
// file holds the begin / rollback, so the result leaves the linked (live)
// database untouched.
//
//   node supabase/tests/build-my-place-items-test.mjs [out.sql]
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
const BODY = path.join(here, 'my_place_items_check.sql');
const ITEMS = 'migration_my_place_items.sql';
const CATALOG = path.resolve(supa, '..', 'art', 'my-place', 'catalog.json');
const fail = (m) => {
  console.error(`FAILED: ${m}`);
  process.exit(1);
};

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

const items = fs.readFileSync(path.join(supa, ITEMS), 'utf8').replace(/\r\n/g, '\n');
const bad = topLevel(items).match(/(^|;)\s*(begin|commit|end|rollback|abort|start\s+transaction)\s*(;|$)/im);
if (bad) fail(`${ITEMS} contains a top-level "${bad[2]}" statement; it would end the test transaction.`);

const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const expect =
  `insert into _expect (id, slot_group, is_starter) values\n` +
  cat.items.map((i) => `  (${q(i.id)}, ${q(i.fits)}, ${i.is_starter ? 'true' : 'false'})`).join(',\n') +
  ';';

const body = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n');
for (const m of ['-- @@EXPECT@@', '-- @@ITEMS@@', '-- @@ITEMS_RERUN@@']) {
  if (body.split(m + '\n').length !== 2) fail(`${path.basename(BODY)} needs exactly one "${m}" line.`);
}
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'my_place_items_test.sql'));
fs.writeFileSync(
  out,
  body
    .replace('-- @@EXPECT@@\n', () => `-- ==== expected items (${path.relative(supa, CATALOG)}) ====\n${expect}\n`)
    .replace('-- @@ITEMS_RERUN@@\n', () => `-- ==== ${ITEMS} (re-run) ====\n${items}\n`)
    .replace('-- @@ITEMS@@\n', () => `-- ==== ${ITEMS} ====\n${items}\n`),
);
console.log(out);
