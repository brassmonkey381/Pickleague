#!/usr/bin/env node
process.removeAllListeners('warning'); // the .ts reparse notice is expected
// Generate supabase/functions/send-push/catalog.json from the app's import-free
// catalog (mobile/src/lib/notificationCatalog.data.ts), the single source of the
// category and action ids. --check fails (exit 1) when the committed file has
// drifted, so a renamed button can't ship to the app without the server.
//
//   node scripts/push-catalog.mjs          # write
//   node scripts/push-catalog.mjs --check  # verify (run before every push)
//
// Needs Node 22.6+ (strips the .ts types).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'mobile/src/lib/notificationCatalog.data.ts');
const out = path.join(root, 'supabase/functions/send-push/catalog.json');

const { CATALOG } = await import(pathToFileURL(src).href);
const json = JSON.stringify(
  Object.fromEntries(Object.entries(CATALOG).map(([c, d]) => [c, Object.keys(d.actions)])),
  null,
  2,
) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== json) {
    console.error('FAILED: send-push/catalog.json is out of date. Run: node scripts/push-catalog.mjs');
    process.exit(1);
  }
  console.log('push catalog: in sync');
} else {
  fs.writeFileSync(out, json);
  console.log(`wrote ${path.relative(root, out)}`);
}
