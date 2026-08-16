/**
 * The 1200x630 picture on the link-preview cards. Body elements come from
 * api/_lib/cards.tsx via the foundation's satori-safe chrome; this file only
 * owns ImageResponse. Card body and OG text load from the same functions, so
 * the picture and the words can never disagree.
 */
import { ImageResponse } from '@vercel/og';
import { OG_CACHE_CONTROL } from './_lib/og-kit';
import { loadCard, parseCardType, GENERIC_CARD } from './_lib/cards';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const type = parseCardType(url.searchParams.get('type'));

  let card = null;
  try {
    card = await loadCard(type, id);
  } catch {
    // A generic card beats a broken image in the thread.
  }

  return new ImageResponse((card ?? GENERIC_CARD).body, {
    width: 1200,
    height: 630,
    headers: { 'cache-control': OG_CACHE_CONTROL },
  });
}
