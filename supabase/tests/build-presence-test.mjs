#!/usr/bin/env node
// Build the presence persona test (Phase 1 + Phase 1.5 + refusal messages +
// the offline check-in time and old-build league joins + court arrival
// check-ins): one SQL file that is
//
//   begin;
//   <presence_p1_personas.sql up to -- @@MIGRATIONS@@>   (state captured before)
//   <migration_league_members_lock_identity.sql, the five
//    migration_presence_p1_*.sql files, migration_validity_rules.sql,
//    migration_refusal_messages.sql, migration_checkin_tap_time.sql and the
//    three court arrival files, then migration_court_arrival_two_hours.sql,
//    in apply order>
//   <migration_court_star_cap_three.sql>                 (court stars capped at 3)
//   <migration_presence_p1_checkins.sql, migration_validity_rules.sql,
//    migration_refusal_messages.sql, migration_checkin_tap_time.sql>
//                                                        (re-runs: Phase 1 must not put its
//                                                         3-arg checkout_venue or 2-arg
//                                                         end_play_session back; 1.5 is
//                                                         re-runnable; the refusal texts,
//                                                         then the tap-time file, go
//                                                         last, as on live)
//   <migration_rls_hardening_2026q3.sql>                 (a re-run must take nothing offline)
//   <migration_venue_checkins.sql, migration_play_sessions.sql>
//                                                        (re-runs of the superseded files
//                                                         must keep the presence versions)
//   <the court arrival files again, two-hours last>      (re-applied, as their headers say:
//                                                         the re-runs above put older bodies
//                                                         of the functions they replace back)
//   <migration_court_star_cap_three.sql again>           (re-applied: the refusal re-run puts
//                                                         the 5-court set_court_favorite back)
//   <migration_rls_hardening_2026q3.sql>                 (re-run after them, as the apply
//                                                         script does: nothing goes offline)
//   <presence_p1_personas.sql after the marker>          (personas + assertions, with
//    validity_personas.sql in place of -- @@VALIDITY@@,  (the Phase 1.5 section)
//    refusal_personas.sql in place of -- @@REFUSALS@@,   (refusal messages and codes)
//    tap_time_personas.sql in place of -- @@TAPTIME@@,   (offline check-in time, old-build joins)
//    court_arrival_personas.sql in place of              (court arrival check-ins, prompts,
//    -- @@ARRIVALS@@)                                     the app-open scan)
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
  'migration_checkin_tap_time.sql',
];
// Court arrival (Doggle parity), files 1 to 3 in apply order, after all of the
// above. They replace functions that migration_validity_rules.sql and
// migration_venue_checkins.sql also define, so they run again after those
// files' re-runs below (their headers: re-apply after such a re-run), and the
// hardening file once more after that. migration_court_arrival_two_hours.sql
// (arrival check-ins last 2 hours) replaces two of the queue file's functions,
// so it goes after the three, in both passes.
export const ARRIVALS = [
  'migration_court_arrival_settings.sql',
  'migration_court_arrival_queue.sql',
  'migration_court_checkin_prompt.sql',
  'migration_court_arrival_two_hours.sql',
];
// Run again after all of the above, before the hardening re-run: the Phase 1
// check-ins file must keep the Phase 1.5 checkout_venue and end_play_session
// (its guards skip its own), and the Phase 1.5 file must be re-runnable. The
// refusal texts re-run next: the two files before them put the old texts back.
// The tap-time file re-runs last: the refusal file puts the older
// checkin_venue, extend_checkin and start_play_session back.
// Court stars capped at 3 (Doggle parity). After the files that define
// set_court_favorite (migration_presence_p1_reads.sql, migration_refusal_messages.sql),
// and again after their re-runs, which put the 5-court cap back.
const STAR_CAP = 'migration_court_star_cap_three.sql';
const RERUN = [
  'migration_presence_p1_checkins.sql',
  'migration_validity_rules.sql',
  'migration_refusal_messages.sql',
  'migration_checkin_tap_time.sql',
];
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
const TAPTIME = path.join(here, 'tap_time_personas.sql');
const TAPTIME_MARKER = '-- @@TAPTIME@@';
const ARRIVAL_PERSONAS = path.join(here, 'court_arrival_personas.sql');
const ARRIVALS_MARKER = '-- @@ARRIVALS@@';

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
for (const m of [VALIDITY_MARKER, REFUSALS_MARKER, TAPTIME_MARKER, ARRIVALS_MARKER]) {
  if (!rest.includes(m)) {
    console.error(`FAILED: ${path.basename(BODY)} has no "${m}" line.`);
    process.exit(1);
  }
}

const parts = [
  'begin;',
  body.slice(0, at),
  ...MIGRATIONS.map((f) => `-- ════ ${f} ════\n${read(path.join(supa, f))}`),
  ...ARRIVALS.map((f) => `-- ════ ${f} ════\n${read(path.join(supa, f))}`),
  `-- ════ ${STAR_CAP} ════\n${read(path.join(supa, STAR_CAP))}`,
  ...RERUN.map((f) => `-- ════ ${f} (re-run) ════\n${read(path.join(supa, f))}`),
  `-- ════ ${HARDENING} (re-run) ════\n${read(path.join(supa, HARDENING))}`,
  ...SUPERSEDED.map((f) => `-- ════ ${f} (re-run) ════\n${read(path.join(supa, f))}`),
  ...ARRIVALS.map((f) => `-- ════ ${f} (re-applied after the re-runs) ════\n${read(path.join(supa, f))}`),
  `-- ════ ${STAR_CAP} (re-applied after the re-runs) ════\n${read(path.join(supa, STAR_CAP))}`,
  `-- ════ ${HARDENING} (re-run after the court arrival files) ════\n${read(path.join(supa, HARDENING))}`,
  rest
    .replace(VALIDITY_MARKER, () => `-- ════ ${path.basename(VALIDITY)} ════\n${read(VALIDITY)}`)
    .replace(REFUSALS_MARKER, () => `-- ════ ${path.basename(REFUSALS)} ════\n${read(REFUSALS)}`)
    .replace(TAPTIME_MARKER, () => `-- ════ ${path.basename(TAPTIME)} ════\n${read(TAPTIME)}`)
    .replace(ARRIVALS_MARKER, () => `-- ════ ${path.basename(ARRIVAL_PERSONAS)} ════\n${read(ARRIVAL_PERSONAS)}`),
  'rollback;',
  '',
];

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'presence_p1_test.sql'));
fs.writeFileSync(out, parts.join('\n'));
console.log(out);
