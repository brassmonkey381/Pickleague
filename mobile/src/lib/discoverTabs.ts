// Discover's tabs and the routes that fold into it (state/feed-discover-play-plan.md
// §4, §8, C5). PURE (no react-native): the navigator, the push routes, the
// linking table and the tests all use it.
//
//   Discover  =  Leagues · Tournaments · Places · Players   (the user's order)
//
// The old screens are aliases of Discover while it is on:
//   Play {initialTab, mine, prefillInviteCode}  -> leagues, or tournaments
//   Leagues {prefillInviteCode}                  -> leagues
//   Tournaments (no leagueId)                    -> tournaments (a league's own list stays)
//   Courts {lat, lng}                            -> places
//   Friends {tab}                                -> players {players: tab}
// and their URLs open Discover directly (/play, /leagues, /tournaments,
// /courts, /friends -> /discover/<tab>), keeping the query they carried.

export const DISCOVER_TABS = ['leagues', 'tournaments', 'places', 'players'] as const;
export type DiscoverTab = (typeof DISCOVER_TABS)[number];

/** Players' own views: the friend-request push opens Requests, "Find" opens
 *  the people you've played with (the old Friends > Find tab). */
export const PLAYERS_VIEWS = ['friends', 'requests', 'find'] as const;
export type PlayersView = (typeof PLAYERS_VIEWS)[number];

/** Discover's route params (types/index.ts RootStackParamList['Discover']). */
export type DiscoverParams = {
  tab?: DiscoverTab;
  /** "All my leagues" / "My tournaments": the Mine chip on for this visit
   *  (strictly `true`: on web it comes back from the URL as 'true' and a
   *  refresh must not re-apply it). */
  mine?: boolean;
  /** A league invite code: Leagues opens Join with code, filled in. */
  prefillInviteCode?: string;
  /** Players' opening view. */
  players?: PlayersView;
  /** Places centres here (else the device location, or a searched city). */
  lat?: number;
  lng?: number;
};

/** The old routes Discover replaces. */
export type LegacyDiscoverRoute = 'Play' | 'Leagues' | 'Tournaments' | 'Courts' | 'Friends';

export const DISCOVER_TAB_LABELS: Record<DiscoverTab, string> = {
  leagues: 'Leagues',
  tournaments: 'Tournaments',
  places: 'Places',
  players: 'Players',
};

/** The tabs on offer, in order: Places needs court discovery, Players the
 *  friends screen's RPCs (each tab follows its own flag, plan C4). */
export function availableDiscoverTabs(flags: { places: boolean; players: boolean }): DiscoverTab[] {
  return DISCOVER_TABS.filter((t) => (t === 'places' ? flags.places : t === 'players' ? flags.players : true));
}

export function asDiscoverTab(v: unknown): DiscoverTab | null {
  return typeof v === 'string' && (DISCOVER_TABS as readonly string[]).includes(v) ? (v as DiscoverTab) : null;
}

export function asPlayersView(v: unknown): PlayersView | null {
  return typeof v === 'string' && (PLAYERS_VIEWS as readonly string[]).includes(v) ? (v as PlayersView) : null;
}

/**
 * The tab Discover opens on: the route's tab, else the one used last, else
 * Leagues (the first tab; Discover replaced the Play hub, which opened there).
 * Each candidate counts only while it is on offer.
 */
