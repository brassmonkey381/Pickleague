/**
 * The picture on the link-preview card for /events/:id.
 *
 * Rendered per request so the tally in the image matches the tally in the OG
 * text — the whole point being that a thread shows the poll's state without
 * anyone opening the app. Text comes from describeEvent() in ./event-og so the
 * two can never disagree.
 *
 * No emoji anywhere in here on purpose: satori needs an emoji font supplied
 * explicitly and renders tofu boxes without one.
 */
import { ImageResponse } from '@vercel/og';
import { describeEvent } from './event-og';

export const config = { runtime: 'edge' };

const BG = '#0f1c14';
const ACCENT = '#8fe3a8';
const TEXT = '#ffffff';
const MUTED = '#b9c7bd';
const FAINT = '#6f8476';

export default async function handler(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id') ?? '';

  let card: { title: string; description: string } | null = null;
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    try {
      card = await describeEvent(id);
    } catch {
      // A generic card beats a broken image in the thread.
    }
  }

  const title = card?.title ?? 'Pickleague';
  const description = card?.description ?? 'Pick a time, play some pickleball.';

  return new ImageResponse(
    (
      // satori requires an explicit display:flex on any element with children.
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          backgroundColor: BG,
          padding: '64px',
        }}
      >
        <div style={{ display: 'flex', fontSize: 32, fontWeight: 700, color: ACCENT, letterSpacing: 2 }}>
          PICKLEAGUE
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              // Long league event names would otherwise overflow the card.
              fontSize: title.length > 42 ? 58 : 72,
              fontWeight: 800,
              color: TEXT,
              lineHeight: 1.1,
            }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', marginTop: 28, fontSize: 34, color: MUTED, lineHeight: 1.35 }}>
            {description}
          </div>
        </div>

        <div style={{ display: 'flex', fontSize: 26, color: FAINT }}>pickleague.club</div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        // Matches the HTML card's window so image and text stay in step.
        'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
      },
    },
  );
}
