/**
 * PKL-054: replay any tournament. Rebuilds its timeline from its own rows (scores, court calls, byes, the bracket
 * filling in, admin actions, alerts) and writes a self-contained page with play/pause, speed and a scrubber.
 *
 *   npx tsx replay-tournament.ts <tournament-id> [--checks <checks.json>] [--out <dir>]
 *   npx tsx replay-tournament.ts --from <saved.json> [--out <dir>]      re-render a saved timeline (e.g. a deleted QA run)
 *   npx tsx replay-tournament.ts --fixture [--out <dir>]                offline demo: a made-up pool play tournament
 *
 * Output: <out>/<id>.json (the timeline) and <out>/<id>.html (open it in any browser). Default out: state/replays.
 * Reads with the service key (env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, else tools/toolbox/toolbox.secrets.json,
 * read silently). Read-only: it never writes to the database.
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReplay, type RCheck, type ReplayData } from './replay/collect';
import { saveReplay } from './replay/render';
import { fixtureReplay } from './replay/fixture';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const argv = process.argv.slice(2);
const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = path.resolve(val('--out') ?? path.join(repo, 'state', 'replays'));

export function serviceClient() {
  let URL = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !SERVICE) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'toolbox', 'toolbox.secrets.json'), 'utf8'));
      URL ||= s.SUPABASE_URL; SERVICE ||= s.SUPABASE_SERVICE_ROLE_KEY;
    } catch { /* fall through */ }
  }
  if (!URL || !SERVICE) throw new Error('missing Supabase URL / service key (env or tools/toolbox/toolbox.secrets.json)');
  return createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  let data: ReplayData;
  if (argv.includes('--fixture')) data = fixtureReplay();
  else if (val('--from')) data = JSON.parse(fs.readFileSync(path.resolve(val('--from')!), 'utf8'));
  else {
    const tid = argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));
    if (!tid) { console.log('usage: npx tsx replay-tournament.ts <tournament-id> [--checks file] [--out dir] | --from file.json | --fixture'); process.exit(2); }
    const checks: RCheck[] = val('--checks') ? JSON.parse(fs.readFileSync(path.resolve(val('--checks')!), 'utf8')) : [];
    data = await collectReplay(serviceClient(), tid, checks);
  }
  const out = saveReplay(data, OUT, argv.includes('--fixture') ? 'fixture' : String(data.tournament.id));
  console.log(`${data.events.length} events, ${data.alerts.length} alerts, ${data.checks.length} checks, ${data.matches.length} matches`);
  for (const n of data.notes) console.log(`note: ${n}`);
  console.log(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('FAILED: ' + (e?.message ?? e)); process.exit(1); });
}
