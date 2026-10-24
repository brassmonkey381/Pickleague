import { describe, it, expect } from 'vitest';
import {
  ENTITY_ICON,
  entityIcon,
  entityTileColors,
  glyphTileColors,
  joinFacts,
  leagueRoleChip,
  myRegistrationChip,
  playerCountLabel,
  tournamentStatusChip,
} from '../entityGlyph';
import { LIGHT } from '../theme';

describe('entity glyphs', () => {
  it('drawn glyphs: pickleball league, trophy tournament, paddle drill, pickle pickles', () => {
    expect(entityIcon('league')).toBe('pickleball');
    expect(entityIcon('tournament')).toBe('trophy');
    expect(entityIcon('drill')).toBe('paddle');
    expect(entityIcon('pickles')).toBe('pickle');
    expect(entityIcon('court')).toBe('pin');
  });

  it('only event and season share a drawn glyph (both are dates)', () => {
    const byIcon = new Map<string, string[]>();
    for (const [kind, icon] of Object.entries(ENTITY_ICON)) byIcon.set(icon, [...(byIcon.get(icon) ?? []), kind]);
    const shared = [...byIcon.values()].filter((kinds) => kinds.length > 1);
    expect(shared).toEqual([['event', 'season']]);
  });

  it('every kind has a glyph', () => {
    expect(Object.keys(ENTITY_ICON).sort()).toEqual(
      ['court', 'drill', 'event', 'league', 'match', 'pickles', 'player', 'season', 'shop', 'tournament', 'vote'],
    );
  });

  it('tile colours come from the theme', () => {
    expect(entityTileColors('league', LIGHT)).toEqual({ bg: LIGHT.primaryLight, border: LIGHT.primary });
    expect(entityTileColors('court', LIGHT)).toEqual({ bg: LIGHT.surfaceAlt, border: LIGHT.border });
    expect(entityTileColors('pickles', LIGHT)).toEqual({ bg: LIGHT.primaryLight, border: LIGHT.primary });
  });

  it('event and season use the filled calendar', () => {
    expect(entityIcon('event')).toBe('calendar-event');
    expect(entityIcon('season')).toBe('calendar-event');
  });

  it('a glyph with a colour of its own: fire warning, trophy gold, pickle brand; others none', () => {
    expect(glyphTileColors('fire', LIGHT)).toEqual({ bg: LIGHT.warningLight, border: LIGHT.warning });
    expect(glyphTileColors('trophy', LIGHT)).toEqual({ bg: LIGHT.rarityLegendaryLight, border: LIGHT.rarityLegendary });
    expect(glyphTileColors('pickle', LIGHT)).toEqual({ bg: LIGHT.primaryLight, border: LIGHT.primary });
    expect(glyphTileColors('megaphone', LIGHT)).toBeNull();
  });
});

describe('row text helpers', () => {
  it('joinFacts drops empty parts', () => {
    expect(joinFacts(['Lake Merritt', null, '', '  ', false, undefined, '3 players'])).toBe('Lake Merritt · 3 players');
    expect(joinFacts([])).toBe('');
  });

  it('never says 0 players', () => {
    expect(playerCountLabel(0)).toBeNull();
    expect(playerCountLabel(null)).toBeNull();
    expect(playerCountLabel(1)).toBe('1 player');
    expect(playerCountLabel(12)).toBe('12 players');
  });

  it('role chips: none for non-members or an unknown role', () => {
    expect(leagueRoleChip('admin')?.label).toBe('Admin');
    expect(leagueRoleChip('co-admin')?.label).toBe('Co-admin');
    expect(leagueRoleChip('member')?.label).toBe('Member');
    expect(leagueRoleChip('unknown')).toBeNull();
    expect(leagueRoleChip(null)).toBeNull();
  });

  it('tournament chips never echo a raw status', () => {
    expect(tournamentStatusChip('registration')?.label).toBe('Open');
    expect(tournamentStatusChip('weird')).toBeNull();
    expect(myRegistrationChip('pending', true)?.label).toBe('Invited');
    expect(myRegistrationChip('pending')?.label).toBe('Requested');
    expect(myRegistrationChip('approved')?.label).toBe('Registered');
    expect(myRegistrationChip('rejected')).toBeNull();
    expect(myRegistrationChip(null)).toBeNull();
  });
});
