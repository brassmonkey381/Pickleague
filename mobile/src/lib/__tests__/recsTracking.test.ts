import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// analytics.ts pulls in the app's Supabase client and native modules; these
// tests cover only the pure props builders, so none of them loads.
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('react-native', () => ({ AppState: { addEventListener: vi.fn() }, Platform: { OS: 'ios' } }));
vi.mock('@just-messin-around/expo-foundation/platform', () => ({ getInstallTime: vi.fn(), getNativeBuild: vi.fn() }));
vi.mock('../supabase', () => ({ supabase: {} }));
vi.mock('../godmode', () => ({ isGodmodeUserId: () => false }));

import { recActedProps, recShownProps } from '../analytics';
import { RECS_VERSIONS, type Recommender } from '../recsVersions';

describe('recs event props', () => {
  it('recs.shown carries the recommender, its version from recsVersions, the surface, count and extras', () => {
    expect(recShownProps('suggest-friends', { surface: 'discover_players', count: 7, sort: 'nearest' })).toEqual({
      recommender: 'suggest-friends',
      version: 'suggest-friends-v2',
      surface: 'discover_players',
      count: 7,
      sort: 'nearest',
    });
  });

  it('recs.acted carries action and a 1-based rank, null when there is none', () => {
    expect(recActedProps('drill-partner-search', { surface: 'drill_search', action: 'accepted', rank: 3 })).toEqual({
      recommender: 'drill-partner-search',
      version: 'drill-partner-search-v4',
      surface: 'drill_search',
      action: 'accepted',
      rank: 3,
    });
    expect(recActedProps('routine-suggestions', { surface: 'home_card', action: 'dismissed' }).rank).toBeNull();
  });

  it('the version cannot come from the call site', () => {
    const shown = recShownProps('courts-nearby', { surface: 'courts', count: 1, version: 'made-up', recommender: 'x' });
    expect(shown.version).toBe('courts-nearby-v1');
    expect(shown.recommender).toBe('courts-nearby');
    const acted = recActedProps('courts-nearby', { surface: 'courts', action: 'accepted', version: 'made-up' });
    expect(acted.version).toBe('courts-nearby-v1');
  });

  it('every version equals the README index (docs/recommendations rule 6)', () => {
    const readme = readFileSync(resolve(__dirname, '../../../../docs/recommendations/README.md'), 'utf8');
    for (const name of Object.keys(RECS_VERSIONS) as Recommender[]) {
      const row = readme.split('\n').find((l) => l.includes(`](${name}.md)`));
      expect(row, name).toBeDefined();
      expect(row).toContain(`\`${RECS_VERSIONS[name]}\``);
    }
  });
});
