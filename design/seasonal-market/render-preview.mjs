#!/usr/bin/env node
// Renders every seasonal market item onto one PNG sheet for review, one row
// per drop (design/court-pass/render-preview.mjs, for the market). The art is
// the SVG the server ships (art/seasonal-market/<drop>/svg run through the
// kit's import.mjs); the labels, prices and windows come from each drop's
// catalog.json.
//
//   node design/seasonal-market/render-preview.mjs     # -> design/seasonal-market/2026-11-12-preview.png
//
// Requires headless Chrome or Edge (auto-detected on Windows; override with CHROME=).
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const lib = require(join(ROOT, 'art', 'seasonal-market', 'lib.cjs'));
const fail = (m) => {
  console.error(`FAILED: ${m}`);
  process.exit(1);
};

const DROPS = lib.drops();
if (!DROPS.length) fail('no drops in art/seasonal-market.');
const tag = DROPS.map((d, i) => (i === 0 ? d : DROPS[i - 1].slice(0, 4) === d.slice(0, 4) ? d.slice(5) : d)).join('-');
const OUT = join(ROOT, 'design', 'seasonal-market', `${tag}-preview.png`);
const RARITY = { common: '#6b7280', rare: '#2f7fc1', legendary: '#b8860b' };
const ART = 170;
const when = (w) => (w ? new Date(`${w.local.replace(' ', 'T')}:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'now');

function card(drop, it) {
  let svg;
  try {
    svg = lib.importArt(drop, it).svg;
  } catch (e) {
    fail(e.message);
  }
  const ar = it.aspect;
  const w = ar >= 1 ? ART - 20 : (ART - 20) * ar;
  const h = ar >= 1 ? (ART - 20) / ar : ART - 20;
  return `<div class="card"><div class="art"><div class="svg" style="width:${w}px;height:${h}px">${svg}</div></div>` +
    `<div class="t">${it.icon} ${it.name}</div>` +
    `<div class="m">🥒 ${it.cost.toLocaleString('en-US')} pickles · <b style="color:${RARITY[it.rarity]}">${it.rarity}</b></div>` +
    `<div class="m">My Place: ${it.slot_group} · <code>${it.id}</code></div></div>`;
}

const sections = DROPS.map((d) => {
  const cat = lib.catalog(d);
  const total = cat.items.reduce((n, i) => n + i.cost, 0);
  return `<h2>${cat.title} <span class="m">· season ${cat.season} · on sale ${when(cat.available_from)} to ${when(cat.available_until)} (Pacific midnight) · all 6 for ${total.toLocaleString('en-US')} pickles</span></h2>` +
    `<div class="grid">${cat.items.map((it) => card(d, it)).join('')}</div>`;
}).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f4f7fb;padding:20px;font:12px system-ui,sans-serif;color:#2b2f36;width:1240px}
h1{font-size:20px;margin-bottom:2px} h2{font-size:14px;margin:16px 0 8px} h2 .m{font-weight:400}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.card{background:#fff;border-radius:12px;padding:10px;border:1px solid #dbe3ec}
.art{height:${ART}px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:repeating-conic-gradient(#eef2f6 0 25%,#fff 0 50%) 0 0/16px 16px;margin-bottom:8px}
.svg>svg{width:100%;height:100%;display:block}
.t{font-weight:600;font-size:13px} .m{color:#5b6470;font-size:11px;margin-top:2px} code{font-size:10px}
</style></head><body>
<h1>My Place seasonal market · ${tag}</h1>
<div class="m">Sold for pickles in My Place, separate from the Court Pass (whose rewards are earned, never sold). A drop's items are buyable only inside its window; owners keep them after.</div>
${sections}
</body></html>`;

const htmlPath = join(tmpdir(), `seasonal-market-${tag}-preview.html`);
writeFileSync(htmlPath, html);
const browser = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));
if (!browser) fail(`no Chrome or Edge found. Set CHROME to the browser's path, or open ${htmlPath} yourself.`);
execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${OUT}`, '--window-size=1280,760', '--force-device-scale-factor=2', `file:///${htmlPath.replace(/\\/g, '/')}`], { stdio: 'ignore' });
console.log(`wrote ${OUT}`);
