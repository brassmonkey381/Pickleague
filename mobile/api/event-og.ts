/**
 * Link-preview card for /events/:id.
 *
 * A messaging thread cannot host a live poll — SMS has no interactive content
 * and WhatsApp's Business Cloud API has no group endpoint at all. What both DO
 * do is fetch Open Graph tags and render a card. So the card becomes the poll
 * status: whoever opens the thread sees the tally as of when the preview was
 * fetched, and re-sharing the link refreshes it.
 *
 * Reached only by crawlers. vercel.json routes /events/:id here when the
 * user-agent looks like a preview fetcher; every human still falls through to
 * the SPA, so this cannot affect the app itself.
 *
 * Reads with the anon key against the same public policies the web app uses
 * (league_events / event_slots / event_slot_votes are all "viewable by
 * everyone"). No vote is attributed to anyone: the card shows counts only.
 */
export const config = { runtime: 'edge' };

const SITE = 'https://www.pickleague.club';

/**
 * The host that actually served this request.
 *
 * Hardcoding the apex was wrong: pickleague.club 307s to www, so og:image
 * pointed at a redirect. Crawlers are far less forgiving about redirects on
 * the IMAGE than on the page — several fetch it without following — and the
 * hop returned 15 bytes of text/plain instead of a PNG, so the card rendered
 * with no picture. Emitting the same host we were reached on keeps every URL
 * on one origin whichever domain the link used.
 */
function originOf(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) return SITE;
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

type EventRow = {
  id: string;
  title: string;
  status: 'voting' | 'scheduled' | 'cancelled';
  vote_ends_at: string;
  confirmed_slot_id: string | null;
  min_players: number | null;
};
type SlotRow = { id: string; starts_at: string };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ));
}

function fmt(iso: string, opts: Intl.DateTimeFormatOptions): string {
  // Fixed to Pacific: the server has no way to know the reader's zone, and a
  // card that says "9:00 AM UTC" for a 9am Alameda game is worse than useless.
  return new Date(iso).toLocaleString('en-US', { ...opts, timeZone: 'America/Los_Angeles' });
}

async function sb(path: string): Promise<any[]> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return [];
  return (await res.json()) as any[];
}

/** Title + description for the card. Exported shape mirrors the image route. */
export async function describeEvent(id: string): Promise<{ title: string; description: string } | null> {
  const events = await sb(
    `league_events?id=eq.${encodeURIComponent(id)}`
    + `&select=id,title,status,vote_ends_at,confirmed_slot_id,min_players&limit=1`,
  );
  const ev = events[0] as EventRow | undefined;
  if (!ev) return null;

  const slots = await sb(
    `event_slots?event_id=eq.${encodeURIComponent(id)}&select=id,starts_at&order=starts_at`,
  ) as SlotRow[];

  const votes = slots.length
    ? await sb(`event_slot_votes?slot_id=in.(${slots.map(s => s.id).join(',')})&select=slot_id,user_id`)
    : [];

  const perSlot = new Map<string, number>();
  const voters = new Set<string>();
  for (const v of votes) {
    perSlot.set(v.slot_id, (perSlot.get(v.slot_id) ?? 0) + 1);
    voters.add(v.user_id);
  }

  if (ev.status === 'cancelled') {
    return { title: `${ev.title} — cancelled`, description: 'Not enough players could agree on a time.' };
  }

  if (ev.status === 'scheduled') {
    const slot = slots.find(s => s.id === ev.confirmed_slot_id);
    const when = slot
      ? fmt(slot.starts_at, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'a confirmed time';
    const going = slot ? (perSlot.get(slot.id) ?? 0) : 0;
    return {
      title: `${ev.title} — it's on`,
      description: `${when} · ${going} ${going === 1 ? 'player' : 'players'} in. Tap for details.`,
    };
  }

  // Voting open: the tally is the whole point of the card.
  const leader = [...slots].sort(
    (a, b) => (perSlot.get(b.id) ?? 0) - (perSlot.get(a.id) ?? 0)
      || new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  )[0];

  const closed = new Date(ev.vote_ends_at) <= new Date();
  const parts: string[] = [`${voters.size} ${voters.size === 1 ? 'person has' : 'people have'} voted`];
  if (leader && (perSlot.get(leader.id) ?? 0) > 0) {
    parts.push(
      `${fmt(leader.starts_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} leading `
      + `(${perSlot.get(leader.id)})`,
    );
  }
  if (ev.min_players != null) parts.push(`needs ${ev.min_players} on one time`);
  parts.push(closed
    ? 'voting closed'
    : `closes ${fmt(ev.vote_ends_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);

  return { title: `Vote: ${ev.title}`, description: parts.join(' · ') };
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';

  // Guard the id shape before it reaches a query string, and so a junk URL
  // renders the generic card rather than erroring.
  const looksLikeUuid = /^[0-9a-f-]{36}$/i.test(id);

  let card: { title: string; description: string } | null = null;
  if (looksLikeUuid) {
    try {
      card = await describeEvent(id);
    } catch {
      // Never fail the preview: a card with generic copy beats a broken link.
    }
  }

  const title = card?.title ?? 'Pickleague';
  const description = card?.description ?? 'Pick a time, play some pickleball.';
  const site = originOf(req);
  const canonical = looksLikeUuid ? `${site}/events/${id}` : site;
  // Falls back to the same route without an id, which renders the generic card.
  // A static asset would be a second thing to keep in sync, and the web export
  // ships only favicon.ico — /icon.png would have 404'd.
  const image = looksLikeUuid
    ? `${site}/api/event-og-image?id=${encodeURIComponent(id)}`
    : `${site}/api/event-og-image`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pickleague">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0; url=${canonical}">
</head>
<body><p><a href="${canonical}">${esc(title)}</a></p></body>
</html>`;

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short cache: the tally changes as people vote, and a re-share should
      // pick up the newer number rather than a preview from this morning.
      'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    },
  });
}
