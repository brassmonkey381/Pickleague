#!/usr/bin/env node
// Pickleague toolbox — Migrations (check / run)
//
// The repo's supabase/migration_*.sql files are hand-applied, so what's live
// can silently drift (found the hard way: prod was missing create_mlp_team's
// captain-slot version for weeks). This tool makes drift visible and fixable:
//
//   check — parse every `create or replace function` in migration files, pick
//           the CANONICAL definition per function (the file most recently
//           touched in git wins; schema.sql / setup_all_migrations.sql are
//           excluded as consolidated snapshots), and diff the function BODIES
//           against live prod (via admin_list_function_defs). Reports
//           OK / DRIFT / MISSING, with the first differing lines for drifts.
//   run   — execute one migration file against prod (via admin_execute_sql).
//           --dry-run prints the SQL without executing.
//
// Both transports are service-role-only RPCs (migration_toolbox_admin_helpers)
// so no direct Postgres connection string is needed.
//
//   node scripts/migration-audit.mjs --mode check [--only mlp]
//   node scripts/migration-audit.mjs --mode run --file migration_x.sql [--dry-run]
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const MODE = val('--mode', 'check');
const ONLY = val('--only', '');
const FILE = val('--file', '');
const DRY = flag('--dry-run');

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const migDir = path.join(repoRoot, 'supabase');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── shared: body normalization ──────────────────────────────────────────────
// pg_get_functiondef re-wraps the header but preserves the body between the
// dollar quotes verbatim — so we compare bodies, normalized for line endings
// and trailing whitespace.
function normalizeBody(body) {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

// Extract the dollar-quoted body from a full definition (repo or prod form).
function extractBody(def) {
  const open = def.match(/\bas\s+(\$[a-z_]*\$)/i);
  if (!open) return null;
  const tag = open[1];
  const start = open.index + open[0].length;
  const end = def.indexOf(tag, start);
  if (end < 0) return null;
  return def.slice(start, end);
}

// ── check mode ──────────────────────────────────────────────────────────────
// Consolidated snapshots — never canonical (they hold historical definitions).
const EXCLUDED = new Set(['schema.sql', 'setup_all_migrations.sql']);

function gitTimestamps() {
  // One pass over git history: newest commit epoch per supabase/*.sql file.
  const out = execFileSync('git', ['log', '--format=C:%ct', '--name-only', '--', 'supabase'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const ts = new Map();
  let cur = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('C:')) cur = Number(line.slice(2));
    else if (line.endsWith('.sql')) {
      const base = path.basename(line.trim());
      if (!ts.has(base)) ts.set(base, cur); // first hit = newest (log is desc)
    }
  }
  return ts;
}

function parseFunctions(sql, file) {
  const found = [];
  const re = /create\s+or\s+replace\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1].toLowerCase();
    const rest = sql.slice(m.index);
    const body = extractBody(rest);
    if (body == null) { found.push({ name, file, body: null }); continue; }
    found.push({ name, file, body: normalizeBody(body) });
  }
  return found;
}

