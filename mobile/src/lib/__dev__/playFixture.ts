// DEV-ONLY scale fixture for Play: 200 leagues + 54 tournaments, added to the
// real rows CLIENT-SIDE so chips, sort, paging ("38 of 153"), the 6-row
// thresholds and "+ reachable from page 3" can be checked without writing a
// single test row to prod (plan section 1 "Test data at scale": leagues are
// `select using (true)`, so even SIM-owned leagues would reach every real
// user's Discover).
//
// Off unless BOTH hold:
//   1. __DEV__ (a release bundle compiles every branch below to "off"), and
//   2. an explicit toggle: EXPO_PUBLIC_PLAY_FIXTURE=1 in mobile/.env at bundle
//      time, or at runtime the dev menu item "Toggle Play fixture" (native) /
//      `__togglePlayFixture()` in the browser console (web).
//
// The rows are injected at RENDER time, never inside a fetcher, so they never
// reach the query cache or its disk copy. Their ids start with `fixture-`;
// screens refuse writes (Join, Request) on them and say why.
import { useEffect, useState } from 'react';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';
import type { LeagueWithStats, Tournament } from '../../types';

export const FIXTURE_PREFIX = 'fixture-';

export function isFixtureId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(FIXTURE_PREFIX);
}

let enabled = __DEV__ && process.env.EXPO_PUBLIC_PLAY_FIXTURE === '1';
const changed = createSignal<boolean>();

export function isPlayFixtureOn(): boolean {
  return __DEV__ && enabled;
}

export function setPlayFixtureOn(next: boolean): void {
  if (!__DEV__) return;
  enabled = next;
  changed.emit(next);
}

let menuInstalled = false;
function installDevToggle(): void {
  if (!__DEV__ || menuInstalled) return;
  menuInstalled = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DevSettings, Platform } = require('react-native');
    const toggle = () => setPlayFixtureOn(!enabled);
    if (Platform.OS === 'web') {
      (globalThis as unknown as { __togglePlayFixture?: () => void }).__togglePlayFixture = toggle;
    } else if (DevSettings?.addMenuItem) {
      DevSettings.addMenuItem('Toggle Play fixture (200 leagues)', toggle);
    }
  } catch {
    // No dev menu: the env var still works.
  }
}

/** Whether to inject the fixture. Always false outside __DEV__. */
export function usePlayFixtureOn(): boolean {
  const [on, setOn] = useState(isPlayFixtureOn());
  useEffect(() => {
    if (!__DEV__) return undefined;
    installDevToggle();
    return changed.subscribe(setOn);
  }, []);
  return __DEV__ && on;
}

// ── Deterministic data ───────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COURTS: { name: string; lat: number; lng: number }[] = [
  { name: 'Lake Merritt', lat: 37.8027, lng: -122.2585 },
  { name: 'Moraga Commons', lat: 37.8349, lng: -122.1297 },
  { name: 'Mission Courts', lat: 37.7599, lng: -122.4148 },
  { name: 'Golden Gate Park', lat: 37.7694, lng: -122.4862 },
  { name: 'Bushrod Park', lat: 37.8456, lng: -122.2638 },
  { name: 'Palo Alto Mitchell Park', lat: 37.4214, lng: -122.1104 },
  { name: 'San Jose Willow Glen', lat: 37.3022, lng: -121.8995 },
  { name: 'Walnut Creek Heather Farm', lat: 37.9213, lng: -122.0473 },
  { name: 'Sacramento McKinley', lat: 38.5764, lng: -121.4630 },
  { name: 'Santa Cruz Brommer', lat: 36.9741, lng: -121.9798 },
];
const ADJ = ['Sunset', 'Dink', 'Kitchen', 'Third Shot', 'Erne', 'Baseline', 'Lob', 'Smash', 'Rally', 'Paddle'];
const NOUN = ['Club', 'League', 'Crew', 'Collective', 'Society', 'Squad', 'Ladder', 'Night', 'Open Play', 'Social'];
const FORMATS: Tournament['format'][] = ['round_robin', 'single_elimination', 'double_elimination', 'pool_play', 'mlp', 'mlp_random', 'rotating_partners'];

const DAY = 86_400_000;

export type FixtureLeague = LeagueWithStats & { saved: boolean; recentMatchCount: number };

let leaguesCache: FixtureLeague[] | null = null;

/** 200 leagues: ~25% private, ~40% in season, a few with tournaments, 4 of
 *  them Mine (3 member + 1 pending request), 6 saved. */
