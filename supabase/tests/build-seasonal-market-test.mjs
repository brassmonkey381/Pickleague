#!/usr/bin/env node
// Build the seasonal market check: seasonal_market_check.sql with
// migration_seasonal_market_2026_11_12.sql in place of its -- @@MARKET@@ line
// and again (it must be re-runnable) at -- @@MARKET_RERUN@@, and the drops'
// items (art/seasonal-market/<drop>/catalog.json) as rows of _expect at
// -- @@EXPECT@@. The test file holds the begin / rollback, so the result
// leaves the linked (live) database untouched.
//
//   node supabase/tests/build-seasonal-market-test.mjs [out.sql]
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
const BODY = path.join(here, 'seasonal_market_check.sql');
const MARKET = 'migration_seasonal_market_2026_11_12.sql';
const ART = path.resolve(supa, '..', 'art', 'seasonal-market');
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

const file = path.join(supa, MARKET);
if (!fs.existsSync(file)) fail(`no supabase/${MARKET}: run node art/seasonal-market/build.mjs first.`);
const market = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const bad = topLevel(market).match(/(^|;)\s*(begin|commit|end|rollback|abort|start\s+transaction)\s*(;|$)/im);
if (bad) fail(`${MARKET} contains a top-level "${bad[2]}" statement; it would end the test transaction.`);

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const at = (w) => (w == null ? 'null' : `${q(w.local)}::timestamp at time zone ${q(w.time_zone)}`);
const drops = fs.readdirSync(ART).filter((f) => /^\d{4}-\d{2}$/.test(f) && fs.existsSync(path.join(ART, f, 'catalog.json'))).sort();
const rows = [];
for (const d of drops) {
  const cat = JSON.parse(fs.readFileSync(path.join(ART, d, 'catalog.json'), 'utf8'));
  for (const it of cat.items) {
    rows.push(`  (${q(it.id)}, ${q(cat.title)}, ${q(it.slot_group)}, ${it.cost}, ${q(it.rarity)}, ${q(cat.season)}, ${at(cat.available_from)}, ${at(cat.available_until)})`);
  }
}
if (!rows.length) fail('no items in art/seasonal-market/<drop>/catalog.json.');
const expect = `insert into _expect (id, drop_title, slot_group, cost, rarity, season, available_from, available_until) values\n${rows.join(',\n')};`;

const body = fs.readFileSync(BODY, 'utf8').replace(/\r\n/g, '\n');
for (const m of ['-- @@EXPECT@@', '-- @@MARKET@@', '-- @@MARKET_RERUN@@']) {
  if (body.split(m + '\n').length !== 2) fail(`${path.basename(BODY)} needs exactly one "${m}" line.`);
}
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'seasonal_market_test.sql'));
fs.writeFileSync(
  out,
  body
    .replace('-- @@EXPECT@@\n', () => `-- ==== expected items (art/seasonal-market/*/catalog.json) ====\n${expect}\n`)
    .replace('-- @@MARKET_RERUN@@\n', () => `-- ==== ${MARKET} (re-run) ====\n${market}\n`)
    .replace('-- @@MARKET@@\n', () => `-- ==== ${MARKET} ====\n${market}\n`),
);
console.log(out);