async function check() {
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql') && !EXCLUDED.has(f))
    .filter((f) => !ONLY || f.includes(ONLY));
  const ts = gitTimestamps();

  // canonical repo definition per function name = def from the newest file;
  // `all` keeps every historical version so drift can be classified as
  // "prod is on an OLDER repo version" vs "prod matches nothing in the repo".
  const canonical = new Map(); // name -> { body, file, epoch }
  const all = new Map();       // name -> [{ body, file }]
  let parseWarnings = 0;
  for (const f of files) {
    const sql = readFileSync(path.join(migDir, f), 'utf8');
    const epoch = ts.get(f) ?? 0;
    for (const fn of parseFunctions(sql, f)) {
      if (fn.body == null) { parseWarnings++; continue; }
      if (!all.has(fn.name)) all.set(fn.name, []);
      all.get(fn.name).push({ body: fn.body, file: f });
      const prev = canonical.get(fn.name);
      // later position within the same file also wins (redefinitions in-file)
      if (!prev || epoch >= prev.epoch) canonical.set(fn.name, { body: fn.body, file: f, epoch });
    }
  }
  if (ONLY) console.log(`(filtered to files matching "${ONLY}")`);
  console.log(`Parsed ${canonical.size} canonical function definitions from ${files.length} migration files.`);
  if (parseWarnings) console.log(`⚠ ${parseWarnings} definition(s) could not be parsed (unusual dollar-quoting) — skipped.`);

  const { data: prodRows, error } = await db.rpc('admin_list_function_defs');
  if (error) { console.error('admin_list_function_defs: ' + error.message + '\n(run migration_toolbox_admin_helpers.sql first)'); process.exit(1); }
  const prodByName = new Map();
  for (const r of prodRows ?? []) {
    if (!prodByName.has(r.name)) prodByName.set(r.name, []);
    prodByName.get(r.name).push({ sig: r.sig, body: normalizeBody(extractBody(r.def) ?? '') });
  }

  const drifted = [], missing = [];
  let ok = 0;
  for (const [name, repo] of [...canonical.entries()].sort()) {
    const prods = prodByName.get(name);
    if (!prods) { missing.push({ name, file: repo.file }); continue; }
    if (prods.some((p) => p.body === repo.body)) { ok++; continue; }
    drifted.push({ name, repo, prod: prods[0] });
  }

  console.log(`\n✔ ${ok} functions match prod`);
  if (missing.length) {
    console.log(`\n∅ MISSING from prod (${missing.length}):`);
    for (const m of missing) console.log(`   ${m.name}  (defined in ${m.file})`);
  }
  if (drifted.length) {
    // Classify: prod on an OLDER committed version (repo moved ahead — apply
    // the canonical file) vs prod matching NOTHING in the repo (someone
    // hotfixed prod out-of-band, or a re-typed apply differs cosmetically —
    // reconcile by re-applying the repo file, or commit the prod version).
    const behind = [], ambiguous = [], unknown = [];
    for (const d of drifted) {
      const versions = all.get(d.name) ?? [];
      const prodBodies = new Set((prodByName.get(d.name) ?? []).map((p) => p.body));
      const match = versions.find((v) => v.file !== d.repo.file && prodBodies.has(v.body));
      if (!match) { unknown.push(d); continue; }
      // Same-commit files can't be ordered by git time — a batch commit may
      // contain both "feature" and "follow-up tune" files, and prod may
      // correctly be on the one applied last. Don't recommend blindly.
      if ((ts.get(match.file) ?? 0) === d.repo.epoch) ambiguous.push({ ...d, prodFile: match.file });
      else behind.push({ ...d, prodFile: match.file });
    }
    if (behind.length) {
      console.log(`\n✖ PROD BEHIND (${behind.length}) — prod runs a strictly older committed version:`);
      for (const d of behind) console.log(`   ${d.name}\n      prod = ${d.prodFile}\n      repo = ${d.repo.file}  ← apply this`);
    }
    if (ambiguous.length) {
      console.log(`\n≈ AMBIGUOUS (${ambiguous.length}) — prod matches a file from the SAME commit as the repo canonical (order unknowable from git; verify by content before applying):`);
      for (const d of ambiguous) console.log(`   ${d.name}\n      prod = ${d.prodFile}\n      also = ${d.repo.file}`);
    }
    if (unknown.length) {
      console.log(`\n⁇ UNRECONCILED (${unknown.length}) — prod matches NO committed version (out-of-band hotfix or cosmetic re-type):`);
      for (const d of unknown) {
        console.log(`\n   ${d.name}  (repo canonical: ${d.repo.file})`);
        const a = d.repo.body.split('\n');
        const b = d.prod.body.split('\n');
        let shown = 0;
        for (let i = 0; i < Math.max(a.length, b.length) && shown < 4; i++) {
          if (a[i] !== b[i]) {
            console.log(`     @line ${i + 1}`);
            console.log(`       repo: ${(a[i] ?? '<end>').trim().slice(0, 110)}`);
            console.log(`       prod: ${(b[i] ?? '<end>').trim().slice(0, 110)}`);
            shown++;
          }
        }
        if (a.length !== b.length) console.log(`     (repo ${a.length} lines, prod ${b.length} lines)`);
      }
    }
  }
  if (!missing.length && !drifted.length) console.log('\nNo drift — every canonical repo definition is live. 🎉');
  else console.log(`\nTo apply a file: mode=run, file=<migration>.sql (dry-run first).`);
  console.log('\nNote: this audits FUNCTION BODIES only — tables/columns/triggers/policies are out of scope.');
}

// ── run mode ────────────────────────────────────────────────────────────────
async function run() {
  if (!FILE) { console.error('run mode needs --file <migration_x.sql>'); process.exit(1); }
  const p = path.join(migDir, path.basename(FILE));
  if (!existsSync(p)) { console.error(`No such file: supabase/${path.basename(FILE)}`); process.exit(1); }
  const sql = readFileSync(p, 'utf8');
  console.log(`── supabase/${path.basename(FILE)} (${sql.length} chars) ──`);
  if (DRY) {
    console.log(sql);
    console.log('\n--dry-run: NOT executed. Uncheck dry-run to apply.');
    return;
  }
  const { error } = await db.rpc('admin_execute_sql', { p_sql: sql });
  if (error) { console.error('✗ ' + error.message); process.exit(1); }
  console.log('✓ applied to prod.');
}

(MODE === 'run' ? run() : check()).catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
