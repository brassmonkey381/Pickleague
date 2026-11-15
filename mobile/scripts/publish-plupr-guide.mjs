// Publishes the PLUPR player guide (docs/plupr-guide/plupr-guide.html, the
// source) as a web page at /guides/plupr (PKL-028). Adds the page's canonical,
// share tags and a top bar back to Pickleague; the guide text is untouched.
// Re-run after editing the source:  node scripts/publish-plupr-guide.mjs
// (from mobile/). The in-app Guides link keeps opening the slide deck at
// /guides/plupr.html, which is now noindex so the two don't compete.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../docs/plupr-guide/plupr-guide.html');
const out = path.resolve(here, '../public/guides/plupr/index.html');
let s = fs.readFileSync(src, 'utf8');

const rep = (a, b) => {
  if (!s.includes(a)) { console.error(`FAILED: "${a}" not found in ${src}`); process.exit(1); }
  s = s.replace(a, b);
};
const url = 'https://www.pickleague.club/guides/plupr';
const desc = (s.match(/<meta name="description" content="([^"]*)">/) ?? [])[1];
if (!desc) { console.error('FAILED: the source has no meta description'); process.exit(1); }

rep('<title>PLUPR Player Guide</title>', `<title>PLUPR Player Guide — Pickleague</title>
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="Pickleague">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="PLUPR Player Guide">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="https://www.pickleague.club/landing-assets/logo.png">
<meta name="twitter:card" content="summary">
<meta name="apple-itunes-app" content="app-id=6796130870">`);
rep('</style>', `  /* Web page top bar (scripts/publish-plupr-guide.mjs) */
  .webbar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    max-width: 8.5in; margin: 16px auto 0; padding: 0 4px; font-weight: 700; }
  .webbar a { color: var(--green); text-decoration: none; }
  .webbar .cta { background: var(--green); color: #fff; padding: 8px 14px; border-radius: 999px; }
  @media print { .webbar { display: none; } }
  @media screen and (max-width: 800px) { .webbar { margin: 12px 16px 8px; } .takeaways { grid-template-columns: 1fr !important; } }
</style>`);
rep('<body>', `<body>
<nav class="webbar" aria-label="Pickleague">
  <a href="/">Pickleague</a>
  <a class="cta" href="/home">Open the app</a>
</nav>`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, s);
console.log(`ok: ${path.relative(process.cwd(), out)} (${s.length} bytes)`);
