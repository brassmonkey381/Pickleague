/**
 * VENDORED from @just-messin-around/expo-foundation/og (v1.15.x) — src/og/
 * helpers.ts + chrome.tsx, verbatim but merged into one file.
 *
 * Why a copy exists: the foundation publishes raw TypeScript sources, and
 * Vercel's Edge Function bundler refuses TS inside node_modules ("referencing
 * unsupported modules"), which failed the deploy. Until the foundation ships
 * compiled JS, edge functions must carry their own copy.
 *
 * The foundation module remains the source of truth — change THERE first,
 * publish, then mirror here. Do not let this file grow Pickleague-specific
 * code; that belongs in cards.tsx.
 */
import React from 'react';

// ── helpers ───────────────────────────────────────────────────

/** User-agents of link-preview fetchers, for a crawler-only rewrite. */
export const CRAWLER_UA_PATTERN =
  '.*(facebookexternalhit|Facebot|WhatsApp|Twitterbot|Slackbot|Discordbot|LinkedInBot|TelegramBot|Applebot|SkypeUriPreview|redditbot|Googlebot|bingbot|Iframely|Embedly).*';

/** First word of a full name — cards show first names only. */
export function firstName(full: string | null | undefined): string {
  return (full ?? '').trim().split(/\s+/)[0] || '?';
}

/** "Ana, Ben, Cho +4" — bounded name lists for fixed-size cards. */
export function clampNames(list: string[], max: number): string {
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ));
}

/**
 * The origin that served this request, from forwarding headers. Hardcoding a
 * canonical host breaks og:image whenever the other host redirects to it —
 * crawlers follow redirects on the page far more reliably than on the image.
 */
export function requestOrigin(
  headers: { get(name: string): string | null },
  fallback: string,
): string {
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host) return fallback;
  const proto = headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}

