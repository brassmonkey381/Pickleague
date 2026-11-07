// Copied from @just-messin-around/expo-foundation/placeSchedule/watch (1.111).
// Edit upstream, then copy again.
//
// The pure half of the weekly schedule check. No imports: the same code runs
// in Node and Deno.

/** A page's text: no scripts, styles, tags or whitespace runs, so a rebuilt page with the same words hashes the same. */
export function normalizePageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function pageHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether robots.txt lets this agent read the path: the agent's own group, else
 * "*". The longest matching rule wins and Allow wins a tie. `*` and `$` work.
 */
export function robotsAllows(robotsTxt: string, path: string, userAgent: string): boolean {
  const agent = userAgent.toLowerCase();
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let open = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
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
  let best: { allow: boolean; pattern: string } | null = null;
  for (const rule of applies.flatMap((g) => g.rules)) {
    const source = rule.pattern
      .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    if (!new RegExp(`^${source}`).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}
