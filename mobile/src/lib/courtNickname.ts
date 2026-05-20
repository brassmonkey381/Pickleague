// Court-location display names: prefers `court_locations.nickname` when one
// exists, falling back to the canonical name. The court list is tiny and
// rarely changes, so we cache it module-level after one fetch.
//
// Usage:
//   import { ensureCourtNicknamesLoaded, displayCourtName } from '../lib/courtNickname';
//   useEffect(() => { ensureCourtNicknamesLoaded(); }, []);
//   <Text>{displayCourtName(match.location_name)}</Text>
//
// displayCourtName is intentionally synchronous so it can be used inline in
// render. If the cache hasn't loaded yet, it returns the raw name — once
// the fetch resolves a re-render will show the nickname.

import { supabase } from './supabase';

let cache: Map<string, string> | null = null;
let loadPromise: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function notify() {
  for (const cb of subscribers) cb();
}

export async function ensureCourtNicknamesLoaded(): Promise<void> {
  if (cache) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const { data, error } = await supabase
        .from('court_locations')
        .select('name, nickname')
        .not('nickname', 'is', null);
      const map = new Map<string, string>();
      if (!error) {
        for (const row of (data ?? []) as { name: string; nickname: string | null }[]) {
          if (row.nickname) map.set(row.name, row.nickname);
        }
      }
      cache = map;
      notify();
    })();
  }
  return loadPromise;
}

export function displayCourtName(name: string | null | undefined): string {
  if (!name) return '';
  if (!cache) return name;
  return cache.get(name) || name;
}

// Convenience React hook — subscribes to cache changes so consumers re-render
// when the initial fetch resolves. Returns a sync resolver function.
import { useEffect, useState } from 'react';

export function useCourtName(): (name: string | null | undefined) => string {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    ensureCourtNicknamesLoaded();
    const cb = () => setVersion(v => v + 1);
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }, []);
  // version is read so re-renders happen when the cache updates.
  void version;
  return displayCourtName;
}
