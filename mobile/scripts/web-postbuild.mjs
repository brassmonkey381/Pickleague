// Runs after `expo export --platform web` (npm run build:web, PKL-028).
// The marketing page becomes the home page: dist/index.html (the app shell
// Expo writes) moves to dist/app.html, which vercel.json serves for every app
// route, and dist/landing.html takes its place, so / is readable HTML for
// people and crawlers alike. Signed-in visitors are sent on to /home by a
// script in landing.html. Also copies public/404.html, which the export skips;
// Vercel serves it, with a 404 status, for any path nothing else matches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const fail = (m) => { console.error(`FAILED: ${m}`); process.exit(1); };
const shell = path.join(dist, 'index.html');
const landing = path.join(dist, 'landing.html');

if (!fs.existsSync(shell)) fail('dist/index.html missing (run expo export first)');
if (!fs.existsSync(landing)) fail('dist/landing.html missing');
if (!fs.readFileSync(shell, 'utf8').includes('<div id="root">')) fail('dist/index.html is not the app shell (ran twice?)');
for (const f of ['robots.txt', 'sitemap.xml', 'guides/plupr/index.html']) {
  if (!fs.existsSync(path.join(dist, f))) fail(`dist/${f} missing`);
}

fs.copyFileSync(path.join(root, 'public', '404.html'), path.join(dist, '404.html'));
fs.renameSync(shell, path.join(dist, 'app.html'));
fs.renameSync(landing, shell);
console.log('ok: / is the landing page, the app shell is app.html, 404.html in place');
