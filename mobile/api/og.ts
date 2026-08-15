/**
 * OG meta page for /events/:id, /leagues/:id and /tournaments/:id.
 *
 * Reached only by preview crawlers — the vercel.json rewrites carry a
 * user-agent condition (see CRAWLER_UA_PATTERN in the foundation /og docs;
 * vercel.json cannot import it, so the list is duplicated there). Humans fall
 * through to the SPA catch-all, so the app path is untouched.
 */
import { ogPageHtml, requestOrigin, OG_CACHE_CONTROL } from '@just-messin-around/expo-foundation/og';
import { loadCard, GENERIC_CARD, FALLBACK_ORIGIN, type CardType } from './_lib/cards';

export const config = { runtime: 'edge' };

const PATHS: Record<CardType, string> = {
  event: 'events', league: 'leagues', tournament: 'tournaments',
};

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const typeParam = url.searchParams.get('type') ?? 'event';
  const type: CardType = typeParam === 'league' || typeParam === 'tournament' ? typeParam : 'event';

  let card = null;
  try {
    card = await loadCard(type, id);
  } catch {
    // Never fail a preview: generic copy beats a broken link.
  }
  const c = card ?? GENERIC_CARD;

  const site = requestOrigin(req.headers, FALLBACK_ORIGIN);
  const canonical = card ? `${site}/${PATHS[type]}/${id}` : site;
  const image = `${site}/api/og-image?type=${type}&id=${encodeURIComponent(id)}`;

  return new Response(
    ogPageHtml({
      siteName: 'Pickleague',
      title: c.title,
      description: c.description,
      canonical,
      image,
    }),
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': OG_CACHE_CONTROL } },
  );
}
