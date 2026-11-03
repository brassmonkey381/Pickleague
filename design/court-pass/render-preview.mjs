#!/usr/bin/env node
// Renders every item of a Court Pass month onto one PNG sheet for review
// (Doggle's design/park-pass/render-preview.mjs, for Pickleague). The decor
// is the SVG the server ships (art/court-pass/<month>/svg run through the
// kit's import.mjs); avatars are the emoji on its background circle, as
// HomeGreeting draws them; name styles are drawn as FlairName shows them
// today (a gradient's first stop, solid; Snowfall's base colour with flakes,
// frozen mid-fall; Sparkle's base colour with three sparkles). Item list +
// labels come from the month's catalog.json.
//
//   node design/court-pass/render-preview.mjs            # 2026-12
//   node design/court-pass/render-preview.mjs 2026-11
//
// Requires headless Chrome or Edge (auto-detected on Windows; override with CHROME=).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MONTH = process.argv[2] ?? '2026-12';
const DIR = join(ROOT, 'art', 'court-pass', MONTH);
const OUT = join(ROOT, 'design', 'court-pass', `${MONTH}-preview.png`);
const require = createRequire(import.meta.url);
const { KIT } = require(join(ROOT, 'art', 'my-place', 'lib.cjs'));
const IMPORT = join(KIT, 'tools', 'room-art', 'import.mjs');
const fail = (m) => {
  console.error(`FAILED: ${m}`);
  process.exit(1);
};

if (!existsSync(join(DIR, 'catalog.json'))) fail(`no catalog at ${join(DIR, 'catalog.json')}.`);
const cat = JSON.parse(readFileSync(join(DIR, 'catalog.json'), 'utf8'));
const NAME = 'Jordan';
const RARITY = { common: '#6b7280', rare: '#2f7fc1', legendary: '#b8860b' };

function decorSvg(it) {
  const out = execFileSync(process.execPath, [IMPORT, '--svg', join(DIR, 'svg', `${it.id}.svg`), '--id', it.id, '--fits', it.slot_group, '--format', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out).art_svg;
}

const ART = 170;
function art(it) {
  if (it.table === 'home_items') {
    const ar = it.aspect;
    const w = ar >= 1 ? ART - 20 : (ART - 20) * ar;
    const h = ar >= 1 ? (ART - 20) / ar : ART - 20;
    return `<div class="svg" style="width:${w}px;height:${h}px">${decorSvg(it)}</div>`;
  }
  const p = it.payload;
  if (it.category === 'avatar') return `<div class="av" style="background:${p.bgColor}">${p.emoji}</div>`;
  if (p.kind === 'gradient') {
    return `<div class="names"><div class="nm" style="color:${p.stops[0]}">${NAME}</div><div class="sub">in lists today (first stop)</div>` +
      `<div class="nm" style="background:linear-gradient(90deg,${p.stops.join(',')});-webkit-background-clip:text;color:transparent">${NAME}</div><div class="sub">the full gradient</div></div>`;
  }
  if (p.kind === 'animated' && p.effect === 'snowfall') {
    const flakes = [['8%', 2, 8], ['34%', 14, 7], ['60%', -4, 9], ['86%', 22, 7]]
      .map(([l, t, s]) => `<span class="fl" style="left:${l};top:${t}px;font-size:${s}px">❄&#xFE0E;</span>`).join('');
    return `<div class="names"><div class="snow"><span class="nm big" style="color:${p.base}">${NAME}</span>${flakes}</div><div class="sub">profile (flakes drift down, looping)</div>` +
      `<div class="nm" style="color:${p.base}">${NAME}</div><div class="sub">in lists (solid base)</div></div>`;
  }
  if (p.kind === 'animated' && p.effect === 'sparkle') {
    const sp = [['-10px', -6, 10], ['100%', -2, 8], ['55%', -9, 9]]
      .map(([l, t, s]) => `<span class="fl" style="left:${l};top:${t}px;font-size:${s}px;color:inherit">✨</span>`).join('');
    return `<div class="names"><div class="snow"><span class="nm big" style="color:${p.base}">${NAME}</span>${sp}</div><div class="sub">profile (sparkles twinkle, looping)</div>` +
      `<div class="nm" style="color:${p.base}">${NAME}</div><div class="sub">in lists (solid base)</div></div>`;
  }
  return `<div class="sub">no preview for ${it.category}</div>`;
}

function card(it) {
  const where = it.table === 'home_items' ? `My Place: ${it.slot_group}` : it.category.replace(/_/g, ' ');
  return `<div class="card ${it.lane}"><div class="art">${art(it)}</div>` +
    `<div class="t">${it.icon} ${it.title}</div>` +
    `<div class="m">Tier ${it.tier} · ${it.lane === 'free' ? 'Free' : 'Premium (preview)'} · <b style="color:${RARITY[it.rarity]}">${it.rarity}</b></div>` +
    `<div class="m">${where} · <code>${it.id}</code></div></div>`;
}

const lane = (l) => cat.items.filter((i) => i.lane === l).sort((a, b) => a.tier - b.tier).map(card).join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f4f7fb;padding:20px;font:12px system-ui,sans-serif;color:#2b2f36;width:1240px}
h1{font-size:20px;margin-bottom:2px} h2{font-size:14px;margin:16px 0 8px}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.card{background:#fff;border-radius:12px;padding:10px;border:1px solid #dbe3ec}
.card.premium{background:#fbfcfe;border-style:dashed}
.art{height:${ART}px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:repeating-conic-gradient(#eef2f6 0 25%,#fff 0 50%) 0 0/16px 16px;margin-bottom:8px}
.svg>svg{width:100%;height:100%;display:block}
.av{width:110px;height:110px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:60px}
.names{text-align:center} .nm{font-weight:700;font-size:20px} .nm.big{font-size:24px}
.sub{font-size:10px;color:#7a828c;margin-bottom:8px}
.snow{position:relative;display:inline-block;margin-bottom:2px} .fl{position:absolute;color:#7cc7ff;opacity:.85}
.t{font-weight:600;font-size:13px} .m{color:#5b6470;font-size:11px;margin-top:2px} code{font-size:10px}
</style></head><body>
<h1>${cat.title.replace(/:.*/, '')} · ${MONTH}</h1>
<div class="m">${cat.items.length} items. Free lane = what players earn; premium = display only ("Premium track coming soon"), never granted or sold.</div>
<h2>Free lane</h2><div class="grid">${lane('free')}</div>
<h2>Premium lane (preview)</h2><div class="grid">${lane('premium')}</div>
</body></html>`;

const htmlPath = join(tmpdir(), `court-pass-${MONTH}-preview.html`);
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
execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${OUT}`, '--window-size=1280,720', '--force-device-scale-factor=2', `file:///${htmlPath.replace(/\\/g, '/')}`], { stdio: 'ignore' });
console.log(`wrote ${OUT}`);