export function fixtureLeagues(): FixtureLeague[] {
  if (leaguesCache) return leaguesCache;
  const r = rng(20261013);
  const now = Date.now();
  const out: FixtureLeague[] = [];
  for (let i = 0; i < 200; i++) {
    const court = COURTS[Math.floor(r() * COURTS.length)];
    const active = r() < 0.4;
    const upcoming = !active && r() < 0.2;
    const tournaments = r() < 0.12 ? 1 + Math.floor(r() * 2) : 0;
    const mineRole: LeagueWithStats['myRole'] = i < 3 ? (i === 0 ? 'admin' : 'member') : null;
    out.push({
      id: `${FIXTURE_PREFIX}league-${i}`,
      name: `${ADJ[i % ADJ.length]} ${NOUN[Math.floor(i / ADJ.length) % NOUN.length]} ${i + 1}`,
      description: null,
      created_by: 'fixture',
      is_active: true,
      is_open: r() >= 0.25,
      home_court: court.name,
      home_court_lat: court.lat + (r() - 0.5) * 0.05,
      home_court_lng: court.lng + (r() - 0.5) * 0.05,
      prize_pool: 0,
      payout_structure: [],
      created_at: new Date(now - Math.floor(r() * 400) * DAY).toISOString(),
      memberCount: 1 + Math.floor(r() * 40),
      matchCount: Math.floor(r() * 300),
      distinctPlayDays: Math.floor(r() * 60),
      myRole: mineRole,
      hasRequested: i === 3,
      activeSeasonCount: active ? 1 : 0,
      activeTournamentCount: tournaments,
      openRegistrationTournamentCount: tournaments > 0 ? 1 : 0,
      scheduledTournamentCount: 0,
      upcomingEventCount: 0,
      openVoteCount: r() < 0.08 ? 1 : 0,
      adminId: null,
      adminName: `Fixture Admin ${i % 17}`,
      currentBaselinePlupr: null,
      featuredSeasonStatus: active ? 'active' : upcoming ? 'upcoming' : null,
      featuredSeasonStart: active || upcoming ? new Date(now + (upcoming ? 20 : -30) * DAY).toISOString().slice(0, 10) : null,
      featuredSeasonEnd: null,
      saved: i % 33 === 5,
      recentMatchCount: Math.floor(r() * 30),
    });
  }
  leaguesCache = out;
  return out;
}

export type FixtureTournaments = {
  tournaments: Tournament[];
  myRegs: Record<string, { status: 'pending' | 'approved' | 'rejected' | 'waitlisted'; role: string | null; invited_by: string | null }>;
  approvedCounts: Record<string, number>;
  playerCounts: Record<string, number>;
  leagueNames: Record<string, string>;
};

let tournamentsCache: FixtureTournaments | null = null;

/** 54 tournaments: 12 open for registration, 3 in progress, 39 ended or
 *  cancelled; 2 Mine (one invite). */
export function fixtureTournaments(): FixtureTournaments {
  if (tournamentsCache) return tournamentsCache;
  const r = rng(54);
  const now = Date.now();
  const leagues = fixtureLeagues();
  const out: FixtureTournaments = { tournaments: [], myRegs: {}, approvedCounts: {}, playerCounts: {}, leagueNames: {} };
  for (let i = 0; i < 54; i++) {
    const status: Tournament['status'] = i < 12 ? 'registration' : i < 15 ? 'active' : i % 7 === 0 ? 'cancelled' : 'completed';
    const league = leagues[Math.floor(r() * leagues.length)];
    const court = COURTS[Math.floor(r() * COURTS.length)];
    const offsetDays = status === 'registration' ? 1 + Math.floor(r() * 40) : status === 'active' ? 0 : -(1 + Math.floor(r() * 300));
    const id = `${FIXTURE_PREFIX}tournament-${i}`;
    const max = r() < 0.6 ? 8 + 4 * Math.floor(r() * 4) : null;
    const approved = Math.floor(r() * (max ?? 20));
    out.tournaments.push({
      id,
      league_id: league.id,
      name: `${ADJ[(i * 3) % ADJ.length]} ${['Open', 'Classic', 'Slam', 'Cup', 'Invitational'][i % 5]} ${i + 1}`,
      description: null,
      created_by: 'fixture',
      format: FORMATS[i % FORMATS.length],
      match_type: r() < 0.6 ? 'doubles' : 'singles',
      seeding: 'random',
      pool_count: 2,
      partner_rotation: null,
      registration_mode: r() < 0.85 ? 'request' : 'invite_only',
      max_players: max,
      min_players: null,
      status,
      start_time: new Date(now + offsetDays * DAY + Math.floor(r() * 10) * 3_600_000).toISOString(),
      registration_closes_at: null,
      expected_length_hours: 2 + Math.floor(r() * 4),
      mlp_play_format: 'round_robin',
      mlp_pool_count: 2,
      mlp_playoff_teams: 4,
      playoff_format: 'none',
      playoff_third_place: false,
      team_creation: 'random',
      location_name: court.name,
      location_lat: court.lat,
      location_lng: court.lng,
      prize_pool: 0,
      pickle_ante: r() < 0.3 ? 50 : 0,
      payout_structure: [],
      champion_payout_applied_at: null,
      bracket_release_time: null,
      created_at: new Date(now - (60 - i) * DAY).toISOString(),
    } as Tournament);
    out.approvedCounts[id] = approved;
    out.playerCounts[id] = approved;
    out.leagueNames[league.id] = league.name;
  }
  out.myRegs[`${FIXTURE_PREFIX}tournament-2`] = { status: 'pending', role: null, invited_by: 'fixture' };
  out.myRegs[`${FIXTURE_PREFIX}tournament-13`] = { status: 'approved', role: 'player', invited_by: null };
  tournamentsCache = out;
  return out;
}