export function openingDiscoverTab(param: unknown, lastUsed: unknown, available: readonly DiscoverTab[]): DiscoverTab {
  for (const v of [param, lastUsed]) {
    const t = asDiscoverTab(v);
    if (t && available.includes(t)) return t;
  }
  return available[0] ?? 'leagues';
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Drop undefined keys, so a test (and a URL) sees only what was carried. */
function compact(p: DiscoverParams): DiscoverParams {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  return out as DiscoverParams;
}

/**
 * Discover's params for a navigate to an old route, carrying what its callers
 * send today (plan C5). Null when the old route still has a screen of its
 * own: Tournaments with a leagueId (a league's tournaments list).
 */
export function discoverParamsForLegacy(route: LegacyDiscoverRoute, params?: Record<string, unknown> | null): DiscoverParams | null {
  const p = params ?? {};
  switch (route) {
    case 'Play': {
      const code = str(p.prefillInviteCode);
      // Join with code lives on Leagues, so a code brings Leagues forward.
      const tab: DiscoverTab = !code && p.initialTab === 'tournaments' ? 'tournaments' : 'leagues';
      return compact({ tab, mine: p.mine === true ? true : undefined, prefillInviteCode: code });
    }
    case 'Leagues':
      return compact({ tab: 'leagues', prefillInviteCode: str(p.prefillInviteCode) });
    case 'Tournaments':
      return str(p.leagueId) ? null : { tab: 'tournaments' };
    case 'Courts':
      return compact({ tab: 'places', lat: num(p.lat), lng: num(p.lng) });
    case 'Friends':
      return compact({ tab: 'players', players: asPlayersView(p.tab) ?? undefined });
  }
}

/**
 * Where a link to Discover goes while Discover is off: the old route that
 * held that tab, or null when nothing did (Places without court discovery).
 * Callers use it through lib/discoverNav, which picks by the flag.
 */
export function legacyRouteForDiscover(
  params: DiscoverParams,
  flags: { courts: boolean; friends: boolean },
): [LegacyDiscoverRoute, Record<string, unknown> | undefined] | null {
  const tab = params.tab ?? 'leagues';
  switch (tab) {
    case 'leagues':
    case 'tournaments': {
      const extra = compact({ mine: params.mine, prefillInviteCode: params.prefillInviteCode });
      return ['Play', { initialTab: params.prefillInviteCode ? 'leagues' : tab, ...extra }];
    }
    case 'places':
      return flags.courts ? ['Courts', params.lat != null && params.lng != null ? { lat: params.lat, lng: params.lng } : undefined] : null;
    case 'players':
      return flags.friends ? ['Friends', params.players ? { tab: params.players } : undefined] : null;
  }
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/** The old list paths and the route each one named. A path with more
 *  segments (leagues/<id>, tournaments/new, courts/<venue id>) is not one. */
const LEGACY_PATHS: Record<string, LegacyDiscoverRoute> = {
  play: 'Play',
  leagues: 'Leagues',
  tournaments: 'Tournaments',
  courts: 'Courts',
  friends: 'Friends',
};

// A query string by hand (RN's URLSearchParams has no forEach, and this file
// stays free of platform differences).
function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    const k = dec(eq >= 0 ? pair.slice(0, eq) : pair);
    if (k && !(k in out)) out[k] = dec(eq >= 0 ? pair.slice(eq + 1) : '');
  }
  return out;
}

/** Discover's URL for its params: discover/<tab>?<the rest>. */
export function discoverPath(p: DiscoverParams): string {
  const qs = Object.entries(p)
    .filter(([k, v]) => k !== 'tab' && v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `discover${p.tab ? `/${p.tab}` : ''}${qs ? `?${qs}` : ''}`;
}

/**
 * A link to an old list (pickleague.club/play, /courts?lat=..., /friends?tab=find,
 * an invite's /leagues) rewritten to Discover's, so it opens the right tab
 * with its params and the address bar says /discover/<tab>. Anything else
 * comes back unchanged (a leading '/' and a '#fragment' are kept).
 */
export function rewriteLegacyDiscoverPath(path: string): string {
  const hashAt = path.indexOf('#');
  const hash = hashAt >= 0 ? path.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const qAt = beforeHash.indexOf('?');
  const rawPath = qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash;
  const rawQuery = qAt >= 0 ? beforeHash.slice(qAt + 1) : '';
  const lead = rawPath.startsWith('/') ? '/' : '';
  const segs = rawPath.split('/').filter(Boolean);
  if (segs.length !== 1) return path;
  const route = LEGACY_PATHS[segs[0]];
  if (!route) return path;
  // A URL's mine=true is the string 'true', which the old screen ignored on
  // purpose (a refresh must not re-apply it); it is dropped here the same way.
  const params = discoverParamsForLegacy(route, parseQuery(rawQuery));
  if (!params) return path;
  return `${lead}${discoverPath(params)}${hash}`;
}
