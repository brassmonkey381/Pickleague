// P1 of state/feed-discover-play-plan.md: the bottom bar's rules
// (lib/navBarRules), the bell's badge (lib/useAlertBadge), /play/start and the
// 'home/' push with the bar on (navigation/linking, lib/pushLinks).
import { describe, it, expect } from 'vitest';
import { getPathFromState, getStateFromPath } from '@react-navigation/core';
import {
  ISLAND_ZONE_PX,
  NAV_HIDDEN_ROUTES,
  activeNavSlot,
  islandBottom,
  navBarVisible,
  navReserve,
  screenBottomInset,
} from '../navBarRules';
import { alertBadgeFor } from '../useAlertBadge';
import { pushRoutes } from '../pushLinks';
import { COURT_LINKS, DISCOVER_LINK, discoverAwareStateFromPath, linking } from '../../navigation/linking';
import { PLAY_NAV_ENABLED } from '../features';

describe('navBarVisible', () => {
  const on = { enabled: true, signedIn: true };

  it('shows on the signed-in screens', () => {
    for (const route of ['Home', 'Discover', 'Profile', 'LeagueDetail', 'CourtDetail', 'Settings', 'Notifications']) {
      expect(navBarVisible({ ...on, route }), route).toBe(true);
    }
  });

  it('hides on the signed-out stack, Claim, UpgradeAccount and MatchEntry', () => {
    for (const route of ['Login', 'Register', 'GuestJoin', 'InviteLanding', 'Claim', 'UpgradeAccount', 'MatchEntry']) {
      expect(NAV_HIDDEN_ROUTES.has(route), route).toBe(true);
      expect(navBarVisible({ ...on, route }), route).toBe(false);
    }
  });

  it('hides on the link-only PlayStart route', () => {
    expect(navBarVisible({ ...on, route: 'PlayStart' })).toBe(false);
  });

  it('hides signed out, with the flag off, before the route is known and while the keyboard is up', () => {
    expect(navBarVisible({ enabled: true, signedIn: false, route: 'Home' })).toBe(false);
    expect(navBarVisible({ enabled: false, signedIn: true, route: 'Home' })).toBe(false);
    expect(navBarVisible({ ...on, route: null })).toBe(false);
    expect(navBarVisible({ ...on, route: undefined })).toBe(false);
    expect(navBarVisible({ ...on, route: 'Home', keyboardOpen: true })).toBe(false);
    expect(navBarVisible({ ...on, route: 'Home', keyboardOpen: false })).toBe(true);
  });
});

describe('activeNavSlot', () => {
  it('lights Home, Discover and my own profile', () => {
    expect(activeNavSlot('Home')).toBe('home');
    expect(activeNavSlot('Discover', { tab: 'places' })).toBe('discover');
    expect(activeNavSlot('Profile', {})).toBe('me');
    expect(activeNavSlot('Profile', null)).toBe('me');
    expect(activeNavSlot('Profile', { userId: 'me' }, 'me')).toBe('me');
  });

  it("lights nothing on someone else's profile or any other screen", () => {
    expect(activeNavSlot('Profile', { userId: 'u2' }, 'me')).toBeNull();
    expect(activeNavSlot('PlayerProfile', { userId: 'u2' })).toBeNull();
    expect(activeNavSlot('LeagueDetail')).toBeNull();
    expect(activeNavSlot(null)).toBeNull();
  });
});

describe('the room kept clear for the bar and the island', () => {
  it('the bar alone: its height', () => {
    expect(navReserve({ barPx: 110, islandShown: false, safeBottom: 34 })).toBe(110);
  });

  it('an island too: its zone on top of the bar', () => {
    expect(navReserve({ barPx: 110, islandShown: true, safeBottom: 34 })).toBe(110 + ISLAND_ZONE_PX);
  });

  it('the bar hidden (keyboard, MatchEntry): the island over the safe area', () => {
    expect(navReserve({ barPx: 0, islandShown: true, safeBottom: 34 })).toBe(34 + ISLAND_ZONE_PX);
    expect(navReserve({ barPx: 0, islandShown: false, safeBottom: 34 })).toBe(0);
  });

  it('the island sits just above the bar, else above the safe area', () => {
    expect(islandBottom({ barPx: 110, safeBottom: 34, gap: 6 })).toBe(116);
    expect(islandBottom({ barPx: 0, safeBottom: 34, gap: 6 })).toBe(40);
  });

  it('the island zone fits the pill above the bar, so the island never covers a screen', () => {
    // The pill is about 40 px tall (8 px padding around a title line): the
    // zone holds it plus its gap.
    expect(ISLAND_ZONE_PX).toBeGreaterThanOrEqual(46);
  });

  it("a screen's list pads only for what reaches above the kept-clear room", () => {
    // Only the bar published (its edge is the reserve): nothing extra.
    expect(screenBottomInset(24, 110, 110)).toBe(24);
    // A sticky action bar 70 tall above the reserve: the list pads for it.
    expect(screenBottomInset(24, 110 + 70, 110)).toBe(24 + 70);
    // No bar at all (flag off): the edge is the sticky bar's own height, as before.
    expect(screenBottomInset(24, 70, 0)).toBe(24 + 70);
  });
});

describe("the bell's badge", () => {
  it('the needs-you number first, else a dot for unread, else none', () => {
    expect(alertBadgeFor({ needYou: 3, unread: 5 })).toBe(3);
    expect(alertBadgeFor({ needYou: 0, unread: 2 })).toBe('dot');
    expect(alertBadgeFor({ needYou: 0, unread: 0 })).toBeNull();
    expect(alertBadgeFor(null)).toBeNull();
  });
});

describe('play/start (plan §8, C10)', () => {
  // The table as it ships (Discover on, the bar on), whatever this build says.
  const config = {
    ...linking.config!,
    screens: { ...linking.config!.screens, ...COURT_LINKS, Discover: DISCOVER_LINK, PlayStart: 'play/start' },
  } as NonNullable<typeof linking.config>;
  const resolve = (path: string) => discoverAwareStateFromPath(path, config);

  it('the app registers /play/start exactly when the bar is on', () => {
    if (PLAY_NAV_ENABLED) expect(linking.config?.screens).toHaveProperty('PlayStart', 'play/start');
    else expect(linking.config?.screens).not.toHaveProperty('PlayStart');
  });

  it('/play/start opens the PlayStart route over Home', () => {
    const s = resolve('play/start');
    expect(s?.routes.map((r) => r.name)).toEqual(['Home', 'PlayStart']);
    expect(getStateFromPath('/play/start', config)?.routes.at(-1)?.name).toBe('PlayStart');
  });

  it('is not taken for the old /play hub (which still opens Discover › Leagues)', () => {
    expect(resolve('play')?.routes.at(-1)).toMatchObject({ name: 'Discover', params: { tab: 'leagues' } });
    expect(resolve('play/start')?.routes.at(-1)?.name).not.toBe('Discover');
  });

  it('round-trips through the address bar', () => {
    expect(getPathFromState(resolve('play/start')!, config)).toBe('/play/start');
  });
});

describe("'home/' pushes with the bar on (C1)", () => {
  it('still open Home, and ask CheckinHost to show the island', () => {
    const on = pushRoutes({ wagersEnabled: false, discoverEnabled: true, checkinIsland: true });
    expect(on['home/']('-', '')).toEqual(['Home', { checkin: true }]);
  });

  it('open plain Home with the bar off, as before', () => {
    const off = pushRoutes({ wagersEnabled: false, discoverEnabled: true });
    expect(off['home/']('-', '')).toEqual(['Home']);
  });
});
