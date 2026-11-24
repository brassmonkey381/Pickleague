/** PKL-054: put a ReplayData into the self-contained replay page (replay.html). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReplayData } from './collect';

const here = path.dirname(fileURLToPath(import.meta.url));
const MARK = '/*__REPLAY_DATA__*/';

export function renderReplay(data: ReplayData, template = 'replay.html'): string {
  const tpl = fs.readFileSync(path.join(here, template), 'utf8');
  if (!tpl.includes(MARK)) throw new Error(`${template} has lost its data marker`);
  // Inside <script type="application/json">: only "</" and U+2028/9 need escaping.
  const json = JSON.stringify(data)
    .replace(/<\//g, '<\\/')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  return tpl.replace(MARK, () => json);
}

/** Writes <dir>/<name>.json, <dir>/<name>.html (PKL-087: the courts view: format overview, courts with players walking
 *  on and off, real-world checks) and <dir>/<name>.log.html (the full event / alert / check log); returns the html path. */
export function saveReplay(data: ReplayData, dir: string, name = String(data.tournament.id)): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 1));
  const out = path.join(dir, `${name}.html`);
  fs.writeFileSync(out, renderReplay(data, 'courts.html'));
  fs.writeFileSync(path.join(dir, `${name}.log.html`), renderReplay(data, 'replay.html'));
  return out;
}
