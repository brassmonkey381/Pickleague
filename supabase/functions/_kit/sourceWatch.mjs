// Vendored from @just-messin-around/expo-foundation@1.111.0 (server kit). Edit upstream, then re-vendor.
// @ts-self-types="./sourceWatch.d.mts"
// Source watch (1.111): `@just-messin-around/expo-foundation/sourceWatch`.
// Plain JavaScript with no imports (types in sourceWatch.d.mts): the same file
// runs in a node script and, vendored by scripts/vendor-server-kit.mjs, in a
// Deno edge function. From Pickleague's check-schedule-sources.
//
// Reads an approved page politely and answers with a hash, or why there isn't
// one. It keeps no page text. A person looks at a changed page; nothing here
// publishes anything. The app owns the list of pages (no Facebook, no Meetup,
// no private groups) and what a result does: tables and RPCs stay in the app.

/** A page's text: no scripts, styles, tags or whitespace runs, so a rebuilt page with the same words hashes the same. */
export function normalizePageText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** SHA-256 of the text, as hex. */
export async function pageHash(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether robots.txt lets this agent read the path: the agent's own group, else
 * "*". The longest matching rule wins and Allow wins a tie. `*` and `$` work.
 */
export function robotsAllows(robotsTxt, path, userAgent) {
  const agent = userAgent.toLowerCase();
  const groups = [];
  let open = false;
  for (const raw of String(robotsTxt ?? '').split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, '').match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!open) groups.push({ agents: [], rules: [] });
      groups[groups.length - 1].agents.push(m[2].toLowerCase());
      open = true;
    } else if (key === 'allow' || key === 'disallow') {
      open = false;
      if (groups.length > 0 && m[2]) groups[groups.length - 1].rules.push({ allow: key === 'allow', pattern: m[2] });
    } else {
      open = false;
    }
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const applies = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const rule of applies.flatMap((g) => g.rules)) {
    const source = rule.pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (!new RegExp(`^${source}`).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

export const SOURCE_FETCH_TIMEOUT_MS = 15_000;
/** One request every 2 seconds, so two pages on one site are never close together. */
export const SOURCE_GAP_MS = 2_000;
/** Less text than this is an error page or a script shell, not the page. */
export const SOURCE_MIN_TEXT = 200;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// http to https and apex to www are the same site.
const siteOf = (url) => new URL(url).hostname.replace(/^www\./, '');

/**
 * One page, robots.txt first. Resolves `{ status, hash }`; `hash` is set only
 * when `status` is 'ok'. Otherwise leave the page as it was this week:
 *   'robots 503'        a 5xx: the site's rules are unknown
 *   'robots disallow'   it asked not to be read
 *   'http 404'          the page answered with that status
 *   'too short'         less text than `minText`
 *   'moved off site'    redirected to another host, whose rules weren't read
 *   the error's name    the request failed (TimeoutError, TypeError)
 * Never rejects.
 */
export async function checkPage(url, opts) {
  const { userAgent, token = userAgent, timeoutMs = SOURCE_FETCH_TIMEOUT_MS, gapMs = SOURCE_GAP_MS, minText = SOURCE_MIN_TEXT } = opts;
  const fetchPage = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? wait;
  const get = (target) =>
    fetchPage(target, {
      headers: { 'User-Agent': userAgent, Accept: 'text/html,text/plain' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  try {
    const u = new URL(url);
    const robots = await get(`${u.origin}/robots.txt`);
    if (robots.status >= 500) return { status: `robots ${robots.status}`, hash: null };
    const robotsTxt = robots.ok ? await robots.text() : '';
    if (!robotsAllows(robotsTxt, u.pathname + u.search, token)) return { status: 'robots disallow', hash: null };
    await sleep(gapMs);
    const page = await get(url);
    if (!page.ok) return { status: `http ${page.status}`, hash: null };
    if (page.url && siteOf(page.url) !== siteOf(url)) return { status: 'moved off site', hash: null };
    const text = normalizePageText(await page.text());
    if (text.length < minText) return { status: 'too short', hash: null };
    return { status: 'ok', hash: await pageHash(text) };
  } catch (e) {
    return { status: e instanceof Error ? e.name : 'failed', hash: null };
  }
}

/**
 * Check `sources` one at a time, `gapMs` apart. `onResult(source, result)` is
 * where the app saves it; a throw there stops the run.
 */
export async function checkPages(sources, opts, onResult) {
  const sleep = opts.sleep ?? wait;
  for (const source of sources) {
    await onResult(source, await checkPage(source.url, opts));
    await sleep(opts.gapMs ?? SOURCE_GAP_MS);
  }
}
