// Re-renders the PLUPR guide outputs from plupr-guide.html with headless Edge (or Chrome):
//   PLUPR-Guide.pdf          - the printable guide (Letter)
//   infographics/<id>.png    - each <figure class="infographic" id="ig-..."> as a 1200px-wide PNG
// Usage (from anywhere):  node docs/plupr-guide/render.mjs
// Optional: set BROWSER_EXE to a specific msedge.exe / chrome.exe path.
// Needs network access for the Google Fonts (Fredoka, Nunito) the page links to.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const srcHtml = join(here, 'plupr-guide.html');
const pdfOut = join(here, 'PLUPR-Guide.pdf');
const pngDir = join(here, 'infographics');
const pngSrcDir = join(here, '_png_src');
const profileDir = join(tmpdir(), 'plupr-guide-render-profile');
const WIDTH = 1200;

function step(msg) { console.log(`\n== ${msg}`); }
function fail(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }

function findBrowser() {
  const candidates = [
    process.env.BROWSER_EXE,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) fail('no Edge or Chrome found; set BROWSER_EXE to its full path');
  return hit;
}

const browser = findBrowser();
const baseFlags = [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profileDir}`,
  '--virtual-time-budget=15000', // lets the web fonts load before printing / capturing
];

function runBrowser(args) {
  try {
    return execFileSync(browser, [...baseFlags, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    });
  } catch (e) {
    fail(`browser exited with ${e.status ?? e.code}: ${String(e.stderr || '').split('\n').slice(-3).join(' ')}`);
  }
}

function kb(p) { return `${Math.round(statSync(p).size / 1024)} KB`; }

// ---------------------------------------------------------------- PDF
step(`PDF via ${browser}`);
runBrowser(['--no-pdf-header-footer', `--print-to-pdf=${pdfOut}`, pathToFileURL(srcHtml).href]);
if (!existsSync(pdfOut)) fail('PDF was not written');
const pdfBytes = readFileSync(pdfOut, 'latin1');
const pages = (pdfBytes.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
console.log(`PLUPR-Guide.pdf  ${kb(pdfOut)}  ${pages} pages`);
if (statSync(pdfOut).size < 50 * 1024) fail('PDF is under 50 KB, something did not render');

// ---------------------------------------------------------------- PNGs
step('Infographic PNGs');
const html = readFileSync(srcHtml, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const links = (head.match(/<link [^>]*>/g) || []).join('\n');
const styles = (head.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
const figures = [...html.matchAll(/<figure class="infographic" id="(ig-[^"]+)"[\s\S]*?<\/figure>/g)];
if (!figures.length) fail('no <figure class="infographic" id="ig-..."> found');

mkdirSync(pngSrcDir, { recursive: true });
mkdirSync(pngDir, { recursive: true });

const standalone = (figureHtml) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${WIDTH}">
${links}
${styles}
<style>
  /* PNG frame: white, ${WIDTH}px wide. SVG text scales ~1.56x at this width, so the caption does too. */
  html, body { background: #fff !important; margin: 0; padding: 0; }
  body { width: ${WIDTH}px; }
  .png-frame { width: ${WIDTH}px; padding: 36px 40px 32px; background: #fff; }
  .png-frame figure.infographic { margin: 0 !important; }
  .png-frame figcaption { font-size: 18px; margin-top: 12px; }
</style>
</head>
<body>
<div class="png-frame">
${figureHtml}
</div>
<script>
  window.addEventListener('load', () => {
    document.fonts.ready.then(() => {
      const h = Math.ceil(document.querySelector('.png-frame').getBoundingClientRect().height);
      document.body.setAttribute('data-h', String(h));
    });
  });
</script>
</body>
</html>
`;

for (const [figureHtml, id] of figures) {
  const pagePath = join(pngSrcDir, `${id}.html`);
  writeFileSync(pagePath, standalone(figureHtml), 'utf8');
  const url = pathToFileURL(pagePath).href;
  // pass 1: measure the frame height with fonts loaded
  const dom = runBrowser([`--window-size=${WIDTH},1000`, '--dump-dom', url]);
  const m = dom.match(/data-h="(\d+)"/);
  if (!m) fail(`could not measure ${id}`);
  const height = Number(m[1]);
  // pass 2: screenshot at exactly that size
  const out = join(pngDir, `${id}.png`);
  runBrowser([`--window-size=${WIDTH},${height}`, `--screenshot=${out}`, url]);
  if (!existsSync(out)) fail(`${id}.png was not written`);
  const png = readFileSync(out);
  console.log(`infographics/${id}.png  ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}  ${kb(out)}`);
}

rmSync(pngSrcDir, { recursive: true, force: true });
step('Done');
