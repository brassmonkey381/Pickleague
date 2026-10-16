import { describe, it, expect } from 'vitest';
import {
  CHECKINS_LEVELS,
  DEFAULT_PRESENCE_SETTINGS,
  PAUSE_CHOICES,
  PLANS_LEVELS,
  checkinsLevelLabel,
  consentAudienceLine,
  consentOthersLine,
  isPaused,
  normalizePresenceSettings,
  pauseUntil,
  pausedUntilLabel,
  plansLevelLabel,
} from '../presencePrivacy';

// A Thursday afternoon in the device zone.
const NOW = new Date(2026, 9, 15, 17, 40, 0);

describe('presence levels', () => {
  it('lists the four court levels and the three plan levels in screen order', () => {
    expect(CHECKINS_LEVELS.map((o) => o.value)).toEqual(['everyone', 'leaguemates', 'friends', 'hidden']);
    expect(PLANS_LEVELS.map((o) => o.value)).toEqual(['leaguemates', 'friends', 'hidden']);
  });

  it('defaults to friends and league-mates at the courts, friends for plans', () => {
    expect(DEFAULT_PRESENCE_SETTINGS.checkins_level).toBe('leaguemates');
    expect(DEFAULT_PRESENCE_SETTINGS.plans_level).toBe('friends');
    expect(checkinsLevelLabel('leaguemates')).toBe('Friends and league-mates');
    expect(plansLevelLabel('friends')).toBe('Friends');
    expect(checkinsLevelLabel('hidden')).toBe('Hidden');
  });

  it('names who will see you in the consent sheet', () => {
    expect(consentAudienceLine('leaguemates')).toMatch(/friends and players in your closed leagues/);
    expect(consentAudienceLine('everyone')).toMatch(/Anyone signed in/);
    expect(consentAudienceLine('friends')).toMatch(/Only your friends/);
    expect(consentAudienceLine('hidden')).toMatch(/Nobody/);
    expect(consentOthersLine('friends')).toMatch(/"a player"/);
    expect(consentOthersLine('hidden')).toMatch(/still count/);
  });
});

describe('normalizePresenceSettings', () => {
  it('fills every field from an empty or missing payload', () => {
    expect(normalizePresenceSettings(null)).toEqual(DEFAULT_PRESENCE_SETTINGS);
    expect(normalizePresenceSettings({})).toEqual(DEFAULT_PRESENCE_SETTINGS);
    expect(normalizePresenceSettings('nope')).toEqual(DEFAULT_PRESENCE_SETTINGS);
  });

  it('keeps known values and reads a one-row array', () => {
    const row = {
      checkins_level: 'friends',
      plans_level: 'hidden',
      paused_until: '2026-10-15T19:00:00+00:00',
      consent_seen_at: '2026-10-01T10:00:00Z',
      auto_checkin: true,
    };
    expect(normalizePresenceSettings(row)).toEqual(row);
    expect(normalizePresenceSettings([row])).toEqual(row);
  });

  it('never widens an unknown level to everyone', () => {
    const s = normalizePresenceSettings({ checkins_level: 'public', plans_level: 'everyone', auto_checkin: 'yes' });
    expect(s.checkins_level).toBe('leaguemates');
    expect(s.plans_level).toBe('friends');
    expect(s.auto_checkin).toBe(false);
  });

  it('drops a timestamp that does not parse', () => {
    expect(normalizePresenceSettings({ paused_until: 'soon', consent_seen_at: '' }).paused_until).toBeNull();
    expect(normalizePresenceSettings({ consent_seen_at: '' }).consent_seen_at).toBeNull();
  });
});

describe('pause', () => {
  it('offers 1 hour, the rest of today and 24 hours', () => {
    expect(PAUSE_CHOICES.map((c) => c.value)).toEqual(['hour', 'today', 'day']);
  });

  it('computes when each pause ends', () => {
    expect(pauseUntil('hour', NOW).getTime()).toBe(NOW.getTime() + 3600_000);
    expect(pauseUntil('day', NOW).getTime()).toBe(NOW.getTime() + 24 * 3600_000);
    const midnight = pauseUntil('today', NOW);
    expect([midnight.getDate(), midnight.getHours(), midnight.getMinutes()]).toEqual([16, 0, 0]);
  });

  it('is paused only while the end is in the future', () => {
    const later = new Date(NOW.getTime() + 60_000).toISOString();
    const earlier = new Date(NOW.getTime() - 60_000).toISOString();
    expect(isPaused(later, NOW.getTime())).toBe(true);
    expect(isPaused(earlier, NOW.getTime())).toBe(false);
    expect(isPaused(null, NOW.getTime())).toBe(false);
    expect(isPaused('garbage', NOW.getTime())).toBe(false);
  });

  it('says when sharing comes back', () => {
    const now = NOW.getTime();
    expect(pausedUntilLabel(pauseUntil('hour', NOW).toISOString(), now)).toBe('til 6:40 PM');
    expect(pausedUntilLabel(pauseUntil('today', NOW).toISOString(), now)).toBe('til midnight');
    expect(pausedUntilLabel(pauseUntil('day', NOW).toISOString(), now)).toBe('til tomorrow 5:40 PM');
    expect(pausedUntilLabel(new Date(2026, 9, 18, 9, 0).toISOString(), now)).toBe('til Sun 9 AM');
  });
});
