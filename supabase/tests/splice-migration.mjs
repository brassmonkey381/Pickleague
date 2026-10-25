#!/usr/bin/env node
// Splice migration file(s) into an already-built persona suite, to run an
// existing suite as if those migrations were live:
//
//   node supabase/tests/splice-migration.mjs <mode> <built.sql> <out.sql> <migration.sql>...
//
//   mode after-begin       right after the suite's first `begin;` line: the
//                          suite then runs exactly as it would on a database
//                          where the migrations are applied (its own spliced
//                          migrations re-run on top, as they do on live).
//   mode after-migrations  right after the last migration file the suite's
//                          builder spliced in (found by content), so the
//                          suite's setup and checks run on top of them.
//
// Migration names are relative to supabase/. Refuses a migration with a
// top-level transaction statement (it would end the test transaction).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const supa = path.resolve(here, '..');
const [mode, inFile, outFile, ...migrations] = process.argv.slice(2);
if (!['after-begin', 'after-migrations'].includes(mode) || !inFile || !outFile || migrations.length === 0) {
  console.error('usage: splice-migration.mjs after-begin|after-migrations <built.sql> <out.sql> <migration.sql>...');
  process.exit(1);
}
const norm = (s) => s.replace(/\r\n/g, '\n');
const built = norm(fs.readFileSync(inFile, 'utf8'));
const extra = migrations.map((m) => {
  const sql = norm(fs.readFileSync(path.join(supa, m), 'utf8'));
  if (/^\s*(begin|commit|rollback|start\s+transaction)\s*;/im.test(sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ''))) {
    console.error(`FAILED: ${m} has a top-level transaction statement.`);
    process.exit(1);
  }
  return `\n-- ==== ${m} (spliced by splice-migration.mjs, ${mode}) ====\n${sql}\n`;
}).join('');

let at;
if (mode === 'after-begin') {
  const m = /^begin;[ \t]*$/m.exec(built);
  if (!m) { console.error('FAILED: the suite has no begin; line.'); process.exit(1); }
  at = m.index + m[0].length;
} else {
  at = -1;
  for (const f of fs.readdirSync(supa).filter((n) => /^migration_.*\.sql$/.test(n))) {
    const body = norm(fs.readFileSync(path.join(supa, f), 'utf8')).trim();
    if (body.length < 200) continue;
    const i = built.lastIndexOf(body);
    if (i >= 0) at = Math.max(at, i + body.length);
  }
  if (at < 0) { console.error('FAILED: found no spliced migration in the suite.'); process.exit(1); }
}
fs.writeFileSync(outFile, built.slice(0, at) + '\n' + extra + built.slice(at));
console.log(outFile);
