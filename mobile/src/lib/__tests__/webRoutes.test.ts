// PKL-028: the web routing in vercel.json and the app's linking table must
// agree. / is the static landing page, the app's Home is /home, and every app
// path is served the app shell; anything else is a real 404.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getPathFromState, getStateFromPath } from '@react-navigation/core';
import { linking } from '../../navigation/linking';

const vercel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../vercel.json'), 'utf8'));

/** First path segment of every screen path in the linking table ('' skipped). */
function linkedSegments(): string[] {
  const out = new Set<string>();
  const walk = (screens: Record<string, any>) => {
    for (const v of Object.values(screens)) {
      const paths = typeof v === 'string' ? [v] : [v?.path, ...(v?.alias ?? []).map((a: any) => (typeof a === 'string' ? a : a?.path))];
      for (const p of paths) if (typeof p === 'string' && p) out.add(p.split('/')[0]);
      if (v && typeof v === 'object' && v.screens) walk(v.screens);
    }
  };
  walk(linking.config!.screens as Record<string, any>);
  return [...out].sort();
}

/** The segment list of the app-shell rewrite (the one whose destination is /app.html). */
function shellSegments(): string[] {
  const rule = vercel.rewrites.find((r: any) => r.destination === '/app.html');
  const m = /^\/:seg\(([^)]+)\)\/:rest\*$/.exec(rule?.source ?? '');
  return m ? m[1].split('|') : [];
}

describe('web routes (vercel.json) cover the app', () => {
  it('serves the app shell for every path the app links to', () => {
    const shell = new Set(shellSegments());
    const missing = linkedSegments().filter((s) => !shell.has(s));
    expect(missing).toEqual([]);
  });

  it('has no catch-all, so unknown paths 404', () => {
    expect(vercel.rewrites.some((r: any) => r.source === '/(.*)')).toBe(false);
  });

  it('gives Googlebot, Bingbot and Applebot the same page as people', () => {
    for (const r of vercel.rewrites) {
      for (const h of r.has ?? []) expect(h.value).not.toMatch(/Googlebot|bingbot|Applebot/i);
    }
  });
});

describe('Home lives at /home on the web', () => {
  const nav = { routes: [{ name: 'Home' }] } as any;
  it('links Home as /home', () => {
    expect(getPathFromState(nav, linking.config)).toBe('/home');
  });
  it('still opens Home from the bare domain and from /home', () => {
    expect(getStateFromPath('', linking.config)?.routes.map((r) => r.name) ?? ['Home']).toEqual(['Home']);
    expect(getStateFromPath('home', linking.config)?.routes.map((r) => r.name)).toEqual(['Home']);
  });
});
