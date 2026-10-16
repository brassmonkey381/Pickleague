#!/usr/bin/env node
// Build the presence persona test (Phase 1 + Phase 1.5 + refusal messages):
// one SQL file that is
//
//   begin;
//   <presence_p1_personas.sql up to -- @@MIGRATIONS@@>   (state captured before)
//   <migration_league_members_lock_identity.sql, the five
//    migration_presence_p1_*.sql files, migration_validity_rules.sql and
//    migration_refusal_messages.sql, in apply order>
//   <migration_presence_p1_checkins.sql, migration_validity_rules.sql,
//    migration_refusal_messages.sql>
//                                                        (re-runs: Phase 1 must not put its
//                                                         3-arg checkout_venue or 2-arg
//                                                         end_play_session back; 1.5 is
//                                                         re-runnable; the refusal texts
//                                                         go last, as on live)
//   <migration_rls_hardening_2026q3.sql>                 (a re-run must take nothing offline)
//   <migration_venue_checkins.sql, migration_play_sessions.sql>
//                                                        (re-runs of the superseded files
//                                                         must keep the presence versions)
//   <presence_p1_personas.sql after the marker>          (personas + assertions, with
//    validity_personas.sql in place of -- @@VALIDITY@@,  (the Phase 1.5 section)
//    refusal_personas.sql in place of -- @@REFUSALS@@)   (refusal messages and codes)
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
  'migration_league_members_lock_identity.sql',
  'migration_presence_p1_schema.sql',
  'migration_presence_p1_checkins.sql',
  'migration_presence_p1_reads.sql',
  'migration_presence_p1_friends.sql',
  'migration_presence_p1_hygiene.sql',
  'migration_validity_rules.sql',
  'migration_refusal_messages.sql',
];
// Run again after all of the above, before the hardening re-run: the Phase 1
// check-ins file must keep the Phase 1.5 checkout_venue and end_play_session
// (its guards skip its own), and the Phase 1.5 file must be re-runnable. The
// refusal texts re-run last: the two files before them put the old texts back.
const RERUN = ['migration_presence_p1_checkins.sql', 'migration_validity_rules.sql', 'migration_refusal_messages.sql'];
const HARDENING = 'migration_rls_hardening_2026q3.sql';
// Applied long before presence and partly superseded by it: re-running them
// must change nothing the presence files own (their guards skip those parts).
const SUPERSEDED = ['migration_venue_checkins.sql', 'migration_play_sessions.sql'];
const BODY = path.join(here, 'presence_p1_personas.sql');
const MARKER = '-- @@MIGRATIONS@@';
const VALIDITY = path.join(here, 'validity_personas.sql');
const VALIDITY_MARKER = '-- @@VALIDITY@@';
const REFUSALS = path.join(here, 'refusal_personas.sql');
const REFUSALS_MARKER = '-- @@REFUSALS@@';

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

const rest = body.slice(at + MARKER.length);
for (const m of [VALIDITY_MARKER, REFUSALS_MARKER]) {
  if (!rest.includes(m)) {
    console.error(`FAILED: ${path.basename(BODY)} has no "${m}" line.`);
    process.exit(1);
  }
}

const parts = [
  'begin;',
  body.slice(0, at),
  ...MIGRATIONS.map((f) => `-- ════ ${f} ════\n${read(path.join(supa, f))}`),
  ...RERUN.map((f) => `-- ════ ${f} (re-run) ════\n${read(path.join(supa, f))}`),
  `-- ════ ${HARDENING} (re-run) ════\n${read(path.join(supa, HARDENING))}`,
  ...SUPERSEDED.map((f) => `-- ════ ${f} (re-run) ════\n${read(path.join(supa, f))}`),
  rest
    .replace(VALIDITY_MARKER, () => `-- ════ ${path.basename(VALIDITY)} ════\n${read(VALIDITY)}`)
    .replace(REFUSALS_MARKER, () => `-- ════ ${path.basename(REFUSALS)} ════\n${read(REFUSALS)}`),
  'rollback;',
  '',
];

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'presence_p1_test.sql'));
fs.writeFileSync(out, parts.join('\n'));
console.log(out);
