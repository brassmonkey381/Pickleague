// What a visitor and a crawler get at each public URL (PKL-028).
//
//   node scripts/seo-check.mjs [base] [--json out.json] [--assert]
//
// base defaults to https://www.pickleague.club. Every URL is fetched as a
// browser, as Googlebot and as a link-preview bot (facebookexternalhit), with
// redirects NOT followed, and the script prints status, type, size, title,
// canonical, robots (meta tag and X-Robots-Tag header) and where a redirect
// points. --assert exits 1 when a rule below is broken, so it doubles as the
// post-deploy check. Read-only: GET requests only.
import fs from 'node:fs';

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? 'https://www.pickleague.club').replace(/\/$/, '');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const doAssert = args.includes('--assert');

const AGENTS = {
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  preview: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
};

// A made-up id: the card pages fall back to a generic card for an unknown id.
const FAKE = '00000000-0000-4000-8000-000000000000';
export const URLS = [
  '/', '/landing', '/landing.html', '/register', '/login',
  '/privacy', '/privacy.html', '/delete-account',
  '/guides/plupr', '/guides/plupr.html',
  '/robots.txt', '/sitemap.xml', '/llms.txt', '/nonexistent-xyz', '/terms',
  `/leagues/${FAKE}`, `/players/${FAKE}`, `/invite/ABC123`, '/g/sometoken', '/home',
];

const pick = (re, s) => (s.match(re)?.[1] ?? '').trim();

async function probe(path, agent) {
  const res = await fetch(base + path, { redirect: 'manual', headers: { 'user-agent': AGENTS[agent] } });
  const type = (res.headers.get('content-type') ?? '').split(';')[0];
  const body = type.startsWith('text/') || type.includes('json') || type.includes('xml') ? await res.text() : '';
  const isHtml = type === 'text/html';
  return {
    path, agent, status: res.status, type, bytes: body.length,
    location: res.headers.get('location') ?? '',
    title: isHtml ? pick(/<title>([^<]*)<\/title>/i, body) : '',
    canonical: isHtml ? pick(/<link rel="canonical" href="([^"]*)"/i, body) : '',
    robots: [isHtml ? pick(/<meta name="robots" content="([^"]*)"/i, body) : '', res.headers.get('x-robots-tag') ?? '']
      .filter(Boolean).join(' / '),
    refresh: isHtml ? pick(/http-equiv="refresh" content="([^"]*)"/i, body) : '',
    shell: isHtml && body.includes('<div id="root"></div>'),
    first: type === 'text/plain' ? body.split('\n').slice(0, 3).join(' | ') : '',
  };
}

const rows = [];
for (const path of URLS) for (const agent of Object.keys(AGENTS)) {
  try { rows.push(await probe(path, agent)); }
  catch (e) { rows.push({ path, agent, status: 'ERR', error: String(e.message ?? e) }); }
}

for (const r of rows) {
  const what = r.location ? `-> ${r.location}` : [r.type, `${r.bytes}b`, r.shell ? 'APP SHELL' : '', r.title && `"${r.title}"`,
    r.canonical && `canonical ${r.canonical}`, r.robots && `robots ${r.robots}`, r.refresh && `refresh ${r.refresh}`, r.first]
    .filter(Boolean).join('  ');
  console.log(`${String(r.status).padEnd(4)} ${r.agent.padEnd(9)} ${r.path.padEnd(52)} ${what}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ base, at: new Date().toISOString(), rows }, null, 1));

if (doAssert) {
  const fails = [];
  const get = (p, a = 'browser') => rows.find((r) => r.path === p && r.agent === a);
  // 1. No cloaking: Googlebot gets exactly what a browser gets, everywhere.
  for (const p of URLS) {
    const b = get(p), g = get(p, 'googlebot');
    if (b.status !== g.status || b.bytes !== g.bytes || b.location !== g.location) fails.push(`${p}: Googlebot differs from a browser`);
  }
  // 2. Crawl files and real 404s.
  if (get('/robots.txt').type !== 'text/plain') fails.push('/robots.txt is not text/plain');
  if (!/xml/.test(get('/sitemap.xml').type)) fails.push('/sitemap.xml is not XML');
  for (const p of ['/llms.txt', '/nonexistent-xyz', '/terms']) if (get(p).status !== 404) fails.push(`${p} is not a 404`);
  // 3. The home page is readable HTML with the canonical tag.
  const home = get('/');
  if (home.status !== 200 || home.shell || home.canonical !== 'https://www.pickleague.club/') fails.push('/ is not the landing page with its canonical');
  if (get('/guides/plupr').status !== 200 || get('/guides/plupr').shell) fails.push('/guides/plupr is not the guide');
  if (get('/delete-account').status !== 200) fails.push('/delete-account broke');
  // 4. noindex on sign-in, invite and person routes.
  for (const p of ['/login', '/register', '/invite/ABC123', '/g/sometoken', `/players/${FAKE}`]) {
    if (!/noindex/.test(get(p).robots)) fails.push(`${p} has no noindex`);
  }
  if (fails.length) { console.log('\nFAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('\nOK: all checks pass');
}