/** The full HTML document a preview crawler consumes. */
export function ogPageHtml(input: {
  siteName: string;
  title: string;
  description: string;
  canonical: string;
  image: string;
  imageWidth?: number;
  imageHeight?: number;
}): string {
  const { siteName, title, description, canonical, image } = input;
  const w = input.imageWidth ?? 1200;
  const h = input.imageHeight ?? 630;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(siteName)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="${w}">
<meta property="og:image:height" content="${h}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0; url=${canonical}">
</head>
<body><p><a href="${canonical}">${escapeHtml(title)}</a></p></body>
</html>`;
}

/** Cache header shared by the HTML and image routes. */
export const OG_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

/** Minimal anonymous PostgREST reader; [] on any failure — a generic card
 *  always beats a broken preview. */
export function createRestFetcher(cfg: { url?: string; key?: string }) {
  return async function rest(path: string): Promise<any[]> {
    if (!cfg.url || !cfg.key) return [];
    try {
      const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      });
      if (!res.ok) return [];
      return (await res.json()) as any[];
    } catch {
      return [];
    }
  };
}

// ── chrome (satori-safe: every container declares display:flex; no emoji) ──

export type OgPalette = {
  bg: string; panel: string; accent: string; barBg: string; bar: string;
  text: string; muted: string; faint: string; danger: string;
};

export const OG_DARK: OgPalette = {
  bg: '#101418', panel: '#181e24', accent: '#8ab4f8', barBg: '#232b33',
  bar: '#5b7ea8', text: '#ffffff', muted: '#b7c1c9', faint: '#707a83', danger: '#e07a6a',
};

const row = (extra: React.CSSProperties = {}): React.CSSProperties =>
  ({ display: 'flex', ...extra });

export function OgChrome(props: {
  brand: string;
  site: string;
  colors?: OgPalette;
  children?: React.ReactNode;
}) {
  const c = props.colors ?? OG_DARK;
  return (
    <div style={row({
      flexDirection: 'column', width: '100%', height: '100%',
      backgroundColor: c.bg, padding: '48px 56px',
    })}>
      <div style={row({ justifyContent: 'space-between', alignItems: 'center' })}>
        <div style={row({ fontSize: 26, fontWeight: 700, color: c.accent, letterSpacing: 2 })}>
          {props.brand}
        </div>
        <div style={row({ fontSize: 22, color: c.faint })}>{props.site}</div>
      </div>
      {props.children}
    </div>
  );
}

export function OgSimpleCard(props: {
  brand: string;
  site: string;
  title: string;
  sub: string;
  colors?: OgPalette;
}) {
  const c = props.colors ?? OG_DARK;
  return (
    <OgChrome brand={props.brand} site={props.site} colors={c}>
      <div style={row({ flexDirection: 'column', justifyContent: 'center', flexGrow: 1 })}>
        <div style={row({ fontSize: props.title.length > 30 ? 50 : 64, fontWeight: 800, color: c.text })}>
          {props.title}
        </div>
        <div style={row({ fontSize: 30, color: c.muted, marginTop: 20 })}>{props.sub}</div>
      </div>
    </OgChrome>
  );
}

/** One labelled bar row; `frac` is 0..1 of the leading option. */
export function OgBarRow(props: {
  label: string;
  count: number;
  frac: number;
  detail?: string;
  emphasized?: boolean;
  height: number;
  colors?: OgPalette;
}) {
  const c = props.colors ?? OG_DARK;
  const fill = props.count === 0 ? c.barBg : props.emphasized ? c.accent : c.bar;
  return (
    <div style={row({
      alignItems: 'center', height: props.height, backgroundColor: c.panel,
      borderRadius: 14, marginBottom: 10, padding: '0 22px',
    })}>
      <div style={row({ width: 250, fontSize: 27, fontWeight: 700, color: c.text })}>{props.label}</div>
      <div style={row({ flexGrow: 1, height: 16, backgroundColor: c.barBg, borderRadius: 8 })}>
        <div style={row({
          width: `${Math.round(Math.max(0.06, props.frac) * 100)}%`,
          height: 16, backgroundColor: fill, borderRadius: 8,
        })} />
      </div>
      <div style={row({
        width: 52, justifyContent: 'flex-end', fontSize: 28, fontWeight: 800,
        color: props.emphasized ? c.accent : c.text,
      })}>
        {String(props.count)}
      </div>
      {props.detail != null && (
        <div style={row({ width: 320, marginLeft: 18, fontSize: 21, color: c.muted, overflow: 'hidden' })}>
          {props.detail}
        </div>
      )}
    </div>
  );
}

/**
 * Full-width bar with its caption UNDERNEATH — the layout that survives long
 * labels. OgBarRow's fixed side columns wrap badly in satori when the label
 * outgrows its column (text spills over neighbours instead of clipping);
 * stacking gives the label the whole card width. `frac` is 0..1 of the
 * leading option.
 */
export function OgBarBlock(props: {
  label: string;
  caption: string;
  frac: number;
  emphasized?: boolean;
  empty?: boolean;
  colors?: OgPalette;
}) {
  const c = props.colors ?? OG_DARK;
  const fill = props.empty ? c.barBg : props.emphasized ? c.accent : c.bar;
  return (
    <div style={row({
      flexDirection: 'column', backgroundColor: c.panel, borderRadius: 14,
      marginBottom: 12, padding: '14px 22px 12px',
    })}>
      <div style={row({ width: '100%', height: 18, backgroundColor: c.barBg, borderRadius: 9 })}>
        <div style={row({
          width: `${Math.round(Math.max(0.05, props.frac) * 100)}%`,
          height: 18, backgroundColor: fill, borderRadius: 9,
        })} />
      </div>
      <div style={row({ justifyContent: 'space-between', alignItems: 'center', marginTop: 8 })}>
        <div style={row({ fontSize: 25, fontWeight: 700, color: c.text })}>{props.label}</div>
        <div style={row({ fontSize: 22, color: props.emphasized ? c.accent : c.muted })}>{props.caption}</div>
      </div>
    </div>
  );
}

/** Label/value stat, for "Format · Round robin" style facts. */
export function OgStat(props: { label: string; value: string; colors?: OgPalette }) {
  const c = props.colors ?? OG_DARK;
  return (
    <div style={row({ flexDirection: 'column', marginRight: 48 })}>
      <div style={row({ fontSize: 20, color: c.faint, letterSpacing: 1 })}>{props.label}</div>
      <div style={row({ fontSize: 30, fontWeight: 700, color: c.text, marginTop: 4 })}>{props.value}</div>
    </div>
  );
}
